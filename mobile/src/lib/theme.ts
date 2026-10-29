import { useColorScheme } from "react-native";

// The phone's colours: the web phone app's (internal/box/phoneui/app.css),
// which are the desktop app's greys. Amber means "needs you" and nothing
// else; teal is working, green done, grey at rest.

export const light = {
  bg: "#f6f6f4",
  panel: "#ffffff",
  sunk: "#efeeeb",
  fg: "#1d1f22",
  muted: "#686b70",
  line: "#e2e1dd",
  term: "#1b1d20",
  termFg: "#d9d7d2",
  waiting: "#b7791f",
  waitingBg: "#fbf1dc",
  running: "#2c7a73",
  done: "#2f7d4f",
  idle: "#8a8d92",
  bad: "#c2412d",
  accent: "#1d1f22",
  accentFg: "#ffffff",
};

export type Colors = typeof light;

export const dark: Colors = {
  bg: "#16181b",
  panel: "#1d2023",
  sunk: "#23262a",
  fg: "#e7e6e3",
  muted: "#9a9ca1",
  line: "#2c2f34",
  term: "#111315",
  termFg: "#d9d7d2",
  waiting: "#e8a94b",
  waitingBg: "#352813",
  running: "#5fc4b8",
  done: "#6fcf97",
  idle: "#8a8d92",
  bad: "#f07a66",
  accent: "#e7e6e3",
  accentFg: "#16181b",
};

export const mono = "Menlo";

export function useColors(): Colors {
  return useColorScheme() === "dark" ? dark : light;
}

// stateColor is an agent state's colour.
export function stateColor(c: Colors, state: string | undefined): string {
  switch (state) {
    case "waiting":
      return c.waiting;
    case "running":
      return c.running;
    case "finished":
      return c.done;
    default:
      return c.idle;
  }
}
