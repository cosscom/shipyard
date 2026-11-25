package box

import (
	"fmt"
	"strconv"
	"strings"
	"time"
)

// Cron is a parsed five-field cron expression: minute, hour, day of month,
// month, day of week, read in the box's local time.
type Cron struct {
	min, hour, dom, month, dow uint64
	// domAll and dowAll record a "*" field: when both day fields are
	// restricted, cron runs on either, as Vixie cron does.
	domAll, dowAll bool
}

var cronShortcuts = map[string]string{
	"@yearly":   "0 0 1 1 *",
	"@annually": "0 0 1 1 *",
	"@monthly":  "0 0 1 * *",
	"@weekly":   "0 0 * * 0",
	"@daily":    "0 0 * * *",
	"@midnight": "0 0 * * *",
	"@hourly":   "0 * * * *",
}

// ParseCron reads a cron expression or one of the @ shortcuts.
func ParseCron(expr string) (Cron, error) {
	expr = strings.TrimSpace(expr)
	if s, ok := cronShortcuts[strings.ToLower(expr)]; ok {
		expr = s
	}
	f := strings.Fields(expr)
	if len(f) != 5 {
		return Cron{}, fmt.Errorf("%q needs five fields (minute hour day month weekday) or a shortcut like @daily", expr)
	}
	var c Cron
	var err error
	if c.min, err = cronField(f[0], 0, 59, "minute"); err != nil {
		return Cron{}, err
	}
	if c.hour, err = cronField(f[1], 0, 23, "hour"); err != nil {
		return Cron{}, err
	}
	if c.dom, err = cronField(f[2], 1, 31, "day of month"); err != nil {
		return Cron{}, err
	}
	if c.month, err = cronField(f[3], 1, 12, "month"); err != nil {
		return Cron{}, err
	}
	// 7 is Sunday too.
	if c.dow, err = cronField(f[4], 0, 7, "weekday"); err != nil {
		return Cron{}, err
	}
	if c.dow&(1<<7) != 0 {
		c.dow |= 1
	}
	c.domAll, c.dowAll = f[2] == "*", f[4] == "*"
	return c, nil
}

func cronField(s string, lo, hi int, name string) (uint64, error) {
	var bits uint64
	for _, part := range strings.Split(s, ",") {
		step := 1
		if i := strings.Index(part, "/"); i >= 0 {
			n, err := strconv.Atoi(part[i+1:])
			if err != nil || n <= 0 {
				return 0, fmt.Errorf("%s: bad step in %q", name, part)
			}
			step, part = n, part[:i]
		}
		from, to := lo, hi
		switch {
		case part == "*":
		case strings.Contains(part, "-"):
			a, b, _ := strings.Cut(part, "-")
			var err1, err2 error
			from, err1 = strconv.Atoi(a)
			to, err2 = strconv.Atoi(b)
			if err1 != nil || err2 != nil {
				return 0, fmt.Errorf("%s: bad range %q", name, part)
			}
		default:
			n, err := strconv.Atoi(part)
			if err != nil {
				return 0, fmt.Errorf("%s: %q is not a number", name, part)
			}
			from, to = n, n
			if step > 1 {
				to = hi
			}
		}
		if from < lo || to > hi || from > to {
			return 0, fmt.Errorf("%s must be between %d and %d", name, lo, hi)
		}
		for v := from; v <= to; v += step {
			bits |= 1 << uint(v)
		}
	}
	return bits, nil
}

// Matches reports whether the minute t is in falls on the schedule.
func (c Cron) Matches(t time.Time) bool {
	return c.month&(1<<uint(t.Month())) != 0 && c.dayMatches(t) &&
		c.hour&(1<<uint(t.Hour())) != 0 && c.min&(1<<uint(t.Minute())) != 0
}

// Next is the first minute after t on the schedule, within about four
// years; the zero time if there is none (such as 30 February).
func (c Cron) Next(t time.Time) time.Time {
	t = t.Truncate(time.Minute).Add(time.Minute)
	loc := t.Location()
	for end := t.AddDate(4, 0, 0); t.Before(end); {
		prev := t
		switch {
		case c.month&(1<<uint(t.Month())) == 0:
			t = time.Date(t.Year(), t.Month()+1, 1, 0, 0, 0, 0, loc)
		case !c.dayMatches(t):
			t = time.Date(t.Year(), t.Month(), t.Day()+1, 0, 0, 0, 0, loc)
		case c.hour&(1<<uint(t.Hour())) == 0:
			t = t.Add(time.Duration(60-t.Minute()) * time.Minute)
		case c.min&(1<<uint(t.Minute())) == 0:
			t = t.Add(time.Minute)
		default:
			return t
		}
		// time.Date of a time the clock skips (02:00, or in some zones
		// midnight, when summer time starts) can give back an earlier one;
		// step past the gap a minute at a time rather than search forever.
		if !t.After(prev) {
			t = prev.Add(time.Minute)
		}
	}
	return time.Time{}
}

// FiresPerHour is how many times the schedule fires in its busiest hour
// from t on, a rolling hour as a flow's runs-per-hour limit counts it: 0 if
// it never fires again. The minute field is the same in every hour it
// fires, and any 60 minutes in a row take each minute of the hour once, so
// the busiest hour is one of its hours counted through: the first, from
// Next.
func (c Cron) FiresPerHour(t time.Time) int {
	first := c.Next(t)
	if first.IsZero() {
		return 0
	}
	// The local hour (Truncate would cut half-hour zones at UTC's).
	hour := time.Date(first.Year(), first.Month(), first.Day(), first.Hour(), 0, 0, 0, first.Location())
	n := 0
	for at := hour.Add(-time.Minute); ; n++ {
		if at = c.Next(at); at.IsZero() || !at.Before(hour.Add(time.Hour)) {
			return n
		}
	}
}

// dayMatches applies cron's rule for the two day fields: when both are
// restricted, either may match.
func (c Cron) dayMatches(t time.Time) bool {
	dom := c.dom&(1<<uint(t.Day())) != 0
	dow := c.dow&(1<<uint(t.Weekday())) != 0
	switch {
	case c.domAll && c.dowAll:
		return true
	case c.domAll:
		return dow
	case c.dowAll:
		return dom
	}
	return dom || dow
}
