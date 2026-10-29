import { expect, mockOnly, test } from "./fixtures";

// The list sidebar (the layout the specs pin, ?sidebar=list) is on the same
// two lanes as the rail's sheet (index.css, the grid): rows' highlight boxes
// on the edge, their glyphs and labels on the lane, every right end (a row's,
// the window strip's buttons, Settings) on the edge.

test("the list sidebar's boxes, their contents and their ends each line up", async ({ app }) => {
  mockOnly();
  await app.open();
  const page = app.page;
  await expect(app.worktree("devl/checkout-fix")).toBeVisible();
  const lanes = () =>
    page.evaluate(() => {
      const side = document.querySelector("[data-testid=sidebar]")!;
      const box = side.getBoundingClientRect();
      const q = (s: string) => side.querySelector(s)!.getBoundingClientRect();
      const row = side.querySelector("[data-testid=worktree-row][data-worktree='devl/checkout-fix']")!;
      const buttons = [...side.querySelectorAll("button")];
      // A project's header ("shop") and a section's name ("Work"), its
      // fold after it as a project's is.
      const header = buttons.find((b) => b.getAttribute("aria-expanded") !== null && b.querySelector("span")?.textContent === "shop")!.querySelector("span")!;
      const section = side.querySelector("[data-testid=project-section][data-section=Work] [data-testid=section-name]")!;
      const left = (r: DOMRect) => Math.round(r.left - box.left);
      const right = (r: DOMRect) => Math.round(box.right - r.right);
      return {
        boxes: [left(q("[data-testid=nav-home]")), left(row.getBoundingClientRect()), left(q("[data-testid=sidebar-boxes]"))],
        contents: [
          left(q("[data-testid=nav-home] svg")),
          left(header.getBoundingClientRect()),
          left(section.getBoundingClientRect()),
          left(row.querySelector("[role=img]")!.getBoundingClientRect()),
          left(q("[data-testid=sidebar-boxes] > span")),
        ],
        ends: [right(q("[data-testid=nav-home]")), right(row.getBoundingClientRect()), right(q("[data-testid=nav-settings]")), right(q("button[aria-label='Hide the sidebar']"))],
      };
    });
  const same = (xs: number[]) => xs.every((x) => x === xs[0]);
  await expect
    .poll(async () => {
      const l = await lanes();
      return same(l.boxes) && same(l.contents) && same(l.ends) && l.contents[0] > l.boxes[0];
    })
    .toBe(true);
});

// Sections are quiet dividers and projects the labels: a project's name is
// heavier and in fuller ink than its section's. The projects in no section
// come after the sections, under Other. An empty section (Personal, in the
// fixtures) is just its heading until a project is dragged; then it says
// where to drop it.
test("projects outrank their sections, the ones in none come last, and an empty section asks for a drop only during a drag", async ({ app }) => {
  mockOnly();
  await app.open();
  const page = app.page;
  const sections = page.getByTestId("project-section");
  await expect(sections.getByTestId("section-name")).toHaveText(["Work", "Personal", "Other"]);
  const look = await page.evaluate(() => {
    const style = (el: Element) => getComputedStyle(el);
    const section = style(document.querySelector("[data-testid=project-section][data-section=Work] [data-testid=section-name]")!);
    const project = style([...document.querySelectorAll("[data-testid=project-section][data-section=Work] button[aria-expanded] span")].find((s) => s.textContent === "shop")!);
    return { weights: [Number(section.fontWeight), Number(project.fontWeight)], sizes: [parseFloat(section.fontSize), parseFloat(project.fontSize)] };
  });
  expect(look.weights[1]).toBeGreaterThan(look.weights[0]);
  expect(look.sizes[1]).toBeGreaterThan(look.sizes[0]);

  const hint = page.locator("[data-testid=project-section][data-section=Personal] [data-testid=section-drop-hint]");
  await expect(page.getByTestId("section-drop-hint")).toHaveCount(0);
  const project = page.locator("[data-testid=project-section][data-section=Work] button[aria-expanded][draggable=true]").first();
  const drag = await page.evaluateHandle(() => new DataTransfer());
  await project.dispatchEvent("dragstart", { dataTransfer: drag });
  await expect(hint).toHaveText("Drop a project here");
  await project.dispatchEvent("dragend", { dataTransfer: drag });
  await expect(page.getByTestId("section-drop-hint")).toHaveCount(0);
});

test("a project dropped on an empty section's heading moves into it", async ({ app }) => {
  mockOnly();
  // Tall enough that nothing scrolls under the drag (sidebar-fleet.spec.ts).
  await app.page.setViewportSize({ width: 1440, height: 1100 });
  await app.open();
  const page = app.page;
  const personal = page.locator("[data-testid=project-section][data-section=Personal]");
  const evals = page.locator("[data-testid=project-section][data-section=Other] [draggable=true]", { hasText: "evals" });
  // Every box in, and the foot's notice too, so nothing moves mid-drag.
  await expect(evals).toBeVisible();
  await expect(page.getByTestId("skills-notices")).toBeVisible();
  await evals.dragTo(personal.getByTestId("section-name"));
  await expect(personal.locator("[draggable=true]", { hasText: "evals" })).toBeVisible();
});

// The row you open keeps its weight, so a long title is cut off in the same
// place before and after: only its tint and ink say it is open.
test("opening a row doesn't change its weight", async ({ app }) => {
  mockOnly();
  await app.open();
  const row = app.worktree("devl/checkout-fix");
  const weight = () => row.evaluate((el) => getComputedStyle(el).fontWeight);
  const before = await weight();
  await app.openWorktree("devl/checkout-fix");
  await expect(row).toHaveAttribute("data-active", "true");
  expect(await weight()).toBe(before);
});
