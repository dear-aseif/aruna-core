import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeAllPools, withTenantSession } from "@/server/db";
import { withTenant, type Caller } from "@/server/dal";
import { NotFoundError } from "@/server/dal/errors";
import { activatePlaybook } from "@/server/playbook";
import {
  getBriefingTx,
  installBriefingArchive,
  listBriefingsTx,
  loadBriefingDetailForCaller,
  loadBriefingsForCaller,
  renderSections,
  storeBriefing,
} from "@/server/briefings";
import { CORE_SECTION_IDS, runBriefingRoutines, setBriefingSink } from "@/server/routines";
import { expireTaskIfOverdue } from "@/server/tasks";
import { checkedTransition } from "../support/checked-transition";
import { trackTenant } from "../support/ledger";

try {
  process.loadEnvFile(".env.local");
} catch {
  /* env may already be provided by the shell */
}
// Task 10.2: briefing generation from records, archive, idempotency, reopening. Synthetic tenants only.
const run = randomBytes(4).toString("hex");
const mk = (): Caller => ({ tenantId: randomUUID(), actor: "owner", actorId: randomUUID() });
const B = mk(); // services, Asia/Jakarta (UTC+7), 06:00
const C = mk(); // a second tenant, for isolation
const operator = (c: Caller): Caller => ({ ...c, actor: "operator", actorId: `test-operator-${run}` });
const agent: Caller = { ...B, actor: "agent", actorId: `briefing-agent-${run}` };

async function provision(c: Caller, name: string) {
  trackTenant(c.tenantId);
  await withTenantSession(
    c.tenantId,
    async (cl) => {
      await cl.query("insert into tenants (id, name, type, status) values ($1, $2, 'test', 'active')", [c.tenantId, `Briefing ${name} ${run}`]);
    },
    "service",
  );
  const doc = JSON.parse(readFileSync("playbooks/denana.json", "utf8"));
  doc.business.name = `${name} ${run} (synthetic)`;
  doc.business.timezone = "Asia/Jakarta";
  doc.schedule = { briefingTime: "06:00" };
  expect((await activatePlaybook(operator(c), doc)).ok).toBe(true);
}

const DAY = "2031-08-10"; // schedule date; "yesterday" is 2031-08-09 in Jakarta = [08-08T17:00Z, 08-09T17:00Z)
const RUN_AT = new Date("2031-08-09T23:00:00Z"); // 06:00 on 08-10 in Jakarta
const ids: Record<string, string> = {};
const title = (k: string) => `${k} ${run}`;

async function makeTask(k: string, path: ("working" | "in_review" | "pending_approval" | "done" | "rejected")[]) {
  const t = await withTenant(B, (tx) => tx.insert<{ id: string }>("tasks", { title: title(k), origin: "direct", agent: "booking", created_by: B.actorId }));
  for (const s of path) await withTenant(agent, (tx) => checkedTransition(tx, t.id, s));
  ids[k] = t.id;
  return t.id;
}
const setUpdated = (id: string, iso: string) => withTenant(B, (tx) => tx.query("update tasks set updated_at = $2 where id = $1", [id, iso]));

beforeAll(async () => {
  await provision(B, "Bravo");
  await provision(C, "Charlie");
  // Yesterday's outcomes (08-09 Jakarta): one done, one rejected, one expired.
  await makeTask("done-y", ["working", "in_review", "done"]);
  await makeTask("rejected-y", ["working", "in_review", "pending_approval", "rejected"]);
  const exp = await makeTask("expired-y", ["working", "in_review", "pending_approval"]);
  await withTenant(B, (tx) => tx.query("update tasks set approval_expires_at = clock_timestamp() - interval '1 minute' where id = $1", [exp]));
  expect((await withTenant(B, (tx) => expireTaskIfOverdue(tx, exp)))?.status).toBe("expired");
  await setUpdated(ids["done-y"], "2031-08-09T03:00:00Z");
  await setUpdated(ids["rejected-y"], "2031-08-09T05:00:00Z");
  await setUpdated(ids["expired-y"], "2031-08-09T16:59:00Z"); // inside by one minute
  // Outside the window: the instant yesterday ended, and two days ago.
  await makeTask("done-today", ["working", "in_review", "done"]);
  await setUpdated(ids["done-today"], "2031-08-09T17:00:00Z");
  await makeTask("done-old", ["working", "in_review", "done"]);
  await setUpdated(ids["done-old"], "2031-08-08T10:00:00Z");
  // Pending approvals: one open, one whose deadline has passed (the routine must expire it first).
  await makeTask("open", ["working", "in_review", "pending_approval"]);
  const lapsed = await makeTask("lapsed", ["working", "in_review", "pending_approval"]);
  await withTenant(B, (tx) => tx.query("update tasks set approval_expires_at = clock_timestamp() - interval '1 minute' where id = $1", [lapsed]));
  installBriefingArchive();
}, 120_000);
afterAll(async () => {
  setBriefingSink(null);
  await closeAllPools();
});

