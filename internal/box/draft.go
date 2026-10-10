package box

import (
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf8"
)

// What an agent is writing right now, read from its screen. Claude Code
// draws a reply as it streams, but writes it to its transcript only once
// the block is complete, so the chat shows the screen's words as a draft
// until the transcript has them (app: lib/draft.ts).
//
// GET /v1/sessions/{name}/draft reads the pane with its styles (tmux
// capture-pane -e) and answers with the reply being written, as Markdown,
// and the agent's status line. It is read here rather than from /screen's
// plain text because the styles carry what plain text loses: Claude Code
// draws its own chrome (hints, tool calls and their output) in grey and a
// reply in the terminal's own colour; a text block's ⏺ in the foreground
// and a tool call's in grey (blinking, so often only a grey blank shows);
// and Markdown as styles (bold, a colour for `code`, OSC 8 links).
//
// Only Claude Code is read. Codex draws its reply differently and isn't
// drafted: its chat shows the record's words as they land.

// Draft is a session's reply in progress.
type Draft struct {
	Agent string `json:"agent"`
	// Text is the reply being written, as Markdown: empty while the agent
	// thinks, runs a tool, or rests.
	Text string `json:"text,omitempty"`
	// Clipped: the reply began above the top of the screen, so Text is its
	// end.
	Clipped bool `json:"clipped,omitempty"`
	// Status is the agent's status line while it works.
	Status *DraftStatus `json:"status,omitempty"`
}

// DraftStatus is Claude Code's status line: "✻ Seasoning… (9m 11s · ↓ 7.1k
// tokens)".
type DraftStatus struct {
	Word    string `json:"word"`
	Elapsed string `json:"elapsed,omitempty"`
	Tokens  string `json:"tokens,omitempty"`
}

func (b *Box) draft(w http.ResponseWriter, r *http.Request) error {
	// The session and its styled screen in one tmux command: a working
	// chat polls this every second or so.
	sess, raw, err := b.Sessions.getAndCapture(r.Context(), r.PathValue("name"), "-J", "-e")
	if err != nil && sess.Name == "" {
		return err
	}
	agent := firstNonEmpty(sess.Preset, firstNonEmpty(sess.Agent, agentOf(sess.Command)))
	out := Draft{Agent: agent}
	if agent == "claude" && sess.Service == "" && !sess.Exited {
		if err != nil {
			return err
		}
		out = ParseClaudeDraft(string(raw))
		out.Agent = agent
	}
	writeJSON(w, out)
	return nil
}

// maxDraft bounds the text sent: a screen holds far less.
const maxDraft = 32 << 10

// ParseClaudeDraft reads Claude Code's screen, with its styles, for the
// reply it is writing.
//
// Claude Code draws a block per step, each led at the margin by ⏺ (● on
// Linux), with its words indented under it; a tool call's lines are grey.
// Under the last block are its status line, hints and its prompt box. So
// the reply is the last block when that block is words: from the prompt
// box up past the status line and hints, then up through indented lines
// to the block's ⏺. A grey line on the way (a tool's output or summary)
// or another line at the margin (a prompt) means the last block isn't
// words. Reaching the top of the screen means the reply is taller than
// it: its end is what shows (Clipped).
func ParseClaudeDraft(raw string) Draft {
	lines := parseStyled(raw)
	for len(lines) > 0 && lines[len(lines)-1].blank() {
		lines = lines[:len(lines)-1]
	}
	var d Draft
	// The prompt box: a rule at the margin with the prompt under it.
	end := -1
	for i := len(lines) - 2; i >= 0; i-- {
		if lines[i].rule() && lines[i].indent() == 0 && promptLine.MatchString(lines[i+1].plain) {
			end = i
			break
		}
	}
	if end < 0 {
		return d
	}
	i, st := footTop(lines, end)
	if st != nil {
		d.Status = st
	}
	var body []styledLine
	for ; i >= 0; i-- {
		l := lines[i]
		switch m := l.marker(); {
		case l.blank():
			body = append(body, l)
		case m != markNone:
			// The block's first line.
			if m == markTool || toolHeader.MatchString(l.textAfterMarker()) || notWords.MatchString(l.textAfterMarker()) || elbowFirst(body) {
				return d
			}
			body = append(body, l.withoutMarker())
			d.Text = draftMarkdown(reverse(body))
			return d
		case l.indent() == 0:
			// A rule at the margin tops a dialog drawn over the reply
			// ("Teach auto mode…"): what was read is the dialog's, and the
			// reply, if any, is above it.
			if l.rule() {
				var st *DraftStatus
				i, st = footTop(lines, i)
				i++
				if st != nil && d.Status == nil {
					d.Status = st
				}
				body = body[:0]
				continue
			}
			// A prompt, a past turn's last line, the logo: no reply.
			return d
		case l.chrome() && !l.quoteBar():
			// A tool call's output or summary: the last block isn't words.
			return d
		default:
			body = append(body, l)
		}
	}
	if strings.TrimSpace(plainOf(body)) != "" && !elbowFirst(body) {
		d.Text = draftMarkdown(reverse(body))
		d.Clipped = d.Text != ""
	}
	return d
}

