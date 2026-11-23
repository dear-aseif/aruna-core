import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { hashPassword } from "../../src/server/auth/password";
import { getTaskHistory } from "../../src/server/audit";
import { withTenant, type Caller } from "../../src/server/dal";
import { activatePlaybook } from "../../src/server/playbook";
import type { TaskStatus } from "../../src/server/tasks";
import { checkedTransition } from "./checked-transition";

/** Synthetic tenants and tasks for the board's browser tests (task 9.2). Built through the server modules, never raw SQL on status. */
export const E2E_ACTION_TYPE = "e2e.board.confirm";

export interface BoardTenant {
  tenantId: string;
  email: string;
  password: string;
  agent: Caller;
}

export async function createBoardTenant(label: string, run: string): Promise<BoardTenant> {
  const tenantId = randomUUID();
  const email = `board-${label}-${run}@e2e.example`;
  const password = `pw-${randomBytes(12).toString("base64url")}`;
  const system: Caller = { tenantId, actor: "system", actorId: `e2e-board-${run}` };
  const doc = JSON.parse(readFileSync("playbooks/denana.json", "utf8"));
  await withTenant(
    system,
    async (tx) => {
      await tx.query("insert into tenants (id, name, type, status) values ($1, $2, 'pending', 'inactive')", [tenantId, `Board ${label} ${run}`]);
      await tx.insert("profiles", { email, password_hash: await hashPassword(password), role: "owner" });
    },
    "service",
  );
  if (!(await activatePlaybook(system, doc)).ok) throw new Error("playbook activation failed");
  return { tenantId, email, password, agent: { tenantId, actor: "agent", actorId: `e2e-board-agent-${run}` } };
}

/** Create a task and drive it to `status` through the state machine. `expired` = Pending Approval whose deadline has passed (not yet swept). */
export async function createBoardTask(
  t: BoardTenant,
  title: string,
  status: TaskStatus | "overdue",
  fields: Record<string, string | number | boolean> = { customer: "Contoh Pelanggan", slot: "10:00" },
): Promise<string> {
  const payload = { action_type: E2E_ACTION_TYPE, fields };
  return withTenant(t.agent, async (tx) => {
    const r = await tx.insert<{ id: string }>("tasks", { title, origin: "direct", agent: "booking", created_by: t.agent.actorId, payload: JSON.stringify(payload) });
    const path: Partial<Record<TaskStatus | "overdue", TaskStatus[]>> = {
      working: ["working"],
      in_review: ["working", "in_review"],
      pending_approval: ["working", "in_review", "pending_approval"],
      overdue: ["working", "in_review", "pending_approval"],
      done: ["working", "in_review", "done"],
    };
    for (const s of path[status] ?? []) await checkedTransition(tx, r.id, s);
    if (status === "failed") {
      await checkedTransition(tx, r.id, "working");
      await checkedTransition(tx, r.id, "failed", { error: "model unavailable" });
    }
    if (status === "overdue") await tx.query("update tasks set approval_expires_at = clock_timestamp() - interval '1 minute' where id = $1", [r.id]);
    return r.id;
  });
}

export async function taskState(t: BoardTenant, id: string): Promise<{ status: string; revision: number; decisions: number; executions: number }> {
  return withTenant(t.agent, async (tx) => {
    const row = await tx.getById<{ status: string; payload_revision: number }>("tasks", id);
    const history = await getTaskHistory(tx, id);
    return {
      status: row.status,
      revision: row.payload_revision,
      decisions: history.filter((e) => e.type === "approval.decision").length,
      executions: history.filter((e) => e.type === "e2e.action.executed").length,
    };
  });
}
