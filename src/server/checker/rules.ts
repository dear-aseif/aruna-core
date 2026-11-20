/**
 * Deterministic Checker rules (task 6.1, design §2.4 step 1).
 *
 * A rule is a pure function over the draft's structured `fields` and the verified source
 * `sources` records. It has no I/O, no clock and no randomness: the same input always gives the
 * same anomalies. A rule returns an empty list when it passes. Prose is never inspected
 * (amendment #11): critical facts live in structured fields and are compared to source records.
 */
export interface CheckContext {
  /** The draft's structured fields (`task.payload.fields`). */
  readonly fields: Readonly<Record<string, unknown>>;
  /** Verified source records for this draft, loaded by the pack's source loader. */
  readonly sources: Readonly<Record<string, unknown>>;
}

/** The exact inconsistency a failed rule found. Stored on the task and in the audit entry. */
export interface Anomaly {
  rule: string;
  /** Dot path of the offending draft field, when there is one. */
  field?: string;
  message: string;
}

export interface CheckRule {
  id: string;
  /** Action types this rule applies to. Omitted: every action type of the pack. */
  actionTypes?: readonly string[];
  check(ctx: CheckContext): Anomaly[];
}

/** Read a dot path through own properties only. Returns `undefined` when any step is missing. */
export function readPath(root: unknown, path: string): unknown {
  let cur: unknown = root;
  for (const key of path.split(".")) {
    if (cur === null || typeof cur !== "object" || !Object.prototype.hasOwnProperty.call(cur, key)) return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

function isBlank(v: unknown): boolean {
  return v === undefined || v === null || (typeof v === "string" && v.trim() === "") || (Array.isArray(v) && v.length === 0);
}

/** Every listed field is present and not blank (null, empty or whitespace string, empty array). */
export function requiredFields(id: string, paths: readonly string[], actionTypes?: readonly string[]): CheckRule {
  return {
    id,
    actionTypes,
    check: ({ fields }) =>
      paths.filter((p) => isBlank(readPath(fields, p))).map((p) => ({ rule: id, field: p, message: `required field "${p}" is missing` })),
  };
}

export interface NumberEqualsSpec {
  /** Draft field holding the number. */
  field: string;
  /** Dot path into `sources` (for example `po.line.quantity`). */
  source: string;
}

/**
 * Each draft number equals its source number exactly. A draft value that is not a finite number
 * (for example the string "10") fails, and so does a missing source value: nothing is guessed.
 */
export function numberEquality(id: string, specs: readonly NumberEqualsSpec[], actionTypes?: readonly string[]): CheckRule {
  return {
    id,
    actionTypes,
    check: ({ fields, sources }) => {
      const out: Anomaly[] = [];
      for (const { field, source } of specs) {
        const draft = readPath(fields, field);
        const truth = readPath(sources, source);
        if (typeof truth !== "number" || !Number.isFinite(truth)) {
          out.push({ rule: id, field, message: `source value "${source}" is missing or not a number; "${field}" cannot be verified` });
        } else if (typeof draft !== "number" || !Number.isFinite(draft)) {
          out.push({ rule: id, field, message: `"${field}" must be a number (source "${source}" is ${truth})` });
        } else if (draft !== truth) {
          out.push({ rule: id, field, message: `"${field}" is ${draft} but source "${source}" is ${truth}` });
        }
      }
      return out;
    },
  };
}

export interface RecipientMatchSpec {
  /** Draft field holding the recipient (name, phone, or id as a string). */
  field: string;
  /** Dot path into `sources` of the recipient on record. */
  source: string;
}

const normalizeRecipient = (v: string) => v.trim().replace(/\s+/g, " ").toLowerCase();

/** The draft recipient equals the recipient on the source record (trimmed, case-insensitive). */
export function recipientMatch(id: string, spec: RecipientMatchSpec, actionTypes?: readonly string[]): CheckRule {
  return {
    id,
    actionTypes,
    check: ({ fields, sources }) => {
      const draft = readPath(fields, spec.field);
      const truth = readPath(sources, spec.source);
      if (typeof truth !== "string" || truth.trim() === "")
        return [{ rule: id, field: spec.field, message: `source recipient "${spec.source}" is missing; "${spec.field}" cannot be verified` }];
      if (typeof draft !== "string" || draft.trim() === "")
        return [{ rule: id, field: spec.field, message: `recipient "${spec.field}" is missing` }];
      return normalizeRecipient(draft) === normalizeRecipient(truth)
        ? []
        : [{ rule: id, field: spec.field, message: `recipient "${draft}" does not match the recipient on record "${truth}"` }];
    },
  };
}
