import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { validatePlaybook } from "@/server/playbook";
import { SEED_TENANTS, canonicalJson } from "@/server/seed/loader";

const dir = path.join(process.cwd(), "playbooks");
const load = (f: string) => JSON.parse(readFileSync(path.join(dir, f), "utf8"));

describe("seed Playbook files", () => {
  it.each(SEED_TENANTS.map((t) => [t.key, t] as const))("%s validates against the Playbook schema with the right pack", (_k, t) => {
    const r = validatePlaybook(load(t.playbookFile));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.playbook.pack).toBe(t.pack);
  });

  it("only the two Playbook files exist", () => {
    expect(readdirSync(dir).sort()).toEqual(["denana.json", "toko-seragam.json"]);
  });

  it("Denana is women-only facial treatments; Toko Seragam is a uniform shop with a low-stock threshold", () => {
    const d = validatePlaybook(load("denana.json"));
    const s = validatePlaybook(load("toko-seragam.json"));
    expect(d.ok && s.ok).toBe(true);
    if (d.ok && s.ok) {
      expect(d.playbook.business.type).toMatch(/women-only facial/);
      expect(s.playbook.business.type).toMatch(/uniform/);
      expect(s.playbook.thresholds.lowStock).toBeGreaterThan(0);
    }
  });

  it("contains no credentials or secrets, and is marked synthetic", () => {
    for (const f of readdirSync(dir)) {
      const text = readFileSync(path.join(dir, f), "utf8");
      expect(text).not.toMatch(/password|secret|token|api[_-]?key|argon2|postgres(ql)?:\/\//i);
      expect(text).not.toMatch(/\b\d{8,}\b/); // no phone-number-like digit runs
      expect(text).toMatch(/\(synthetic\)/);
    }
  });
});

describe("seed tenant constants", () => {
  it("has two distinct deterministic UUIDs and distinct owner emails", () => {
    const ids = SEED_TENANTS.map((t) => t.tenantId);
    expect(new Set(ids).size).toBe(2);
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(new Set(SEED_TENANTS.map((t) => t.ownerEmail)).size).toBe(2);
  });

  it("canonicalJson ignores key order (jsonb round-trip comparison)", () => {
    expect(canonicalJson({ a: 1, b: { c: [1, { y: 1, x: 2 }] } })).toBe(canonicalJson({ b: { c: [1, { x: 2, y: 1 }] }, a: 1 }));
    expect(canonicalJson({ a: 1 })).not.toBe(canonicalJson({ a: 2 }));
  });
});
