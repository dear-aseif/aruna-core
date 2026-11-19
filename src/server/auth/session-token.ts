import type { JWT } from "next-auth/jwt";
import { resolveSession } from "./service";

/**
 * Cookie codec for Auth.js. Auth.js refuses credentials sign-in unless its strategy is
 * "jwt", so the strategy flag says "jwt" but nothing here is a stateless token: the cookie
 * value is the opaque database-session token, and `decode` looks it up in the sessions
 * table on every request. A revoked, expired, unknown, or deactivated-tenant session decodes
 * to null, so Auth.js treats the request as signed out.
 */
export async function encodeSessionToken({ token }: { token?: JWT }): Promise<string> {
  const t = token?.sessionToken;
  return typeof t === "string" ? t : "";
}

export async function decodeSessionToken({ token }: { token?: string }): Promise<JWT | null> {
  const ctx = await resolveSession(token);
  if (!ctx) return null;
  // `sub` is the user id; the tenant is deliberately not exposed to the client session.
  return { sub: ctx.userId, email: ctx.email, sessionToken: token };
}
