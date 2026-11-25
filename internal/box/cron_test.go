package box

import (
	"testing"
	"time"
)

func TestCronParsesAndFindsTheNextRun(t *testing.T) {
	at := func(s string) time.Time {
		v, err := time.ParseInLocation("2006-01-02 15:04 Mon", s, time.UTC)
		if err != nil {
			t.Fatal(err)
		}
		return v
	}
	for _, tc := range []struct{ expr, from, want string }{
		{"@daily", "2026-10-02 20:13 Fri", "2026-10-03 00:00 Sat"},
		{"@hourly", "2026-10-02 20:13 Fri", "2026-10-02 21:00 Fri"},
		{"0 2 * * *", "2026-10-02 02:00 Fri", "2026-10-03 02:00 Sat"},
		{"*/15 9-17 * * 1-5", "2026-10-02 17:50 Fri", "2026-10-05 09:00 Mon"},
		{"30 8 * * 7", "2026-10-02 20:00 Fri", "2026-10-04 08:30 Sun"},
		{"0 0 1,15 * *", "2026-10-02 00:00 Fri", "2026-10-15 00:00 Thu"},
		{"0 12 13 * 5", "2026-10-02 13:00 Fri", "2026-10-09 12:00 Fri"}, // either day field
		{"5 4 * 2 *", "2026-10-02 00:00 Fri", "2027-02-01 04:05 Mon"},
	} {
		c, err := ParseCron(tc.expr)
		if err != nil {
			t.Fatalf("%s: %v", tc.expr, err)
		}
		if got := c.Next(at(tc.from)); !got.Equal(at(tc.want)) {
			t.Errorf("%s after %s = %s, want %s", tc.expr, tc.from, got.Format("2006-01-02 15:04 Mon"), tc.want)
		}
	}
	if c, _ := ParseCron("0 0 30 2 *"); !c.Next(at("2026-10-02 00:00 Fri")).IsZero() {
		t.Error("30 February should never run")
	}
	for _, bad := range []string{"", "* * * *", "60 * * * *", "* 24 * * *", "* * 0 * *", "*/0 * * * *", "a * * * *", "5-1 * * * *"} {
		if _, err := ParseCron(bad); err == nil {
			t.Errorf("%q parsed", bad)
		}
	}
}

func TestCronCountsItsBusiestHour(t *testing.T) {
	from := time.Date(2026, 11, 24, 10, 17, 0, 0, time.UTC)
	for _, tc := range []struct {
		expr string
		want int
	}{
		{"* * * * *", 60},
		{"*/5 * * * *", 12},
		{"0 9 * * 1-5", 1},
		{"@hourly", 1},
		{"@daily", 1},
		{"0,30 9-17 * * *", 2},
		{"*/15 2 * * 0", 4},
		{"0 0 30 2 *", 0},
	} {
		c, err := ParseCron(tc.expr)
		if err != nil {
			t.Fatalf("%s: %v", tc.expr, err)
		}
		if got := c.FiresPerHour(from); got != tc.want {
			t.Errorf("%s fires %d times in its busiest hour, want %d", tc.expr, got, tc.want)
		}
	}
	// A zone half an hour off UTC still counts its own hours.
	india := time.FixedZone("IST", 5*3600+1800)
	if c, _ := ParseCron("*/10 9 * * *"); c.FiresPerHour(from.In(india)) != 6 {
		t.Errorf("*/10 9 in IST = %d, want 6", c.FiresPerHour(from.In(india)))
	}
}

func TestCronFindsItsNextRunAcrossASkippedHour(t *testing.T) {
	ny, err := time.LoadLocation("America/New_York")
	if err != nil {
		t.Skip(err)
	}
	santiago, err := time.LoadLocation("America/Santiago")
	if err != nil {
		t.Skip(err)
	}
	for _, tc := range []struct {
		expr       string
		from, want time.Time
	}{
		// 02:00 doesn't exist on 8 March in New York.
		{"0 9 * * *", time.Date(2026, 3, 8, 0, 30, 0, 0, ny), time.Date(2026, 3, 8, 9, 0, 0, 0, ny)},
		{"30 2 * * *", time.Date(2026, 3, 8, 0, 30, 0, 0, ny), time.Date(2026, 3, 9, 2, 30, 0, 0, ny)},
		// Nor midnight on 6 September in Santiago.
		{"0 12 * * 1", time.Date(2026, 8, 31, 22, 0, 0, 0, santiago), time.Date(2026, 9, 7, 12, 0, 0, 0, santiago)},
	} {
		c, _ := ParseCron(tc.expr)
		done := make(chan time.Time, 1)
		go func() { done <- c.Next(tc.from) }()
		select {
		case got := <-done:
			if !got.Equal(tc.want) {
				t.Errorf("%s from %v: %v, want %v", tc.expr, tc.from, got, tc.want)
			}
		case <-time.After(2 * time.Second):
			t.Fatalf("%s from %v: Next never returned", tc.expr, tc.from)
		}
	}
}
