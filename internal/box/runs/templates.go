package runs

import (
	"embed"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"sort"
	"strings"
	"time"
)

// Templates are built-in parameterised flows, templates/<name>.json. A
// template's steps take parameters two ways:
//
//   - ${name} (or ${a.b} into an object parameter) stands for a whole JSON
//     value and is replaced by the parameter JSON-encoded, so a parameter
//     can fill a number, a list or a command, but never add a field;
//   - {{params.name}} in text fields is filled in when the step runs, like
//     any run variable.
//
//go:embed templates/*.json
var templateFS embed.FS

// ParamSpec describes one parameter.
type ParamSpec struct {
	Required    bool   `json:"required,omitempty"`
	Default     any    `json:"default,omitempty"`
	Description string `json:"description,omitempty"`
}

// Template is a template as listed.
type Template struct {
	Name        string               `json:"name"`
	Title       string               `json:"title"`
	Description string               `json:"description"`
	Params      map[string]ParamSpec `json:"params"`
	// Tokens says what the template sends agents, for the docs and audit.
	Tokens string `json:"tokens,omitempty"`
}

type templateDoc struct {
	Template
	Steps json.RawMessage `json:"steps"`
}

// Expanded is a template filled in.
type Expanded struct {
	Title  string
	Steps  []Step
	Params map[string]any
	Budget *Budget
}

func loadTemplate(name string) (templateDoc, error) {
	var t templateDoc
	if !regexp.MustCompile(`^[a-z][a-z0-9-]*$`).MatchString(name) {
		return t, fmt.Errorf("no template %q", name)
	}
	b, err := templateFS.ReadFile("templates/" + name + ".json")
	if err != nil {
		return t, fmt.Errorf("no template %q", name)
	}
	// ${name} stands for a whole value: quoted, the file is JSON, and
	// Expand replaces the quoted placeholder with the value.
	b = bare.ReplaceAll(b, []byte(`"$${$1}"`))
	if err := json.Unmarshal(b, &t); err != nil {
		return t, fmt.Errorf("template %s: %w", name, err)
	}
	return t, nil
}

