import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeAllPools, withTenantSession } from "@/server/db";
import { withTenant, NotFoundError, type Caller } from "@/server/dal";
import { getTaskHistory } from "@/server/audit";
import {
  IllegalTransitionError,
  RetryNotPermittedError,
  TASK_STATUSES,
  TRANSITIONS,
  isLegalTransition,
  retryTask,
  transitionTask,
  type TaskStatus,
} from "@/server/tasks";
import { trackTenant } from "../support/ledger";
try {
  process.loadEnvFile(".env.local");
} catch {
  /* env may already be provided by the shell */
}
const run = randomBytes(4).toString("hex");
const OWNER_A: Caller = { tenantId: randomUUID(), actor: "owner", actorId: randomUUID() };
const AGENT_A: Caller = { ...OWNER_A, actor: "agent", actorId: `booking-agent-${run}` };
const OWNER_B: Caller = { tenantId: randomUUID(), actor: "owner", actorId: randomUUID() };
async function provision(c: Caller, label: string) {
  trackTenant(c.tenantId);
  await withTenantSession(
    c.tenantId,
    async (cl) => {
      await cl.query("insert into tenants (id, name, type, status) values ($1, $2, 'test', 'active')", [c.tenantId, `Tasks ${label} ${run}`]);
    },
    "service",
  );
}
beforeAll(async () => {
  await provision(OWNER_A, "A");
  await provision(OWNER_B, "B");
}, 60_000);
afterAll(async () => {
  await closeAllPools();
});
const newTask = (c: Caller) =>
  withTenant(c, (tx) => tx.insert<{ id: string }>("tasks", { title: "fixture", origin: "direct", agent: "booking", created_by: c.actorId })).then((t) => t.id);
