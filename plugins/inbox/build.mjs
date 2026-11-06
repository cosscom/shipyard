// Bundles the plugin as one ES module. React and the Shipyard SDK stay external:
// the app provides one shared copy of each at runtime.
import { build } from "esbuild";

await build({
  entryPoints: ["src/index.tsx"],
  bundle: true,
  format: "esm",
  jsx: "automatic",
  target: "es2022",
  external: ["react", "react/jsx-runtime", "react-dom", "@berth/plugin", "@berth/plugin/ui"],
  outfile: "dist/index.js",
  logLevel: "info",
});
