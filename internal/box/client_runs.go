package box

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strconv"

	"github.com/cosscom/shipyard/internal/box/runs"
)

// StartRun starts a run; idem, when set, is its Idempotency-Key, so a
// retried start returns the run it already made.
func (c *Client) StartRun(ctx context.Context, req RunRequest, idem string) (out runs.Summary, err error) {
	var h http.Header
	if idem != "" {
		h = http.Header{"Idempotency-Key": {idem}}
	}
	return out, c.callHeader(ctx, http.MethodPost, "/v1/runs", h, req, &out)
}

// Runs lists runs, newest first.
func (c *Client) Runs(ctx context.Context, f runs.Filter) (out []runs.Summary, err error) {
	q := url.Values{}
	if f.Status != "" {
		q.Set("status", f.Status)
	}
	if f.Template != "" {
		q.Set("template", f.Template)
	}
	if f.Flow != "" {
		q.Set("flow", f.Flow)
	}
	if f.Limit > 0 {
		q.Set("limit", strconv.Itoa(f.Limit))
	}
	return out, c.call(ctx, http.MethodGet, "/v1/runs?"+q.Encode(), nil, &out)
}

// Run returns one run with its steps.
func (c *Client) Run(ctx context.Context, id string) (out runs.Run, err error) {
	return out, c.call(ctx, http.MethodGet, "/v1/runs/"+url.PathEscape(id), nil, &out)
}

// RunTemplates lists the box's run templates.
func (c *Client) RunTemplates(ctx context.Context) (out []runs.Template, err error) {
	return out, c.call(ctx, http.MethodGet, "/v1/runs/templates", nil, &out)
}

// CancelRun stops a run.
func (c *Client) CancelRun(ctx context.Context, id string) error {
	return c.call(ctx, http.MethodPost, "/v1/runs/"+url.PathEscape(id)+"/cancel", nil, nil)
}

// RejudgeRun asks an attempts run's judge again, about the attempts as
// they are now; the run stays at its pick.
func (c *Client) RejudgeRun(ctx context.Context, id string) (runs.Evaluation, error) {
	var out runs.Evaluation
	return out, c.call(ctx, http.MethodPost, "/v1/runs/"+url.PathEscape(id)+"/judge", nil, &out)
}

// DecideGate approves or rejects a run's gate; step "" is the open one.
func (c *Client) DecideGate(ctx context.Context, id, step string, d GateDecision) error {
	if step == "" {
		step = "current"
	}
	return c.call(ctx, http.MethodPost, "/v1/runs/"+url.PathEscape(id)+"/gates/"+url.PathEscape(step)+"/decide", d, nil)
}

// RunRecord is one line of a run's journal, numbered.
type RunRecord struct {
	N int `json:"n"`
	runs.Record
}

// RunEvents streams a run's journal from record since; follow keeps it
// open until the run ends.
func (c *Client) RunEvents(ctx context.Context, id string, since int, follow bool, fn func(RunRecord)) error {
	q := url.Values{"since": {strconv.Itoa(since)}}
	if !follow {
		q.Set("follow", "0")
	}
	resp, err := c.Doer.DoWithHeader(ctx, http.MethodGet, "/v1/runs/"+url.PathEscape(id)+"/events?"+q.Encode(), nil, http.Header{})
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("box replied %s", resp.Status)
	}
	sc := bufio.NewScanner(resp.Body)
	sc.Buffer(make([]byte, 0, 64<<10), 1<<20)
	for sc.Scan() {
		var r RunRecord
		if json.Unmarshal(sc.Bytes(), &r) == nil {
			fn(r)
		}
	}
	return sc.Err()
}
