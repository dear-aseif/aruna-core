import { randomBytes } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { closeAllPools } from "../../src/server/db";
import { createBoardTask, createBoardTenant, type BoardTenant } from "../support/board-fixtures";
import { deleteTenants } from "../support/tenant-cleanup";
try {
  process.loadEnvFile(".env.local");
} catch {
  /* env may already be provided by the shell */
}
// Task 9.3: a task card opens its detail with the audit trail, on a phone (Pixel 7, the default project).
const run = randomBytes(4).toString("hex");
let A: BoardTenant;
let B: BoardTenant;
test.describe.configure({ mode: "serial" });
test.beforeAll(async () => {
  A = await createBoardTenant("da", run);
  B = await createBoardTenant("db", run);
});
test.afterAll(async () => {
  await deleteTenants([A.tenantId, B.tenantId]);
  await closeAllPools();
});
async function signIn(page: Page, t: BoardTenant) {
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill(t.email);
  await page.getByLabel("Password").fill(t.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/board$/, { timeout: 15_000 });
}
test("phone: card shows agent, origin and history; detail shows the audit trail; no sideways scroll", async ({ page }) => {
  const id = await createBoardTask(A, `Detail ${run}`, "pending_approval");
  await signIn(page, A);
  const card = page.locator(`[data-task-id="${id}"]`);
  await expect(card.getByTestId("task-agent")).toHaveText("booking");
  await expect(card.getByTestId("task-origin")).toHaveText("Direct");
  await expect(card.getByTestId("task-checks").getByTestId("task-check")).toHaveCount(1);
  await card.getByRole("button", { name: "Approve" }).click();
  await expect(page.getByTestId("column-pending_approval").locator(`[data-task-id="${id}"]`)).toHaveCount(0, { timeout: 20_000 }); // moved out of Pending Approval
  await page.getByTestId("status-chips").locator('[data-status="done"]').click();
  await page.getByTestId("column-done").locator(`[data-task-id="${id}"]`).getByRole("link", { name: "Open details" }).click();
  await expect(page).toHaveURL(new RegExp(`/board/${id}$`));
  const detail = page.getByTestId("task-detail");
  await expect(detail.getByTestId("status-badge")).toHaveAttribute("data-status", "done");
  await expect(detail.getByTestId("task-approval")).toHaveCount(1);
  const types = await detail.getByTestId("audit-entry").evaluateAll((els) => els.map((e) => e.getAttribute("data-type")));
  expect(types[0]).toBe("task.transition");
  expect(types).toEqual(expect.arrayContaining(["checker.result", "approval.decision"]));
  await expect(detail.getByTestId("task-created")).toContainText("GMT+8");
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
});
test("another tenant's task detail is a 404 page", async ({ page }) => {
  const foreign = await createBoardTask(B, `Secret ${run}`, "working");
  await signIn(page, A);
  const res = await page.goto(`/board/${foreign}`);
  expect(res?.status()).toBe(404);
  await expect(page.getByText(`Secret ${run}`)).toHaveCount(0);
});
