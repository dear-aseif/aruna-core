import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { closeAllPools, withTenantSession } from "@/server/db";
import { withTenant, NotFoundError, type Caller } from "@/server/dal";
import { activatePlaybook } from "@/server/playbook";
import { getTaskHistory } from "@/server/audit";
import {
  ApprovalExpiredError,
  DEFAULT_APPROVAL_EXPIRY_MINUTES,
  IllegalTransitionError,
  NotAwaitingApprovalError,
  clearExpiryActionCancellers,
  expireTaskIfOverdue,
  readTask,
  registerExpiryActionCanceller,
  sweepExpiredApprovals,
  transitionTask,
  withApprovalAction,
  type TaskRow,
} from "@/server/tasks";
import { trackTenant } from "../support/ledger";
try {
  process.loadEnvFile(".env.local");
} catch {
  /* env may already be provided by the shell */
}
const run = randomBytes(4).toString("hex");
const A: Caller = { tenantId: randomUUID(), actor: "owner", actorId: randomUUID() };
const AGENT_A: Caller = { ...A, actor: "agent", actorId: `expiry-agent-${run}` };
const B: Caller = { tenantId: randomUUID(), actor: "owner", actorId: randomUUID() }; // no Playbook: default window
const OPERATOR_A: Caller = { ...A, actor: "operator", actorId: `test-operator-${run}` };
async function provision(c: Caller, label: string) {
  trackTenant(c.tenantId);
  await withTenantSession(
    c.tenantId,
    async (cl) => {
      await cl.query("insert into tenants (id, name, type, status) values ($1, $2, 'test', 'active')", [c.tenantId, `Expiry ${label} ${run}`]);
    },
    "service",
  );
}
beforeAll(async () => {
  await provision(A, "A");
  await provision(B, "B");
  const doc = JSON.parse(readFileSync("playbooks/denana.json", "utf8"));
  doc.thresholds.approvalExpiryMinutes = 7;
  const r = await activatePlaybook(OPERATOR_A, doc);
  expect(r.ok).toBe(true);
}, 60_000);
afterEach(() => clearExpiryActionCancellers());
afterAll(async () => {
  await closeAllPools();
});
async function pendingTask(c: Caller): Promise<string> {
  const t = await withTenant(c, (tx) => tx.insert<{ id: string }>("tasks", { title: "fixture", origin: "direct", agent: "booking", created_by: c.actorId }));
  for (const s of ["working", "in_review", "pending_approval"] as const)
    await withTenant({ ...c, actor: "agent", actorId: AGENT_A.actorId }, (tx) => transitionTask(tx, t.id, s));
  return t.id;
}
/** Place the deadline relative to DATABASE time (seconds; negative = already passed). */
const setDeadline = (c: Caller, id: string, secondsFromNow: number) =>
  withTenant(c, (tx) => tx.query("update tasks set approval_expires_at = clock_timestamp() + make_interval(secs => $2) where id = $1", [id, secondsFromNow]));
const row = (c: Caller, id: string) => withTenant(c, (tx) => tx.getById<TaskRow>("tasks", id));
const history = (c: Caller, id: string) => withTenant(c, (tx) => getTaskHistory(tx, id));

describe("approval_expires_at on entering Pending Approval", () => {
  it("comes from the tenant's active Playbook (7 minutes here), by database time", async () => {
    const id = await pendingTask(A);
    const [r] = await withTenant(A, (tx) =>
      tx.query<{ mins: number }>("select extract(epoch from (approval_expires_at - updated_at)) / 60 as mins from tasks where id = $1", [id]),
    );
    expect(Number(r.mins)).toBeCloseTo(7, 3);
    const h = (await history(A, id)).find((e) => e.payload.to === "pending_approval")!;
    expect(h.payload.approval_expiry_minutes).toBe(7);
  });
  it("uses the default (15) when there is no active Playbook value", async () => {
    expect(DEFAULT_APPROVAL_EXPIRY_MINUTES).toBe(15);
    const id = await pendingTask(B);
    const [r] = await withTenant(B, (tx) =>
      tx.query<{ mins: number }>("select extract(epoch from (approval_expires_at - updated_at)) / 60 as mins from tasks where id = $1", [id]),
    );
    expect(Number(r.mins)).toBeCloseTo(15, 3);
  });
  it("is not set before Pending Approval", async () => {
    const t = await withTenant(A, (tx) => tx.insert<TaskRow>("tasks", { title: "x", origin: "direct", agent: "a", created_by: "u" }));
    expect(t.approval_expires_at).toBeNull();
  });
});

