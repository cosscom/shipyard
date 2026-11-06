// A launch on a worktree with hundreds of saved tabs (features/workspace-tabs.md):
// only the tab showing has its pane drawn; another draws when it is opened and
// stays drawn after. Before, every saved tab's pane mounted at launch, each
// with its terminal and chat, and the window grew to gigabytes.

const A = "devl:/home/me/work/shop-checkout-fix";
const OLD = 300;

export const initArg = {
  current: A,
  shown: [A],
  folded: [],
  tones: {},
  recentUrls: [],
  spaces: {
    [A]: {
      ref: { box: "devl", location: "shop", worktree: "checkout-fix", path: "/home/me/work/shop-checkout-fix" },
      tabs: [
        ...Array.from({ length: OLD }, (_, i) => ({
          id: `old-${i}`,
          root: { kind: "leaf", id: `old-pane-${i}`, content: { kind: "terminal", box: "devl", session: `old-task-${i}`, agent: "claude", command: "claude", title: `Old task ${i}`, view: "conversation" } },
          focus: `old-pane-${i}`,
        })),
        { id: "agent-tab", root: { kind: "leaf", id: "own", content: { kind: "terminal", box: "devl", session: "checkout-fix-claude", agent: "claude", command: "claude", view: "terminal" } }, focus: "own" },
      ],
      hidden: [],
      known: ["checkout-fix-claude", "svc-shop-checkout-fix-web", ...Array.from({ length: OLD }, (_, i) => `old-task-${i}`)],
      visitedAt: 1,
      active: "agent-tab",
    },
  },
};

// Seeded once, as a save left by an earlier run; a reload keeps what the app saved.
export const init = (state) => {
  if (sessionStorage.getItem("verify.seeded")) return;
  sessionStorage.setItem("verify.seeded", "1");
  localStorage.setItem("berth.prefs", JSON.stringify({ whatsNewSeen: "999.0.0" }));
  localStorage.setItem("berth.workspaces", JSON.stringify(state));
};

export async function run({ page, shot, step, expect }) {
  const drawn = page.locator('[data-testid="pane"]:has(> *)');
  const nodes = () => page.evaluate(() => document.getElementsByTagName("*").length);

  step(`launch on checkout-fix with ${OLD} saved tabs of ended sessions and its agent's tab in front`);
  await expect(page.getByRole("tab", { name: /Fix checkout webhook retries/ })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("tab", { name: /Old task 299\b/ })).toHaveCount(1);
  expect(await page.locator('[data-testid="pane"]').count()).toBeGreaterThan(OLD);
  await expect(drawn).toHaveCount(1);
  step(`one pane drawn of ${await page.locator('[data-testid="pane"]').count()}; ${await nodes()} DOM nodes`);
  await shot("1-launch");

  step("open 'Old task 7': its pane draws, the agent's stays drawn behind it");
  await page.getByRole("tab", { name: /Old task 7\b/ }).click();
  await expect(page.getByRole("tab", { name: /Old task 7\b/ })).toHaveAttribute("aria-selected", "true");
  await expect(drawn).toHaveCount(2);
  await shot("2-old-task");

  step("back to the agent's tab: nothing more is drawn, nothing redrawn");
  await page.getByRole("tab", { name: /Fix checkout webhook retries/ }).click();
  await expect(page.getByRole("tab", { name: /Fix checkout webhook retries/ })).toHaveAttribute("aria-selected", "true");
  await expect(drawn).toHaveCount(2);
  step(`${await nodes()} DOM nodes`);
  await shot("3-back");
}
