import { ChevronDownIcon, LogInIcon, UserRoundIcon, XIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Menu, MenuGroup, MenuGroupLabel, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import type { BrowserContext } from "@/lib/browser-url";
import { loginUrl, loginUserLabel, nextFrom, plausibleEmail } from "@/lib/login-url";
import { useLoginConfig, worktreeOrigin } from "@/lib/login-users";

// The Browser tab's "Log in as…": the seeded users the project's login
// lists (its kit's, the box's own, or the trusted committed config's). A
// pick opens the page through the laptop proxy's login route, which has the
// box run the login script against this worktree's own dev server and sets
// the cookies for this worktree's host alone. Nothing shows without a login.

export function useBrowserLogin(ctx: BrowserContext) {
  const ref = ctx.ref;
  const login = useLoginConfig(ref?.box, ref?.location);
  const origin = ref ? worktreeOrigin(ref, ctx.urlPort) : undefined;
  return login && origin ? { login, origin } : undefined;
}

export function LoginMenu({ ctx, url, onGo, onOther }: { ctx: BrowserContext; url: string; onGo(url: string): void; onOther(): void }) {
  const found = useBrowserLogin(ctx);
  if (!found) return null;
  const { login, origin } = found;
  const next = nextFrom(url, origin);
  return (
    <Menu>
      <MenuTrigger
        aria-label="Log in as…"
        data-testid="login-as"
        className="inline-flex h-6.5 shrink-0 items-center gap-1 rounded-md px-1.5 text-tag text-muted-foreground hover:bg-accent hover:text-foreground data-popup-open:bg-accent data-popup-open:text-foreground [&_svg]:size-3.5"
      >
        <UserRoundIcon />
        <span className="@max-[34rem]/bar:sr-only">Log in as…</span>
        <ChevronDownIcon className="size-3! opacity-60" />
      </MenuTrigger>
      <MenuPopup align="end" className="min-w-60">
        <MenuGroup>
          <MenuGroupLabel>Log in as</MenuGroupLabel>
          {(login.users ?? []).map((u) => (
            <MenuItem key={u.email} onClick={() => onGo(loginUrl(origin, u.email, next))}>
              <UserRoundIcon />
              <span className="flex min-w-0 flex-col">
                <span className="truncate">{loginUserLabel(u)}</span>
                {u.label && <span className="truncate font-mono text-tag text-muted-foreground">{u.email}</span>}
              </span>
            </MenuItem>
          ))}
        </MenuGroup>
        {login.any && (
          <>
            {!!login.users?.length && <MenuSeparator />}
            <MenuItem onClick={onOther}>
              <LogInIcon />
              Another email…
            </MenuItem>
          </>
        )}
      </MenuPopup>
    </Menu>
  );
}

// OtherLogin asks for an email when the project lets a worktree be logged
// in as anyone ("any": true). The box checks the email strictly.
export function OtherLogin({ ctx, url, onGo, onDone }: { ctx: BrowserContext; url: string; onGo(url: string): void; onDone(): void }) {
  const found = useBrowserLogin(ctx);
  const [email, setEmail] = useState("");
  if (!found) return null;
  const ok = plausibleEmail(email.trim());
  return (
    <form
      className="flex shrink-0 items-center gap-2 border-b bg-accent/40 px-2 py-1.5 text-meta"
      onSubmit={(e) => {
        e.preventDefault();
        if (!ok) return;
        onGo(loginUrl(found.origin, email.trim(), nextFrom(url, found.origin)));
        onDone();
      }}
    >
      <UserRoundIcon className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="shrink-0 text-muted-foreground">Log in as</span>
      <input
        autoFocus
        type="email"
        aria-label="Email to log in as"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        placeholder="someone@example.com"
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        className="h-6 min-w-0 flex-1 rounded border bg-background px-2 font-mono outline-none focus:border-ring"
      />
      <Button type="submit" size="xs" disabled={!ok}>
        <LogInIcon />
        Log in
      </Button>
      <button type="button" aria-label="Cancel" className="rounded p-1 text-muted-foreground hover:bg-accent" onClick={onDone}>
        <XIcon className="size-3.5" />
      </button>
    </form>
  );
}
