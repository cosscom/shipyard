package box

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

// A worktree's files, for the app's ⌘P picker and File tab: a fuzzy list
// of the worktree's files, one file's text (with an etag naming its
// contents), and a write that only lands on the version it was made
// against. They are the worktree's, not a session's, so they work in a
// worktree with no agent in it.
//
//	GET /v1/locations/{name}/worktrees/{worktree}/files?q=&limit=
//	GET /v1/locations/{name}/worktrees/{worktree}/files?dir=   (worktreefolder.go)
//	GET /v1/locations/{name}/worktrees/{worktree}/file?path=[&stat=1][&raw=1][&turn=1]
//	PUT /v1/locations/{name}/worktrees/{worktree}/file?path=   If-Match: "<etag>" | If-None-Match: *
//	GET /v1/locations/{name}/worktrees/{worktree}/touched
//
// Like the transcript and the session diff, a file is the worktree's
// content, so only paired peers reach these; nothing is kept.

const (
	// maxEditableFile is the largest file the File tab opens: larger ones
	// are refused with a reason (open them in your editor).
	maxEditableFile = 2 << 20
	// maxRawFile is the largest image served for display (?raw=1).
	maxRawFile = 20 << 20
	// maxPickerResults bounds one ⌘P answer.
	maxPickerResults = 200
	// filesFresh is how long a worktree's file list is reused.
	filesFresh = 10 * time.Second
)

// CodeFileChanged is a write refused because the file changed since the
// version it was made against (412): the answer carries the file now.
const CodeFileChanged = "file_changed"

// WorktreeFile is a file of the worktree: what GET …/file answers, and,
// without content, what a write answers and ?stat=1 polls.
type WorktreeFile struct {
	Path string `json:"path"`
	// Etag names the contents (a hash of them); a write must name the
	// version it replaces (If-Match).
	Etag  string `json:"etag"`
	Mtime int64  `json:"mtime"`
	Size  int64  `json:"size"`
	// Content is the text, when the file is text and small enough.
	Content *string `json:"content,omitempty"`
	// Binary: not UTF-8 text. Image is its type when it is a picture the
	// app can show (?raw=1 serves it).
	Binary bool   `json:"binary,omitempty"`
	Image  string `json:"image,omitempty"`
	// TooLarge: past maxEditableFile; Reason says so in words.
	TooLarge bool   `json:"too_large,omitempty"`
	Reason   string `json:"reason,omitempty"`
	// Deleted, in a refused write's answer: the file is gone.
	Deleted bool `json:"deleted,omitempty"`
	// Turn is what the agent's latest turn did to the file (?turn=1), with
	// the file as the turn found it.
	Turn *FileTurn `json:"turn,omitempty"`
}

// ---- Paths ---------------------------------------------------------------

var (
	errPathOutside = httpError{http.StatusForbidden, "that path is outside the worktree"}
	errPathGit     = httpError{http.StatusForbidden, "Shipyard doesn't open or write git's own files (.git)"}
	errDangling    = httpError{http.StatusForbidden, "that path is a link to something that isn't there"}
)

