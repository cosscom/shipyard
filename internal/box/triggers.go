package box

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/cosscom/shipyard/internal/events"
	"github.com/cosscom/shipyard/internal/statefile"
)

// Webhook triggers: POST /v1/triggers/<flow> starts a flow whose trigger is
// "webhook", when the request is signed with the flow's secret:
//
//	X-Berth-Timestamp: <unix seconds, within 5 minutes>
//	X-Berth-Signature: sha256=<hex HMAC-SHA256(secret, timestamp + "." + body)>
//	X-Berth-Delivery:  <optional id; a second delivery of it starts nothing>
//
// The body is a JSON object; its fields become {{event.FIELD}}, and
// {{event.body}} reaches prompts labelled as someone else's words. The route
// is on the box's API, and on the tailnet address when triggers.json turns
// that on, so a CI job on the tailnet or a bridge you host can call it with
// no relay.

// TriggerSecrets keeps each webhook flow's secret, 0600.
type TriggerSecrets struct {
	Path string
	mu   sync.Mutex
	// seen holds signatures used in the last 5 minutes: a replayed request
	// is refused even without a delivery ID.
	seen map[string]time.Time
}

// fresh records a signature and reports whether it is new.
func (t *TriggerSecrets) fresh(sig string, now time.Time) bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.seen == nil {
		t.seen = map[string]time.Time{}
	}
	for k, at := range t.seen {
		if now.Sub(at) > 5*time.Minute {
			delete(t.seen, k)
		}
	}
	if _, ok := t.seen[sig]; ok {
		return false
	}
	if len(t.seen) < 10000 {
		t.seen[sig] = now
	}
	return true
}

func (t *TriggerSecrets) load() map[string]string {
	out := map[string]string{}
	if b, err := os.ReadFile(t.Path); err == nil {
		json.Unmarshal(b, &out)
	}
	return out
}

// Get returns the secret of a flow (scope/id).
func (t *TriggerSecrets) Get(key string) string {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.load()[key]
}

// Rotate makes a new secret for a flow and returns it.
func (t *TriggerSecrets) Rotate(key string) (string, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	s := hex.EncodeToString(b)
	all := t.load()
	all[key] = s
	raw, _ := json.Marshal(all)
	return s, statefile.Write(t.Path, raw)
}

// Sign is the signature a caller sends.
func Sign(secret string, ts int64, body []byte) string {
	m := hmac.New(sha256.New, []byte(secret))
	fmt.Fprintf(m, "%d.", ts)
	m.Write(body)
	return "sha256=" + hex.EncodeToString(m.Sum(nil))
}

// webhookFlow finds the webhook flow named id (in scope, when given).
func (b *Box) webhookFlow(ctx context.Context, id, scope string) (ScopedFlow, bool) {
	all, err := b.ActiveFlows(ctx)
	if err != nil {
		return ScopedFlow{}, false
	}
	for _, sf := range all {
		if sf.Flow.ID == id && sf.Flow.Trigger.Webhook != nil && (scope == "" || sf.Scope == scope) {
			return sf, true
		}
	}
	return ScopedFlow{}, false
}

// flowSecret makes (or remakes) a webhook flow's secret: shown once.
func (b *Box) flowSecret(w http.ResponseWriter, r *http.Request) error {
	if b.Triggers == nil {
		return httpError{http.StatusNotFound, "this box has no webhook triggers"}
	}
	var req struct {
		Scope string `json:"scope"`
	}
	decode(r, &req)
	sf, ok := b.webhookFlow(r.Context(), r.PathValue("id"), req.Scope)
	if !ok {
		return httpError{http.StatusNotFound, "no flow with that id starts from a webhook"}
	}
	if err := b.before(r, "config.change", map[string]any{"flow": sf.Flow.ID, "secret": true}); err != nil {
		return err
	}
	s, err := b.Triggers.Rotate(sf.Scope + "/" + sf.Flow.ID)
	if err != nil {
		return err
	}
	writeJSON(w, map[string]string{"flow": sf.Flow.ID, "scope": sf.Scope, "secret": s, "path": "/v1/triggers/" + sf.Flow.ID + "?scope=" + sf.Scope})
	return nil
}

