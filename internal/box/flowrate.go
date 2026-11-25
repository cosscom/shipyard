package box

import (
	"context"
	"errors"
	"fmt"
	"time"
)

// A flow's runs-per-hour limit, and what it leaves behind when it refuses a
// start: a line in berthd's log when a flow first reaches it and one when
// starts are allowed again, and a count of refusals in the last hour that
// GET /v1/flows shows. A schedule that fires more often than its limit
// allows is warned about too, but never stopped.

// errRateLimited refuses a run past its flow's hourly limit.
var errRateLimited = errors.New("the flow reached its runs-per-hour limit")

// flowRate is one flow's starts and refusals in the last hour, and the
// streak of refusals the log has not yet summed up.
type flowRate struct {
	starts      []time.Time
	refused     []time.Time
	lastRefused time.Time
	streak      int
	streakFrom  time.Time
	streakTo    time.Time
}

// prune drops what is over an hour old at now.
func (r *flowRate) prune(now time.Time) {
	cut := now.Add(-time.Hour)
	keep := func(ts []time.Time) []time.Time {
		kept := ts[:0]
		for _, t := range ts {
			if t.After(cut) {
				kept = append(kept, t)
			}
		}
		return kept
	}
	r.starts, r.refused = keep(r.starts), keep(r.refused)
}

// maxRunsPerHour is a flow's limit, its own or the default.
func maxRunsPerHour(f Flow) int {
	if f.MaxRunsPerHour > 0 {
		return f.MaxRunsPerHour
	}
	return DefaultMaxRunsPerHour
}

// allowRate counts a start of the flow key against its hourly limit, and
// returns the slot it took (for releaseRate). A refusal is counted and, the
// first of a streak, logged; started ends the streak once a run starts.
func (f *Flows) allowRate(key string, limit int, via string) (time.Time, bool) {
	now := f.now()
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.rate == nil {
		f.rate = map[string]*flowRate{}
	}
	r := f.rate[key]
	if r == nil {
		r = &flowRate{}
		f.rate[key] = r
	}
	r.prune(now)
	if len(r.starts) >= limit {
		r.refused = append(r.refused, now)
		r.lastRefused = now
		if r.streak == 0 {
			r.streakFrom = now
			f.logf("flows: %s reached its limit of %d runs an hour; refusing its starts (first from %s) until one is allowed again", key, limit, viaName(via))
		}
		r.streak++
		r.streakTo = now
		return time.Time{}, false
	}
	r.starts = append(r.starts, now)
	return now, true
}

// started ends the flow key's streak of refusals, if it had one, now that a
// start went through: one line says how many were refused, and when.
func (f *Flows) started(key string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	r := f.rate[key]
	if r == nil || r.streak == 0 {
		return
	}
	f.logf("flows: %s: %d start%s refused %s–%s", key, r.streak, plural(r.streak), r.streakFrom.Format("15:04"), r.streakTo.Format("15:04"))
	r.streak = 0
}

// releaseRate gives back the slot a start took and did not use.
func (f *Flows) releaseRate(key string, slot time.Time) {
	f.mu.Lock()
	defer f.mu.Unlock()
	r := f.rate[key]
	if r == nil {
		return
	}
	for i := len(r.starts) - 1; i >= 0; i-- {
		if r.starts[i].Equal(slot) {
			r.starts = append(r.starts[:i], r.starts[i+1:]...)
			return
		}
	}
}

// refusals is how many starts of the flow key were refused in the last
// hour, and when the latest was.
func (f *Flows) refusals(key string) (int, time.Time) {
	now := f.now()
	f.mu.Lock()
	defer f.mu.Unlock()
	r := f.rate[key]
	if r == nil {
		return 0, time.Time{}
	}
	r.prune(now)
	if len(r.refused) == 0 {
		return 0, time.Time{}
	}
	return len(r.refused), r.lastRefused
}

func (f *Flows) logf(format string, args ...any) {
	if f.Logf != nil {
		f.Logf(format, args...)
	}
}

func viaName(via string) string {
	if via == "" {
		return "an event"
	}
	return via
}

// rateCheck is how often a scheduled flow fires against its limit.
type rateCheck struct {
	fires, worktrees, limit int
}

// warning says how many starts an hour the limit will refuse, or nothing
// when the schedule fits under it.
func (c rateCheck) warning() string {
	if c.fires <= c.limit {
		return ""
	}
	share := ""
	if c.worktrees > 1 {
		// The app words it so too, without the count it can't know.
		share = " across its worktrees, which share the limit"
	}
	return fmt.Sprintf("This schedule fires up to %d times an hour%s; the limit is %d, so about %d starts an hour will be refused.", c.fires, share, c.limit, c.fires-c.limit)
}

// flowRateCheck counts how often a scheduled flow starts in its busiest
// hour: once per firing, or once per matching worktree for each_worktree,
// the way fireScheduled starts it.
func (b *Box) flowRateCheck(ctx context.Context, sf ScopedFlow) rateCheck {
	tr := sf.Flow.Trigger
	if tr.Schedule == "" {
		return rateCheck{}
	}
	c, err := ParseCron(tr.Schedule)
	if err != nil {
		return rateCheck{}
	}
	rc := rateCheck{fires: c.FiresPerHour(b.Flows.now()), worktrees: 1, limit: maxRunsPerHour(sf.Flow)}
	if tr.EachWorktree {
		rc.worktrees = len(b.flowTargets(ctx, sf, tr.Where.Branch != ""))
		rc.fires *= rc.worktrees
	}
	return rc
}

// warnRates logs, once for each schedule and limit, a scheduled flow that
// fires more often than its limit allows.
func (b *Box) warnRates(ctx context.Context, all []ScopedFlow) {
	f := b.Flows
	for _, sf := range all {
		if !sf.Flow.Enabled || sf.Flow.Trigger.Schedule == "" {
			continue
		}
		key := sf.key()
		seen := fmt.Sprintf("%s|%v|%d", sf.Flow.Trigger.Schedule, sf.Flow.Trigger.EachWorktree, maxRunsPerHour(sf.Flow))
		f.mu.Lock()
		if f.warned == nil {
			f.warned = map[string]string{}
		}
		was := f.warned[key]
		f.warned[key] = seen
		f.mu.Unlock()
		if was == seen {
			continue
		}
		if w := b.flowRateCheck(ctx, sf).warning(); w != "" {
			f.logf("flows: %s: %s", key, w)
		}
	}
}
