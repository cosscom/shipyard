package boxcmd

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/cosscom/shipyard/internal/box"
)

// ask is `berthd ask`: an agent tells the person something needs them and
// carries on (box.AgentAsk). The answer comes back as a prompt.
func ask(ctx context.Context, c *box.Client, args []string, out io.Writer) error {
	fs, asJSON := flags(args)
	kind := fs.String("kind", "", "decision, action, ready or blocked")
	title := fs.String("title", "", "what you need, in one line")
	details := fs.String("details", "", "what they need to know to answer")
	recommended := fs.String("recommended", "", "the option you'd pick")
	session := fs.String("session", os.Getenv("BERTH_SESSION"), "the session asking (default: this one)")
	var options []box.AttentionOption
	fs.Func("option", "a decision's answer, LABEL or \"LABEL: what it means\" (repeat for each)", func(v string) error {
		label, desc, _ := strings.Cut(v, ": ")
		options = append(options, box.AttentionOption{Label: strings.TrimSpace(label), Description: strings.TrimSpace(desc)})
		return nil
	})
	pos, err := parse(fs, args)
	if err != nil || len(pos) != 0 || *kind == "" || *title == "" {
		return usageErr(`ask --kind decision|action|ready|blocked --title "…" [--details "…"] [--option "LABEL[: what it means]"]... [--recommended LABEL] [--session NAME] [--json]`)
	}
	if *session == "" {
		return errors.New("an ask comes from an agent's session: run it in one, or name it with --session")
	}
	a := box.AgentAsk{Kind: *kind, Title: *title, Details: *details, Options: options, Recommended: *recommended}
	if err := a.Check(); err != nil {
		return err
	}
	it, err := c.Ask(ctx, *session, a)
	if err != nil {
		return err
	}
	return show(out, *asJSON, it, func() {
		verb := "Posted"
		if it.Revision > 1 {
			verb = "Replaced your ask with"
		}
		fmt.Fprintf(out, "%s %s: %s\nCarry on: the answer comes to %s as a prompt when the person gives it.\n", verb, it.Kind, it.Title, *session)
	})
}
