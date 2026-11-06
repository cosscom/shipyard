// Attention items on a real box, read from two computers
// (features/plugins.md, plugin-attention): a snooze made in a plugin on
// laptop A is what the same plugin reads on laptop B, though B's own plugin
// storage is empty; B resolving an item shows on A at once, from the box's
// event; and an open item settles on both when its session ends.
//
// On ../attention-live.sh (one box "devq", laptop A on 9472, laptop B on
// 9474):
//
//   ../attention-live.sh up && eval "$(../attention-live.sh env)"
//   node drive.mjs attention-two-laptops-live --port $PORT --agent http://127.0.0.1:9472
//
// It starts a shell session "att-shell" in acme-shop and posts two asks
// about it, as an agent would.

export const live = true;
export const params = { labs: "0" };

const BOX = "devq";
const SESSION = "att-shell";
const ASK = `session:${SESSION}`;
const DEPLOY = "acme/deploy-check";
const UNTIL = "2030-01-02T09:00:00Z";
const AGENT_B = process.env.VERIFY_AGENT_B ?? "http://127.0.0.1:9474";
const TOKEN_B = process.env.VERIFY_BERTH_TOKEN_B;

export const plugins = [
  {
    id: "attention-check",
    name: "Attention check",
    source: `
import { createElement as h, useEffect, useState } from "react";
export default function (berth) {
  const BOX = ${JSON.stringify(BOX)};
  const Screen = () => {
    const [items, setItems] = useState(null);
    const [error, setError] = useState("");
    const [local, setLocal] = useState(berth.storage.get("snoozed", ""));
    const load = () => berth.attention.list(BOX).then(setItems, (e) => setError(e.message));
    useEffect(() => {
      load();
      return berth.on("attention.*", load);
    }, []);
    const act = (key, change, note) => {
      if (note) {
        berth.storage.set("snoozed", note);
        setLocal(note);
      }
      berth.attention.update(BOX, key, change).then(load, (e) => setError(e.message));
    };
    const line = (it) =>
      it.key + " · " + it.kind + " · " + it.status + (it.closed_reason ? " (" + it.closed_reason + ")" : "") +
      " · " + (it.snoozed_until ? "snoozed until " + it.snoozed_until : "not snoozed") + " · rev " + it.revision + " · by " + it.by;
    return h("div", { style: { padding: 16, display: "grid", gap: 8 } },
      h("p", null, "berth.attention is " + typeof berth.attention),
      h("p", { "data-testid": "att-local" }, "This computer's plugin storage: " + (local || "nothing")),
      error && h("p", { role: "alert" }, error),
      h("ul", { "aria-label": "Attention items" }, (items ?? []).map((it) =>
        h("li", { key: it.key },
          h("span", { "data-testid": "att-row" }, line(it)),
          it.title && h("span", null, " — " + it.title),
          " ",
          h("button", { onClick: () => act(it.key, { snoozed_until: ${JSON.stringify(UNTIL)}, revision: it.revision }, it.key) }, "Snooze " + it.key),
          " ",
          h("button", { onClick: () => act(it.key, { status: "closed", revision: it.revision }) }, "Resolve " + it.key),
        ))),
      items && h("p", null, items.length + " items on " + BOX),
    );
  };
  berth.addScreen({ id: "attention-check", title: "Attention check", Component: Screen });
  berth.addSidebarItem({ id: "attention-check", title: "Attention check", icon: "Bell", screen: "attention-check" });
}
`,
  },
];

const openScreen = async (page, expect) => {
  await page.getByTestId("nav-more").click();
  await page.getByRole("menu").getByRole("menuitem", { name: "Attention check" }).click();
  await expect(page.getByText("berth.attention is object")).toBeVisible();
};

const row = (page, key) => page.getByTestId("att-row").filter({ hasText: new RegExp(`^${key.replace(/[/#]/g, "\\$&")} ·`) });

