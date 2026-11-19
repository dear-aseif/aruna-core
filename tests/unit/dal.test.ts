import { randomBytes, randomUUID } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeAllPools, withTenantSession } from "@/server/db";
import {
  CROSS_TENANT_AUDIT_TYPE,
  CrossTenantReferenceError,
  NotFoundError,
  TenantContextError,
  withTenant,
  type Caller,
} from "@/server/dal";

try {
  process.loadEnvFile(".env.local");
} catch {
  /* env may already be provided by the shell */
}

// Synthetic fixtures only, provisioned through the service role inside each tenant's own session.
const run = randomBytes(4).toString("hex");
const A: Caller = { tenantId: randomUUID(), actor: "owner", actorId: randomUUID() };
const B: Caller = { tenantId: randomUUID(), actor: "owner", actorId: randomUUID() };

async function provision(c: Caller, label: string) {
  await withTenantSession(
    c.tenantId,
    async (cl) => {
      await cl.query("insert into tenants (id, name, type, status) values ($1, $2, 'test', 'active')", [c.tenantId, `DAL ${label} ${run}`]);
      await cl.query("insert into settings (tenant_id, assistant_name) values ($1, $2)", [c.tenantId, `Assistant ${label}`]);
    },
    "service",
  );
}

async function auditCount(c: Caller): Promise<number> {
  return withTenant(c, async (tx) => {
    const r = await tx.query<{ n: string }>("select count(*)::text as n from audit_log where type = $1", [CROSS_TENANT_AUDIT_TYPE]);
    return Number(r[0].n);
  });
}

beforeAll(async () => {
  await provision(A, "A");
  await provision(B, "B");
}, 60_000);
afterAll(async () => {
  await closeAllPools();
});

describe("tenant isolation through the DAL (runtime role)", () => {
  it("runs as the non-owner runtime role without BYPASSRLS", async () => {
    await withTenant(A, async (tx) => {
      const r = await tx.query<{ rolsuper: boolean; rolbypassrls: boolean; u: string }>(
        "select r.rolsuper, r.rolbypassrls, current_user as u from pg_roles r where r.rolname = current_user",
      );
      expect(r[0].rolsuper).toBe(false);
      expect(r[0].rolbypassrls).toBe(false);
    });
  });

  it("a read of the other tenant's row is refused as an error, not an empty success", async () => {
    await expect(withTenant(A, (tx) => tx.getById("settings", B.tenantId, "tenant_id"))).rejects.toBeInstanceOf(NotFoundError);
    const own = await withTenant(A, (tx) => tx.getById<{ assistant_name: string }>("settings", A.tenantId, "tenant_id"));
    expect(own.assistant_name).toBe("Assistant A");
  });

  it("a write against the other tenant's row is refused and changes nothing", async () => {
    await expect(withTenant(A, (tx) => tx.updateById("settings", B.tenantId, { assistant_name: "hijacked" }, "tenant_id"))).rejects.toBeInstanceOf(NotFoundError);
    const b = await withTenant(B, (tx) => tx.getById<{ assistant_name: string }>("settings", B.tenantId, "tenant_id"));
    expect(b.assistant_name).toBe("Assistant B");
  });

  it("an insert for another tenant is refused (declared tenant mismatch)", async () => {
    await expect(withTenant(A, (tx) => tx.insert("playbooks", { tenant_id: B.tenantId, version: 1, config: "{}" }))).rejects.toBeInstanceOf(
      CrossTenantReferenceError,
    );
  });

  it("an RLS WITH CHECK violation from a raw query is refused as a cross-tenant attempt", async () => {
    await expect(
      withTenant(A, (tx) => tx.query("insert into playbooks (tenant_id, version, config) values ($1, 1, '{}')", [B.tenantId])),
    ).rejects.toBeInstanceOf(CrossTenantReferenceError);
  });
});

describe("cross-tenant audit", () => {
  it("one refused attempt writes exactly one audit row under the caller's tenant, with the stable actor id", async () => {
    const C: Caller = { tenantId: randomUUID(), actor: "owner", actorId: randomUUID() };
    await provision(C, "C");
    await expect(withTenant(C, async (tx) => tx.assertSameTenant(B.tenantId, "playbooks"))).rejects.toBeInstanceOf(CrossTenantReferenceError);
    const rows = await withTenant(C, (tx) =>
      tx.query<{ actor: string; actor_id: string; tenant_id: string; payload: { reason: string; table: string } }>(
        "select actor, actor_id, tenant_id, payload from audit_log where type = $1",
        [CROSS_TENANT_AUDIT_TYPE],
      ),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].tenant_id).toBe(C.tenantId);
    expect(rows[0].actor).toBe("owner");
    expect(rows[0].actor_id).toBe(C.actorId);
    expect(rows[0].payload).toEqual({ reason: "tenant_mismatch", table: "playbooks" });
    // The other tenant sees nothing of it.
    expect(await auditCount(B)).toBe(0);
  });

  it("the unit of work's own writes roll back with the refusal while the audit entry survives", async () => {
    const before = await auditCount(A);
    await expect(
      withTenant(A, async (tx) => {
        await tx.audit("test.work_marker");
        tx.assertSameTenant(B.tenantId);
      }),
    ).rejects.toBeInstanceOf(CrossTenantReferenceError);
    expect(await auditCount(A)).toBe(before + 1);
    const marker = await withTenant(A, (tx) => tx.query("select 1 from audit_log where type = 'test.work_marker'"));
    expect(marker).toHaveLength(0);
  });
});

describe("fail closed", () => {
  it.each([
    ["empty tenant", { ...A, tenantId: "" }],
    ["malformed tenant", { ...A, tenantId: "not-a-uuid" }],
    ["missing actor id", { ...A, actorId: "" }],
  ])("%s: no query runs", async (_n, caller) => {
    let ran = false;
    await expect(
      withTenant(caller as Caller, async () => {
        ran = true;
      }),
    ).rejects.toBeInstanceOf(TenantContextError);
    expect(ran).toBe(false);
  });

  it("a query outside any tenant binding sees no rows", async () => {
    const n = await withTenantSession(A.tenantId, async (c) => {
      await c.query("select set_config('app.tenant_id', '', true)");
      return (await c.query("select 1 from settings")).rowCount;
    });
    expect(n).toBe(0);
  });
});

describe("pool access guard", () => {
  it("no server code outside src/server/db imports the pools or the pg runtime", () => {
    const root = join(process.cwd(), "src", "server");
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const f of readdirSync(dir)) {
        const p = join(dir, f);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.tsx?$/.test(f)) {
          const rel = relative(root, p).split(sep).join("/");
          if (rel.startsWith("db/")) continue;
          const src = readFileSync(p, "utf8");
          if (/\bgetPool\b/.test(src) || /import\s+(?!type\b)[^;]*from\s+["']pg["']/.test(src)) offenders.push(rel);
        }
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });
});
