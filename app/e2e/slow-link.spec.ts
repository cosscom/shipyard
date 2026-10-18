import { BOX, fakeAgent, type FakeAgent } from "./fake-agent";
import { expect, mockOnly, test } from "./fixtures";

// A box on a slow link, relayed through a Tailscale server far away, stays
// online: the agent marks it slow (docs: concepts/laptop-agent#slow-and-dropping-networks),
// and the app says so quietly, never as offline, while requests to it go
// through. Settings › Boxes says why, and that Tailscale relays it.

let agent: FakeAgent;

test.beforeEach(async () => {
  mockOnly("runs on a stand-in agent");
  agent = await fakeAgent();
});

test.afterEach(async () => {
  await agent?.close();
});

const relayed = { via: "relay", relay: "nyc", relay_name: "New York", nearest: "London" };
const slow = { latency_ms: 1900, link: { slow: true, reason: "health check took 1.9s", max_ms: 1900, jitter_ms: 420, path: relayed } };

test("a box on a slow link stays online, says slow quietly, and its chat still loads", async ({ app }) => {
  agent.online = slow;
  await app.open({ agent, params: { view: "conversation" } });
  await app.openWorktree(`${BOX}/fix`);
  // Requests go through: the chat reads its conversation as usual.
  await expect(app.chat.getByText("The retry loop never backs off; fixed it.")).toBeVisible();
  // The sidebar's foot says online and slow, not offline; the box is no
  // row of its own in the list.
  const foot = app.page.getByTestId("sidebar-boxes");
  await expect(foot).toContainText(`${BOX} online`);
  await expect(foot.getByTestId("boxes-slow")).toHaveText("· slow");
  await expect(app.page.getByRole("group", { name: `${BOX}, online, slow link` })).toHaveCount(0);
  // Its tip says so beside the box's name.
  await foot.hover();
  await expect(app.page.getByTestId("boxes-tip-line").filter({ hasText: BOX })).toContainText("slow");
  // Nothing says it is away. (The stand-in has no terminals, so the one
  // under the chat keeps trying; the chat's own would say so.)
  await expect(app.chat.getByText(`Reconnecting to ${BOX}…`)).toHaveCount(0);
  await expect(app.page.getByText("offline", { exact: true })).toHaveCount(0);

  // Steady again (the agent says so with box.link): no word of it.
  agent.online = { latency_ms: 80, link: { max_ms: 1900, path: relayed } };
  agent.event({ type: "box.link", data: { slow: false } });
  await expect(app.page.getByTestId("boxes-slow")).toHaveCount(0);
  await expect(foot).toContainText(`${BOX} online`);
});

test("Settings › Boxes shows the latency, why the link is slow, and that Tailscale relays it", async ({ app }) => {
  agent.online = slow;
  await app.open({ agent });
  const boxes = await app.openSettings("boxes");
  await expect(boxes.getByText("Slow", { exact: true })).toBeVisible();
  const link = boxes.getByTestId("box-link");
  await expect(link).toContainText("Slow: health check took 1.9s. Shipyard stays connected, and requests still go through.");
  await expect(link).toContainText("Latency 1,900 ms.");
  const relay = boxes.getByTestId("box-relayed");
  await expect(relay).toContainText("Relayed through Tailscale's New York server: no direct connection (this computer's nearest is London).");
  await expect(relay.getByRole("button", { name: "Learn more" })).toBeVisible();
  // Online, so no Retry: it isn't reconnecting.
  await expect(boxes.getByRole("button", { name: "Retry" })).toHaveCount(0);

  // Steady but still relayed: the latency, how high it went, and the relay.
  agent.online = { latency_ms: 80, link: { max_ms: 1900, path: relayed } };
  agent.event({ type: "box.link", data: { slow: false } });
  await expect(boxes.getByText("80 ms · up to 1,900 ms")).toBeVisible();
  await expect(boxes.getByTestId("box-link")).not.toContainText("Slow:");
  await expect(boxes.getByTestId("box-relayed")).toBeVisible();
});