// Templates lists the built-in templates.
func Templates() []Template {
	entries, _ := templateFS.ReadDir("templates")
	var out []Template
	for _, e := range entries {
		t, err := loadTemplate(strings.TrimSuffix(e.Name(), ".json"))
		if err == nil {
			out = append(out, t.Template)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out
}

var (
	bare        = regexp.MustCompile(`\$\{([a-z_][a-z0-9_.]*)\}`)
	placeholder = regexp.MustCompile(`"\$\{([a-z_][a-z0-9_.]*)\}"`)
)

// Expand fills a template in with params.
func Expand(name string, params map[string]any) (Expanded, error) {
	t, err := loadTemplate(name)
	if err != nil {
		return Expanded{}, err
	}
	p := map[string]any{}
	for k, spec := range t.Params {
		if v, ok := params[k]; ok && v != nil && v != "" {
			p[k] = v
		} else if spec.Required {
			return Expanded{}, fmt.Errorf("template %s needs %s", name, k)
		} else if spec.Default != nil {
			p[k] = spec.Default
		}
	}
	for k := range params {
		if _, ok := t.Params[k]; !ok {
			return Expanded{}, fmt.Errorf("template %s has no parameter %q", name, k)
		}
	}
	derive(name, p)
	var missing error
	text := placeholder.ReplaceAllStringFunc(string(t.Steps), func(m string) string {
		key := m[3 : len(m)-2]
		v, ok := lookup(p, key)
		if !ok {
			return "null"
		}
		b, err := json.Marshal(v)
		if err != nil {
			missing = err
			return "null"
		}
		return string(b)
	})
	if missing != nil {
		return Expanded{}, missing
	}
	var steps []Step
	if err := json.Unmarshal([]byte(text), &steps); err != nil {
		return Expanded{}, fmt.Errorf("template %s: a parameter has the wrong type: %v", name, err)
	}
	ex := Expanded{Steps: steps, Params: p}
	vars := map[string]string{}
	for k, v := range Flatten(p) {
		vars["params."+k] = v
	}
	ex.Title = ExpandText(t.Title, vars)
	if len(ex.Title) > 80 {
		ex.Title = ex.Title[:79] + "…"
	}
	if b, ok := p["budget"]; ok && b != nil {
		raw, _ := json.Marshal(b)
		var bg Budget
		if err := json.Unmarshal(raw, &bg); err != nil {
			return Expanded{}, fmt.Errorf("budget: %v", err)
		}
		if bg.MaxWall != "" {
			if _, err := time.ParseDuration(bg.MaxWall); err != nil {
				return Expanded{}, fmt.Errorf("budget max_wall %q is not a duration", bg.MaxWall)
			}
		}
		ex.Budget = &bg
	}
	return ex, nil
}

// derive adds parameters computed from others.
func derive(name string, p map[string]any) {
	countOf := func(k string) {
		if list, ok := p[k].([]any); ok && p["count"] == "" {
			p["count"] = float64(len(list))
		}
	}
	switch name {
	case "broadcast":
		countOf("sessions")
		// A name is short for {session, text}: the shared prompt.
		if list, ok := p["sessions"].([]any); ok {
			for i, v := range list {
				if s, ok := v.(string); ok {
					list[i] = map[string]any{"session": s, "text": p["text"]}
				}
			}
		}
	case "stop":
		countOf("sessions")
		// A name is short for {session}.
		if list, ok := p["sessions"].([]any); ok {
			for i, v := range list {
				if s, ok := v.(string); ok {
					list[i] = map[string]any{"session": s}
				}
			}
		}
	case "attempts":
		countOf("attempts")
		p["auto_pick"] = p["pick"] == "auto"
		if list, ok := p["attempts"].([]any); ok {
			for i, a := range list {
				// "claude" is short for {"agent": "claude"}.
				if s, ok := a.(string); ok {
					list[i] = map[string]any{"agent": s}
				}
			}
			if n, ok := p["concurrency"].(float64); !ok || n <= 0 {
				p["concurrency"] = float64(len(list))
			}
		}
	}
}

func lookup(p map[string]any, key string) (any, bool) {
	var cur any = p
	for _, part := range strings.Split(key, ".") {
		m, ok := cur.(map[string]any)
		if !ok {
			return nil, false
		}
		cur, ok = m[part]
		if !ok {
			return nil, false
		}
	}
	return cur, true
}

// Flatten turns params into variables: an object's fields as a.b too.
func Flatten(p map[string]any) map[string]string {
	out := map[string]string{}
	var walk func(prefix string, v any, depth int)
	walk = func(prefix string, v any, depth int) {
		out[prefix] = paramString(v)
		if m, ok := v.(map[string]any); ok && depth < 3 {
			for k, val := range m {
				walk(prefix+"."+k, val, depth+1)
			}
		}
	}
	for k, v := range p {
		walk(k, v, 0)
	}
	return out
}

// Kinds are the step kinds a run (and a flow) may use.
var Kinds = map[string]bool{
	"run": true, "check": true, "prompt": true, "wait": true, "start_agent": true, "notify": true, "webhook": true,
	"loop": true, "gate": true, "map": true, "join": true, "judge": true, "if": true, "pr": true, "sleep": true,
	"headless": true, "collect": true, "handoff": true, "cleanup": true, "stop_session": true, "archive_worktree": true,
}

// ValidateSteps reports the first thing wrong with steps.
func ValidateSteps(steps []Step) error {
	if len(steps) == 0 {
		return errors.New("no steps")
	}
	return validate(steps, "step", 0)
}

func validate(steps []Step, where string, depth int) error {
	if depth > 4 {
		return errors.New("steps nest more than 4 deep")
	}
	ids := map[string]bool{}
	for i, s := range steps {
		at := fmt.Sprintf("%s %d", where, i+1)
		if !Kinds[s.Kind] {
			return fmt.Errorf("%s: unknown kind %q", at, s.Kind)
		}
		if s.ID != "" {
			if ids[s.ID] {
				return fmt.Errorf("%s: two steps are called %s", at, s.ID)
			}
			ids[s.ID] = true
		}
		switch s.When {
		case "", "success", "failure", "always":
		default:
			return fmt.Errorf("%s: when must be success, failure or always", at)
		}
		need := map[string]string{"run": s.Command, "check": s.Command, "prompt": s.Text, "start_agent": s.Agent, "notify": s.Title, "webhook": s.URL, "headless": s.Text, "if": s.Cond}[s.Kind]
		if _, required := map[string]bool{"run": true, "check": true, "prompt": true, "start_agent": true, "notify": true, "webhook": true, "headless": true, "if": true}[s.Kind]; required && strings.TrimSpace(need) == "" {
			return fmt.Errorf("%s (%s) is missing what to do", at, s.Kind)
		}
		if s.Kind == "webhook" && !strings.HasPrefix(s.URL, "https://") && !strings.HasPrefix(s.URL, "http://") {
			return fmt.Errorf("%s: webhook URL must be http or https", at)
		}
		for _, d := range []string{s.Timeout, s.Duration} {
			if d != "" {
				if v, err := time.ParseDuration(d); err != nil || v <= 0 {
					return fmt.Errorf("%s: %q is not a duration", at, d)
				}
			}
		}
		switch s.Kind {
		case "loop":
			if len(s.Steps) == 0 {
				return fmt.Errorf("%s: a loop needs steps", at)
			}
			if s.Max > 50 {
				return fmt.Errorf("%s: a loop runs at most 50 rounds", at)
			}
			if err := CheckCond(s.Until); err != nil {
				return fmt.Errorf("%s: until: %v", at, err)
			}
		case "map":
			if len(s.Steps) == 0 || len(s.Items) == 0 {
				return fmt.Errorf("%s: a map needs items and steps", at)
			}
		case "if":
			if err := CheckCond(s.Cond); err != nil {
				return fmt.Errorf("%s: cond: %v", at, err)
			}
		case "sleep":
			if s.Duration == "" {
				return fmt.Errorf("%s: sleep needs a duration", at)
			}
		case "gate":
			switch s.OnTimeout {
			case "", "reject", "approve", "fail":
			default:
				return fmt.Errorf("%s: on_timeout must be reject, approve or fail", at)
			}
		case "join":
		case "judge":
			switch s.By {
			case "", "check", "agent", "human":
			default:
				return fmt.Errorf("%s: judge by must be check, agent or human", at)
			}
		}
		if s.Mode != "" && (s.Kind == "map" || s.Kind == "join") {
			switch s.Mode {
			case "all", "any", "first_success":
			default:
				return fmt.Errorf("%s: mode must be all, any or first_success", at)
			}
		}
		if err := validate(s.Steps, at+", step", depth+1); len(s.Steps) > 0 && err != nil {
			return err
		}
		if err := validate(s.Else, at+", else step", depth+1); len(s.Else) > 0 && err != nil {
			return err
		}
	}
	return nil
}
