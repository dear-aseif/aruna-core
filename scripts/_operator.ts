import type { Caller } from "../src/server/dal";
/** Parses `--name value` pairs for the operator scripts; every listed name is required. */
export function parseArgs<K extends string>(names: readonly K[]): Record<K, string> {
  const argv = process.argv.slice(2);
  const out = {} as Record<K, string>;
  for (const n of names) {
    const i = argv.indexOf(`--${n}`);
    const v = i >= 0 ? argv[i + 1] : undefined;
    if (!v || v.startsWith("--")) throw new Error(`missing --${n} <value> (required: ${names.map((x) => `--${x}`).join(", ")})`);
    out[n] = v;
  }
  return out;
}
/** The operator's stable identity comes from --operator; it is written to the audit log on every entry. */
export const operatorCaller = (a: { tenant: string; operator: string }): Caller => ({ tenantId: a.tenant, actor: "operator", actorId: a.operator });