export async function run({ page, shot, step, expect, call, out }) {
  if (!TOKEN_B) throw new Error("VERIFY_BERTH_TOKEN_B is not set: eval \"$(attention-live.sh env)\"");
  const box = (path, init) => call(`/v1/boxes/${BOX}/api${path}`, init);
  const info = await box("/info");
  if (!info.capabilities?.includes("attention")) throw new Error(`${BOX} doesn't list the attention capability: ${info.capabilities}`);

  step(`start a shell session ${SESSION} in acme-shop, and post two asks about it as its agent would`);
  await box("/sessions", { method: "POST", body: JSON.stringify({ location: "acme-shop", name: SESSION, command: "cat" }) });
  await box("/attention", { method: "POST", body: JSON.stringify({ session: SESSION, kind: "decision", title: "Ship the acme checkout on Friday?", options: [{ label: "Yes" }, { label: "Not yet" }], recommended: "Not yet" }) });
  await box("/attention", { method: "POST", body: JSON.stringify({ key: DEPLOY, session: SESSION, kind: "action", title: "Log in to the acme staging deploy" }) });

  step("laptop A: open the plugin's screen; both asks are open and not snoozed");
  await openScreen(page, expect);
  await expect(row(page, ASK)).toHaveText(`${ASK} · decision · open · not snoozed · rev 1 · by app`);
  await expect(row(page, DEPLOY)).toHaveText(`${DEPLOY} · action · open · not snoozed · rev 1 · by app`);
  await expect(page.getByTestId("att-local")).toHaveText("This computer's plugin storage: nothing");
  await shot("1-a-two-open-asks");

  step(`laptop A: snooze ${ASK} until ${UNTIL} (the plugin also notes it in its own storage on A)`);
  await page.getByRole("button", { name: `Snooze ${ASK}` }).click();
  await expect(row(page, ASK)).toHaveText(`${ASK} · decision · open · snoozed until ${UNTIL} · rev 2 · by app`);
  await expect(page.getByTestId("att-local")).toHaveText(`This computer's plugin storage: ${ASK}`);
  await shot("2-a-snoozed");

  step("laptop B: another browser, its own laptop agent paired with the same box, its own plugin storage");
  const browser = page.context().browser();
  const ctxB = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "dark" });
  await ctxB.route(/^https?:\/\/(?:[^/]*\.)?(?:localhost|127\.0\.0\.1|\[::1\]):(?:1377|1378|1379)(?:\/|$)/, (r) => r.abort());
  const pageB = await ctxB.newPage();
  const errorsB = [];
  pageB.on("console", (m) => m.type() === "error" && errorsB.push(m.text()));
  pageB.on("pageerror", (e) => errorsB.push(e.message));
  await pageB.route("**/builtin-plugins/index.json", async (r) => {
    const res = await r.fetch();
    const list = await res.json();
    await r.fulfill({ response: res, json: [...list, ...plugins.map((p) => ({ id: p.id, name: p.name, version: "0.0.0-verify", main: "index.js" }))] });
  });
  for (const p of plugins) await pageB.route(`**/builtin-plugins/${p.id}/index.js`, (r) => r.fulfill({ contentType: "text/javascript", body: p.source }));
  const origin = new URL(page.url()).origin;
  await pageB.goto(`${origin}/?${new URLSearchParams({ token: TOKEN_B, agent: AGENT_B, ...params })}`);
  await expect(pageB.getByTestId("nav-home")).toBeVisible({ timeout: 20_000 });
  // B's screenshots go beside the driver's own.
  const shotB = (label) => pageB.screenshot({ path: `${out}/${label}.png` });
  try {
    await openScreen(pageB, expect);
    step("laptop B: the snooze made on A is there, read from the box; B's own plugin storage has nothing");
    await expect(row(pageB, ASK)).toHaveText(`${ASK} · decision · open · snoozed until ${UNTIL} · rev 2 · by app`);
    await expect(pageB.getByTestId("att-local")).toHaveText("This computer's plugin storage: nothing");
    await shotB("3-b-reads-the-snooze");

    step(`laptop B: resolve ${ASK}; laptop A shows it closed without a reload, from the box's attention.updated event`);
    await pageB.getByRole("button", { name: `Resolve ${ASK}` }).click();
    await expect(row(pageB, ASK)).toHaveText(`${ASK} · decision · closed (resolved) · snoozed until ${UNTIL} · rev 3 · by app`);
    await expect(row(page, ASK)).toHaveText(`${ASK} · decision · closed (resolved) · snoozed until ${UNTIL} · rev 3 · by app`);
    await shot("4-a-sees-b-resolve");

    step(`a stale write is refused: A snoozes ${ASK} again from revision 2`);
    const stale = await fetch(`${AGENT_B}/v1/boxes/${BOX}/api/attention/${encodeURIComponent(ASK)}`, { method: "PATCH", headers: { Authorization: `Bearer ${TOKEN_B}`, "Content-Type": "application/json" }, body: JSON.stringify({ revision: 2, snoozed_until: "" }) });
    if (stale.status !== 409) throw new Error(`a stale revision answered ${stale.status}, not 409`);

    step(`end session ${SESSION}: its open ask ${DEPLOY} settles on both laptops, as the box's own change`);
    await box(`/sessions/${SESSION}`, { method: "DELETE" });
    await expect(row(page, DEPLOY)).toHaveText(`${DEPLOY} · action · closed (session_ended) · not snoozed · rev 2 · by berth`);
    await expect(row(pageB, DEPLOY)).toHaveText(`${DEPLOY} · action · closed (session_ended) · not snoozed · rev 2 · by berth`);
    await shot("5-a-session-ended");
    await shotB("6-b-session-ended");

    step("second view: the box's API through laptop B says the same");
    const res = await fetch(`${AGENT_B}/v1/boxes/${BOX}/api/attention`, { headers: { Authorization: `Bearer ${TOKEN_B}` } });
    const items = await res.json();
    const ask = items.find((i) => i.key === ASK);
    const deploy = items.find((i) => i.key === DEPLOY);
    if (ask?.status !== "closed" || ask.closed_reason !== "resolved" || ask.snoozed_until !== UNTIL || deploy?.closed_reason !== "session_ended") {
      throw new Error(`the box holds ${JSON.stringify(items)}`);
    }
    step(`GET attention on laptop B: ${ASK} closed (resolved), snoozed until ${UNTIL}; ${DEPLOY} closed (session_ended)`);
    if (errorsB.length) throw new Error(`laptop B's console: ${errorsB.join(" | ")}`);
  } catch (err) {
    await shotB("failed-b").catch(() => {});
    throw err;
  } finally {
    await ctxB.close();
  }
}
