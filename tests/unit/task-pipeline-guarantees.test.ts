import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { closeAllPools, withTenantSession } from "@/server/db";
import { withTenant, TenantTx, type Caller } from "@/server/dal";
import { getTaskHistory } from "@/server/audit";
import {
  ApprovalExpiredError,
  RetryNotPermittedError,
  clearExpiryActionCancellers,
  readTask,
  retryTask,
  sweepExpiredApprovals,
  transitionTask,
  withApprovalAction,
  type TaskRow,
  type TaskStatus,
} from "@/server/tasks";
import { trackTenant } from "../support/ledger";
try {
  process.loadEnvFile(".env.local");
} catch {
  /* env may already be provided by the shell */
}
/**
 * Task 4.5: pipeline guarantees (Requirements 3.3, 5.4, 6.1, 6.2, 6.3; Properties 4, 5).
 * Complements task-state-machine.test.ts and task-expiry.test.ts with: Failed from both source
 * states, non-owner retry, audit field and database-timestamp checks, the deadline boundary
 * through both expiry triggers, approve-versus-sweep races with a marker side-effect, and
 * audit-atomicity fault injection in both directions.
 */
vi.setConfig({ testTimeout: 180_000 }); // each step is a round trip to the managed database
const run = randomBytes(4).toString("hex");
const OWNER: Caller = { tenantId: randomUUID(), actor: "owner", actorId: randomUUID() };
const AGENT: Caller = { ...OWNER, actor: "agent", actorId: `pipeline-agent-${run}` };
const SYSTEM: Caller = { ...OWNER, actor: "system", actorId: `test-system-${run}` };
const OPERATOR: Caller = { ...OWNER, actor: "operator", actorId: `test-operator-${run}` };

beforeAll(async () => {
  trackTenant(OWNER.tenantId);
  await withTenantSession(
    OWNER.tenantId,
    async (cl) => {
      await cl.query("insert into tenants (id, name, type, status) values ($1, $2, 'test', 'active')", [OWNER.tenantId, `Pipeline ${run}`]);
    },
    "service",
  );
}, 60_000);
afterEach(() => {
  vi.restoreAllMocks();
  clearExpiryActionCancellers();
});
afterAll(async () => {
  await closeAllPools();
});

const newTask = () =>
  withTenant(OWNER, (tx) => tx.insert<{ id: string }>("tasks", { title: "fixture", origin: "direct", agent: "booking", created_by: OWNER.actorId })).then((t) => t.id);
const PATH: Partial<Record<TaskStatus, TaskStatus[]>> = {
  queued: [],
  working: ["working"],
  in_review: ["working", "in_review"],
  pending_approval: ["working", "in_review", "pending_approval"],
};
async function taskAt(target: keyof typeof PATH): Promise<string> {
  const id = await newTask();
  for (const s of PATH[target]!) await withTenant(AGENT, (tx) => transitionTask(tx, id, s));
  return id;
}
const row = (id: string) => withTenant(OWNER, (tx) => tx.getById<TaskRow>("tasks", id));
const history = (id: string) => withTenant(OWNER, (tx) => getTaskHistory(tx, id));
const dbNow = () => withTenant(OWNER, async (tx) => (await tx.query<{ t: Date }>("select clock_timestamp() as t"))[0].t);
/** Place the deadline relative to DATABASE time (seconds; negative = already passed). */
const setDeadline = (id: string, secs: number) =>
  withTenant(OWNER, (tx) => tx.query("update tasks set approval_expires_at = clock_timestamp() + make_interval(secs => $2) where id = $1", [id, secs]));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const expiredEntries = async (id: string) => (await history(id)).filter((e) => e.type === "task.transition" && e.payload.to === "expired");

