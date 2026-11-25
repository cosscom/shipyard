// A flow its runs-per-hour limit holds back, on a real box
// (features/flows.md, flows-limit-live): a box flow "every-minute" with
// schedule * * * * * and a limit of 2, started three times through the
// box's POST /v1/runs. Two start, the third is refused with 429, berthd's
// log says the flow reached its limit, GET /v1/flows counts the refusal and
// warns of the schedule, and the app shows both. Raising the limit lets a
// start through, and the log sums the refusals up.
//
// On a dev box of this checkout (../dev-box.sh):
//
//   node drive.mjs flows-limit-live --port $PORT --agent http://127.0.0.1:9378
//
// The flow is off (it never fires by itself, so the counts are the
// scenario's own) and the box's flows are put back as they were.

import { readFileSync } from "node:fs";

export const live = true;
export const params = { labs: "0" };

const BOX = (process.env.VERIFY_WORKTREE ?? "devq/acme-shop").split("/")[0];
const LOG = `${process.env.VERIFY_BOX_DIR ?? "/tmp/verify-berthd-box"}/berthd.log`;
const flow = (limit) => ({ id: "every-minute", name: "Every minute", enabled: false, max_runs_per_hour: limit, trigger: { schedule: "* * * * *" }, steps: [{ kind: "run", command: "true" }] });

export async function run({ page, shot, step, expect, call }) {
  const api = (path, init) => call(`/v1/boxes/${BOX}/api/${path}`, init);
  const put = (flows) => api("flows", { method: "PUT", body: JSON.stringify({ flows }) });
  const start = () => api("runs", { method: "POST", body: JSON.stringify({ flow_id: "every-minute", scope: "box" }) }).then(() => 202, (err) => Number(err.message.match(/: (\d{3}) /)?.[1] ?? 0));
  const listed = async () => (await api("flows")).find((f) => f.scope === "box" && f.flow.id === "every-minute");
  const log = () => readFileSync(LOG, "utf8");

  const before = (await api("flows")).filter((f) => f.scope === "box").map((f) => f.flow);
  try {
    step("a box flow every-minute: * * * * *, at most 2 runs an hour");
    await put([...before.filter((f) => f.id !== "every-minute"), flow(2)]);

    step("start it three times through POST /v1/runs: 202, 202, then 429");
    const codes = [await start(), await start(), await start()];
    expect(codes).toEqual([202, 202, 429]);

    step("berthd.log says once that it reached its limit");
    expect(log().match(/flows: box\/every-minute reached its limit of 2 runs an hour; refusing its starts \(first from api\)/g)).toHaveLength(1);

    step("GET /v1/flows counts the refusal and warns of the schedule");
    const f = await listed();
    expect(f.refused_last_hour).toBe(1);
    expect(f.last_refused_at).toBeTruthy();
    expect(f.fires_per_hour).toBe(60);
    expect(f.warning).toBe("This schedule fires up to 60 times an hour; the limit is 2, so about 58 starts an hour will be refused.");

    step("the app's flow list shows the badge");
    await page.getByTestId("nav-automations").click();
    // Off the sidebar, so no row's tooltip covers the shots.
    await page.mouse.move(1200, 880);
    const row = page.getByRole("button").filter({ hasText: "Every minute" });
    await expect(row.getByTestId("flow-limit-badge")).toHaveText("Limit reached · 1 refused in the last hour", { timeout: 15_000 });
    await shot("1-flow-list-badge");

    step("its editor shows the badge and the warning by At most");
    await row.click();
    await expect(page.getByTestId("flow-limit-badge")).toHaveText("Limit reached · 1 refused in the last hour");
    const warning = page.getByTestId("flow-rate-warning");
    await expect(warning).toHaveText("This schedule fires up to 60 times an hour; the limit is 2, so about 58 starts an hour will be refused.");
    await warning.scrollIntoViewIfNeeded();
    await shot("2-editor-warning");

    step("raise the limit to 10: the next start goes through, and the log sums up the refusal");
    await put([...before.filter((f) => f.id !== "every-minute"), flow(10)]);
    expect(await start()).toBe(202);
    expect(log()).toMatch(/flows: box\/every-minute: 1 start refused \d\d:\d\d–\d\d:\d\d/);
  } finally {
    step("put the box's flows back");
    await put(before);
  }
}
