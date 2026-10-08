package box

import (
	"bufio"
	"bytes"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// Stats is a box at a glance: how loaded it is, and what its agents are doing.
type Stats struct {
	Hostname string    `json:"hostname"`
	Uptime   int64     `json:"uptime_s,omitempty"`
	CPUs     int       `json:"cpus"`
	Load     []float64 `json:"load,omitempty"`
	Memory   Usage     `json:"memory"`
	Swap     Usage     `json:"swap"`
	Disks    []Disk    `json:"disks"`
	Agents   []Agent   `json:"agents"`
	// Hooks is true when an agent tool on the box reports to berthd, so
	// an agent's waiting or finished state is known.
	Hooks bool `json:"hooks"`
}

// Usage is bytes in use out of a total.
type Usage struct {
	Total uint64 `json:"total"`
	Used  uint64 `json:"used"`
}

type Disk struct {
	Mount string `json:"mount"`
	Usage
}

// Agent is a coding agent process running on the box.
type Agent struct {
	Tool     string `json:"tool"`
	PID      int    `json:"pid"`
	Path     string `json:"path,omitempty"`
	Location string `json:"location,omitempty"`
	Worktree string `json:"worktree,omitempty"`
	// State is "idle", "waiting" or "finished" when its hooks said so
	// last, and "running" otherwise.
	State string    `json:"state"`
	Since time.Time `json:"since,omitempty"`
}

// agentTools are the process names counted as agents.
var agentTools = map[string]string{"claude": "claude", "codex": "codex", "cursor-agent": "cursor", "grok": "grok"}

func (b *Box) handleStats(w http.ResponseWriter, r *http.Request) error {
	s := collectStats("/proc")
	locs, _ := b.Locations.List(r.Context())
	for i := range s.Agents {
		ag := &s.Agents[i]
		ag.Location, ag.Worktree = worktreeFor(locs, ag.Path)
		ag.State = "running"
		if b.Turns != nil {
			if st, at, ok := b.Turns.DirState(ag.Path); ok && st != "running" && st != "exited" && st != "" {
				ag.State, ag.Since = st, at
			}
		}
	}
	home, _ := os.UserHomeDir()
	s.Hooks = hooksInstalled(home)
	writeJSON(w, s)
	return nil
}

// worktreeFor names the location and worktree a directory is in, choosing
// the deepest worktree that contains it.
func worktreeFor(locs []Location, dir string) (location, worktree string) {
	best := -1
	for _, l := range locs {
		for _, wt := range l.Worktrees {
			if (dir == wt.Path || strings.HasPrefix(dir, wt.Path+"/")) && len(wt.Path) > best {
				best, location, worktree = len(wt.Path), l.Name, wt.Name
			}
		}
	}
	return location, worktree
}

// hooksInstalled reports whether Claude Code on this box reports to berthd.
func hooksInstalled(home string) bool {
	b, err := os.ReadFile(filepath.Join(home, ".claude", "settings.json"))
	return err == nil && bytes.Contains(b, []byte("berthd hook"))
}

func collectStats(proc string) Stats {
	return collectStatsIn(proc, "/sys/fs/cgroup")
}

// collectStatsIn reads the kernel's view, narrowed to the limits of the
// cgroup the box runs in: inside a container, the host's totals are not the
// box's to use.
func collectStatsIn(proc, cgroup string) Stats {
	s := Stats{CPUs: runtime.NumCPU()}
	s.Hostname, _ = os.Hostname()
	if b, err := os.ReadFile(filepath.Join(proc, "uptime")); err == nil {
		if f := strings.Fields(string(b)); len(f) > 0 {
			up, _ := strconv.ParseFloat(f[0], 64)
			s.Uptime = int64(up)
		}
	}
	if b, err := os.ReadFile(filepath.Join(proc, "loadavg")); err == nil {
		f := strings.Fields(string(b))
		for _, f := range f[:min(3, len(f))] {
			v, _ := strconv.ParseFloat(f, 64)
			s.Load = append(s.Load, v)
		}
	}
	s.Memory, s.Swap = memInfo(filepath.Join(proc, "meminfo"))
	if limit, used, ok := cgroupMemory(cgroup); ok && limit < s.Memory.Total {
		s.Memory = Usage{Total: limit, Used: used}
	}
	if cpus := cgroupCPUs(cgroup); cpus > 0 && cpus < s.CPUs {
		s.CPUs = cpus
	}
	// Never nil: a nil slice marshals as null, and every client reads these as
	// lists. A box with no agent running is an ordinary state, not a missing
	// field, and it should not be the client's job to tell the two apart.
	s.Disks = disks()
	if s.Disks == nil {
		s.Disks = []Disk{}
	}
	s.Agents = agentProcesses(proc)
	if s.Agents == nil {
		s.Agents = []Agent{}
	}
	return s
}

// memInfo reads /proc/meminfo. Used memory is what applications hold:
// total less what the kernel could hand out now, caches included.
func memInfo(path string) (mem, swap Usage) {
	f, err := os.Open(path)
	if err != nil {
		return
	}
	defer f.Close()
	kb := map[string]uint64{}
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		k, v, ok := strings.Cut(sc.Text(), ":")
		if !ok {
			continue
		}
		n, _ := strconv.ParseUint(strings.Fields(v)[0], 10, 64)
		kb[k] = n * 1024
	}
	mem = Usage{Total: kb["MemTotal"], Used: kb["MemTotal"] - kb["MemAvailable"]}
	swap = Usage{Total: kb["SwapTotal"], Used: kb["SwapTotal"] - kb["SwapFree"]}
	return
}

