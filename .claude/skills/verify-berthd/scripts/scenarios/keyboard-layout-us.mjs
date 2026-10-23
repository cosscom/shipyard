// keyboard-layout.mjs on a US layout: Back and Forward read ⌘[ and ⌘].
import { drive, init, LAYOUTS } from "./keyboard-layout.mjs";

export { init };
export const initArg = LAYOUTS.us.map;
export const run = drive(LAYOUTS.us);
