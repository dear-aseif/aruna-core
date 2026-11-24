import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { AuthenticationError, signInWithPassword } from "@/server/auth";
import { hashPassword } from "@/server/auth/password";
import { AUDIT_TYPES, listAuditEntries } from "@/server/audit";
import { storeBriefing } from "@/server/briefings";
import { withTenant, type Caller } from "@/server/dal";
import { closeAllPools, withTenantSession } from "@/server/db";
import { listExportEntities, registerExportEntity, requestOwnExport } from "@/server/exports";
import { csvCell, readZip, toCsv } from "@/server/exports/archive";
import { CORE_EXPORT_ENTITIES, unregisterExportEntity } from "@/server/exports/registry";
import { exportQuery } from "@/server/exports/service";
import { activatePlaybook } from "@/server/playbook";
import { ShellForbiddenError } from "@/server/workspace";
import { trackTenant } from "../support/ledger";
try {
  process.loadEnvFile(".env.local");
} catch {
  /* env may already be provided by the shell */
}
// Task 10.3: the export service. Synthetic tenants only; everything runs through the real server modules.
const run = randomBytes(4).toString("hex");
const password = `pw-${randomBytes(12).toString("base64url")}`;
const mk = (n: string) => ({ n, id: randomUUID(), email: `exp-${n}-${run}@unit.example`, token: "", userId: "", hash: "" });
const A = mk("a");
const B = mk("b");
const system = (t: { id: string }): Caller => ({ tenantId: t.id, actor: "system", actorId: `exp-system-${run}` });
const reader = (t: { id: string }): Caller => ({ tenantId: t.id, actor: "owner", actorId: `exp-reader-${run}` });
let operatorToken = "";
const markerB = `B-ONLY-${run}`;
const SECTION_COUNT_TABLES = ["tasks", "threads", "messages", "briefings", "audit_log", "playbooks", "settings"] as const;

async function seedTenant(t: ReturnType<typeof mk>, docs: string[], marker: string) {
  trackTenant(t.id);
  await withTenantSession(t.id, async (c) => void (await c.query("insert into tenants (id, name, type, status) values ($1, $2, 'test', 'active')", [t.id, `Export ${t.n} ${run}`])), "service");
  t.hash = await hashPassword(password);
  await withTenant(system(t), (tx) => tx.insert("profiles", { email: t.email, password_hash: t.hash, role: "owner" }), "service");
  for (const d of docs) expect((await activatePlaybook(system(t), JSON.parse(readFileSync(`playbooks/${d}.json`, "utf8")))).ok).toBe(true);
  const s = (await signInWithPassword(t.email, password))!;
  t.token = s.sessionToken;
  t.userId = s.context.userId;
  await withTenant(system(t), async (tx) => {
    for (const title of [`${marker} one`, `${marker} two`, `${marker} three`]) {
      await tx.insert("tasks", { title, origin: "direct", agent: "booking", created_by: `exp-agent-${run}`, payload: JSON.stringify({ note: `${marker}, "quoted"`, n: 1 }) });
    }
    const th = await tx.insert<{ id: string }>("threads", { kind: "maestro", agent: "maestro" });
    const sp = await tx.insert<{ id: string }>("threads", { kind: "specialist", agent: "booking", title: "Booking" });
    await tx.insert("messages", { thread_id: th.id, sender: "owner", body: `${marker} hello` });
    await tx.insert("messages", { thread_id: sp.id, sender: "agent", body: `${marker} reply, with comma` });
    await storeBriefing(tx, { scheduleDate: "2026-11-20", sections: [{ id: "core", facts: { marker } }] });
    await tx.audit("test.seed", { marker });
  });
}
beforeAll(async () => {
  await seedTenant(A, ["denana", "toko-seragam"], `A-ONLY-${run}`); // two Playbook versions, two packs
  await seedTenant(B, ["denana"], markerB);
  const opEmail = `exp-op-${run}@unit.example`;
  await withTenant(system(A), async (tx) => tx.insert("profiles", { email: opEmail, password_hash: await hashPassword(password), role: "operator" }), "service");
  operatorToken = (await signInWithPassword(opEmail, password))!.sessionToken;
}, 120_000);
afterEach(() => unregisterExportEntity("extra_threads"));
afterAll(async () => {
  await closeAllPools();
});

const countOf = (t: { id: string }, table: string) =>
  withTenant(reader(t), async (tx) => Number((await tx.query<{ n: string }>(`select count(*)::int as n from ${table}`))[0].n));
