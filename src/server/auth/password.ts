import argon2 from "argon2";

// argon2id with explicit parameters (OWASP-recommended minimum: 19 MiB, t=2, p=1).
const OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
} as const;

/** Upper bound so an oversized input cannot be used to burn hashing time. */
export const MAX_PASSWORD_LENGTH = 1024;

export async function hashPassword(plain: string): Promise<string> {
  if (typeof plain !== "string" || plain.length === 0 || plain.length > MAX_PASSWORD_LENGTH) {
    throw new Error("hashPassword: invalid password input");
  }
  return argon2.hash(plain, OPTIONS);
}

/** False for any mismatch or malformed hash; never throws on bad input. */
export async function verifyPassword(hash: string, plain: string): Promise<boolean> {
  if (typeof plain !== "string" || plain.length === 0 || plain.length > MAX_PASSWORD_LENGTH) return false;
  try {
    return await argon2.verify(hash, plain);
  } catch {
    return false;
  }
}

// A real argon2id hash of a random value, computed once, so an unknown email costs the same
// verification time as a known one (no account-existence timing signal).
let dummy: Promise<string> | undefined;
export function dummyHash(): Promise<string> {
  return (dummy ??= argon2.hash(`dummy-${Math.random()}-${Date.now()}`, OPTIONS));
}
