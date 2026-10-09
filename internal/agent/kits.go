package agent

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/cosscom/shipyard/internal/box"
	"github.com/cosscom/shipyard/internal/hooks"
	"github.com/cosscom/shipyard/internal/statefile"
)

// Kits on the laptop: fetched from a link (a git repository, a gist, a
// kit.json URL) or a folder, kept in ~/.berth/kits/<id>/, and applied to
// projects on any box. Plugins can ship kits too.

const kitManifest = "kit.json"

const errKitChanged = "the kit changed since it was reviewed; review it again"

// KitSource records where a kept kit came from, so it can be updated.
type KitSource struct {
	Src     string    `json:"src"`
	Commit  string    `json:"commit,omitempty"`
	Fetched time.Time `json:"fetched"`
	// Team is set for a team setup's kit taken on its own (teamkit.go): it
	// is read again from that team setup's newer commits.
	Team *box.KitTeam `json:"team,omitempty"`
}

// KitInfo describes a kit for listing and review.
type KitInfo struct {
	box.Kit
	// Origin is "user" for ~/.berth/kits, "plugin:<id>" for a plugin's.
	Origin string     `json:"origin"`
	Source *KitSource `json:"source,omitempty"`
	Hash   string     `json:"hash"`
	Path   string     `json:"path"`
	// FileList is every file the kit carries, with its size.
	FileList []KitFile `json:"file_list"`
}

type KitFile struct {
	Path string `json:"path"`
	Size int64  `json:"size"`
	// Text is the content of small text files, for review before applying.
	Text string `json:"text,omitempty"`
}

func (a *Agent) kitsDir() string { return filepath.Join(a.cfg.UserDir, "kits") }

// readKit reads the kit in dir and hashes everything it carries.
func readKit(dir string, withText bool) (KitInfo, error) {
	b, err := os.ReadFile(filepath.Join(dir, kitManifest))
	if err != nil {
		return KitInfo{}, fmt.Errorf("no %s in %s", kitManifest, dir)
	}
	var k box.Kit
	if err := json.Unmarshal(b, &k); err != nil {
		return KitInfo{}, fmt.Errorf("%s: %w", kitManifest, err)
	}
	if k.ID == "" {
		return KitInfo{}, fmt.Errorf("%s has no id", kitManifest)
	}
	info := KitInfo{Kit: k, Path: dir, FileList: []KitFile{}}
	h := sha256.New()
	h.Write(b)
	var paths []string
	filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if d.IsDir() && (d.Name() == ".git" || d.Name() == "node_modules") {
			return filepath.SkipDir
		}
		rel, _ := filepath.Rel(dir, p)
		if d.IsDir() || rel == kitManifest || rel == "source.json" {
			return nil
		}
		paths = append(paths, filepath.ToSlash(rel))
		return nil
	})
	sort.Strings(paths)
	for _, rel := range paths {
		data, err := os.ReadFile(filepath.Join(dir, rel))
		if err != nil {
			continue
		}
		h.Write([]byte(rel))
		h.Write(data)
		f := KitFile{Path: rel, Size: int64(len(data))}
		if withText && len(data) < 64<<10 && !strings.ContainsRune(string(data), 0) {
			f.Text = string(data)
		}
		info.FileList = append(info.FileList, f)
	}
	for rel, content := range k.Files {
		h.Write([]byte(rel))
		h.Write([]byte(content))
		info.FileList = append(info.FileList, KitFile{Path: rel, Size: int64(len(content)), Text: content})
	}
	info.Hash = hex.EncodeToString(h.Sum(nil))[:12]
	if src, err := os.ReadFile(filepath.Join(dir, "source.json")); err == nil {
		var s KitSource
		if json.Unmarshal(src, &s) == nil {
			info.Source = &s
		}
	}
	return info, nil
}

// kits lists the kept kits, then the ones plugins ship.
func (a *Agent) kits() []KitInfo {
	out := []KitInfo{}
	dirs, _ := filepath.Glob(filepath.Join(a.kitsDir(), "*", kitManifest))
	for _, m := range dirs {
		if k, err := readKit(filepath.Dir(m), false); err == nil {
			k.Origin = "user"
			out = append(out, k)
		}
	}
	for _, p := range a.plugins() {
		if !p.Enabled {
			continue
		}
		var m struct {
			Kits []string `json:"kits"`
		}
		b, err := os.ReadFile(filepath.Join(a.cfg.UserDir, "plugins", p.ID, hooks.PluginManifest))
		if err != nil || json.Unmarshal(b, &m) != nil {
			continue
		}
		for _, rel := range m.Kits {
			dir := filepath.Join(a.cfg.UserDir, "plugins", p.ID, filepath.Clean("/"+rel))
			if k, err := readKit(dir, false); err == nil {
				k.Origin = "plugin:" + p.ID
				out = append(out, k)
			}
		}
	}
	return out
}

