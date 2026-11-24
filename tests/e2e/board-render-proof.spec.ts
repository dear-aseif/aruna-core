import { randomBytes } from "node:crypto";
import { expect, test } from "@playwright/test";
import { closeAllPools } from "../../src/server/db";
import { createBoardTask, createBoardTenant, type BoardTenant } from "../support/board-fixtures";
import { deferTenantCleanup } from "../support/ledger";

// Render proof for task 9.2: Pixel 7 screenshots of the board, EN then ID, for one synthetic tenant.
// Opt-in so normal runs leave the repo clean:  npm run proof:render:board
try {
  process.loadEnvFile(".env.local");
} catch {
  /* env may already be provided by the shell */
}
test.skip(!process.env.RENDER_PROOF, "set RENDER_PROOF=1 (npm run proof:render:board) to regenerate docs/render-proof/9.2");

const OUT = "docs/render-proof/9.2";
const run = randomBytes(4).toString("hex");
let T: BoardTenant;

test.beforeAll(async () => {
  T = await createBoardTenant("proof", run);
  await createBoardTask(T, "Konfirmasi booking Facial Dasar", "pending_approval", { customer: "Contoh Pelanggan", treatment: "Facial Dasar", slot: "Sel 24 Nov, 10:00" });
  await createBoardTask(T, "Konfirmasi booking Facial Cerah", "pending_approval", { customer: "Pelanggan Dua", treatment: "Facial Cerah", slot: "Rab 25 Nov, 13:00" });
  await createBoardTask(T, "Rekap stok mingguan", "done");
  await createBoardTask(T, "Draf tindak lanjut pemasok", "in_review");
  await createBoardTask(T, "Booking terlambat", "overdue");
});
test.afterAll(async () => {
  deferTenantCleanup([T.tenantId]);
  await closeAllPools();
});

test("board on a phone, EN then ID", async ({ page }) => {
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill(T.email);
  await page.getByLabel("Password").fill(T.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/board$/);
  await expect(page.getByTestId("column-pending_approval").getByRole("button", { name: "Approve" }).first()).toBeVisible();
  await page.screenshot({ path: `${OUT}/board-en.png` });
  await page.locator("header").getByTestId("language-toggle").getByRole("button", { name: "ID" }).click();
  await expect(page.getByTestId("column-pending_approval").getByRole("button", { name: "Setujui" }).first()).toBeVisible();
  await page.screenshot({ path: `${OUT}/board-id.png` });
});
