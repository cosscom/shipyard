package box

import (
	"context"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/cosscom/shipyard/internal/events"
	"github.com/cosscom/shipyard/internal/integrations/adapters"
)

// A new agent can't read a prompt yet. It is still drawing, or, in a
// folder it hasn't seen, it asks first whether to trust it (Claude Code,
// Codex). That question takes keys only. Text typed into it is dropped,
// and the Enter after it answers the question: Claude Code highlights
// "No, exit", so a prompt sent then ends the session before the prompt it
// was started with (on its command line, which the agent keeps until it
// is trusted) ever runs.
//
// So while an agent session starts, berth watches its screen. A send waits
// until the agent has drawn. While a startup question shows, prompts are
// held in the session's inbox, typed once the person has answered and the
// agent is at its prompt, and the screen poller leaves its turn alone.

// startupQuestions are the words of those questions. notify: the chat is
// told the agent waits (agent.waiting). Codex's numbered menu isn't, so the
// chat opens its own screen for it, as it did before, rather than offering
// its options as buttons (a digit picks one there, but Enter confirms).
var startupQuestions = []struct {
	words  string
	notify bool
}{
	{"Yes, I trust this folder", true},                     // Claude Code, in a folder it has not seen
	{"Do you trust the files in this", true},               // older Claude Code
	{"Do you trust the contents of this directory", false}, // Codex
}

// stillLoading is a screen an agent draws before it is ready: Codex shows
// its frame with "model: loading" while it starts, and asks whether to
// trust the folder only after that.
var stillLoading = regexp.MustCompile(`model:\s+loading\b`)

// startupHints are the key hints those questions show at their foot. One
// must show too, so the words alone (in a file the agent prints, say) are
// never taken for the question.
var startupHints = []string{"enter to confirm", "press enter to continue"}

// startupQuestion says whether screen shows an agent's startup question,
// and whether to say it waits.
func startupQuestion(screen string) (asked, notify bool) {
	lines := strings.Split(strings.TrimRight(screen, "\n "), "\n")
	if len(lines) > 24 {
		lines = lines[len(lines)-24:]
	}
	foot := strings.Join(lines, "\n")
	low := strings.ToLower(foot)
	hinted := false
	for _, h := range startupHints {
		if strings.Contains(low, h) {
			hinted = true
		}
	}
	if !hinted {
		return false, false
	}
	for _, q := range startupQuestions {
		if strings.Contains(foot, q.words) {
			return true, q.notify
		}
	}
	return false, false
}

// How the watch goes. A send waits at most startupSendWait for the agent to
// draw; a blank screen counts as drawn once the session is startupBlank
// old. The watch looks for a question for startupWatch, and gives an
// answered agent startupSettle to reach its prompt.
var (
	startupPoll     = 250 * time.Millisecond
	startupSendWait = 5 * time.Second
	startupBlank    = 3 * time.Second
	startupWatch    = 20 * time.Second
	startupSettle   = 8 * time.Second
)

const (
	startBooting = iota // drawing, or answered and drawing its prompt
	startAsking         // showing its startup question
	startReady          // at its prompt, or working
)

// startup is one session's watch.
type startup struct {
	mu      sync.Mutex
	state   int
	changed chan struct{}
}

type startKey struct {
	b    *Box
	name string
}

var startups sync.Map // startKey → *startup

func (st *startup) set(state int) {
	st.mu.Lock()
	defer st.mu.Unlock()
	if st.state != state {
		st.state = state
		close(st.changed)
		st.changed = make(chan struct{})
	}
}

func (st *startup) get() (int, <-chan struct{}) {
	st.mu.Lock()
	defer st.mu.Unlock()
	return st.state, st.changed
}

// beginStartup starts watching a new agent session; from is who started it.
func (b *Box) beginStartup(from string, sess Session) {
	if sess.Agent == "" || b.Sessions == nil {
		return
	}
	st := &startup{changed: make(chan struct{})}
	startups.Store(startKey{b, sess.Name}, st)
	go b.watchStartup(from, sess, st)
}

// startingState is where a session's start is: startReady when it isn't
// being watched.
func (b *Box) startingState(name string) int {
	if v, ok := startups.Load(startKey{b, name}); ok {
		s, _ := v.(*startup).get()
		return s
	}
	return startReady
}

// awaitDrawn waits, for at most startupSendWait, while a new agent is still
// drawing, and says where its start is then.
func (b *Box) awaitDrawn(ctx context.Context, name string) int {
	v, ok := startups.Load(startKey{b, name})
	if !ok {
		return startReady
	}
	st := v.(*startup)
	limit := time.NewTimer(startupSendWait)
	defer limit.Stop()
	for {
		s, changed := st.get()
		if s != startBooting {
			return s
		}
		select {
		case <-changed:
		case <-limit.C:
			return s
		case <-ctx.Done():
			return s
		}
	}
}