// footTop walks up from the line above end (the prompt box or a dialog's
// rule) past what Claude Code draws under its last block, and returns the
// index of the first line above it and the status line, if one shows.
//
// With a status line, everything under it is foot (hints, "⎿ Tip:",
// notices). Without one (it hides while words stream) only a few hint
// lines are: blank, grey (not a tool's "⎿"), or far to the right.
func footTop(lines []styledLine, end int) (int, *DraftStatus) {
	for i := end - 1; i >= 0 && i >= end-12; i-- {
		l := lines[i]
		if st, ok := claudeStatus(l); ok {
			return i - 1, st
		}
		if l.marker() != markNone || (l.indent() == 0 && !l.blank()) {
			break
		}
	}
	i := end - 1
	for skipped := 0; i >= 0; i-- {
		l := lines[i]
		if l.blank() {
			continue
		}
		hint := l.indent() > 0 && l.marker() == markNone && ((l.chrome() && !strings.HasPrefix(strings.TrimSpace(l.plain), "⎿")) || l.indent() >= 20)
		if !hint || skipped >= 4 {
			break
		}
		skipped++
	}
	return i, nil
}

var (
	// The prompt box's input line: "❯ " (no-break space in 2.1), "> ".
	promptLine = regexp.MustCompile(`^[❯>](\s|\x{a0}|$)`)
	// A tool call's first line, not words: "Bash(yarn test)",
	// "Update(src/a.ts)".
	toolHeader = regexp.MustCompile(`^[A-Z][A-Za-z0-9_]*\(`)
	// Claude Code's own notes where words would be.
	notWords = regexp.MustCompile(`^(Background command|Interrupted|API Error|No response requested)`)
	// Its status line while it works: "✻ Seasoning… (9m 11s · ↓ 7.1k
	// tokens · esc to interrupt)", "✻ Proofing…"; and once a turn ends,
	// "✻ Worked for 10s".
	statusLine = regexp.MustCompile(`^[✻✽✶✳✢·*✦]\s+([A-Z][\w' -]{0,40}?…)\s*(?:\(([^)]*)\))?`)
	doneLine   = regexp.MustCompile(`^[✻✽✶✳✢·*✦]\s+[A-Z][\w' -]{0,40} for \d`)
	elapsedRe  = regexp.MustCompile(`(?:\d+h\s*)?(?:\d+m\s*)?\d+s`)
	tokensRe   = regexp.MustCompile(`[\d.]+k?\s*tokens`)
)

func claudeStatus(l styledLine) (*DraftStatus, bool) {
	if doneLine.MatchString(l.plain) {
		return nil, true
	}
	m := statusLine.FindStringSubmatch(l.plain)
	if m == nil {
		return nil, false
	}
	return &DraftStatus{Word: strings.TrimSpace(m[1]), Elapsed: elapsedRe.FindString(m[2]), Tokens: tokensRe.FindString(m[2])}, true
}

// elbowFirst says the block's first line (body is bottom-up) is a tool's
// result, "⎿ …", drawn under a tool call.
func elbowFirst(body []styledLine) bool {
	for i := len(body) - 1; i >= 0; i-- {
		if !body[i].blank() {
			return strings.HasPrefix(strings.TrimSpace(body[i].plain), "⎿")
		}
	}
	return false
}

func reverse(ls []styledLine) []styledLine {
	out := make([]styledLine, len(ls))
	for i, l := range ls {
		out[len(ls)-1-i] = l
	}
	return out
}

