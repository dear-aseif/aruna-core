import { Client } from "pg";
import { poolConfigFor, parseDbUrl, ROLE_ENV } from "../src/server/db/config";
import { describeError } from "./_util";

/**
 * Creates the application runtime and service/routine roles (design §2.1).
 * Idempotent. Credentials come from DATABASE_URL_APP / DATABASE_URL_SERVICE.
 * Nothing secret is printed. The CREATE/ALTER statement is composed on the
 * server with format(%I, %L) from bound parameters, never by string interpolation.
 */
async function main() {
  const c = poolConfigFor("migrator");
  const client = new Client({
    host: c.host, port: c.port, user: c.user, password: c.password, database: c.database,
    ssl: c.ssl, connectionTimeoutMillis: 10_000,
  });
  await client.connect();
  try {
    for (const role of ["app", "service"] as const) {
      const creds = parseDbUrl(ROLE_ENV[role], process.env[ROLE_ENV[role]]);
      const exists = await client.query("select 1 from pg_roles where rolname = $1", [creds.user]);
      const verb = exists.rowCount ? "alter" : "create";
      // The managed master user is not a superuser, so Postgres refuses ALTER ROLE on
      // security attributes. Attributes are fixed at CREATE; an existing role only gets its
      // password reset, and its attributes are then verified below.
      const attrs =
        verb === "create" ? " nosuperuser nocreatedb nocreaterole noinherit nobypassrls noreplication" : "";
      const stmt = await client.query<{ s: string }>(
        `select format('%s role %I with login password %L' || $4::text, $1::text, $2::text, $3::text) as s`,
        [verb, creds.user, creds.password, attrs],
      );
      await client.query(stmt.rows[0].s);
      const a = (
        await client.query<{ bad: boolean }>(
          `select (rolsuper or rolcreatedb or rolcreaterole or rolbypassrls or rolreplication or not rolcanlogin) as bad
             from pg_roles where rolname = $1`,
          [creds.user],
        )
      ).rows[0];
      if (!a || a.bad) throw new Error(`role ${role} has unexpected attributes; drop and recreate it`);
      // Allow connecting to the database; no other privileges here (table grants come with the tables).
      const grant = await client.query<{ s: string }>(
        `select format('grant connect on database %I to %I', current_database(), $1::text) as s`,
        [creds.user],
      );
      await client.query(grant.rows[0].s);
      console.log(`PASS role ${role}: ${verb === "create" ? "created" : "already existed, password reset, attributes verified"}`);
    }
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(`FAIL bootstrap-roles: ${describeError(err)}`);
  process.exit(1);
});
