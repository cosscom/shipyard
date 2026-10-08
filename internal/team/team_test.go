package team

import (
	"os"
	"strings"
	"testing"
)

func TestParseAcmeExample(t *testing.T) {
	b, err := os.ReadFile("../../examples/team/acme-dot-berth/team.json")
	if err != nil {
		t.Fatal(err)
	}
	s, warnings, err := Parse(b)
	if err != nil {
		t.Fatal(err)
	}
	if len(warnings) != 0 {
		t.Fatalf("warnings on the example: %v", warnings)
	}
	if s.ID != "acme" || s.Org != "acme" || len(s.Box.Steps) != 8 || len(s.Projects) != 1 {
		t.Fatalf("parsed %+v", s)
	}
	if s.SudoSteps() != 4 {
		t.Fatalf("sudo steps = %d", s.SudoSteps())
	}
	if !s.NotifyUpdates() {
		t.Fatal("updates should notify by default and here")
	}
	if got := strings.Join(s.Box.Settings.Env(), " "); got != "BERTH_SETTING_SHOP_POSTGRES_VERSION=18 BERTH_SETTING_SHOP_REDIS_VERSION=8" {
		t.Fatalf("settings env %q", got)
	}
	if !s.UsesOnePassword() {
		t.Fatal("the example's shared keys are op:// references")
	}
	if strings.Join(s.Agents, " ") != "claude codex" {
		t.Fatalf("agents = %v", s.Agents)
	}
	shop, ok := s.Project("shop")
	if !ok || shop.Repo != "acme/shop" || shop.ProjectPath() != "~/code/shop" {
		t.Fatalf("project %+v", shop)
	}
	k, err := ParseKitRef(shop.Kit)
	if err != nil || k.Owner != "acme" || k.Name != "berth-kit-shop" || !k.IsCommit() {
		t.Fatalf("kit ref %+v %v", k, err)
	}
	if k.String() != shop.Kit {
		t.Fatalf("round trip %q", k.String())
	}
	// Nothing in the example names a repository but the public one.
	if strings.Contains(string(b), "billing-api") {
		t.Fatal("the example names a private repository")
	}
}

func TestSettings(t *testing.T) {
	doc := strings.Replace(minimal, `"script":"box/setup.sh",`, `"script":"box/setup.sh","settings":{"PG_VERSION":"18","$why":{"any":"comment"},"redis_port":"6379"},"$settings":{"OLD":1},`, 1)
	s, warnings, err := Parse([]byte(doc))
	if err != nil || len(warnings) != 0 {
		t.Fatal(err, warnings)
	}
	if got := strings.Join(s.Box.Settings.Env(), " "); got != "BERTH_SETTING_PG_VERSION=18 BERTH_SETTING_redis_port=6379" {
		t.Fatalf("env %q", got)
	}
	bad := map[string]string{
		`"settings":{"PG":18}`:          `must be a string ("18")`,
		`"settings":{"PG-VERSION":"1"}`: "not a setting name",
		`"settings":{"9PG":"1"}`:        "not a setting name",
		`"settings":{"PG":"a\nb"}`:      "control character",
		`"settings":["PG"]`:             "object of names and strings",
	}
	for in, want := range bad {
		doc := strings.Replace(minimal, `"script":"box/setup.sh",`, `"script":"box/setup.sh",`+in+`,`, 1)
		if _, _, err := Parse([]byte(doc)); err == nil || !strings.Contains(err.Error(), want) {
			t.Errorf("%s: got %v, want %q", in, err, want)
		}
	}
	old, _, _ := Parse([]byte(strings.Replace(minimal, `"script":"box/setup.sh",`, `"script":"box/setup.sh","settings":{"PG":"17","GONE":"x"},`, 1)))
	nw, _, _ := Parse([]byte(strings.Replace(minimal, `"script":"box/setup.sh",`, `"script":"box/setup.sh","settings":{"PG":"18","NEW":"y"},`, 1)))
	var lines []string
	for _, c := range Diff(old, nw, nil, nil) {
		lines = append(lines, c.Kind+" "+c.Area+" "+c.ID+" | "+c.Detail)
	}
	if got := strings.Join(lines, "\n"); got != "add setting NEW | y\nchange setting PG | 17 → 18\nremove setting GONE | no longer set" {
		t.Fatalf("diff:\n%s", got)
	}
}