func plainOf(ls []styledLine) string {
	var b strings.Builder
	for _, l := range ls {
		b.WriteString(l.plain)
		b.WriteByte('\n')
	}
	return b.String()
}

// ---- styled lines -------------------------------------------------------

// style is the SGR state a run of text is drawn in. fg is -1 for the
// terminal's own colour, else a 256-colour index (basic colours 0–15).
type style struct {
	fg                               int
	bold, dim, italic, underline, bg bool
	link                             string
}

type span struct {
	text string
	st   style
}

type styledLine struct {
	spans []span
	plain string
}

// parseStyled splits capture-pane -e output into lines of styled runs. The
// state carries from line to line, as tmux writes it.
func parseStyled(raw string) []styledLine {
	st := style{fg: -1}
	var out []styledLine
	for _, l := range strings.Split(raw, "\n") {
		out = append(out, parseStyledLine(l, &st))
	}
	return out
}

func parseStyledLine(s string, st *style) styledLine {
	var spans []span
	var b strings.Builder
	flush := func() {
		if b.Len() > 0 {
			spans = append(spans, span{b.String(), *st})
			b.Reset()
		}
	}
	for i := 0; i < len(s); {
		c := s[i]
		if c == 0x1b && i+1 < len(s) {
			switch s[i+1] {
			case '[':
				j := i + 2
				for j < len(s) && (s[j] < 0x40 || s[j] > 0x7e) {
					j++
				}
				if j >= len(s) {
					i = len(s)
					continue
				}
				if s[j] == 'm' {
					flush()
					st.apply(s[i+2 : j])
				}
				i = j + 1
			case ']':
				// OSC, to BEL or ESC \: only links (OSC 8) matter.
				end, next := -1, len(s)
				for k := i + 2; k < len(s); k++ {
					if s[k] == 0x07 {
						end, next = k, k+1
						break
					}
					if s[k] == 0x1b && k+1 < len(s) && s[k+1] == '\\' {
						end, next = k, k+2
						break
					}
				}
				if end > 0 {
					if body := s[i+2 : end]; strings.HasPrefix(body, "8;") {
						flush()
						if p := strings.SplitN(body, ";", 3); len(p) == 3 {
							st.link = p[2]
						}
					}
				}
				i = next
			default:
				i += 2
			}
			continue
		}
		if c != '\r' {
			b.WriteByte(c)
		}
		i++
	}
	flush()
	var plain strings.Builder
	for _, sp := range spans {
		plain.WriteString(sp.text)
	}
	return styledLine{spans: spans, plain: strings.TrimRight(plain.String(), "  ")}
}

func (st *style) apply(p string) {
	if p == "" {
		p = "0"
	}
	ps := strings.FieldsFunc(p, func(r rune) bool { return r == ';' || r == ':' })
	num := func(i int) int {
		if i >= len(ps) {
			return 0
		}
		n, _ := strconv.Atoi(ps[i])
		return n
	}
	for i := 0; i < len(ps); i++ {
		switch n := num(i); {
		case n == 0:
			*st = style{fg: -1, link: st.link}
		case n == 1:
			st.bold = true
		case n == 2:
			st.dim = true
		case n == 3:
			st.italic = true
		case n == 4:
			st.underline = true
		case n == 22:
			st.bold, st.dim = false, false
		case n == 23:
			st.italic = false
		case n == 24:
			st.underline = false
		case n >= 30 && n <= 37:
			st.fg = n - 30
		case n >= 90 && n <= 97:
			st.fg = n - 90 + 8
		case n == 39:
			st.fg = -1
		case n == 38 && num(i+1) == 5:
			st.fg = num(i + 2)
			i += 2
		case n == 38 && num(i+1) == 2:
			st.fg = rgbIndex(num(i+2), num(i+3), num(i+4))
			i += 4
		case n == 48 && num(i+1) == 5:
			st.bg = true
			i += 2
		case n == 48 && num(i+1) == 2:
			st.bg = true
			i += 4
		case (n >= 40 && n <= 47) || (n >= 100 && n <= 107):
			st.bg = true
		case n == 49:
			st.bg = false
		}
	}
}