// cleanWorktreePath checks a path the app names: relative to the worktree,
// clean, inside it, and never in .git. It is the path as the app shows it,
// with forward slashes.
func cleanWorktreePath(p string) (string, error) {
	if p == "" || strings.ContainsRune(p, 0) {
		return "", badRequest("which file? Pass ?path=, relative to the worktree")
	}
	if filepath.IsAbs(p) || strings.HasPrefix(p, "/") || strings.HasPrefix(p, `\`) {
		return "", badRequest("give the path relative to the worktree, not %s", p)
	}
	c := filepath.Clean(filepath.FromSlash(p))
	if c == "." {
		return "", badRequest("that path is the worktree itself, not a file")
	}
	if c == ".." || strings.HasPrefix(c, ".."+string(filepath.Separator)) {
		return "", errPathOutside
	}
	if gitPart(c) {
		return "", errPathGit
	}
	return filepath.ToSlash(c), nil
}

// gitPart says whether any part of a relative path is .git.
func gitPart(rel string) bool {
	for _, part := range strings.Split(filepath.ToSlash(rel), "/") {
		if strings.EqualFold(part, ".git") {
			return true
		}
	}
	return false
}

// realPath is p with its symlinks resolved; for a file that doesn't exist
// yet, its folder's, and its own name.
func realPath(p string) (string, error) {
	r, err := filepath.EvalSymlinks(p)
	if err == nil {
		return r, nil
	}
	if !errors.Is(err, fs.ErrNotExist) {
		return "", err
	}
	if st, lerr := os.Lstat(p); lerr == nil && st.Mode()&fs.ModeSymlink != 0 {
		// A link to something missing: where it leads can't be checked.
		return "", errDangling
	}
	dir, err := filepath.EvalSymlinks(filepath.Dir(p))
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, filepath.Base(p)), nil
}

// relInside is target relative to root, when it is inside it (and not
// root itself).
func relInside(root, target string) (string, bool) {
	r, err := filepath.Rel(root, target)
	if err != nil || r == "." || r == ".." || strings.HasPrefix(r, ".."+string(filepath.Separator)) || filepath.IsAbs(r) {
		return "", false
	}
	return r, true
}

// worktreeFile resolves a path the app names to the file on disk: clean,
// and still inside the worktree, outside .git, once every symlink on the
// way is followed. A file that doesn't exist resolves through its folder.
func worktreeFile(root, p string) (abs, rel string, err error) {
	rel, err = cleanWorktreePath(p)
	if err != nil {
		return "", "", err
	}
	realRoot, err := filepath.EvalSymlinks(root)
	if err != nil {
		return "", "", httpError{http.StatusNotFound, "the worktree's folder is missing: " + root}
	}
	abs, err = realPath(filepath.Join(realRoot, filepath.FromSlash(rel)))
	if errors.Is(err, fs.ErrNotExist) {
		return "", "", httpError{http.StatusNotFound, rel + " isn't in this worktree"}
	}
	if err != nil {
		return "", "", err
	}
	inner, ok := relInside(realRoot, abs)
	if !ok {
		return "", "", errPathOutside
	}
	if gitPart(inner) {
		return "", "", errPathGit
	}
	return abs, rel, nil
}

// ---- Contents ------------------------------------------------------------

func etagOf(data []byte) string {
	sum := sha256.Sum256(data)
	return "sha256-" + hex.EncodeToString(sum[:16])
}

// bigEtag names a file too large to hash on every poll by its size and
// time instead.
func bigEtag(st fs.FileInfo) string {
	return "stat-" + strconv.FormatInt(st.Size(), 36) + "-" + strconv.FormatInt(st.ModTime().UnixNano(), 36)
}

// unquoteEtag reads an etag from If-Match: quoted or not, weak or not.
func unquoteEtag(s string) string {
	s = strings.TrimSpace(s)
	s = strings.TrimPrefix(s, "W/")
	return strings.Trim(s, `"`)
}

// isBinary says data isn't text the editor can hold: a NUL early on, or
// not UTF-8.
func isBinary(data []byte) bool {
	head := data[:min(len(data), 8000)]
	for _, c := range head {
		if c == 0 {
			return true
		}
	}
	return !utf8.Valid(data)
}

// imageTypes are the pictures the app shows instead of refusing.
var imageTypes = map[string]string{
	".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
	".webp": "image/webp", ".avif": "image/avif", ".bmp": "image/bmp", ".ico": "image/x-icon",
}

func imageType(path string) string { return imageTypes[strings.ToLower(filepath.Ext(path))] }

func sizeWords(n int64) string {
	switch {
	case n >= 1<<20:
		return strconv.FormatFloat(float64(n)/(1<<20), 'f', 1, 64) + " MB"
	case n >= 1<<10:
		return strconv.FormatInt(n>>10, 10) + " KB"
	}
	return strconv.FormatInt(n, 10) + " bytes"
}

// readWorktreeFile reads the file at abs for the app: its text when it is
// text and small enough, else why not. withContent false is a stat: the
// etag and times only.
func readWorktreeFile(abs, rel string, withContent bool) (WorktreeFile, error) {
	st, err := os.Stat(abs)
	if errors.Is(err, fs.ErrNotExist) {
		return WorktreeFile{}, httpError{http.StatusNotFound, rel + " isn't in this worktree (any more)"}
	}
	if err != nil {
		return WorktreeFile{}, err
	}
	if st.IsDir() {
		return WorktreeFile{}, badRequest("%s is a folder, not a file", rel)
	}
	if !st.Mode().IsRegular() {
		return WorktreeFile{}, badRequest("%s isn't a regular file", rel)
	}
	f := WorktreeFile{Path: rel, Size: st.Size(), Mtime: st.ModTime().UnixMilli(), Image: imageType(rel)}
	if st.Size() > maxEditableFile {
		f.Etag, f.TooLarge = bigEtag(st), true
		f.Binary = f.Image != ""
		f.Reason = fmt.Sprintf("%s is %s, more than the %s Shipyard opens. Open it in your editor.", filepath.Base(rel), sizeWords(st.Size()), sizeWords(maxEditableFile))
		return f, nil
	}
	data, err := os.ReadFile(abs)
	if err != nil {
		return WorktreeFile{}, err
	}
	f.Etag, f.Size = etagOf(data), int64(len(data))
	if st2, err := os.Stat(abs); err == nil {
		f.Mtime = st2.ModTime().UnixMilli()
	}
	if isBinary(data) {
		f.Binary = true
		if f.Image == "" {
			f.Reason = filepath.Base(rel) + " isn't text, so the editor can't show it. Open it in your editor."
		}
		return f, nil
	}
	f.Image = ""
	if withContent {
		s := string(data)
		f.Content = &s
	}
	return f, nil
}

func (b *Box) getWorktreeFile(w http.ResponseWriter, r *http.Request) error {
	_, wt, err := b.worktreeRef(r.Context(), r.PathValue("name"), r.PathValue("worktree"))
	if err != nil {
		return err
	}
	q := r.URL.Query()
	abs, rel, err := worktreeFile(wt.Path, q.Get("path"))
	if err != nil {
		return err
	}
	if q.Get("raw") == "1" {
		return serveImage(w, abs, rel)
	}
	f, err := readWorktreeFile(abs, rel, q.Get("stat") != "1")
	if err != nil {
		return err
	}
	if q.Get("turn") == "1" {
		f.Turn = b.fileTurn(r, wt, rel)
	}
	writeJSON(w, f)
	return nil
}

// serveImage sends a picture's bytes, for the File tab to show. Nothing
// else is served raw: text comes as JSON, and other files not at all.
func serveImage(w http.ResponseWriter, abs, rel string) error {
	typ := imageType(rel)
	if typ == "" {
		return httpError{http.StatusUnsupportedMediaType, rel + " isn't a picture Shipyard shows"}
	}
	st, err := os.Stat(abs)
	if err != nil || !st.Mode().IsRegular() {
		return httpError{http.StatusNotFound, rel + " isn't in this worktree (any more)"}
	}
	if st.Size() > maxRawFile {
		return httpError{http.StatusRequestEntityTooLarge, fmt.Sprintf("%s is %s, more than the %s Shipyard shows", filepath.Base(rel), sizeWords(st.Size()), sizeWords(maxRawFile))}
	}
	data, err := os.ReadFile(abs)
	if err != nil {
		return err
	}
	w.Header().Set("ETag", `"`+etagOf(data)+`"`)
	return writePicture(w, typ, data)
}

// writePicture sends a picture's bytes as typ, and never as anything a
// browser would run.
func writePicture(w http.ResponseWriter, typ string, data []byte) error {
	h := w.Header()
	h.Set("Content-Type", typ)
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("Content-Security-Policy", "default-src 'none'; sandbox")
	_, err := w.Write(data)
	return err
}

// fileLocks serialises writes to one file, so two saves can't both pass
// the same If-Match.
var fileLocks sync.Map // abs path → *sync.Mutex

func lockFile(abs string) func() {
	v, _ := fileLocks.LoadOrStore(abs, &sync.Mutex{})
	mu := v.(*sync.Mutex)
	mu.Lock()
	return mu.Unlock
}

func (b *Box) putWorktreeFile(w http.ResponseWriter, r *http.Request) error {
	_, wt, err := b.worktreeRef(r.Context(), r.PathValue("name"), r.PathValue("worktree"))
	if err != nil {
		return err
	}
	ifMatch, ifNone := r.Header.Get("If-Match"), strings.TrimSpace(r.Header.Get("If-None-Match"))
	if ifMatch == "" && ifNone != "*" {
		return httpError{http.StatusPreconditionRequired, "say which version this replaces: If-Match with its etag, or If-None-Match: * to make a new file"}
	}
	var in struct {
		Content *string `json:"content"`
	}
	if err := decodeLimit(r, &in, maxFileBody); err != nil {
		return err
	}
	if in.Content == nil {
		return badRequest("the request has no content")
	}
	if len(*in.Content) > maxEditableFile {
		return httpError{http.StatusRequestEntityTooLarge, fmt.Sprintf("that is %s, more than the %s Shipyard writes", sizeWords(int64(len(*in.Content))), sizeWords(maxEditableFile))}
	}
	abs, rel, err := worktreeFile(wt.Path, r.URL.Query().Get("path"))
	if err != nil {
		return err
	}
	defer lockFile(abs)()

	cur, err := readWorktreeFile(abs, rel, true)
	var he httpError
	exists := err == nil
	if err != nil && !(errors.As(err, &he) && he.status == http.StatusNotFound) {
		return err
	}
	switch {
	case ifNone == "*" && exists:
		writeChanged(w, rel+" already exists", cur)
		return nil
	case ifMatch != "" && !exists:
		writeChanged(w, rel+" was deleted since you opened it", WorktreeFile{Path: rel, Deleted: true})
		return nil
	case ifMatch != "" && strings.TrimSpace(ifMatch) != "*" && unquoteEtag(ifMatch) != cur.Etag:
		writeChanged(w, rel+" changed since you opened it", cur)
		return nil
	}
	mode := fs.FileMode(0o644)
	if st, err := os.Stat(abs); err == nil {
		mode = st.Mode().Perm()
	}
	data := []byte(*in.Content)
	if err := writeAtomic(abs, data, mode); err != nil {
		return err
	}
	if !exists {
		// A new file shows in the Files panel and ⌘P at once.
		forgetWorktreeFiles(wt.Path)
	}
	out := WorktreeFile{Path: rel, Etag: etagOf(data), Size: int64(len(data))}
	if st, err := os.Stat(abs); err == nil {
		out.Mtime = st.ModTime().UnixMilli()
	}
	w.Header().Set("ETag", `"`+out.Etag+`"`)
	writeJSON(w, out)
	return nil
}

// maxFileBody bounds a write's request: the content, JSON-escaped.
const maxFileBody = 4*maxEditableFile + 64<<10

// writeChanged refuses a write with 412 and the file as it is now, so the
// app can show what changed instead of overwriting it.
func writeChanged(w http.ResponseWriter, msg string, now WorktreeFile) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusPreconditionFailed)
	json.NewEncoder(w).Encode(struct {
		Error string `json:"error"`
		Code  string `json:"code"`
		WorktreeFile
	}{msg, CodeFileChanged, now})
}

