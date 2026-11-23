import { randomBytes } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { closeAllPools } from "../../src/server/db";
import { createBoardTenant, type BoardTenant } from "../support/board-fixtures";
import { deleteTenants } from "../support/tenant-cleanup";
try {
  process.loadEnvFile(".env.local");
} catch {
  /* env may already be provided by the shell */
}
// Task 9.4: chat, briefings and settings on a phone (Pixel 7, the default project).
const run = randomBytes(4).toString("hex");
let A: BoardTenant;
let B: BoardTenant;
test.describe.configure({ mode: "serial" });
test.beforeAll(async () => {
  A = await createBoardTenant("chat-a", run);
  B = await createBoardTenant("chat-b", run);
});
test.afterAll(async () => {
  await deleteTenants([A.tenantId, B.tenantId]);
  await closeAllPools();
});
async function signIn(page: Page, t: BoardTenant) {
  for (let attempt = 0; attempt < 2; attempt++) {
    await page.goto("/sign-in");
    await page.getByLabel("Email").fill(t.email);
    await page.getByLabel("Password").fill(t.password);
    await page.getByRole("button", { name: "Sign in" }).click();
    try {
      await expect(page).toHaveURL(/\/board$/, { timeout: 15_000 });
      return;
    } catch {
      /* one retry: a sign-in that overlaps another spec's tenant cleanup can fail transiently */
    }
  }
  await expect(page).toHaveURL(/\/board$/);
}
const noSidewaysScroll = async (page: Page) => expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
test("phone: chat shows the Maestro thread; a status question is answered from live data and creates no task", async ({ page }) => {
  await signIn(page, A);
  await page.getByRole("link", { name: "Ask in chat" }).click();
  await expect(page).toHaveURL(/\/chat$/);
  await expect(page.getByTestId("thread-tabs").getByRole("link")).toHaveCount(1);
  await expect(page.getByTestId("thread-tabs").getByRole("link", { name: "Aruna" })).toHaveAttribute("aria-current", "page");
  await expect(page.getByTestId("chat-empty")).toBeVisible();
  await page.getByLabel("Write a message").fill("What is waiting for my approval?");
  await page.getByRole("button", { name: "Send" }).click();
  const messages = page.getByTestId("chat-message");
  await expect(messages).toHaveCount(2);
  await expect(messages.nth(0).getByTestId("chat-sender")).toHaveText("You");
  await expect(messages.nth(1).getByTestId("chat-sender")).toHaveText("Aruna");
  await expect(messages.nth(1)).toContainText("Nothing is waiting for your approval.");
  // Indonesian question
  await page.getByLabel("Write a message").fill("Apa yang menunggu persetujuan saya?");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(messages).toHaveCount(4);
  await expect(messages.nth(3)).toContainText("Nothing is waiting for your approval.");
  // no task was created by either question
  await page.goto("/board");
  for (const s of ["queued", "working", "in_review", "pending_approval", "done", "rejected", "expired", "failed"]) {
    await page.getByTestId("status-chips").locator(`[data-status="${s}"]`).getByTestId("chip-count").waitFor();
    await expect(page.getByTestId("status-chips").locator(`[data-status="${s}"]`).getByTestId("chip-count")).toHaveText("0");
  }
});
test("phone: briefings show the honest empty state", async ({ page }) => {
  await signIn(page, A);
  await page.getByRole("link", { name: "Today's briefing" }).click();
  await expect(page).toHaveURL(/\/briefings$/);
  await expect(page.getByTestId("briefings-empty-today")).toHaveText("No briefing has been generated for today yet.");
  await expect(page.getByTestId("briefings-empty-archive")).toBeVisible();
  await noSidewaysScroll(page);
});
test("phone: settings rename the assistant everywhere; Playbook and model are shown; export is unavailable until 10.3", async ({ page }) => {
  await signIn(page, A);
  await page.goto("/settings");
  await expect(page.getByTestId("playbook-business")).toContainText("Denana");
  await expect(page.getByTestId("settings-model")).toContainText("bedrock");
  await expect(page.getByTestId("export-run")).toBeDisabled();
  await expect(page.getByTestId("export-unavailable")).toBeVisible();
  await noSidewaysScroll(page);
  await page.getByLabel("Assistant name").fill("Sari");
  await page.getByRole("button", { name: "Save name" }).click();
  await expect(page.getByTestId("assistant-name-notice")).toHaveText("Name saved.");
  await expect(page.getByTestId("assistant-name-mobile")).toHaveText("Sari");
  await page.goto("/chat");
  await expect(page.getByTestId("thread-tabs").getByRole("link", { name: "Sari" })).toBeVisible();
  await expect(page.getByTestId("chat-message").last().getByTestId("chat-sender")).toHaveText("Sari");
});
test("phone: chat and settings render in Indonesian after the language switch", async ({ page }) => {
  await signIn(page, B);
  await page.locator("header").getByTestId("language-toggle").getByRole("button", { name: "ID" }).click();
  await expect(page.locator("header").getByTestId("language-toggle").getByRole("button", { name: "ID" })).toHaveAttribute("aria-pressed", "true");
  await page.goto("/chat");
  await expect(page.getByRole("button", { name: "Kirim" })).toBeVisible();
  await page.goto("/settings");
  await expect(page.getByRole("button", { name: "Simpan nama" })).toBeVisible();
  await expect(page.getByTestId("export-unavailable")).toHaveText("Ekspor data belum tersedia.");
  await page.goto("/briefings");
  await expect(page.getByTestId("briefings-empty-today")).toHaveText("Belum ada ringkasan yang dibuat untuk hari ini.");
});
test("chat, settings and export APIs refuse signed-out requests; another tenant's thread is a 404", async ({ request, page }) => {
  expect((await request.get("/api/workspace/chat")).status()).toBe(401);
  expect((await request.post("/api/workspace/chat/messages", { data: { threadId: "x", body: "hi" } })).status()).toBe(401);
  expect((await request.get("/api/workspace/settings")).status()).toBe(401);
  expect((await request.post("/api/workspace/settings/assistant", { data: { name: "X" } })).status()).toBe(401);
  expect((await request.post("/api/workspace/settings/export")).status()).toBe(401);
  expect((await request.get("/api/workspace/briefings")).status()).toBe(401);
  await signIn(page, A);
  const cookie = (await page.context().cookies()).map((c) => `${c.name}=${c.value}`).join("; ");
  const theirs = (await (await page.request.get("/api/workspace/chat", { headers: { cookie } })).json()) as { selectedThreadId: string };
  await signIn(page, B);
  const cookieB = (await page.context().cookies()).map((c) => `${c.name}=${c.value}`).join("; ");
  const res = await page.request.post("/api/workspace/chat/messages", { headers: { cookie: cookieB }, data: { threadId: theirs.selectedThreadId, body: "What is waiting for my approval?" } });
  expect(res.status()).toBe(404);
  const exp = await page.request.post("/api/workspace/settings/export", { headers: { cookie: cookieB } });
  expect(exp.status()).toBe(503);
});