// rgbIndex places a 24-bit colour where the rules below can read it: a
// grey as the grey ramp's middle, white and black as themselves, anything
// else as a colour.
func rgbIndex(r, g, b int) int {
	hi, lo := max(r, g, b), min(r, g, b)
	switch {
	case hi-lo > 24:
		return 300
	case hi >= 215:
		return 231
	case hi <= 40:
		return 16
	}
	return 244
}

// grey is a colour Claude Code draws its chrome in.
func grey(fg int) bool {
	return fg == 8 || (fg >= 232 && fg <= 255) || fg == 59 || fg == 102 || fg == 145 || fg == 188
}

// neutral is the foreground: the terminal's own, white or black.
func neutral(fg int) bool {
	return fg == -1 || fg == 231 || fg == 15 || fg == 7 || fg == 16 || fg == 0
}

func (st style) faint() bool { return st.dim || grey(st.fg) }

// syntax: a basic colour a code block's highlighting uses.
func (st style) syntax() bool {
	return st.fg >= 1 && st.fg <= 14 && st.fg != 7 && st.fg != 8 && st.link == ""
}

// inlineCode: the colour Claude Code gives `code` in words.
func (st style) inlineCode() bool {
	return st.fg >= 16 && !neutral(st.fg) && !grey(st.fg) && st.link == "" && !st.dim
}

func (l styledLine) blank() bool { return strings.Trim(l.plain, "  ") == "" }

func (l styledLine) indent() int {
	n := 0
	for _, r := range l.plain {
		if r != ' ' && r != ' ' {
			break
		}
		n++
	}
	return n
}

// rule: a line of ─ alone.
func (l styledLine) rule() bool {
	t := strings.TrimSpace(l.plain)
	return utf8.RuneCountInString(t) >= 8 && strings.Trim(t, "─━") == ""
}

// chrome: every character drawn is grey or dim.
func (l styledLine) chrome() bool {
	seen := false
	for _, sp := range l.spans {
		if strings.Trim(sp.text, "  ") == "" {
			continue
		}
		if !sp.st.faint() {
			return false
		}
		seen = true
	}
	return seen
}

// quoteBar: a quote's empty line, "▎" alone (dim, yet words).
func (l styledLine) quoteBar() bool { return strings.TrimSpace(l.plain) == "▎" }

type mark int

const (
	markNone mark = iota
	markText
	markTool
)

// marker reads the margin: a block's ⏺ (● on Linux) in the foreground is
// words; in grey or a colour it is a tool call (green or red once done);
// a styled blank there is a tool call's ⏺ between blinks.
func (l styledLine) marker() mark {
	if len(l.spans) == 0 {
		return markNone
	}
	r, _ := utf8.DecodeRuneInString(l.plain)
	first := l.spans[0]
	for _, sp := range l.spans {
		if sp.text != "" {
			first = sp
			break
		}
	}
	switch {
	case r == '⏺' || r == '●':
		if neutral(first.st.fg) && !first.st.dim {
			return markText
		}
		return markTool
	case first.text == " " && first.st.fg != -1 && !l.blank():
		return markTool
	}
	return markNone
}

func (l styledLine) textAfterMarker() string {
	_, n := utf8.DecodeRuneInString(l.plain)
	return strings.TrimSpace(l.plain[n:])
}

// withoutMarker is the block's first line as a line under it: the ⏺ and
// its space become the indent words have.
func (l styledLine) withoutMarker() styledLine {
	out := styledLine{plain: "  " + strings.TrimLeft(l.plain[utf8.RuneLen([]rune(l.plain)[0]):], "  ")}
	dropped := 0
	for _, sp := range l.spans {
		t := sp.text
		if dropped == 0 {
			if t == "" {
				continue
			}
			_, n := utf8.DecodeRuneInString(t)
			t = t[n:]
			dropped = 1
		}
		if dropped == 1 {
			t = strings.TrimLeft(t, "  ")
			if t == "" {
				continue
			}
			dropped = 2
		}
		out.spans = append(out.spans, span{t, sp.st})
	}
	out.spans = append([]span{{"  ", style{fg: -1}}}, out.spans...)
	return out
}

// ---- Markdown -----------------------------------------------------------