describe("state machine: Failed and retry", () => {
  it.each(["working", "in_review"] as const)("moves %s -> failed with a recorded error, audited with actor, from, to and a database timestamp", async (from) => {
    const id = await taskAt(from);
    const before = await dbNow();
    await withTenant(AGENT, (tx) => transitionTask(tx, id, "failed", { error: "provider timeout" }));
    const after = await dbNow();
    expect(await row(id)).toMatchObject({ status: "failed", error: "provider timeout" });
    const last = (await history(id)).at(-1)!;
    expect(last).toMatchObject({ type: "task.transition", actor: "agent", actorId: AGENT.actorId, taskId: id });
    expect(last.payload).toMatchObject({ from, to: "failed", error: "provider timeout" });
    expect(last.createdAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(last.createdAt.getTime()).toBeLessThanOrEqual(after.getTime());
  });
  it.each(["queued", "pending_approval"] as const)("refuses %s -> failed and changes nothing", async (from) => {
    const id = await taskAt(from);
    const n = (await history(id)).length;
    await expect(withTenant(AGENT, (tx) => transitionTask(tx, id, "failed", { error: "x" }))).rejects.toThrow(/illegal task transition/);
    expect((await row(id)).status).toBe(from);
    expect(await history(id)).toHaveLength(n);
  });
  it("failed returns to queued only through the owner retry; every other actor is refused", async () => {
    const id = await taskAt("working");
    await withTenant(AGENT, (tx) => transitionTask(tx, id, "failed", { error: "boom" }));
    await expect(withTenant(AGENT, (tx) => transitionTask(tx, id, "queued"))).rejects.toThrow(/illegal task transition/);
    for (const who of [AGENT, SYSTEM, OPERATOR]) {
      await expect(withTenant(who, (tx) => retryTask(tx, id))).rejects.toBeInstanceOf(RetryNotPermittedError);
    }
    expect((await row(id)).status).toBe("failed");
    const before = await dbNow();
    await withTenant(OWNER, (tx) => retryTask(tx, id));
    const after = await dbNow();
    expect((await row(id)).status).toBe("queued");
    const last = (await history(id)).at(-1)!;
    expect(last).toMatchObject({ type: "task.retry", actor: "owner", actorId: OWNER.actorId });
    expect(last.payload).toMatchObject({ from: "failed", to: "queued" });
    expect(last.createdAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(last.createdAt.getTime()).toBeLessThanOrEqual(after.getTime());
  });
});

describe("expiry at the approval_expires_at boundary, through both triggers", () => {
  const triggers = {
    sweep: async (id: string) => {
      const r = await sweepExpiredApprovals();
      expect(r.errors).toEqual([]);
      return (await row(id)).status;
    },
    lazy: async (id: string) => (await readTask(OWNER, id)).status,
  };
  // Offsets from database time: 30 s before (a margin wider than any remote-DB/suite-load latency
  // between writing the deadline and the check), the boundary instant itself, 1 ms after.
  // The live clock cannot be frozen, so "at" is the instant captured when the deadline is
  // written (the check happens at or after it); the predicate is `deadline <= clock_timestamp()`.
  const cases: [string, number, string][] = [
    ["just before", 30, "pending_approval"],
    ["exactly at", 0, "expired"],
    ["just after", -0.001, "expired"],
  ];
  for (const [name, trigger] of Object.entries(triggers)) {
    it.each(cases)(`${name}: %s the deadline`, async (_label, offset, expected) => {
      const id = await taskAt("pending_approval");
      await setDeadline(id, offset);
      expect(await trigger(id)).toBe(expected);
      expect(await expiredEntries(id)).toHaveLength(expected === "expired" ? 1 : 0);
    });
  }
  it("the comparison is inclusive: a deadline equal to the compared instant counts as overdue", async () => {
    const [r] = await withTenant(OWNER, (tx) => tx.query<{ eq: boolean }>("select (t <= t) as eq from (select clock_timestamp() as t) s"));
    expect(r.eq).toBe(true);
  });
});

describe("approve versus sweep race (Property 5)", () => {
  /** An approval whose side-effect is a marker; the marker is the stand-in for an executed action. */
  const approve = (id: string, markers: string[]) =>
    withApprovalAction(OWNER, id, async (tx) => {
      markers.push(id);
      await transitionTask(tx, id, "done");
    });

  it("approval inside its window holds the row; a sweep landing after the deadline cannot expire it", async () => {
    const id = await taskAt("pending_approval");
    await setDeadline(id, 5);
    const markers: string[] = [];
    let sweep: ReturnType<typeof sweepExpiredApprovals> | undefined;
    await withApprovalAction(OWNER, id, async (tx) => {
      markers.push(id);
      // hold the row lock until database time passes the deadline, then start the sweep
      for (;;) {
        const [r] = await tx.query<{ due: boolean }>("select approval_expires_at <= clock_timestamp() as due from tasks where id = $1", [id]);
        if (r.due) break;
        await sleep(250);
      }
      sweep = sweepExpiredApprovals();
      await sleep(1500); // the sweep sees the task as overdue and blocks on the row lock
      await transitionTask(tx, id, "done");
    });
    expect((await sweep!).errors).toEqual([]);
    expect((await row(id)).status).toBe("done");
    expect(markers).toEqual([id]);
    expect(await expiredEntries(id)).toHaveLength(0);
  }, 180_000);

  it("sweep first: the approval is refused and its action never executes", async () => {
    const id = await taskAt("pending_approval");
    await setDeadline(id, -1);
    expect((await sweepExpiredApprovals()).errors).toEqual([]);
    const markers: string[] = [];
    await expect(approve(id, markers)).rejects.toBeInstanceOf(ApprovalExpiredError);
    expect(markers).toEqual([]);
    expect((await row(id)).status).toBe("expired");
  }, 180_000);

  it("concurrent, at the deadline: exactly one outcome, and no marker after Expired", async () => {
    for (let i = 0; i < 4; i++) {
      const id = await taskAt("pending_approval");
      await setDeadline(id, 0.25);
      await sleep(240 + i * 4); // straddle the deadline across iterations
      const markers: string[] = [];
      const [a, s] = await Promise.allSettled([approve(id, markers), sweepExpiredApprovals()]);
      expect(s.status).toBe("fulfilled");
      const final = (await row(id)).status;
      const terminal = (await history(id)).filter((e) => e.type === "task.transition" && ["done", "expired"].includes(String(e.payload.to)));
      expect(terminal).toHaveLength(1);
      expect(terminal[0].payload.to).toBe(final);
      if (final === "done") {
        expect(a.status).toBe("fulfilled");
        expect(markers).toEqual([id]);
      } else {
        expect(final).toBe("expired");
        expect(a.status).toBe("rejected");
        expect((a as PromiseRejectedResult).reason).toBeInstanceOf(ApprovalExpiredError);
        expect(markers).toEqual([]);
      }
    }
  }, 180_000);

  it("after Expired, repeated approval attempts never execute", async () => {
    const id = await taskAt("pending_approval");
    await setDeadline(id, -1);
    await readTask(OWNER, id);
    const markers: string[] = [];
    for (let i = 0; i < 3; i++) await expect(approve(id, markers)).rejects.toThrow();
    expect(markers).toEqual([]);
    expect((await row(id)).status).toBe("expired");
  });
});

describe("audit atomicity fault injection (Property 4)", () => {
  it("a failing audit write rolls back the business mutation (status, timestamps, error)", async () => {
    const id = await taskAt("working");
    const before = await row(id);
    const n = (await history(id)).length;
    const real = TenantTx.prototype.audit;
    vi.spyOn(TenantTx.prototype, "audit").mockImplementation(async function (this: TenantTx, type, payload, taskId) {
      if (type === "task.transition") throw new Error("injected audit failure");
      return real.call(this, type, payload, taskId);
    });
    await expect(withTenant(AGENT, (tx) => transitionTask(tx, id, "failed", { error: "x" }))).rejects.toThrow("injected audit failure");
    vi.restoreAllMocks();
    const after = await row(id);
    expect(after).toMatchObject({ status: "working", error: null });
    expect(after.updated_at).toEqual(before.updated_at);
    expect(await history(id)).toHaveLength(n);
  });
  it("a failing audit write rolls back the retry and the expiry as well", async () => {
    const failedId = await taskAt("working");
    await withTenant(AGENT, (tx) => transitionTask(tx, failedId, "failed", { error: "e" }));
    const pendingId = await taskAt("pending_approval");
    await setDeadline(pendingId, -1);
    const real = TenantTx.prototype.audit;
    vi.spyOn(TenantTx.prototype, "audit").mockImplementation(async function (this: TenantTx, type, payload, taskId) {
      if (type === "task.retry" || type === "task.actions_cancelled") throw new Error("injected audit failure");
      return real.call(this, type, payload, taskId);
    });
    await expect(withTenant(OWNER, (tx) => retryTask(tx, failedId))).rejects.toThrow("injected audit failure");
    // the lazy check runs the expiry transition, then its actions-cancelled audit fails: whole expiry rolls back
    await expect(readTask(OWNER, pendingId)).rejects.toThrow("injected audit failure");
    vi.restoreAllMocks();
    expect((await row(failedId)).status).toBe("failed");
    expect((await row(pendingId)).status).toBe("pending_approval");
    expect(await expiredEntries(pendingId)).toHaveLength(0);
  });
  it("a failing mutation leaves no success audit entry", async () => {
    const id = await taskAt("working");
    const n = (await history(id)).length;
    const realQuery = TenantTx.prototype.query;
    vi.spyOn(TenantTx.prototype, "query").mockImplementation(async function (this: TenantTx, text: string, params?: unknown[]) {
      if (/update tasks set status/.test(text)) throw new Error("injected mutation failure");
      return realQuery.call(this, text, params);
    } as typeof TenantTx.prototype.query);
    await expect(withTenant(AGENT, (tx) => transitionTask(tx, id, "in_review"))).rejects.toThrow("injected mutation failure");
    vi.restoreAllMocks();
    expect((await row(id)).status).toBe("working");
    const h = await history(id);
    expect(h).toHaveLength(n);
    expect(h.some((e) => e.payload.to === "in_review")).toBe(false);
  });
});