// atStartupQuestion says whether a session's agent shows its startup
// question now: from its watch, or, for one no watch follows (berthd
// restarted while it asked), from its screen.
func (b *Box) atStartupQuestion(ctx context.Context, sess Session) bool {
	if sess.Agent == "" {
		return false
	}
	if v, ok := startups.Load(startKey{b, sess.Name}); ok {
		s, _ := v.(*startup).get()
		return s == startAsking
	}
	screen, err := b.Sessions.capture(ctx, sess.Name, 0)
	if err != nil {
		return false
	}
	asked, _ := startupQuestion(screen)
	return asked
}

// startupHeld says whether a held prompt must wait for the agent's start:
// it is drawing, or asks its startup question.
func (b *Box) startupHeld(ctx context.Context, name string) bool {
	if b.startingState(name) != startReady {
		return true
	}
	sess, err := b.Sessions.Get(ctx, name)
	if err != nil {
		return false
	}
	sess.Agent = agentFor(sess)
	return b.atStartupQuestion(ctx, sess)
}

// watchStartup reads a new agent session's screen until it is at its
// prompt: it says when the agent stops at its startup question, and, once
// that is answered, lets what waited for it go on.
func (b *Box) watchStartup(from string, sess Session, st *startup) {
	ctx := context.Background()
	key := startKey{b, sess.Name}
	defer func() {
		st.set(startReady)
		startups.CompareAndDelete(key, st)
		if b.Turns != nil {
			b.Turns.kickInbox()
		}
	}()
	began := time.Now()
	var answered time.Time
	told := false
	last, same := "", 0
	for {
		poll := startupPoll
		if s, _ := st.get(); s == startAsking && time.Since(began) > startupWatch {
			// Asking a while: nobody is waiting on a quick answer.
			poll = time.Second
		}
		time.Sleep(poll)
		cur, err := b.Sessions.Get(ctx, sess.Name)
		if err != nil || cur.Exited {
			return
		}
		screen, err := b.Sessions.capture(ctx, sess.Name, 0)
		if err != nil {
			return
		}
		if asked, notify := startupQuestion(screen); asked {
			st.set(startAsking)
			if notify && !told {
				told = true
				// From the screen: its hooks don't run until it is trusted.
				b.Events.Publish(events.Event{Type: adapters.Waiting, Box: b.Name, Origin: from, Data: map[string]any{
					"path": sess.Dir, "agent": sess.Agent, "session": sess.Name, "reason": "startup question", "source": "screen",
				}})
			}
			last, same = screen, 0
			continue
		}
		if s, _ := st.get(); s == startAsking {
			// Answered: it draws its prompt next.
			st.set(startBooting)
			answered = time.Now()
			last, same = "", 0
			continue
		}
		if screen == last {
			same++
		} else {
			last, same = screen, 0
		}
		blank := strings.TrimSpace(screen) == ""
		loading := stillLoading.MatchString(screen)
		drawn := same >= 2 && (!blank || time.Since(began) > startupBlank) && !loading
		if answered.IsZero() {
			// Starting: drawn once its hooks speak or its screen holds
			// still. A question can still come, so the watch goes on a
			// while.
			if drawn || b.hooked(sess.Name) && !loading || time.Since(began) > startupWatch {
				st.set(startReady)
			}
			if time.Since(began) > startupWatch {
				return
			}
			continue
		}
		// Answered: at its prompt once its screen holds still (working on
		// the prompt it started with, it never does: then after a while).
		if drawn || time.Since(answered) > startupSettle {
			b.startupAnswered(from, sess)
			return
		}
	}
}

// startupAnswered tells the ledger an agent that waited at its startup
// question is at its prompt, when nothing else did: its hooks say so
// themselves, but an agent without them would wait on forever, and so
// would the prompts held for it.
func (b *Box) startupAnswered(from string, sess Session) {
	if b.Turns == nil {
		return
	}
	if ss, ok := b.Turns.State(sess.Name); !ok || ss.State != "waiting" {
		return
	}
	b.Events.Publish(events.Event{Type: adapters.Ready, Box: b.Name, Origin: from, Data: map[string]any{
		"path": sess.Dir, "agent": sess.Agent, "session": sess.Name, "source": "screen",
	}})
}

// hooked says whether the session's agent has reported through its own
// hooks.
func (b *Box) hooked(name string) bool {
	if b.Turns == nil {
		return false
	}
	t := b.Turns
	t.mu.Lock()
	defer t.mu.Unlock()
	s := t.sess[name]
	return s != nil && s.Hooked
}

// startupPrompt records the prompt an agent was started with, on its
// command line, as the session's first turn, as a send would: the ledger
// then has it open while the agent asks its startup question, so prompts
// sent meanwhile wait for it to end, and waits have a turn to wait on.
func (b *Box) startupPrompt(origin, from string, sess Session) {
	if b.Turns == nil || sess.Agent == "" {
		return
	}
	b.Events.Publish(events.Event{Type: "session.sent", Box: b.Name, Origin: origin, Data: map[string]any{
		"name": sess.Name, "from": from, "agent": sess.Agent, "startup": true,
	}})
}

// startupText is the error for typing text into a startup question.
func startupText(agent string) error {
	who := "The agent"
	for _, p := range builtinAgents {
		if p.ID == agent {
			who = p.Name
		}
	}
	return httpError{409, who + " is asking whether to trust this folder, which takes keys, not text: answer it in its screen first"}
}
