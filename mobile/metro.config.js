// Metro, with the code the app shares with the desktop app: packages/core
// (plain TypeScript, relative imports only) and the plugin SDK's types.
// The repository isn't a pnpm workspace, so Metro is told where they are.
const path = require("node:path");
const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);
config.watchFolders = [path.resolve(__dirname, "../packages/core"), path.resolve(__dirname, "../packages/plugin-sdk")];
// Only this app's node_modules: never app/'s, next door.
config.resolver.nodeModulesPaths = [path.resolve(__dirname, "node_modules")];
config.resolver.disableHierarchicalLookup = true;

module.exports = config;
