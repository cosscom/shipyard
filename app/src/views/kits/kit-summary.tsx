import { ChevronRightIcon, FileCodeIcon, FileIcon, PlayIcon, ShieldIcon, WorkflowIcon, WrenchIcon } from "lucide-react";
import { type ReactNode, useState } from "react";

import { AgentIcon } from "@/components/agent-glyph";
import { type KitFile, type KitInfo, formatBytes } from "@/lib/kits";
import { cn } from "@/lib/utils";
import { CATALOG } from "@/views/automations/catalog";
import { summary as flowSummary } from "@/views/automations/flows/model";

// KitSummary says everything a kit will do to a project, in plain sections,
// so it can be reviewed before it runs anywhere.

function Block({ title, count, children }: { title: string; count?: number; children: ReactNode }) {
  return (
    <section>
      <h3 className="mb-1.5 flex items-center gap-1.5 text-section">
        {title}
        {count !== undefined && <span className="rounded-full bg-muted px-1.5 text-tag tabular-nums">{count}</span>}
      </h3>
      <div className="divide-y divide-border/70 overflow-hidden rounded-lg border bg-card">{children}</div>
    </section>
  );
}

function Row({ label, children, mono }: { label?: ReactNode; children: ReactNode; mono?: boolean }) {
  return (
    <div className="flex min-w-0 gap-3 px-3 py-2 text-body">
      {label && <span className="w-24 shrink-0 text-muted-foreground text-meta leading-5">{label}</span>}
      <div className={cn("min-w-0 flex-1", mono && "font-mono text-mono")}>{children}</div>
    </div>
  );
}

// Item is a named entry (a service, an automation, a hook, an agent): its
// name on one line and what it does under it, so long names never truncate.
function Item({ icon, name, meta, children }: { icon: ReactNode; name: ReactNode; meta?: ReactNode; children: ReactNode }) {
  return (
    <div className="min-w-0 px-3 py-2">
      <div className="flex min-w-0 items-center gap-1.5 text-body">
        <span className="shrink-0 text-muted-foreground [&_svg]:size-3">{icon}</span>
        <span className="min-w-0 truncate text-row">{name}</span>
        {meta && <span className="ml-auto shrink-0 text-meta text-muted-foreground">{meta}</span>}
      </div>
      <div className="mt-0.5 pl-[18px] text-muted-foreground">{children}</div>
    </div>
  );
}

function Code({ children }: { children: ReactNode }) {
  return <pre className="whitespace-pre-wrap break-words font-mono text-mono">{children}</pre>;
}

const eventLabel = (on: string) => CATALOG.find((c) => c.on === on)?.label ?? (on.startsWith("before:") ? `Before ${on.slice(7)}` : on);

