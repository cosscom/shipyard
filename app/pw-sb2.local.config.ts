import base from "./playwright.config";
export default { ...base, testDir: "./e2e", outputDir: "node_modules/.e2e-results-sb2", use: { ...base.use, baseURL: "http://127.0.0.1:1423" }, webServer: { command: "pnpm exec vite preview --host 127.0.0.1 --port 1423 --strictPort", url: "http://127.0.0.1:1423/", reuseExistingServer: true, timeout: 30000 } };
