import { randomBytes } from "node:crypto";
import { expect, test } from "@playwright/test";
import { closeAllPools } from "../../src/server/db";
import { createBoardTenant, type BoardTenant } from "../support/board-fixtures";
import { deferTenantCleanup } from "../support/ledger";
// Render proof for task 9.4: Pixel 7 screenshots of chat and settings, EN then ID, for one synthetic tenant.
// Opt-in so normal runs leave the repo clean:  npm run proof:render:chat
try {
  process.loadEnvFile(".env.local");
} catch {
  /* env may already be provided by the shell */
}
test.skip(!process.env.RENDER_PROOF, "set RENDER_PROOF=1 (npm run proof:render:chat) to regenerate docs/render-proof/9.4");
const OUT = "docs/render-proof/9.4";
const run = randomBytes(4).toString("hex");
let T: BoardTenant;
test.beforeAll(async () => {
  T = await createBoardTenant("chatproof", run);
});
test.afterAll(async () => {
  deferTenantCleanup([T.tenantId]);
  await closeAllPools();
});
test("chat and settings on a phone, EN then ID", async ({ page }) => {
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill(T.email);
  await page.getByLabel("Password").fill(T.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/board$/);
  await page.goto("/chat");
  await page.getByLabel("Write a message").fill("What is waiting for my approval?");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByTestId("chat-message")).toHaveCount(2);
  await page.screenshot({ path: `${OUT}/chat-en.png` });
  await page.goto("/settings");
  await expect(page.getByTestId("settings-view")).toBeVisible();
  await page.screenshot({ path: `${OUT}/settings-en.png`, fullPage: true });
  await page.locator("header").getByTestId("language-toggle").getByRole("button", { name: "ID" }).click();
  await expect(page.locator("header").getByTestId("language-toggle").getByRole("button", { name: "ID" })).toHaveAttribute("aria-pressed", "true");
  await page.goto("/chat");
  await page.getByLabel("Tulis pesan").fill("Apa yang menunggu persetujuan saya?");
  await page.getByRole("button", { name: "Kirim" }).click();
  await expect(page.getByTestId("chat-message")).toHaveCount(4);
  await page.screenshot({ path: `${OUT}/chat-id.png` });
  await page.goto("/settings");
  await expect(page.getByRole("button", { name: "Simpan nama" })).toBeVisible();
  await page.screenshot({ path: `${OUT}/settings-id.png`, fullPage: true });
});
