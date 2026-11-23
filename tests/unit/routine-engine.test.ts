import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { closeAllPools, withTenantSession } from "@/server/db";
import { withTenant, type Caller } from "@/server/dal";
import { activatePlaybook } from "@/server/playbook";
import {
  CORE_SECTION_IDS,
  MAX_FAILED_ATTEMPTS,
  ROUTINE_ACTOR_ID,
  ROUTINE_AUDIT_TYPES,
  registerBriefingSection,
  runBriefingRoutines,
  setBriefingSink,
  unregisterBriefingSection,
  type BriefingRun,
} from "@/server/routines";
import { checkedTransition } from "../support/checked-transition";
import { trackTenant } from "../support/ledger";

try {
  process.loadEnvFile(".env.local");
} catch {
  /* env may already be provided by the shell */
}
const run = randomBytes(4).toString("hex");
const mk = (): Caller => ({ tenantId: randomUUID(), actor: "owner", actorId: randomUUID() });
const A = mk(); // services, Asia/Makassar (UTC+8), 07:30
const B = mk(); // services, Asia/Jakarta (UTC+7), 06:00
const D = mk(); // services, Jakarta 06:00, its pack section fails
const C = mk(); // services, Jakarta 06:00, deactivated
const E = mk(); // retail, Jakarta 06:00
const operator = (c: Caller): Caller => ({ ...c, actor: "operator", actorId: `test-operator-${run}` });
const only = (...cs: Caller[]) => ({ onlyTenantIds: cs.map((c) => c.tenantId) });

async function provision(c: Caller, file: string, name: string, timezone: string, briefingTime: string) {
  trackTenant(c.tenantId);
  await withTenantSession(
    c.tenantId,
    async (cl) => {
      await cl.query("insert into tenants (id, name, type, status) values ($1, $2, 'test', 'active')", [c.tenantId, `Routine ${name} ${run}`]);
    },
    "service",
  );
  const doc = JSON.parse(readFileSync(`playbooks/${file}`, "utf8"));
  doc.business.name = `${name} ${run} (synthetic)`;
  doc.business.timezone = timezone;
  doc.schedule = { briefingTime };
  const r = await activatePlaybook(operator(c), doc);
  expect(r.ok).toBe(true);
}

const FAIL_SECTION = `test.fail.${run}`;
const SERVICES_SECTION = `test.services.${run}`;
beforeAll(async () => {
  await provision(A, "denana.json", "Alpha", "Asia/Makassar", "07:30");
  await provision(B, "denana.json", "Bravo", "Asia/Jakarta", "06:00");
  await provision(D, "denana.json", `FAILING Delta`, "Asia/Jakarta", "06:00");
  await provision(C, "denana.json", "Charlie", "Asia/Jakarta", "06:00");
  await provision(E, "toko-seragam.json", "Echo", "Asia/Jakarta", "06:00");
  registerBriefingSection({
    id: FAIL_SECTION,
    pack: "services",
    async collect(_tx, ctx) {
      if (ctx.playbook.business.name.includes("FAILING")) throw new Error("synthetic section failure");
      return { ok: true };
    },
  });
  registerBriefingSection({ id: SERVICES_SECTION, pack: "services", order: 50, collect: async () => ({ services: true }) });
}, 90_000);
afterEach(() => setBriefingSink(null));
afterAll(async () => {
  unregisterBriefingSection(FAIL_SECTION);
  unregisterBriefingSection(SERVICES_SECTION);
  await closeAllPools();
});

const routineAudit = (c: Caller) =>
  withTenant(c, (tx) =>
    tx.query<{ type: string; actor: string; actor_id: string; payload: Record<string, unknown> }>(
      "select type, actor, actor_id, payload from audit_log where type like 'routine.%' order by created_at, seq",
    ),
  );

describe("routine engine: schedule decision", () => {
  it("runs a tenant exactly at its briefing time in its own timezone, and not before", async () => {
    // 07:30 Makassar = 23:30Z. One second before: nothing for A. Bravo (Jakarta 06:00) is already due.
    const early = await runBriefingRoutines({ now: new Date("2031-03-10T23:29:59Z"), ...only(A, B) });
    expect(early.results.find((r) => r.tenantId === A.tenantId)?.outcome).toBe("not_due");
    expect(early.results.find((r) => r.tenantId === B.tenantId)?.outcome).toBe("ran");
    expect(await routineAudit(A)).toHaveLength(0); // a tenant that is not due gets no record at all

    const exact = await runBriefingRoutines({ now: new Date("2031-03-10T23:30:00Z"), ...only(A, B) });
    expect(exact.results.find((r) => r.tenantId === A.tenantId)).toMatchObject({ outcome: "ran", scheduleDate: "2031-03-11" });
    expect(exact.results.find((r) => r.tenantId === B.tenantId)?.outcome).toBe("already_ran");
  });

  it("leaves an auditable run record by the system actor, and runs once per schedule date", async () => {
    const rows = await routineAudit(A);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ type: ROUTINE_AUDIT_TYPES.run, actor: "system", actor_id: ROUTINE_ACTOR_ID });
    expect(rows[0].payload).toMatchObject({ schedule_date: "2031-03-11", briefing_time: "07:30", timezone: "Asia/Makassar", pack: "services" });

    await runBriefingRoutines({ now: new Date("2031-03-11T03:00:00Z"), ...only(A) }); // later same local day
    expect(await routineAudit(A)).toHaveLength(1);
    const next = await runBriefingRoutines({ now: new Date("2031-03-11T23:30:00Z"), ...only(A) });
    expect(next.results[0]).toMatchObject({ outcome: "ran", scheduleDate: "2031-03-12" });
    expect(await routineAudit(A)).toHaveLength(2);
  });
});

