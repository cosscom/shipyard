package box

import (
	"context"
	"encoding/json"
	"math"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/cosscom/shipyard/internal/integrations"
	"github.com/cosscom/shipyard/internal/statefile"
)

// Claude Code's plan limits: each turn of a structured session says how
// much of its account's 5-hour and weekly windows is used (a
// rate_limit_event). berthd keeps the latest in ~/.berth/limits/<account>.json,
// where the Usage plugin reads them. Claude Code passes them otherwise only
// to a status line, which it runs only on its own screen, so a box whose
// agents all run structured would have none. A status line may write the
// same files (the plugin's README has the lines).

// limitsMu keeps two sessions on one account from writing its file at
// once, an older reading after a newer one. A status line writing between
// the read and the rename isn't held by it: its reading can be lost, or an
// older one kept, until the account's next turn writes again.
var limitsMu sync.Mutex

// claudeRateLimit is the part of a rate_limit_event's rate_limit_info the
// driver reads: one window or more, by name ("five_hour", "seven_day").
type claudeRateLimit struct {
	Windows map[string]struct {
		Utilization *float64 `json:"utilization"`
		ResetsAt    *float64 `json:"resetsAt"`
	} `json:"unifiedWindows"`
}

// limitsFile is ~/.berth/limits/<account>.json, in the shape a status line
// writes it: limits holds Claude Code's rate_limits as it passes them to
// one.
type limitsFile struct {
	Account string                     `json:"account,omitempty"`
	Dir     string                     `json:"dir,omitempty"`
	At      string                     `json:"at"`
	Limits  map[string]json.RawMessage `json:"limits"`
}

type limitWindow struct {
	UsedPercentage float64 `json:"used_percentage"`
	ResetsAt       int64   `json:"resets_at"`
}

// claudeAccountName is what the Usage plugin calls the Claude Code account
// in dir: "default" for ~/.claude, the folder's name for
// ~/.berth/accounts/claude/<name>. "" for any other folder: the plugin
// knows no other, and one elsewhere named like an account isn't it.
func claudeAccountName(home, dir string) string {
	if dir == "" {
		return "default"
	}
	d := integrations.ExpandAccountDir(home, dir)
	switch {
	case d == filepath.Join(home, ".claude"):
		return "default"
	case d != "" && filepath.Dir(d) == integrations.AccountsDir(home, "claude"):
		return filepath.Base(d)
	}
	return ""
}

// recordLimits keeps what a rate_limit_event at at says of the session's
// account. Called by speak, which alone uses c.account.
func (c *claudeConv) recordLimits(at time.Time, info json.RawMessage) {
	home, err := os.UserHomeDir()
	if err != nil {
		return
	}
	if c.account == "" {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		sess, err := c.b.Sessions.Get(ctx, c.name)
		if err != nil {
			return
		}
		dir := c.b.claudeHomeFor(ctx, sess)
		name := claudeAccountName(home, dir)
		if name == "" {
			return
		}
		c.account, c.accountDir = name, integrations.ExpandAccountDir(home, dir)
	}
	writeClaudeLimits(filepath.Join(home, ".berth", "limits", c.account+".json"), c.account, c.accountDir, at, info)
}

// writeClaudeLimits writes path from a rate_limit_event's rate_limit_info,
// unless the file already holds a later reading. A window the event leaves
// out keeps what the file had; a file that isn't one is written afresh.
func writeClaudeLimits(path, account, dir string, at time.Time, info json.RawMessage) error {
	var rl claudeRateLimit
	if json.Unmarshal(info, &rl) != nil {
		return nil
	}
	limits := map[string]json.RawMessage{}
	for name, w := range rl.Windows {
		if w.Utilization == nil || w.ResetsAt == nil {
			continue
		}
		resets := *w.ResetsAt
		if resets > 1e12 {
			resets /= 1000 // milliseconds
		}
		raw, _ := json.Marshal(limitWindow{UsedPercentage: math.Round(*w.Utilization*10000) / 100, ResetsAt: int64(resets)})
		limits[name] = raw
	}
	if len(limits) == 0 {
		return nil
	}
	limitsMu.Lock()
	defer limitsMu.Unlock()
	var old limitsFile
	if raw, err := os.ReadFile(path); err == nil && json.Unmarshal(raw, &old) == nil {
		if t, err := time.Parse(time.RFC3339, old.At); err == nil && !at.After(t) {
			return nil
		}
		for name, w := range old.Limits {
			if _, ok := limits[name]; !ok {
				limits[name] = w
			}
		}
	}
	out, err := json.Marshal(limitsFile{Account: account, Dir: dir, At: at.UTC().Format("2006-01-02T15:04:05.000Z07:00"), Limits: limits})
	if err != nil {
		return err
	}
	return statefile.Write(path, append(out, '\n'))
}
