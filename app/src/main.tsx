import React from "react";
import ReactDOM from "react-dom/client";

import App from "@/App";
import { ErrorBoundary } from "@/components/error-boundary";
import { showingTabRescues } from "@/components/workspace/pane-guard";
// Error toasts in plain English, with the box's own words behind Details.
import "@/components/error-note";
import { isTauri } from "@/lib/api";
import { openUrl } from "@/lib/open-url";
// Says once when terminals fall back to xterm.js, and why.
import "@/lib/terminal-health";
// The Mac app's see-through sidebar, before the first paint.
import "@/lib/vibrancy";
import { installGlobals } from "@/plugins/host";
import "@/index.css";

// Plugins resolve React and the SDK through globals; set them before any
// plugin can load.
installGlobals();

// Links clicked in a terminal open with window.open; in the app that would
// navigate the webview, so send them to the system browser instead.
if (isTauri()) {
  window.open = (url?: string | URL) => {
    if (url) void openUrl(String(url));
    return null;
  };
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    {/* The last guard: what broke was most likely the tab showing, so its
        ways out are offered here too, rather than a window with no way on. */}
    <ErrorBoundary window rescues={showingTabRescues}>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
