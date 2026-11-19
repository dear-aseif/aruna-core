import { randomUUID, randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeAllPools, withTenantSession } from "@/server/db";
import {
  hashPassword,
  resolveSession,
  revokeSession,
  signInWithPassword,
  withAuthenticatedTenant,
  AuthenticationError,
} from "@/server/auth";
import { hashSessionToken } from "@/server/auth/service";
import { decodeSessionToken, encodeSessionToken } from "@/server/auth/session-token";

try {
  process.loadEnvFile(".env.local");
} catch {
  /* env may already be provided by the shell */
}

// Synthetic fixtures only. Created through the service role inside each tenant's own session
// (the runtime roles have no other way to provision accounts: there is no signup).
const run = randomBytes(4).toString("hex");
const A = { tenant: randomUUID(), user: randomUUID(), email: `owner-a-${run}@example.test`, password: `pw-a-${randomBytes(6).toString("hex")}` };
const B = { tenant: randomUUID(), user: randomUUID(), email: `owner-b-${run}@example.test`, password: `pw-b-${randomBytes(6).toString("hex")}` };
const INACTIVE = { tenant: randomUUID(), user: randomUUID(), email: `owner-x-${run}@example.test`, password: `pw-x-${randomBytes(6).toString("hex")}` };

async function provision(f: typeof A, name: string, status: "active" | "inactive") {
  const hash = await hashPassword(f.password);
  await withTenantSession(
    f.tenant,
    async (c) => {
      await c.query("insert into tenants (id, name, type, status) values ($1, $2, 'test', $3)", [f.tenant, name, status]);
      await c.query(
        "insert into profiles (user_id, tenant_id, email, password_hash, role) values ($1, $2, $3, $4, 'owner')",
        [f.user, f.tenant, f.email, hash],
      );
    },
    "service",
  );
}

beforeAll(async () => {
  await provision(A, `Test Tenant A ${run}`, "active");
  await provision(B, `Test Tenant B ${run}`, "active");
  await provision(INACTIVE, `Test Tenant X ${run}`, "inactive");
}, 60_000);

afterAll(async () => {
  await closeAllPools();
});

describe("credentials sign-in", () => {
  it("correct credentials create a session bound to the profile's tenant", async () => {
    const r = await signInWithPassword(A.email, A.password);
    expect(r).not.toBeNull();
    expect(r!.context.tenantId).toBe(A.tenant);
    expect(r!.context.userId).toBe(A.user);
    expect(r!.context.role).toBe("owner");
    expect(r!.expires.getTime()).toBeGreaterThan(Date.now());

    const ctx = await resolveSession(r!.sessionToken);
    expect(ctx?.tenantId).toBe(A.tenant);

    // The stored row carries the tenant and only a hash of the token.
    await withTenantSession(A.tenant, async (c) => {
      const row = (await c.query("select tenant_id, session_token_hash from sessions where id = $1", [r!.context.sessionId])).rows[0];
      expect(row.tenant_id).toBe(A.tenant);
      expect(row.session_token_hash).toBe(hashSessionToken(r!.sessionToken));
      expect(row.session_token_hash).not.toBe(r!.sessionToken);
    });
  });

  it("email lookup is case- and whitespace-insensitive", async () => {
    const r = await signInWithPassword(`  ${A.email.toUpperCase()} `, A.password);
    expect(r?.context.tenantId).toBe(A.tenant);
  });

  it("refuses a wrong password, an unknown email, and malformed input", async () => {
    expect(await signInWithPassword(A.email, "wrong-password")).toBeNull();
    expect(await signInWithPassword(`nobody-${run}@example.test`, A.password)).toBeNull();
    expect(await signInWithPassword(A.email, "")).toBeNull();
    expect(await signInWithPassword(undefined, undefined)).toBeNull();
    expect(await signInWithPassword(A.email, "x".repeat(5000))).toBeNull();
  });

  it("refuses sign-in for a tenant that is not active", async () => {
    expect(await signInWithPassword(INACTIVE.email, INACTIVE.password)).toBeNull();
  });

  it("stores an argon2id hash, never the plaintext", async () => {
    await withTenantSession(A.tenant, async (c) => {
      const h = (await c.query("select password_hash from profiles where user_id = $1", [A.user])).rows[0].password_hash as string;
      expect(h.startsWith("$argon2id$")).toBe(true);
      expect(h).not.toContain(A.password);
    });
  });
});

