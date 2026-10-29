package box

import (
	"context"
	"fmt"
	"log"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/cosscom/shipyard/internal/transcript"
)

// Answering an agent's questions from the chat (the "answer" capability):
// Claude Code's AskUserQuestion draws a form of its own, a tab per
// question, each with its options (radios, or checkboxes for one that
// takes several), a "Type something" field for the person's own words,
// and, for more than one question or a multiple choice, a review with
// Submit. POST /v1/sessions/{name}/answer takes the whole answer set and
// fills that form in with keys, reading the screen after every key to
// check it shows what it should, as the rewind does. Anything unexpected
// stops it where it is, untouched, and says what: the person finishes in
// the agent's own screen. Nothing is guessed and nothing is submitted
// that the review doesn't show.

// AnswerRequest answers the questions one AskUserQuestion call asked.
type AnswerRequest struct {
	// Tool is the call (the question item's "tool").
	Tool    string           `json:"tool"`
	Answers []QuestionAnswer `json:"answers"`
}

// QuestionAnswer is one question's answer: the options picked, by label
// (one for a single choice), and the person's own words (Other).
type QuestionAnswer struct {
	Picks []string `json:"picks,omitempty"`
	Other string   `json:"other,omitempty"`
}

// AnswerResult is what was answered, each as Claude Code shows it.
type AnswerResult struct {
	Answered []string `json:"answered"`
}

var answering sync.Map // session name → *sync.Mutex

func (b *Box) mountAnswer(route func(string, func(http.ResponseWriter, *http.Request) error)) {
	route("POST /v1/sessions/{name}/answer", b.answerSession)
}

func (b *Box) answerSession(w http.ResponseWriter, r *http.Request) error {
	var req AnswerRequest
	if err := decode(r, &req); err != nil {
		return err
	}
	if req.Tool == "" {
		return badRequest("say which question to answer (tool)")
	}
	sess, err := b.Sessions.Get(r.Context(), r.PathValue("name"))
	if err != nil {
		return err
	}
	shown, err := b.answer(r.Context(), sess, req)
	if err != nil {
		// Every answer that didn't go says why in the box's log.
		log.Printf("answer %s: %v", sess.Name, err)
		return err
	}
	log.Printf("answer %s: answered %d questions", sess.Name, len(shown))
	writeJSON(w, AnswerResult{Answered: shown})
	return nil
}

func (b *Box) answer(ctx context.Context, sess Session, req AnswerRequest) ([]string, error) {
	if b.Turns != nil {
		if st, ok := b.Turns.State(sess.Name); ok && st.State != "waiting" {
			return nil, httpError{http.StatusConflict, "Claude isn't waiting for an answer"}
		}
	}
	mu, _ := answering.LoadOrStore(sess.Name, &sync.Mutex{})
	if !mu.(*sync.Mutex).TryLock() {
		return nil, httpError{http.StatusConflict, "already answering Claude's questions"}
	}
	defer mu.(*sync.Mutex).Unlock()
	return b.driverFor(sess).Answer(ctx, sess, req)
}

// checkAnswers says the answers fit the questions, and returns each as
// Claude Code will show it: the options picked, in their order, then the
// person's own words, joined with ", ".
func checkAnswers(qs []transcript.Question, as []QuestionAnswer) ([]string, error) {
	if len(as) != len(qs) {
		return nil, badRequest("answer all %d questions", len(qs))
	}
	out := make([]string, len(qs))
	for i, q := range qs {
		a := as[i]
		other := strings.Join(strings.Fields(a.Other), " ")
		if other != a.Other && strings.TrimSpace(a.Other) != other {
			return nil, badRequest("question %d: the answer in your words is one line", i+1)
		}
		as[i].Other = other
		var parts []string
		for _, o := range q.Options {
			for _, p := range a.Picks {
				if p == o.Label {
					parts = append(parts, o.Label)
					break
				}
			}
		}
		if len(parts) != len(a.Picks) {
			return nil, badRequest("question %d: pick from its options", i+1)
		}
		if other != "" {
			parts = append(parts, other)
		}
		switch {
		case len(parts) == 0:
			return nil, badRequest("question %d has no answer", i+1)
		case !q.Multi && len(parts) > 1:
			return nil, badRequest("question %d takes one answer", i+1)
		}
		out[i] = strings.Join(parts, ", ")
	}
	return out, nil
}