const statusOf = (c: Caller, id: string) => withTenant(c, async (tx) => (await tx.getById<{ status: string }>("tasks", id)).status);
/** The legal path from a fresh (queued) task to each status. */
const PATH: Record<TaskStatus, TaskStatus[]> = {
  queued: [],
  working: ["working"],
  in_review: ["working", "in_review"],
  pending_approval: ["working", "in_review", "pending_approval"],
  done: ["working", "in_review", "pending_approval", "done"],
  rejected: ["working", "in_review", "pending_approval", "rejected"],
  expired: ["working", "in_review", "pending_approval", "expired"],
  failed: ["working", "failed"],
};
async function taskAt(target: TaskStatus): Promise<string> {
  const id = await newTask(OWNER_A);
  for (const s of PATH[target]) await withTenant(AGENT_A, (tx) => transitionTask(tx, id, s, { error: "provider timeout" }));
  return id;
}
describe("transition table", () => {
  it("is exactly the design §2.3 flow, as amended by gate ruling 6.3", () => {
    expect(TRANSITIONS).toEqual({
      queued: ["working"],
      working: ["in_review", "failed"],
      in_review: ["pending_approval", "done", "working", "failed"],
      pending_approval: ["done", "rejected", "expired", "in_review"],
      done: [],
      rejected: [],
      expired: [],
      failed: [],
    });
  });
  it("every status pair outside the table is illegal; failed -> queued is not a generic transition", () => {
    for (const from of TASK_STATUSES)
      for (const to of TASK_STATUSES) expect(isLegalTransition(from, to)).toBe(TRANSITIONS[from].includes(to));
    expect(isLegalTransition("failed", "queued")).toBe(false);
  });
  it("failed is reachable only from working and in_review", () => {
    expect(TASK_STATUSES.filter((s) => isLegalTransition(s, "failed")).sort()).toEqual(["in_review", "working"]);
  });
});
describe("transitions against the database", () => {
  it("each legal move succeeds and writes one audit entry with actor, from and to", async () => {
    const id = await newTask(OWNER_A);
    for (const to of ["working", "in_review", "pending_approval", "done"] as const)
      await withTenant(AGENT_A, (tx) => transitionTask(tx, id, to));
    const h = (await withTenant(OWNER_A, (tx) => getTaskHistory(tx, id))).filter((e) => e.type === "task.transition");
    expect(h.map((e) => [e.payload.from, e.payload.to])).toEqual([
      ["queued", "working"],
      ["working", "in_review"],
      ["in_review", "pending_approval"],
      ["pending_approval", "done"],
    ]);
    expect(h.every((e) => e.actor === "agent" && e.actorId === AGENT_A.actorId && e.taskId === id && e.createdAt instanceof Date)).toBe(true);
    expect(await statusOf(OWNER_A, id)).toBe("done");
  });
  it("every illegal pair throws IllegalTransitionError and changes nothing (no status change, no audit)", async () => {
    for (const from of TASK_STATUSES) {
      const illegal = TASK_STATUSES.filter((to) => !isLegalTransition(from, to));
      const id = await taskAt(from);
      const before = await withTenant(OWNER_A, (tx) => getTaskHistory(tx, id));
      for (const to of illegal) {
        await expect(withTenant(AGENT_A, (tx) => transitionTask(tx, id, to, { error: "x" }))).rejects.toBeInstanceOf(IllegalTransitionError);
      }
      expect(await statusOf(OWNER_A, id)).toBe(from);
      expect(await withTenant(OWNER_A, (tx) => getTaskHistory(tx, id))).toHaveLength(before.length);
    }
  }, 120_000);
  it("the general API refuses pending_approval -> in_review (reserved for draft revision), changing nothing", async () => {
    const id = await taskAt("pending_approval");
    const n = (await withTenant(OWNER_A, (tx) => getTaskHistory(tx, id))).length;
    for (const reason of [undefined, "draft_revised"])
      await expect(withTenant(AGENT_A, (tx) => transitionTask(tx, id, "in_review", { reason }))).rejects.toBeInstanceOf(IllegalTransitionError);
    expect(await statusOf(OWNER_A, id)).toBe("pending_approval");
    expect(await withTenant(OWNER_A, (tx) => getTaskHistory(tx, id))).toHaveLength(n);
    const barrel = await import("@/server/tasks");
    expect("returnToReviewOnRevision" in barrel).toBe(false);
  });
  it("rework (in_review -> working) is legal", async () => {
    const id = await taskAt("in_review");
    await withTenant(AGENT_A, (tx) => transitionTask(tx, id, "working", { reason: "anomaly" }));
    expect(await statusOf(OWNER_A, id)).toBe("working");
  });
  it("moving to failed records the error on the task and in the audit entry; an error is required", async () => {
    const id = await taskAt("working");
    await expect(withTenant(AGENT_A, (tx) => transitionTask(tx, id, "failed"))).rejects.toThrow(/requires a recorded error/);
    expect(await statusOf(OWNER_A, id)).toBe("working");
    await withTenant(AGENT_A, (tx) => transitionTask(tx, id, "failed", { error: "provider unreachable" }));
    const row = await withTenant(OWNER_A, (tx) => tx.getById<{ status: string; error: string }>("tasks", id));
    expect(row).toMatchObject({ status: "failed", error: "provider unreachable" });
    const last = (await withTenant(OWNER_A, (tx) => getTaskHistory(tx, id))).at(-1)!;
    expect(last.payload).toMatchObject({ from: "working", to: "failed", error: "provider unreachable" });
  });
});
describe("owner retry", () => {
  it("returns a failed task to queued only for the owner, and audits it", async () => {
    const id = await taskAt("failed");
    await expect(withTenant(AGENT_A, (tx) => retryTask(tx, id))).rejects.toBeInstanceOf(RetryNotPermittedError);
    expect(await statusOf(OWNER_A, id)).toBe("failed");
    await withTenant(OWNER_A, (tx) => retryTask(tx, id));
    const row = await withTenant(OWNER_A, (tx) => tx.getById<{ status: string; error: string | null }>("tasks", id));
    expect(row).toMatchObject({ status: "queued", error: null });
    const last = (await withTenant(OWNER_A, (tx) => getTaskHistory(tx, id))).at(-1)!;
    expect(last).toMatchObject({ type: "task.retry", actor: "owner", actorId: OWNER_A.actorId });
    expect(last.payload).toEqual({ from: "failed", to: "queued", previous_error: "provider timeout" });
  });
  it("is refused for a task that is not failed", async () => {
    const id = await taskAt("done");
    await expect(withTenant(OWNER_A, (tx) => retryTask(tx, id))).rejects.toBeInstanceOf(IllegalTransitionError);
  });
});
describe("status is changed only by the state machine", () => {
  it("a direct status update is refused by the database; a task cannot be inserted as non-queued", async () => {
    const id = await newTask(OWNER_A);
    await expect(withTenant(OWNER_A, (tx) => tx.updateById("tasks", id, { status: "done" }))).rejects.toThrow(/state machine/);
    await expect(
      withTenant(OWNER_A, (tx) => tx.insert("tasks", { title: "x", origin: "direct", agent: "a", created_by: "u", status: "done" })),
    ).rejects.toThrow();
    expect(await statusOf(OWNER_A, id)).toBe("queued");
  });
  it("the marker does not stay on after a transition", async () => {
    const id = await newTask(OWNER_A);
    await expect(
      withTenant(AGENT_A, async (tx) => {
        await transitionTask(tx, id, "working");
        await tx.query("update tasks set status = 'done' where id = $1", [id]);
      }),
    ).rejects.toThrow(/state machine/);
    expect(await statusOf(OWNER_A, id)).toBe("queued");
  });
  it("the transition and its audit entry roll back together", async () => {
    const id = await newTask(OWNER_A);
    await expect(
      withTenant(AGENT_A, async (tx) => {
        await transitionTask(tx, id, "working");
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await statusOf(OWNER_A, id)).toBe("queued");
    expect(await withTenant(OWNER_A, (tx) => getTaskHistory(tx, id))).toEqual([]);
  });
});
describe("tenant isolation", () => {
  it("another tenant's task is invisible and cannot be transitioned or retried", async () => {
    const id = await taskAt("failed");
    await expect(withTenant(OWNER_B, (tx) => transitionTask(tx, id, "working"))).rejects.toBeInstanceOf(NotFoundError);
    await expect(withTenant(OWNER_B, (tx) => retryTask(tx, id))).rejects.toBeInstanceOf(NotFoundError);
    expect(await statusOf(OWNER_A, id)).toBe("failed");
  });
  it("an audit entry cannot reference a task of another tenant (composite FK)", async () => {
    const id = await newTask(OWNER_A);
    await expect(withTenant(OWNER_B, (tx) => tx.audit("agent.action", {}, id))).rejects.toThrow(/audit_log_task_fk/);
  });
});
