import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { withTenant, type Caller } from "../dal";
import { hashPassword } from "../auth/password";
import { activatePlaybook, validatePlaybook } from "../playbook";

/**
 * Seed loader (task 2.5). Creates or converges the two proof tenants from /playbooks/*.json.
 * Tenant ids are deterministic constants, so a re-run updates the same two tenants in place
 * and touches no other tenant. Synthetic data only (C4); credentials are never stored in a file.
 */

export interface SeedTenant {
  key: "denana" | "toko-seragam";
  /** Deterministic tenant id: the only handle the loader (and its proof query) uses. */
  tenantId: string;
  playbookFile: string;
  ownerEmail: string;
  /** Pack the Playbook must activate. */
  pack: "services" | "retail";
}

export const SEED_TENANTS: readonly SeedTenant[] = [
  {
    key: "denana",
    tenantId: "5eed0000-0000-4000-8000-00000000d3a1",
    playbookFile: "denana.json",
    ownerEmail: "owner@denana.example",
    pack: "services",
  },
  {
    key: "toko-seragam",
    tenantId: "5eed0000-0000-4000-8000-00000000a5e2",
    playbookFile: "toko-seragam.json",
    ownerEmail: "owner@toko-seragam.example",
    pack: "retail",
  },
];

export const SEED_ACTOR_ID = "seed-loader";

export interface SeedResult {
  key: SeedTenant["key"];
  tenantId: string;
  tenantCreated: boolean;
  profile: "created" | "password-reset" | "unchanged";
  playbook: "activated" | "unchanged";
  version: number;
  /** Plaintext, present only when a password was just set. Print once; never persist. */
  credential?: { email: string; password: string };
}

export function playbooksDir(): string {
  return path.join(process.cwd(), "playbooks");
}

export async function readPlaybookFile(file: string, dir = playbooksDir()): Promise<unknown> {
  return JSON.parse(await readFile(path.join(dir, file), "utf8"));
}

/** Key-order-independent serialization, for comparing a file to the jsonb copy in the database. */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
}

function newPassword(): string {
  return randomBytes(18).toString("base64url");
}

export async function seedTenant(t: SeedTenant, opts: { resetPasswords?: boolean; dir?: string } = {}): Promise<SeedResult> {
  const doc = await readPlaybookFile(t.playbookFile, opts.dir);
  const checked = validatePlaybook(doc);
  if (!checked.ok) {
    throw new Error(`${t.playbookFile} is not a valid Playbook: missing [${checked.missing}] invalid [${checked.invalid.map((i) => i.path)}]`);
  }
  if (checked.playbook.pack !== t.pack) throw new Error(`${t.playbookFile}: expected pack ${t.pack}, got ${checked.playbook.pack}`);
  const pb = checked.playbook;
  const caller: Caller = { tenantId: t.tenantId, actor: "system", actorId: SEED_ACTOR_ID };

  // Step 1: tenant row (created inactive; activation sets the profile fields and status) and owner profile.
  // Provisioning is an operator action, so it runs under the service role; RLS still binds it to this tenant.
  let password: string | undefined;
  const step1 = await withTenant(
    caller,
    async (tx) => {
      const inserted = await tx.query(
        "insert into tenants (id, name, type, timezone) values ($1, $2, $3, $4) on conflict (id) do nothing returning id",
        [t.tenantId, pb.business.name, pb.business.type, pb.business.timezone],
      );
      const existing = await tx.maybeOne<{ user_id: string }>("select user_id from profiles where role = 'owner'");
      let profile: SeedResult["profile"] = "unchanged";
      if (!existing) {
        password = newPassword();
        await tx.insert("profiles", { email: t.ownerEmail, password_hash: await hashPassword(password), role: "owner" });
        profile = "created";
        await tx.audit("seed.owner_profile_created", { email: t.ownerEmail });
      } else if (opts.resetPasswords) {
        password = newPassword();
        await tx.query("update profiles set password_hash = $2, email = $3, updated_at = now() where user_id = $1", [
          existing.user_id,
          await hashPassword(password),
          t.ownerEmail,
        ]);
        profile = "password-reset";
        await tx.audit("seed.owner_password_reset", { email: t.ownerEmail });
      }
      return { tenantCreated: inserted.length > 0, profile };
    },
    "service",
  );

  // Step 2: activate through the Playbook service, unless the active version already equals the file.
  const current = await withTenant(
    caller,
    (tx) => tx.maybeOne<{ version: number; config: unknown }>("select version, config from playbooks where active"),
    "service",
  );
  let playbook: SeedResult["playbook"] = "unchanged";
  let version = current?.version ?? 0;
  if (!current || canonicalJson(current.config) !== canonicalJson(pb)) {
    const r = await activatePlaybook(caller, doc);
    if (!r.ok) throw new Error(`activation refused for ${t.key}`);
    playbook = "activated";
    version = r.version;
  }

  return {
    key: t.key,
    tenantId: t.tenantId,
    tenantCreated: step1.tenantCreated,
    profile: step1.profile,
    playbook,
    version,
    credential: password ? { email: t.ownerEmail, password } : undefined,
  };
}
