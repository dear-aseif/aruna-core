import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { closeAllPools, withTenantSession } from "@/server/db";
import { withTenant, type Caller } from "@/server/dal";
import {
  PLAYBOOK_ACTIVATED,
  PLAYBOOK_REFUSED,
  activatePlaybook,
  getActivePack,
  getBusinessProfile,
  getCatalog,
  getHours,
  getTemplates,
  getThresholds,
  validatePlaybook,
} from "@/server/playbook";
import { trackTenant } from "../support/ledger";

try {
  process.loadEnvFile(".env.local");
} catch {
  /* env may already be provided by the shell */
}

/**
 * Playbook validation and activation (Property 8; R2.1, R2.2, R2.3, R2.4). The documents are the
 * two seeded Playbook files, deep-copied per case; all database work happens on throwaway synthetic
 * tenants that are removed in afterAll (the seeded tenants are never activated or changed here).
 */
type Doc = Record<string, any>;
type Path = (string | number)[];
const load = (f: string): Doc => JSON.parse(readFileSync(path.join(process.cwd(), "playbooks", f), "utf8"));
const retail = () => load("toko-seragam.json");
const services = () => load("denana.json");

const fmt = (p: Path) => p.reduce<string>((s, k) => (typeof k === "number" ? `${s}[${k}]` : s ? `${s}.${k}` : k), "");

function omit(doc: Doc, p: Path): Doc {
  const d = structuredClone(doc);
  let cur: any = d;
  for (const k of p.slice(0, -1)) cur = cur[k];
  delete cur[p[p.length - 1]];
  return d;
}

const COMMON: Path[] = [
  ["business"], ["business", "name"], ["business", "type"], ["business", "timezone"],
  ["assistantName"],
  ["hours"], ["hours", 0, "day"], ["hours", 0, "open"], ["hours", 0, "close"],
  ["catalog"], ["thresholds"], ["templates"],
];
const RETAIL_ONLY: Path[] = [
  ["catalog", "products"], ["catalog", "products", 0, "name"], ["catalog", "products", 0, "variants"],
  ["catalog", "products", 0, "variants", 0, "sku"], ["catalog", "products", 0, "variants", 0, "size"], ["catalog", "products", 0, "variants", 0, "price"],
  ["thresholds", "lowStock"], ["templates", "supplierFollowUp"],
];
const SERVICES_ONLY: Path[] = [
  ["catalog", "treatments"], ["catalog", "treatments", 0, "name"], ["catalog", "treatments", 0, "durationMinutes"], ["catalog", "treatments", 0, "price"],
  ["templates", "bookingConfirmation"],
];
const CASES = [
  { pack: "retail", doc: retail, required: [...COMMON, ...RETAIL_ONLY] },
  { pack: "services", doc: services, required: [...COMMON, ...SERVICES_ONLY] },
] as const;

describe("the seeded Playbook files are complete", () => {
  it.each(CASES)("$pack file validates", ({ doc }) => {
    expect(validatePlaybook(doc()).ok).toBe(true);
  });
});

describe("each required-field omission is named exactly (R2.3)", () => {
  for (const c of CASES) {
    it.each(c.required.map((p) => [fmt(p), p] as const))(`${c.pack}: omitting %s reports exactly that field`, (name, p) => {
      const r = validatePlaybook(omit(c.doc(), p as Path));
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.missing).toEqual([name]);
      expect(r.invalid).toEqual([]);
    });
  }

  it("omitting `pack` is reported as missing", () => {
    const r = validatePlaybook(omit(retail(), ["pack"]));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.missing).toContain("pack");
  });

  it("optional fields may be omitted (schedule, approval limits)", () => {
    expect(validatePlaybook(omit(retail(), ["schedule"])).ok).toBe(true);
    expect(validatePlaybook(omit(services(), ["thresholds", "approvalExpiryMinutes"])).ok).toBe(true);
  });

  // Property-style: random subsets of required fields, fixed-seed generator so a failure reproduces.
  it("for any subset of omitted required fields, `missing` is exactly the omitted set", () => {
    let s = 0x9e3779b9;
    const rnd = () => {
      s = (s + 0x6d2b79f5) | 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    for (let i = 0; i < 300; i++) {
      const c = CASES[i % 2];
      const chosen = c.required.filter(() => rnd() < 0.2);
      if (chosen.length === 0) continue;
      let d = c.doc();
      // Delete deeper paths first so every deletion is still addressable; paths under an omitted ancestor are not reported.
      for (const p of [...chosen].sort((a, b) => b.length - a.length)) {
        try {
          d = omit(d, p as Path);
        } catch {
          /* parent already removed */
        }
      }
      const names = chosen.map(fmt);
      const expected = names.filter((n) => !names.some((o) => o !== n && (n.startsWith(`${o}.`) || n.startsWith(`${o}[`)))).sort();
      const r = validatePlaybook(d);
      expect(r.ok, `case ${i} ${c.pack} omitting ${names.join(", ")}`).toBe(false);
      if (!r.ok) {
        expect(r.missing, `case ${i} ${c.pack} omitting ${names.join(", ")}`).toEqual(expected);
        expect(r.invalid).toEqual([]);
      }
    }
  });
});