export function KitSummary({ kit, filesOpen }: { kit: KitInfo; filesOpen?: boolean }) {
  const c = kit.config ?? {};
  const env = Object.entries(c.env ?? {});
  const nothing = !c.setup && !c.archive && !c.ports && !env.length && !c.services?.length && !c.hooks?.length && !c.flows?.length && !c.agents?.length;

  return (
    <div className="space-y-4">
      {(c.setup || c.archive) && (
        <Block title="Setup and teardown">
          {c.setup && (
            <Row label="New worktree">
              <Code>{c.setup}</Code>
            </Row>
          )}
          {c.archive && (
            <Row label="Removed worktree">
              <Code>{c.archive}</Code>
            </Row>
          )}
        </Block>
      )}

      {(env.length > 0 || c.ports) && (
        <Block title="Environment and ports" count={env.length || undefined}>
          {c.ports ? (
            <Row label="Ports">
              <span className="text-desc">
                {c.ports} per worktree, from <code className="font-mono">$BERTH_PORT</code>
              </span>
            </Row>
          ) : null}
          {env.map(([k, v]) => (
            <div key={k} className="grid grid-cols-[minmax(6rem,auto)_minmax(0,1fr)] gap-x-4 px-3 py-2 font-mono text-mono">
              <span className="max-w-64 truncate text-foreground/90" title={k}>
                {k}
              </span>
              <span className="break-all text-muted-foreground">{v}</span>
            </div>
          ))}
        </Block>
      )}

      {c.services?.length ? (
        <Block title="Services" count={c.services.length}>
          {c.services.map((s) => (
            <Item key={s.name} icon={<PlayIcon />} name={s.name} meta={s.autostart ? "Starts with every new worktree" : "Started from the Run menu"}>
              <Code>{s.run}</Code>
            </Item>
          ))}
        </Block>
      ) : null}

      {c.flows?.length ? (
        <Block title="Automations" count={c.flows.length}>
          {c.flows.map((f) => (
            <Item key={f.id} icon={<WorkflowIcon />} name={f.name || f.id} meta={f.enabled === false ? "Off" : undefined}>
              <p className="text-desc">{flowSummary(f)}</p>
            </Item>
          ))}
        </Block>
      ) : null}

      {c.hooks?.length ? (
        <Block title="Hooks" count={c.hooks.length}>
          {c.hooks.map((h, i) => (
            <Item key={`${h.on}-${i}`} icon={h.on.startsWith("before:") ? <ShieldIcon /> : <WrenchIcon />} name={eventLabel(h.on)} meta={<code className="font-mono">{h.on}</code>}>
              <Code>{h.run}</Code>
            </Item>
          ))}
        </Block>
      ) : null}

      {c.agents?.length ? (
        <Block title="Agents" count={c.agents.length}>
          {c.agents.map((a) => (
            <Item key={a.id} icon={<AgentIcon agent={a.id} />} name={a.name || a.id}>
              <Code>{a.command}</Code>
            </Item>
          ))}
        </Block>
      ) : null}

      {kit.requires?.length ? (
        <Block title="Needs on each box">
          {kit.requires.map((r) => (
            <Row key={r.tool} label={<span className="font-mono text-foreground">{r.tool}</span>}>
              <span className="text-desc text-muted-foreground">{r.hint || "Must be installed. Applying warns where it is not."}</span>
            </Row>
          ))}
        </Block>
      ) : null}

      {nothing && <p className="rounded-lg border border-dashed px-3 py-4 text-center text-meta text-muted-foreground">This kit sets nothing up yet.</p>}

      {kit.file_list?.length ? <FilesBlock files={kit.file_list} open={filesOpen} /> : null}
    </div>
  );
}

function FilesBlock({ files, open }: { files: KitFile[]; open?: boolean }) {
  const shown = files.filter((f) => f.path !== "kit.json" && f.path !== "source.json");
  if (!shown.length) return null;
  return (
    <Block title="Files" count={shown.length}>
      {shown.map((f) => (
        <FileRow key={f.path} file={f} open={open} />
      ))}
    </Block>
  );
}

function FileRow({ file, open }: { file: KitFile; open?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const viewable = file.text !== undefined;
  const Icon = /\.(sh|py|js|ts|cjs|mjs|rb|sql|json|ya?ml|toml)$/.test(file.path) ? FileCodeIcon : FileIcon;
  return (
    <div>
      <button
        type="button"
        disabled={!viewable && !open}
        onClick={() => setExpanded(!expanded)}
        className="flex w-full min-w-0 items-center gap-2 px-3 py-2 text-left text-body hover:bg-accent/50 disabled:hover:bg-transparent"
      >
        <ChevronRightIcon className={cn("size-3 shrink-0 text-muted-foreground transition-transform", expanded && "rotate-90", !viewable && "opacity-0")} />
        <Icon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate font-mono text-mono">{file.path}</span>
        <span className="shrink-0 text-meta text-muted-foreground tabular-nums">{viewable ? formatBytes(file.size) : `${formatBytes(file.size)} · not shown`}</span>
      </button>
      {expanded && viewable && (
        <pre className="max-h-80 overflow-auto border-t bg-muted/40 px-4 py-3 font-mono text-mono">{file.text || "(empty)"}</pre>
      )}
    </div>
  );
}

// kitCounts is a kit in a line: "Setup · 2 services · 3 automations".
export function kitCounts(kit: KitInfo): string {
  const c = kit.config ?? {};
  const parts: string[] = [];
  if (c.setup || c.archive) parts.push(c.setup && c.archive ? "Setup and teardown" : c.setup ? "Setup" : "Teardown");
  const n = (k: number, one: string, many = `${one}s`) => k && parts.push(`${k} ${k === 1 ? one : many}`);
  n(Object.keys(c.env ?? {}).length, "env var");
  n(c.services?.length ?? 0, "service");
  n(c.flows?.length ?? 0, "automation");
  n(c.hooks?.length ?? 0, "hook");
  n(c.agents?.length ?? 0, "agent");
  n((kit.file_list ?? []).filter((f) => f.path !== "kit.json" && f.path !== "source.json").length, "file");
  return parts.join(" · ") || "Nothing yet";
}
