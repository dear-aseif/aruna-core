import type { PoolClient, QueryResultRow } from "pg";
import { withTenantSession, type DbRole } from "../db";
import { AuthenticationError, resolveSession, type AuthContext } from "../auth/service";
import { CrossTenantReferenceError, NotFoundError, TenantContextError } from "./errors";

export { CrossTenantReferenceError, NotFoundError, TenantContextError } from "./errors";

export type AuditActor = "owner" | "agent" | "system" | "operator";

/** Who is calling and for which tenant. Built server-side (from the session), never from client input. */
export interface Caller {
  tenantId: string;
  actor: AuditActor;
  /** Stable identity of the actor (profile user id, agent name, or routine name). */
  actorId: string;
}

export const CROSS_TENANT_AUDIT_TYPE = "security.cross_tenant_attempt";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IDENT = /^[a-z_][a-z0-9_]{0,62}$/;

function ident(name: string): string {
  if (!IDENT.test(name)) throw new Error(`invalid SQL identifier: ${name}`);
  return `"${name}"`;
}

/** Map an authenticated session to a Caller. Owner sessions are `owner`, operator sessions are `operator`; actorId is the profile user id. */
export function callerFromAuth(ctx: AuthContext): Caller {
  return { tenantId: ctx.tenantId, actor: ctx.role === "owner" ? "owner" : "operator", actorId: ctx.userId };
}

function isRlsViolation(err: unknown): boolean {
  const e = err as { code?: string; message?: string };
  return e?.code === "42501" && /row-level security/i.test(e.message ?? "");
}

/** The transaction handle. Every query of a unit of work runs on this one handle. */
export class TenantTx {
  constructor(
    private readonly client: PoolClient,
    readonly caller: Caller,
  ) {}

  get tenantId(): string {
    return this.caller.tenantId;
  }

  async query<R extends QueryResultRow = QueryResultRow>(text: string, params: unknown[] = []): Promise<R[]> {
    return (await this.client.query<R>(text, params)).rows;
  }

  async maybeOne<R extends QueryResultRow = QueryResultRow>(text: string, params: unknown[] = []): Promise<R | null> {
    return (await this.query<R>(text, params))[0] ?? null;
  }

  /** Refuse a reference whose declared tenant is not the caller's. */
  assertSameTenant(referencedTenantId: unknown, table?: string): void {
    if (referencedTenantId !== this.tenantId) throw new CrossTenantReferenceError("tenant_mismatch", table);
  }

  /** Read one record by id. Throws NotFoundError if it is not visible to this tenant. */
  async getById<R extends QueryResultRow = QueryResultRow>(table: string, id: string, idColumn = "id"): Promise<R> {
    const r = await this.maybeOne<R>(`select * from ${ident(table)} where ${ident(idColumn)} = $1`, [id]);
    if (!r) throw new NotFoundError(table);
    return r;
  }

  /**
   * Insert a row for the caller's tenant. `tenant_id` is injected; a `tenant_id` supplied
   * for another tenant is a cross-tenant reference and is refused.
   */
  async insert<R extends QueryResultRow = QueryResultRow>(table: string, values: Record<string, unknown>): Promise<R> {
    if ("tenant_id" in values) this.assertSameTenant(values.tenant_id, table);
    const row: Record<string, unknown> = { ...values, tenant_id: this.tenantId };
    const cols = Object.keys(row);
    const rows = await this.query<R>(
      `insert into ${ident(table)} (${cols.map(ident).join(", ")}) values (${cols.map((_, i) => `$${i + 1}`).join(", ")}) returning *`,
      cols.map((c) => row[c]),
    );
    return rows[0];
  }

  /** Update one record by id. Throws NotFoundError if it is not visible to this tenant. */
  async updateById<R extends QueryResultRow = QueryResultRow>(
    table: string,
    id: string,
    set: Record<string, unknown>,
    idColumn = "id",
  ): Promise<R> {
    if ("tenant_id" in set) this.assertSameTenant(set.tenant_id, table);
    const cols = Object.keys(set).filter((c) => c !== "tenant_id");
    if (cols.length === 0) throw new Error("updateById: nothing to update");
    const rows = await this.query<R>(
      `update ${ident(table)} set ${cols.map((c, i) => `${ident(c)} = $${i + 2}`).join(", ")} where ${ident(idColumn)} = $1 returning *`,
      [id, ...cols.map((c) => set[c])],
    );
    if (!rows[0]) throw new NotFoundError(table);
    return rows[0];
  }

  /** Append an audit entry in this transaction, for the caller's tenant and actor. */
  async audit(type: string, payload: Record<string, unknown> = {}, taskId: string | null = null): Promise<void> {
    await this.client.query(
      "insert into audit_log (tenant_id, task_id, actor, actor_id, type, payload) values ($1, $2, $3, $4, $5, $6::jsonb)",
      [this.tenantId, taskId, this.caller.actor, this.caller.actorId, type, JSON.stringify(payload)],
    );
  }
}

/**
 * The Data Access Layer's single transaction wrapper (design §2.1): one transaction, tenant
 * bound with a parameterised set_config inside it, every query on the same handle, commit or
 * roll back as one. Fails closed before any query when the tenant context is missing or malformed.
 *
 * Cross-tenant refusal: if the unit of work raises CrossTenantReferenceError (or the database
 * refuses a write with a row-level-security violation), the unit of work is rolled back and
 * the refusal is recorded as a `security.cross_tenant_attempt` audit entry under the caller's
 * tenant in its own short transaction, so the entry survives the rollback. The caller then
 * receives CrossTenantReferenceError.
 */
export async function withTenant<T>(
  caller: Caller,
  work: (tx: TenantTx) => Promise<T>,
  role: Exclude<DbRole, "migrator"> = "app",
): Promise<T> {
  if (
    !caller ||
    typeof caller.tenantId !== "string" ||
    !UUID.test(caller.tenantId) ||
    !caller.actorId ||
    typeof caller.actorId !== "string"
  ) {
    throw new TenantContextError();
  }
  try {
    return await withTenantSession(caller.tenantId, (c) => work(new TenantTx(c, caller)), role);
  } catch (err) {
    const refusal =
      err instanceof CrossTenantReferenceError
        ? err
        : isRlsViolation(err)
          ? new CrossTenantReferenceError("rls_violation")
          : null;
    if (!refusal) throw err;
    await withTenantSession(
      caller.tenantId,
      (c) => new TenantTx(c, caller).audit(CROSS_TENANT_AUDIT_TYPE, { reason: refusal.reason, table: refusal.table ?? null }),
      role,
    );
    throw refusal;
  }
}

/**
 * Resolve the caller from a session token, then run the unit of work in that caller's tenant.
 * The tenant is never taken from a client parameter.
 */
export async function withCaller<T>(token: unknown, work: (tx: TenantTx, auth: AuthContext) => Promise<T>): Promise<T> {
  const auth = await resolveSession(token);
  if (!auth) throw new AuthenticationError();
  return withTenant(callerFromAuth(auth), (tx) => work(tx, auth));
}
