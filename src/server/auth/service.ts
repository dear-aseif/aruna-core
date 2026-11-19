import { createHash, randomBytes } from "node:crypto";
import type { PoolClient } from "pg";
import { getPool, withTenantSession } from "../db";
import { dummyHash, MAX_PASSWORD_LENGTH, verifyPassword } from "./password";

/** Absolute session lifetime (no sliding renewal). Decision recorded in the task 2.2 report. */
export const SESSION_TTL_SECONDS = 14 * 24 * 60 * 60;

export type ProfileRole = "owner" | "operator";

/** The server-resolved identity of a request. The tenant here comes from the database only. */
export interface AuthContext {
  sessionId: string;
  userId: string;
  tenantId: string;
  role: ProfileRole;
  email: string;
}

export interface SignInResult {
  sessionToken: string;
  expires: Date;
  context: AuthContext;
}

export function normalizeEmail(email: unknown): string | null {
  if (typeof email !== "string") return null;
  const e = email.trim().toLowerCase();
  return e.length > 0 && e.length <= 320 ? e : null;
}

export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function newSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

interface ProfileRow {
  user_id: string;
  tenant_id: string;
  email: string;
  password_hash: string;
  role: ProfileRole;
}

/** Runs on the app pool in one transaction with a transaction-local setting; no tenant needed. */
async function withLocalSetting<T>(
  key: "app.login_email" | "app.session_token_hash",
  value: string,
  work: (c: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await getPool("app").connect();
  try {
    await client.query("begin");
    await client.query("select set_config($1, $2, true)", [key, value]);
    const r = await work(client);
    await client.query("commit");
    return r;
  } catch (err) {
    await client.query("rollback").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Credentials sign-in. Order (design auth contract):
 *  1. resolve the profile by email through the profiles_login_lookup policy
 *     (app.login_email set inside one transaction);
 *  2. verify the argon2id hash;
 *  3. take the tenant FROM THE PROFILE ROW and create the session inside that tenant's session.
 * The only client inputs are email and password. Every failure returns null, with no
 * distinction between unknown email, wrong password, and inactive tenant.
 */
export async function signInWithPassword(emailInput: unknown, password: unknown): Promise<SignInResult | null> {
  const email = normalizeEmail(emailInput);
  const passwordOk = typeof password === "string" && password.length > 0 && password.length <= MAX_PASSWORD_LENGTH;
  if (!email || !passwordOk) return null;

  const profile = await withLocalSetting("app.login_email", email, async (c) => {
    const r = await c.query<ProfileRow>(
      "select user_id, tenant_id, email, password_hash, role from profiles where email = $1",
      [email],
    );
    return r.rows[0] ?? null;
  });

  const verified = await verifyPassword(profile?.password_hash ?? (await dummyHash()), password as string);
  if (!profile || !verified) return null;

  const token = newSessionToken();
  const created = await withTenantSession(profile.tenant_id, async (c) => {
    const t = await c.query<{ status: string }>("select status from tenants where id = app_tenant_id()");
    if (t.rows[0]?.status !== "active") return null;
    const s = await c.query<{ id: string; expires_at: Date }>(
      `insert into sessions (tenant_id, user_id, session_token_hash, expires_at)
       values ($1, $2, $3, now() + make_interval(secs => $4))
       returning id, expires_at`,
      [profile.tenant_id, profile.user_id, hashSessionToken(token), SESSION_TTL_SECONDS],
    );
    return s.rows[0];
  });
  if (!created) return null;

  return {
    sessionToken: token,
    expires: created.expires_at,
    context: {
      sessionId: created.id,
      userId: profile.user_id,
      tenantId: profile.tenant_id,
      role: profile.role,
      email: profile.email,
    },
  };
}

/**
 * Resolve a session token to the caller's identity, or null. The tenant is read from the
 * session row (via the token-lookup policy), then everything else is re-read inside that
 * tenant's session. Refused when the token is unknown, revoked, or expired (database time),
 * or when the tenant is no longer active (design §2.9: a live session grants nothing once
 * the tenant is deactivated).
 */
export async function resolveSession(token: unknown): Promise<AuthContext | null> {
  if (typeof token !== "string" || token.length === 0 || token.length > 256) return null;
  const hash = hashSessionToken(token);

  const tenantId = await withLocalSetting("app.session_token_hash", hash, async (c) => {
    const r = await c.query<{ tenant_id: string }>(
      "select tenant_id from sessions where session_token_hash = $1",
      [hash],
    );
    return r.rows[0]?.tenant_id ?? null;
  });
  if (!tenantId) return null;

  return withTenantSession(tenantId, async (c) => {
    const r = await c.query<{ id: string; user_id: string; tenant_id: string; role: ProfileRole; email: string }>(
      `select s.id, s.user_id, s.tenant_id, p.role, p.email
         from sessions s
         join profiles p on p.tenant_id = s.tenant_id and p.user_id = s.user_id
         join tenants t on t.id = s.tenant_id
        where s.session_token_hash = $1
          and s.revoked_at is null
          and s.expires_at > now()
          and t.status = 'active'`,
      [hash],
    );
    const row = r.rows[0];
    return row
      ? { sessionId: row.id, userId: row.user_id, tenantId: row.tenant_id, role: row.role, email: row.email }
      : null;
  });
}

/** Revoke one session by token. Idempotent; unknown tokens are ignored. */
export async function revokeSession(token: unknown): Promise<void> {
  if (typeof token !== "string" || token.length === 0 || token.length > 256) return;
  const hash = hashSessionToken(token);
  const tenantId = await withLocalSetting("app.session_token_hash", hash, async (c) => {
    const r = await c.query<{ tenant_id: string }>("select tenant_id from sessions where session_token_hash = $1", [hash]);
    return r.rows[0]?.tenant_id ?? null;
  });
  if (!tenantId) return;
  await withTenantSession(tenantId, (c) =>
    c.query("update sessions set revoked_at = now() where session_token_hash = $1 and revoked_at is null", [hash]),
  );
}

/**
 * Resolve the session, then run `work` inside withTenantSession for the tenant the session
 * belongs to. This is the single entry for authenticated data access: callers never pass a tenant.
 */
export async function withAuthenticatedTenant<T>(
  token: unknown,
  work: (client: PoolClient, ctx: AuthContext) => Promise<T>,
): Promise<T> {
  const ctx = await resolveSession(token);
  if (!ctx) throw new AuthenticationError();
  return withTenantSession(ctx.tenantId, (c) => work(c, ctx));
}

export class AuthenticationError extends Error {
  constructor() {
    super("not authenticated");
    this.name = "AuthenticationError";
  }
}