// keyTerm is a terminal answered with keys: the agent's tmux pane, or a
// model of it in tests.
type keyTerm interface {
	keys(k ...string) error
	screen() string
	// fit makes the screen tall enough to show a whole form, and gives
	// back what puts it as it was.
	fit() (restore func())
}

type tmuxTerm struct {
	s      *Sessions
	target string
}

func (t tmuxTerm) keys(k ...string) error {
	if len(k) == 2 && k[0] == "-l" {
		// Typed text goes in pieces tmux takes; it is still keystrokes.
		for _, part := range literalChunks(k[1]) {
			out, err := t.s.tmux(context.Background(), "send-keys", "-t", t.target, "-l", part)
			if err != nil {
				return tmuxSendError("send-keys", out, err)
			}
		}
		return nil
	}
	out, err := t.s.tmux(context.Background(), append([]string{"send-keys", "-t", t.target}, k...)...)
	if err != nil {
		return tmuxSendError("send-keys", out, err)
	}
	return nil
}

func (t tmuxTerm) screen() string {
	out, _ := t.s.tmux(context.Background(), "capture-pane", "-p", "-J", "-t", t.target)
	return string(out)
}

// formRows is a screen tall enough for any form: four questions'
// review, each with a long answer, at 80 columns.
const formRows = 200

// fit grows a short pane while it is answered. A form taller than its
// screen scrolls its tabs and question off the top, where the screen
// can't be read: what scrolls off is an old frame, not the one drawn
// after it. An agent nobody has open sits at tmux's 80x24,
// which a question with a list in it outgrows.
func (t tmuxTerm) fit() func() {
	ctx := context.Background()
	out, err := t.s.tmux(ctx, "display-message", "-p", "-t", t.target, "#{window_width} #{window_height}")
	if err != nil {
		return func() {}
	}
	var w, h int
	if _, err := fmt.Sscan(string(out), &w, &h); err != nil || h >= formRows {
		return func() {}
	}
	// resize-window fixes the window's size (window-size manual): its own
	// setting, if it had one, goes back after, else it inherits again.
	own, _ := t.s.tmux(ctx, "show-options", "-w", "-q", "-v", "-t", t.target, "window-size")
	if _, err := t.s.tmux(ctx, "resize-window", "-t", t.target, "-y", strconv.Itoa(formRows)); err != nil {
		return func() {}
	}
	policy := []string{"set-option", "-w", "-u", "-t", t.target, "window-size"}
	if v := strings.TrimSpace(string(own)); v != "" {
		policy = []string{"set-option", "-w", "-t", t.target, "window-size", v}
	}
	return func() {
		t.s.tmux(ctx, append([]string{"resize-window", "-t", t.target, "-x", strconv.Itoa(w), "-y", strconv.Itoa(h), ";"}, policy...)...)
	}
}

// formTail is what the box's log keeps of a screen where an answer
// stopped: the form, from its tabs down, or the foot of a screen without
// one. Never the conversation above it. The form holds the person's own
// words, as the agent's record does on the same box: without what the
// screen showed, the next failure can't be told apart from this one.
func formTail(sc string) string {
	lines := strings.Split(strings.TrimRight(sc, " \n\t"), "\n")
	from := max(len(lines)-8, 0)
	for i := len(lines) - 1; i >= 0; i-- {
		l := strings.TrimSpace(lines[i])
		if (strings.HasPrefix(l, "←") || strings.HasPrefix(l, "☐") || strings.HasPrefix(l, "☒")) && strings.ContainsAny(l, "☐☒") {
			from = i
			break
		}
	}
	var out []string
	for _, l := range lines[from:] {
		if l = strings.TrimRight(l, " \t"); l != "" {
			out = append(out, "  | "+l)
		}
	}
	return strings.Join(out, "\n")
}