// draftMarkdown turns a block's lines, as Claude Code draws them, back into
// Markdown near enough to what it wrote: a heading is a line in bold
// (underlined too for the first level), a list item its marker with the
// lines hung under it, a quote "▎", a table box-drawn, a code block lines
// in syntax colours (or indented unevenly). Words the terminal wrapped are
// joined again: in a paragraph or a list item every line break is one (a
// single line break in Markdown reads as a space, so joining is exact),
// while a code block keeps its lines as drawn.
func draftMarkdown(lines []styledLine) string {
	// Words sit two columns in, under the ⏺.
	base := -1
	for _, l := range lines {
		if !l.blank() && (base < 0 || l.indent() < base) {
			base = l.indent()
		}
	}
	if base < 0 {
		return ""
	}
	var rows []row
	for _, l := range lines {
		rows = append(rows, classify(trimCols(l, base)))
	}
	// Groups: runs of lines between blank lines.
	var out []string
	codeOpen := false
	var pendingBlank int
	for i := 0; i < len(rows); {
		if rows[i].kind == kBlank {
			pendingBlank++
			i++
			continue
		}
		j := i
		for j < len(rows) && rows[j].kind != kBlank {
			j++
		}
		group := rows[i:j]
		if isCode(group) {
			if codeOpen {
				// Code split only by blank lines is one block.
				for ; pendingBlank > 0; pendingBlank-- {
					out = append(out, "")
				}
			} else {
				if len(out) > 0 {
					out = append(out, "")
				}
				out = append(out, "```")
				codeOpen = true
			}
			for _, r := range group {
				out = append(out, strings.Repeat(" ", r.indent)+strings.TrimLeft(r.line.plain, " "))
			}
		} else {
			if codeOpen {
				out = append(out, "```")
				codeOpen = false
			}
			if len(out) > 0 {
				out = append(out, "")
			}
			out = append(out, groupMarkdown(group)...)
		}
		pendingBlank = 0
		i = j
	}
	if codeOpen {
		out = append(out, "```")
	}
	text := strings.TrimSpace(strings.Join(out, "\n"))
	// A list item just begun ("-" alone) isn't anything yet.
	if k := strings.LastIndexByte(text, '\n'); k >= 0 && listOnly.MatchString(text[k+1:]) {
		text = strings.TrimRight(text[:k], "\n")
	} else if listOnly.MatchString(text) {
		text = ""
	}
	if len(text) > maxDraft {
		text = text[len(text)-maxDraft:]
	}
	return text
}

var (
	listOnly   = regexp.MustCompile(`^\s*([-*•]|\d+[.)])\s*$`)
	listItemRe = regexp.MustCompile(`^([-*•◦▪]|\d+[.)])\s+`)
	numbered   = regexp.MustCompile(`^\d`)
)

type rowKind int

const (
	kBlank rowKind = iota
	kProse
	kHeading
	kList
	kQuote
	kTable
	kRule
	kCode
)

type row struct {
	kind   rowKind
	indent int
	line   styledLine
	level  int    // a heading's
	marker string // a list item's
}

func classify(l styledLine) row {
	r := row{indent: l.indent(), line: l}
	t := strings.TrimSpace(l.plain)
	switch {
	case l.blank():
		r.kind = kBlank
	case strings.HasPrefix(t, "▎"):
		r.kind = kQuote
	case strings.ContainsRune("┌│├└╭╰┬┴┼", []rune(t)[0]):
		r.kind = kTable
	case l.rule():
		r.kind = kRule
	case l.hasSyntax():
		r.kind = kCode
	case listItemRe.MatchString(t):
		r.kind = kList
		m := listItemRe.FindStringSubmatch(t)
		r.marker = m[1]
	case r.indent == 0 && l.allBold() && !strings.HasSuffix(t, ":"):
		r.kind = kHeading
		r.level = 2
		if l.allUnderlined() {
			r.level = 1
		}
	default:
		r.kind = kProse
	}
	return r
}

func (l styledLine) hasSyntax() bool {
	for _, sp := range l.spans {
		if strings.TrimSpace(sp.text) != "" && sp.st.syntax() {
			return true
		}
	}
	return false
}

func (l styledLine) allBold() bool {
	seen := false
	for _, sp := range l.spans {
		if strings.TrimSpace(sp.text) == "" {
			continue
		}
		if !sp.st.bold {
			return false
		}
		seen = true
	}
	return seen
}

