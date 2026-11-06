import { type ReactNode } from "react";

// Enough Markdown to read an agent's message: paragraphs, headings as bold,
// lists, fenced code, inline code, bold and links. It builds React nodes from
// the text, so nothing an agent wrote is ever drawn as HTML.

const INLINE = /(`[^`\n]+`|\*\*[^*\n]+\*\*|\[[^\]\n]+\]\(https?:\/\/[^)\s]+\))/g;

function inline(text: string, openUrl: (url: string) => void): ReactNode[] {
  return text.split(INLINE).map((part, i) => {
    if (part.startsWith("`") && part.endsWith("`") && part.length > 2)
      return (
        <code key={i} className="rounded bg-muted px-1 font-mono text-[0.92em]">
          {part.slice(1, -1)}
        </code>
      );
    if (part.startsWith("**") && part.endsWith("**") && part.length > 4)
      return (
        <strong key={i} className="font-medium">
          {part.slice(2, -2)}
        </strong>
      );
    const link = part.match(/^\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)$/);
    if (link)
      return (
        <button key={i} type="button" className="underline" onClick={() => openUrl(link[2])}>
          {link[1]}
        </button>
      );
    return part;
  });
}

export function Markdown({ text, openUrl }: { text: string; openUrl: (url: string) => void }) {
  const blocks: ReactNode[] = [];
  const lines = text.split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith("```")) {
      const code: string[] = [];
      for (i++; i < lines.length && !lines[i].startsWith("```"); i++) code.push(lines[i]);
      i++;
      blocks.push(
        <pre key={i} className="overflow-x-auto rounded-md bg-muted p-2 font-mono text-xs">
          {code.join("\n")}
        </pre>,
      );
    } else if (/^\s*([-*]|\d+\.)\s/.test(line)) {
      const rows: string[] = [];
      for (; i < lines.length && /^\s*([-*]|\d+\.)\s/.test(lines[i]); i++) rows.push(lines[i].replace(/^\s*([-*]|\d+\.)\s+/, ""));
      blocks.push(
        <ul key={i} className="flex list-disc flex-col gap-1 pl-5">
          {rows.map((r, n) => (
            <li key={n}>{inline(r, openUrl)}</li>
          ))}
        </ul>,
      );
    } else if (/^#{1,6}\s/.test(line)) {
      blocks.push(
        <p key={i} className="font-medium">
          {inline(line.replace(/^#+\s+/, ""), openUrl)}
        </p>,
      );
      i++;
    } else if (!line.trim()) {
      i++;
    } else {
      const para: string[] = [];
      for (; i < lines.length && lines[i].trim() && !lines[i].startsWith("```") && !/^\s*([-*]|\d+\.)\s/.test(lines[i]) && !/^#{1,6}\s/.test(lines[i]); i++) para.push(lines[i]);
      blocks.push(<p key={i}>{inline(para.join(" "), openUrl)}</p>);
    }
  }
  return <div className="flex min-w-0 flex-col gap-2 break-words">{blocks}</div>;
}
