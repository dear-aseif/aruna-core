-- Core tenancy tables (task 2.1): tenants, profiles, playbooks, settings, audit_log.
-- Design §2.1 (tenancy, roles, RLS), §3 (data models). R1.1-1.3, R1.5, R2.1-2.4, R6.2.
--
-- Not created here (allocated to the features that build them): tasks (4.2),
-- threads and messages (8.1), briefings (10.2). audit_log.task_id is a plain nullable
-- uuid for now; task 4.2 adds the composite (tenant_id, task_id) foreign key.
--
-- Database roles. The migration owner runs this file. The runtime (app) and
-- service/routine role names come from DATABASE_URL_APP / DATABASE_URL_SERVICE;
-- scripts/migrate.ts passes them in as the session settings aruna.app_role and
-- aruna.service_role. The roles must already exist (npm run db:bootstrap-roles).
--
-- Neither runtime role has BYPASSRLS or any blanket policy (design §2.1). Both are bound
-- by the same tenant policies. The only cross-tenant read is aruna_list_tenant_ids(),
-- a security-definer function that returns tenant ids and nothing else.

do $$
declare
  app_role text := nullif(current_setting('aruna.app_role', true), '');
  svc_role text := nullif(current_setting('aruna.service_role', true), '');
begin
  if app_role is null or svc_role is null then
    raise exception 'aruna.app_role / aruna.service_role are not set; run this through scripts/migrate.ts';
  end if;
  if not exists (select 1 from pg_roles where rolname = app_role)
     or not exists (select 1 from pg_roles where rolname = svc_role) then
    raise exception 'runtime roles % / % do not exist; run the role bootstrap first', app_role, svc_role;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Tenant context
-- ---------------------------------------------------------------------------

-- The tenant bound to the current transaction (SET LOCAL app.tenant_id). Returns NULL
-- when unset or empty, so every policy comparison is NULL and no row is visible
-- or writable: fail closed. A malformed value raises, which also fails closed.
create function app_tenant_id() returns uuid
  language sql stable
  as $$ select nullif(current_setting('app.tenant_id', true), '')::uuid $$;