func (l styledLine) allUnderlined() bool {
	for _, sp := range l.spans {
		if strings.TrimSpace(sp.text) != "" && !sp.st.underline {
			return false
		}
	}
	return true
}

// isCode: a group drawn in syntax colours, or one whose lines are indented
// unevenly with nothing else to explain it (code with no colours).
func isCode(group []row) bool {
	uneven := false
	for _, r := range group {
		switch r.kind {
		case kCode:
			return true
		case kList, kQuote, kTable, kHeading, kRule:
			return false
		}
		if r.indent != group[0].indent {
			uneven = true
		}
	}
	return uneven && len(group) > 1
}

func groupMarkdown(group []row) []string {
	var out []string
	// The open list item, paragraph or quote that a wrapped line joins: a
	// list item's lines hang under its words, deeper than its marker.
	open := -1
	openIndent := 0
	openList := false
	inTable := false
	var table [][]string
	header := false
	flushTable := func() {
		if !inTable {
			return
		}
		out = append(out, tableMarkdown(table, header)...)
		table, header, inTable = nil, false, false
	}
	for _, r := range group {
		if r.kind != kTable {
			flushTable()
		}
		switch r.kind {
		case kTable:
			if !inTable {
				inTable, open = true, -1
			}
			t := strings.TrimSpace(r.line.plain)
			switch {
			case strings.HasPrefix(t, "│"):
				cells := strings.Split(strings.Trim(t, "│"), "│")
				for i := range cells {
					cells[i] = strings.TrimSpace(cells[i])
				}
				// A row's cells wrapped onto more lines join their row.
				if n := len(table); n > 0 && table[n-1] != nil && len(table[n-1]) == len(cells) && !rowClosed(table) {
					for i, c := range cells {
						if c != "" {
							table[n-1][i] = strings.TrimSpace(table[n-1][i] + " " + c)
						}
					}
				} else {
					table = append(table, cells)
				}
			case strings.HasPrefix(t, "├") || strings.HasPrefix(t, "╞"):
				if len(table) == 1 {
					header = true
				}
				table = append(table, nil) // a border closes the row above
			}
		case kHeading:
			out = append(out, strings.Repeat("#", r.level)+" "+strings.TrimSpace(inline(r.line.spans, true)))
			open = -1
		case kRule:
			out = append(out, "---")
			open = -1
		case kQuote:
			text := strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(r.line.plain), "▎"))
			if text == "" {
				out = append(out, ">")
				open = -1
				continue
			}
			// Claude Code draws a quote in italics of its own.
			md := inline(unitalic(dropQuoteBar(r.line.spans)), false)
			md = strings.TrimSpace(md)
			if open >= 0 && strings.HasPrefix(out[open], "> ") {
				out[open] += " " + md
			} else {
				out = append(out, "> "+md)
				open, openIndent, openList = len(out)-1, r.indent, false
			}
		case kList:
			m := listItemRe.FindStringIndex(strings.TrimLeft(r.line.plain, " "))
			rest := dropCols(r.line, r.indent+m[1])
			marker := r.marker
			if !numbered.MatchString(marker) {
				marker = "-"
			}
			out = append(out, strings.Repeat(" ", r.indent)+marker+" "+strings.TrimSpace(inline(rest.spans, false)))
			open, openIndent, openList = len(out)-1, r.indent, true
		default:
			md := strings.TrimSpace(inline(trimCols(r.line, r.indent).spans, false))
			if open >= 0 && (r.indent > openIndent || (!openList && r.indent == openIndent)) && !strings.HasPrefix(out[open], ">") {
				out[open] += " " + md
			} else {
				out = append(out, md)
				open, openIndent, openList = len(out)-1, r.indent, false
			}
		}
	}
	flushTable()
	return out
}

func rowClosed(table [][]string) bool { return table[len(table)-1] == nil }

func tableMarkdown(table [][]string, header bool) []string {
	var rows [][]string
	for _, r := range table {
		if r != nil {
			rows = append(rows, r)
		}
	}
	if len(rows) == 0 {
		return nil
	}
	line := func(cells []string) string {
		for i := range cells {
			cells[i] = strings.ReplaceAll(cells[i], "|", `\|`)
		}
		return "| " + strings.Join(cells, " | ") + " |"
	}
	out := []string{line(rows[0])}
	// Markdown needs a header row; a table drawn without one gets an empty one.
	sep := "|" + strings.Repeat("---|", len(rows[0]))
	if header || len(rows) > 1 {
		out = append(out, sep)
	}
	for _, r := range rows[1:] {
		out = append(out, line(r))
	}
	return out
}

