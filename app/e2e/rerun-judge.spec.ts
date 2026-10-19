import { expect, mockOnly, test } from "./fixtures";

// Review's Compare for an attempts run waiting for a pick: the judge can be
// asked again about the attempts as they are now. The mock's first rerun
// gets a reply that isn't valid (the checks' pick stands in, with Retry);
// the next ranks attempt 2 first, now that its agent has moved on.

test("Rerun judge judges the attempts again, says a fallback isn't a verdict, and keeps the earlier evaluations", async ({ app }) => {
  mockOnly("the attempts run and its judge are mock fixtures");
  await app.open();
  const { page } = app;
  await page.getByTestId("nav-review").click();
  await page.getByRole("button", { name: /refunds: 3 attempts · pick one/ }).click();

  const judge = page.getByRole("region", { name: "Judge on devl" });
  await expect(judge).toHaveAttribute("data-evaluation", "verdict");
  await expect(judge).toContainText("Winner: attempt 3.");
  await expect(judge).toContainText("Evaluation 1, the run's own by claude");
  // It says which versions it judged, and attempt 2 has moved on since.
  await expect(judge.locator("[data-version='1']")).toContainText("a17f0c9");
  const attempt2 = page.locator("section", { hasText: "Attempt 2" }).filter({ hasText: "refunds-a2" }).first();
  await expect(attempt2.getByText("changed since judged")).toBeVisible();
  await expect(attempt2).toContainText("e4d2a91 + uncommitted");

  // Rerun: the judge looks while the run keeps waiting for the pick.
  await judge.getByRole("button", { name: "Rerun judge" }).click();
  await expect(judge.getByText(/judging the attempts as they are now/)).toBeVisible();
  await expect(judge.getByRole("button", { name: "Judging…" })).toBeDisabled();

  // Its reply isn't valid: a failure, with the checks' pick as a fallback,
  // said apart from a verdict.
  await expect(judge).toHaveAttribute("data-evaluation", "fallback", { timeout: 15_000 });
  await expect(judge).toContainText("No valid verdict from the judge");
  await expect(judge).toContainText("Fallback: the checks' pick");
  await expect(judge).toContainText("The judge's reply was not valid (no JSON object in the reply).");
  await expect(judge).toContainText("This is a fallback, not the judge's verdict.");
  const attempt3 = page.locator("section", { hasText: "Attempt 3" }).filter({ hasText: "refunds-a3" }).first();
  await expect(attempt3.getByText("checks' pick")).toBeVisible();
  await expect(page.getByText("judge's pick")).toHaveCount(1); // gpu's own judge

  // Retry: a verdict this time, on the worktrees as they are now.
  await judge.getByRole("button", { name: "Retry" }).click();
  await expect(judge).toHaveAttribute("data-evaluation", "verdict", { timeout: 15_000 });
  await expect(judge).toContainText("Winner: attempt 2.");
  await expect(judge).toContainText("Evaluation 3, a rerun by claude");
  await expect(judge).toContainText("Since evaluation 2: the winner changed from attempt 3 to attempt 2.");
  await expect(judge.locator("[data-version='1']")).toContainText("e4d2a91 + uncommitted");
  await expect(attempt2.getByText("changed since judged")).toHaveCount(0);
  await expect(attempt2).toContainText("#1 · passes, and since the last look");

  // The earlier evaluations are kept, to see what changed.
  await judge.getByRole("button", { name: "Earlier evaluations (2)" }).click();
  const earlier = judge.getByRole("list", { name: "Earlier evaluations" });
  await expect(earlier.getByRole("listitem")).toHaveCount(2);
  await expect(earlier.getByRole("listitem").first()).toContainText("Fallback by checks");
  await expect(earlier.getByRole("listitem").last()).toContainText("Winner: attempt 3.");

  // Still the person's to pick: nothing was picked, published or archived.
  await expect(page.getByRole("button", { name: "Pick this one" })).toHaveCount(4);
  await expect(page.getByText(/^picked$/)).toHaveCount(0);
});