func (a *Agent) kit(id string) (KitInfo, bool) {
	for _, k := range a.kits() {
		if k.ID == id {
			return k, true
		}
	}
	return KitInfo{}, false
}

var githubTree = regexp.MustCompile(`^https://github\.com/([^/]+)/([^/]+)/tree/([^/]+)(?:/(.*))?$`)

// fetchKit gets a kit from src into a fresh folder under tmpRoot and returns
// the kit's folder in it and the commit it came from.
// knownHosts are where a kit link written without https:// is still meant
// as a web link ("github.com/me/kit"), not a local path.
var knownHosts = []string{"github.com/", "gist.github.com/", "gitlab.com/", "bitbucket.org/", "codeberg.org/"}

// withScheme puts https:// in front of a link to a known git host that was
// written without one.
func withScheme(src string) string {
	for _, h := range knownHosts {
		if strings.HasPrefix(src, h) {
			return "https://" + src
		}
	}
	return src
}

func fetchKit(ctx context.Context, src, tmpRoot string) (dir, commit string, err error) {
	src = withScheme(strings.TrimSpace(src))
	if src == "" || strings.HasPrefix(src, "-") {
		return "", "", errors.New("give a kit link: a git repository, a gist, a kit.json URL, or a folder")
	}
	if p := expandHome(src); filepath.IsAbs(p) {
		if _, err := os.Stat(filepath.Join(p, kitManifest)); err != nil {
			return "", "", fmt.Errorf("no %s in %s", kitManifest, p)
		}
		return p, "", nil
	}
	if err := os.MkdirAll(tmpRoot, 0o700); err != nil {
		return "", "", err
	}
	work, err := os.MkdirTemp(tmpRoot, "fetch-")
	if err != nil {
		return "", "", err
	}
	ctx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()

	// A kit.json on its own, such as a gist's raw file.
	if strings.HasSuffix(strings.SplitN(src, "?", 2)[0], ".json") && strings.HasPrefix(src, "https://") {
		req, _ := http.NewRequestWithContext(ctx, http.MethodGet, src, nil)
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			return "", "", err
		}
		defer resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			return "", "", fmt.Errorf("%s answered %s", src, resp.Status)
		}
		b, err := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
		if err != nil {
			return "", "", err
		}
		return work, "", os.WriteFile(filepath.Join(work, kitManifest), b, 0o600)
	}

	// A git repository, optionally a subfolder and a ref:
	// https://github.com/o/r, …/tree/REF/sub/dir, URL#sub/dir, URL@ref.
	repo, ref, sub := src, "", ""
	if m := githubTree.FindStringSubmatch(src); m != nil {
		repo, ref, sub = "https://github.com/"+m[1]+"/"+m[2], m[3], m[4]
	} else {
		if i := strings.Index(repo, "#"); i >= 0 {
			repo, sub = repo[:i], repo[i+1:]
		}
		if u, err := url.Parse(repo); err == nil && u.Host != "" {
			if i := strings.LastIndex(u.Path, "@"); i > 0 {
				ref = u.Path[i+1:]
				u.Path = u.Path[:i]
				repo = u.String()
			}
			if u.Host == "gist.github.com" && !strings.HasSuffix(repo, ".git") {
				repo += ".git"
			}
		}
	}
	args := []string{"clone", "--depth", "1", "--quiet"}
	if ref != "" {
		args = append(args, "--branch", ref)
	}
	args = append(args, "--", repo, filepath.Join(work, "repo"))
	cmd := exec.CommandContext(ctx, "git", args...)
	// ext:: runs a command and file:: reads this computer: a kit link gets
	// network transports only.
	cmd.Env = append(os.Environ(), "GIT_TERMINAL_PROMPT=0", "GIT_ALLOW_PROTOCOL="+box.GitProtocols)
	if out, err := cmd.CombinedOutput(); err != nil {
		return "", "", fmt.Errorf("could not fetch %s: %s", repo, strings.TrimSpace(string(out)))
	}
	if out, err := exec.CommandContext(ctx, "git", "-C", filepath.Join(work, "repo"), "rev-parse", "HEAD").Output(); err == nil {
		commit = strings.TrimSpace(string(out))
	}
	dir = filepath.Join(work, "repo", filepath.Clean("/"+sub))
	if _, err := os.Stat(filepath.Join(dir, kitManifest)); err != nil {
		return "", "", fmt.Errorf("no %s in %s", kitManifest, src)
	}
	return dir, commit, nil
}