// answerStep is how long one key's effect may take to show.
var answerStep = 2500 * time.Millisecond

// stuck is an answer that stopped: what the screen showed instead.
func stuck(format string, args ...any) error {
	return httpError{http.StatusConflict, fmt.Sprintf(format, args...) + ": finish in Claude's screen"}
}

// driveAnswers fills in Claude Code's question form from the top, one
// question at a time, checking the screen after each key. Where it stops,
// the box's log has the screen it stopped at.
func driveAnswers(ctx context.Context, t keyTerm, qs []transcript.Question, as []QuestionAnswer) (err error) {
	restore := t.fit()
	defer func() {
		if err != nil {
			// answerSession logs why.
			log.Printf("answer: Claude's form when it stopped:\n%s", formTail(t.screen()))
		}
		restore()
	}()
	until := func(ok func(formView) bool) (formView, bool) {
		end := time.Now().Add(answerStep)
		for {
			f := readForm(t.screen())
			if ok(f) {
				return f, true
			}
			if time.Now().After(end) || ctx.Err() != nil {
				return f, false
			}
			time.Sleep(40 * time.Millisecond)
		}
	}
	press := func(k ...string) error {
		if err := ctx.Err(); err != nil {
			return err
		}
		return t.keys(k...)
	}
	// moveTo puts the cursor on a row: an option's number, or 0 for the
	// Next (or Submit) row under a multiple choice.
	moveTo := func(target int) (formView, error) {
		for range 24 {
			f := readForm(t.screen())
			if f.cursor == target {
				return f, nil
			}
			if f.cursor < 0 || !f.has(target) {
				return f, stuck("Claude's form has no option %s", rowName(target))
			}
			key := "Down"
			if rowPos(target) < rowPos(f.cursor) {
				key = "Up"
			}
			if err := press(key); err != nil {
				return f, err
			}
			from := f.cursor
			if _, ok := until(func(g formView) bool { return g.ok && g.cursor != from }); !ok {
				return f, stuck("Claude's form didn't move to option %s", rowName(target))
			}
		}
		return formView{}, stuck("Claude's form didn't reach option %s", rowName(target))
	}

	// typeOther types the person's words into the "Type something" row
	// (or, with none, checks a multiple choice's holds none).
	typeOther := func(row int, words string, multi bool) error {
		if words == "" {
			if multi && readForm(t.screen()).row(row).checked {
				return stuck("Claude's own-words answer is ticked")
			}
			return nil
		}
		f, err := moveTo(row)
		if err != nil {
			return err
		}
		r := f.row(row)
		switch {
		case r.holds(words) && (!multi || r.checked):
			return nil
		case !ownWordsEmpty(r.text):
			return stuck("Claude's own-words answer already holds %q", clip(r.words(), 60))
		}
		if err := press("-l", words); err != nil {
			return err
		}
		// Long words wrap onto the lines under the row: read whole, they
		// are exactly what was typed.
		if g, ok := until(func(g formView) bool {
			r := g.row(row)
			return g.ok && r.holds(words) && (!multi || r.checked)
		}); !ok {
			return stuck("Claude's form didn't take your words: it shows %q", clip(g.row(row).words(), 60))
		}
		return nil
	}

	// More than one question, or several picks, end in a review.
	reviews := len(qs) > 1 || qs[0].Multi
	// The form opens on the first question; one the person moved on from
	// goes back to it.
	f, ok := until(func(f formView) bool { return f.ok && (f.review || questionIndex(qs, f.question) >= 0) })
	if !ok {
		return stuck("Claude's screen doesn't show its questions")
	}
	for range len(qs) + 1 {
		if !f.review && questionIndex(qs, f.question) == 0 {
			break
		}
		if err := press("Left"); err != nil {
			return err
		}
		prev := f
		if f, ok = until(func(g formView) bool { return g.ok && (g.review != prev.review || g.question != prev.question) }); !ok {
			return stuck("Claude's form didn't go back to the first question")
		}
	}
	if questionIndex(qs, f.question) != 0 || f.review {
		return stuck("Claude's form didn't go back to the first question")
	}

	for i, q := range qs {
		a := as[i]
		if _, ok := until(func(f formView) bool { return f.ok && !f.review && questionIndex(qs, f.question) == i }); !ok {
			return stuck("Claude's screen doesn't show question %d (%s)", i+1, firstNonEmpty(q.Header, q.Question))
		}
		other := len(q.Options) + 1 // the "Type something" row
		if q.Multi {
			for j, o := range q.Options {
				want := false
				for _, p := range a.Picks {
					want = want || p == o.Label
				}
				f, err := moveTo(j + 1)
				if err != nil {
					return err
				}
				row := f.row(j + 1)
				if !row.box || !sameLabel(row.text, o.Label) {
					return stuck("Claude's option %d reads %q, not %q", j+1, row.text, o.Label)
				}
				if row.checked == want {
					continue
				}
				if err := press("Space"); err != nil {
					return err
				}
				if _, ok := until(func(g formView) bool { return g.ok && g.row(j+1).checked == want }); !ok {
					return stuck("Claude didn't tick %q", o.Label)
				}
			}
			if err := typeOther(other, a.Other, true); err != nil {
				return err
			}
			if _, err := moveTo(0); err != nil {
				return err
			}
		} else {
			target := other
			for j, o := range q.Options {
				if len(a.Picks) == 1 && a.Picks[0] == o.Label {
					target = j + 1
				}
			}
			if target == other {
				if err := typeOther(other, a.Other, false); err != nil {
					return err
				}
			} else {
				f, err := moveTo(target)
				if err != nil {
					return err
				}
				if row := f.row(target); !sameLabel(row.text, a.Picks[0]) {
					return stuck("Claude's option %d reads %q, not %q", target, row.text, a.Picks[0])
				}
			}
		}
		if err := press("Enter"); err != nil {
			return err
		}
		last := i == len(qs)-1
		var ok bool
		if f, ok = until(func(f formView) bool {
			switch {
			case !last:
				return f.ok && !f.review && questionIndex(qs, f.question) == i+1
			case reviews:
				return f.ok && f.review
			}
			return !f.ok
		}); !ok {
			if last && reviews {
				return stuck("Claude's form didn't show its review after question %d", i+1)
			}
			return stuck("Claude didn't take the answer to question %d", i+1)
		}
	}
	if !reviews {
		return nil
	}

	// More than one question, or several picks: Claude Code shows them all
	// before they go. Submit only what it shows as wanted.
	shown, _ := checkAnswers(qs, as)
	for i, s := range shown {
		if !wrapsWith(f.reviewLines, "→ "+s) {
			return stuck("Claude's review doesn't show %q for question %d", s, i+1)
		}
	}
	if f, err = moveTo(1); err != nil {
		return err
	}
	if r := f.row(1); r.text != "Submit answers" {
		return stuck("Claude's review offers %q, not Submit answers", r.text)
	}
	if err := press("Enter"); err != nil {
		return err
	}
	if _, ok := until(func(f formView) bool { return !f.ok }); !ok {
		return stuck("Claude didn't take the answers")
	}
	return nil
}

