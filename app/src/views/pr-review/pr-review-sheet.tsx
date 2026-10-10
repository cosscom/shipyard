import { Suspense, useRef } from "react";

import { Sheet, SheetPopup } from "@/components/ui/sheet";
import { lazyView } from "@/lib/lazy-view";
import { closeReviewSheet, usePrReview } from "@/lib/pr-review";

// PrReviewSheet's frame (review-sheet.tsx is what it shows): its content
// loads after the app has started.
const PrReviewBody = lazyView(() => import("@/views/pr-review/review-sheet").then((m) => m.PrReviewBody));

export function PrReviewSheet() {
  const sheet = usePrReview((s) => s.sheet);
  const popup = useRef<HTMLDivElement>(null);
  return (
    <Sheet open={!!sheet} onOpenChange={(open) => !open && closeReviewSheet()}>
      <SheetPopup ref={popup} initialFocus={popup} data-testid="pr-review-sheet" className="w-[min(600px,100vw)] max-w-none outline-none">
        <Suspense>{sheet && <PrReviewBody key={`${sheet.nonce}`} />}</Suspense>
      </SheetPopup>
    </Sheet>
  );
}
