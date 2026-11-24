import { randomBytes } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { withTenant } from "../../src/server/dal";
import { closeAllPools } from "../../src/server/db";
import { createBoardTask, createBoardTenant, taskState, type BoardTenant } from "../support/board-fixtures";
import { deferTenantCleanup } from "../support/ledger";

try {
  process.loadEnvFile(".env.local");
} catch {
  /* env may already be provided by the shell */
}

// Task 9.2: the board on a phone (Pixel 7, the default project) and on a wide viewport.
const run = randomBytes(4).toString("hex");
let A: BoardTenant;
let B: BoardTenant;

test.describe.configure({ mode: "serial" });
test.beforeAll(async () => {
  A = await createBoardTenant("a", run);
  B = await createBoardTenant("b", run);
});
test.afterAll(async () => {
  deferTenantCleanup([A.tenantId, B.tenantId]);
  await closeAllPools();
});

async function signIn(page: Page, t: BoardTenant) {
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill(t.email);
  await page.getByLabel("Password").fill(t.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/board$/);
}
const chip = (page: Page, status: string) => page.getByTestId("status-chips").locator(`[data-status="${status}"]`);
const column = (page: Page, status: string) => page.getByTestId(`column-${status}`);
const noSidewaysScroll = async (page: Page) => expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);

test("phone: a per-status stack with filter chips, one status at a time", async ({ page }) => {
  const pending = `Pending ${run} phone`;
  await createBoardTask(A, pending, "pending_approval");
  await createBoardTask(A, `Done ${run} phone`, "done");
  await signIn(page, A);
  await expect(page.getByTestId("status-chips")).toBeVisible();
  await expect(page.getByTestId("status-chips").getByRole("button")).toHaveCount(8);
  // The status that needs the owner opens first; the other seven columns are not shown.
  await expect(column(page, "pending_approval")).toBeVisible();
  await expect(column(page, "pending_approval").getByText(pending)).toBeVisible();
  for (const s of ["queued", "working", "in_review", "done", "rejected", "expired", "failed"]) await expect(column(page, s)).toBeHidden();
  await chip(page, "done").click();
  await expect(column(page, "done").getByText(`Done ${run} phone`)).toBeVisible();
  await expect(column(page, "pending_approval")).toBeHidden();
  await expect(chip(page, "done")).toHaveAttribute("aria-pressed", "true");
  await noSidewaysScroll(page);
});

test("wide viewport: every status is a column and the chips are gone", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await signIn(page, A);
  await expect(page.getByTestId("status-chips")).toBeHidden();
  for (const s of ["queued", "working", "in_review", "pending_approval", "done", "rejected", "expired", "failed"]) await expect(column(page, s)).toBeVisible();
  await expect(column(page, "pending_approval").getByText(`Pending ${run} phone`)).toBeVisible();
  await expect(column(page, "done").getByText(`Done ${run} phone`)).toBeVisible();
});

test("phone: approve changes the task through the approval gate exactly once", async ({ page }) => {
  const title = `Approve ${run}`;
  const id = await createBoardTask(A, title, "pending_approval");
  await signIn(page, A);
  const card = column(page, "pending_approval").locator(`[data-task-id="${id}"]`);
  await expect(card.getByTestId("task-draft")).toContainText("Contoh Pelanggan");
  await expect(card.getByTestId("task-deadline")).toHaveText(/^\d{2}:\d{2}$/);
  await card.getByRole("button", { name: "Approve" }).dblclick(); // a double tap must not run it twice
  await expect(card).toHaveCount(0);
  await chip(page, "done").click();
  await expect(column(page, "done").locator(`[data-task-id="${id}"]`)).toBeVisible();
  expect(await taskState(A, id)).toMatchObject({ status: "done", decisions: 1, executions: 1 });
});

test("phone: reject changes the task through the approval gate and runs nothing", async ({ page }) => {
  const id = await createBoardTask(A, `Reject ${run}`, "pending_approval");
  await signIn(page, A);
  await column(page, "pending_approval").locator(`[data-task-id="${id}"]`).getByRole("button", { name: "Reject" }).click();
  await expect(column(page, "pending_approval").locator(`[data-task-id="${id}"]`)).toHaveCount(0);
  await chip(page, "rejected").click();
  await expect(column(page, "rejected").locator(`[data-task-id="${id}"]`)).toBeVisible();
  expect(await taskState(A, id)).toMatchObject({ status: "rejected", decisions: 1, executions: 0 });
});