// writeAtomic replaces the file at abs with data: written beside it, then
// renamed over it, so nothing ever reads half a file.
func writeAtomic(abs string, data []byte, mode fs.FileMode) error {
	var rnd [6]byte
	rand.Read(rnd[:])
	tmp := filepath.Join(filepath.Dir(abs), "."+filepath.Base(abs)+".berth-"+hex.EncodeToString(rnd[:]))
	if err := os.WriteFile(tmp, data, mode); err != nil {
		return err
	}
	_ = os.Chmod(tmp, mode)
	if err := os.Rename(tmp, abs); err != nil {
		os.Remove(tmp)
		return err
	}
	return nil
}

// ---- The file list -------------------------------------------------------

var worktreeFilesCache sync.Map // dir → filesEntry

// cachedFiles is gitFiles for dir, reused for filesFresh.
func cachedFiles(ctx context.Context, dir string) ([]string, bool, error) {
	if v, ok := worktreeFilesCache.Load(dir); ok {
		if e := v.(filesEntry); time.Since(e.at) < filesFresh {
			return e.files, e.more, nil
		}
	}
	all, more, err := gitFiles(ctx, dir)
	if err != nil {
		return nil, false, err
	}
	worktreeFilesCache.Store(dir, filesEntry{at: time.Now(), dir: dir, files: all, more: more})
	return all, more, nil
}

