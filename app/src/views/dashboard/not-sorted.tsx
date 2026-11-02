import { CircleDashedIcon } from "lucide-react";

import { Tip } from "@/components/tip";

// NotSorted tags a card the sub-states couldn't place, so it sits in the
// first column. The board gives it to whichever card it shows, as one of the
// card's own lines, so every card style has it.
export function NotSorted() {
  return (
    <Tip label="Turn check couldn't place this one, so it sits in the first column. It may be off on this box, or not cover this agent, or not have been sure.">
      <div data-testid="not-sorted" className="flex w-fit items-center gap-1">
        <CircleDashedIcon className="size-3" aria-hidden />
        Not sorted
      </div>
    </Tip>
  );
}
