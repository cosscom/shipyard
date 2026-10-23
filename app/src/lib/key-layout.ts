// A shortcut matched by the key's place (e.code) rather than its character
// is pressed where a US keyboard has that key: Back is ⌘ and the key right
// of P, which is [ on a US layout, Å on a Norwegian one and Ü on a German
// one. These turn "the key in this place" into what it reads on the layout
// in use, so the keys shown are the keys to press. Pure, for its tests; the
// layout itself is learned in lib/keyboard-layout.ts.

// The places, by e.code, a shortcut can be matched by. Each is what a US
// layout has there, the label shown while the layout isn't known.
export const PLACES: Record<string, string> = {
  BracketLeft: "[",
  BracketRight: "]",
  KeyC: "C",
  KeyD: "D",
  KeyI: "I",
  KeyS: "S",
};

// A dead key (Norwegian ¨, French ^) can come as its combining mark; the
// label is the mark on its own.
const SPACING: Record<string, string> = {
  "̀": "`",
  "́": "´",
  "̂": "^",
  "̃": "~",
  "̄": "¯",
  "̆": "˘",
  "̇": "˙",
  "̈": "¨",
  "̊": "˚",
  "̋": "˝",
  "̌": "ˇ",
  "̧": "¸",
  "̨": "˛",
};

// keyLabel is how a key that types char is labelled ("å" is Å), or
// undefined when char isn't one character a label can show ("Dead",
// "Unidentified", a space, a control character, an IME's "Process").
export function keyLabel(char: string | undefined): string | undefined {
  if (!char) return undefined;
  const c = SPACING[char] ?? char;
  if ([...c].length !== 1 || !/^[\p{L}\p{N}\p{P}\p{S}]$/u.test(c)) return undefined;
  return c.toLocaleUpperCase();
}

// learn is labels with what layout says each place types: a
// KeyboardLayoutMap, or the Mac app's answer. Places it leaves out or
// can't label keep what they had.
export function learn(labels: Record<string, string>, layout: Iterable<[string, string]>): Record<string, string> {
  let out = labels;
  for (const [code, char] of layout) {
    if (!(code in PLACES)) continue;
    const label = keyLabel(char);
    if (!label || out[code] === label) continue;
    if (out === labels) out = { ...labels };
    out[code] = label;
  }
  return out;
}

const MODS = /^[⌃⌘⌥⇧]+/;

// layoutKeys is keys ("⌘[") as they read on the layout labels describe
// ("⌘Å"), when its key is matched by code. Anything else, or a place the
// layout isn't known for, stays as it is.
export function layoutKeys(keys: string, code: string | undefined, labels: Record<string, string>): string {
  if (!code) return keys;
  const label = labels[code];
  const mods = MODS.exec(keys)?.[0] ?? "";
  if (!label || keys.slice(mods.length) !== PLACES[code]) return keys;
  return mods + label;
}
