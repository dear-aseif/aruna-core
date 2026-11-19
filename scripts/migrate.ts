import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { parseDbUrl, poolConfigFor, ROLE_ENV } from "../src/server/db/config";
import { describeError } from "./_util";

const DIR = join(process.cwd(), "db", "migrations");
const NAME = /^\d{4}_[a-z0-9_]+\.sql$/;

async function main() {
  const files = readdirSync(DIR).filter((f) => f.endsWith(".sql")).sort();
  const bad = files.filter((f) => !NAME.test(f));
  if (bad.length) throw new Error(`Migration files must be named NNNN_name.sql: ${bad.join(", ")}`);

  const c = poolConfigFor("migrator");
  const client = new Client({
    host: c.host, port: c.port, user: c.user, password: c.password, database: c.database,
    ssl: c.ssl, connectionTimeoutMillis: 10_000,
  });
  await client.connect();
  try {
    await client.query(
      `create table if not exists schema_migrations (
         filename text primary key,
         applied_at timestamptz not null default now()
       )`,
    );
    const done = new Set((await client.query<{ filename: string }>("select filename from schema_migrations")).rows.map((r) => r.filename));
    // Migrations grant to the runtime roles by name; hand them over as session settings.
    for (const [key, role] of [["aruna.app_role", "app"], ["aruna.service_role", "service"]] as const) {
      const creds = parseDbUrl(ROLE_ENV[role], process.env[ROLE_ENV[role]]);
      await client.query("select set_config($1, $2, false)", [key, creds.user]);
    }
    let applied = 0;
    for (const f of files) {
      if (done.has(f)) continue;
      const sql = readFileSync(join(DIR, f), "utf8");
      try {
        await client.query("begin");
        await client.query(sql);
        await client.query("insert into schema_migrations (filename) values ($1)", [f]);
        await client.query("commit");
      } catch (err) {
        await client.query("rollback").catch(() => {});
        throw new Error(`migration ${f} failed and was rolled back: ${describeError(err)}`);
      }
      applied++;
      console.log(`PASS applied ${f}`);
    }
    console.log(`PASS migrations up to date (${applied} applied, ${files.length - applied} already applied)`);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(`FAIL migrate: ${describeError(err)}`);
  process.exit(1);
});
