package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"runtime"
	"strings"
	"time"

	"github.com/cosscom/shipyard/internal/agentcli"
	"github.com/cosscom/shipyard/internal/guided"
	"github.com/cosscom/shipyard/internal/integrations"
	"github.com/cosscom/shipyard/internal/service"
)

const agentsUsage = "usage: berthd agents install [--integrations] [--markers] claude|codex|cursor|opencode|grok ... | berthd agents list [--json]"

// agents installs agent CLIs here, as this user, into ~/.local/bin, with no
// sudo: `berthd agents install claude codex`. The guided install runs it on
// a new box, a team setup's agents step runs it, and the app's "Add agents"
// on a box runs it through the box API. --integrations then installs their
// hooks and skills; --markers prints a step marker for each agent, for a
// checklist.
func agents(args []string, out io.Writer) error {
	if len(args) == 0 {
		return errors.New(agentsUsage)
	}
	switch args[0] {
	case "list":
		fs := flag.NewFlagSet("agents list", flag.ContinueOnError)
		asJSON := fs.Bool("json", false, "print JSON")
		if err := fs.Parse(args[1:]); err != nil {
			return err
		}
		return listAgents(out, *asJSON)
	case "install":
		return agentsInstall(args[1:], out)
	}
	return errors.New(agentsUsage)
}

func agentsInstall(args []string, out io.Writer) error {
	fs := flag.NewFlagSet("agents install", flag.ContinueOnError)
	withIntegrations := fs.Bool("integrations", false, "then install their hooks and skills")
	markers := fs.Bool("markers", false, "print a step marker as each agent starts and ends")
	var ids []string
	rest := args
	for len(rest) > 0 {
		if err := fs.Parse(rest); err != nil {
			return err
		}
		if fs.NArg() == 0 {
			break
		}
		ids = append(ids, fs.Arg(0))
		rest = fs.Args()[1:]
	}
	list, err := agentcli.ParseList(strings.Join(ids, ","))
	if err != nil {
		return err
	}
	if len(list) == 0 {
		return errors.New(agentsUsage)
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return err
	}
	in := agentcli.New(home, runtime.GOOS, runtime.GOARCH, out)
	ctx := context.Background()
	var failed []string
	for _, id := range list {
		step := "agent-" + id
		if *markers {
			fmt.Fprint(out, guided.Marker(step, guided.Start, ""))
		}
		res, err := in.Install(ctx, id)
		if err != nil {
			fmt.Fprintln(out, err)
			failed = append(failed, id)
			if *markers {
				fmt.Fprint(out, guided.Marker(step, guided.Fail, err.Error()))
			}
			continue
		}
		if *markers {
			state := guided.Done
			if res.Already {
				state = guided.Skip
			}
			fmt.Fprint(out, guided.Marker(step, state, res.Path))
		}
	}
	// Agents in ~/.local/bin are found by a login shell only if its PATH
	// has the folder; Ubuntu's ~/.profile adds it once it exists.
	login, _ := service.LoginShellPATH(5 * time.Second)
	if file, err := agentcli.EnsureLoginPATH(home, service.UserShell(), login); err != nil {
		fmt.Fprintf(out, "Could not add ~/.local/bin to your login PATH: %v\n", err)
	} else if file != "" {
		fmt.Fprintf(out, "Added ~/.local/bin to your PATH in %s (new logins pick it up).\n", file)
	}
	if *withIntegrations {
		if *markers {
			fmt.Fprint(out, guided.Marker("integrations", guided.Start, ""))
		}
		exe, err := os.Executable()
		if err == nil {
			err = integrations.InstallPresent(home, exe, out)
		}
		if *markers {
			if err != nil {
				fmt.Fprint(out, guided.Marker("integrations", guided.Fail, err.Error()))
			} else {
				fmt.Fprint(out, guided.Marker("integrations", guided.Done, ""))
			}
		}
		if err != nil {
			failed = append(failed, "integrations")
		}
	}
	if len(failed) > 0 {
		return fmt.Errorf("not installed: %s", strings.Join(failed, ", "))
	}
	return nil
}

// agentState is one agent CLI as `berthd agents list` reports it.
type agentState struct {
	agentcli.Agent
	Installed bool   `json:"installed"`
	Path      string `json:"path,omitempty"`
}

func agentStates() []agentState {
	home, _ := os.UserHomeDir()
	in := agentcli.New(home, runtime.GOOS, runtime.GOARCH, io.Discard)
	var out []agentState
	for _, a := range agentcli.Catalog {
		s := agentState{Agent: a}
		s.Path, s.Installed = in.Find(a)
		out = append(out, s)
	}
	return out
}

func listAgents(out io.Writer, asJSON bool) error {
	states := agentStates()
	if asJSON {
		return json.NewEncoder(out).Encode(states)
	}
	for _, s := range states {
		switch {
		case s.Installed:
			fmt.Fprintf(out, "%-13s installed  %s\n", s.Name, s.Path)
		case s.Offered:
			fmt.Fprintf(out, "%-13s -          berthd agents install %s\n", s.Name, s.ID)
		default:
			fmt.Fprintf(out, "%-13s -          %s\n", s.Name, s.Install)
		}
	}
	return nil
}
