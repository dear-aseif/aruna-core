import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeAllPools, withTenantSession } from "@/server/db";
import { withTenant, type Caller } from "@/server/dal";
import { getTaskHistory } from "@/server/audit";
import { registerCheckerPack, checkTask, requiredFields } from "@/server/checker";
import { TEST_ACTION_TYPES as T, TestRecordStore, approveTask, registerTestApprovalHandlers, unregisterTestApprovalHandlers } from "@/server/approvals";
import { ensureThreadsTx, listThreadsTx, listMessagesTx } from "@/server/threads";
import { transitionTask, type TaskRow, type TaskStatus } from "@/server/tasks";
import {
  NOT_FOUND_TASK,
  NotMaestroThreadError,
  QuestionNotPermittedError,
  STATUS_LABELS,
  askMaestro,
  classifyQuestion,
  type KnownAgent,
} from "@/server/maestro";
import { trackTenant } from "../support/ledger";
import { registerTestSpecialists } from "../support/test-specialists";

try {
  process.loadEnvFile(".env.local");
} catch {
  /* env may already be provided by the shell */
}

// Maestro live-data answers (task 8.3). Two synthetic tenants, app runtime role (RLS applies).
const run = randomBytes(4).toString("hex");
const PACK = `maestro-pack-${run}`;
const A = { id: randomUUID(), name: "Alma" };
const B = { id: randomUUID(), name: "Bima" };
const owner = (t: { id: string }): Caller => ({ tenantId: t.id, actor: "owner", actorId: `mq-owner-${run}` });
const agent = (t: { id: string }): Caller => ({ tenantId: t.id, actor: "agent", actorId: `mq-agent-${run}` });
const store = new TestRecordStore();
let maestroA = "";
let scribeA = "";
let maestroB = "";

beforeAll(async () => {
  registerTestSpecialists();
  registerCheckerPack({ packId: PACK, rules: [requiredFields("required", ["record_id"])] });
  registerTestApprovalHandlers(store);
  for (const t of [A, B]) {
    trackTenant(t.id);
    await withTenantSession(
      t.id,
      async (c) => {
        await c.query("insert into tenants (id, name, type, active_pack, status) values ($1, $2, 'test', 'services', 'active')", [t.id, `Maestro ${t.name} ${run}`]);
        await c.query("insert into settings (tenant_id, assistant_name) values ($1, $2)", [t.id, t.name]);
      },
      "service",
    );
    await withTenant(owner(t), (tx) => ensureThreadsTx(tx));
  }
  const threads = async (t: { id: string }) => Object.fromEntries((await withTenant(owner(t), (tx) => listThreadsTx(tx))).map((th) => [th.agent, th.id]));
  const ta = await threads(A);
  maestroA = ta.maestro;
  scribeA = ta.test_scribe;
  maestroB = (await threads(B)).maestro;
}, 60_000);

afterAll(async () => {
  unregisterTestApprovalHandlers();
  await closeAllPools();
});

/** Insert a task for a tenant, moved to the requested status through the state machine. */
async function makeTask(t: { id: string }, title: string, agentId: string, target: TaskStatus): Promise<string> {
  return withTenant(agent(t), async (tx) => {
    const task = await tx.insert<TaskRow>("tasks", { title, origin: "direct", agent: agentId, created_by: `mq-agent-${run}` });
    if (target === "queued") return task.id;
    await transitionTask(tx, task.id, "working");
    if (target === "working") return task.id;
    if (target === "failed") {
      await transitionTask(tx, task.id, "failed", { error: "boom", reason: "test" });
      return task.id;
    }
    await transitionTask(tx, task.id, "in_review");
    if (target === "in_review") return task.id;
    const recordId = randomUUID();
    store.put(recordId, { state: "pending" });
    await tx.query("update tasks set payload = $2::jsonb where id = $1", [task.id, JSON.stringify({ action_type: T.bookingConfirm, fields: { record_id: recordId } })]);
    const out = await checkTask(tx, task.id, { packId: PACK });
    expect(out.route).toBe("pending_approval");
    return task.id;
  });
}

const row = (t: { id: string }, id: string) => withTenant(owner(t), (tx) => tx.getById<TaskRow>("tasks", id));
const counts = (t: { id: string }) =>
  withTenant(owner(t), async (tx) => Object.fromEntries((await tx.query<{ status: string; n: number }>("select status, count(*)::int n from tasks group by status")).map((r) => [r.status, r.n])));