describe("pack-fragment mismatch is refused in both directions (R2.2)", () => {
  it("a Retail Playbook carrying the Services fragment is refused", () => {
    const d = retail();
    d.catalog = services().catalog;
    d.templates = services().templates;
    const r = validatePlaybook(d);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.missing).toEqual(["catalog.products", "templates.supplierFollowUp"]);
    expect(r.invalid.map((i) => i.path)).toEqual(["catalog.treatments", "templates.bookingConfirmation"]);
  });

  it("a Services Playbook carrying the Retail fragment is refused", () => {
    const d = services();
    d.catalog = retail().catalog;
    d.thresholds = { lowStock: 5 };
    d.templates = retail().templates;
    const r = validatePlaybook(d);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.missing).toEqual(["catalog.treatments", "templates.bookingConfirmation"]);
    expect(r.invalid.map((i) => i.path)).toEqual(["catalog.products", "templates.supplierFollowUp", "thresholds.lowStock"]);
  });

  it("a complete document that merely declares the other pack is refused", () => {
    expect(validatePlaybook({ ...retail(), pack: "services" }).ok).toBe(false);
    expect(validatePlaybook({ ...services(), pack: "retail" }).ok).toBe(false);
  });
});

describe("activation and runtime reads (database, runtime role on synthetic tenants)", () => {
  const run = randomBytes(4).toString("hex");
  const mk = (): Caller => ({ tenantId: randomUUID(), actor: "system", actorId: `test-playbook-${run}` });
  async function provision(c: Caller, label: string) {
    trackTenant(c.tenantId);
    await withTenantSession(
      c.tenantId,
      (cl) => cl.query("insert into tenants (id, name, type, status) values ($1, $2, 'pending', 'inactive')", [c.tenantId, `PV ${label} ${run}`]),
      "service",
    );
  }
  afterAll(async () => {
    await closeAllPools();
  });

  const snapshot = (c: Caller) =>
    withTenant(c, async (tx) => ({
      playbooks: await tx.query("select version, active, config from playbooks order by version"),
      settings: await tx.query("select assistant_name from settings"),
      tenant: await tx.query("select name, type, active_pack, timezone, status, updated_at from tenants"),
      audit: await tx.query<{ type: string }>("select type from audit_log where type <> $1 order by created_at, id", [PLAYBOOK_REFUSED]),
    }));

  const refusals = (c: Caller) =>
    withTenant(c, (tx) => tx.query<{ payload: { missing: string[]; invalid: unknown[] } }>("select payload from audit_log where type = $1 order by created_at, id", [PLAYBOOK_REFUSED]));

  it("activating a complete seeded Playbook succeeds for each pack", async () => {
    for (const [file, pack] of [["toko-seragam.json", "retail"], ["denana.json", "services"]] as const) {
      const c = mk();
      await provision(c, `ok-${pack}`);
      expect(await activatePlaybook(c, load(file))).toMatchObject({ ok: true, version: 1, pack });
    }
  });

  it("an omission is refused with the exact list; the refusal is audited and nothing else changes", async () => {
    const c = mk();
    await provision(c, "omit");
    const bad = omit(omit(retail(), ["thresholds", "lowStock"]), ["hours"]);
    const before = await snapshot(c);
    expect(await activatePlaybook(c, bad)).toEqual({ ok: false, missing: ["hours", "thresholds.lowStock"], invalid: [] });
    expect(await snapshot(c)).toEqual(before);
    const r = await refusals(c);
    expect(r).toHaveLength(1);
    expect(r[0].payload.missing).toEqual(["hours", "thresholds.lowStock"]);
    // Nothing was created for the tenant.
    expect(before.playbooks).toEqual([]);
    expect(before.settings).toEqual([]);
    expect(before.tenant[0]).toMatchObject({ status: "inactive", active_pack: null });
  });

  it("a mismatched Playbook is refused in both directions and changes nothing", async () => {
    const c = mk();
    await provision(c, "mismatch");
    const retailWithServices = { ...retail(), catalog: services().catalog, templates: services().templates };
    const servicesWithRetail = { ...services(), catalog: retail().catalog, templates: retail().templates };
    for (const doc of [retailWithServices, servicesWithRetail]) {
      const before = await snapshot(c);
      const r = await activatePlaybook(c, doc);
      expect(r.ok).toBe(false);
      expect(await snapshot(c)).toEqual(before);
    }
    expect(await refusals(c)).toHaveLength(2);
  });

  it("switching the active Playbook switches every runtime read, with no code change", async () => {
    const c = mk();
    await provision(c, "switch");
    const toko = retail();
    const denana = services();

    expect(await activatePlaybook(c, toko)).toMatchObject({ ok: true, version: 1, pack: "retail" });
    await withTenant(c, async (tx) => {
      expect(await getActivePack(tx)).toBe("retail");
      expect(await getBusinessProfile(tx)).toEqual(toko.business);
      expect(await getCatalog(tx)).toEqual(toko.catalog);
      expect(await getHours(tx)).toEqual(toko.hours);
      expect(await getThresholds(tx)).toEqual(toko.thresholds);
      expect(await getTemplates(tx)).toEqual(toko.templates);
    });

    expect(await activatePlaybook(c, denana)).toMatchObject({ ok: true, version: 2, pack: "services" });
    await withTenant(c, async (tx) => {
      expect(await getActivePack(tx)).toBe("services");
      expect(await getBusinessProfile(tx)).toEqual(denana.business);
      expect(await getCatalog(tx)).toEqual(denana.catalog);
      expect(await getHours(tx)).toEqual(denana.hours);
      expect(await getThresholds(tx)).toEqual(denana.thresholds);
      expect(await getTemplates(tx)).toEqual(denana.templates);
      expect(await tx.query("select version from playbooks where active")).toEqual([{ version: 2 }]);
      const t = await tx.getById<{ name: string; type: string; active_pack: string }>("tenants", c.tenantId);
      expect(t).toMatchObject({ name: denana.business.name, type: denana.business.type, active_pack: "services" });
      const types = (await tx.query<{ type: string }>("select type from audit_log where type = $1", [PLAYBOOK_ACTIVATED])).length;
      expect(types).toBe(2);
    });

    // Switching back restores the first Playbook's reads (a new version, same content).
    expect(await activatePlaybook(c, toko)).toMatchObject({ ok: true, version: 3, pack: "retail" });
    expect(await withTenant(c, (tx) => getCatalog(tx))).toEqual(toko.catalog);
  });

  it("a refused re-activation leaves the previous active Playbook and its reads in force", async () => {
    const c = mk();
    await provision(c, "keep");
    await activatePlaybook(c, retail());
    const before = await snapshot(c);
    const bad = omit(services(), ["templates", "bookingConfirmation"]);
    expect(await activatePlaybook(c, bad)).toEqual({ ok: false, missing: ["templates.bookingConfirmation"], invalid: [] });
    expect(await snapshot(c)).toEqual(before);
    await withTenant(c, async (tx) => {
      expect(await getActivePack(tx)).toBe("retail");
      expect(await getCatalog(tx)).toEqual(retail().catalog);
      expect((await tx.getById<{ name: string }>("tenants", c.tenantId)).name).toBe(retail().business.name);
    });
  });
});
