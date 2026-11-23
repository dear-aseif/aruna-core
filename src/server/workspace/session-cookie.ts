import { cookies } from "next/headers";

/** Auth.js cookie names (plain and secure-prefixed). The value is the opaque database-session token. */
export const SESSION_COOKIE_NAMES = ["__Secure-authjs.session-token", "authjs.session-token"] as const;

export async function readSessionToken(): Promise<string | undefined> {
  const jar = await cookies();
  for (const n of SESSION_COOKIE_NAMES) {
    const v = jar.get(n)?.value;
    if (v) return v;
  }
  return undefined;
}
