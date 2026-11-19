import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { closeAllPools, withTenantSession } from "@/server/db";
import { withTenant, type Caller } from "@/server/dal";
import { trackTenant } from "../support/ledger";
import { listPackIds } from "@/server/packs";
import {
  PLAYBOOK_REFUSED,
  NoActivePlaybookError,
  activatePlaybook,
  getActivePack,
  getCatalog,
  getHours,
  getTemplates,
  getThresholds,
  validatePlaybook,
} from "@/server/playbook";

try {
  process.loadEnvFile(".env.local");
} catch {
  /* env may already be provided by the shell */
}

// Synthetic documents only.
const hours = [
  { day: "mon", open: "09:00", close: "17:00" },
  { day: "tue", open: "09:00", close: "17:00" },
];

const retail = () => ({
  business: { name: "Toko Contoh", type: "school uniform shop", timezone: "Asia/Makassar" },
  assistantName: "Aruna",
  pack: "retail",
  hours,
  thresholds: { lowStock: 5, approvalAmountLimit: 2_000_000 },
  templates: { supplierFollowUp: "Halo {supplier}, mohon kabar PO {poReference}: {item} x {quantity}." },
  catalog: { products: [{ name: "Kemeja Putih", variants: [{ sku: "KP-S", size: "S", price: 65000 }, { sku: "KP-M", size: "M", price: 70000 }] }] },
});

const services = () => ({
  business: { name: "Studio Contoh", type: "facial studio", timezone: "Asia/Makassar" },
  assistantName: "Sari",
  pack: "services",
  hours,
  thresholds: {},
  templates: { bookingConfirmation: "Halo {customer}, booking {treatment} pada {slot} dikonfirmasi." },
  catalog: { treatments: [{ name: "Facial Dasar", durationMinutes: 60, price: 150000 }] },
});

describe("pack registration", () => {
  it("registers both packs", () => {
    validatePlaybook({}); // importing the playbook module registers the built-in packs
    expect(listPackIds()).toEqual(["retail", "services"]);
  });
});

describe("validation (no database)", () => {
  it("accepts a complete Retail and a complete Services Playbook", () => {
    expect(validatePlaybook(retail()).ok).toBe(true);
    expect(validatePlaybook(services()).ok).toBe(true);
  });

  it("an incomplete Retail Playbook lists exactly the missing fields", () => {
    const d: Record<string, any> = retail();
    delete d.hours;
    delete d.thresholds.lowStock;
    delete d.templates.supplierFollowUp;
    delete d.catalog.products[0].variants;
    const r = validatePlaybook(d);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.missing).toEqual(["catalog.products[0].variants", "hours", "templates.supplierFollowUp", "thresholds.lowStock"]);
    expect(r.invalid).toEqual([]);
  });

  it("an incomplete Services Playbook lists exactly the missing fields", () => {
    const d: Record<string, any> = services();
    delete d.assistantName;
    delete d.templates.bookingConfirmation;
    delete d.catalog.treatments[0].durationMinutes;
    delete d.catalog.treatments[0].price;
    const r = validatePlaybook(d);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.missing).toEqual([
      "assistantName",
      "catalog.treatments[0].durationMinutes",
      "catalog.treatments[0].price",
      "templates.bookingConfirmation",
    ]);
  });

  it("reports invalid (present but wrong) fields separately from missing ones", () => {
    const d: Record<string, any> = retail();
    d.thresholds.lowStock = -1;
    d.hours = [{ day: "mon", open: "18:00", close: "09:00" }];
    const r = validatePlaybook(d);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.missing).toEqual([]);
    expect(r.invalid.map((i) => i.path)).toEqual(["hours[0].close", "thresholds.lowStock"]);
  });

  it("a Services Playbook carrying the Retail fragment fails validation", () => {
    const d: Record<string, any> = services();
    d.catalog = retail().catalog;
    d.thresholds = { lowStock: 5 };
    d.templates.supplierFollowUp = "x";
    const r = validatePlaybook(d);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.missing).toEqual(["catalog.treatments"]);
    expect(r.invalid.map((i) => i.path)).toEqual(["catalog.products", "templates.supplierFollowUp", "thresholds.lowStock"]);
  });

  it("a Retail Playbook referencing the Services fragment fails validation", () => {
    const d: Record<string, any> = retail();
    d.catalog = services().catalog;
    d.templates = services().templates;
    const r = validatePlaybook(d);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.missing).toEqual(["catalog.products", "templates.supplierFollowUp"]);
    expect(r.invalid.map((i) => i.path)).toEqual(["catalog.treatments", "templates.bookingConfirmation"]);
  });

  it("an unknown pack and a missing pack are refused", () => {
    const unknown = validatePlaybook({ ...retail(), pack: "mining" });
    expect(unknown.ok).toBe(false);
    const d: Record<string, any> = retail();
    delete d.pack;
    const r = validatePlaybook(d);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.missing).toContain("pack");
  });

  it("refuses duplicate SKUs", () => {
    const d: Record<string, any> = retail();
    d.catalog.products[0].variants[1].sku = "KP-S";
    const r = validatePlaybook(d);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.invalid.map((i) => i.path)).toEqual(["catalog.products[0].variants[1].sku"]);
  });
});

