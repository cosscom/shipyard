import { DynamicIcon, iconNames, type IconName } from "lucide-react/dynamic";

// lucide's map of every icon by name (some 1,700 lazy imports) is large, so
// it loads with the first icon a plugin or a sidebar item names, not at
// start (plugins/ui.tsx's Icon).

const known = new Set<string>(iconNames);

// iconName turns "PanelsTopLeft" or "panels-top-left" into lucide's name.
export function iconName(name: string): IconName | undefined {
  const kebab = name
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/([A-Z])([A-Z][a-z])/g, "$1-$2")
    .toLowerCase();
  return known.has(kebab) ? (kebab as IconName) : undefined;
}

export default function NamedIcon({ name, className }: { name: string; className?: string }) {
  const n = iconName(name);
  return n ? <DynamicIcon name={n} className={className} /> : <DynamicIcon name="puzzle" className={className} />;
}
