package boxcmd

import (
	"context"
	"flag"
	"fmt"
	"io"
	"os"

	"github.com/cosscom/shipyard/internal/box"
)

// substatesCmd lists and edits the sub-states of Needs you (box/substates.go).
// An edit made here is stamped by the box, and the app spreads it to the
// others.
func substatesCmd(ctx context.Context, c *box.Client, args []string, out io.Writer) error {
	usage := usageErr("substates [list] [--json] | add --name N --description D [--id ID] | edit ID [--name N] [--description D] | remove ID | order ID... | preset | clear")
	fs, asJSON := flags(args)
	name := fs.String("name", "", "the sub-state's name")
	desc := fs.String("description", "", "what it means, for turn check to place a session by")
	id := fs.String("id", "", "its ID (made from the name if left out)")
	pos, err := parse(fs, args)
	if err != nil {
		return usage
	}
	given := map[string]bool{}
	fs.Visit(func(f *flag.Flag) { given[f.Name] = true })
	// Who it was shows in Settings: the agent this runs in, if any.
	c = c.WithCaller(os.Getenv("BERTH_SESSION"))
	action := "list"
	if len(pos) > 0 {
		action, pos = pos[0], pos[1:]
	}
	var set box.SubStateSet
	switch action {
	case "list":
		if len(pos) > 0 {
			return usage
		}
		if set, err = c.SubStates(ctx); err != nil {
			return fmt.Errorf("this box may run an older berthd without sub-states; update it (berth upgrade): %w", err)
		}
	case "add":
		if len(pos) > 0 || *name == "" || *desc == "" {
			return usage
		}
		set, err = c.AddSubState(ctx, box.SubState{ID: *id, Name: *name, Description: *desc})
	case "edit":
		if len(pos) != 1 || (!given["name"] && !given["description"]) {
			return usage
		}
		var newName, newDesc *string
		if given["name"] {
			newName = name
		}
		if given["description"] {
			newDesc = desc
		}
		set, err = c.EditSubState(ctx, pos[0], newName, newDesc)
	case "remove", "rm":
		if len(pos) != 1 {
			return usage
		}
		set, err = c.RemoveSubState(ctx, pos[0])
	case "order":
		if len(pos) == 0 {
			return usage
		}
		set, err = c.OrderSubStates(ctx, pos)
	case "preset":
		set, err = c.UseSubStatePreset(ctx)
	case "clear":
		set, err = c.ClearSubStates(ctx)
	default:
		return usage
	}
	if err != nil {
		return err
	}
	return show(out, *asJSON, set, func() {
		if len(set.States) == 0 {
			fmt.Fprintln(out, "No sub-states: Needs you is one column.")
		}
		for i, s := range set.States {
			mark := ""
			if i == 0 {
				mark = " (default)"
			}
			fmt.Fprintf(out, "%s  %s%s\n  %s\n", s.ID, s.Name, mark, s.Description)
		}
		if set.ChangedBy != "" {
			fmt.Fprintf(out, "Last change: %s, by %s, %s\n", set.Change, set.ChangedBy, set.ChangedAt.Local().Format("2 Jan 15:04"))
		}
	})
}