const open = (zip: Uint8Array) => new Map(readZip(zip).map((f) => [f.path, Buffer.from(f.data).toString("utf8")]));

describe("export contents (design §2.9)", () => {
  it("covers every entity the tenant holds data for, with counts equal to the source tables", async () => {
    const before = Object.fromEntries(await Promise.all(SECTION_COUNT_TABLES.map(async (t) => [t, await countOf(A, t)] as const)));
    const { summary, archive } = await requestOwnExport(A.token);
    const files = open(archive);
    const manifestFile = JSON.parse(files.get("manifest.json")!);
    expect(manifestFile.entities).toEqual(summary.manifest);
    expect(Object.keys(summary.manifest).sort()).toEqual(
      ["audit_log", "briefings", "business_profile", "catalog", "messages", "playbooks", "settings", "tasks", "threads"].sort(),
    );
    expect(summary.manifest).toMatchObject({
      business_profile: 1,
      playbooks: before.playbooks,
      settings: before.settings,
      tasks: before.tasks,
      threads: before.threads,
      messages: before.messages,
      briefings: before.briefings,
      audit_log: before.audit_log,
    });
    expect(before).toMatchObject({ playbooks: 2, tasks: 3, threads: 2, messages: 2, briefings: 1 });
    for (const [name, n] of Object.entries(summary.manifest)) {
      expect(JSON.parse(files.get(`${name}.json`)!)).toBeInstanceOf(name === "catalog" ? Object : Array);
      if (name !== "catalog") {
        expect(JSON.parse(files.get(`${name}.json`)!)).toHaveLength(n);
        expect(files.get(`${name}.csv`)!.trim().split("\r\n").length).toBeGreaterThanOrEqual(1); // header at least
      }
    }
    expect(files.has("catalog.json")).toBe(true);
    // Playbook version history, both packs; the active one is the second version
    const playbooks = JSON.parse(files.get("playbooks.json")!) as { version: number; active: boolean; config: { pack: string } }[];
    expect(playbooks.map((p) => [p.version, p.config.pack, p.active])).toEqual([[1, "services", false], [2, "retail", true]]);
    expect(JSON.parse(files.get("business_profile.json")!)[0]).toMatchObject({ id: A.id, active_pack: "retail" });
    // every file in the manifest exists and its checksum matches
    for (const f of manifestFile.files as { path: string; bytes: number }[]) expect(Buffer.byteLength(files.get(f.path)!)).toBe(f.bytes);
    // CSV: header from the entity's columns; quotes and commas survive
    const tasksCsv = files.get("tasks.csv")!;
    expect(tasksCsv.split("\r\n")[0]).toBe(CORE_EXPORT_ENTITIES.find((e) => e.name === "tasks")!.columns.join(","));
    expect(tasksCsv).toContain('\\""quoted\\""'); // JSON escapes the quote, CSV doubles it
  });

  it("records a database-time cutoff in the archive and the summary", async () => {
    const t0 = Date.now();
    const { summary, archive } = await requestOwnExport(A.token);
    const manifest = JSON.parse(open(archive).get("manifest.json")!);
    expect(manifest.cutoff).toBe(summary.cutoff);
    expect(Math.abs(new Date(summary.cutoff).getTime() - t0)).toBeLessThan(60_000);
    expect(summary.fileName).toMatch(/^aruna-export-\d{8}T\d{6}Z\.zip$/);
  });

  it("includes entities registered by a pack, whichever pack is active", async () => {
    registerExportEntity({ name: "extra_threads", table: "threads", columns: ["id", "tenant_id", "agent"], orderBy: ["id"], owner: "retail" });
    expect(listExportEntities().map((e) => e.name)).toContain("extra_threads");
    const { summary, archive } = await requestOwnExport(A.token);
    expect(summary.manifest.extra_threads).toBe(2);
    expect(open(archive).has("extra_threads.csv")).toBe(true);
  });
});

