// Package adapters turns each coding agent's own hooks into berth's agent
// events, and says what each agent can report. An adapter keeps only
// identifiers and the working directory: prompts, messages and transcripts
// never leave the agent.
package adapters

import "strings"

// Signal is what an agent event says happened in its turn.
const (
	Ready    = "agent.ready"    // at its prompt, nothing asked yet
	Started  = "agent.started"  // working on a prompt
	Waiting  = "agent.waiting"  // needs someone: a permission or a question
	Finished = "agent.finished" // its turn ended
	Exited   = "agent.exited"   // the agent itself stopped
)

// Caps is what an adapter can tell. An agent without Started has its turn
// start when berth sends to it; one without Waiting never says it needs
// someone, so the screen adapter watches for that.
type Caps struct {
	Ready    bool `json:"ready"`
	Started  bool `json:"started"`
	Waiting  bool `json:"waiting"`
	Finished bool `json:"finished"`
	// FinalMessage is set when the agent can hand over its last message
	// (opt-in; berth does not read it today).
	FinalMessage bool `json:"final_message"`
	// Via is how berth hears from it: hooks, notify, plugin or screen.
	Via string `json:"via"`
}

// Adapter translates one agent's hook calls.
type Adapter struct {
	Name string
	Caps Caps
	// Translate maps a hook event and its payload to a berth event type
	// and the identifiers worth keeping. ok is false for events not worth
	// announcing.
	Translate func(hook string, in Payload) (typ string, data map[string]any, ok bool)
}

// Payload is a hook's JSON input.
type Payload map[string]any

func (p Payload) Str(k string) string {
	s, _ := p[k].(string)
	return s
}

var registry = map[string]*Adapter{}

func register(a *Adapter) *Adapter {
	registry[a.Name] = a
	return a
}

// For returns the adapter for an agent preset or tool, if berth has one.
func For(name string) (*Adapter, bool) {
	a, ok := registry[name]
	return a, ok
}

// All lists the adapters, for the API and docs.
func All() []*Adapter {
	return []*Adapter{Claude, Codex, Cursor, Gemini, OpenCode, Grok, Screen}
}

// CapsFor is an agent's capabilities: the screen's for anything unknown.
func CapsFor(agent string) Caps {
	if a, ok := registry[agent]; ok {
		return a.Caps
	}
	return Screen.Caps
}

func lower(s string) string { return strings.ToLower(s) }