-- Enables and forces RLS on a business table, adds the tenant-isolation policy for the
-- app and service roles (USING and WITH CHECK on the table's tenant column).
-- Later migrations call this for their tables.
create function aruna_enable_tenant_rls(tbl regclass, tenant_col text default 'tenant_id') returns void
  language plpgsql
  as $$
declare
  app_role text := current_setting('aruna.app_role');
  svc_role text := current_setting('aruna.service_role');
  rel text := (select relname from pg_class where oid = tbl);
begin
  execute format('alter table %s enable row level security', tbl);
  execute format('alter table %s force row level security', tbl);
  execute format(
    'create policy %I on %s for all to %I, %I using (%I = app_tenant_id()) with check (%I = app_tenant_id())',
    rel || '_tenant_isolation', tbl, app_role, svc_role, tenant_col, tenant_col);
end $$;

-- ---------------------------------------------------------------------------
-- tenants
-- ---------------------------------------------------------------------------

create table tenants (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (length(btrim(name)) > 0),
  type        text not null check (length(btrim(type)) > 0),
  active_pack text check (active_pack in ('services', 'retail')),
  timezone    text not null default 'UTC',
  status      text not null default 'inactive' check (status in ('active', 'inactive', 'deactivated')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

select aruna_enable_tenant_rls('tenants', 'id');

-- Narrow bootstrap lookup for routines (design §2.1): returns active tenant ids only, then
-- the caller works per tenant inside tenant sessions. The function owner (the migration
-- owner, subject to FORCE RLS) gets a select policy so the definer can read; runtime roles
-- never get that policy and cannot read other tenant rows directly.
do $$
begin
  execute format('create policy tenants_bootstrap_owner_select on tenants for select to %I using (true)', current_user);
end $$;

create function aruna_list_tenant_ids() returns setof uuid
  language sql stable security definer
  set search_path = pg_catalog, public
  as $$ select id from public.tenants where status = 'active' order by id $$;

-- ---------------------------------------------------------------------------
-- profiles: binds one login to exactly one tenant (owner or operator)
-- ---------------------------------------------------------------------------

create table profiles (
  user_id       uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants (id) on delete restrict,
  email         text not null check (email = lower(btrim(email)) and length(email) > 0),
  password_hash text not null,  -- argon2id; never exported (design §2.9)
  role          text not null check (role in ('owner', 'operator')),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (tenant_id, user_id)
);
create unique index profiles_email_key on profiles (email);
create index profiles_tenant_idx on profiles (tenant_id);

select aruna_enable_tenant_rls('profiles');

-- Sign-in bootstrap lookup (design §2.1): before a tenant is known, the app role may read
-- only the single profile whose email equals the transaction-local app.login_email.
-- No setting means no row.
do $$
begin
  execute format(
    'create policy profiles_login_lookup on profiles for select to %I using (email = nullif(current_setting(''app.login_email'', true), ''''))',
    current_setting('aruna.app_role'));
end $$;

-- ---------------------------------------------------------------------------
-- playbooks: versioned, one active version per tenant
-- ---------------------------------------------------------------------------

create table playbooks (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references tenants (id) on delete restrict,
  version    integer not null check (version > 0),
  config     jsonb not null,
  active     boolean not null default false,
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, version)
);
create unique index playbooks_one_active_per_tenant on playbooks (tenant_id) where active;

select aruna_enable_tenant_rls('playbooks');

-- ---------------------------------------------------------------------------
-- settings: one row per tenant (assistant display name, gateway config)
-- ---------------------------------------------------------------------------

create table settings (
  tenant_id      uuid primary key references tenants (id) on delete restrict,
  assistant_name text not null check (length(btrim(assistant_name)) > 0),
  model_provider text,
  model_id       text,
  updated_at     timestamptz not null default now()
);

select aruna_enable_tenant_rls('settings');

-- ---------------------------------------------------------------------------
-- audit_log: append-only (R6.2)
-- ---------------------------------------------------------------------------

create table audit_log (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references tenants (id) on delete restrict,
  task_id    uuid,  -- composite FK (tenant_id, task_id) is added with the tasks table (4.2)
  actor      text not null check (actor in ('owner', 'agent', 'system')),
  actor_id   text not null,
  type       text not null check (length(btrim(type)) > 0),
  payload    jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index audit_log_tenant_created_idx on audit_log (tenant_id, created_at);
create index audit_log_tenant_task_idx on audit_log (tenant_id, task_id) where task_id is not null;

alter table audit_log enable row level security;
alter table audit_log force row level security;

-- Defence in depth: a trigger rejects UPDATE, DELETE and TRUNCATE for every role,
-- including the table owner, on top of the grants below.
create function audit_log_append_only() returns trigger
  language plpgsql
  as $$
begin
  raise exception 'audit_log is append-only: % is not permitted', tg_op
    using errcode = 'insufficient_privilege';
end $$;

create trigger audit_log_no_update_delete
  before update or delete on audit_log
  for each row execute function audit_log_append_only();
create trigger audit_log_no_truncate
  before truncate on audit_log
  for each statement execute function audit_log_append_only();

-- ---------------------------------------------------------------------------
-- Policies for audit_log (select + insert only) and grants
-- ---------------------------------------------------------------------------

do $$
declare
  app_role text := current_setting('aruna.app_role');
  svc_role text := current_setting('aruna.service_role');
begin
  execute format('create policy audit_log_select on audit_log for select to %I, %I using (tenant_id = app_tenant_id())', app_role, svc_role);
  execute format('create policy audit_log_insert on audit_log for insert to %I, %I with check (tenant_id = app_tenant_id())', app_role, svc_role);

  -- Nothing is granted to PUBLIC; each role gets exactly what it needs.
  execute 'revoke all on tenants, profiles, playbooks, settings, audit_log from public';

  -- App runtime: no DELETE anywhere; tenants and profiles are read-only (provisioning and
  -- deactivation are operator actions run through the service role).
  execute format('grant select on tenants, profiles to %I', app_role);
  execute format('grant select, insert, update on playbooks, settings to %I', app_role);
  execute format('grant select, insert on audit_log to %I', app_role);

  -- Service/routine role.
  execute format('grant select, insert, update on tenants, profiles, playbooks, settings to %I', svc_role);
  execute format('grant select, insert on audit_log to %I', svc_role);

  execute format('grant execute on function app_tenant_id() to %I, %I', app_role, svc_role);
  execute 'revoke all on function aruna_list_tenant_ids() from public';
  execute format('grant execute on function aruna_list_tenant_ids() to %I', svc_role);
end $$;

-- Later migrations create tables as the migration owner; the runtime roles must not
-- receive anything implicitly, so default privileges stay empty.
revoke all on function aruna_enable_tenant_rls(regclass, text) from public;