// formView is Claude Code's question form, read from its screen.
type formView struct {
	ok bool
	// review is the last step, listing every answer, with Submit.
	review     bool
	reviewText string
	// reviewLines are its lines, as they wrap.
	reviewLines []string
	// question is the one shown, its words on one line.
	question string
	rows     []formRow
	// cursor is the row under "❯": its number, 0 for the Next (or
	// Submit) row of a multiple choice, -1 for none.
	cursor int
}

type formRow struct {
	num  int // 0 for the Next row
	text string
	// more is the lines under it: an option's description, or the rest
	// of long words of the person's own, wrapped.
	more    []string
	box     bool // a checkbox: "[ ]" or "[✔]"
	checked bool
}

// words is the person's own words in the row, on one line.
func (r formRow) words() string {
	return flatText(r.text + " " + strings.Join(r.more, " "))
}

// holds says the row shows words, wherever the form wrapped them.
func (r formRow) holds(words string) bool {
	return wrappedAs(append([]string{r.text}, r.more...), words)
}

func (f formView) row(n int) formRow {
	for _, r := range f.rows {
		if r.num == n {
			return r
		}
	}
	return formRow{num: -1}
}

func (f formView) has(n int) bool { return f.row(n).num == n }

var (
	formRule = regexp.MustCompile(`^\s*[─━]{8,}\s*$`)
	// A row is "❯ 1." or "  1.": a question's own "1." lines start at the
	// edge, or after its "│".
	formRowRe = regexp.MustCompile(`^(?:(❯)|[\s\x{a0}])[\s\x{a0}](\d{1,2})\.[\s\x{a0}]+(.*?)\s*$`)
	// A question of several lines is drawn behind a bar (Claude Code 2.1.3).
	formGutter = regexp.MustCompile(`^\s*│\s?`)
	formNext   = regexp.MustCompile(`^\s*(❯)?[\s\x{a0}]*(Next|Submit)\s*$`)
	formBox    = regexp.MustCompile(`^\[([^\]])\]\s*(.*)$`)
	formEnd    = regexp.MustCompile(`^(❯\s*)?\d\.\s+Cancel$`)
)

