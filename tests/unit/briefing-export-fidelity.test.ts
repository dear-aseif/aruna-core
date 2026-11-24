import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { formatTimestamp } from "@/server/board/history";
import { listBriefingsTx, loadBriefingDetailForCaller, installBriefingArchive } from "@/server/briefings";
import { withTenant, type Caller } from "@/server/dal";
import { closeAllPools, withTenantSession } from "@/server/db";
import { hashPassword } from "@/server/auth/password";
import { signInWithPassword } from "@/server/auth";
import { requestOwnExport } from "@/server/exports";
import { readZip } from "@/server/exports/archive";
import { CORE_EXPORT_ENTITIES } from "@/server/exports/registry";
import { activatePlaybook } from "@/server/playbook";
import { CORE_SECTION_IDS, runBriefingRoutines, setBriefingSink } from "@/server/routines";
import { checkedTransition } from "../support/checked-transition";
import { trackTenant } from "../support/ledger";

try {
  process.loadEnvFile(".env.local");
} catch {
  /* env may already be provided by the shell */
}
// Task 10.5 (Property 9): per-fact briefing fidelity and row-level export completeness.
// Already proven elsewhere and deliberately not repeated here:
//  - cutoff blocks deactivation until a fresh export + verification: tenant-deactivation.test.ts
//    ("refuses deactivation when data changed after the cutoff...", "detects an edit to an existing record")
//  - deactivation enforcement (old session, public intake, routine, executor): tenant-deactivation.test.ts
//    ("deactivation effects and enforcement")
//  - same (tenant, date) returns the stored archive unchanged, reopening, section rendering: briefings.test.ts
//  - export counts vs source tables, manifest, credential absence, tenant scope: export-service.test.ts
// Synthetic tenants only.
const run = randomBytes(4).toString("hex");
const password = `pw-${randomBytes(12).toString("base64url")}`;
const TZ = "Asia/Jakarta";
const sys = (id: string): Caller => ({ tenantId: id, actor: "system", actorId: `fid-system-${run}` });
const operator = (id: string): Caller => ({ tenantId: id, actor: "operator", actorId: `fid-operator-${run}` });

async function provision(id: string, name: string) {
  trackTenant(id);
  await withTenantSession(id, async (c) => void (await c.query("insert into tenants (id, name, type, status) values ($1, $2, 'test', 'active')", [id, `Fid ${name} ${run}`])), "service");
  const doc = JSON.parse(readFileSync("playbooks/denana.json", "utf8"));
  doc.business.timezone = TZ;
  doc.schedule = { briefingTime: "06:00" };
  expect((await activatePlaybook(operator(id), doc)).ok).toBe(true);
}

const F = { id: randomUUID(), caller: null as unknown as Caller };
const E = randomUUID(); // a tenant with no tasks at all
const agent = (id: string): Caller => ({ tenantId: id, actor: "agent", actorId: `fid-agent-${run}` });
const DAY = "2032-03-10"; // yesterday = 2032-03-09 Jakarta = [03-08T17:00Z, 03-09T17:00Z)
const RUN_AT = new Date("2032-03-09T23:00:00Z");
const task: Record<string, { id: string; title: string }> = {};
let ownerToken = "";

async function mk(key: string, path: string[]) {
  const t = await withTenant(sys(F.id), (tx) => tx.insert<{ id: string }>("tasks", { title: `${key} ${run}`, origin: "direct", agent: "booking", created_by: `fid-${run}` }));
  for (const s of path) await withTenant(agent(F.id), (tx) => checkedTransition(tx, t.id, s as "working"));
  task[key] = { id: t.id, title: `${key} ${run}` };
}