describe("expiry mechanics", () => {
  it("not yet due: stays Pending Approval, nothing audited", async () => {
    const id = await pendingTask(A);
    await setDeadline(A, id, 60);
    expect(await withTenant(A, (tx) => expireTaskIfOverdue(tx, id))).toBeNull();
    expect((await row(A, id)).status).toBe("pending_approval");
  });
  it("due: becomes Expired, audited as the system actor, actions cancelled in the same transaction", async () => {
    const cancelled: string[] = [];
    registerExpiryActionCanceller(async (_tx, task) => {
      cancelled.push(task.id);
      return 2;
    });
    const id = await pendingTask(A);
    await setDeadline(A, id, -1);
    const out = await withTenant({ ...A, actor: "system", actorId: "test-expirer" }, (tx) => expireTaskIfOverdue(tx, id));
    expect(out?.status).toBe("expired");
    expect(cancelled).toEqual([id]);
    const h = await history(A, id);
    const tr = h.find((e) => e.payload.to === "expired")!;
    expect(tr).toMatchObject({ type: "task.transition", actor: "system", actorId: "test-expirer" });
    expect(tr.payload).toMatchObject({ from: "pending_approval", reason: "approval_deadline_passed" });
    expect(h.at(-1)).toMatchObject({ type: "task.actions_cancelled", actor: "system" });
    expect(h.at(-1)!.payload).toEqual({ reason: "approval_expired", cancelled_actions: 2 });
  });
  it("a failing canceller rolls the expiry back (one transaction)", async () => {
    registerExpiryActionCanceller(async () => {
      throw new Error("cancel failed");
    });
    const id = await pendingTask(A);
    await setDeadline(A, id, -1);
    await expect(withTenant(A, (tx) => expireTaskIfOverdue(tx, id))).rejects.toThrow("cancel failed");
    expect((await row(A, id)).status).toBe("pending_approval");
  });
  it("a task that is not Pending Approval is left alone; another tenant's task is invisible", async () => {
    const id = await pendingTask(A);
    await withTenant(A, (tx) => transitionTask(tx, id, "done"));
    await setDeadline(A, id, -1);
    expect(await withTenant(A, (tx) => expireTaskIfOverdue(tx, id))).toBeNull();
    await expect(withTenant(B, (tx) => expireTaskIfOverdue(tx, id))).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("sweep", () => {
  it("expires overdue tasks per tenant as the system actor, leaves undue ones, is idempotent", async () => {
    const dueA = await pendingTask(A);
    const dueB = await pendingTask(B);
    const notDue = await pendingTask(A);
    await setDeadline(A, dueA, -5);
    await setDeadline(B, dueB, -5);
    await setDeadline(A, notDue, 600);
    const r = await sweepExpiredApprovals();
    expect(r.errors).toEqual([]);
    expect(r.expired).toBeGreaterThanOrEqual(2);
    expect((await row(A, dueA)).status).toBe("expired");
    expect((await row(B, dueB)).status).toBe("expired");
    expect((await row(A, notDue)).status).toBe("pending_approval");
    const tr = (await history(A, dueA)).find((e) => e.payload.to === "expired")!;
    expect(tr).toMatchObject({ actor: "system", actorId: "expiry-sweep" });
    const again = await sweepExpiredApprovals();
    expect(again.errors).toEqual([]);
    expect((await history(A, dueA)).filter((e) => e.payload.to === "expired")).toHaveLength(1);
  }, 60_000);
});

describe("lazy check", () => {
  it("reading an overdue Pending Approval task expires it first (audited as system) and returns Expired", async () => {
    const id = await pendingTask(A);
    await setDeadline(A, id, -1);
    const t = await readTask(A, id);
    expect(t.status).toBe("expired");
    expect((await history(A, id)).find((e) => e.payload.to === "expired")).toMatchObject({ actor: "system", actorId: "expiry-lazy-check" });
  });
  it("reading a task within its window leaves it Pending Approval", async () => {
    const id = await pendingTask(A);
    expect((await readTask(A, id)).status).toBe("pending_approval");
  });
  it("acting on an overdue task expires it and refuses the action; the action does not run", async () => {
    const id = await pendingTask(A);
    await setDeadline(A, id, -1);
    let ran = false;
    await expect(
      withApprovalAction(A, id, async (tx) => {
        ran = true;
        await transitionTask(tx, id, "done");
      }),
    ).rejects.toBeInstanceOf(ApprovalExpiredError);
    expect(ran).toBe(false);
    expect((await row(A, id)).status).toBe("expired");
  });
  it("acting within the window runs the action; acting on a decided task is refused", async () => {
    const id = await pendingTask(A);
    await withApprovalAction(A, id, (tx) => transitionTask(tx, id, "done"));
    expect((await row(A, id)).status).toBe("done");
    await expect(withApprovalAction(A, id, async () => {})).rejects.toBeInstanceOf(NotAwaitingApprovalError);
  });
  it("an action whose deadline has just passed is refused with ApprovalExpiredError", async () => {
    const id = await pendingTask(A);
    await setDeadline(A, id, 0.05);
    await new Promise((r) => setTimeout(r, 150));
    await expect(withApprovalAction(A, id, async () => {})).rejects.toBeInstanceOf(ApprovalExpiredError);
  });
});

describe("approve versus expiry at the same moment", () => {
  it("exactly one outcome: the row lock serializes them and the loser changes nothing", async () => {
    for (let i = 0; i < 6; i++) {
      const id = await pendingTask(A);
      await setDeadline(A, id, -1);
      const approve = withTenant(A, (tx) => transitionTask(tx, id, "done"));
      const expire = withTenant({ ...A, actor: "system", actorId: "test-expirer" }, (tx) => expireTaskIfOverdue(tx, id));
      const [a, e] = await Promise.allSettled([approve, expire]);
      const final = (await row(A, id)).status;
      const terminal = (await history(A, id)).filter((x) => x.type === "task.transition" && ["done", "expired"].includes(String(x.payload.to)));
      expect(terminal).toHaveLength(1);
      expect(terminal[0].payload.to).toBe(final);
      if (final === "done") {
        expect(a.status).toBe("fulfilled");
        expect(e.status === "fulfilled" && e.value === null).toBe(true);
      } else {
        expect(final).toBe("expired");
        expect(e.status).toBe("fulfilled");
        expect(a.status).toBe("rejected");
        expect((a as PromiseRejectedResult).reason).toBeInstanceOf(IllegalTransitionError);
      }
    }
  }, 60_000);
});