// cgroupMemory reads a cgroup v2 memory limit. Only a container's own root
// has memory.max at the top; a host's root cgroup has none.
func cgroupMemory(root string) (limit, used uint64, ok bool) {
	b, err := os.ReadFile(filepath.Join(root, "memory.max"))
	if err != nil {
		return 0, 0, false
	}
	limit, err = strconv.ParseUint(strings.TrimSpace(string(b)), 10, 64)
	if err != nil {
		return 0, 0, false // "max": no limit
	}
	b, err = os.ReadFile(filepath.Join(root, "memory.current"))
	if err != nil {
		return 0, 0, false
	}
	used, err = strconv.ParseUint(strings.TrimSpace(string(b)), 10, 64)
	return limit, used, err == nil
}

// cgroupCPUs reads a cgroup v2 CPU quota ("600000 100000" is 6 CPUs).
func cgroupCPUs(root string) int {
	b, err := os.ReadFile(filepath.Join(root, "cpu.max"))
	if err != nil {
		return 0
	}
	f := strings.Fields(string(b))
	if len(f) != 2 || f[0] == "max" {
		return 0
	}
	quota, err1 := strconv.ParseFloat(f[0], 64)
	period, err2 := strconv.ParseFloat(f[1], 64)
	if err1 != nil || err2 != nil || period == 0 {
		return 0
	}
	return int(quota/period + 0.5)
}

// disks reports the root filesystem and, when separate, the home one.
func disks() []Disk {
	var out []Disk
	seen := map[uint64]bool{}
	home, _ := os.UserHomeDir()
	for _, mount := range []string{"/", home} {
		var st syscall.Statfs_t
		if mount == "" || syscall.Statfs(mount, &st) != nil {
			continue
		}
		id := uint64(st.Blocks)<<16 ^ uint64(st.Bsize)
		if seen[id] {
			continue
		}
		seen[id] = true
		bs := uint64(st.Bsize)
		total := uint64(st.Blocks) * bs
		out = append(out, Disk{Mount: mount, Usage: Usage{Total: total, Used: total - uint64(st.Bavail)*bs}})
	}
	return out
}

// agentProcesses lists agent processes this user can see, with where they run.
func agentProcesses(proc string) []Agent {
	entries, err := os.ReadDir(proc)
	if err != nil {
		return nil
	}
	var out []Agent
	for _, e := range entries {
		pid, err := strconv.Atoi(e.Name())
		if err != nil {
			continue
		}
		dir := filepath.Join(proc, e.Name())
		comm, err := os.ReadFile(filepath.Join(dir, "comm"))
		if err != nil {
			continue
		}
		tool, ok := agentTools[strings.TrimSpace(string(comm))]
		if !ok {
			continue
		}
		cwd, err := os.Readlink(filepath.Join(dir, "cwd"))
		if err != nil {
			continue
		}
		// An agent left in a worktree that was since removed.
		cwd = strings.TrimSuffix(cwd, " (deleted)")
		out = append(out, Agent{Tool: tool, PID: pid, Path: cwd})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].PID < out[j].PID })
	return out
}
