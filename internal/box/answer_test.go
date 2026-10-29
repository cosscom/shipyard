package box

import (
	"context"
	"errors"
	"net/http"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/cosscom/shipyard/internal/transcript"
)

// fakeForm is Claude Code's AskUserQuestion form (2.1), drawn as its
// screen shows it and moved by the keys it takes: arrows move the cursor
// (Left and Right between questions), Enter picks a single choice or
// ticks a multiple one, Space ticks, typing goes into "Type something",
// Next (Submit for the last) moves on, and a review lists the answers
// before they go. With a width, long words wrap as the real one wraps
// them (testdata/answer); with rows, only the foot of the form shows, as
// on a pane shorter than it.
type fakeForm struct {
	width, rows int
	// fits counts how often the screen was made tall enough; noFit keeps
	// it short.
	fits  int
	noFit bool
	// typed can change the words that arrive (a fault).
	typed   func(string) string
	qs      []transcript.Question
	tab     int // the question shown; len(qs) is the review
	cursor  []int
	ticked  []map[int]bool
	other   []string
	picked  []string
	review  int
	sent    bool
	keysLog []string
	// before can change a key or the form before a key acts (a fault).
	before func(f *fakeForm, key string) string
}

func newFakeForm(qs []transcript.Question) *fakeForm {
	f := &fakeForm{qs: qs, review: 1}
	for range qs {
		f.cursor = append(f.cursor, 1)
		f.ticked = append(f.ticked, map[int]bool{})
		f.other = append(f.other, "")
		f.picked = append(f.picked, "")
	}
	return f
}

func (f *fakeForm) reviews() bool { return len(f.qs) > 1 || f.qs[0].Multi }

func (f *fakeForm) fit() func() {
	if f.noFit {
		return func() {}
	}
	old := f.rows
	f.rows = 0
	f.fits++
	return func() { f.rows = old }
}

func (f *fakeForm) keys(k ...string) error {
	if len(k) == 2 && k[0] == "-l" {
		f.keysLog = append(f.keysLog, "type:"+k[1])
		q := f.qs[f.tab]
		if f.cursor[f.tab] == len(q.Options)+1 {
			words := k[1]
			if f.typed != nil {
				words = f.typed(words)
			}
			f.other[f.tab] += words
			if q.Multi {
				f.ticked[f.tab][len(q.Options)+1] = true
			}
		}
		return nil
	}
	for _, key := range k {
		if f.before != nil {
			key = f.before(f, key)
		}
		f.keysLog = append(f.keysLog, key)
		f.press(key)
	}
	return nil
}

func (f *fakeForm) press(key string) {
	if f.sent {
		return
	}
	if f.tab == len(f.qs) {
		switch key {
		case "Up":
			f.review = 1
		case "Down":
			f.review = 2
		case "Left":
			f.tab--
		case "Enter":
			f.sent = f.review == 1
		}
		return
	}
	q := f.qs[f.tab]
	n := len(q.Options)
	rows := []int{}
	for i := 1; i <= n+1; i++ {
		rows = append(rows, i)
	}
	if q.Multi {
		rows = append(rows, 0)
	}
	pos := 0
	for i, r := range rows {
		if r == f.cursor[f.tab] {
			pos = i
		}
	}
	next := func() {
		f.tab++
		if f.tab == len(f.qs) && !f.reviews() {
			f.sent = true
		}
	}
	switch key {
	case "Down":
		f.cursor[f.tab] = rows[min(pos+1, len(rows)-1)]
	case "Up":
		f.cursor[f.tab] = rows[max(pos-1, 0)]
	case "Left":
		f.tab = max(f.tab-1, 0)
	case "Right":
		f.tab++
	case "Space":
		if c := f.cursor[f.tab]; q.Multi && c > 0 && (c <= n || f.other[f.tab] != "") {
			f.ticked[f.tab][c] = !f.ticked[f.tab][c]
		}
	case "Enter":
		c := f.cursor[f.tab]
		switch {
		case q.Multi && c == 0:
			next()
		case q.Multi:
			if c <= n || f.other[f.tab] != "" {
				f.ticked[f.tab][c] = !f.ticked[f.tab][c]
			}
		case c <= n:
			f.picked[f.tab] = q.Options[c-1].Label
			next()
		case f.other[f.tab] != "":
			f.picked[f.tab] = f.other[f.tab]
			next()
		}
	}
}