describe("tenant isolation of sessions", () => {
  it("a session for tenant A resolves only tenant A and cannot see tenant B", async () => {
    const a = (await signInWithPassword(A.email, A.password))!;
    const b = (await signInWithPassword(B.email, B.password))!;
    expect((await resolveSession(a.sessionToken))?.tenantId).toBe(A.tenant);
    expect((await resolveSession(b.sessionToken))?.tenantId).toBe(B.tenant);

    await withAuthenticatedTenant(a.sessionToken, async (c, ctx) => {
      expect(ctx.tenantId).toBe(A.tenant);
      const emails = (await c.query("select email from profiles")).rows.map((r) => r.email);
      expect(emails).toEqual([A.email]);
      expect((await c.query("select 1 from tenants where id = $1", [B.tenant])).rowCount).toBe(0);
      expect((await c.query("select 1 from sessions where id = $1", [b.context.sessionId])).rowCount).toBe(0);
    });
  });

  it("a forged or altered token resolves to nothing", async () => {
    const a = (await signInWithPassword(A.email, A.password))!;
    expect(await resolveSession(a.sessionToken + "x")).toBeNull();
    expect(await resolveSession(a.sessionToken.slice(0, -1))).toBeNull();
    expect(await resolveSession(hashSessionToken(a.sessionToken))).toBeNull(); // the stored hash is not a credential
    expect(await resolveSession("")).toBeNull();
    expect(await resolveSession(undefined)).toBeNull();
    await expect(withAuthenticatedTenant("bogus", async () => 1)).rejects.toBeInstanceOf(AuthenticationError);
  });

  it("the database refuses a session that pairs tenant A with tenant B's profile", async () => {
    await expect(
      withTenantSession(
        A.tenant,
        (c) =>
          c.query(
            "insert into sessions (tenant_id, user_id, session_token_hash, expires_at) values ($1, $2, $3, now() + interval '1 hour')",
            [A.tenant, B.user, hashSessionToken(randomBytes(8).toString("hex"))],
          ),
        "service",
      ),
    ).rejects.toThrow();
  });

  it("without a token setting the sessions table exposes no rows to the app role", async () => {
    const { getPool } = await import("@/server/db");
    const r = await getPool("app").query("select count(*)::int as n from sessions");
    expect(r.rows[0].n).toBe(0);
  });
});

describe("revoked and expired sessions", () => {
  it("a revoked session is refused, and revoking is idempotent", async () => {
    const s = (await signInWithPassword(A.email, A.password))!;
    expect(await resolveSession(s.sessionToken)).not.toBeNull();
    await revokeSession(s.sessionToken);
    await revokeSession(s.sessionToken);
    expect(await resolveSession(s.sessionToken)).toBeNull();
  });

  it("an expired session is refused using database time", async () => {
    const token = randomBytes(32).toString("base64url");
    await withTenantSession(
      A.tenant,
      (c) =>
        c.query(
          "insert into sessions (tenant_id, user_id, session_token_hash, expires_at) values ($1, $2, $3, now() - interval '1 second')",
          [A.tenant, A.user, hashSessionToken(token)],
        ),
      "service",
    );
    expect(await resolveSession(token)).toBeNull();
  });

  it("a live session stops working once its tenant is no longer active", async () => {
    const s = (await signInWithPassword(B.email, B.password))!;
    expect(await resolveSession(s.sessionToken)).not.toBeNull();
    await withTenantSession(B.tenant, (c) => c.query("update tenants set status = 'deactivated' where id = $1", [B.tenant]), "service");
    expect(await resolveSession(s.sessionToken)).toBeNull();
    await withTenantSession(B.tenant, (c) => c.query("update tenants set status = 'active' where id = $1", [B.tenant]), "service");
  });
});

describe("Auth.js cookie codec (database-backed)", () => {
  it("decodes a live token, and stops decoding it once revoked", async () => {
    const s = (await signInWithPassword(A.email, A.password))!;
    expect(await encodeSessionToken({ token: { sessionToken: s.sessionToken } })).toBe(s.sessionToken);
    const live = await decodeSessionToken({ token: s.sessionToken });
    expect(live?.sub).toBe(A.user);
    expect(JSON.stringify(live)).not.toContain(A.tenant); // tenant never reaches the client session
    await revokeSession(s.sessionToken);
    expect(await decodeSessionToken({ token: s.sessionToken })).toBeNull();
  });

  it("a signed or unknown cookie value decodes to nothing", async () => {
    expect(await decodeSessionToken({ token: "eyJhbGciOiJIUzI1NiJ9.e30.x" })).toBeNull();
    expect(await decodeSessionToken({ token: undefined })).toBeNull();
  });
});
