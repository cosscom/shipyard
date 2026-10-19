package runs

import (
	"bufio"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/cosscom/shipyard/internal/statefile"
)

// Storage: one JSONL journal per run, runs/<id>.jsonl, and runs/index.json
// listing every run kept. Journals are only ever appended to and streamed
// one line at a time: nothing loads a whole one.

// Record is one line of a run's journal.
type Record struct {
	T       string            `json:"t"`
	At      time.Time         `json:"at"`
	Path    string            `json:"path,omitempty"`
	Attempt int               `json:"attempt,omitempty"`
	Run     *Run              `json:"run,omitempty"`
	Step    *StepRun          `json:"step,omitempty"`
	Set     map[string]string `json:"set,omitempty"`
	Status  string            `json:"status,omitempty"`
	Error   string            `json:"error,omitempty"`
	Gate    *Gate             `json:"gate,omitempty"`
	Decided *Decision         `json:"decided,omitempty"`
	Until   time.Time         `json:"until,omitzero"`
	Usage   *Usage            `json:"usage,omitempty"`
	Cand    *Candidate        `json:"candidate,omitempty"`
	Item    map[string]any    `json:"item,omitempty"`
	// Feedback is a check's failing tail, kept for the prompt after it.
	Feedback string `json:"feedback,omitempty"`
	// Eval is an evaluation of an attempts run, as it starts and ends.
	Eval *Evaluation `json:"evaluation,omitempty"`
}

// Record types.
const (
	recCreated    = "run.created"
	recStatus     = "run.status"
	recFinished   = "run.finished"
	recStarted    = "step.started"
	recOutput     = "step.output"
	recStepDone   = "step.finished"
	recGateOpen   = "gate.opened"
	recGateDone   = "gate.decided"
	recSleep      = "sleep.started"
	recCandidate  = "candidate"
	recCoalesced  = "run.coalesced"
	recCancelWant = "run.cancel"
	recEval       = "judge.evaluation"
)

// maxRecordLine bounds one journal line read back; outputs are capped far
// below it when written.
const maxRecordLine = 1 << 20

type journal struct {
	mu sync.Mutex
	f  *os.File
	n  int // records written or read
}

func openJournal(path string) (*journal, error) {
	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return nil, err
	}
	return &journal{f: f}, nil
}

// append writes one record; sync forces it to disk before returning, for
// the records a resume depends on (a prompt about to be typed, a gate's
// decision).
func (j *journal) append(r Record, sync bool) error {
	b, err := json.Marshal(r)
	if err != nil {
		return err
	}
	j.mu.Lock()
	defer j.mu.Unlock()
	if j.f == nil {
		return errors.New("journal closed")
	}
	if _, err := j.f.Write(append(b, '\n')); err != nil {
		return err
	}
	j.n++
	if sync {
		return j.f.Sync()
	}
	return nil
}

func (j *journal) count() int {
	j.mu.Lock()
	defer j.mu.Unlock()
	return j.n
}

func (j *journal) close() {
	j.mu.Lock()
	defer j.mu.Unlock()
	if j.f != nil {
		j.f.Sync()
		j.f.Close()
		j.f = nil
	}
}

// scan streams a journal's records from record number since, calling fn
// for each until it returns false. It returns how many records it read,
// counting the skipped ones. A torn last line is ignored.
func scan(path string, since int, fn func(int, Record) bool) (int, error) {
	f, err := os.Open(path)
	if err != nil {
		return 0, err
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, 64<<10), maxRecordLine)
	n := 0
	for sc.Scan() {
		i := n
		n++
		if i < since {
			continue
		}
		var r Record
		if json.Unmarshal(sc.Bytes(), &r) != nil {
			n--
			break
		}
		if !fn(i, r) {
			break
		}
	}
	if err := sc.Err(); err != nil && !errors.Is(err, io.EOF) {
		return n, err
	}
	return n, nil
}

// index is the list of runs kept, with summaries for listing.
type index struct {
	path string
	mu   sync.Mutex
	runs []Summary // oldest first
	byID map[string]int
}