describe("credentials are never exported", () => {
  it("the archive holds no password hash, session token, token hash or login email", async () => {
    const { archive } = await requestOwnExport(A.token);
    const all = [...open(archive).entries()];
    expect(all.map(([p]) => p).some((p) => /profile|session|password|credential/i.test(p.replace("business_profile", "")))).toBe(false);
    const sessionTokenHash = await withTenantSession(A.id, async (c) => (await c.query<{ h: string }>("select session_token_hash as h from sessions")).rows[0]?.h, "service");
    expect(sessionTokenHash).toMatch(/^[0-9a-f]{64}$/); // a real value exists to look for
    for (const [path, text] of all) {
      for (const secret of [A.hash, password, A.token, sessionTokenHash, A.email, "$argon2", "password_hash", "session_token"]) {
        expect(text.includes(secret), `${path} contains credential material`).toBe(false);
      }
    }
  });

  it("is structural: the query names its columns, never selects *, and the registry refuses credential tables and columns", () => {
    const sql = exportQuery(listExportEntities());
    expect(sql).not.toMatch(/\*/);
    expect(sql).not.toMatch(/\b(profiles|sessions)\b/);
    for (const e of listExportEntities()) expect(e.columns.join(" ")).not.toMatch(/hash|token|secret|password|api_?key/i);
    const base = { name: "x_entity", table: "threads", columns: ["id"], orderBy: ["id"], owner: "retail" };
    expect(() => registerExportEntity({ ...base, table: "profiles" })).toThrow(/credentials/);
    expect(() => registerExportEntity({ ...base, table: "sessions" })).toThrow(/credentials/);
    expect(() => registerExportEntity({ ...base, columns: ["id", "password_hash"] })).toThrow(/credential/);
    expect(() => registerExportEntity({ ...base, columns: ["id", "session_token_hash"] })).toThrow(/credential/);
    expect(() => registerExportEntity({ ...base, columns: ["id; drop table x"] })).toThrow();
    expect(() => registerExportEntity({ ...base, name: "tasks" })).toThrow(/already registered/);
  });
});

describe("tenant scope and authorization", () => {
  it("never contains another tenant's data, and each tenant gets its own", async () => {
    const a = open((await requestOwnExport(A.token)).archive);
    const b = open((await requestOwnExport(B.token)).archive);
    for (const [path, text] of a) {
      expect(text.includes(markerB), path).toBe(false);
      expect(text.includes(B.id), path).toBe(false);
    }
    for (const [path, text] of b) {
      expect(text.includes(`A-ONLY-${run}`), path).toBe(false);
      expect(text.includes(A.id), path).toBe(false);
    }
    expect(JSON.parse(b.get("tasks.json")!)).toHaveLength(3);
    expect(JSON.parse(b.get("playbooks.json")!)).toHaveLength(1);
    expect(JSON.parse(b.get("business_profile.json")!)[0].id).toBe(B.id);
  });

  it("refuses an operator session and a signed-out caller, and writes no export audit entry for them", async () => {
    const countExports = () => withTenant(reader(A), async (tx) => (await listAuditEntries(tx, { type: AUDIT_TYPES.export, limit: 500 })).length);
    const before = await countExports();
    await expect(requestOwnExport(operatorToken)).rejects.toBeInstanceOf(ShellForbiddenError);
    await expect(requestOwnExport(undefined)).rejects.toBeInstanceOf(AuthenticationError);
    expect(await countExports()).toBe(before);
  });
});

describe("the export is audited", () => {
  it("writes one export.created entry (actor = the requesting owner) carrying the cutoff and the manifest counts", async () => {
    const before = await withTenant(reader(B), async (tx) => (await listAuditEntries(tx, { type: AUDIT_TYPES.export, limit: 500 })).length);
    const { summary } = await requestOwnExport(B.token);
    const entries = await withTenant(reader(B), (tx) => listAuditEntries(tx, { type: AUDIT_TYPES.export, limit: 500 }));
    expect(entries).toHaveLength(before + 1);
    const e = entries[0];
    expect(e).toMatchObject({ actor: "owner", actorId: B.userId, taskId: null, type: AUDIT_TYPES.export });
    expect(e.payload).toMatchObject({ cutoff: summary.cutoff, counts: summary.manifest, fileName: summary.fileName });
    expect(e.payload.total).toBe(Object.values(summary.manifest).reduce((x, y) => x + y, 0));
    // A's log did not get B's entry
    const aEntries = await withTenant(reader(A), (tx) => listAuditEntries(tx, { type: AUDIT_TYPES.export, limit: 500 }));
    expect(aEntries.some((x) => x.actorId === B.userId)).toBe(false);
  });
});

describe("archive helpers", () => {
  it("guards spreadsheet formulas and quotes cells", () => {
    expect(csvCell("=1+1")).toBe("'=1+1");
    expect(csvCell("-5")).toBe("-5");
    expect(csvCell("-abc")).toBe("'-abc");
    expect(csvCell('a,"b"')).toBe('"a,""b"""');
    expect(csvCell({ k: 1 })).toBe('"{""k"":1}"');
    expect(csvCell(null)).toBe("");
    expect(toCsv(["a", "b"], [])).toBe("a,b\r\n");
  });
});