func expandHome(p string) string {
	if p == "~" || strings.HasPrefix(p, "~/") {
		if home, err := os.UserHomeDir(); err == nil {
			return filepath.Join(home, p[1:])
		}
	}
	return p
}

// keepKit copies a fetched kit into ~/.berth/kits/<id>/, replacing any kit
// with that id, and records its source.
func (a *Agent) keepKit(dir, src, commit string) (KitInfo, error) {
	info, err := readKit(dir, false)
	if err != nil {
		return KitInfo{}, err
	}
	if !regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,47}$`).MatchString(info.ID) {
		return KitInfo{}, fmt.Errorf("kit id %q must be lowercase letters, digits and dashes", info.ID)
	}
	dest := filepath.Join(a.kitsDir(), info.ID)
	if filepath.Clean(dir) == filepath.Clean(dest) {
		return readKit(dest, false)
	}
	tmp := dest + ".new"
	os.RemoveAll(tmp)
	if err := copyTree(dir, tmp); err != nil {
		return KitInfo{}, err
	}
	s, _ := json.MarshalIndent(KitSource{Src: src, Commit: commit, Fetched: time.Now().UTC()}, "", "  ")
	if err := statefile.Write(filepath.Join(tmp, "source.json"), s); err != nil {
		return KitInfo{}, err
	}
	os.RemoveAll(dest)
	if err := os.Rename(tmp, dest); err != nil {
		return KitInfo{}, err
	}
	k, err := readKit(dest, false)
	k.Origin = "user"
	return k, err
}

func copyTree(src, dst string) error {
	return filepath.WalkDir(src, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() && (d.Name() == ".git" || d.Name() == "node_modules") {
			return filepath.SkipDir
		}
		rel, _ := filepath.Rel(src, p)
		target := filepath.Join(dst, rel)
		if d.IsDir() {
			return os.MkdirAll(target, 0o755)
		}
		if !d.Type().IsRegular() {
			return nil
		}
		data, err := os.ReadFile(p)
		if err != nil {
			return err
		}
		info, _ := d.Info()
		mode := os.FileMode(0o644)
		if info != nil && info.Mode()&0o111 != 0 {
			mode = 0o755
		}
		return os.WriteFile(target, data, mode)
	})
}

// kitInstall packs a kit for a box: its manifest and every file, base64.
func kitInstall(k KitInfo) (box.KitInstall, error) {
	in := box.KitInstall{Kit: k.Kit, Files: map[string]string{}, Hash: k.Hash}
	if k.Source != nil {
		in.Source, in.Team = k.Source.Src, k.Source.Team
	} else {
		in.Source = k.Origin
	}
	for _, f := range k.FileList {
		if _, inline := k.Kit.Files[f.Path]; inline {
			continue
		}
		data, err := os.ReadFile(filepath.Join(k.Path, filepath.FromSlash(f.Path)))
		if err != nil {
			return in, err
		}
		in.Files[f.Path] = base64.StdEncoding.EncodeToString(data)
	}
	return in, nil
}

// KitTarget is a project on a box.
type KitTarget struct {
	Box      string `json:"box"`
	Location string `json:"location"`
}

// applyKit installs k on one project.
func (a *Agent) applyKit(ctx context.Context, k KitInfo, t KitTarget) (box.KitResult, error) {
	c, ok := a.client(t.Box)
	if !ok {
		return box.KitResult{}, fmt.Errorf("no paired box named %s", t.Box)
	}
	in, err := kitInstall(k)
	if err != nil {
		return box.KitResult{}, err
	}
	var res box.KitResult
	err = box.NewClient(c).Call(ctx, http.MethodPut, "/v1/locations/"+url.PathEscape(t.Location)+"/kit", in, &res)
	return res, err
}

// InstalledKitOn is a kit installed on a project, with whether this laptop
// has a newer version of it.
type InstalledKitOn struct {
	Box string `json:"box"`
	box.InstalledKitAt
	Outdated bool `json:"outdated"`
}

func (a *Agent) installedKits(ctx context.Context) []InstalledKitOn {
	kept := map[string]string{}
	for _, k := range a.kits() {
		kept[k.ID] = k.Hash
	}
	var online []string
	for _, b := range a.status().Boxes {
		if b.State == StateOnline {
			online = append(online, b.Name)
		}
	}
	// Every box at once; the answers keep the boxes' order.
	each := make([][]box.InstalledKitAt, len(online))
	fanOut(len(online), func(i int) {
		c, ok := a.client(online[i])
		if !ok {
			return
		}
		cctx, cancel := context.WithTimeout(ctx, 10*time.Second)
		defer cancel()
		var at []box.InstalledKitAt
		if box.NewClient(c).Call(cctx, http.MethodGet, "/v1/kits", nil, &at) == nil {
			each[i] = at
		}
	})
	out := []InstalledKitOn{}
	for n, at := range each {
		for _, i := range at {
			h, ok := kept[i.Kit.ID]
			out = append(out, InstalledKitOn{Box: online[n], InstalledKitAt: i, Outdated: ok && h != i.Kit.Hash})
		}
	}
	return out
}

func (a *Agent) kitRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/kits", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, a.kits())
	})
	mux.HandleFunc("GET /v1/kits/installed", func(w http.ResponseWriter, r *http.Request) {
		a.sync()
		writeJSON(w, http.StatusOK, a.installedKits(r.Context()))
	})
	mux.HandleFunc("GET /v1/kits/{id}", func(w http.ResponseWriter, r *http.Request) {
		k, ok := a.kit(r.PathValue("id"))
		if !ok {
			writeError(w, http.StatusNotFound, "no kit called "+r.PathValue("id"))
			return
		}
		full, err := readKit(k.Path, true)
		if err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		full.Origin = k.Origin
		writeJSON(w, http.StatusOK, full)
	})
	// preview fetches a kit for review without keeping it.
	mux.HandleFunc("POST /v1/kits/preview", func(w http.ResponseWriter, r *http.Request) {
		var req struct{ Src string }
		if !decodeBody(w, r, &req) {
			return
		}
		tmp := filepath.Join(a.cfg.Dir, "kit-fetch")
		dir, commit, err := fetchKit(r.Context(), req.Src, tmp)
		if err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		defer os.RemoveAll(tmp)
		info, err := readKit(dir, true)
		if err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		info.Source = &KitSource{Src: req.Src, Commit: commit, Fetched: time.Now().UTC()}
		_, exists := a.kit(info.ID)
		writeJSON(w, http.StatusOK, map[string]any{"kit": info, "replaces": exists})
	})
	// add keeps a kit. The link is fetched again, so a reviewer passes the
	// hash the preview showed and only that exact kit is kept: a source
	// that changed in between is refused rather than kept unseen.
	mux.HandleFunc("POST /v1/kits/add", func(w http.ResponseWriter, r *http.Request) {
		var req struct{ Src, Hash string }
		if !decodeBody(w, r, &req) {
			return
		}
		tmp := filepath.Join(a.cfg.Dir, "kit-fetch")
		dir, commit, err := fetchKit(r.Context(), req.Src, tmp)
		if err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		defer os.RemoveAll(tmp)
		if req.Hash != "" {
			fetched, err := readKit(dir, false)
			if err != nil {
				writeError(w, http.StatusBadRequest, err.Error())
				return
			}
			if fetched.Hash != req.Hash {
				writeError(w, http.StatusConflict, errKitChanged)
				return
			}
		}
		k, err := a.keepKit(dir, req.Src, commit)
		if err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		if req.Hash != "" && k.Hash != req.Hash {
			os.RemoveAll(k.Path)
			writeError(w, http.StatusConflict, errKitChanged)
			return
		}
		a.publish(Event{Type: "kit.added", Data: map[string]any{"kit": k.ID, "source": req.Src}})
		writeJSON(w, http.StatusOK, k)
	})
	mux.HandleFunc("POST /v1/kits/{id}/update", func(w http.ResponseWriter, r *http.Request) {
		k, ok := a.kit(r.PathValue("id"))
		if !ok || k.Source == nil || k.Origin != "user" {
			writeError(w, http.StatusBadRequest, "only kits added from a link can be updated from it")
			return
		}
		// A team setup's kit is read again from the setup's newest commit.
		if k.Source.Team != nil {
			g, err := newGH()
			if err != nil {
				writeError(w, http.StatusBadRequest, err.Error())
				return
			}
			nk, changed, err := a.updateTeamKit(r.Context(), g, k)
			if err != nil {
				writeError(w, http.StatusBadGateway, err.Error())
				return
			}
			writeJSON(w, http.StatusOK, map[string]any{"kit": nk, "changed": changed})
			return
		}
		tmp := filepath.Join(a.cfg.Dir, "kit-fetch")
		dir, commit, err := fetchKit(r.Context(), k.Source.Src, tmp)
		if err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		defer os.RemoveAll(tmp)
		nk, err := a.keepKit(dir, k.Source.Src, commit)
		if err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"kit": nk, "changed": nk.Hash != k.Hash})
	})
	mux.HandleFunc("DELETE /v1/kits/{id}", func(w http.ResponseWriter, r *http.Request) {
		k, ok := a.kit(r.PathValue("id"))
		if !ok || k.Origin != "user" {
			writeError(w, http.StatusNotFound, "no kit of yours called "+r.PathValue("id"))
			return
		}
		if err := os.RemoveAll(k.Path); err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, map[string]string{"removed": k.ID})
	})
	// apply installs a kit on projects, streaming one line per project.
	mux.HandleFunc("POST /v1/kits/{id}/apply", func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Targets []KitTarget `json:"targets"`
			// Hash, when given, is the kit the caller reviewed; a kept kit
			// that has changed since is not applied.
			Hash string `json:"hash"`
		}
		if !decodeBody(w, r, &req) {
			return
		}
		k, ok := a.kit(r.PathValue("id"))
		if !ok {
			writeError(w, http.StatusNotFound, "no kit called "+r.PathValue("id"))
			return
		}
		if req.Hash != "" && req.Hash != k.Hash {
			writeError(w, http.StatusConflict, errKitChanged)
			return
		}
		a.sync()
		w.Header().Set("Content-Type", "application/x-ndjson")
		w.WriteHeader(http.StatusOK)
		rc := http.NewResponseController(w)
		enc := json.NewEncoder(w)
		failed := 0
		for _, t := range req.Targets {
			res, err := a.applyKit(r.Context(), k, t)
			line := map[string]any{"box": t.Box, "location": t.Location}
			if err != nil {
				failed++
				line["error"] = err.Error()
			} else {
				line["kit"], line["warnings"] = res.Kit, res.Warnings
			}
			enc.Encode(line)
			rc.Flush()
		}
		done := map[string]any{"done": true, "applied": len(req.Targets) - failed}
		if failed > 0 {
			done["error"] = fmt.Sprintf("%d of %d projects failed", failed, len(req.Targets))
		}
		enc.Encode(done)
		rc.Flush()
	})
	mux.HandleFunc("POST /v1/kits/remove", func(w http.ResponseWriter, r *http.Request) {
		var t KitTarget
		if !decodeBody(w, r, &t) {
			return
		}
		c, ok := a.client(t.Box)
		if !ok {
			writeError(w, http.StatusNotFound, "no paired box named "+t.Box)
			return
		}
		var out box.InstalledKit
		if err := box.NewClient(c).Call(r.Context(), http.MethodDelete, "/v1/locations/"+url.PathEscape(t.Location)+"/kit", nil, &out); err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, out)
	})
	// save turns a project's own setup on a box into a kit on this laptop.
	mux.HandleFunc("POST /v1/kits/save", func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			KitTarget
			ID, Name, Description string
		}
		if !decodeBody(w, r, &req) {
			return
		}
		c, ok := a.client(req.Box)
		if !ok {
			writeError(w, http.StatusNotFound, "no paired box named "+req.Box)
			return
		}
		var cfg box.Config
		if err := box.NewClient(c).Call(r.Context(), http.MethodGet, "/v1/locations/"+url.PathEscape(req.Location)+"/config", nil, &cfg); err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		// What the box adds over the repository: its kit's layer and its own.
		var base box.RepoConfig
		if cfg.Kit != nil {
			base = cfg.Kit.Config
		}
		k := box.Kit{ID: req.ID, Name: req.Name, Description: req.Description, Version: "1", Config: box.Merge(base, cfg.Local)}
		var locs []box.Location
		if box.NewClient(c).Call(r.Context(), http.MethodGet, "/v1/locations", nil, &locs) == nil {
			for _, l := range locs {
				if l.Name == req.Location {
					k.Match.Slug = l.Slug
				}
			}
		}
		dir, err := os.MkdirTemp(a.cfg.Dir, "kit-save-")
		if err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		defer os.RemoveAll(dir)
		// Scripts the kit already carried come along.
		if cfg.Kit != nil {
			if existing, ok := a.kit(cfg.Kit.ID); ok {
				copyTree(existing.Path, dir)
				os.Remove(filepath.Join(dir, "source.json"))
			}
		}
		b, _ := json.MarshalIndent(k, "", "  ")
		if err := os.WriteFile(filepath.Join(dir, kitManifest), append(b, '\n'), 0o600); err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		kept, err := a.keepKit(dir, "", "")
		if err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		os.Remove(filepath.Join(kept.Path, "source.json"))
		kept, _ = readKit(kept.Path, false)
		kept.Origin = "user"
		writeJSON(w, http.StatusOK, kept)
	})
}
