import { readFileSync } from "node:fs";
import type { PoolConfig } from "pg";

export type DbRole = "migrator" | "app" | "service";

export const ROLE_ENV: Record<DbRole, string> = {
  migrator: "DATABASE_URL_MIGRATOR",
  app: "DATABASE_URL_APP",
  service: "DATABASE_URL_SERVICE",
};

export interface ParsedDbUrl {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}

/**
 * Parse a postgres connection URL into explicit fields. Never includes the
 * URL or password in an error message. A password with unescaped special
 * characters (@ : / ? # %) breaks URL parsing; that is reported, not worked
 * around.
 */
export function parseDbUrl(envName: string, raw: string | undefined): ParsedDbUrl {
  if (!raw) throw new Error(`${envName} is not set`);
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(
      `${envName} is not a valid URL. If the password contains special characters ` +
        `(@ : / ? # %), they must be percent-encoded.`,
    );
  }
  if (u.protocol !== "postgresql:" && u.protocol !== "postgres:") {
    throw new Error(`${envName} must use the postgresql:// scheme`);
  }
  let user: string;
  let password: string;
  try {
    user = decodeURIComponent(u.username);
    password = decodeURIComponent(u.password);
  } catch {
    throw new Error(`${envName} has an invalid percent-encoding in its credentials`);
  }
  const database = decodeURIComponent(u.pathname.replace(/^\//, ""));
  if (!u.hostname || !user || !password || !database) {
    throw new Error(
      `${envName} is missing host, user, password or database name. If the password ` +
        `contains special characters, percent-encode them.`,
    );
  }
  return { host: u.hostname, port: u.port ? Number(u.port) : 5432, user, password, database };
}

/**
 * TLS is always on, with certificate verification. Lightsail managed
 * databases serve certificates signed by an Amazon RDS CA. If verification
 * fails because the CA is not in Node's trust store, the committed AWS RDS CA
 * bundle (db/certs) is used, or DATABASE_CA_CERT_FILE overrides it. Verification
 * is never turned off.
 */
export function poolConfigFor(role: DbRole, env: NodeJS.ProcessEnv = process.env): PoolConfig {
  const p = parseDbUrl(ROLE_ENV[role], env[ROLE_ENV[role]]);
  return {
    ...p,
    ssl: { rejectUnauthorized: true, ...(caFromEnv(env) ? { ca: caFromEnv(env) } : {}) },
    max: role === "migrator" ? 2 : 10,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
    application_name: `aruna-${role}`,
  };
}

// Public AWS RDS CA bundle (not a secret), committed so verification works out of the box.
const DEFAULT_CA_FILE = "db/certs/rds-global-bundle.pem";

function caFromEnv(env: NodeJS.ProcessEnv): string | undefined {
  const file = env.DATABASE_CA_CERT_FILE || DEFAULT_CA_FILE;
  try {
    return readFileSync(file, "utf8");
  } catch (err) {
    if (env.DATABASE_CA_CERT_FILE) throw new Error(`DATABASE_CA_CERT_FILE could not be read: ${file}`);
    return undefined;
  }
}
