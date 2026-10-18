import { UserRoundIcon } from "lucide-react";

import type { LocationConfig } from "@/lib/flows";
import { Section, type Source, SourceBadge } from "@/views/project/parts";

// LoginSection shows, read-only, who this project's worktrees can be logged
// in as: the "login" of its kit, the box's own config, or its committed
// config once trusted. The Browser tab's "Log in as…" and the ⌘K palette
// offer these users; agents use `berthd browser open --as EMAIL`.
export function LoginSection({ config, box }: { config: LocationConfig; box: string }) {
  const login = config.effective?.login;
  const source: Source | undefined = config.local?.login ? "box" : config.kit?.config.login ? "kit" : config.repo?.login ? "repo" : undefined;
  return (
    <Section
      id="login"
      title="Login users"
      description={
        <>
          Seeded users a worktree's pages can be opened logged in as, from the Browser tab's <span className="text-foreground">Log in as…</span>. The script runs in the worktree, against its own dev server and database.
        </>
      }
    >
      {!login ? (
        <p className="px-4 py-3.5 text-desc text-muted-foreground">
          None. Add <code className="rounded bg-muted px-1 py-px font-mono text-tag">"login"</code> with a script and users to the project's kit or <code className="rounded bg-muted px-1 py-px font-mono text-tag">.berth/config.json</code>.
        </p>
      ) : (
        <div className="divide-y divide-border/70">
          <div className="flex items-center gap-3 px-4 py-3">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 text-row">
                Login script
                {source && <SourceBadge source={source} box={box} />}
              </div>
              <code className="mt-1 block truncate font-mono text-mono text-muted-foreground">{login.script}</code>
            </div>
            <span className="shrink-0 text-meta text-muted-foreground">{login.any ? "Any email allowed" : "Only these users"}</span>
          </div>
          {(login.users ?? []).map((u) => (
            <div key={u.email} className="flex items-center gap-3 px-4 py-2.5" data-testid="login-user">
              <UserRoundIcon className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate text-body">{u.label || u.email}</span>
              {u.label && <span className="shrink-0 truncate font-mono text-meta text-muted-foreground">{u.email}</span>}
            </div>
          ))}
        </div>
      )}
    </Section>
  );
}
