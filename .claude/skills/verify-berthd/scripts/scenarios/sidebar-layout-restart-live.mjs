// A real laptop agent restarts just as the app asks it for the sidebar's
// layout, as the first launch of an updated Mac app restarts its agent.
// The app keeps trying, and the saved layout replaces the default once the
// agent is back; nothing is written meanwhile. Run it through
// ../sidebar-layout-restart.sh, which seeds the layout (Kits pinned,
// Automations hidden), starts the agent (../agent-box.sh) and compares
// sidebar.json before and after. features/sidebar-nav.md.
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

export const live = true;
// The requests that meet the stopped agent.
export const allowErrors = [/ERR_CONNECTION_REFUSED/, /Failed to load resource/, /Failed to fetch/, /NetworkError/];

// The list sidebar, where the places are rows (nav-<id>).
export const params = { sidebar: "list" };

const agentBox = fileURLToPath(new URL("../agent-box.sh", import.meta.url));

export async function run({ page, shot, step, expect }) {
  const sidebar = page.getByTestId("sidebar");

  step("the saved layout shows: Kits pinned, Automations hidden");
  await expect(sidebar.getByTestId("nav-kits")).toBeVisible({ timeout: 20_000 });
  await expect(sidebar.getByTestId("nav-automations")).toHaveCount(0);
  await shot("1-saved-layout");

  step("start the app again; as it asks for the layout, the agent stops, and starts 2 s later");
  let restarted = false;
  let back;
  await page.route(/\/v1\/app\/sidebar(?:\?|$)/, async (route) => {
    if (!restarted && route.request().method() === "GET") {
      restarted = true;
      execFileSync(agentBox, ["stop"], { stdio: "inherit" });
      back = new Promise((resolve, reject) => {
        setTimeout(() => {
          const p = spawn(agentBox, ["start"], { stdio: "inherit" });
          p.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`agent-box.sh start: exit ${code}`))));
        }, 2000);
      });
    }
    await route.continue().catch(() => {});
  });
  await page.reload();
  await expect(sidebar.getByTestId("nav-home")).toBeVisible({ timeout: 30_000 });
  await expect.poll(() => restarted, { timeout: 30_000 }).toBe(true);
  await back;
  step("the agent is back: Kits pinned and Automations hidden again");
  await expect(sidebar.getByTestId("nav-kits")).toBeVisible({ timeout: 30_000 });
  await expect(sidebar.getByTestId("nav-automations")).toHaveCount(0);
  await shot("2-after-restart");

  step("Customize sidebar opens, with Kits under Pinned and Automations under Hidden");
  await page.getByTestId("nav-more").click();
  await page.getByTestId("nav-customize").click();
  const sheet = page.getByRole("dialog", { name: "Customize sidebar" });
  await expect(sheet).toBeVisible();
  await expect(sheet.locator("section", { has: page.getByRole("heading", { name: "Pinned" }) })).toContainText("Kits");
  await expect(sheet.locator("section", { has: page.getByRole("heading", { name: "Hidden" }) })).toContainText("Automations");
  await shot("3-customize");
  await sheet.getByRole("button", { name: "Done" }).click();
}
