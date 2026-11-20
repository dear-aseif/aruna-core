import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeAllPools, withTenantSession } from "@/server/db";
import { callerFromAuth, withTenant, type Caller } from "@/server/dal";
import type { AuthContext } from "@/server/auth/service";
import {
  AUDIT_TYPES,
  getTaskHistory,
  listAuditEntries,
  recordAgentAction,
  recordApprovalDecision,
  recordCheckerResult,
  recordExport,
  recordSecurityEvent,
} from "@/server/audit";
import { trackTenant } from "../support/ledger";

try {
  process.loadEnvFile(".env.local");
} catch {
  /* env may already be provided by the shell */
}

const run = randomBytes(4).toString("hex");
const A: Caller = { tenantId: randomUUID(), actor: "agent", actorId: `booking-agent-${run}` };
const B: Caller = { tenantId: randomUUID(), actor: "owner", actorId: randomUUID() };

async function provision(c: Caller, label: string) {
  trackTenant(c.tenantId);
  await withTenantSession(
    c.tenantId,
    async (cl) => {
      await cl.query("insert into tenants (id, name, type, status) values ($1, $2, 'test', 'active')", [c.tenantId, `Audit ${label} ${run}`]);
    },
    "service",
  );
}

beforeAll(async () => {
  await provision(A, "A");
  await provision(B, "B");
}, 60_000);
afterAll(async () => {
  await closeAllPools();
});

/** Audit entries reference real tasks (composite FK since 4.2), so tests create one first. */
async function newTask(c: Caller): Promise<string> {
  const t = await withTenant(c, (tx) => tx.insert<{ id: string }>("tasks", { title: "audit fixture", origin: "direct", agent: "booking", created_by: c.actorId }));
  return t.id;
}
describe("audit appends", () => {
  it("land with actor, actor_id, type and payload intact", async () => {
    const task = await newTask(A);
    await withTenant(A, async (tx) => {
      await recordAgentAction(tx, task, "draft_produced", { items: 2 });
      await recordCheckerResult(tx, task, { passed: false, failures: ["amount_mismatch"] });
      await recordApprovalDecision(tx, task, { decision: "approved", revision: 3 });
      await recordExport(tx, { scope: "tenant" });
      await recordSecurityEvent(tx, "login_refused", { reason: "inactive" });
    });
    const all = await withTenant(A, (tx) => listAuditEntries(tx));
    const byType = Object.fromEntries(all.map((e) => [e.type, e]));
    expect(Object.keys(byType).sort()).toEqual(
      [AUDIT_TYPES.agentAction, AUDIT_TYPES.checkerResult, AUDIT_TYPES.approvalDecision, AUDIT_TYPES.export, "security.login_refused"].sort(),
    );
    const a = byType[AUDIT_TYPES.agentAction];
    expect(a.actor).toBe("agent");
    expect(a.actorId).toBe(A.actorId);
    expect(a.tenantId).toBe(A.tenantId);
    expect(a.taskId).toBe(task);
    expect(a.payload).toEqual({ items: 2, action: "draft_produced" });
    expect(byType[AUDIT_TYPES.checkerResult].payload).toEqual({ passed: false, failures: ["amount_mismatch"] });
    expect(byType[AUDIT_TYPES.export].taskId).toBeNull();

    const filtered = await withTenant(A, (tx) => listAuditEntries(tx, { type: AUDIT_TYPES.export }));
    expect(filtered.map((e) => e.type)).toEqual([AUDIT_TYPES.export]);
  });

  it("rejects a malformed security event kind", async () => {
    await expect(withTenant(A, (tx) => recordSecurityEvent(tx, "Bad Kind"))).rejects.toThrow(/invalid security event kind/);
  });

  it("per-task history is chronological, including entries from one transaction and across transactions", async () => {
    const task = await newTask(A);
    await withTenant(A, async (tx) => {
      await recordAgentAction(tx, task, "one");
      await recordAgentAction(tx, task, "two");
      await recordAgentAction(tx, task, "three");
    });
    await withTenant(A, (tx) => recordAgentAction(tx, task, "four"));
    const other = await newTask(A);
    await withTenant(A, (tx) => recordAgentAction(tx, other, "other-task"));
    const h = await withTenant(A, (tx) => getTaskHistory(tx, task));
    expect(h.map((e) => e.payload.action)).toEqual(["one", "two", "three", "four"]);
  });

  it("an operator session's entries carry actor 'operator' with the profile user id as actor_id", async () => {
    const ctx: AuthContext = { tenantId: B.tenantId, userId: randomUUID(), role: "operator", sessionId: randomUUID() } as AuthContext;
    const caller = callerFromAuth(ctx);
    expect(caller).toEqual({ tenantId: B.tenantId, actor: "operator", actorId: ctx.userId });
    expect(callerFromAuth({ ...ctx, role: "owner" }).actor).toBe("owner");
    await withTenant(caller, (tx) => recordSecurityEvent(tx, "operator_check"));
    const e = await withTenant(B, (tx) => listAuditEntries(tx, { type: "security.operator_check" }));
    expect(e).toHaveLength(1);
    expect(e[0].actor).toBe("operator");
    expect(e[0].actorId).toBe(ctx.userId);
  });

  it("an append inside a transaction that rolls back leaves no entry", async () => {
    const task = await newTask(A);
    await expect(
      withTenant(A, async (tx) => {
        await recordAgentAction(tx, task, "will_roll_back");
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await withTenant(A, (tx) => getTaskHistory(tx, task))).toEqual([]);
  });

  it("another tenant's entries are invisible in history and list", async () => {
    const task = await newTask(A);
    await withTenant(A, (tx) => recordAgentAction(tx, task, "secret"));
    expect(await withTenant(B, (tx) => getTaskHistory(tx, task))).toEqual([]);
    const bAll = await withTenant(B, (tx) => listAuditEntries(tx, { limit: 500 }));
    expect(bAll.every((e) => e.tenantId === B.tenantId)).toBe(true);
    expect(bAll.some((e) => e.payload.action === "secret")).toBe(false);
  });

  it("the runtime role cannot update or delete audit entries", async () => {
    await expect(withTenant(A, (tx) => tx.query("update audit_log set type = 'x'"))).rejects.toThrow();
    await expect(withTenant(A, (tx) => tx.query("delete from audit_log"))).rejects.toThrow();
  });
});
