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
// streak of refusals the log has not yet summed up. Starts are at most the
// limit; refusals, which a flooded webhook can make many of, are counted
// by the minute, so the hour holds at most 61 of them however many come.
type flowRate struct {
	starts      []time.Time
	refused     []refusedMinute
	lastRefused time.Time
	streak      int
	streakFrom  time.Time
	streakTo    time.Time
}

type refusedMinute struct {
	at time.Time // the minute
	n  int
}

// refuse counts a refusal at now.
func (r *flowRate) refuse(now time.Time) {
	m := now.Truncate(time.Minute)
	if n := len(r.refused); n > 0 && r.refused[n-1].at.Equal(m) {
		r.refused[n-1].n++
	} else {
		r.refused = append(r.refused, refusedMinute{at: m, n: 1})
	}
	r.lastRefused = now
}

// refusedCount is how many refusals the last hour holds.
func (r *flowRate) refusedCount() int {
	n := 0
	for _, m := range r.refused {
		n += m.n
	}
	return n
}

// prune drops what is over an hour old at now: a minute of refusals once
// all of it is.
func (r *flowRate) prune(now time.Time) {
	cut := now.Add(-time.Hour)
	i := 0
	for i < len(r.starts) && !r.starts[i].After(cut) {
		i++
	}
	r.starts = r.starts[i:]
	i = 0
	for i < len(r.refused) && !r.refused[i].at.Add(time.Minute).After(cut) {
		i++
	}
	r.refused = r.refused[i:]
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
		r.refuse(now)
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
	n := r.refusedCount()
	if n == 0 {
		return 0, time.Time{}
	}
	return n, r.lastRefused
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

// rateChecker counts how often scheduled flows start in their busiest
// hour, reading the box's worktrees at most once for all of them.
type rateChecker struct {
	ctx  context.Context
	b    *Box
	locs []Location
	read bool
}

// check is sf's count: once per firing, or once per matching worktree for
// each_worktree, the way fireScheduled starts it.
func (k *rateChecker) check(sf ScopedFlow) rateCheck {
	tr := sf.Flow.Trigger
	if tr.Schedule == "" {
		return rateCheck{}
	}
	c, err := ParseCron(tr.Schedule)
	if err != nil {
		return rateCheck{}
	}
	rc := rateCheck{fires: c.FiresPerHour(k.b.Flows.now()), worktrees: 1, limit: maxRunsPerHour(sf.Flow)}
	if tr.EachWorktree {
		if !k.read {
			k.locs, _ = k.b.Locations.List(k.ctx)
			k.read = true
		}
		rc.worktrees = len(flowTargetsIn(k.locs, sf, tr.Where.Branch != ""))
		rc.fires *= rc.worktrees
	}
	return rc
}

// warnRates logs a scheduled flow that fires more often than its limit
// allows, once each time what it fires (a schedule, a limit, a worktree
// more) changes.
func (b *Box) warnRates(ctx context.Context, all []ScopedFlow) {
	f := b.Flows
	k := &rateChecker{ctx: ctx, b: b}
	for _, sf := range all {
		if !sf.Flow.Enabled || sf.Flow.Trigger.Schedule == "" {
			continue
		}
		key := sf.key()
		rc := k.check(sf)
		seen := fmt.Sprintf("%d|%d", rc.fires, rc.limit)
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
		if w := rc.warning(); w != "" {
			f.logf("flows: %s: %s", key, w)
		}
	}
}
