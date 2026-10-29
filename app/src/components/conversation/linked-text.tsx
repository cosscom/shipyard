import { Fragment } from "react";

import { linkParts } from "@/lib/link-text";
import { openUrl } from "@/lib/open-url";

// An agent's plain text (a question, an option) with its web addresses as
// links that open the whole address in the browser (lib/link-text). An
// option's text sits in its <label>: a link there opens and leaves the
// pick alone, by mouse and by keyboard. Wrap the text where it goes
// (wrap-anywhere): a long address has nowhere else to break.
export function LinkedText({ text }: { text: string }) {
  return linkParts(text).map((p, i) =>
    p.url ? (
      <a
        key={i}
        href={p.url}
        className="cv-link"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          void openUrl(p.url!);
        }}
        // Its keys stay its own: an arrow would reach the option's radio
        // group and pick. The app's shortcuts listen before this (capture).
        onKeyDown={(e) => e.stopPropagation()}
      >
        {p.text}
      </a>
    ) : (
      <Fragment key={i}>{p.text}</Fragment>
    ),
  );
}
