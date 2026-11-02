package box

import (
	"errors"
	"net/http"
	"strings"
)

// Every error the box answers with is {"error": "...", "code": "..."}. The
// message is for people and logs; the code is what clients branch on, so an
// app can say what happened in its own words and offer the one thing that
// helps (start the agent again, update the box) without reading the text.
//
// Codes:
//
//	not_found        no such session, worktree, location, share, …
//	session_exited   the session's program has ended; it takes no input
//	session_exists   a session with that name is already running
//	agent_waiting    the agent waits for an answer; sending would pick one
//	refused          a before: hook (or the box's own rules) said no
//	unsupported      this box doesn't have that feature
//	tmux_missing     tmux is not installed on the box
//	browser_blocked  the box's browser can't start its sandbox (browsersandbox.go)
//	git_failed       git refused; the message carries git's words
//	command_failed   a program the box ran failed
//	agent_failed     an agent started again exited as it started (409); the
//	                 message carries what it wrote to its stderr
//	too_many         slow down and try again
//	file_changed     a write named a version of the file that is no longer
//	                 there (412); the answer carries the file as it is now
//	moved            a pull request's head is not the commit confirmed
//	dirty            a worktree has uncommitted changes, so it was left
//	helper_off       a plugin's helper is not running, so nothing answers (409)
//	helper_invalid   a helper's spec or its plugin's id is not one the box takes
//	helper_mismatch  an uploaded helper is not the size and SHA-256 named
//	helper_missing   the box does not hold the helper it was asked to start (409)
//	helper_unreachable  a running helper did not answer (502)
//	helper_no_attach  a helper that is not told of worktrees was asked to be (409)
//	bad_request      the request itself was wrong
//	internal         anything else
const (
	CodeNotFound      = "not_found"
	CodeSessionExited = "session_exited"
	CodeSessionExists = "session_exists"
	CodeAgentWaiting  = "agent_waiting"
	CodeRefused       = "refused"
	CodeUnsupported   = "unsupported"
	CodeTmuxMissing   = "tmux_missing"
	CodeBrowserBlock  = "browser_blocked"
	CodeGitFailed     = "git_failed"
	CodeCommandFailed = "command_failed"
	CodeAgentFailed   = "agent_failed"
	CodeTooMany       = "too_many"
	CodeBadRequest    = "bad_request"
	CodeInternal      = "internal"
)

// ErrSessionExited refuses to type into a session whose program has ended:
// tmux keeps the dead pane so its last output stays readable, but nothing
// reads what is typed there.
var ErrSessionExited = errors.New("the session's program has ended, so it can't take input; start it again")

// errTmuxMissing is what every tmux call says on a box without it.
var errTmuxMissing = errors.New("tmux is not installed on this box")

// codeFor names an error for clients.
func codeFor(err error) string {
	var he httpError
	var rc reviewCode
	var af agentFailed
	switch {
	case errors.As(err, &rc):
		return rc.code
	case errors.As(err, &af):
		return CodeAgentFailed
	case errors.Is(err, ErrSessionExited):
		return CodeSessionExited
	case errors.Is(err, ErrSessionExists):
		return CodeSessionExists
	case errors.Is(err, errTmuxMissing):
		return CodeTmuxMissing
	case errors.Is(err, ErrBrowserSandbox):
		return CodeBrowserBlock
	case errors.Is(err, ErrUnknownLocation), errors.Is(err, ErrUnknownWorktree), errors.Is(err, ErrUnknownSession), errors.Is(err, ErrUnknownShare), errors.Is(err, ErrUnknownUnit):
		return CodeNotFound
	case errors.As(err, &he):
		if strings.Contains(he.msg, "is waiting for someone to answer it") || strings.Contains(he.msg, "is asking whether to trust this folder") {
			return CodeAgentWaiting
		}
		return codeForStatus(he.status)
	}
	msg := err.Error()
	switch {
	case exitedPane(msg):
		return CodeSessionExited
	case strings.HasPrefix(msg, "git ") || strings.Contains(msg, "fatal: "):
		return CodeGitFailed
	case strings.HasPrefix(msg, "tmux ") || strings.HasPrefix(msg, "exec: ") || strings.Contains(msg, "exit status"):
		return CodeCommandFailed
	}
	return codeForStatus(statusFor(err))
}

func codeForStatus(status int) string {
	switch status {
	case http.StatusNotFound:
		return CodeNotFound
	case http.StatusForbidden, http.StatusUnauthorized:
		return CodeRefused
	case http.StatusNotImplemented:
		return CodeUnsupported
	case http.StatusTooManyRequests:
		return CodeTooMany
	case http.StatusBadRequest, http.StatusConflict, http.StatusMethodNotAllowed, http.StatusRequestEntityTooLarge, http.StatusPreconditionRequired, http.StatusUnsupportedMediaType:
		return CodeBadRequest
	case http.StatusPreconditionFailed:
		return CodeFileChanged
	}
	return CodeInternal
}

// exitedPane is tmux's way of saying the program in a pane has ended.
func exitedPane(msg string) bool {
	return strings.Contains(msg, "pane has exited") || strings.Contains(msg, "pane is dead")
}

// writeErr answers with err, its status and its code.
func writeErr(w http.ResponseWriter, err error) {
	writeCoded(w, statusFor(err), err.Error(), codeFor(err))
}
