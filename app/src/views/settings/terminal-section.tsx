import { useSyncExternalStore } from "react";

import { Button } from "@/components/ui/button";
import { SimpleSelect } from "@/components/simple-select";
import { Switch } from "@/components/ui/switch";
import { setPrefs, setTerminalPrefs, usePrefs } from "@/lib/prefs";
import { copyText } from "@/lib/clipboard";
import { DEFAULT_TERMINAL_PREFS, onRendererOutcome, rendererOutcome, type TerminalPrefs } from "@/lib/terminal";
import { useActiveTheme } from "@/hooks/use-theme";
import { Segmented, Stepper } from "@/views/settings/controls";
import { SettingsGroup, SettingsPage, SettingsRow } from "@/views/settings/rows";

const FONTS = [
  { value: DEFAULT_TERMINAL_PREFS.fontFamily, label: "JetBrains Mono" },
  { value: '"SF Mono", ui-monospace, Menlo, monospace', label: "SF Mono" },
  { value: 'Menlo, ui-monospace, monospace', label: "Menlo" },
  { value: '"Berkeley Mono", ui-monospace, Menlo, monospace', label: "Berkeley Mono (if installed)" },
  { value: '"Fira Code", ui-monospace, Menlo, monospace', label: "Fira Code (if installed)" },
];

export function TerminalSection() {
  const t = usePrefs((p) => p.terminal);
  const copyOnSelect = usePrefs((p) => p.copyOnSelect);
  const set = (patch: Partial<TerminalPrefs>) => setTerminalPrefs(patch);
  const outcome = useSyncExternalStore(onRendererOutcome, rendererOutcome);
  const fellBack = outcome?.chosen === "ghostty" && outcome.renderer === "xterm";
  const fonts = FONTS.some((f) => f.value === t.fontFamily) ? FONTS : [{ value: t.fontFamily, label: t.fontFamily }, ...FONTS];

  return (
    <SettingsPage
      title="Terminal"
      description="Every terminal pane. Open ones update as you change these."
      actions={
        <Button size="xs" variant="ghost" className="text-muted-foreground" onClick={() => setTerminalPrefs(DEFAULT_TERMINAL_PREFS)}>
          Restore defaults
        </Button>
      }
    >
      <TerminalPreview prefs={t} />
      <SettingsGroup title="Text">
        <SettingsRow label="Font">
          <SimpleSelect className="w-56" options={fonts} value={t.fontFamily} onChange={(fontFamily) => set({ fontFamily })} />
        </SettingsRow>
        <SettingsRow label="Size" description="Or ⌘+ and ⌘− with a terminal focused; ⌘0 resets it.">
          <Stepper value={t.fontSize} min={9} max={24} onChange={(fontSize) => set({ fontSize })} />
        </SettingsRow>
        <SettingsRow label="Line height" description="1.0 packs lines like Ghostty; higher is airier.">
          <Stepper value={t.lineHeight} min={1} max={1.6} step={0.05} format={{ minimumFractionDigits: 2, maximumFractionDigits: 2 }} onChange={(lineHeight) => set({ lineHeight })} />
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup title="Cursor">
        <SettingsRow label="Style">
          <Segmented
            value={t.cursorStyle}
            options={[
              { value: "block", label: "Block" },
              { value: "bar", label: "Bar" },
              { value: "underline", label: "Underline" },
            ]}
            onChange={(cursorStyle) => set({ cursorStyle })}
          />
        </SettingsRow>
        <SettingsRow label="Blink">
          <Switch checked={t.cursorBlink} onCheckedChange={(cursorBlink) => set({ cursorBlink })} />
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup title="Behaviour">
        <SettingsRow label="Scrollback" description="Lines kept in the app. The box's tmux keeps 50,000 more, redrawn when you reattach.">
          <Stepper value={t.scrollback} min={1000} max={100000} step={1000} onChange={(scrollback) => set({ scrollback })} />
        </SettingsRow>
        <SettingsRow
          label="Predict typing"
          description="On a slow link, what you type shows before the box echoes it, underlined until the box agrees, as in Mosh. Adaptive does it only when the round trip is over about 60 ms."
        >
          <Segmented
            value={t.predict}
            options={[
              { value: "adaptive", label: "Adaptive" },
              { value: "always", label: "Always" },
              { value: "never", label: "Never" },
            ]}
            onChange={(predict) => set({ predict })}
          />
        </SettingsRow>
        <SettingsRow label="Copy on select" description="Selecting text copies it, as in most Linux terminals.">
          <Switch checked={copyOnSelect} onCheckedChange={(copyOnSelect) => setPrefs({ copyOnSelect })} />
        </SettingsRow>
        <SettingsRow
          label="Renderer"
          description={
            fellBack ? (
              <>
                In use: xterm.js, because ghostty-web couldn't start{outcome.reason ? `: ${outcome.reason}` : ""}.{" "}
                <button type="button" className="underline underline-offset-2 hover:text-foreground" onClick={() => void copyText(outcome.details ?? outcome.reason ?? "", "Details copied")}>
                  Copy details
                </button>
              </>
            ) : (
              "Ghostty's terminal core, compiled to WebAssembly, or xterm.js. Switch if something draws wrong."
            )
          }
        >
          <Segmented
            value={t.renderer}
            options={[
              { value: "ghostty", label: "Ghostty" },
              { value: "xterm", label: "xterm.js" },
            ]}
            onChange={(renderer) => set({ renderer })}
          />
        </SettingsRow>
      </SettingsGroup>

    </SettingsPage>
  );
}

// TerminalPreview shows a few lines as the terminal will draw them, in the
// chosen font, size, line height and cursor.
function TerminalPreview({ prefs }: { prefs: TerminalPrefs }) {
  const t = useActiveTheme().terminal;
  const cursor =
    prefs.cursorStyle === "bar" ? { width: 2, height: "1.15em" } : prefs.cursorStyle === "underline" ? { width: "0.6em", height: 2, verticalAlign: "-0.15em" } : { width: "0.6em", height: "1.15em" };
  return (
    <div
      aria-hidden
      // A picture of a terminal in the theme's ANSI colours, the programs'
      // own choice: the axe spec leaves it out (the app's text it checks).
      data-a11y-skip
      className="overflow-hidden rounded-xl border px-4 py-3"
      style={{ background: t.background, color: t.foreground, fontFamily: prefs.fontFamily, fontSize: prefs.fontSize, lineHeight: prefs.lineHeight }}
    >
      <div>
        <span style={{ color: t.green }}>me@devl</span> <span style={{ color: t.blue }}>~/work/shop-checkout-fix</span> <span style={{ color: t.magenta }}>(me/checkout-fix)</span>
      </div>
      <div>
        <span style={{ color: t.brightBlack }}>$</span> pnpm test --filter checkout
      </div>
      <div>
        <span style={{ color: t.green }}>✓</span> webhook retries with an idempotency key <span style={{ color: t.brightBlack }}>(41 tests)</span>
      </div>
      <div>
        <span style={{ color: t.yellow }}>●</span> Claude: the fix needs a migration. Create it? <span style={{ color: t.cyan }}>❯ Yes</span>
      </div>
      <div>
        <span style={{ color: t.brightBlack }}>$</span>{" "}
        <span className={prefs.cursorBlink ? "animate-pulse" : undefined} style={{ display: "inline-block", background: t.cursor, verticalAlign: "-0.2em", ...cursor }} />
      </div>
    </div>
  );
}