describe("routine engine: failure isolation", () => {
  it("a failing tenant does not stop the others, is recorded, and is retried only a bounded number of times", async () => {
    const now = new Date("2031-04-10T00:00:00Z"); // 07:00 Jakarta: B and D due; A (Makassar 08:00) due too
    const r1 = await runBriefingRoutines({ now, ...only(A, B, D) });
    expect(r1.failed).toBe(1);
    expect(r1.results.find((r) => r.tenantId === D.tenantId)).toMatchObject({ outcome: "failed", error: "synthetic section failure" });
    expect(r1.results.find((r) => r.tenantId === A.tenantId)?.outcome).toBe("ran");
    expect(r1.results.find((r) => r.tenantId === B.tenantId)?.outcome).toBe("ran");

    const d1 = await routineAudit(D);
    expect(d1.map((x) => x.type)).toEqual([ROUTINE_AUDIT_TYPES.failed]);
    expect(d1[0].payload).toMatchObject({ schedule_date: "2031-04-10", error: "synthetic section failure" });

    for (let i = 1; i < MAX_FAILED_ATTEMPTS; i++) await runBriefingRoutines({ now, ...only(D) });
    const last = await runBriefingRoutines({ now, ...only(D) });
    expect(last.results[0].outcome).toBe("gave_up");
    expect((await routineAudit(D)).filter((x) => x.type === ROUTINE_AUDIT_TYPES.failed)).toHaveLength(MAX_FAILED_ATTEMPTS);
  });

  it("a failed run leaves no run record and rolls back its work", async () => {
    expect((await routineAudit(D)).some((x) => x.type === ROUTINE_AUDIT_TYPES.run)).toBe(false);
  });
});

describe("routine engine: deactivated tenants", () => {
  it("writes nothing for a deactivated tenant", async () => {
    await withTenantSession(C.tenantId, (cl) => cl.query("update tenants set status = 'deactivated' where id = $1", [C.tenantId]), "service");
    const r = await runBriefingRoutines({ now: new Date("2031-05-10T03:00:00Z"), ...only(C) });
    expect(r.tenants).toBe(0);
    expect(r.results).toEqual([]);
    expect(await routineAudit(C)).toHaveLength(0);
  });
});

describe("routine engine: shared routine and section registry", () => {
  it("core sections run for both packs; a pack's section runs only for that pack; the sink sees the facts", async () => {
    const seen = new Map<string, BriefingRun>();
    setBriefingSink(async (tx, runInfo) => {
      seen.set(tx.tenantId, runInfo);
    });
    const r = await runBriefingRoutines({ now: new Date("2031-06-10T00:00:00Z"), ...only(B, E) });
    expect(r.failed).toBe(0);
    const ids = (c: Caller) => seen.get(c.tenantId)!.sections.map((s) => s.id);
    expect(ids(B)).toEqual([CORE_SECTION_IDS.yesterdayOutcomes, CORE_SECTION_IDS.pendingApprovals, SERVICES_SECTION, FAIL_SECTION]);
    expect(ids(E)).toEqual([CORE_SECTION_IDS.yesterdayOutcomes, CORE_SECTION_IDS.pendingApprovals]);
    expect((await routineAudit(E))[0].payload.sections).toEqual(ids(E));
  });

  it("applies approval expiry before the pending-approvals list is read", async () => {
    const agent: Caller = { ...B, actor: "agent", actorId: `routine-agent-${run}` };
    const mkPending = async (title: string) => {
      const t = await withTenant(B, (tx) => tx.insert<{ id: string }>("tasks", { title, origin: "direct", agent: "booking", created_by: B.actorId }));
      for (const s of ["working", "in_review", "pending_approval"] as const) await withTenant(agent, (tx) => checkedTransition(tx, t.id, s));
      return t.id;
    };
    const lapsed = await mkPending("lapsed");
    const open = await mkPending("open");
    await withTenant(B, (tx) => tx.query("update tasks set approval_expires_at = clock_timestamp() - interval '1 minute' where id = $1", [lapsed]));

    let pending: { tasks: { id: string }[] } | undefined;
    setBriefingSink(async (_tx, runInfo) => {
      pending = runInfo.sections.find((s) => s.id === CORE_SECTION_IDS.pendingApprovals)!.facts as typeof pending;
    });
    const r = await runBriefingRoutines({ now: new Date("2031-07-10T00:00:00Z"), ...only(B) });
    expect(r.results[0].outcome).toBe("ran");
    expect(pending!.tasks.map((t) => t.id)).toEqual([open]);
    const status = await withTenant(B, (tx) => tx.getById<{ status: string }>("tasks", lapsed));
    expect(status.status).toBe("expired");
  });

  it("refuses a duplicate section id", () => {
    expect(() => registerBriefingSection({ id: SERVICES_SECTION, pack: "services", collect: async () => null })).toThrow(/already registered/);
  });
});