func TestProjectIDsAreURLSafe(t *testing.T) {
	doc := strings.Replace(minimal, `{"id":"web","repo":"acme/web"`, `{"id":"acme.com","repo":"acme/web"`, 1)
	doc = strings.Replace(doc, `"keys":{"web"`, `"keys":{"acme.com"`, 1)
	_, _, err := Parse([]byte(doc))
	if err == nil || !strings.Contains(err.Error(), `id "acme.com" can't be part of a URL`) || !strings.Contains(err.Error(), `"acme-com"`) || !strings.Contains(err.Error(), `~/code/acme.com`) {
		t.Fatalf("got %v", err)
	}
	for _, id := range []string{"Web", "web_app", "-web", "web-", "a.b"} {
		if ValidProjectID(id) {
			t.Errorf("%q is valid", id)
		}
	}
	for _, id := range []string{"web", "shop", "billing-api", "a1"} {
		if !ValidProjectID(id) {
			t.Errorf("%q is not valid", id)
		}
	}
	for in, want := range map[string]string{"acme.com": "acme-com", "Web_App": "web-app", "..x..": "x", "a  b": "a-b", "!!": ""} {
		if got := URLSafeName(in); got != want {
			t.Errorf("URLSafeName(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestUsesOnePassword(t *testing.T) {
	s, _, _ := Parse([]byte(minimal))
	if !s.UsesOnePassword() {
		t.Fatal("op:// shared key not seen")
	}
	s, _, _ = Parse([]byte(strings.Replace(minimal, `"op://Dev/Stripe/key"`, `"env://STRIPE"`, 1)))
	if s.UsesOnePassword() {
		t.Fatal("env:// is not 1Password")
	}
}

func TestOnePasswordPolicy(t *testing.T) {
	s, warn, err := Parse([]byte(minimal))
	if err != nil || s.RequiresOnePassword() || len(warn) != 0 {
		t.Fatalf("default: %v %v %v", s.RequiresOnePassword(), warn, err)
	}
	req := strings.Replace(minimal, `"org":"acme",`, `"org":"acme","onepassword":"required",`, 1)
	if s, warn, err = Parse([]byte(req)); err != nil || !s.RequiresOnePassword() || len(warn) != 0 {
		t.Fatalf("required: %v %v %v", s, warn, err)
	}
	// Required means nothing without a 1Password reference to read.
	if s, _, _ = Parse([]byte(strings.Replace(req, `"op://Dev/Stripe/key"`, `"env://STRIPE"`, 1))); s.RequiresOnePassword() {
		t.Fatal("required with no op:// key")
	}
	if _, _, err = Parse([]byte(strings.Replace(minimal, `"org":"acme",`, `"org":"acme","onepassword":"always",`, 1))); err == nil || !strings.Contains(err.Error(), `"optional"`) {
		t.Fatalf("a bad policy: %v", err)
	}
}

const minimal = `{"schema":"berth.team/v1","id":"acme","name":"Acme","org":"acme",
 "box":{"script":"box/setup.sh","steps":[{"id":"tools","title":"Tools","sudo":true},{"id":"db","title":"Database"}]},
 "projects":[{"id":"web","repo":"acme/web","kit":"./kits/web"},{"id":"api","repo":"acme/api","path":"~/src/api","required":true}],
 "keys":{"web":{"from":".env.example","shared":{"STRIPE_KEY":"op://Dev/Stripe/key"},"ask":["MAIL_KEY"]}}}`

func TestParseRejects(t *testing.T) {
	cases := []struct{ from, to, want string }{
		{`"berth.team/v1"`, `"berth.team/v2"`, "this version of Shipyard reads"},
		{`"id":"acme"`, `"id":"Acme Co"`, "lowercase"},
		{`"name":"Acme"`, `"name":" "`, "name is empty"},
		{`"org":"acme"`, `"org":"ac me"`, "not a GitHub org"},
		{`"script":"box/setup.sh"`, `"script":"../setup.sh"`, "inside .berth"},
		{`"script":"box/setup.sh"`, `"script":"/usr/bin/setup.sh"`, "inside .berth"},
		{`"id":"db"`, `"id":"tools"`, "twice"},
		{`"id":"db"`, `"id":"check"`, "reserved"},
		{`"id":"db"`, `"id":"github"`, "reserved"},
		{`"id":"db"`, `"id":"1password"`, "lowercase letters"},
		{`"id":"web"`, `"id":"web.app"`, "can't be part of a URL"},
		{`"title":"Database"`, `"title":""`, "no title"},
		{`"repo":"acme/api"`, `"repo":"api"`, "owner/name"},
		{`"repo":"acme/api"`, `"repo":"acme/web"`, "twice"},
		{`"path":"~/src/api"`, `"path":"src/api"`, "must start with"},
		{`"path":"~/src/api"`, `"path":"~/../etc"`, "not a folder"},
		{`"kit":"./kits/web"`, `"kit":"../kits/web"`, "inside .berth"},
		{`"kit":"./kits/web"`, `"kit":"https://github.com/acme/kit"`, "not pinned"},
		{`"op://Dev/Stripe/key"`, `"sk_live_123"`, "never a value"},
		{`"ask":["MAIL_KEY"]`, `"ask":["STRIPE_KEY"]`, "both shared and asked"},
		{`"keys":{"web"`, `"keys":{"nope"`, "not one of the projects"},
	}
	for _, c := range cases {
		doc := strings.Replace(minimal, c.from, c.to, 1)
		if doc == minimal {
			t.Fatalf("case %q did not change the document", c.from)
		}
		_, _, err := Parse([]byte(doc))
		if err == nil || !strings.Contains(err.Error(), c.want) {
			t.Errorf("%s → %s: got %v, want %q", c.from, c.to, err, c.want)
		}
	}
	if _, _, err := Parse([]byte(minimal)); err != nil {
		t.Fatal(err)
	}
}

func TestParseWarnsOnUnknownFields(t *testing.T) {
	doc := strings.Replace(minimal, `"name":"Acme"`, `"name":"Acme","github":{"require_member":true},"$note":"fine"`, 1)
	doc = strings.Replace(doc, `"title":"Tools"`, `"title":"Tools","check":"x"`, 1)
	_, warnings, err := Parse([]byte(doc))
	if err != nil {
		t.Fatal(err)
	}
	joined := strings.Join(warnings, "\n")
	if len(warnings) != 2 || !strings.Contains(joined, `"github"`) || !strings.Contains(joined, `box.steps[0]: "check"`) {
		t.Fatalf("warnings %v", warnings)
	}
}

func TestParseKitRef(t *testing.T) {
	cases := map[string]KitRef{
		"./kits/web":                       {Path: "kits/web"},
		"kits/web":                         {Path: "kits/web"},
		"https://github.com/o/kit@abc1234": {Owner: "o", Name: "kit", Ref: "abc1234", Link: "https://github.com/o/kit"},
		"github.com/o/kit@v2":              {Owner: "o", Name: "kit", Ref: "v2", Link: "https://github.com/o/kit"},
		"https://github.com/o/kits/tree/abc1234/shop":   {Owner: "o", Name: "kits", Ref: "abc1234", Sub: "shop", Link: "https://github.com/o/kits/tree/abc1234/shop"},
		"https://gitlab.com/o/kit@0123456789abcdef0123": {Link: "https://gitlab.com/o/kit", Ref: "0123456789abcdef0123"},
	}
	for in, want := range cases {
		got, err := ParseKitRef(in)
		if err != nil || got != want {
			t.Errorf("%s: got %+v %v, want %+v", in, got, err, want)
		}
	}
	for _, bad := range []string{"https://github.com/o/kit", "https://example.com/kit.json", "../x", "/abs/kit"} {
		if _, err := ParseKitRef(bad); err == nil {
			t.Errorf("%s: no error", bad)
		}
	}
}

func TestEnvKeys(t *testing.T) {
	got := EnvKeys([]byte("# comment\nA=1\nexport B=\"x\"\n\nA=2\nnot a line\nlower_ok=\n9BAD=1\n"))
	if strings.Join(got, ",") != "A,B,lower_ok" {
		t.Fatal(got)
	}
}

func TestDiff(t *testing.T) {
	old, _, err := Parse([]byte(minimal))
	if err != nil {
		t.Fatal(err)
	}
	newDoc := strings.Replace(minimal, `{"id":"db","title":"Database"}`, `{"id":"db","title":"Database 16","sudo":true},{"id":"node","title":"Node 22"}`, 1)
	newDoc = strings.Replace(newDoc, `{"id":"tools","title":"Tools","sudo":true},`, ``, 1)
	newDoc = strings.Replace(newDoc, `"required":true}`, `"required":true},{"id":"video","repo":"acme/video"}`, 1)
	newDoc = strings.Replace(newDoc, `"kit":"./kits/web"`, `"kit":"./kits/web2"`, 1)
	newDoc = strings.Replace(newDoc, `"ask":["MAIL_KEY"]`, `"ask":["MAIL_KEY","SMS_KEY"]`, 1)
	newDoc = strings.Replace(newDoc, `"op://Dev/Stripe/key"`, `"op://Dev/Stripe/key","DAILY":"op://Dev/Daily/key"`, 1)
	nw, _, err := Parse([]byte(newDoc))
	if err != nil {
		t.Fatal(err)
	}
	changes := Diff(old, nw,
		map[string]string{"box/setup.sh": "a\nb\n", "team.json": "x", "old.sh": "x"},
		map[string]string{"box/setup.sh": "a\nc\nd\n", "team.json": "y", "kits/web2/kit.json": "{}"})
	var lines []string
	for _, c := range changes {
		lines = append(lines, c.Kind+" "+c.Area+" "+c.ID+" | "+c.Detail)
	}
	got := strings.Join(lines, "\n")
	for _, want := range []string{
		"change step db | Database → Database 16 · now asks for your password",
		"add step node | ",
		"remove step tools | ",
		"add project video | new repo",
		"change project web | kit ./kits/web → ./kits/web2",
		"add key web/DAILY | from 1Password: op://Dev/Daily/key",
		"add key web/SMS_KEY | yours to enter, once",
		"change file box/setup.sh | +2 −1 lines",
		"add file kits/web2/kit.json | ",
		"remove file old.sh | ",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("missing %q in\n%s", want, got)
		}
	}
	if strings.Contains(got, "team.json") {
		t.Errorf("team.json itself is reported through its fields, not as a file:\n%s", got)
	}
	if s := NewSudo(changes); len(s) != 1 || s[0] != "Database 16" {
		t.Fatalf("new sudo = %v", s)
	}
	if len(Diff(old, old, nil, nil)) != 0 {
		t.Fatal("a setup differs from itself")
	}
}

func TestParseSource(t *testing.T) {
	cases := map[string]Source{
		"acme":                        {Owner: "acme", Repo: ".berth"},
		"berth://team?org=acme":       {Owner: "acme", Repo: ".berth"},
		"github.com/acme/.berth":      {Owner: "acme", Repo: ".berth"},
		"github.com/acme/.berth@main": {Owner: "acme", Repo: ".berth", Ref: "main", Link: true},
		"https://github.com/o/r":      {Owner: "o", Repo: "r", Link: true},
		"github.com/o/r@team-setup":   {Owner: "o", Repo: "r", Ref: "team-setup", Link: true},
		"o/r@4e1c9a2":                 {Owner: "o", Repo: "r", Ref: "4e1c9a2", Link: true},
		"https://github.com/jo-acme/acme-setup/tree/team-setup/team":                         {Owner: "jo-acme", Repo: "acme-setup", Ref: "team-setup", Path: "team", Link: true},
		"berth://team?src=" + "github.com%2Fjo-acme%2Facme-setup%2Ftree%2Fteam-setup%2Fteam": {Owner: "jo-acme", Repo: "acme-setup", Ref: "team-setup", Path: "team", Link: true},
		"github.com/o/r/tree/main/a/b/":                                                      {Owner: "o", Repo: "r", Ref: "main", Path: "a/b", Link: true},
	}
	for in, want := range cases {
		got, err := ParseSource(in)
		if err != nil || got != want {
			t.Errorf("%s: got %+v %v, want %+v", in, got, err, want)
		}
	}
	for _, bad := range []string{"", "not an org!", "github.com/o/r/tree/main/../x", "https://gitlab.com/o/r", "berth://team", "o/r@--upload-pack=x"} {
		if s, err := ParseSource(bad); err == nil {
			t.Errorf("%q: no error (%+v)", bad, s)
		}
	}
	s, _ := ParseSource("https://github.com/jo-acme/acme-setup/tree/team-setup/team")
	if s.String() != "github.com/jo-acme/acme-setup/tree/team-setup/team" || s.File("team.json") != "team/team.json" ||
		s.HTMLURL() != "https://github.com/jo-acme/acme-setup/tree/team-setup/team" || s.Key() != "github.com_jo-acme_acme-setup_tree_team-setup_team" {
		t.Fatalf("%s %s %s %s", s.String(), s.File("team.json"), s.HTMLURL(), s.Key())
	}
	if again, _ := ParseSource(s.String()); again != s {
		t.Fatalf("round trip %+v", again)
	}
}

func TestAgents(t *testing.T) {
	doc := strings.Replace(minimal, `"name":"Acme"`, `"name":"Acme","agents":["claude","codex"]`, 1)
	s, warnings, err := Parse([]byte(doc))
	if err != nil || len(warnings) != 0 || strings.Join(s.Agents, ",") != "claude,codex" {
		t.Fatalf("agents: %v %v %v", s, warnings, err)
	}
	doc = strings.Replace(minimal, `"name":"Acme"`, `"name":"Acme","agents":["grok"]`, 1)
	s, warnings, err = Parse([]byte(doc))
	if err != nil || len(warnings) != 0 || strings.Join(s.Agents, ",") != "grok" {
		t.Fatalf("grok: %v %v %v", s, warnings, err)
	}
	for in, want := range map[string]string{
		`["gemini"]`:       "Node.js",
		`["vim"]`:          "not an agent",
		`["claude,codex"]`: "not an agent",
		`"claude"`:         "",
	} {
		doc := strings.Replace(minimal, `"name":"Acme"`, `"name":"Acme","agents":`+in, 1)
		if _, _, err := Parse([]byte(doc)); err == nil || !strings.Contains(err.Error(), want) {
			t.Errorf("agents %s: %v", in, err)
		}
	}
	// A team's own step can't take Shipyard's name for its step.
	doc = strings.Replace(minimal, `{"id":"db","title":"Database"}`, `{"id":"agents","title":"Agents"}`, 1)
	if _, _, err := Parse([]byte(doc)); err == nil || !strings.Contains(err.Error(), "reserved") {
		t.Errorf("a step named agents: %v", err)
	}
	old, _, _ := Parse([]byte(minimal))
	nw, _, _ := Parse([]byte(strings.Replace(minimal, `"name":"Acme"`, `"name":"Acme","agents":["codex"]`, 1)))
	changes := Diff(old, nw, nil, nil)
	if len(changes) != 1 || changes[0].Area != "agent" || changes[0].Text != "Codex" {
		t.Errorf("diff = %+v", changes)
	}
}
