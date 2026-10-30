import type { ToolImageRef } from "@/lib/transcript";

// A call's output in pieces: its text, and the pictures it returned where
// they stand.
export type OutputPart = { kind: "text"; text: string } | { kind: "image"; image: ToolImageRef };

// outputParts puts each picture at its line of the output: in place of its
// "[image]" line, or after the line where the output was cut. A picture the
// box doesn't serve stays its "[image]" line.
export function outputParts(output: string, images: ToolImageRef[] | undefined): OutputPart[] {
  if (!images?.length) return output ? [{ kind: "text", text: output }] : [];
  const parts: OutputPart[] = [];
  let text: string[] = [];
  const flush = () => {
    if (text.length) parts.push({ kind: "text", text: text.join("\n") });
    text = [];
  };
  output.split("\n").forEach((line, i) => {
    const here = images.filter((img) => img.line === i);
    if (!here.length || line !== "[image]") text.push(line);
    if (!here.length) return;
    flush();
    for (const image of here) parts.push({ kind: "image", image });
  });
  flush();
  return parts;
}
