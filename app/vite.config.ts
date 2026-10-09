import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const host = process.env.TAURI_DEV_HOST;

// devPlugins serves the repository's plugins/ folder at /__dev-plugins/ while
// developing, so mock mode can load a real plugin bundle without the agent.
function devPlugins(): Plugin {
  const root = path.resolve(import.meta.dirname, "../plugins");
  return {
    name: "berth-dev-plugins",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use("/__dev-plugins/", (req, res, next) => {
        const file = path.join(root, decodeURIComponent((req.url ?? "").split("?")[0]));
        if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return next();
        res.setHeader("Content-Type", file.endsWith(".json") ? "application/json" : "text/javascript");
        fs.createReadStream(file).pipe(res);
      });
    },
  };
}

// mockVdiff serves the visual-diff fixtures' images (real runs of berthd
// shots compare, e2e/fixtures/vdiff-img/) at /__mock-vdiff/ to mock mode,
// in the dev server and vite preview (the e2e suite) only: no build ships
// them.
function mockVdiff(): Plugin {
  const root = path.resolve(import.meta.dirname, "e2e/fixtures/vdiff-img");
  const serve = (req: { url?: string }, res: import("node:http").ServerResponse, next: () => void) => {
    const name = decodeURIComponent((req.url ?? "").split("?")[0]).replace(/^\//, "");
    if (!/^[0-9a-f]{16}\.png$/.test(name)) return next();
    const file = path.join(root, name);
    if (!fs.existsSync(file)) return next();
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "max-age=3600");
    fs.createReadStream(file).pipe(res);
  };
  return {
    name: "berth-mock-vdiff",
    configureServer(server) {
      server.middlewares.use("/__mock-vdiff/", serve);
    },
    configurePreviewServer(server) {
      server.middlewares.use("/__mock-vdiff/", serve);
    },
  };
}

// demoPage makes the demo build's page work from any folder (berthd.app/demo/):
// the plugin shims and the icon by relative paths, a title and no indexing,
// and a fresh demo on every load (the app's remembered layout cleared).
function demoPage(): Plugin {
  return {
    name: "berth-demo-page",
    transformIndexHtml(html) {
      return html
        .replace(/"\/shims\//g, '"./shims/')
        .replace('href="/favicon.svg"', 'href="./favicon.svg"')
        .replace("<title>Shipyard</title>", '<title>Shipyard demo</title>\n    <meta name="robots" content="noindex" />')
        .replace(
          "<script type=\"importmap\">",
          `<script>
      // Its paths are relative: /demo needs its slash to find them.
      if (!location.pathname.endsWith("/") && !location.pathname.endsWith(".html")) location.replace(location.pathname + "/" + location.search + location.hash);
      // Every visit starts the demo afresh.
      try {
        for (const k of Object.keys(localStorage)) if (k.startsWith("berth.")) localStorage.removeItem(k);
      } catch {}
    </script>
    <script type="importmap">`,
        );
    },
  };
}

// noShikiWasm: the diff renderer highlights with Shiki's JavaScript regex
// engine, so its Oniguruma engine (a 600 KB wasm chunk) is never shipped.
function noShikiWasm(): Plugin {
  return {
    name: "berth-no-shiki-wasm",
    enforce: "pre",
    resolveId: (id) => (id === "shiki/wasm" ? "\0no-shiki-wasm" : undefined),
    load: (id) => (id === "\0no-shiki-wasm" ? "export default undefined;" : undefined),
  };
}

// workerScript: the highlighting worker's script is imported for what it
// does when it runs, which its package's sideEffects list leaves out (so a
// build would drop it, leaving an empty worker).
function workerScript(): Plugin {
  return {
    name: "berth-diffs-worker-script",
    enforce: "pre",
    async resolveId(id, importer, options) {
      if (id !== "@pierre/diffs/worker/worker.js") return undefined;
      const r = await this.resolve(id, importer, { ...options, skipSelf: true });
      return r ? { ...r, moduleSideEffects: true } : undefined;
    },
  };
}

// startupChunks puts all the code the app starts with ($initial: what the
// entry imports, statically, all the way down) in two files: the libraries
// and the app's own. Left to itself the bundler cut it into some 300, as
// lazily loaded code shares much of it (lucide's icons one file each), and
// the window waited on every one of them before its first paint. Two load
// and compile side by side. What loads later is split as before.
const startupChunks = {
  groups: [
    { name: "vendor", test: /[\\/]node_modules[\\/]/, tags: ["$initial" as const] },
    { name: "startup", tags: ["$initial" as const] },
  ],
};

// commit is the checkout's short hash, which Copy diagnostics names as the
// app's build; empty outside a git checkout.
function commit(): string {
  try {
    return execSync("git rev-parse --short HEAD", { cwd: import.meta.dirname, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    return "";
  }
}

// appVersion is package.json's version, which make publish sets for each
// release, the same the Tauri shell reports; the What's new card keys on it.
function appVersion(): string {
  return JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, "package.json"), "utf8")).version;
}

// https://vite.dev/config/
//
// `vite build --mode demo` (pnpm build:demo) is the live demo on berthd.app:
// the app on its fixtures (mock mode, always), with a guide and scripted
// activity (src/demo/), nothing that needs a laptop agent or Tauri, built
// with relative paths into site/demo/.
// A second dev server (another --port) keeps its own prebundled deps: one
// cache re-bundled under a running server gives its page two copies of a
// library's internals, and Base UI's contexts stop matching.
const argPort = process.argv.includes("--port") ? process.argv[process.argv.indexOf("--port") + 1] : undefined;

export default defineConfig(({ mode }) => ({
  cacheDir: argPort && argPort !== "1420" ? `node_modules/.vite-${argPort}` : "node_modules/.vite",
  plugins: [react(), tailwindcss(), devPlugins(), mockVdiff(), noShikiWasm(), ...(mode === "demo" ? [demoPage()] : [])],
  // The diff renderer's highlighting worker loads its languages as chunks,
  // which takes a module worker.
  worker: { format: "es" as const, plugins: () => [noShikiWasm(), workerScript()] },
  define: { __BERTH_DEMO__: JSON.stringify(mode === "demo"), __BERTH_COMMIT__: JSON.stringify(commit()), __BERTH_VERSION__: JSON.stringify(appVersion()) },
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
      // lucide's dynamic icons are one chunk per icon (some 1,700 files);
      // the demo draws the few that plugins name from one small map.
      ...(mode === "demo" ? { "lucide-react/dynamic": path.resolve(import.meta.dirname, "./src/demo/lucide-dynamic.tsx") } : {}),
    },
  },
  base: mode === "demo" ? "./" : "/",
  // A desktop app loads from disk; one large chunk (xterm, React) is fine.
  build: {
    chunkSizeWarningLimit: 2000,
    ...(mode === "demo" ? { outDir: path.resolve(import.meta.dirname, "../site/demo"), emptyOutDir: true } : {}),
    rolldownOptions: { output: { codeSplitting: startupChunks } },
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
