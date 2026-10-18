import { BracesIcon } from "lucide-react";
import { useRef } from "react";

import { Input } from "@/components/ui/input";
import { Menu, MenuGroup, MenuGroupLabel, MenuItem, MenuPopup, MenuTrigger } from "@/components/ui/menu";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import type { Variable } from "@/views/automations/flows/model";

// TemplateField is a step's text, with the {{…}} variables it can use one
// click away, inserted where the cursor is.
export function TemplateField({
  value,
  onChange,
  variables,
  placeholder,
  multiline,
  mono,
  readOnly,
  label,
}: {
  value: string;
  onChange(v: string): void;
  variables: Variable[];
  placeholder?: string;
  multiline?: boolean;
  mono?: boolean;
  readOnly?: boolean;
  label: string;
}) {
  const el = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  const groups = [...new Set(variables.map((v) => v.group))];

  const insert = (token: string) => {
    const at = el.current?.selectionStart ?? value.length;
    const end = el.current?.selectionEnd ?? at;
    onChange(value.slice(0, at) + token + value.slice(end));
    requestAnimationFrame(() => {
      el.current?.focus();
      el.current?.setSelectionRange(at + token.length, at + token.length);
    });
  };

  const cls = cn(mono && "font-mono text-mono");
  return (
    <div>
      <span className="mb-1 flex items-center gap-2">
        <span className="text-label text-muted-foreground">{label}</span>
        {!readOnly && variables.length > 0 && (
          <Menu>
            <MenuTrigger render={<button type="button" className="ml-auto inline-flex items-center gap-1 rounded px-1 text-tag text-muted-foreground hover:bg-accent hover:text-foreground" />}>
              <BracesIcon className="size-3" />
              Insert
            </MenuTrigger>
            <MenuPopup align="end" className="max-h-80 min-w-56">
              {groups.map((g) => (
                <MenuGroup key={g}>
                  <MenuGroupLabel>{g}</MenuGroupLabel>
                  {variables
                    .filter((v) => v.group === g)
                    .map((v) => (
                      <MenuItem key={v.token} onClick={() => insert(v.token)}>
                        <span className="flex-1">{v.label}</span>
                        <code className="font-mono text-tag text-muted-foreground">{v.token}</code>
                      </MenuItem>
                    ))}
                </MenuGroup>
              ))}
            </MenuPopup>
          </Menu>
        )}
      </span>
      {multiline ? (
        <Textarea ref={el} value={value} readOnly={readOnly} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} className={cls} spellCheck={!mono} />
      ) : (
        <Input ref={el} value={value} readOnly={readOnly} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} className={cls} spellCheck={false} />
      )}
    </div>
  );
}
