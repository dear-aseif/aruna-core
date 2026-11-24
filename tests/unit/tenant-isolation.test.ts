import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeAllPools } from "@/server/db";
import {
  CROSS_TENANT_AUDIT_TYPE,
  CrossTenantReferenceError,
  NotFoundError,
  withTenant,
  type Caller,
} from "@/server/dal";
import { getActivePack, getBusinessProfile, getCatalog } from "@/server/playbook";
import { SEED_TENANTS } from "@/server/seed/loader";
import { trackSeedAuditActor } from "../support/ledger";

try {
  process.loadEnvFile(".env.local");
} catch {
  /* env may already be provided by the shell */
}

/**
 * Tenant isolation (Property 1; R1.1, R1.2, R1.3, R1.5) against the two SEEDED tenants and the
 * real Data Access Layer under the runtime role. Rulings from 2.3: a bare-id READ of another
 * tenant's record is invisible (NotFoundError) and NOT audited; a cross-tenant WRITE or declared
 * reference is refused AND writes exactly one security.cross_tenant_attempt entry.
 *
 * Attempt counts are scoped to this run's own actor id: the seeded tenants are shared with every other
 * test file running in parallel, so an unscoped count of the tenant's log is global state.
 * The seeded tenants are only read, apart from the audit entries the refused attempts write.
 * Those entries carry this run's unique `test-` actor id and are removed as the migrator by the
 * global teardown (the append-only log forbids it for the runtime roles), leaving both tenants as seeded.
 */
const [denanaSeed, tokoSeed] = SEED_TENANTS;
const run = randomBytes(4).toString("hex");
const ACTOR = `test-isolation-${run}`;
trackSeedAuditActor(ACTOR); // removed by the global teardown (migrator), leaving the seeded tenants as seeded
const D: Caller = { tenantId: denanaSeed.tenantId, actor: "owner", actorId: ACTOR };
const T: Caller = { tenantId: tokoSeed.tenantId, actor: "owner", actorId: ACTOR };

const attemptCount = (c: Caller) =>
  withTenant(c, async (tx) =>
    Number((await tx.query<{ n: string }>("select count(*)::text as n from audit_log where type = $1 and actor_id = $2", [CROSS_TENANT_AUDIT_TYPE, ACTOR]))[0].n),
  );

const attemptsBy = (c: Caller) =>
  withTenant(c, (tx) =>
    tx.query<{ tenant_id: string; actor: string; actor_id: string; payload: { reason: string; table: string | null } }>(
      "select tenant_id, actor, actor_id, payload from audit_log where type = $1 and actor_id = $2",
      [CROSS_TENANT_AUDIT_TYPE, ACTOR],
    ),
  );

// Ids of the other tenant's records, learned through that tenant's own session.
let dPlaybookId: string;
let tPlaybookId: string;
let dUserId: string;
let tUserId: string;
let tSettingsName: string;

beforeAll(async () => {
  const one = (c: Caller) =>
    withTenant(c, async (tx) => ({
      playbook: (await tx.query<{ id: string }>("select id from playbooks where active"))[0],
      user: (await tx.query<{ user_id: string }>("select user_id from profiles where role = 'owner'"))[0],
      settings: await tx.getById<{ assistant_name: string }>("settings", c.tenantId, "tenant_id"),
    }));
  try {
    const d = await one(D);
    const t = await one(T);
    dPlaybookId = d.playbook.id;
    tPlaybookId = t.playbook.id;
    dUserId = d.user.user_id;
    tUserId = t.user.user_id;
    tSettingsName = t.settings.assistant_name;
  } catch (e) {
    throw new Error(`the two seeded tenants must exist (run npm run db:seed): ${(e as Error).message}`);
  }
}, 60_000);

afterAll(async () => {
  await closeAllPools();
});

