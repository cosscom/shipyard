// Web addresses in an agent's plain text (a question, its options), as
// parts to draw: text, and links that open the whole address.

import { findUrls, trimUrl } from "./term-links.ts";

export interface LinkPart {
  text: string;
  // Set when the part is a link: the address it opens.
  url?: string;
}

// The box cuts a long question or description and ends it in "…"
// (internal/transcript clip).
const CUT = "…";

// linkParts splits text at its http(s) addresses. An address that runs into
// the box's cut at the end isn't linked: it would open a page that isn't the
// one meant. An ellipsis after an address anywhere else is the sentence's,
// and so is any punctuation before it ("…/a.… or not").
export function linkParts(text: string): LinkPart[] {
  const out: LinkPart[] = [];
  let at = 0;
  for (const m of findUrls(text, true)) {
    if (!/^https?:\/\//i.test(m.url)) continue;
    let url = m.url;
    if (url.endsWith(CUT)) {
      if (m.end === text.length) continue;
      url = trimUrl(url.replace(/…+$/, ""));
    }
    if (!/^https?:\/\/./i.test(url)) continue;
    if (m.start > at) out.push({ text: text.slice(at, m.start) });
    out.push({ text: url, url });
    at = m.start + url.length;
  }
  if (at < text.length) out.push({ text: text.slice(at) });
  return out;
}