// readForm reads the form at the foot of a screen. It sits under its tab
// row ("←  ☐ Colour  ☐ Toppings  ✔ Submit  →", or a single "☐ Drink"),
// and ends in its key hints, or the review's "2. Cancel".
func readForm(sc string) formView {
	f := formView{cursor: -1}
	lines := strings.Split(strings.TrimRight(sc, " \n\t"), "\n")
	for i := range lines {
		lines[i] = strings.TrimRight(lines[i], " \t ")
	}
	end := -1
	for i, seen := len(lines)-1, 0; i >= 0 && seen < 6; i-- {
		l := strings.TrimSpace(lines[i])
		if l == "" {
			continue
		}
		seen++
		if strings.Contains(l, "Enter to select") || strings.Contains(l, "Esc to cancel") || formEnd.MatchString(l) {
			end = i
			break
		}
	}
	if end < 0 {
		return f
	}
	tabs := -1
	for i := end; i >= 0; i-- {
		l := strings.TrimSpace(lines[i])
		if (strings.HasPrefix(l, "←") || strings.HasPrefix(l, "☐") || strings.HasPrefix(l, "☒")) && strings.ContainsAny(l, "☐☒") {
			tabs = i
			break
		}
	}
	if tabs < 0 {
		return f
	}
	region := lines[tabs+1 : end+1]
	f.ok = true
	for i, l := range region {
		if strings.TrimSpace(l) == "Review your answers" {
			f.review = true
			var text []string
			for _, x := range region[i+1:] {
				if strings.HasPrefix(strings.TrimSpace(x), "Ready to submit") {
					break
				}
				text = append(text, x)
			}
			f.reviewText = flatText(strings.Join(text, "\n"))
			for _, l := range text {
				if l = flatText(l); l != "" {
					f.reviewLines = append(f.reviewLines, l)
				}
			}
			region = region[i+1:]
			break
		}
	}
	var words []string
	for _, l := range region {
		if formRule.MatchString(l) {
			if len(f.rows) == 0 && !f.review {
				// A rule before any option: these tabs are an older
				// frame's, above something else.
				return formView{cursor: -1}
			}
			break // what follows ("Chat about this") isn't an answer
		}
		if m := formNext.FindStringSubmatch(l); m != nil && !f.review {
			f.rows = append(f.rows, formRow{num: 0, text: m[2]})
			if m[1] != "" {
				f.cursor = 0
			}
			continue
		}
		m := formRowRe.FindStringSubmatch(l)
		if m == nil {
			switch {
			case len(f.rows) > 0:
				if r := &f.rows[len(f.rows)-1]; r.num > 0 && strings.TrimSpace(l) != "" {
					r.more = append(r.more, strings.TrimSpace(l))
				}
			case !f.review:
				words = append(words, formGutter.ReplaceAllString(l, ""))
			}
			continue
		}
		n, _ := strconv.Atoi(m[2])
		r := formRow{num: n, text: m[3]}
		if b := formBox.FindStringSubmatch(r.text); b != nil {
			r.box, r.checked, r.text = true, strings.TrimSpace(b[1]) != "", b[2]
		}
		f.rows = append(f.rows, r)
		if m[1] != "" {
			f.cursor = n
		}
	}
	f.question = flatText(strings.Join(words, "\n"))
	return f
}