describe("reads return only the caller's own records", () => {
  it.each([
    ["Denana", D, "services"],
    ["Toko Seragam", T, "retail"],
  ] as const)("%s sees exactly its own rows in every tenant-scoped table", async (_n, c, pack) => {
    await withTenant(c, async (tx) => {
      for (const table of ["tenants", "profiles", "playbooks", "settings", "audit_log"]) {
        const col = table === "tenants" ? "id" : "tenant_id";
        const rows = await tx.query<{ n: string }>(`select count(*)::text as n from "${table}" where "${col}" <> $1`, [c.tenantId]);
        expect(Number(rows[0].n), `${table} leaked rows of another tenant`).toBe(0);
      }
      expect(await tx.query("select 1 from tenants")).toHaveLength(1);
      expect(await getActivePack(tx)).toBe(pack);
    });
  });

  it("each seeded tenant's runtime Playbook reads are its own", async () => {
    const d = await withTenant(D, async (tx) => ({ biz: await getBusinessProfile(tx), cat: await getCatalog(tx) }));
    const t = await withTenant(T, async (tx) => ({ biz: await getBusinessProfile(tx), cat: await getCatalog(tx) }));
    expect(d.biz.type).toMatch(/women-only facial/);
    expect(t.biz.type).toMatch(/uniform/);
    expect(d.cat).toHaveProperty("treatments");
    expect(d.cat).not.toHaveProperty("products");
    expect(t.cat).toHaveProperty("products");
    expect(t.cat).not.toHaveProperty("treatments");
  });

  it("runs as a non-owner, non-superuser role without BYPASSRLS", async () => {
    await withTenant(D, async (tx) => {
      const r = await tx.query<{ rolsuper: boolean; rolbypassrls: boolean; owner: boolean }>(
        `select r.rolsuper, r.rolbypassrls,
                exists (select 1 from pg_class c where c.relname = 'tenants' and c.relowner = r.oid) as owner
           from pg_roles r where r.rolname = current_user`,
      );
      expect(r[0]).toEqual({ rolsuper: false, rolbypassrls: false, owner: false });
    });
  });
});

describe("bare-id reads of another tenant's record are invisible and not audited (ruling 2.3)", () => {
  it.each([
    ["playbooks", () => ({ table: "playbooks", id: tPlaybookId, col: "id" })],
    ["profiles", () => ({ table: "profiles", id: tUserId, col: "user_id" })],
    ["settings", () => ({ table: "settings", id: T.tenantId, col: "tenant_id" })],
    ["tenants", () => ({ table: "tenants", id: T.tenantId, col: "id" })],
  ])("Denana reading Toko Seragam's %s row by id gets NotFoundError", async (_n, target) => {
    const before = [await attemptCount(D), await attemptCount(T)];
    const { table, id, col } = target();
    await expect(withTenant(D, (tx) => tx.getById(table, id, col))).rejects.toBeInstanceOf(NotFoundError);
    expect([await attemptCount(D), await attemptCount(T)]).toEqual(before); // no audit row, in either tenant
  });

  it("the reverse direction is invisible too", async () => {
    const before = [await attemptCount(D), await attemptCount(T)];
    await expect(withTenant(T, (tx) => tx.getById("playbooks", dPlaybookId))).rejects.toBeInstanceOf(NotFoundError);
    await expect(withTenant(T, (tx) => tx.getById("profiles", dUserId, "user_id"))).rejects.toBeInstanceOf(NotFoundError);
    expect([await attemptCount(D), await attemptCount(T)]).toEqual(before);
  });

  it("a query that names another tenant's id in its filter returns no rows", async () => {
    const rows = await withTenant(D, (tx) => tx.query("select * from settings where tenant_id = $1", [T.tenantId]));
    expect(rows).toEqual([]);
  });
});

