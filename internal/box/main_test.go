package box

import (
	"context"
	"fmt"
	"os"
	"testing"

	"github.com/cosscom/shipyard/internal/agenthost"
	"github.com/cosscom/shipyard/internal/agentpath"
)

// Rebases and merges make commits, which git refuses without an identity;
// a fresh CI machine has none.
func TestMain(m *testing.M) {
	// The structured driver's tests run this binary as `berthd agent-host`
	// (claudedriver_test.go).
	if os.Getenv("BERTH_TEST_AGENT_HOST") == "1" {
		code, err := agenthost.Main(os.Args[1:], os.Stdout)
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(2)
		}
		os.Exit(code)
	}
	// The secret stores' programs, faked (secretstore_test.go).
	if os.Getenv("BERTH_TEST_FAKE") != "" && os.Getenv("BERTH_TEST_FAKE_DIR") != "" {
		os.Exit(fakeProgram())
	}
	for k, v := range map[string]string{
		"GIT_AUTHOR_NAME": "berth test", "GIT_AUTHOR_EMAIL": "test@example.com",
		"GIT_COMMITTER_NAME": "berth test", "GIT_COMMITTER_EMAIL": "test@example.com",
	} {
		if os.Getenv(k) == "" {
			os.Setenv(k, v)
		}
	}
	// Agent CLIs are looked for on the test's PATH and HOME each time, never
	// through the developer's own shell.
	for _, k := range []string{"NVM_DIR", "FNM_DIR", "VOLTA_HOME", "BUN_INSTALL", "PNPM_HOME", "XDG_DATA_HOME"} {
		os.Unsetenv(k)
	}
	testFinder := &agentpath.Finder{NoCache: true, NoVersion: true, NoNPM: true, SystemDirs: []string{}}
	agentFinder = func() *agentpath.Finder { return testFinder }
	// Login scripts run with the test's PATH, never the developer's shell's.
	loginPATH = func(context.Context) string { return "" }
	code := m.Run()
	// The fake helper the helpers' tests built (helpers_test.go).
	removeFakeHelper()
	os.Exit(code)
}