// flatText is words on one line: a form wraps long ones.
func flatText(s string) string { return strings.Join(strings.Fields(s), " ") }

// A form wraps words at a space where it can, and inside a word too long
// for a line (an attached file's path) where it can't: read back, a line
// break is a space or nothing, and only there may the two differ.

// wrappedAs says lines are words, wrapped.
func wrappedAs(lines []string, words string) bool {
	return wrapRe(words, true).MatchString(strings.Join(flatLines(lines), "\n"))
}

// wrapsWith says lines hold words somewhere, wrapped.
func wrapsWith(lines []string, words string) bool {
	return wrapRe(words, false).MatchString(strings.Join(flatLines(lines), "\n"))
}

func flatLines(lines []string) []string {
	var out []string
	for _, l := range lines {
		if l = flatText(l); l != "" {
			out = append(out, l)
		}
	}
	return out
}

// wrapRe matches words with a line break for any space, or between any
// two of their letters.
func wrapRe(words string, whole bool) *regexp.Regexp {
	var b strings.Builder
	for i, r := range []rune(flatText(words)) {
		switch {
		case r == ' ':
			b.WriteString(`[ \n]`)
			continue
		case i > 0:
			b.WriteString(`\n?`)
		}
		b.WriteString(regexp.QuoteMeta(string(r)))
	}
	if whole {
		return regexp.MustCompile(`^` + b.String() + `$`)
	}
	return regexp.MustCompile(b.String())
}

// questionIndex is which question the form shows, by its words, or -1.
func questionIndex(qs []transcript.Question, shown string) int {
	if shown == "" {
		return -1
	}
	for i, q := range qs {
		want := flatText(q.Question)
		if want == shown || (len(shown) >= 12 && strings.HasPrefix(want, shown)) || (len(want) >= 12 && strings.HasPrefix(shown, want)) {
			return i
		}
	}
	return -1
}

// sameLabel says a row reads as an option: a long one is cut or wraps.
func sameLabel(row, label string) bool {
	row, label = flatText(strings.TrimSuffix(row, "…")), flatText(label)
	return row == label || (len(row) >= 6 && strings.HasPrefix(label, row))
}

// ownWordsEmpty is the "Type something" row before anything is typed.
func ownWordsEmpty(s string) bool {
	s = strings.TrimSuffix(strings.TrimSpace(s), ".")
	return s == "Type something" || s == "Other"
}

func rowPos(n int) int {
	if n == 0 {
		return 1000
	}
	return n
}

func rowName(n int) string {
	if n == 0 {
		return "Next"
	}
	return strconv.Itoa(n)
}
