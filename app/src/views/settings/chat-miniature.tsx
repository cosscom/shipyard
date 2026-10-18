// The conversation drawn small over a chat background's preview in Settings:
// a user message, an edit, a reply with code and the composer. It is a
// picture of the chat scaled to about 60%, so its text is sized to the
// drawing rather than by the type scale.
export function ChatMiniature() {
  return (
    <div className="absolute inset-y-0 left-1/2 flex w-[62%] -translate-x-1/2 flex-col gap-2.5 px-4 pt-4 pb-3 text-[11px] leading-relaxed">
      <div className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-hidden">
        <div className="self-end rounded-2xl bg-muted px-2.5 py-1 text-foreground">Make the search page fast again</div>
        <div className="flex items-center gap-1.5 self-start rounded-lg bg-muted/40 px-2 py-1 text-muted-foreground">
          <span className="text-foreground/80">Edited</span> <span className="font-mono">lib/search.ts</span> <span className="font-mono text-success">+12</span>
          <span className="font-mono text-destructive">-4</span>
        </div>
        <p className="text-foreground">The slow part was an unindexed join, so I added a trigram index:</p>
        <pre className="rounded-lg bg-muted px-2 py-1.5 font-mono text-[10px] text-foreground">create index on products using gin (name gin_trgm_ops);</pre>
        <p className="text-muted-foreground">p95 went from 840 ms to 95 ms.</p>
      </div>
      <div className="shrink-0 rounded-lg border border-input bg-background px-2.5 py-1.5 text-muted-foreground dark:bg-input/32">Reply, or ask for something else</div>
    </div>
  );
}
