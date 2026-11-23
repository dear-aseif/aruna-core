import { randomBytes, randomUUID } from "node:crypto";
import { devices, expect, test } from "@playwright/test";
import { hashPassword } from "../../src/server/auth/password";
import { withTenant } from "../../src/server/dal";
import { closeAllPools } from "../../src/server/db";
import { activatePlaybook } from "../../src/server/playbook";
import { deleteTenants } from "../support/tenant-cleanup";

test("home exposes the PWA manifest and sends signed-out visitors to sign-in", async ({ page, request }) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/sign-in$/);
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await expect(page.locator('link[rel="manifest"]')).toHaveCount(1);
  const res = await request.get("/manifest.webmanifest");
  expect(res.ok()).toBe(true);
  expect((await res.json()).display).toBe("standalone");
});

test("workspace routes and the shell API refuse signed-out requests", async ({ page, request }) => {
  await page.goto("/settings");
  await expect(page).toHaveURL(/\/sign-in$/);
  const res = await request.get("/api/workspace/shell");
  expect(res.status()).toBe(401);
});

// Signed-in shell: two synthetic tenants (one per pack) with known throwaway passwords.
// Created through the same server modules as the seed loader and removed afterwards.
try {
  process.loadEnvFile(".env.local");
} catch {
  /* env may already be provided by the shell */
}
const run = randomBytes(4).toString("hex");
const password = `pw-${randomBytes(12).toString("base64url")}`;
const hours = [{ day: "mon", open: "09:00", close: "17:00" }];
const fixtures = [
  {
    tenantId: randomUUID(),
    email: `shell-services-${run}@e2e.example`,
    business: "Studio Contoh Facial",
    assistant: "Sari",
    packLabels: ["Catalog", "Bookings"],
    doc: {
      business: { name: "Studio Contoh Facial", type: "facial studio", timezone: "Asia/Makassar" },
      assistantName: "Sari",
      pack: "services",
      hours,
      thresholds: {},
      templates: { bookingConfirmation: "Halo {customer}, booking {treatment} pada {slot} dikonfirmasi." },
      catalog: { treatments: [{ name: "Facial Dasar", durationMinutes: 60, price: 150000 }] },
    },
  },
  {
    tenantId: randomUUID(),
    email: `shell-retail-${run}@e2e.example`,
    business: "Toko Contoh Seragam",
    assistant: "Rani",
    packLabels: ["Catalog", "Stock"],
    doc: {
      business: { name: "Toko Contoh Seragam", type: "school uniform shop", timezone: "Asia/Makassar" },
      assistantName: "Rani",
      pack: "retail",
      hours,
      thresholds: { lowStock: 5 },
      templates: { supplierFollowUp: "Halo {supplier}, mohon kabar PO {poReference}: {item} x {quantity}." },
      catalog: { products: [{ name: "Kemeja Putih", variants: [{ sku: "KP-S", size: "S", price: 65000 }] }] },
    },
  },
];

test.describe("signed-in workspace shell", () => {
  test.beforeAll(async () => {
    for (const f of fixtures) {
      const caller = { tenantId: f.tenantId, actor: "system" as const, actorId: `e2e-shell-${run}` };
      await withTenant(
        caller,
        async (tx) => {
          await tx.query("insert into tenants (id, name, type, status) values ($1, $2, 'pending', 'inactive')", [f.tenantId, f.business]);
          await tx.insert("profiles", { email: f.email, password_hash: await hashPassword(password), role: "owner" });
        },
        "service",
      );
      expect((await activatePlaybook(caller, f.doc)).ok).toBe(true);
    }
  });
  test.afterAll(async () => {
    await deleteTenants(fixtures.map((f) => f.tenantId));
    await closeAllPools();
  });

  for (const f of fixtures) {
    test(`${f.business}: one shell, Playbook-driven names and pack screens, usable on a phone`, async ({ page, request }) => {
      await page.goto("/sign-in");
      await page.getByLabel("Email").fill(f.email);
      await page.getByLabel("Password").fill(password);
      await page.getByRole("button", { name: "Sign in" }).click();
      await expect(page).toHaveURL(/\/board$/);

      await expect(page.getByTestId("business-name-mobile")).toHaveText(f.business);
      await expect(page.getByTestId("assistant-name-mobile")).toHaveText(f.assistant);
      const nav = page.getByTestId("bottom-nav");
      await expect(nav).toBeVisible();
      await expect(nav.getByRole("link")).toHaveText(["Board", "Chat", "Briefings", ...f.packLabels, "Settings"]);

      // Every nav target is reachable from the phone viewport and nothing scrolls sideways.
      for (const label of ["Chat", "Briefings", ...f.packLabels, "Settings", "Board"]) {
        await nav.getByRole("link", { name: label, exact: true }).click();
        await expect(page.getByRole("heading", { level: 1, name: label })).toBeVisible();
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        expect(overflow).toBeLessThanOrEqual(0);
      }

      // The shell API returns the same model, resolved from the session cookie.
      const api = await request.get("/api/workspace/shell", { headers: { cookie: (await page.context().cookies()).map((c) => `${c.name}=${c.value}`).join("; ") } });
      expect(api.status()).toBe(200);
      expect(await api.json()).toMatchObject({ businessName: f.business, assistantName: f.assistant });

      // A screen of the other pack is not served.
      const other = f.packLabels.includes("Stock") ? "bookings" : "stock";
      expect((await page.goto(`/p/${other}`))?.status()).toBe(404);
    });
  }
});

