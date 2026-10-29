package boxcmd

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"time"

	"github.com/cosscom/shipyard/internal/box"
)

// secretRequest asks the person for a secret through a card in the app,
// for the agent session it runs in. It never waits long: the answer comes
// back as a <berth-notification>, with --wait at most 90 seconds.
func secretRequest(ctx context.Context, c *box.Client, args []string, out io.Writer) error {
	fs, asJSON := flags(args)
	var req box.SecretRequestBody
	fs.StringVar(&req.Reason, "reason", "", "why it is needed; the person reads it on the card")
	fs.BoolVar(&req.New, "new", false, "ask for a new value even when one is saved")
	fs.StringVar(&req.Store, "store", "", "where to save it: local or gcp (default: the project's, else the box's)")
	fs.StringVar(&req.Environment, "environment", "", "staging or production")
	fs.StringVar(&req.Grant, "grant", "", "a service account to give read access to this one secret (gcp)")
	fs.StringVar(&req.TTL, "ttl", "", "suggest a lifetime: 1h, 24h or 7d (default: none)")
	wait := fs.Duration("wait", 0, "wait up to this long for the answer, at most 90s")
	pos, err := parse(fs, args)
	if err != nil || len(pos) != 1 {
		return usageErr("secret request NAME --reason WHY [--new] [--store local|gcp] [--environment staging|production] [--grant SA_EMAIL] [--ttl 1h|24h|7d] [--wait 90s]")
	}
	req.Name = pos[0]
	session := os.Getenv("BERTH_SESSION")
	if session == "" {
		return errors.New("run this in an agent session on the box: BERTH_SESSION names the session that hears the answer")
	}
	sr, err := c.WithCaller(session).RequestSecret(ctx, req)
	if err != nil {
		return err
	}
	if *wait > 90*time.Second {
		*wait = 90 * time.Second
	}
	if sr.Status == "pending" && *wait > 0 {
		deadline := time.Now().Add(*wait)
		for sr.Status == "pending" && time.Now().Before(deadline) {
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(time.Second):
			}
			if now, err := c.SecretRequest(ctx, sr.ID); err == nil {
				sr = now
			}
		}
	}
	if err := show(out, *asJSON, sr, func() {
		switch sr.Status {
		case "saved":
			if sr.Reused {
				fmt.Fprintf(out, "%s is saved already. Its reference is %s.\n", sr.Name, sr.Ref)
			} else {
				fmt.Fprintf(out, "The person saved %s. Its reference is %s.\n", sr.Name, sr.Ref)
			}
			fmt.Fprintf(out, "Use it in one command: berthd secret exec --env %s=%s -- COMMAND\n(--file %s=%s for a file holding it). Never print the value.\n", sr.Name, sr.Ref, sr.Name, sr.Ref)
		case "pending":
			fmt.Fprintf(out, "Asked the person for %s (request %s); a card waits in Shipyard.\n", sr.Name, sr.ID)
			fmt.Fprintln(out, "Shipyard tells you when they answer: a <berth-notification> with the reference arrives at your next idle. End your turn rather than waiting.")
		}
	}); err != nil {
		return err
	}
	switch sr.Status {
	case "declined":
		return fmt.Errorf("the person declined to give %s", sr.Name)
	case "timed_out":
		return fmt.Errorf("nobody answered the request for %s", sr.Name)
	}
	return nil
}