func loadIndex(path string) *index {
	ix := &index{path: path}
	if b, err := os.ReadFile(path); err == nil {
		json.Unmarshal(b, &ix.runs)
	}
	ix.reindex()
	return ix
}

func (ix *index) reindex() {
	sort.SliceStable(ix.runs, func(i, j int) bool { return ix.runs[i].Created.Before(ix.runs[j].Created) })
	ix.byID = make(map[string]int, len(ix.runs))
	for i, s := range ix.runs {
		ix.byID[s.ID] = i
	}
}

func (ix *index) put(s Summary) {
	ix.mu.Lock()
	defer ix.mu.Unlock()
	if i, ok := ix.byID[s.ID]; ok {
		ix.runs[i] = s
	} else {
		ix.byID[s.ID] = len(ix.runs)
		ix.runs = append(ix.runs, s)
	}
	ix.saveLocked()
}

func (ix *index) get(id string) (Summary, bool) {
	ix.mu.Lock()
	defer ix.mu.Unlock()
	i, ok := ix.byID[id]
	if !ok {
		return Summary{}, false
	}
	return ix.runs[i], true
}

func (ix *index) saveLocked() {
	if ix.path == "" {
		return
	}
	b, err := json.Marshal(ix.runs)
	if err == nil {
		statefile.Write(ix.path, b)
	}
}

// Filter narrows List.
type Filter struct {
	Status   string // a status, or "active" (not terminal), or "done"
	Template string
	Flow     string
	Key      string
	Group    string
	Limit    int
}

func (f Filter) match(s Summary) bool {
	switch f.Status {
	case "":
	case "active":
		if Terminal(s.Status) {
			return false
		}
	case "done":
		if !Terminal(s.Status) {
			return false
		}
	default:
		ok := false
		for _, st := range strings.Split(f.Status, ",") {
			ok = ok || st == s.Status
		}
		if !ok {
			return false
		}
	}
	return (f.Template == "" || f.Template == s.Template) && (f.Flow == "" || f.Flow == s.FlowID) &&
		(f.Key == "" || f.Key == s.Key) && (f.Group == "" || f.Group == s.Group)
}

// list returns matching runs, newest first.
func (ix *index) list(f Filter) []Summary {
	ix.mu.Lock()
	defer ix.mu.Unlock()
	limit := f.Limit
	if limit <= 0 {
		limit = 50
	}
	out := []Summary{}
	for i := len(ix.runs) - 1; i >= 0 && len(out) < limit; i-- {
		if f.match(ix.runs[i]) {
			out = append(out, ix.runs[i])
		}
	}
	return out
}

// Retention: finished runs past it are compacted away, journal and all.
const (
	keepPerKind = 100
	keepFor     = 30 * 24 * time.Hour
	maxIndex    = 1000
)

// compact drops finished runs past retention: more than keepPerKind of a
// flow or template, older than keepFor, or beyond maxIndex runs in all.
// It returns the dropped IDs, whose journals the caller removes.
func (ix *index) compact(now time.Time) []string {
	ix.mu.Lock()
	defer ix.mu.Unlock()
	perKind := map[string]int{}
	keep := make([]bool, len(ix.runs))
	total := 0
	for i := len(ix.runs) - 1; i >= 0; i-- {
		s := ix.runs[i]
		if !Terminal(s.Status) {
			keep[i] = true
			total++
			continue
		}
		kind := s.Template + "/" + s.FlowID
		perKind[kind]++
		end := s.Finished
		if end.IsZero() {
			end = s.Updated
		}
		if perKind[kind] > keepPerKind || now.Sub(end) > keepFor || total >= maxIndex {
			continue
		}
		keep[i] = true
		total++
	}
	var dropped []string
	kept := ix.runs[:0]
	for i, s := range ix.runs {
		if keep[i] {
			kept = append(kept, s)
		} else {
			dropped = append(dropped, s.ID)
		}
	}
	ix.runs = kept
	if len(dropped) > 0 {
		ix.reindex()
		ix.saveLocked()
	}
	return dropped
}

func journalPath(dir, id string) string { return filepath.Join(dir, id+".jsonl") }
