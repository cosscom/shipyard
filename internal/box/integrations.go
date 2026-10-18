package box

import (
	"bytes"
	"net/http"
	"os"
	"strings"

	"github.com/cosscom/shipyard/internal/integrations"
)

// Integrations are the hooks agent CLIs on this box run to report their
// needs-you, working and done states, and Shipyard's skills. berthd install
// sets them up for the CLIs it finds; these let the app add them for a CLI
// installed since.

// IntegrationTool is one agent CLI and whether berth's hooks are in its
// settings for this box's user: Hooked for its default account, and for
// Claude Code and Codex each account folder in Accounts.
type IntegrationTool struct {
	integrations.Tool
	Present  bool                        `json:"present"`
	Hooked   bool                        `json:"hooked"`
	Accounts []integrations.AccountState `json:"accounts,omitempty"`
}

// IntegrationsReport lists the agent CLIs berth has integrations for.
type IntegrationsReport struct {
	Tools []IntegrationTool `json:"tools"`
	// Output is what an install did, in berthd integrations install's words.
	Output string `json:"output,omitempty"`
}

func integrationsReport() (IntegrationsReport, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return IntegrationsReport{}, err
	}
	out := IntegrationsReport{Tools: []IntegrationTool{}}
	for _, t := range integrations.Tools {
		it := IntegrationTool{Tool: t, Present: t.Present(home), Hooked: t.Hooked(home)}
		if _, ok := integrations.AccountVars[t.ID]; ok && it.Present {
			it.Accounts = integrations.AccountStates(home, t.ID)
		}
		out.Tools = append(out.Tools, it)
	}
	return out, nil
}

func (b *Box) listIntegrations(w http.ResponseWriter, r *http.Request) error {
	rep, err := integrationsReport()
	if err != nil {
		return err
	}
	writeJSON(w, rep)
	return nil
}

// installIntegrations installs one tool's hooks and skills for this box's
// user, as `berthd integrations install TOOL` does: in every account folder,
// or with Account, in that one (the Usage plugin's "Add account…").
func (b *Box) installIntegrations(w http.ResponseWriter, r *http.Request) error {
	var req struct {
		Tool    string `json:"tool"`
		Account string `json:"account,omitempty"`
	}
	if err := decode(r, &req); err != nil {
		return err
	}
	if _, ok := integrations.ToolByID(req.Tool); !ok {
		return badRequest("unknown tool %q; use %s or all", req.Tool, strings.Join(integrations.AllTools, ", "))
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return err
	}
	self, err := b.self()
	if err != nil {
		return err
	}
	data := map[string]any{"tool": req.Tool}
	if req.Account != "" {
		data["account"] = req.Account
	}
	if err := b.before(r, "integrations.install", data); err != nil {
		return err
	}
	// One installed since berthd last looked counts.
	b.refreshAgents(r.Context())
	var out bytes.Buffer
	if req.Account != "" {
		err = integrations.InstallAccount(home, req.Tool, req.Account, self, &out)
	} else {
		err = integrations.InstallTool(home, req.Tool, self, &out)
	}
	if err != nil {
		return badRequest("%v", err)
	}
	b.publish(r, "integrations.installed", data)
	rep, err := integrationsReport()
	if err != nil {
		return err
	}
	rep.Output = strings.TrimSpace(out.String())
	writeJSON(w, rep)
	return nil
}

// self is the berthd binary serving this box, which hooks and wrappers run.
func (b *Box) self() (string, error) {
	if b.Update != nil && b.Update.Executable != "" {
		return b.Update.Executable, nil
	}
	return os.Executable()
}