test("phone: editing a Pending Approval draft re-checks it and returns it to Pending Approval at the new revision", async ({ page }) => {
  const id = await createBoardTask(A, `Revise ${run}`, "pending_approval");
  await signIn(page, A);
  const card = column(page, "pending_approval").locator(`[data-task-id="${id}"]`);
  await card.getByRole("button", { name: "Edit draft" }).click();
  await card.getByLabel("slot").fill("11:30");
  await card.getByRole("button", { name: "Save changes" }).click();
  // The same card is back in Pending Approval, showing the revised value; nothing is left In Review.
  // Revise + Checker pass + board refresh can take several seconds on the dev server.
  await expect(card.getByTestId("task-draft")).toContainText("11:30", { timeout: 20_000 });
  await chip(page, "in_review").click();
  await expect(column(page, "in_review").locator(`[data-task-id="${id}"]`)).toHaveCount(0);
  expect(await taskState(A, id)).toMatchObject({ status: "pending_approval", revision: 2, executions: 0 });
});

test("an overdue task shows Expired, never Pending Approval, and cannot be approved", async ({ page }) => {
  const title = `Overdue ${run}`;
  const id = await createBoardTask(A, title, "overdue");
  await signIn(page, A);
  await expect(column(page, "pending_approval").getByText(title)).toHaveCount(0);
  await chip(page, "expired").click();
  const card = column(page, "expired").locator(`[data-task-id="${id}"]`);
  await expect(card).toBeVisible();
  await expect(card.getByTestId("status-badge")).toHaveText("Expired");
  await expect(card.getByRole("button", { name: "Approve" })).toHaveCount(0);
  expect(await taskState(A, id)).toMatchObject({ status: "expired", executions: 0 });
});

test("a task that lapses while the board is open cannot be approved: the owner is told and it shows Expired", async ({ page }) => {
  const id = await createBoardTask(A, `Lapse ${run}`, "pending_approval");
  await signIn(page, A);
  const card = column(page, "pending_approval").locator(`[data-task-id="${id}"]`);
  await expect(card).toBeVisible();
  await withTenant(A.agent, (tx) => tx.query("update tasks set approval_expires_at = clock_timestamp() - interval '1 minute' where id = $1", [id]));
  await card.getByRole("button", { name: "Approve" }).click();
  await expect(page.getByTestId("board-notice")).toContainText("expired");
  await chip(page, "expired").click();
  await expect(column(page, "expired").locator(`[data-task-id="${id}"]`)).toBeVisible();
  expect(await taskState(A, id)).toMatchObject({ status: "expired", decisions: 0, executions: 0 });
});

test("another tenant's tasks never render, on any viewport or through the board API", async ({ page }) => {
  const secret = `Secret ${run} other tenant`;
  await createBoardTask(B, secret, "pending_approval");
  await createBoardTask(B, `${secret} done`, "done");
  await signIn(page, A);
  await page.setViewportSize({ width: 1400, height: 900 });
  await expect(page.getByTestId("board-columns")).toBeVisible();
  await expect(page.getByText(secret)).toHaveCount(0);
  const cookie = (await page.context().cookies()).map((c) => `${c.name}=${c.value}`).join("; ");
  const res = await page.request.get("/api/workspace/board", { headers: { cookie } });
  expect(res.status()).toBe(200);
  expect(JSON.stringify(await res.json())).not.toContain(secret);
  // and B sees its own
  const other = await page.context().browser()!.newContext({ baseURL: "http://localhost:3100", viewport: { width: 1400, height: 900 } });
  const p2 = await other.newPage();
  await signIn(p2, B);
  await expect(p2.getByText(secret, { exact: true })).toBeVisible();
  await other.close();
});

test("phone: chat and briefing are reachable from the board", async ({ page }) => {
  await signIn(page, A);
  await page.getByRole("link", { name: "Ask in chat" }).click();
  await expect(page).toHaveURL(/\/chat$/);
  await page.goto("/board");
  await page.getByRole("link", { name: "Today's briefing" }).click();
  await expect(page).toHaveURL(/\/briefings$/);
});

test("board API and actions refuse signed-out requests", async ({ request }) => {
  expect((await request.get("/api/workspace/board")).status()).toBe(401);
  const id = "00000000-0000-4000-8000-000000000000";
  expect((await request.post(`/api/workspace/tasks/${id}/approve`, { data: { revision: 1 } })).status()).toBe(401);
  expect((await request.post(`/api/workspace/tasks/${id}/reject`, { data: {} })).status()).toBe(401);
  expect((await request.post(`/api/workspace/tasks/${id}/revise`, { data: { fields: { a: 1 } } })).status()).toBe(401);
});