func (f *fakeForm) answer(i int) string {
	q := f.qs[i]
	if !q.Multi {
		return f.picked[i]
	}
	var parts []string
	for j, o := range q.Options {
		if f.ticked[i][j+1] {
			parts = append(parts, o.Label)
		}
	}
	if f.ticked[i][len(q.Options)+1] {
		parts = append(parts, f.other[i])
	}
	return strings.Join(parts, ", ")
}

const fakeRule = "────────────────────────────────────────────────────────────────────────────────"

// wrap breaks words into lines of the form's width, the first after
// first and the rest after more, as Claude Code wraps them: at a space,
// or inside a word too long for a line of its own (a file's path), which
// fills the line it starts on.
func (f *fakeForm) wrap(first, more, words string) []string {
	if f.width == 0 {
		return []string{first + words}
	}
	var out []string
	line := []rune(first)
	empty := func() bool { return string(line) == first || string(line) == more }
	for _, word := range strings.Fields(words) {
		w := []rune(word)
		if !empty() && len(line)+1+len(w) > f.width && len([]rune(more))+len(w) <= f.width {
			out = append(out, string(line))
			line = []rune(more)
		}
		if !empty() {
			line = append(line, ' ')
		}
		for _, r := range w {
			if len(line) == f.width {
				out = append(out, string(line))
				line = []rune(more)
			}
			line = append(line, r)
		}
	}
	return append(out, string(line))
}

// screen is the frame as the pane shows it: a short one, its foot only.
func (f *fakeForm) screen() string {
	lines := strings.Split(strings.TrimSuffix(f.frame(), "\n"), "\n")
	if f.rows > 0 && len(lines) > f.rows {
		lines = lines[len(lines)-f.rows:]
	}
	return strings.Join(lines, "\n") + "\n"
}

func (f *fakeForm) frame() string {
	var b strings.Builder
	w := func(lines ...string) {
		for _, s := range lines {
			b.WriteString(s + "\n")
		}
	}
	w("❯ Use the AskUserQuestion tool to ask me three questions at once: 1. one single-choice")
	w("  2. one multi-select")
	w("")
	if f.sent {
		w("⏺ User answered Claude's questions:")
		for i, q := range f.qs {
			w("  ⎿  · " + q.Question + " → " + f.answer(i))
		}
		w("")
		w("✢ Thinking… (esc to interrupt)")
		w(fakeRule)
		w("❯ ")
		w(fakeRule)
		w("  ⏵⏵ auto mode on (shift+tab to cycle)")
		return b.String()
	}
	w(fakeRule)
	if f.reviews() {
		tabs := "←  "
		for i, q := range f.qs {
			box := "☐"
			if f.answer(i) != "" {
				box = "☒"
			}
			tabs += box + " " + q.Header + "  "
		}
		w(tabs + "✔ Submit  →")
	} else {
		w(" ☐ " + f.qs[0].Header + "            ")
	}
	if f.tab == len(f.qs) {
		w("Review your answers")
		for i, q := range f.qs {
			if lines := strings.Split(q.Question, "\n"); len(lines) > 1 {
				w(" │ ● " + lines[0])
				for _, l := range lines[1:] {
					w(f.wrap(" │   ", " │   ", l)...)
				}
			} else {
				w(" ● " + q.Question + "       ")
			}
			w(f.wrap("   → ", "   ", f.answer(i))...)
		}
		w("Ready to submit your answers?")
		mark := func(n int) string {
			if f.review == n {
				return "❯ "
			}
			return "  "
		}
		w(mark(1) + "1. Submit answers")
		w(mark(2) + "2. Cancel")
		w("")
		w("")
		return b.String()
	}
	q := f.qs[f.tab]
	// A long question wraps; one of several lines is drawn behind a bar.
	words := q.Question
	switch {
	case strings.Contains(words, "\n"):
		for _, l := range strings.Split(words, "\n") {
			w(f.wrap("│ ", "│ ", l)...)
		}
		w("")
	case len(words) > 50:
		cut := strings.LastIndex(words[:50], " ")
		w(words[:cut])
		w(words[cut+1:])
	default:
		w(words)
	}
	mark := func(n int) string {
		if f.cursor[f.tab] == n {
			return "❯ "
		}
		return "  "
	}
	n := len(q.Options)
	for j, o := range q.Options {
		if q.Multi {
			box := "[ ]"
			if f.ticked[f.tab][j+1] {
				box = "[✔]"
			}
			w(mark(j+1) + strconv.Itoa(j+1) + ". " + box + " " + o.Label)
			w("         " + o.Description + "     ")
		} else {
			w(mark(j+1) + strconv.Itoa(j+1) + ". " + o.Label + "   ")
			w("     " + o.Description)
		}
	}
	if q.Multi {
		box, text := "[ ]", "Type something"
		if f.other[f.tab] != "" {
			text = f.other[f.tab]
		}
		if f.ticked[f.tab][n+1] {
			box = "[✔]"
		}
		w(f.wrap(mark(n+1)+strconv.Itoa(n+1)+". "+box+" ", "     ", text)...)
		label := "Next"
		if f.tab == len(f.qs)-1 {
			label = "Submit"
		}
		w(mark(0) + "   " + label)
	} else {
		text := "Type something."
		if f.other[f.tab] != "" {
			text = f.other[f.tab]
		}
		w(f.wrap(mark(n+1)+strconv.Itoa(n+1)+". ", "     ", text)...)
	}
	w(fakeRule)
	w("  " + strconv.Itoa(n+2) + ". Chat about this")
	w("")
	w("Enter to select · Tab/Arrow keys to navigate · Esc to cancel")
	w("")
	return b.String()
}

