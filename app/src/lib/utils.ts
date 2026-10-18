import { type ClassValue, clsx } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

// The density sizes in index.css (h-row, py-row-pad, gap-row-gap,
// h-side-row) are spacing like h-8, so they replace it when merged. The
// type scale (text-page-title … text-mono) is font sizes, so
// it replaces those and sits beside a colour such as text-muted-foreground.
export const TYPE_SCALE = ["page-title", "title", "heading", "subtitle", "body", "section", "row", "desc", "label", "meta", "tag", "mono"];
const twMerge = extendTailwindMerge({ extend: { theme: { spacing: ["row", "row-pad", "row-gap", "side-row"], text: TYPE_SCALE } } });

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
