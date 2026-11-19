import { withTenant, type Caller, type TenantTx } from "../dal";
import { validatePlaybook, type PlaybookCore, type PlaybookProblems } from "./schema";

export class NoActivePlaybookError extends Error {
  constructor() {
    super("tenant has no active Playbook");
    this.name = "NoActivePlaybookError";
  }
}

export class PlaybookActivationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlaybookActivationError";
  }
}

export type ActivationResult =
  | { ok: true; version: number; playbookId: string; pack: string }
  /** Refused: names exactly the missing fields and the invalid ones. Nothing was changed. */
  | ({ ok: false } & PlaybookProblems);

export const PLAYBOOK_ACTIVATED = "playbook.activated";
export const PLAYBOOK_REFUSED = "playbook.activation_refused";

/**
 * Activate a Playbook for the caller's tenant (design §2.2). Provisioning is an operator action,
 * so this runs under the service role; tenant binding and RLS still apply.
 *
 * Incomplete or invalid Playbook: nothing changes, the refusal (with the exact field lists) is
 * audited and returned. Complete Playbook, one transaction: the previous active version is
 * deactivated, the new version becomes the single active one, the tenant's profile fields and
 * pack are set and the tenant becomes active, and `settings` is seeded with the assistant name
 * only if no settings row exists. An existing settings row is never overwritten (amendment #22).
 */
export async function activatePlaybook(caller: Caller, doc: unknown): Promise<ActivationResult> {
  const result = validatePlaybook(doc);
  return withTenant(
    caller,
    async (tx) => {
      if (!result.ok) {
        await tx.audit(PLAYBOOK_REFUSED, { missing: result.missing, invalid: result.invalid });
        return { ok: false, missing: result.missing, invalid: result.invalid };
      }
      const pb = result.playbook;
      const tenant = await tx.getById<{ status: string }>("tenants", tx.tenantId);
      if (tenant.status === "deactivated") throw new PlaybookActivationError("tenant is deactivated");

      const [{ next }] = await tx.query<{ next: number }>("select coalesce(max(version), 0) + 1 as next from playbooks");
      await tx.query("update playbooks set active = false where active");
      const row = await tx.insert<{ id: string }>("playbooks", { version: next, config: JSON.stringify(pb), active: true });
      await tx.query(
        "update tenants set name = $2, type = $3, timezone = $4, active_pack = $5, status = 'active', updated_at = now() where id = $1",
        [tx.tenantId, pb.business.name, pb.business.type, pb.business.timezone, pb.pack],
      );
      await tx.query("insert into settings (tenant_id, assistant_name) values ($1, $2) on conflict (tenant_id) do nothing", [
        tx.tenantId,
        pb.assistantName,
      ]);
      await tx.audit(PLAYBOOK_ACTIVATED, { version: next, pack: pb.pack });
      return { ok: true, version: next, playbookId: row.id, pack: pb.pack };
    },
    "service",
  );
}

/**
 * The tenant's active Playbook as stored in the database (authoritative at runtime). Re-validated
 * on read, so a stored document that no longer satisfies its schema fails loudly.
 */
export async function getActivePlaybook(tx: TenantTx): Promise<PlaybookCore> {
  const row = await tx.maybeOne<{ config: unknown }>("select config from playbooks where active");
  if (!row) throw new NoActivePlaybookError();
  const v = validatePlaybook(row.config);
  if (!v.ok) throw new Error(`stored Playbook is invalid: ${[...v.missing, ...v.invalid.map((i) => i.path)].join(", ")}`);
  return v.playbook;
}

/** Runtime reads. Each one reads the active Playbook row; switching versions changes the results, no code change. */
export async function getActivePack(tx: TenantTx): Promise<string> {
  return (await getActivePlaybook(tx)).pack;
}
export async function getCatalog(tx: TenantTx): Promise<unknown> {
  return (await getActivePlaybook(tx)).catalog;
}
export async function getHours(tx: TenantTx): Promise<PlaybookCore["hours"]> {
  return (await getActivePlaybook(tx)).hours;
}
export async function getThresholds(tx: TenantTx): Promise<PlaybookCore["thresholds"]> {
  return (await getActivePlaybook(tx)).thresholds;
}
export async function getTemplates(tx: TenantTx): Promise<PlaybookCore["templates"]> {
  return (await getActivePlaybook(tx)).templates;
}
export async function getBusinessProfile(tx: TenantTx): Promise<PlaybookCore["business"]> {
  return (await getActivePlaybook(tx)).business;
}

/** Convenience: run one read in the caller's tenant under the runtime role. */
export function readActivePlaybook(caller: Caller): Promise<PlaybookCore> {
  return withTenant(caller, getActivePlaybook);
}