var threeQs = []transcript.Question{
	{Question: "Pick a colour:", Header: "Colour", Options: []transcript.Option{{Label: "Red", Description: "The colour red"}, {Label: "Green", Description: "The colour green"}, {Label: "Blue", Description: "The colour blue"}}},
	{Question: "Pick your toppings:", Header: "Toppings", Multi: true, Options: []transcript.Option{{Label: "Cheese", Description: "Add cheese"}, {Label: "Ham", Description: "Add ham"}, {Label: "Olives", Description: "Add olives"}, {Label: "Mushrooms", Description: "Add mushrooms"}}},
	{Question: "What's your pet's name? Pick a suggestion or type your own via Other.", Header: "Pet name", Options: []transcript.Option{{Label: "Biscuit", Description: "Suggestion: Biscuit"}, {Label: "Pepper", Description: "Suggestion: Pepper"}}},
}

func fastSteps(t *testing.T) {
	old := answerStep
	answerStep = 150 * time.Millisecond
	t.Cleanup(func() { answerStep = old })
}

func TestDriveThreeQuestions(t *testing.T) {
	fastSteps(t)
	f := newFakeForm(threeQs)
	as := []QuestionAnswer{{Picks: []string{"Green"}}, {Picks: []string{"Olives", "Cheese"}, Other: "anchovies"}, {Other: "Captain Whiskers"}}
	if _, err := checkAnswers(threeQs, as); err != nil {
		t.Fatal(err)
	}
	if err := driveAnswers(context.Background(), f, threeQs, as); err != nil {
		t.Fatalf("drive: %v\nkeys %v\n%s", err, f.keysLog, f.screen())
	}
	if !f.sent || f.answer(0) != "Green" || f.answer(1) != "Cheese, Olives, anchovies" || f.answer(2) != "Captain Whiskers" {
		t.Fatalf("sent %v: %q %q %q", f.sent, f.answer(0), f.answer(1), f.answer(2))
	}
	want := "Down Enter Space Down Down Space Down Down type:anchovies Down Enter Down Down type:Captain Whiskers Enter Enter"
	if got := strings.Join(f.keysLog, " "); got != want {
		t.Errorf("keys\n got %s\nwant %s", got, want)
	}
}

// One question with one answer goes as soon as it is picked; one with
// several picks has a review.
func TestDriveOneQuestion(t *testing.T) {
	fastSteps(t)
	one := []transcript.Question{{Question: "Tea or coffee?", Header: "Drink", Options: []transcript.Option{{Label: "Tea"}, {Label: "Coffee"}}}}
	f := newFakeForm(one)
	if err := driveAnswers(context.Background(), f, one, []QuestionAnswer{{Picks: []string{"Coffee"}}}); err != nil || !f.sent || f.answer(0) != "Coffee" {
		t.Fatalf("single: %v %v %q", err, f.sent, f.answer(0))
	}
	if got := strings.Join(f.keysLog, " "); got != "Down Enter" {
		t.Errorf("keys = %s", got)
	}
	fruit := []transcript.Question{{Question: "Which fruits?", Header: "Fruits", Multi: true, Options: []transcript.Option{{Label: "Apple"}, {Label: "Pear"}, {Label: "Plum"}}}}
	f = newFakeForm(fruit)
	if err := driveAnswers(context.Background(), f, fruit, []QuestionAnswer{{Picks: []string{"Apple", "Plum"}}}); err != nil || !f.sent || f.answer(0) != "Apple, Plum" {
		t.Fatalf("multi: %v %v %q\n%v", err, f.sent, f.answer(0), f.keysLog)
	}
}