func (b *Box) listWorktreeFiles(w http.ResponseWriter, r *http.Request) error {
	_, wt, err := b.worktreeRef(r.Context(), r.PathValue("name"), r.PathValue("worktree"))
	if err != nil {
		return err
	}
	if r.URL.Query().Has("dir") {
		return b.listWorktreeFolder(w, r, wt)
	}
	all, more, err := cachedFiles(r.Context(), wt.Path)
	if err != nil {
		return err
	}
	if more {
		// Past maxListedFiles the list loses the tracked files late in
		// the alphabet (git lists the untracked first): what the agents
		// touched this turn is searched all the same.
		all = withTouched(all, b.touchedIn(r, wt))
	}
	limit := maxFileResults
	if n, err := strconv.Atoi(r.URL.Query().Get("limit")); err == nil && n > 0 {
		limit = min(n, maxPickerResults)
	}
	var files []string
	for _, f := range RankFiles(all, r.URL.Query().Get("q"), limit*2) {
		if !gitPart(f) {
			files = append(files, f)
		}
	}
	writeJSON(w, FileList{Files: files[:min(limit, len(files))], Truncated: more})
	return nil
}

// withTouched is all with the touched files it lacks (those still there)
// added at its end.
func withTouched(all []string, touched []FileTurn) []string {
	var extra []string
	for _, t := range touched {
		if !t.Deleted && !slices.Contains(all, t.Path) && !slices.Contains(extra, t.Path) {
			extra = append(extra, t.Path)
		}
	}
	if len(extra) == 0 {
		return all
	}
	return append(slices.Clip(all), extra...)
}