const onlyB = { onlyTenantIds: [B.tenantId] };
const stored = () => withTenant(B, (tx) => listBriefingsTx(tx));
type Outcomes = { date: string; done: number; rejected: number; expired: number; tasks: { id: string; title: string; status: string }[] };
type Pending = { count: number; tasks: { id: string; title: string }[] };
const factsOf = (b: { sections: { id: string; facts: unknown }[] }, id: string) => b.sections.find((s) => s.id === id)!.facts;

describe("briefing generation from records", () => {
  it("stores exactly the source facts: yesterday's outcomes in the tenant's timezone, and the pending list", async () => {
    const r = await runBriefingRoutines({ now: RUN_AT, ...onlyB });
    expect(r.results[0]).toMatchObject({ outcome: "ran", scheduleDate: DAY });
    const all = await stored();
    expect(all).toHaveLength(1);
    expect(all[0].date).toBe(DAY);
    expect(all[0].sections.map((s) => s.id)).toEqual([CORE_SECTION_IDS.yesterdayOutcomes, CORE_SECTION_IDS.pendingApprovals]);

    const y = factsOf(all[0], CORE_SECTION_IDS.yesterdayOutcomes) as Outcomes;
    expect(y.date).toBe("2031-08-09");
    expect([y.done, y.rejected, y.expired]).toEqual([1, 1, 1]);
    expect(y.tasks.map((t) => [t.id, t.title, t.status])).toEqual([
      [ids["done-y"], title("done-y"), "done"],
      [ids["rejected-y"], title("rejected-y"), "rejected"],
      [ids["expired-y"], title("expired-y"), "expired"],
    ]);

    const p = factsOf(all[0], CORE_SECTION_IDS.pendingApprovals) as Pending;
    expect(p.count).toBe(1);
    expect(p.tasks.map((t) => [t.id, t.title])).toEqual([[ids.open, title("open")]]);
  });

  it("applies approval expiry before the pending snapshot: the overdue approval is not listed and is Expired", async () => {
    const [b] = await stored();
    const p = factsOf(b, CORE_SECTION_IDS.pendingApprovals) as Pending;
    expect(p.tasks.map((t) => t.id)).not.toContain(ids.lapsed);
    expect((await withTenant(B, (tx) => tx.getById<{ status: string }>("tasks", ids.lapsed))).status).toBe("expired");
    // And it is not in the rendered text either.
    const d = await loadBriefingDetailForCaller(B, b.id);
    expect(JSON.stringify(d.sections)).not.toContain(title("lapsed"));
  });

  it("stores the generation in the same transaction as an audit entry, and never the assistant name", async () => {
    const [b] = await stored();
    const audit = await withTenant(B, (tx) => tx.query<{ actor: string; payload: Record<string, unknown> }>("select actor, payload from audit_log where type = 'briefing.stored'"));
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actor: "system", payload: { briefing_id: b.id, schedule_date: DAY } });
    const name = await withTenant(B, (tx) => tx.getById<{ assistant_name: string }>("settings", B.tenantId, "tenant_id"));
    expect(JSON.stringify(b.sections)).not.toContain(name.assistant_name);
  });
});

describe("idempotency and immutability", () => {
  it("a second routine run for the same date creates no duplicate", async () => {
    const r = await runBriefingRoutines({ now: new Date("2031-08-10T04:00:00Z"), ...onlyB });
    expect(r.results[0].outcome).toBe("already_ran");
    expect(await stored()).toHaveLength(1);
  });

  it("storing the same date again returns the archived briefing unchanged, even with different facts", async () => {
    const [before] = await stored();
    const again = await withTenant(B, (tx) => storeBriefing(tx, { scheduleDate: DAY, sections: [{ id: "x", facts: { changed: true } }] }));
    expect(again.created).toBe(false);
    expect(again.briefing).toEqual(before);
    const after = await stored();
    expect(after).toHaveLength(1);
    expect(after[0]).toEqual(before);
  });

  it("the runtime roles cannot update or delete an archived briefing", async () => {
    await expect(withTenant(B, (tx) => tx.query("update briefings set sections = '[]'::jsonb"))).rejects.toThrow(/permission denied/);
    await expect(withTenant(B, (tx) => tx.query("delete from briefings"))).rejects.toThrow(/permission denied/);
    expect(await stored()).toHaveLength(1);
  });
});