// The person had already moved on in the form, and ticked something:
// it goes back to the first question and sets every tick as asked.
func TestDriveFromWhereThePersonLeftIt(t *testing.T) {
	fastSteps(t)
	f := newFakeForm(threeQs)
	f.picked[0] = "Red"
	f.ticked[1][2] = true // Ham
	f.tab = 1
	as := []QuestionAnswer{{Picks: []string{"Blue"}}, {Picks: []string{"Mushrooms"}}, {Picks: []string{"Pepper"}}}
	if err := driveAnswers(context.Background(), f, threeQs, as); err != nil {
		t.Fatalf("drive: %v\n%v", err, f.keysLog)
	}
	if !f.sent || f.answer(0) != "Blue" || f.answer(1) != "Mushrooms" || f.answer(2) != "Pepper" {
		t.Fatalf("sent %v: %q %q %q", f.sent, f.answer(0), f.answer(1), f.answer(2))
	}
}

// Anything unexpected stops it, says what, and never submits.
func TestDriveStopsOnSurprise(t *testing.T) {
	fastSteps(t)
	as := []QuestionAnswer{{Picks: []string{"Green"}}, {Picks: []string{"Ham"}}, {Picks: []string{"Biscuit"}}}
	cases := map[string]func(f *fakeForm, key string) string{
		// A key that does nothing (the agent froze, or another screen).
		"ignored": func(f *fakeForm, key string) string {
			if key == "Down" {
				return "Nothing"
			}
			return key
		},
		// The answer lands elsewhere: the review would show the wrong one.
		"wrong pick": func(f *fakeForm, key string) string {
			if f.tab == 2 && key == "Enter" {
				f.cursor[2] = 2
			}
			return key
		},
		// The review is drawn, but its top is out of sight: nothing
		// says what would go, so nothing goes.
		"review out of sight": func(f *fakeForm, key string) string {
			if f.tab == len(f.qs)-1 && key == "Enter" {
				f.rows = 6
			}
			return key
		},
		// A different question comes up.
		"other question": func(f *fakeForm, key string) string {
			if f.tab == 1 && key == "Enter" && f.cursor[1] == 0 {
				f.qs = append([]transcript.Question{}, f.qs...)
				f.qs[2].Question = "Something else entirely?"
			}
			return key
		},
	}
	for name, fault := range cases {
		f := newFakeForm(threeQs)
		f.before = fault
		err := driveAnswers(context.Background(), f, threeQs, as)
		var he httpError
		if !errors.As(err, &he) || he.status != http.StatusConflict || !strings.Contains(he.msg, "finish in Claude's screen") {
			t.Errorf("%s: err = %v", name, err)
		}
		if f.sent {
			t.Errorf("%s: submitted anyway", name)
		}
	}
	// Words that arrive short (a key lost) stop it at that question.
	f0 := newFakeForm(threeQs)
	f0.typed = func(s string) string { return s[:len(s)-2] }
	err := driveAnswers(context.Background(), f0, threeQs, []QuestionAnswer{{Picks: []string{"Green"}}, {Picks: []string{"Ham"}}, {Other: "Captain Whiskers"}})
	if err == nil || !strings.Contains(err.Error(), "didn't take your words") || f0.sent {
		t.Errorf("lost keys: %v, sent %v", err, f0.sent)
	}
	// Not the form at all.
	f := &plainScreen{s: "❯ \n" + fakeRule + "\n  ⏵⏵ auto mode on"}
	if err := driveAnswers(context.Background(), f, threeQs, as); err == nil || !strings.Contains(err.Error(), "doesn't show its questions") {
		t.Errorf("no form: %v", err)
	}
	if len(f.sent) != 0 {
		t.Errorf("keys sent to a screen without the form: %v", f.sent)
	}
}

