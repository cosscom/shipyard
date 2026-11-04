import { SearchIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { platformKeys } from "@/lib/platform";
import { cn } from "@/lib/utils";
import { openSettings, type SettingsSectionId } from "@/views/settings/open";

// Where each setting lives, by the words people look for it with. Find a
// setting matches these and opens the section.
const INDEX: { id: SettingsSectionId; title: string; words: string }[] = [
  { id: "general", title: "General", words: "closing tabs stop keep running confirm browser beside login startup helper berth command cli private urls ports" },
  { id: "notifications", title: "Notifications", words: "toast system centre center quiet hours do not disturb sound alerts waiting" },
  { id: "appearance", title: "Appearance", words: "theme dark light match system home picture wallpaper harbour chat background width text size density font sidebar rail list columns layout" },
  { id: "terminal", title: "Terminal", words: "font size line height cursor blink scrollback predict typing copy on select renderer" },
  { id: "boxes", title: "Boxes", words: "servers machines berthd update routes sessions browsers offline reconnect pair" },
  { id: "computers", title: "Computers", words: "laptops this mac join link pair remove" },
  { id: "phone", title: "Phone", words: "mobile qr code pairing ntfy push" },
  { id: "agents", title: "Agents", words: "claude code codex models skills turn check cli install permissions bypass ask approvals allow chat" },
  { id: "integrations", title: "Integrations", words: "linear github slack webhooks connect" },
  { id: "secrets", title: "Secrets", words: "api keys tokens passwords credentials secret manager gcp keychain store expiry delete requests" },
  { id: "plugins", title: "Plugins", words: "marketplace install built in extensions allow" },
  { id: "shortcuts", title: "Shortcuts", words: "keyboard keys bindings hotkeys" },
  { id: "labs", title: "Labs", words: "experiments early harbour conversations diagnostics" },
  { id: "about", title: "About", words: "version update release notes documentation diagnostics" },
  { id: "developer", title: "Developer", words: "reset reload mock sample data onboarding connection build" },
];

function matches(q: string) {
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  return INDEX.filter((s) => {
    const hay = `${s.title} ${s.words}`.toLowerCase();
    return terms.every((t) => hay.includes(t));
  });
}

// SettingsFind is the "Find a setting" field at the top of every section:
// ⌘F focuses it, typing lists the sections that have what you typed, and
// Enter (or a click) opens the first.
export function SettingsFind() {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [at, setAt] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const found = useMemo(() => matches(q), [q]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "f") {
        e.preventDefault();
        input.current?.focus();
        input.current?.select();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const go = (id: SettingsSectionId) => {
    setQ("");
    setOpen(false);
    input.current?.blur();
    openSettings(id);
  };

  return (
    <div className="relative w-50 shrink-0 max-[900px]:hidden">
      <label className="flex h-8 items-center gap-2 rounded-lg bg-muted px-2.5 text-muted-foreground focus-within:ring-2 focus-within:ring-ring/40">
        <SearchIcon className="size-3.5 shrink-0" />
        <input
          ref={input}
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setAt(0);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => window.setTimeout(() => setOpen(false), 120)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") setAt((i) => Math.min(i + 1, found.length - 1));
            else if (e.key === "ArrowUp") setAt((i) => Math.max(i - 1, 0));
            else if (e.key === "Enter" && found[at]) go(found[at].id);
            else if (e.key === "Escape") {
              e.stopPropagation();
              setQ("");
              input.current?.blur();
            } else return;
            e.preventDefault();
          }}
          placeholder="Find a setting"
          aria-label="Find a setting"
          className="min-w-0 flex-1 bg-transparent text-desc text-foreground outline-none placeholder:text-muted-foreground"
        />
        {!q && <kbd className="font-sans text-meta">{platformKeys("⌘F")}</kbd>}
      </label>
      {open && q.trim() && (
        <div role="listbox" aria-label="Settings found" className="absolute top-9 right-0 z-20 w-64 overflow-hidden rounded-lg border bg-popover p-1 text-popover-foreground shadow-lg">
          {found.length === 0 ? (
            <div className="px-2.5 py-2 text-muted-foreground text-meta">Nothing matches “{q.trim()}”.</div>
          ) : (
            found.map((s, i) => (
              <button
                key={s.id}
                type="button"
                role="option"
                aria-selected={i === at}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => go(s.id)}
                onMouseEnter={() => setAt(i)}
                className={cn("flex w-full items-center rounded-md px-2.5 py-1.5 text-left text-desc", i === at && "bg-accent")}
              >
                {s.title}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
