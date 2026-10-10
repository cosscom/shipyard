package agent

import (
	"encoding/json"
	"path/filepath"
	"testing"

	"github.com/cosscom/shipyard/internal/statefile"
)

// The proxy keeps the routes between requests, yet a route another
// process saves (the CLI) applies to the very next request.
func TestRoutesEditedOnDiskApplyAtOnce(t *testing.T) {
	path := filepath.Join(t.TempDir(), "routes.json")
	a := &Agent{routes: newRouteStore(path)}
	write := func(routes ...Route) {
		t.Helper()
		b, _ := json.Marshal(routes)
		if err := statefile.Write(path, b); err != nil {
			t.Fatal(err)
		}
	}
	if _, _, ok := a.route("x.cal.test.localhost"); ok {
		t.Fatal("routed with no routes file")
	}
	write(Route{Pattern: "*.cal.test.localhost", Box: "devl", Port: 3000})
	if box, port, ok := a.route("x.cal.test.localhost"); !ok || box != "devl" || port != 3000 {
		t.Fatalf("route = %s %d %v", box, port, ok)
	}
	// Same length, straight after: another box.
	write(Route{Pattern: "*.cal.test.localhost", Box: "devm", Port: 3000})
	if box, _, ok := a.route("x.cal.test.localhost"); !ok || box != "devm" {
		t.Fatalf("after an edit: %s %v", box, ok)
	}
	write()
	if _, _, ok := a.route("x.cal.test.localhost"); ok {
		t.Fatal("a removed route still routes")
	}
}
