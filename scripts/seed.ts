import { closeAllPools, withTenantSession } from "../src/server/db";
import { SEED_TENANTS, seedTenant, type SeedResult } from "../src/server/seed/loader";
import { describeError } from "./_util";

/**
 * Seed the two proof tenants (task 2.5). Idempotent: deterministic tenant ids.
 * Flags: --reset-passwords  issue new owner passwords for existing seeded owners.
 * New credentials are printed once to the console at the end and written nowhere.
 */
async function main() {
  const resetPasswords = process.argv.includes("--reset-passwords");
  const results: SeedResult[] = [];
  for (const t of SEED_TENANTS) {
    const r = await seedTenant(t, { resetPasswords });
    results.push(r);
    console.log(
      `${r.key} ${r.tenantId}: tenant ${r.tenantCreated ? "created" : "existing"}, owner profile ${r.profile}, playbook ${r.playbook} (v${r.version})`,
    );
  }

  console.log("\nProof (the two seeded tenants, by id):");
  for (const t of SEED_TENANTS) {
    const row = await withTenantSession(
      t.tenantId,
      async (c) => {
        const r = await c.query(
          `select t.name, t.status, t.active_pack, s.assistant_name,
                  (select count(*)::int from playbooks p where p.active) as active_playbooks,
                  (select count(*)::int from profiles p where p.role = 'owner') as owners
             from tenants t left join settings s on s.tenant_id = t.id where t.id = $1`,
          [t.tenantId],
        );
        return r.rows[0];
      },
      "service",
    );
    console.log(`${t.key}: ${JSON.stringify(row)}`);
  }

  const fresh = results.filter((r) => r.credential);
  if (fresh.length) {
    console.log("\nOwner credentials (shown once; store them now, they are not saved anywhere):");
    for (const r of fresh) console.log(`  ${r.key}: ${r.credential!.email} / ${r.credential!.password}`);
  } else {
    console.log("\nNo new credentials issued (owner profiles already exist; use --reset-passwords to issue new ones).");
  }
}

main()
  .catch((err) => {
    console.error(`seed failed: ${describeError(err)}`);
    process.exitCode = 1;
  })
  .finally(() => closeAllPools());
