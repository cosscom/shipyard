import { Input } from "@/components/ui/input";

// OrgField takes an org, or a link to a setup (owner/repo/tree/branch/folder
// after the github.com/ it shows, or a whole URL pasted, which hides it).
export function OrgField({ value, onChange, autoFocus }: { value: string; onChange(v: string): void; autoFocus?: boolean }) {
  const whole = /github\.com|:\/\//i.test(value);
  return (
    <label className="flex min-w-0 flex-1 items-center rounded-lg border bg-background pl-3 font-mono text-sm shadow-xs/5 focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/24 dark:bg-input/32">
      {!whole && <span className="shrink-0 text-muted-foreground">github.com/</span>}
      <Input unstyled aria-label="GitHub org or link" autoFocus={autoFocus} spellCheck={false} autoCapitalize="off" placeholder="your-org" value={value} onChange={(e) => onChange(e.target.value)} className="font-mono [&_input]:pl-0.5" />
    </label>
  );
}