func dropQuoteBar(spans []span) []span {
	var out []span
	dropped := false
	for _, sp := range spans {
		if !dropped {
			if i := strings.Index(sp.text, "▎"); i >= 0 {
				t := strings.TrimLeft(sp.text[i+len("▎"):], " ")
				dropped = true
				if t != "" {
					out = append(out, span{t, sp.st})
				}
				continue
			}
			if strings.TrimSpace(sp.text) == "" {
				continue
			}
		}
		out = append(out, sp)
	}
	return out
}

// dropCols drops a line's first n characters, whatever they are (a list
// item's indent and marker), keeping its styles.
func dropCols(l styledLine, n int) styledLine {
	var out styledLine
	left := n
	for _, sp := range l.spans {
		t := sp.text
		for left > 0 && t != "" {
			_, w := utf8.DecodeRuneInString(t)
			t = t[w:]
			left--
		}
		if t != "" {
			out.spans = append(out.spans, span{t, sp.st})
		}
	}
	for _, sp := range out.spans {
		out.plain += sp.text
	}
	return out
}

func unitalic(spans []span) []span {
	out := make([]span, len(spans))
	for i, sp := range spans {
		sp.st.italic = false
		out[i] = sp
	}
	return out
}

// trimCols drops a line's first n columns (spaces), keeping its styles.
func trimCols(l styledLine, n int) styledLine {
	out := styledLine{plain: l.plain}
	for i := 0; i < n && len(out.plain) > 0 && (out.plain[0] == ' '); i++ {
		out.plain = out.plain[1:]
	}
	left := n
	for _, sp := range l.spans {
		t := sp.text
		for left > 0 && len(t) > 0 && t[0] == ' ' {
			t = t[1:]
			left--
		}
		if left > 0 && t == "" {
			continue
		}
		left = 0
		if t != "" {
			out.spans = append(out.spans, span{t, sp.st})
		}
	}
	return out
}

// inline writes a line's runs as Markdown: bold, italics, `code` and
// links, with the rest escaped. A heading's own bold is its level, not
// emphasis.
func inline(spans []span, heading bool) string {
	type piece struct {
		text               string
		bold, italic, code bool
		link               string
	}
	var ps []piece
	for _, sp := range spans {
		p := piece{text: sp.text, link: sp.st.link}
		if p.link == "" {
			p.code = sp.st.inlineCode()
			p.bold = sp.st.bold && !heading && !p.code
			p.italic = sp.st.italic && !heading && !p.code
		}
		// Runs drawn alike join, so "**a** **b**" doesn't become "**a****b**".
		if n := len(ps); n > 0 && ps[n-1].bold == p.bold && ps[n-1].italic == p.italic && ps[n-1].code == p.code && ps[n-1].link == p.link {
			ps[n-1].text += p.text
			continue
		}
		ps = append(ps, p)
	}
	var b strings.Builder
	for _, p := range ps {
		core := strings.Trim(p.text, " ")
		if core == "" {
			b.WriteString(p.text)
			continue
		}
		lead := p.text[:strings.Index(p.text, core)]
		trail := p.text[len(lead)+len(core):]
		b.WriteString(lead)
		switch {
		case p.link != "":
			b.WriteString("[" + escapeMD(core) + "](" + p.link + ")")
		case p.code:
			tick := "`"
			if strings.Contains(core, "`") {
				tick = "``"
			}
			b.WriteString(tick + core + tick)
		case p.bold && p.italic:
			b.WriteString("***" + escapeMD(core) + "***")
		case p.bold:
			b.WriteString("**" + escapeMD(core) + "**")
		case p.italic:
			b.WriteString("*" + escapeMD(core) + "*")
		default:
			b.WriteString(escapeMD(core))
		}
		b.WriteString(trail)
	}
	return b.String()
}

var mdSpecial = strings.NewReplacer(`\`, `\\`, "*", `\*`, "`", "\\`", "[", `\[`, "]", `\]`, "<", `\<`, "_", `\_`)

func escapeMD(s string) string { return mdSpecial.Replace(s) }
