import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { closeAllPools, withTenantSession } from "@/server/db";
import { withTenant, type Caller } from "@/server/dal";
import { trackTenant } from "../support/ledger";
import { activatePlaybook, getBusinessProfile, getCatalog } from "@/server/playbook";
import { readPlaybookFile } from "@/server/seed/loader";

try {
  process.loadEnvFile(".env.local");
} catch {
  /* env may already be provided by the shell */
}

// Task 3.1 checkpoint: service-level proof that switching the active Playbook changes the
// business data the services return, with no code change. Synthetic documents only.
const hours = [{ day: "mon", open: "09:00", close: "17:00" }];

const retail = () => ({
  business: { name: "Toko Contoh Seragam", type: "school uniform shop", timezone: "Asia/Makassar" },
  assistantName: "Aruna",
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

describe("switching the active Playbook (runtime role)", () => {
  const run = randomBytes(4).toString("hex");
  const c: Caller = { tenantId: randomUUID(), actor: "system", actorId: "operator-test" };

  afterAll(async () => {
    await closeAllPools();
  });

  const snapshot = () =>
    withTenant(c, async (tx) => ({
      profile: await getBusinessProfile(tx),
      catalog: await getCatalog(tx),
      tenantName: (await tx.getById<{ name: string }>("tenants", c.tenantId)).name,
      assistant: (await tx.getById<{ assistant_name: string }>("settings", c.tenantId, "tenant_id")).assistant_name,
    }));

  it("business name, catalog and assistant name follow the active Playbook; owner edits survive", async () => {
    trackTenant(c.tenantId);
    await withTenantSession(
      c.tenantId,
      (cl) => cl.query("insert into tenants (id, name, type, status) values ($1, $2, 'pending', 'inactive')", [c.tenantId, `Switch ${run}`]),
      "service",
    );

    // The reads below run as the non-owner, non-BYPASSRLS runtime role.
    await withTenant(c, async (tx) => {
      const r = await tx.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
        "select r.rolsuper, r.rolbypassrls from pg_roles r where r.rolname = current_user",
      );
      expect(r[0]).toEqual({ rolsuper: false, rolbypassrls: false });
    });

    expect((await activatePlaybook(c, retail())).ok).toBe(true);
    const first = await snapshot();
    expect(first.profile.name).toBe("Toko Contoh Seragam");
    expect(first.tenantName).toBe("Toko Contoh Seragam");
    expect(first.catalog).toEqual(retail().catalog);
    expect(first.assistant).toBe("Aruna");

    // Owner renames the assistant; later Playbook activations must not overwrite it.
    await withTenant(c, (tx) => tx.updateById("settings", c.tenantId, { assistant_name: "Owner Renamed" }, "tenant_id"));

    expect((await activatePlaybook(c, services())).ok).toBe(true);
    const second = await snapshot();
    expect(second.profile.name).toBe("Studio Contoh Facial");
    expect(second.tenantName).toBe("Studio Contoh Facial");
    expect(second.catalog).toEqual(services().catalog);
    expect(second.assistant).toBe("Owner Renamed");

    // Switching back returns the first business's data again: same code, different active Playbook.
    expect((await activatePlaybook(c, retail())).ok).toBe(true);
    const third = await snapshot();
    expect(third.profile.name).toBe("Toko Contoh Seragam");
    expect(third.catalog).toEqual(retail().catalog);
    expect(third.assistant).toBe("Owner Renamed");
  });

  it("the two real seeded Playbook files switch on a throwaway tenant (live tenants stay untouched)", async () => {
    const t: Caller = { tenantId: randomUUID(), actor: "system", actorId: "operator-test" };
    trackTenant(t.tenantId);
    await withTenantSession(
      t.tenantId,
      (cl) => cl.query("insert into tenants (id, name, type, status) values ($1, $2, 'pending', 'inactive')", [t.tenantId, `Real ${run}`]),
      "service",
    );
    const denana = await readPlaybookFile("denana.json");
    const toko = await readPlaybookFile("toko-seragam.json");
    const read = () =>
      withTenant(t, async (tx) => ({
        name: (await getBusinessProfile(tx)).name,
        catalog: (await getCatalog(tx)) as Record<string, { name: string }[]>,
        assistant: (await tx.getById<{ assistant_name: string }>("settings", t.tenantId, "tenant_id")).assistant_name,
      }));
    const head = (s: Awaited<ReturnType<typeof read>>) => (s.catalog.treatments ?? s.catalog.products).slice(0, 2).map((x) => x.name);

    expect((await activatePlaybook(t, denana)).ok).toBe(true);
    const a = await read();
    expect((await activatePlaybook(t, toko)).ok).toBe(true);
    const b = await read();
    expect((await activatePlaybook(t, denana)).ok).toBe(true);
    const c3 = await read();
    console.log("SWITCH", JSON.stringify({ denana: [a.name, head(a), a.assistant], toko: [b.name, head(b), b.assistant], back: [c3.name, head(c3), c3.assistant] }));

    expect(a.name).toBe("Denana Facial Studio (synthetic)");
    expect(a.catalog.treatments).toBeDefined();
    expect(b.name).toBe("Toko Seragam Maju (synthetic)");
    expect(b.catalog.products).toBeDefined();
    expect(b.catalog.treatments).toBeUndefined();
    expect(c3).toEqual(a);
  });
});