// handleTrigger starts a webhook flow from a signed request.
func (b *Box) handleTrigger(w http.ResponseWriter, r *http.Request) {
	fail := func(code int, msg string) { writeError(w, code, msg) }
	if b.Triggers == nil {
		fail(http.StatusNotFound, "no webhook triggers")
		return
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, 64<<10+1))
	if err != nil || len(body) > 64<<10 {
		fail(http.StatusRequestEntityTooLarge, "the body is over 64 KB")
		return
	}
	sf, ok := b.webhookFlow(r.Context(), r.PathValue("flow"), r.URL.Query().Get("scope"))
	secret := ""
	if ok {
		secret = b.Triggers.Get(sf.Scope + "/" + sf.Flow.ID)
	}
	ts, _ := strconv.ParseInt(r.Header.Get("X-Berth-Timestamp"), 10, 64)
	// The same answer for a flow that is not there and a bad signature.
	if !ok || secret == "" || ts == 0 || time.Since(time.Unix(ts, 0)).Abs() > 5*time.Minute ||
		!hmac.Equal([]byte(r.Header.Get("X-Berth-Signature")), []byte(Sign(secret, ts, body))) {
		fail(http.StatusUnauthorized, "bad or missing signature")
		return
	}
	idem := ""
	if d := r.Header.Get("X-Berth-Delivery"); d != "" {
		idem = "webhook:" + sf.Scope + "/" + sf.Flow.ID + ":" + d
	} else if !b.Triggers.fresh(r.Header.Get("X-Berth-Signature"), time.Now()) {
		fail(http.StatusConflict, "this signed request was already used")
		return
	}
	var data map[string]any
	if len(strings.TrimSpace(string(body))) > 0 {
		if err := json.Unmarshal(body, &data); err != nil {
			fail(http.StatusBadRequest, "the body must be a JSON object")
			return
		}
	}
	if data == nil {
		data = map[string]any{}
	}
	// The posted fields are data; where the run happens is the box's say.
	for _, k := range []string{"path", "location", "name", "session"} {
		delete(data, k)
	}
	field := sf.Flow.Trigger.Webhook.BranchField
	if field == "" {
		field = "branch"
	}
	branch, _ := data[field].(string)
	sel := sf
	sel.Flow.Trigger.Where.Branch = ""
	for _, tg := range b.flowTargets(r.Context(), sel, true) {
		if (branch == "" && tg.Wt.Main) || (branch != "" && tg.Wt.Branch == branch) {
			data["path"], data["location"], data["name"] = tg.Wt.Path, tg.Loc.Name, tg.Wt.Name
			break
		}
	}
	e := events.Event{Type: "webhook.received", Box: b.Name, Origin: "webhook", Time: time.Now(), Data: data}
	s, err := b.startFlowRun(r.Context(), sf, e, flowStart{via: "webhook", idem: idem})
	if err != nil {
		fail(http.StatusTooManyRequests, err.Error())
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusAccepted)
	writeJSON(w, map[string]string{"run": s.ID, "status": s.Status})
}

// TriggerListener serves POST /v1/triggers/<flow> alone on addr (a tailnet
// address), for callers that are not paired laptops.
func (b *Box) TriggerListener(ctx context.Context, addr string) error {
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		return err
	}
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/triggers/{flow}", b.handleTrigger)
	srv := &http.Server{Handler: mux, ReadHeaderTimeout: 10 * time.Second, MaxHeaderBytes: 16 << 10}
	go func() {
		<-ctx.Done()
		srv.Close()
	}()
	go srv.Serve(ln)
	return nil
}