const ask = (t: { id: string }, threadId: string, body: string) => askMaestro(owner(t), { threadId, body });
const setDeadline = (t: { id: string }, id: string, secs: number) =>
  withTenant(owner(t), (tx) => tx.query("update tasks set approval_expires_at = clock_timestamp() + make_interval(secs => $2) where id = $1", [id, secs]));

describe("question recognition", () => {
  const agents: KnownAgent[] = [
    { id: "maestro", label: "Alma" },
    { id: "test_scribe", label: "Test Scribe" },
  ];
  it("maps supported question types and leaves the rest unsupported", () => {
    expect(classifyQuestion("What is Test Scribe doing right now?", agents)).toEqual({ kind: "agent_activity", agent: "test_scribe" });
    expect(classifyQuestion("what is everyone doing", agents)).toEqual({ kind: "agent_activity", agent: null });
    expect(classifyQuestion("What is the Payroll agent doing?", agents)).toEqual({ kind: "unknown_agent", name: "payroll" });
    expect(classifyQuestion("What is waiting for my approval?", agents)).toEqual({ kind: "pending_approvals" });
    expect(classifyQuestion("How many tasks are failed?", agents)).toEqual({ kind: "status_counts", status: "failed" });
    expect(classifyQuestion("how many tasks do we have", agents)).toEqual({ kind: "status_counts", status: null });
    expect(classifyQuestion("what happened recently", agents)).toEqual({ kind: "recent_activity" });
    expect(classifyQuestion("Will sales go up next month?", agents)).toEqual({ kind: "unsupported" });
    expect(classifyQuestion("What did I approve yesterday?", agents)).toEqual({ kind: "unsupported" });
  });
});

describe("answers come from live task and audit state", () => {
  it("an agent-activity answer states exactly the live tasks, statuses and last audit entry", async () => {
    const pendingId = await makeTask(A, `Confirm facial ${run}`, "test_scribe", "pending_approval");
    const queuedId = await makeTask(A, `Prepare consult ${run}`, "test_scribe", "queued");
    const r = await ask(A, maestroA, "What is Test Scribe doing right now?");
    expect(r.intent).toBe("agent_activity");
    expect(r.text).toContain("Test Scribe: 2 open tasks.");
    for (const id of [pendingId, queuedId]) {
      const task = await row(A, id);
      const last = (await withTenant(owner(A), (tx) => getTaskHistory(tx, id))).at(-1);
      const activity = last ? `last activity: ${last.type} by ${last.actor} (${last.actorId}) at ${last.createdAt.toISOString()}` : "no activity recorded"; // a raw fixture insert has no audit entry
      expect(r.text).toContain(`"${task.title}": ${STATUS_LABELS[task.status]} (${activity}`);
    }
    const pending = await row(A, pendingId);
    expect(r.text).toContain(`approval expires at ${pending.approval_expires_at!.toISOString()}`);
  });

  it("status counts equal the database counts exactly", async () => {
    await makeTask(A, `Failing job ${run}`, "maestro", "failed");
    const db = await counts(A);
    const all = await ask(A, maestroA, "How many tasks are there?");
    for (const s of Object.keys(STATUS_LABELS) as TaskStatus[]) expect(all.text).toContain(`${STATUS_LABELS[s]} ${db[s] ?? 0}`);
    const failed = await ask(A, maestroA, "How many tasks are failed?");
    expect(failed.text).toBe(`${db.failed} task${db.failed === 1 ? " is" : "s are"} Failed.`);
  });

  it("the question and the answer are both recorded in the Maestro thread, and no task is created", async () => {
    const before = await counts(A);
    const r = await ask(A, maestroA, "what happened recently?");
    expect(await counts(A)).toEqual(before);
    const msgs = await withTenant(owner(A), (tx) => listMessagesTx(tx, maestroA, { limit: 2 }));
    expect(msgs.map((m) => [m.id, m.sender, m.taskId])).toEqual([
      [r.questionMessageId, "owner", null],
      [r.answerMessageId, "agent", null],
    ]);
    expect(msgs[1].body).toBe(r.text);
    expect(msgs[1].senderName).toBe("Alma");
  });
});