beforeAll(async () => {
  await provision(F.id, "full");
  await provision(E, "empty");
  await mk("done-a", ["working", "in_review", "done"]);
  await mk("done-b", ["working", "in_review", "done"]);
  await mk("rej", ["working", "in_review", "pending_approval", "rejected"]);
  await mk("pend-1", ["working", "in_review", "pending_approval"]);
  await mk("pend-2", ["working", "in_review", "pending_approval"]);
  await mk("busy", ["working"]); // not an outcome, not pending
  for (const [k, at] of [["done-a", "2032-03-09T01:00:00Z"], ["done-b", "2032-03-09T10:00:00Z"], ["rej", "2032-03-09T12:00:00Z"]] as const) {
    await withTenant(sys(F.id), (tx) => tx.query("update tasks set updated_at = $2 where id = $1", [task[k].id, at]));
  }
  // owner login + messages so the export has threads and messages to compare
  const email = `fid-${run}@unit.example`;
  await withTenant(sys(F.id), async (tx) => tx.insert("profiles", { email, password_hash: await hashPassword(password), role: "owner" }), "service");
  ownerToken = (await signInWithPassword(email, password))!.sessionToken;
  await withTenant(sys(F.id), async (tx) => {
    const th = await tx.insert<{ id: string }>("threads", { kind: "maestro", agent: "maestro" });
    await tx.insert("messages", { thread_id: th.id, sender: "owner", body: `hello ${run}` });
    await tx.insert("messages", { thread_id: th.id, sender: "agent", body: `reply ${run}` });
  });
  installBriefingArchive();
}, 120_000);
afterAll(async () => {
  setBriefingSink(null);
  await closeAllPools();
});

const dbTask = (id: string) => withTenant(sys(F.id), (tx) => tx.getById<{ title: string; status: string; approval_expires_at: Date }>("tasks", id));

describe("briefing fidelity: every stated fact is checked against its source record", () => {
  it("each stored and rendered fact equals the task row it came from", async () => {
    const r = await runBriefingRoutines({ now: RUN_AT, onlyTenantIds: [F.id] });
    expect(r.results[0]).toMatchObject({ outcome: "ran", scheduleDate: DAY });
    const [b] = await withTenant(sys(F.id), (tx) => listBriefingsTx(tx));
    const y = b.sections.find((s) => s.id === CORE_SECTION_IDS.yesterdayOutcomes)!.facts as { done: number; rejected: number; expired: number; tasks: { id: string; title: string; status: string }[] };
    const p = b.sections.find((s) => s.id === CORE_SECTION_IDS.pendingApprovals)!.facts as { count: number; tasks: { id: string; title: string; approval_expires_at: string }[] };

    // Yesterday's outcomes: each listed task's title and status is the row's; each counter equals the listed rows of that status.
    expect(y.tasks.map((t) => t.id).sort()).toEqual([task["done-a"].id, task["done-b"].id, task.rej.id].sort());
    for (const t of y.tasks) {
      const row = await dbTask(t.id);
      expect([t.title, t.status]).toEqual([row.title, row.status]);
    }
    for (const s of ["done", "rejected", "expired"] as const) expect(y[s]).toBe(y.tasks.filter((t) => t.status === s).length);
    expect([y.done, y.rejected, y.expired]).toEqual([2, 1, 0]);

    // Pending approvals: exactly the Pending Approval rows, with their own deadline; the count equals the list.
    expect(p.tasks.map((t) => t.id).sort()).toEqual([task["pend-1"].id, task["pend-2"].id].sort());
    expect(p.count).toBe(p.tasks.length);
    for (const t of p.tasks) {
      const row = await dbTask(t.id);
      expect(row.status).toBe("pending_approval");
      expect(t.title).toBe(row.title);
      expect(new Date(t.approval_expires_at).getTime()).toBe(new Date(row.approval_expires_at).getTime());
    }

    // The rendered lines state the same facts: title, outcome label, link, and the deadline in the business timezone.
    const d = await loadBriefingDetailForCaller({ ...sys(F.id), actor: "owner" }, b.id);
    const ys = d.sections.find((s) => s.id === CORE_SECTION_IDS.yesterdayOutcomes)!;
    expect(ys.summary).toBe("2 done, 1 rejected, 0 expired.");
    for (const t of y.tasks) {
      const item = ys.items.find((i) => i.taskId === t.id)!;
      expect(item.text).toBe(`${t.title}: ${t.status === "done" ? "Done" : "Rejected"}`);
    }
    const ps = d.sections.find((s) => s.id === CORE_SECTION_IDS.pendingApprovals)!;
    expect(ps.summary).toBe("2 waiting for your approval.");
    for (const t of p.tasks) {
      const item = ps.items.find((i) => i.taskId === t.id)!;
      const row = await dbTask(t.id);
      expect(item.text).toBe(row.title);
      expect(item.note).toContain(formatTimestamp(new Date(row.approval_expires_at), TZ, "en"));
    }
    // Nothing else is stated: a Working task and a task from outside the window appear nowhere.
    expect(JSON.stringify(d.sections)).not.toContain(task.busy.id);
    expect(ys.items).toHaveLength(3);
    expect(ps.items).toHaveLength(2);
  });

  it("the Pending Approval section is generated, stored and rendered even when nothing is pending and nothing happened", async () => {
    const r = await runBriefingRoutines({ now: RUN_AT, onlyTenantIds: [E] });
    expect(r.results[0]).toMatchObject({ outcome: "ran", scheduleDate: DAY });
    const [b] = await withTenant(sys(E), (tx) => listBriefingsTx(tx));
    const ids = b.sections.map((s) => s.id);
    expect(ids).toContain(CORE_SECTION_IDS.pendingApprovals);
    expect(b.sections.find((s) => s.id === CORE_SECTION_IDS.pendingApprovals)!.facts).toMatchObject({ count: 0, tasks: [] });
    const d = await loadBriefingDetailForCaller({ ...sys(E), actor: "owner" }, b.id);
    expect(d.sections.find((s) => s.id === CORE_SECTION_IDS.pendingApprovals)!.summary).toBe("Nothing is waiting for your approval.");
    expect(d.sections.find((s) => s.id === CORE_SECTION_IDS.yesterdayOutcomes)!.items).toEqual([]);
  });
});

