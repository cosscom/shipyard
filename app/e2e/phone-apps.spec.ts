import { expect, mockOnly, test } from "./fixtures";

// Settings › Phone › Phone apps: the Shipyard phone apps a box notifies
// through the push relay, and removing one.

test("a phone that gets notifications is listed with its box, and Remove stops them", async ({ app }) => {
  mockOnly("turning phone access on writes to a box");
  await app.open();
  const phone = await app.openSettings("phone");
  const apps = phone.locator("section").filter({ has: app.page.getByRole("heading", { name: "Phone apps", exact: true }) });
  await expect(apps).toContainText("No phone gets notifications yet");

  await phone.getByRole("switch", { name: "Phone access on devl" }).click();
  await expect(apps).toContainText("Acme iPhone");
  await expect(apps).toContainText("devl · needs you");

  await apps.getByRole("button", { name: "Remove" }).click();
  await expect(apps).toContainText("No phone gets notifications yet");
});
