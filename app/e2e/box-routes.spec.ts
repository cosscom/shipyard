import { expect, mockOnly, test } from "./fixtures";

// Settings › Boxes shows how this computer reaches each box: the mock's devl
// was added over SSH, which is faster than its relayed Tailscale route, and
// gpu has an SSH host in ~/.ssh/config that is offered, off.

test.beforeEach(() => mockOnly("the routes are mock fixtures"));

test("a box's routes show with their latency and the one in use, and can be added and turned off", async ({ app }) => {
  const { page } = app;
  await app.open();
  const boxes = await app.openSettings("boxes");
  const devl = boxes.getByTestId("box-routes").first();
  await expect(devl.getByTestId("box-routes-summary")).toHaveText("via SSH, 24 ms · Tailscale relayed, 140 ms");
  // Tailscale relays devl, but Shipyard goes over SSH meanwhile.
  await expect(boxes.getByTestId("box-relayed").first()).toContainText("Shipyard goes via SSH instead");

  await devl.getByTestId("box-routes-toggle").click();
  const list = boxes.getByTestId("box-route-list");
  const ssh = list.getByTestId("box-route-ssh");
  await expect(ssh).toContainText("alex@devl");
  await expect(ssh).toContainText("in use");
  await expect(list.getByTestId("box-route-paired")).toContainText("140 ms");

  // SSH off: Tailscale carries the box.
  await ssh.getByRole("switch").click();
  await expect(devl.getByTestId("box-routes-summary")).toHaveText("via Tailscale relayed, 140 ms");
  await expect(list.getByTestId("box-route-ssh")).toContainText("off");
  // The one route left on can't be turned off.
  await expect(list.getByTestId("box-route-paired").getByRole("switch")).toBeDisabled();

  // An address of its own on the LAN.
  await list.getByTestId("box-route-new").click();
  await list.getByTestId("box-route-add-input").fill("192.168.1.20:7444");
  await list.getByTestId("box-route-add").click();
  await expect(list.getByTestId("box-route-direct:192.168.1.20:7444")).toContainText("9 ms");
  await expect(devl.getByTestId("box-routes-summary")).toContainText("Direct, 9 ms");
  await expect(page.getByText("Couldn't add the route")).toHaveCount(0);
});

test("an SSH host named like the box is offered, and turning it on adds it", async ({ app }) => {
  await app.open();
  const boxes = await app.openSettings("boxes");
  const gpu = boxes.getByTestId("box-routes").nth(1);
  await gpu.getByTestId("box-routes-toggle").click();
  const list = boxes.getByTestId("box-route-list");
  const offered = list.getByTestId("box-route-ssh");
  await expect(offered).toContainText("in ~/.ssh/config");
  await offered.getByRole("switch").click();
  await expect(list.getByTestId("box-route-ssh")).toContainText("31 ms");
  await expect(gpu.getByTestId("box-routes-summary")).toContainText("SSH, 31 ms");
});

test("the sidebar's foot names the route each box is reached by, and how busy it is", async ({ app }) => {
  const { page } = app;
  await app.open();
  await page.getByTestId("sidebar-boxes").hover();
  const devl = page.getByTestId("boxes-tip-line").filter({ hasText: "devl" });
  await expect(devl).toContainText("via SSH");
  await expect(devl).toContainText("% mem");
});
