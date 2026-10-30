// Settings › Secrets (features/settings-secrets.md): each box's saved
// secrets by name and facts, never a value; a GCP project the box can't
// list says so; deleting a production secret needs its name typed, a
// staging one only a confirm; where a box saves them is chosen per box and
// per project.
//
// On the mock (devl keeps ACME_STRIPE_TEST in its encrypted file; gpu keeps
// ACME_PROD_DB in acme-prod and ACME_LEDGER_KEY in acme-staging, and can't
// list acme-legacy):
//
//   node drive.mjs settings-secrets --port $PORT

const WARN = /\btext-warning-foreground\b/;

export async function run({ page, shot, step, expect }) {
  step("open Settings › Secrets from the sidebar");
  await page.getByTestId("nav-settings").click();
  await page.getByTestId("settings-nav-secrets").click();
  const body = page.getByTestId("settings-secrets");
  await expect(body).toBeVisible();
  await expect(body.getByRole("heading", { name: "Secrets", level: 1 })).toBeVisible();

  step("each box lists names and facts: store, environment, expiry, who asked and why");
  const devl = body.getByTestId("secrets-devl");
  const gpu = body.getByTestId("secrets-gpu");
  const row = (box, name) => box.locator(`[data-testid=secret-row][data-name="${name}"]`);
  await expect(row(devl, "ACME_STRIPE_TEST")).toContainText("Encrypted file · Expires: in 4d · Saved 3d ago");
  await expect(row(devl, "ACME_STRIPE_TEST")).toContainText("Asked by Fix checkout webhook retries · Claude Code in shop: Replay the webhook fixtures against Stripe's test mode");
  await expect(row(devl, "ACME_STRIPE_TEST").getByTestId("secret-row-environment")).toHaveText("Staging");
  const prod = row(gpu, "ACME_PROD_DB");
  await expect(prod).toContainText("GCP Secret Manager · acme-prod · Expires: never · Saved 12d ago");
  await expect(prod.getByTestId("secret-row-environment")).toHaveText("Production");
  await expect(prod.locator(".text-desc")).toHaveClass(WARN);
  await expect(row(gpu, "ACME_LEDGER_KEY")).toContainText("GCP Secret Manager · acme-staging · Expires: in 22h");

  step("a project the box can't list says so");
  await expect(gpu.getByTestId("secrets-error")).toHaveText("Couldn't list GCP Secret Manager · acme-legacy: missing permission secretmanager.secrets.list on project acme-legacy");

  step("no value anywhere: no field for one, no Show, only names and facts");
  await expect(body.locator("input[type=password]")).toHaveCount(0);
  await expect(body.getByRole("button", { name: /^Show/ })).toHaveCount(0);
  await body.evaluate((el) => el.scrollTo(0, 0));
  await shot("1-secrets-list");

  step("where gpu saves them: its default store and GCP project, and evals' own store");
  await expect(gpu.getByRole("combobox", { name: "Default store on gpu" })).toHaveText("GCP Secret Manager");
  await expect(gpu.getByRole("textbox", { name: "GCP project on gpu" })).toHaveValue("acme-staging");
  await expect(gpu.getByRole("combobox", { name: "Store for evals on gpu" })).toHaveText("Encrypted file");
  await expect(gpu.getByRole("combobox", { name: "Store for shop on gpu" })).toHaveText("Box default");
  step("give shop its own GCP project, and save");
  await gpu.getByRole("combobox", { name: "Store for shop on gpu" }).click();
  await page.getByRole("option", { name: "GCP Secret Manager" }).click();
  await gpu.getByRole("textbox", { name: "GCP project for shop on gpu" }).fill("acme-shop");
  await gpu.getByTestId("secrets-settings-save-gpu").click();
  await expect(page.getByText("Saved where gpu keeps secrets")).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__berthCalls["PUT gpu/secrets/settings"] ?? 0)).toBe(1);
  await expect(gpu.getByTestId("secrets-settings-save-gpu")).toBeDisabled();
  await gpu.getByRole("textbox", { name: "GCP project for shop on gpu" }).scrollIntoViewIfNeeded();
  await shot("2-where-saved");

  step("delete the production secret: Delete stays disabled until its name is typed exactly");
  await prod.getByTestId("secret-row-delete").click();
  const dialog = page.getByTestId("secret-delete-dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("heading", { name: "Delete ACME_PROD_DB?" })).toBeVisible();
  const confirm = dialog.getByTestId("secret-delete-confirm");
  const del = dialog.getByTestId("secret-delete");
  await expect(del).toBeDisabled();
  await confirm.fill("ACME_PROD");
  await expect(del).toBeDisabled();
  await confirm.fill("acme_prod_db");
  await expect(del).toBeDisabled();
  await shot("3-production-delete-locked");
  await confirm.fill("ACME_PROD_DB");
  await expect(del).toBeEnabled();
  await shot("4-production-delete-typed");
  await del.click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => window.__berthCalls["POST gpu/secrets/delete"] ?? 0)).toBe(1);
  await expect(row(gpu, "ACME_PROD_DB")).toHaveCount(0);

  step("a staging secret deletes with a confirm alone");
  await row(devl, "ACME_STRIPE_TEST").getByTestId("secret-row-delete").click();
  await expect(dialog.getByTestId("secret-delete-confirm")).toHaveCount(0);
  await expect(dialog.getByTestId("secret-delete")).toBeEnabled();
  await dialog.getByTestId("secret-delete").click();
  await expect(row(devl, "ACME_STRIPE_TEST")).toHaveCount(0);
  await expect(devl).toContainText("No secrets yet");
  await body.evaluate((el) => el.scrollTo(0, 0));
  await shot("5-after-deletes");

  step("Find a setting finds it by what people call it");
  await body.getByRole("textbox", { name: "Find a setting" }).fill("api token");
  await expect(page.getByRole("option", { name: "Secrets" })).toBeVisible();
}
