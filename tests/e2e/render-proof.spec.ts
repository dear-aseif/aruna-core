import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { hashPassword } from "../../src/server/auth/password";
import { withTenant } from "../../src/server/dal";
import { closeAllPools } from "../../src/server/db";
import { activatePlaybook } from "../../src/server/playbook";
import { deferTenantCleanup } from "../support/ledger";

// Render proof for task 9.1: Pixel 7 screenshots of the shell, EN and ID, for one synthetic tenant
// built from the seed Playbook (playbooks/denana.json). Opt-in so normal runs leave the repo clean:
//   npm run proof:render
try {
  process.loadEnvFile(".env.local");
} catch {
  /* env may already be provided by the shell */
}
test.skip(!process.env.RENDER_PROOF, "set RENDER_PROOF=1 (npm run proof:render) to regenerate docs/render-proof/9.1");

const tenantId = randomUUID();
const email = `proof-${randomBytes(4).toString("hex")}@e2e.example`;
const password = `pw-${randomBytes(12).toString("base64url")}`;
const OUT = "docs/render-proof/9.1";

test.beforeAll(async () => {
  const caller = { tenantId, actor: "system" as const, actorId: "e2e-render-proof" };
  const doc = JSON.parse(readFileSync("playbooks/denana.json", "utf8"));
  await withTenant(
    caller,
    async (tx) => {
      await tx.query("insert into tenants (id, name, type, status) values ($1, $2, 'pending', 'inactive')", [tenantId, doc.business.name]);
      await tx.insert("profiles", { email, password_hash: await hashPassword(password), role: "owner" });
    },
    "service",
  );
  expect((await activatePlaybook(caller, doc)).ok).toBe(true);
});
test.afterAll(async () => {
  deferTenantCleanup([tenantId]);
  await closeAllPools();
});

test("shell on a phone, EN then ID", async ({ page }) => {
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/board$/);
  const nav = page.getByTestId("bottom-nav");
  await expect(nav.getByRole("link").first()).toHaveText("Board");
  await page.screenshot({ path: `${OUT}/shell-en.png` });
  await page.locator("header").getByTestId("language-toggle").getByRole("button", { name: "ID" }).click();
  await expect(nav.getByRole("link").first()).toHaveText("Papan");
  await page.screenshot({ path: `${OUT}/shell-id.png` });
});