describe("answers reflect changes immediately", () => {
  it("a task approved is reported Done on the next question", async () => {
    const id = await makeTask(A, `Approve me ${run}`, "test_scribe", "pending_approval");
    const before = await ask(A, maestroA, `What is the status of ${id}?`);
    expect(before.text).toContain(`"Approve me ${run}" (test_scribe): Pending Approval`);
    const pendingBefore = (await counts(A)).pending_approval ?? 0;
    expect((await ask(A, maestroA, "How many tasks are pending approval?")).text).toContain(`${pendingBefore} task`);
    await approveTask(owner(A), id, (await row(A, id)).payload_revision);
    const after = await ask(A, maestroA, `What is the status of ${id}?`);
    expect(after.text).toContain(`"Approve me ${run}" (test_scribe): Done`);
    expect(after.text).toContain("approval.decision");
    expect((await ask(A, maestroA, "How many tasks are pending approval?")).text).toContain(`${pendingBefore - 1} task`);
  });

  it("a task past its deadline is reported Expired on the next question, with no sweep running", async () => {
    const id = await makeTask(A, `Let me lapse ${run}`, "test_scribe", "pending_approval");
    await setDeadline(A, id, -5);
    expect((await row(A, id)).status).toBe("pending_approval"); // nothing has expired it yet
    const r = await ask(A, maestroA, "What is waiting for my approval?");
    expect(r.text).not.toContain(`Let me lapse ${run}`);
    expect((await row(A, id)).status).toBe("expired");
    expect((await ask(A, maestroA, `status of ${id}`)).text).toContain(`"Let me lapse ${run}" (test_scribe): Expired`);
  });

  it("a task still inside its window is reported pending", async () => {
    const id = await makeTask(A, `Still open ${run}`, "test_scribe", "pending_approval");
    await setDeadline(A, id, 600);
    expect((await ask(A, maestroA, "What is waiting for my approval?")).text).toContain(`"Still open ${run}": Pending Approval`);
  });
});

describe("tenant isolation", () => {
  it("another tenant's tasks never appear and its task id finds nothing", async () => {
    const bTitle = `Bima secret ${run}`;
    const bId = await makeTask(B, bTitle, "test_scribe", "pending_approval");
    const bCounts = await counts(B);
    const asks = ["What is Test Scribe doing right now?", "What is waiting for my approval?", "what happened recently", "how many tasks are there"];
    for (const q of asks) expect((await ask(A, maestroA, q)).text).not.toContain(bTitle);
    const byId = await ask(A, maestroA, `What is the status of ${bId}?`);
    expect(byId.text).toBe(NOT_FOUND_TASK);
    // Tenant A's totals are A's own, not the sum of both tenants.
    const aCounts = await counts(A);
    const total = (await ask(A, maestroA, "how many tasks are there")).text;
    expect(total).toContain(`Pending Approval ${aCounts.pending_approval ?? 0}`);
    expect(bCounts.pending_approval).toBeGreaterThan(0);
    // B sees its own task and its own count.
    expect((await ask(B, maestroB, "What is waiting for my approval?")).text).toContain(bTitle);
    // The task of B is untouched by A's questions.
    expect((await row(B, bId)).status).toBe("pending_approval");
  });

  it("an agent of another tenant's pack is not an agent here", async () => {
    const r = await ask(A, maestroA, "What is test_counter doing?");
    expect(r.intent).toBe("unknown_agent");
    expect(r.text).toContain('I have no agent called "test_counter"');
    expect(r.text).toContain("Test Scribe");
    expect(r.text).not.toContain("Test Counter");
  });

  it("another tenant's thread cannot be used to ask", async () => {
    await expect(ask(A, maestroB, "what happened recently")).rejects.toThrow();
  });
});

describe("unsupported questions", () => {
  it("get a bounded reply naming what can be answered, with nothing fabricated", async () => {
    const before = await counts(A);
    for (const q of ["What will sales be next month?", "Who is my best customer?", "What did I approve yesterday?"]) {
      const r = await ask(A, maestroA, q);
      expect(r.intent).toBe("unsupported");
      expect(r.text).toContain("I can't answer that from your workspace data, so I won't guess.");
      expect(r.text).toContain("what each agent is doing");
      expect(r.text).toContain("Test Scribe");
      expect(r.text).not.toMatch(/\d/); // no number appears in a reply that has no facts
    }
    expect(await counts(A)).toEqual(before);
  });
});

describe("guards", () => {
  it("only the owner asks, and only in the Maestro thread", async () => {
    await expect(askMaestro(agent(A), { threadId: maestroA, body: "status?" })).rejects.toBeInstanceOf(QuestionNotPermittedError);
    await expect(askMaestro(owner(A), { threadId: scribeA, body: "what is everyone doing" })).rejects.toBeInstanceOf(NotMaestroThreadError);
    await expect(askMaestro(owner(A), { threadId: maestroA, body: "   " })).rejects.toThrow();
  });
});