// RankFiles is the files that match q, best first, as the ⌘P picker ranks
// them: every letter of q in order (fuzzyScore), rewarded for runs, word
// starts and landing in the file's own name. An empty q is the first
// files.
func RankFiles(all []string, q string, limit int) []string {
	q = strings.ToLower(strings.Join(strings.Fields(q), ""))
	if q == "" {
		return append([]string{}, all[:min(limit, len(all))]...)
	}
	type hit struct {
		f     string
		score float64
	}
	var hits []hit
	for _, f := range all {
		if s, ok := fuzzyScore(q, f); ok {
			hits = append(hits, hit{f, s})
		}
	}
	sort.SliceStable(hits, func(i, j int) bool {
		if hits[i].score != hits[j].score {
			return hits[i].score > hits[j].score
		}
		return hits[i].f < hits[j].f
	})
	out := make([]string, 0, min(limit, len(hits)))
	for _, h := range hits[:min(limit, len(hits))] {
		out = append(out, h.f)
	}
	return out
}

// fuzzyScore scores path for the lower-case query q as the app's picker
// does (app/src/lib/file-match.ts): each letter of q in order, greedily
// from each place the first could match, the best of those kept. A letter
// earns 1, 4 more right after the last, 3 at a word's start (after / . _ -
// or a capital), 2 in the file's own name; a gap costs a little, and so
// does a long path.
func fuzzyScore(q, path string) (float64, bool) {
	p := strings.ToLower(path)
	if len(p) != len(path) {
		// Case folding changed the length (rare scripts): match as is.
		p = path
	}
	base := strings.LastIndexByte(path, '/') + 1
	best, found := 0.0, false
	hits := make([]int, len(q))
	for st := strings.IndexByte(p, q[0]); st >= 0; {
		i, ok := st, true
		for k := 0; k < len(q); k++ {
			at := strings.IndexByte(p[i:], q[k])
			if at < 0 {
				ok = false
				break
			}
			hits[k] = i + at
			i += at + 1
		}
		if !ok {
			break
		}
		score := 0.0
		for k, h := range hits {
			score++
			if k > 0 && hits[k-1] == h-1 {
				score += 4
			}
			if h == 0 || strings.IndexByte("/._-", path[h-1]) >= 0 || (path[h] >= 'A' && path[h] <= 'Z') {
				score += 3
			}
			if h >= base {
				score += 2
			}
			if k > 0 {
				score -= min(3, float64(h-hits[k-1]-1)*0.05)
			}
		}
		if !found || score > best {
			best, found = score, true
		}
		next := strings.IndexByte(p[st+1:], q[0])
		if next < 0 {
			break
		}
		st += next + 1
	}
	if !found {
		return 0, false
	}
	return best - float64(len(path))*0.02, true
}
