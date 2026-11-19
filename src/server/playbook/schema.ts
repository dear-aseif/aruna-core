import { z, type ZodType } from "zod";
import { getPack, listPackIds } from "../packs"; // importing the index registers the built-in packs

/**
 * Playbook schemas (design §2.2): one CORE schema plus the active pack's fragment.
 * The core names no pack-specific field; the fragment supplies catalog, extra thresholds
 * and templates. Objects are strict, so a field belonging to another pack is refused.
 */

const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const hhmm = z.string().regex(HHMM, "expected HH:MM (24h)");
const nonEmpty = z.string().trim().min(1);

const hoursEntry = z
  .strictObject({ day: z.enum(DAYS), open: hhmm, close: hhmm })
  .refine((h) => h.open < h.close, { message: "close must be after open", path: ["close"] });

const hours = z
  .array(hoursEntry)
  .min(1)
  .superRefine((list, ctx) => {
    const seen = new Set<string>();
    list.forEach((h, i) => {
      if (seen.has(h.day)) ctx.addIssue({ code: "custom", path: [i, "day"], message: "duplicate day" });
      seen.add(h.day);
    });
  });

const coreThresholdShape = {
  /** Largest amount (whole currency units) that may be approved; optional until the Checker uses it. */
  approvalAmountLimit: z.number().int().nonnegative().optional(),
  /** Minutes before a pending approval expires (task 4.3 defaults to 15 when absent). */
  approvalExpiryMinutes: z.number().int().positive().optional(),
};

const coreShape = {
  business: z.strictObject({ name: nonEmpty, type: nonEmpty, timezone: nonEmpty }),
  /** Initial value only; after activation the name lives in `settings`. */
  assistantName: nonEmpty,
  pack: nonEmpty,
  hours,
  /** Optional briefing schedule; the routine engine (10.1) applies its own default when absent. */
  schedule: z.strictObject({ briefingTime: hhmm }).optional(),
};

/** Pack-agnostic pass, used only when the pack itself is missing or unknown. */
const coreSchema = z.strictObject({
  ...coreShape,
  catalog: z.record(z.string(), z.unknown()),
  thresholds: z.looseObject(coreThresholdShape),
  templates: z.record(z.string(), z.string()),
});

/** The complete schema for one registered pack: core plus its fragment. */
export function playbookSchemaFor(packId: string): ZodType | null {
  const pack = getPack(packId);
  if (!pack) return null;
  const f = pack.fragment;
  return z.strictObject({
    ...coreShape,
    pack: z.literal(pack.id),
    catalog: f.catalog,
    thresholds: z.strictObject({ ...coreThresholdShape, ...f.thresholds }),
    templates: z.strictObject(f.templates),
  });
}

export interface PlaybookCore {
  business: { name: string; type: string; timezone: string };
  assistantName: string;
  pack: string;
  hours: { day: (typeof DAYS)[number]; open: string; close: string }[];
  schedule?: { briefingTime: string };
  /** Shape given by the active pack's fragment (see packs/*\/fragment.ts). */
  catalog: unknown;
  thresholds: { approvalAmountLimit?: number; approvalExpiryMinutes?: number; [pack: string]: number | undefined };
  templates: Record<string, string>;
}

export interface FieldProblem {
  path: string;
  reason: string;
}

export interface PlaybookProblems {
  /** Required fields that are absent, by path (e.g. `templates.supplierFollowUp`). Sorted. */
  missing: string[];
  /** Fields that are present but invalid, or not allowed for this pack. Sorted by path. */
  invalid: FieldProblem[];
}

export type ValidationResult = { ok: true; playbook: PlaybookCore } | ({ ok: false } & PlaybookProblems);

function fmtPath(path: readonly PropertyKey[]): string {
  return path.reduce<string>((s, p) => (typeof p === "number" ? `${s}[${p}]` : s ? `${s}.${String(p)}` : String(p)), "");
}

function valueAt(root: unknown, path: readonly PropertyKey[]): unknown {
  let cur: unknown = root;
  for (const p of path) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<PropertyKey, unknown>)[p];
  }
  return cur;
}

/**
 * Validate a Playbook document. Never throws; returns the exact list of missing fields and
 * the invalid ones (R2.3). Unknown keys (including the other pack's fragment) are `invalid`.
 */
export function validatePlaybook(doc: unknown): ValidationResult {
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) {
    return { ok: false, missing: [], invalid: [{ path: "", reason: "Playbook must be a JSON object" }] };
  }
  const packId = (doc as { pack?: unknown }).pack;
  const schema = (typeof packId === "string" ? playbookSchemaFor(packId) : null) ?? coreSchema;
  const parsed = schema.safeParse(doc);
  const missing = new Set<string>();
  const invalid: FieldProblem[] = [];

  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      if (issue.code === "unrecognized_keys") {
        for (const k of issue.keys) invalid.push({ path: fmtPath([...issue.path, k]), reason: "field not allowed for this Playbook" });
      } else if (valueAt(doc, issue.path) === undefined && issue.path.length > 0) {
        missing.add(fmtPath(issue.path));
      } else {
        invalid.push({ path: fmtPath(issue.path), reason: issue.message });
      }
    }
  }
  // A pack that is present but unknown/unregistered is invalid even when the core pass is clean.
  if (typeof packId === "string" && !getPack(packId)) {
    invalid.push({ path: "pack", reason: `unknown pack "${packId}"; registered: ${listPackIds().join(", ")}` });
  }
  if (parsed.success && invalid.length === 0) return { ok: true, playbook: parsed.data as PlaybookCore };
  invalid.sort((a, b) => a.path.localeCompare(b.path));
  return { ok: false, missing: [...missing].sort(), invalid };
}
