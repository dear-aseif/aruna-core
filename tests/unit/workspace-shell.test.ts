import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { closeAllPools, withTenantSession } from "@/server/db";
import { withTenant, type Caller } from "@/server/dal";
import { AuthenticationError } from "@/server/auth";
import { activatePlaybook } from "@/server/playbook";
import { buildNav, findPackScreen, getShellModelTx, loadShell } from "@/server/workspace";
import { InvalidLanguageError, setUiLanguage } from "@/server/settings";
import { trackTenant } from "../support/ledger";
try {
  process.loadEnvFile(".env.local");
} catch {
  /* env may already be provided by the shell */
}
// Task 9.1: one navigation shell for both tenants (R3.4); only Playbook-driven content differs.
// Synthetic tenants only.
const hours = [{ day: "mon", open: "09:00", close: "17:00" }];
const retail = () => ({
  business: { name: "Toko Contoh Seragam", type: "school uniform shop", timezone: "Asia/Makassar" },
  assistantName: "Rani",
  pack: "retail",
  hours,
  thresholds: { lowStock: 5 },
  templates: { supplierFollowUp: "Halo {supplier}, mohon kabar PO {poReference}: {item} x {quantity}." },
  catalog: { products: [{ name: "Kemeja Putih", variants: [{ sku: "KP-S", size: "S", price: 65000 }] }] },
});
const services = () => ({
  business: { name: "Studio Contoh Facial", type: "facial studio", timezone: "Asia/Makassar" },
  assistantName: "Sari",
  pack: "services",
  hours,
  thresholds: {},
  templates: { bookingConfirmation: "Halo {customer}, booking {treatment} pada {slot} dikonfirmasi." },
  catalog: { treatments: [{ name: "Facial Dasar", durationMinutes: 60, price: 150000 }] },
});

describe("buildNav", () => {
  const core = (nav: ReturnType<typeof buildNav>) => nav.filter((n) => n.kind === "core").map((n) => n.id);
  it("uses the same core items in the same order for both packs, with pack screens between Briefings and Settings", () => {
    const s = buildNav("services");
    const r = buildNav("retail");
    expect(core(s)).toEqual(["board", "chat", "briefings", "settings"]);
    expect(core(r)).toEqual(core(s));
    expect(s.map((n) => n.label)).toEqual(["Board", "Chat", "Briefings", "Catalog", "Bookings", "Settings"]);
    expect(r.map((n) => n.label)).toEqual(["Board", "Chat", "Briefings", "Catalog", "Stock", "Settings"]);
  });
  it("adds no pack screens for an unknown pack and resolves only the active pack's screens", () => {
    expect(buildNav("nope").map((n) => n.id)).toEqual(["board", "chat", "briefings", "settings"]);
    expect(findPackScreen("services", "bookings")?.label).toBe("Bookings");
    expect(findPackScreen("services", "stock")).toBeNull();
    expect(findPackScreen("retail", "stock")?.label).toBe("Stock");
    expect(findPackScreen("retail", "board")).toBeNull();
  });
});

describe("getShellModelTx (runtime role, tenant-bound)", () => {
  const run = randomBytes(4).toString("hex");
  const mk = (): Caller => ({ tenantId: randomUUID(), actor: "system", actorId: `shell-${run}` });
  const S = mk();
  const R = mk();
  afterAll(async () => {
    await closeAllPools();
  });
  it("business name, assistant name and pack screens come from each tenant's Playbook; a rename shows immediately", async () => {
    for (const [c, doc] of [[S, services], [R, retail]] as const) {
      trackTenant(c.tenantId);
      await withTenantSession(
        c.tenantId,
        (cl) => cl.query("insert into tenants (id, name, type, status) values ($1, $2, 'pending', 'inactive')", [c.tenantId, `Shell ${run}`]),
        "service",
      );
      expect((await activatePlaybook(c, doc())).ok).toBe(true);
    }
    const s = await withTenant(S, getShellModelTx);
    const r = await withTenant(R, getShellModelTx);
    expect(s).toMatchObject({ businessName: "Studio Contoh Facial", assistantName: "Sari", pack: "services" });
    expect(r).toMatchObject({ businessName: "Toko Contoh Seragam", assistantName: "Rani", pack: "retail" });
    expect(s.nav.map((n) => n.label)).toContain("Bookings");
    expect(s.nav.map((n) => n.label)).not.toContain("Stock");
    expect(r.nav.map((n) => n.label)).toContain("Stock");
    await withTenant(S, (tx) => tx.updateById("settings", S.tenantId, { assistant_name: "Owner Renamed" }, "tenant_id"));
    expect((await withTenant(S, getShellModelTx)).assistantName).toBe("Owner Renamed");
  });
  it("loadShell refuses a missing or unknown session token", async () => {
    await expect(loadShell(undefined)).rejects.toBeInstanceOf(AuthenticationError);
    await expect(loadShell("not-a-real-token")).rejects.toBeInstanceOf(AuthenticationError);
  });
});

describe("UI language setting (runtime role, tenant-bound)", () => {
  const run = randomBytes(4).toString("hex");
  const mk = (): Caller => ({ tenantId: randomUUID(), actor: "owner", actorId: `lang-${run}` });
  const A = mk();
  const B = mk();
  afterAll(async () => {
    await closeAllPools();
  });
  it("defaults to EN, persists per tenant, is audited, and never touches the other tenant", async () => {
    for (const [c, doc] of [[A, services], [B, retail]] as const) {
      trackTenant(c.tenantId);
      await withTenantSession(
        c.tenantId,
        (cl) => cl.query("insert into tenants (id, name, type, status) values ($1, $2, 'pending', 'inactive')", [c.tenantId, `Lang ${run}`]),
        "service",
      );
      expect((await activatePlaybook({ ...c, actor: "system" }, doc())).ok).toBe(true);
    }
    expect((await withTenant(A, getShellModelTx)).language).toBe("en");
    expect(await withTenant(A, (tx) => setUiLanguage(tx, "id"))).toBe("id");
    expect((await withTenant(A, getShellModelTx)).language).toBe("id");
    expect((await withTenant(B, getShellModelTx)).language).toBe("en");
    const audit = await withTenant(A, (tx) =>
      tx.query<{ payload: { from: string; to: string }; actor: string }>("select payload, actor from audit_log where type = 'settings.ui_language_changed'"),
    );
    expect(audit).toEqual([{ payload: { from: "en", to: "id" }, actor: "owner" }]);
  });
  it("refuses an unsupported language and leaves the setting unchanged", async () => {
    await expect(withTenant(A, (tx) => setUiLanguage(tx, "fr"))).rejects.toBeInstanceOf(InvalidLanguageError);
    expect((await withTenant(A, getShellModelTx)).language).toBe("id");
  });
});