type plainScreen struct {
	s    string
	sent []string
}

func (p *plainScreen) keys(k ...string) error { p.sent = append(p.sent, k...); return nil }
func (p *plainScreen) screen() string         { return p.s }
func (p *plainScreen) fit() func()            { return func() {} }

func TestCheckAnswers(t *testing.T) {
	ok := []QuestionAnswer{{Picks: []string{"Green"}}, {Picks: []string{"Ham"}}, {Other: "Rex"}}
	if shown, err := checkAnswers(threeQs, ok); err != nil || shown[2] != "Rex" {
		t.Fatalf("%v %v", shown, err)
	}
	bad := map[string][]QuestionAnswer{
		"too few":           ok[:2],
		"two for a single":  {{Picks: []string{"Green", "Red"}}, ok[1], ok[2]},
		"pick and words":    {{Picks: []string{"Green"}, Other: "teal"}, ok[1], ok[2]},
		"not an option":     {{Picks: []string{"Purple"}}, ok[1], ok[2]},
		"no answer":         {{}, ok[1], ok[2]},
		"words over a line": {ok[0], ok[1], {Other: "Rex\nthe dog"}},
	}
	for name, as := range bad {
		if _, err := checkAnswers(threeQs, as); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}

// readForm on screens as Claude Code 2.1.289 drew them (captured, wide).
func TestReadForm(t *testing.T) {
	multi := strings.Join([]string{
		"❯ Use the AskUserQuestion tool to ask me three questions at once: one single-choice (pick a colour: red, green, blue), one multi-select (pick toppings: cheese, ham, olives, mushrooms), one where I'd  ",
		"  type my own answer (a pet's name, offer two suggestions). Then repeat my exact answers back to me.",
		"",
		fakeRule,
		"←  ☒ Colour  ☐ Toppings  ☐ Pet name  ✔ Submit  →",
		"",
		"Pick your toppings:",
		"",
		"  1. [✔] Cheese",
		"         Add cheese",
		"  2. [ ] Ham",
		"         Add ham     ",
		"❯ 3. [✔] Olives",
		"         Add olives ",
		"  4. [ ] Mushrooms  ",
		"         Add mushrooms",
		"  5. [✔] anchovies     ",
		"     Next",
		fakeRule,
		"  6. Chat about this",
		"",
		"Enter to select · Tab/Arrow keys to navigate · ctrl+g to edit in Vim · Esc to cancel",
		"", "",
	}, "\n")
	f := readForm(multi)
	if !f.ok || f.review || f.question != "Pick your toppings:" || f.cursor != 3 || len(f.rows) != 6 {
		t.Fatalf("multi: %+v", f)
	}
	if r := f.row(1); !r.box || !r.checked || r.text != "Cheese" {
		t.Errorf("row 1 = %+v", r)
	}
	if r := f.row(2); !r.box || r.checked || r.text != "Ham" {
		t.Errorf("row 2 = %+v", r)
	}
	if r := f.row(5); !r.checked || r.text != "anchovies" {
		t.Errorf("own words = %+v", r)
	}
	if r := f.row(0); r.text != "Next" || f.has(6) {
		t.Errorf("next = %+v, chat counted: %v", r, f.has(6))
	}

	single := strings.Join([]string{
		"❯ Now use AskUserQuestion to ask me ONE single-choice question: tea or coffee (two options). Just that one question.",
		fakeRule,
		" ☐ Drink            ",
		"",
		"Tea or coffee?",
		"",
		"❯ 1. Tea",
		"     A cup of tea",
		"  2. Coffee",
		"     A cup of coffee",
		"  3. Type something.",
		fakeRule,
		"  4. Chat about this",
		"",
		"Enter to select · ↑/↓ to navigate · Esc to cancel",
	}, "\n")
	if f := readForm(single); !f.ok || f.question != "Tea or coffee?" || f.cursor != 1 || !ownWordsEmpty(f.row(3).text) || f.row(2).box {
		t.Fatalf("single: %+v", f)
	}

	review := strings.Join([]string{
		fakeRule,
		"←  ☒ Colour  ☒ Toppings  ☒ Pet name  ✔ Submit  →",
		"",
		"Review your answers",
		"",
		" ● Pick a colour:       ",
		"   → Green  ",
		" ● Pick your toppings: ",
		"   → Cheese, Olives, anchovies",
		" ● What's your pet's name? Pick a suggestion or type your own via Other.",
		"   → Captain Whiskers",
		"",
		"Ready to submit your answers?",
		"",
		"❯ 1. Submit answers",
		"  2. Cancel",
		"", "", "",
	}, "\n")
	f = readForm(review)
	if !f.ok || !f.review || f.cursor != 1 || f.row(1).text != "Submit answers" || !strings.Contains(f.reviewText, "→ Cheese, Olives, anchovies") {
		t.Fatalf("review: %+v", f)
	}

	// Its answer in the conversation, and the prompt back: no form.
	done := strings.Join([]string{
		"⏺ User answered Claude's questions:",
		"  ⎿  · Pick a colour: → Green",
		"     · Pick your toppings: → Cheese, Olives, anchovies",
		"⏺ Here are your answers, exactly as you gave them:",
		"✻ Crunched for 4s · done 10:12",
		fakeRule,
		"❯ ",
		fakeRule,
		"  Opus 5.5 · context 5%",
		"  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents",
	}, "\n")
	if f := readForm(done); f.ok {
		t.Fatalf("done: %+v", f)
	}
	// A permission prompt is not a question form.
	perm := strings.Join([]string{
		"Bash command",
		"  rm -rf build",
		"Do you want to proceed?",
		"❯ 1. Yes",
		"  2. No, and tell Claude what to do differently (esc)",
		"",
		"Esc to cancel",
	}, "\n")
	if f := readForm(perm); f.ok {
		t.Fatalf("permission read as a form: %+v", f)
	}
}

// Questions with lists in them, as agents ask, and long answers: what an
// 80x24 pane can't show whole.
var listQs = []transcript.Question{
	{Question: "How should acme roll out the new checkout?\n1. The old flow stays behind a flag for a week.\n2. Support wants a heads-up before any change customers can see, and release notes go out on Mondays.\n3. Mobile ships on its own schedule.", Header: "Rollout", Options: []transcript.Option{{Label: "Flag first (Recommended)", Description: "Ship behind the flag, turn it on for staff, then everyone."}, {Label: "All at once", Description: "Turn it on for everyone on release day."}, {Label: "Wait", Description: "Hold until mobile is ready too."}}},
	{Question: "Who owns the rollout?\n1. Alex wrote most of the change.\n2. Sam is on call that week.", Header: "Owner", Options: []transcript.Option{{Label: "Alex", Description: "The author."}, {Label: "Sam", Description: "The on-call engineer."}}},
	{Question: "Anything else the team should know before starting?", Header: "Notes", Options: []transcript.Option{{Label: "Nothing", Description: "No further notes."}, {Label: "Later", Description: "More notes will follow."}}},
}

const (
	longWords1 = "Flag first, but keep the flag on for staff only until the support team has had a full Monday with the new flow. If the error rate on payment confirmation goes above half a percent at any point, turn the flag off and tell the channel before anything else."
	longWords3 = "The staging database was restored from last week's backup, so some fixtures may be stale. Release notes are drafted in the shared folder; please add a line about the flag and who to ask."
)

// Long words wrap, and the form is taller than the pane: it is made tall
// enough while it is answered, every answer goes in whole, and the pane
// is put back.
func TestDriveLongWordsOnAShortPane(t *testing.T) {
	fastSteps(t)
	f := newFakeForm(listQs)
	f.width, f.rows = 80, 24
	as := []QuestionAnswer{{Other: longWords1}, {Picks: []string{"Sam"}}, {Other: longWords3}}
	if _, err := checkAnswers(listQs, as); err != nil {
		t.Fatal(err)
	}
	if err := driveAnswers(context.Background(), f, listQs, as); err != nil {
		t.Fatalf("drive: %v\nkeys %v\n%s", err, f.keysLog, f.screen())
	}
	if !f.sent || f.answer(0) != longWords1 || f.answer(1) != "Sam" || f.answer(2) != longWords3 {
		t.Fatalf("sent %v: %q %q %q", f.sent, f.answer(0), f.answer(1), f.answer(2))
	}
	if f.fits != 1 || f.rows != 24 {
		t.Errorf("fits %d, rows put back to %d", f.fits, f.rows)
	}
}

// Images attached to an answer go as their paths after the words, each
// longer than a line of an 80-column pane: Claude Code breaks them inside
// the path, and every answer still goes in whole, through the review.
func TestDriveAttachedPathsOnAShortPane(t *testing.T) {
	fastSteps(t)
	f := newFakeForm(listQs)
	f.width, f.rows = 80, 24
	dir := "/home/acme/work/acme-shop-checkout-rollout/.berth/attachments/"
	words1 := "the flag step was off [attached: " + dir + "20261025-152924-pasted-152924.webp " + dir + "20261025-152931-checkout-step-two-after-the-flag.png]"
	words3 := "[attached: " + dir + "20261025-153002-pasted-153002.webp]"
	as := []QuestionAnswer{{Other: words1}, {Picks: []string{"Sam"}}, {Other: words3}}
	if _, err := checkAnswers(listQs, as); err != nil {
		t.Fatal(err)
	}
	if err := driveAnswers(context.Background(), f, listQs, as); err != nil {
		t.Fatalf("drive: %v\nkeys %v\n%s", err, f.keysLog, f.screen())
	}
	if !f.sent || f.answer(0) != words1 || f.answer(2) != words3 {
		t.Fatalf("sent %v: %q %q", f.sent, f.answer(0), f.answer(2))
	}
}

// Read back, words may differ from what was typed only where a line
// breaks: a space there, or none inside a long word. A space anywhere
// else is a different answer.
func TestWordsAsWrapped(t *testing.T) {
	cases := []struct {
		lines []string
		words string
		want  bool
	}{
		{[]string{"use /tmp/a b"}, "use /tmp/a b", true},
		{[]string{"use /tmp/a b"}, "use /tmp/ab", false},
		{[]string{"use /tmp/ab"}, "use /tmp/a b", false},
		{[]string{"now here"}, "nowhere", false},
		{[]string{"now", "here"}, "now here", true},
		{[]string{"/home/acme/.b", "erth/x.png"}, "/home/acme/.berth/x.png", true},
		{[]string{"/home/acme/.b", "erth/x.png"}, "/home/acme/.b erth/x.png", true},
		{[]string{"off [attached: /a/", "b.png]"}, "off [attached: /a/b.png]", true},
		{[]string{"off [attached: /a/", "b.png] more"}, "off [attached: /a/b.png]", false},
	}
	for _, c := range cases {
		if got := (formRow{text: c.lines[0], more: c.lines[1:]}).holds(c.words); got != c.want {
			t.Errorf("%q holds %q = %v", c.lines, c.words, got)
		}
	}
	review := []string{"· Which screen? → off [attached: /home/acme/.b", "erth/x.png]", "· Who? → Sam"}
	if !wrapsWith(review, "→ off [attached: /home/acme/.berth/x.png]") || !wrapsWith(review, "→ Sam") {
		t.Errorf("review doesn't show its wrapped answers")
	}
	if wrapsWith(review, "→ off [attached: /home/acme/.be rth/x.png]") {
		t.Errorf("review shows an answer with a space it hasn't")
	}
}

// Kept short, the form's top is out of sight: nothing is pressed.
func TestDriveNeedsTheWholeForm(t *testing.T) {
	fastSteps(t)
	f := newFakeForm(listQs)
	f.width, f.rows, f.noFit = 80, 14, true
	err := driveAnswers(context.Background(), f, listQs, []QuestionAnswer{{Other: longWords1}, {Picks: []string{"Sam"}}, {Other: longWords3}})
	if err == nil || !strings.Contains(err.Error(), "doesn't show its questions") || len(f.keysLog) != 0 {
		t.Fatalf("err %v, keys %v", err, f.keysLog)
	}
}

func readScreen(t *testing.T, name string) string {
	t.Helper()
	b, err := os.ReadFile("testdata/answer/" + name)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

// readForm on Claude Code 2.1.303's screens at 80 columns, captured with
// the questions above (testdata/answer).
func TestReadFormRealScreens(t *testing.T) {
	// A question of several lines, behind its bar, with a list in it.
	f := readForm(readScreen(t, "question-list-80.txt"))
	if !f.ok || f.review || questionIndex(listQs, f.question) != 0 || f.cursor != 1 || len(f.rows) != 4 {
		t.Fatalf("question: %+v", f)
	}
	if f.question != flatText(listQs[0].Question) {
		t.Errorf("question words = %q", f.question)
	}
	if r := f.row(1); r.text != "Flag first (Recommended)" || !ownWordsEmpty(f.row(4).text) {
		t.Errorf("rows = %+v", f.rows)
	}
	// Drawn without the bar (earlier versions), its "1." lines are still
	// the question's, not options.
	bare := strings.ReplaceAll(readScreen(t, "question-list-80.txt"), "│ ", "")
	if f := readForm(bare); !f.ok || questionIndex(listQs, f.question) != 0 || len(f.rows) != 4 || f.row(1).text != "Flag first (Recommended)" {
		t.Fatalf("bare: %+v", f)
	}
	// The foot of it, as a pane too short for it shows: not readable.
	if f := readForm(readScreen(t, "question-list-short.txt")); f.ok {
		t.Fatalf("short: %+v", f)
	}
	// Long words of the person's own, wrapped under their row.
	f = readForm(readScreen(t, "own-words-wrapped-80.txt"))
	if !f.ok || f.cursor != 4 || f.row(4).words() != longWords1 {
		t.Fatalf("own words: %q\n%+v", f.row(4).words(), f)
	}
	// Paths too long for a line, broken inside them (Claude Code 2.1.310).
	f = readForm(readScreen(t, "own-words-paths-80.txt"))
	paths := "this is the one that is off [attached: /tmp/verify-berthd-box/acme-shop/.berth/attachments/20261025-152924-orange-giraffe.png /tmp/verify-berthd-box/acme-shop/.berth/attachments/20261025-152924-teal-anchor.png]"
	if !f.ok || f.cursor != 3 || !f.row(3).holds(paths) {
		t.Fatalf("paths: %q\n%+v", f.row(3).words(), f)
	}
	if f.row(3).holds(strings.Replace(paths, "teal", "tea", 1)) {
		t.Errorf("holds words that aren't there")
	}
	// The review, every long answer wrapped.
	f = readForm(readScreen(t, "review-long-80.txt"))
	if !f.ok || !f.review || f.cursor != 1 || f.row(1).text != "Submit answers" {
		t.Fatalf("review: %+v", f)
	}
	for _, a := range []string{longWords1, "Sam", longWords3} {
		if !strings.Contains(f.reviewText, "→ "+a) {
			t.Errorf("review lacks %q:\n%s", a, f.reviewText)
		}
	}
}

// fit makes a short pane tall enough, then puts back its size and its own
// window-size setting, or none.
func TestFitPutsThePaneBack(t *testing.T) {
	s := testSessions(t)
	ctx := context.Background()
	if out, err := s.tmux(ctx, "new-session", "-d", "-s", "fit", "-x", "80", "-y", "24", "sh"); err != nil {
		t.Fatalf("%v: %s", err, out)
	}
	term := tmuxTerm{s: s, target: "=fit:"}
	size := func() string {
		out, _ := s.tmux(ctx, "display-message", "-p", "-t", term.target, "#{window_width}x#{window_height}")
		return strings.TrimSpace(string(out))
	}
	own := func() string {
		out, _ := s.tmux(ctx, "show-options", "-w", "-q", "-v", "-t", term.target, "window-size")
		return strings.TrimSpace(string(out))
	}
	for _, policy := range []string{"", "smallest"} {
		if policy != "" {
			s.tmux(ctx, "set-option", "-w", "-t", term.target, "window-size", policy)
		}
		restore := term.fit()
		if got := size(); got != "80x"+strconv.Itoa(formRows) {
			t.Fatalf("fitted: %s", got)
		}
		restore()
		if got := size(); got != "80x24" {
			t.Errorf("%q: put back to %s", policy, got)
		}
		if got := own(); got != policy {
			t.Errorf("window-size %q put back as %q", policy, got)
		}
	}
}

// The log keeps the form, not the conversation above it.
func TestFormTail(t *testing.T) {
	sc := "secret: hunter2\n" + readScreen(t, "question-list-80.txt")
	got := formTail(sc)
	if strings.Contains(got, "hunter2") || strings.Contains(got, "acme checkout rollout with") || !strings.Contains(got, "☐ Rollout") || !strings.Contains(got, "4. Type something.") {
		t.Fatalf("formTail:\n%s", got)
	}
	if got := formTail("a\nb\nc\nd\ne\nf\ng\nh\ni\nj"); strings.Contains(got, "| b") || !strings.Contains(got, "| j") {
		t.Errorf("no form: %s", got)
	}
}
