// The plugin SDK's runtime half, provided by the app. See src/plugins/host.ts.
const sdk = globalThis.__berth.sdk;
export default sdk;
export const { definePlugin, useBerth, useBoxes, useLocations, useSessions, useFleetSessions, useStats, useEvent, useCurrentWorktree, useStorage, useWidgetData, useProjects, worktreeLocation, sessionName } = sdk;
