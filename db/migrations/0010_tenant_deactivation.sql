-- Tenant deactivation (task 10.4). Design §2.9 (amendments #16, #17, #18), R1.4.
--
-- 1. Write guard. Once a tenant is 'deactivated' its data is read-only: a trigger refuses every
--    INSERT and UPDATE on the guarded tenant tables, whatever role, session or routine issues it.
--    The guard takes a shared transaction-level advisory lock per tenant before it reads the
--    status; deactivation takes the same lock exclusively, so it waits for in-flight writers
--    (the freshness check then sees their commits) and later writers see the new status.
--    audit_log is deliberately NOT guarded (append-only evidence: operator actions and refused
--    attempts are still recorded). DELETE is not guarded: the runtime roles hold no DELETE grant,
--    and hard deletion is a separate, later operator action.
--    `aruna_enable_deactivation_guard(tbl)` is how a pack migration guards its own tables.
-- 2. export_verifications: the operator's record of an archive check (one row per attempt).
create function aruna_refuse_deactivated_write() returns trigger
  language plpgsql
  as $$
declare
  t uuid := new.tenant_id;
  s text;
begin
  perform pg_advisory_xact_lock_shared(hashtextextended('aruna.tenant.' || t::text, 0));
  select status into s from tenants where id = t;
  if s = 'deactivated' then
    raise exception 'tenant is deactivated: writes are refused' using errcode = 'AD001';
  end if;
  return new;
end $$;
create function aruna_enable_deactivation_guard(tbl regclass, ops text default 'insert or update') returns void
  language plpgsql
  as $$
declare
  rel text := (select relname from pg_class where oid = tbl);
begin
  execute format(
    'create trigger %I before %s on %s for each row execute function aruna_refuse_deactivated_write()',
    rel || '_deactivation_guard', ops, tbl);
end $$;
revoke all on function aruna_enable_deactivation_guard(regclass, text) from public;
select aruna_enable_deactivation_guard('playbooks');
select aruna_enable_deactivation_guard('settings');
select aruna_enable_deactivation_guard('tasks');
select aruna_enable_deactivation_guard('threads');
select aruna_enable_deactivation_guard('messages');
select aruna_enable_deactivation_guard('briefings');
-- New sessions for a deactivated tenant are refused too (revocation, an UPDATE, stays possible).
select aruna_enable_deactivation_guard('sessions', 'insert');
create table export_verifications (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references tenants (id) on delete restrict,
  result         text not null check (result in ('passed', 'failed')),
  verified_by    text not null check (length(btrim(verified_by)) > 0),
  archive_sha256 text not null check (archive_sha256 ~ '^[0-9a-f]{64}$'),
  archive_bytes  bigint not null check (archive_bytes >= 0),
  cutoff         timestamptz,
  -- Entity counts from the manifest, the sha256 of each entity's JSON file (audit_log excluded),
  -- and the digest of the archive's audit entries (see src/server/exports/verify.ts).
  entities       jsonb not null default '{}'::jsonb,
  file_hashes    jsonb not null default '{}'::jsonb,
  audit_digest   text,
  problems       jsonb not null default '[]'::jsonb,
  created_at     timestamptz not null default now(),
  unique (tenant_id, id)
);
create index export_verifications_tenant_created_idx on export_verifications (tenant_id, created_at desc);
select aruna_enable_tenant_rls('export_verifications');
do $$
declare
  svc_role text := current_setting('aruna.service_role');
begin
  -- Operator-only: the owner-facing app role gets nothing. Records are immutable (no UPDATE/DELETE).
  execute 'revoke all on export_verifications from public';
  execute format('grant select, insert on export_verifications to %I', svc_role);
end $$;