describe("export completeness: row-level, against the source tables", () => {
  it("every registered core entity is in the archive, with the same rows (ids) as its source table, threads and messages included", async () => {
    const { archive, summary } = await requestOwnExport(ownerToken);
    const files = new Map(readZip(archive).map((f) => [f.path, Buffer.from(f.data).toString("utf8")]));
    expect(CORE_EXPORT_ENTITIES.map((e) => e.name)).toEqual(expect.arrayContaining(["threads", "messages", "tasks", "briefings", "audit_log", "playbooks", "settings", "business_profile"]));
    for (const e of CORE_EXPORT_ENTITIES) {
      expect(files.has(`${e.name}.json`), e.name).toBe(true);
      expect(files.has(`${e.name}.csv`), e.name).toBe(true);
      const exported = JSON.parse(files.get(`${e.name}.json`)!) as Record<string, unknown>[];
      expect(exported, e.name).toHaveLength(summary.manifest[e.name]);
      const key = e.name === "settings" ? "tenant_id" : "id";
      const source = await withTenant(sys(F.id), (tx) => tx.query<Record<string, unknown>>(`select ${key} from ${e.table}`));
      const exportedKeys = new Set(exported.map((r) => String(r[key])));
      if (e.name === "audit_log") {
        // The export's own audit entry is written after the cutoff, so the archive is a subset of the table.
        for (const k of exportedKeys) expect(source.some((s) => String(s[key]) === k)).toBe(true);
      } else {
        expect(exportedKeys, e.name).toEqual(new Set(source.map((s) => String(s[key]))));
      }
    }
    // Field-level check on the entities the task names explicitly.
    const msgs = JSON.parse(files.get("messages.json")!) as { id: string; body: string; sender: string; thread_id: string }[];
    const srcMsgs = await withTenant(sys(F.id), (tx) => tx.query<{ id: string; body: string; sender: string; thread_id: string }>("select id, body, sender, thread_id from messages"));
    expect(msgs.map((m) => [m.id, m.body, m.sender, m.thread_id]).sort()).toEqual(srcMsgs.map((m) => [m.id, m.body, m.sender, m.thread_id]).sort());
    const tasks = JSON.parse(files.get("tasks.json")!) as { id: string; title: string; status: string }[];
    for (const t of Object.values(task)) {
      const row = await dbTask(t.id);
      expect(tasks.find((x) => x.id === t.id)).toMatchObject({ title: row.title, status: row.status });
    }
  });
});