// Language switching: EN | ID in the shell, saved per tenant through the server, isolated between tenants.
test.describe("shell language", () => {
  const lrun = randomBytes(4).toString("hex");
  const lpass = `pw-${randomBytes(12).toString("base64url")}`;
  const mkTenant = (n: string) => ({ tenantId: randomUUID(), email: `lang-${n}-${lrun}@e2e.example`, doc: fixtures[n === "a" ? 0 : 1].doc });
  const A = mkTenant("a");
  const B = mkTenant("b");
  test.beforeAll(async () => {
    for (const f of [A, B]) {
      const caller = { tenantId: f.tenantId, actor: "system" as const, actorId: `e2e-lang-${lrun}` };
      await withTenant(
        caller,
        async (tx) => {
          await tx.query("insert into tenants (id, name, type, status) values ($1, $2, 'pending', 'inactive')", [f.tenantId, f.email]);
          await tx.insert("profiles", { email: f.email, password_hash: await hashPassword(lpass), role: "owner" });
        },
        "service",
      );
      expect((await activatePlaybook(caller, f.doc)).ok).toBe(true);
    }
  });
  test.afterAll(async () => {
    await deleteTenants([A.tenantId, B.tenantId]);
    await closeAllPools();
  });
  async function signIn(page: import("@playwright/test").Page, email: string) {
    await page.goto("/sign-in");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill(lpass);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/\/board$/);
  }
  test("switching to ID re-renders the shell, survives reload, and does not affect the other tenant", async ({ page, browser }) => {
    await signIn(page, A.email);
    const nav = page.getByTestId("bottom-nav");
    await expect(nav.getByRole("link")).toHaveText(["Board", "Chat", "Briefings", "Catalog", "Bookings", "Settings"]);
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    await page.locator("header").getByTestId("language-toggle").getByRole("button", { name: "ID" }).click();
    await expect(nav.getByRole("link")).toHaveText(["Papan", "Obrolan", "Ringkasan", "Katalog", "Reservasi", "Pengaturan"]);
    await expect(page.getByRole("heading", { level: 1, name: "Papan" })).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("lang", "id");
    await page.reload();
    await expect(nav.getByRole("link").first()).toHaveText("Papan");
    await expect(page.locator("header").getByTestId("language-toggle").getByRole("button", { name: "ID" })).toHaveAttribute("aria-pressed", "true");
    // The other tenant is still EN.
    const ctx = await browser.newContext({ ...devices["Pixel 7"], baseURL: "http://localhost:3100" });
    const other = await ctx.newPage();
    await signIn(other, B.email);
    await expect(other.getByTestId("bottom-nav").getByRole("link").first()).toHaveText("Board");
    await ctx.close();
  });
  test("the side rail carries the toggle and the language API refuses signed-out and invalid requests", async ({ page, request }) => {
    expect((await request.post("/api/workspace/language", { data: { language: "id" } })).status()).toBe(401);
    await signIn(page, B.email);
    const cookie = (await page.context().cookies()).map((c) => `${c.name}=${c.value}`).join("; ");
    const bad = await request.post("/api/workspace/language", { data: { language: "fr" }, headers: { cookie } });
    expect(bad.status()).toBe(400);
    await page.setViewportSize({ width: 1200, height: 800 });
    const rail = page.locator("aside").getByTestId("language-toggle");
    await expect(rail).toBeVisible();
    await rail.getByRole("button", { name: "ID" }).click();
    await expect(page.locator("aside").getByRole("button", { name: "Keluar" })).toBeVisible();
  });
});