describe("archive and reopening", () => {
  it("reopening returns the stored content unchanged, however much the records change afterwards", async () => {
    const [before] = await stored();
    // Records move on: the open approval is rejected, a new task appears.
    await withTenant(agent, (tx) => checkedTransition(tx, ids.open, "rejected"));
    await makeTask("later", ["working"]);
    const reopened = await withTenant(B, (tx) => getBriefingTx(tx, before.id));
    expect(reopened).toEqual(before);
    const d = await loadBriefingDetailForCaller(B, before.id);
    const pending = d.sections.find((s) => s.id === CORE_SECTION_IDS.pendingApprovals)!;
    expect(pending.items.map((i) => i.taskId)).toEqual([ids.open]); // still shown as it was at generation time
    expect(d.sections.find((s) => s.id === CORE_SECTION_IDS.yesterdayOutcomes)!.items.map((i) => i.taskId)).toEqual([ids["done-y"], ids["rejected-y"], ids["expired-y"]]);
  });

  it("renders from the facts with fixed templates and resolves the assistant name live", async () => {
    const [b] = await stored();
    const d1 = await loadBriefingDetailForCaller(B, b.id);
    expect(d1.greeting).toContain("Aruna");
    const pending = d1.sections.find((s) => s.id === CORE_SECTION_IDS.pendingApprovals)!;
    expect(pending.summary).toBe("1 waiting for your approval.");
    expect(pending.items[0].note).toMatch(/^Decide before /);
    expect(d1.sections[0].summary).toBe("1 done, 1 rejected, 1 expired.");

    await withTenant(B, (tx) => tx.updateById("settings", B.tenantId, { assistant_name: "Sari", ui_language: "id" }, "tenant_id"));
    const d2 = await loadBriefingDetailForCaller(B, b.id);
    expect(d2.greeting).toBe("Selamat pagi. Sari menyiapkan ringkasan ini dari catatan Anda.");
    expect(d2.sections[0].summary).toBe("1 selesai, 1 ditolak, 1 kedaluwarsa.");
    expect(d2.sections[0].items[0].text).toBe(`${title("done-y")}: Selesai`);
    expect((await stored())[0]).toEqual(b); // the archive row never changed
  });

  it("states an empty pending list explicitly and an empty day plainly (pure render, both languages)", () => {
    const sections = [
      { id: CORE_SECTION_IDS.yesterdayOutcomes, facts: { date: "2031-01-01", done: 0, rejected: 0, expired: 0, tasks: [] } },
      { id: CORE_SECTION_IDS.pendingApprovals, facts: { count: 0, tasks: [] } },
    ];
    const en = renderSections(sections, { lang: "en", timeZone: "Asia/Jakarta" });
    expect(en.map((s) => s.summary)).toEqual(["No tasks were completed, rejected or expired yesterday.", "Nothing is waiting for your approval."]);
    const id = renderSections(sections, { lang: "id", timeZone: "Asia/Jakarta" });
    expect(id[1].summary).toBe("Tidak ada yang menunggu persetujuan Anda.");
    for (const s of [...en, ...id]) expect(`${s.heading} ${s.summary}`).not.toMatch(/[{}]/); // no unfilled placeholder
  });

  it("lists today and the archive by the tenant's local date, newest first", async () => {
    // The next day's run adds a second briefing.
    const r = await runBriefingRoutines({ now: new Date("2031-08-10T23:00:00Z"), ...onlyB });
    expect(r.results[0]).toMatchObject({ outcome: "ran", scheduleDate: "2031-08-11" });
    const m = await loadBriefingsForCaller(B, new Date("2031-08-10T23:30:00Z")); // 06:30 on 08-11 in Jakarta
    expect(m.today?.date).toBe("2031-08-11");
    expect(m.archive.map((x) => x.date)).toEqual([DAY]);
    expect(m.today?.dateLabel).toMatch(/2031/);
    const earlier = await loadBriefingsForCaller(B, new Date("2031-08-12T00:00:00Z")); // 08-12 local: neither is today
    expect(earlier.today).toBeNull();
    expect(earlier.archive.map((x) => x.date)).toEqual(["2031-08-11", DAY]);
  });

  it("an empty tenant shows no briefings; another tenant's briefing is not found", async () => {
    const empty = await loadBriefingsForCaller(C);
    expect(empty).toEqual({ today: null, archive: [] });
    const [b] = await stored();
    await expect(loadBriefingDetailForCaller(C, b.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(loadBriefingDetailForCaller(B, "not-a-uuid")).rejects.toBeInstanceOf(NotFoundError);
    await expect(loadBriefingDetailForCaller(B, randomUUID())).rejects.toBeInstanceOf(NotFoundError);
  });
});