describe("cross-tenant writes and declared references are refused and audited exactly once", () => {
  it("an insert declaring the other tenant is refused with one audit entry under the caller's tenant, and nothing is written", async () => {
    const dBefore = await attemptCount(D);
    const tBefore = await attemptCount(T);
    await expect(
      withTenant(D, (tx) => tx.insert("playbooks", { tenant_id: T.tenantId, version: 9001, config: "{}" })),
    ).rejects.toBeInstanceOf(CrossTenantReferenceError);

    expect(await attemptCount(D)).toBe(dBefore + 1);
    expect(await attemptCount(T)).toBe(tBefore); // the victim's log is untouched
    const mine = await attemptsBy(D);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ tenant_id: D.tenantId, actor: "owner", actor_id: ACTOR });
    expect(mine[0].payload).toEqual({ reason: "tenant_mismatch", table: "playbooks" });
    // Nothing reached the other tenant.
    const v = await withTenant(T, (tx) => tx.query("select 1 from playbooks where version = 9001"));
    expect(v).toHaveLength(0);
  });

  it("an update that declares the other tenant is refused, audited once, and changes nothing", async () => {
    const before = await attemptCount(T);
    await expect(
      withTenant(T, (tx) => tx.updateById("settings", D.tenantId, { tenant_id: D.tenantId, assistant_name: "hijacked" }, "tenant_id")),
    ).rejects.toBeInstanceOf(CrossTenantReferenceError);
    expect(await attemptCount(T)).toBe(before + 1);
    const own = await withTenant(T, (tx) => tx.getById<{ assistant_name: string }>("settings", T.tenantId, "tenant_id"));
    expect(own.assistant_name).toBe(tSettingsName);
    const other = await withTenant(D, (tx) => tx.getById<{ assistant_name: string }>("settings", D.tenantId, "tenant_id"));
    expect(other.assistant_name).not.toBe("hijacked");
  });

  it("a raw write that violates row-level security is refused and audited once", async () => {
    const before = await attemptCount(D);
    await expect(
      withTenant(D, (tx) => tx.query("insert into settings (tenant_id, assistant_name) values ($1, 'x')", [T.tenantId])),
    ).rejects.toBeInstanceOf(CrossTenantReferenceError);
    expect(await attemptCount(D)).toBe(before + 1);
    const last = (await attemptsBy(D)).at(-1)!;
    expect(last.payload.reason).toBe("rls_violation");
  });

  it("a raw audit_log insert for the other tenant is refused and audited once", async () => {
    const before = await attemptCount(D);
    await expect(
      withTenant(D, (tx) =>
        tx.query("insert into audit_log (tenant_id, actor, actor_id, type) values ($1, 'owner', $2, 'forged.entry')", [T.tenantId, ACTOR]),
      ),
    ).rejects.toBeInstanceOf(CrossTenantReferenceError);
    expect(await attemptCount(D)).toBe(before + 1);
    const forged = await withTenant(T, (tx) => tx.query("select 1 from audit_log where type = 'forged.entry'"));
    expect(forged).toHaveLength(0);
  });

  it("a bare-id write to another tenant's row is refused and the row is unchanged", async () => {
    // Per the 2.3 behavior this surfaces as NotFoundError (the row is invisible); whether such a
    // bare-id write should also be audited is not stated by the spec and is not asserted here.
    await expect(
      withTenant(D, (tx) => tx.updateById("settings", T.tenantId, { assistant_name: "hijacked" }, "tenant_id")),
    ).rejects.toBeInstanceOf(NotFoundError);
    const own = await withTenant(T, (tx) => tx.getById<{ assistant_name: string }>("settings", T.tenantId, "tenant_id"));
    expect(own.assistant_name).toBe(tSettingsName);
  });

  it("each refused attempt writes one entry: three attempts, three entries", async () => {
    const before = await attemptCount(T);
    for (let i = 0; i < 3; i++) {
      await expect(withTenant(T, async (tx) => tx.assertSameTenant(D.tenantId, "tasks"))).rejects.toBeInstanceOf(CrossTenantReferenceError);
    }
    expect(await attemptCount(T)).toBe(before + 3);
  });
});

describe("the seeded tenants are left as seeded", () => {
  it("both still have their active Playbook, settings and owner profile", async () => {
    for (const [c, pack] of [[D, "services"], [T, "retail"]] as const) {
      await withTenant(c, async (tx) => {
        expect(await getActivePack(tx)).toBe(pack);
        expect(await tx.query("select 1 from settings")).toHaveLength(1);
        expect(await tx.query("select 1 from profiles where role = 'owner'")).toHaveLength(1);
        expect(await tx.query("select 1 from playbooks")).not.toHaveLength(0);
      });
    }
  });
});