describe("activation and runtime reads (database, runtime role)", () => {
  const run = randomBytes(4).toString("hex");
  const mk = (): Caller => ({ tenantId: randomUUID(), actor: "system", actorId: "operator-test" });

  async function provision(c: Caller, label: string) {
    trackTenant(c.tenantId);
    await withTenantSession(
      c.tenantId,
      (cl) => cl.query("insert into tenants (id, name, type, status) values ($1, $2, 'pending', 'inactive')", [c.tenantId, `PB ${label} ${run}`]),
      "service",
    );
  }
  afterAll(async () => {
    await closeAllPools();
  });

  it("refuses an incomplete Playbook with the exact list, audits it, and leaves the tenant inactive", async () => {
    const c = mk();
    await provision(c, "refuse");
    const d: Record<string, any> = retail();
    delete d.thresholds.lowStock;
    delete d.hours;
    const r = await activatePlaybook(c, d);
    expect(r).toEqual({ ok: false, missing: ["hours", "thresholds.lowStock"], invalid: [] });
    await withTenant(c, async (tx) => {
      expect(await tx.query("select 1 from playbooks")).toHaveLength(0);
      expect(await tx.query("select 1 from settings")).toHaveLength(0);
      expect((await tx.getById<{ status: string; active_pack: string | null }>("tenants", c.tenantId)).status).toBe("inactive");
      const a = await tx.query<{ payload: { missing: string[] } }>("select payload from audit_log where type = $1", [PLAYBOOK_REFUSED]);
      expect(a).toHaveLength(1);
      expect(a[0].payload.missing).toEqual(["hours", "thresholds.lowStock"]);
      await expect(getActivePack(tx)).rejects.toBeInstanceOf(NoActivePlaybookError);
    });
  });

  it("activates a complete Playbook; runtime reads return its values and settings is seeded", async () => {
    const c = mk();
    await provision(c, "activate");
    const r = await activatePlaybook(c, retail());
    expect(r).toMatchObject({ ok: true, version: 1, pack: "retail" });
    await withTenant(c, async (tx) => {
      expect(await getActivePack(tx)).toBe("retail");
      expect(await getHours(tx)).toEqual(hours);
      expect(await getThresholds(tx)).toEqual({ lowStock: 5, approvalAmountLimit: 2_000_000 });
      expect(await getTemplates(tx)).toEqual(retail().templates);
      expect(await getCatalog(tx)).toEqual(retail().catalog);
      const t = await tx.getById<{ status: string; active_pack: string; name: string }>("tenants", c.tenantId);
      expect(t).toMatchObject({ status: "active", active_pack: "retail", name: "Toko Contoh" });
      expect((await tx.getById<{ assistant_name: string }>("settings", c.tenantId, "tenant_id")).assistant_name).toBe("Aruna");
    });
  });

  it("switching the active Playbook changes the reads with no code change; one active version; settings name is not overwritten", async () => {
    const c = mk();
    await provision(c, "switch");
    await activatePlaybook(c, retail());
    await withTenant(c, (tx) => tx.updateById("settings", c.tenantId, { assistant_name: "Owner Renamed" }, "tenant_id"));
    const r = await activatePlaybook(c, services());
    expect(r).toMatchObject({ ok: true, version: 2, pack: "services" });
    await withTenant(c, async (tx) => {
      expect(await getActivePack(tx)).toBe("services");
      expect(await getCatalog(tx)).toEqual(services().catalog);
      expect(await getTemplates(tx)).toEqual(services().templates);
      expect(await getThresholds(tx)).toEqual({});
      const active = await tx.query("select version from playbooks where active");
      expect(active).toEqual([{ version: 2 }]);
      expect(await tx.query("select 1 from playbooks")).toHaveLength(2);
      expect((await tx.getById<{ assistant_name: string }>("settings", c.tenantId, "tenant_id")).assistant_name).toBe("Owner Renamed");
    });
  });

  it("a refused re-activation leaves the current active Playbook in force", async () => {
    const c = mk();
    await provision(c, "keep");
    await activatePlaybook(c, retail());
    const bad: Record<string, any> = services();
    delete bad.templates.bookingConfirmation;
    expect((await activatePlaybook(c, bad)).ok).toBe(false);
    await withTenant(c, async (tx) => {
      expect(await getActivePack(tx)).toBe("retail");
    });
  });

  it("each tenant reads only its own Playbook", async () => {
    const a = mk();
    const b = mk();
    await provision(a, "iso-a");
    await provision(b, "iso-b");
    await activatePlaybook(a, retail());
    await activatePlaybook(b, services());
    expect(await withTenant(a, (tx) => getActivePack(tx))).toBe("retail");
    expect(await withTenant(b, (tx) => getActivePack(tx))).toBe("services");
  });
});
