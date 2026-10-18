import { useEffect, useState } from "react";

import { MenuCheckboxItem } from "@/components/ui/menu";
import { Spinner } from "@/components/ui/spinner";
import { toastManager } from "@/components/ui/toast";
import { errorMessage } from "@/lib/format";
import { call } from "@/lib/runs";

// AutoFix is a worktree's "Auto-fix this PR" settings on its box: failed
// checks go to the worktree's agent (the fix-ci run), and new review
// comments too (address-review, merged while it works), within a cap of
// runs a day.
export interface AutoFix {
  path: string;
  ci: boolean;
  review: boolean;
  check?: string;
  max?: number;
  agent?: string;
}

export const autofixApi = {
  list: async (box: string) => (await call<AutoFix[] | null>(box, "GET", "autofix")) ?? [],
  put: (box: string, a: AutoFix) => call<AutoFix[]>(box, "PUT", "autofix", a),
};

// AutoFixItems are the toggles, for a worktree's menu.
export function AutoFixItems({ box, path }: { box: string; path: string }) {
  const [a, setA] = useState<AutoFix>();
  useEffect(() => {
    autofixApi.list(box).then(
      (all) => setA(all.find((x) => x.path === path) ?? { path, ci: false, review: false }),
      () => setA({ path, ci: false, review: false }),
    );
  }, [box, path]);
  if (!a)
    return (
      <div className="flex items-center gap-2 px-2 py-1.5 text-muted-foreground text-meta">
        <Spinner className="size-3" /> Loading…
      </div>
    );
  const set = async (patch: Partial<AutoFix>) => {
    const next = { ...a, max: a.max || 3, ...patch };
    setA(next);
    try {
      await autofixApi.put(box, next);
      toastManager.add({ type: "success", title: next.ci || next.review ? "Auto-fix is on for this PR" : "Auto-fix is off", description: next.ci || next.review ? `At most ${next.max} runs a day each; it works through the worktree's agent.` : undefined });
    } catch (err) {
      setA(a);
      toastManager.add({ type: "error", title: "Couldn't change auto-fix", description: errorMessage(err) });
    }
  };
  return (
    <>
      <MenuCheckboxItem checked={a.ci} onCheckedChange={(ci) => void set({ ci })}>
        Fix failed checks
      </MenuCheckboxItem>
      <MenuCheckboxItem checked={a.review} onCheckedChange={(review) => void set({ review })}>
        Address review comments
      </MenuCheckboxItem>
      <div className="max-w-60 px-2 py-1.5 text-meta text-muted-foreground">Sends the worktree's agent the failing CI tail or the new comments, then pushes. 3 runs a day each.</div>
    </>
  );
}
