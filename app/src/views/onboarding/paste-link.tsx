import { CheckIcon, ChevronRightIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Tip } from "@/components/tip";
import { Button } from "@/components/ui/button";
import { laptopApi } from "@/lib/api";
import { errorMessage } from "@/lib/format";
import { useStore } from "@/lib/store";
import { findPairingLink, linkAddress, onTailnetAddress, unreachable } from "@/views/onboarding/pairing-link";

// PasteLink pairs with a box from the link `berthd pair` (or the install
// script) printed there. Pasting the whole output is fine: the field keeps
// only the link. Enter pairs.
export function PasteLink({
  network,
  retry,
  autoFocus,
  onBusy,
  onPaired,
  onSignIn,
}: {
  network?: string;
  // Changing retry pairs again with what is in the field: after signing in
  // to the tailnet the box is on, say.
  retry: number;
  autoFocus?: boolean;
  onBusy(busy: boolean): void;
  onPaired(box: string): void;
  onSignIn(): void;
}) {
  const client = useStore((s) => s.client);
  const [text, setText] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string>();
  const [error, setError] = useState<{ message: string; away?: boolean }>();
  const field = useRef<HTMLInputElement>(null);
  const link = findPairingLink(text);
  const address = link ? linkAddress(link) : undefined;

  const pair = async () => {
    if (!client || busy) return;
    if (!link) {
      setError({ message: text.trim() ? "There's no pairing link in that. It starts with berth:// and is the last thing the install command prints." : "Paste the pairing link the box printed first." });
      return;
    }
    setBusy(true);
    onBusy(true);
    setError(undefined);
    try {
      const peer = await laptopApi.pair(client, link, name.trim(), network);
      await useStore.getState().refreshAll();
      setDone(peer.name);
      onPaired(peer.name);
    } catch (err) {
      const message = errorMessage(err);
      setError({ message, away: unreachable(message) });
      setBusy(false);
      onBusy(false);
    }
  };

  const tried = useRef(retry);
  useEffect(() => {
    if (retry === tried.current) return;
    tried.current = retry;
    void pair();
    // Only a new retry pairs; pair reads the latest field and network.
  }, [retry]);

  return (
    <div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void pair();
        }}
        className="flex h-10 items-center gap-2 rounded-lg border border-input bg-background ps-3 pe-1 shadow-xs/5 focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/24 dark:bg-input/32"
      >
        <ChevronRightIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        <input
          ref={field}
          autoFocus={autoFocus}
          value={text}
          disabled={busy}
          spellCheck={false}
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          aria-label="Pairing link"
          aria-invalid={error && !error.away ? true : undefined}
          placeholder="berth://…  paste the link it printed"
          onPaste={(e) => {
            const pasted = e.clipboardData.getData("text");
            const found = findPairingLink(pasted);
            if (!found) return;
            // A pasted line or two of output: keep only the link. Newlines
            // would otherwise run the lines together in a one-line field.
            e.preventDefault();
            setText(found);
            setError(undefined);
          }}
          onChange={(e) => {
            setText(e.target.value);
            setError(undefined);
          }}
          className="h-full min-w-0 flex-1 truncate bg-transparent font-mono text-desc outline-none placeholder:font-sans placeholder:text-muted-foreground/72 placeholder:text-body disabled:opacity-64"
        />
        <Tip label={!link ? "Paste a pairing link first" : undefined}>
          <Button type="submit" size="xs" className="shrink-0" disabled={!link || !!done} loading={busy && !done}>
            Pair
          </Button>
        </Tip>
      </form>
      <div aria-live="polite" className="mt-2 min-h-5 text-meta">
        {done ? (
          <span className="flex items-center gap-1.5 text-success-foreground">
            <CheckIcon className="size-3.5" /> Paired with {done}
          </span>
        ) : error ? (
          <div className="text-destructive-foreground">
            {error.message}
            {error.away && address && (
              <span className="text-muted-foreground">
                {" "}
                {onTailnetAddress(address) ? `${address} is a tailnet address; if the box is on a tailnet this computer isn't signed in to, ` : "If the box is on another tailnet, "}
                <button type="button" className="text-foreground underline underline-offset-2 hover:no-underline" onClick={onSignIn}>
                  sign in to that tailnet
                </button>
                {" and Shipyard tries again."}
              </span>
            )}
          </div>
        ) : link && address ? (
          <div className="flex min-w-0 items-center gap-1.5 text-muted-foreground">
            <span className="min-w-0 truncate">
              Box at <span className="font-mono text-foreground">{address}</span>
              {network ? ` through the ${network} tailnet` : ""}
            </span>
            <span className="ms-auto flex shrink-0 items-center gap-1">
              named
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), void pair())}
                placeholder="after its hostname"
                aria-label="Name in Shipyard"
                spellCheck={false}
                disabled={busy}
                className="h-5 w-32 border-input border-b bg-transparent px-0.5 text-foreground outline-none placeholder:text-muted-foreground/72 focus:border-ring"
              />
            </span>
          </div>
        ) : (
          <span className="text-muted-foreground">It works once, for ten minutes. Pasting everything it printed is fine.</span>
        )}
      </div>
    </div>
  );
}
