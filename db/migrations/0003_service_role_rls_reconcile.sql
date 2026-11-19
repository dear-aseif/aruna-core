-- Reconcile (task 2.1 correction): converge any database that carries an earlier variant of
-- 0002 (unconditional service-role policies, missing aruna_list_tenant_ids()) to the
-- committed 0002 design. Idempotent: functions are replaced, every policy on the five core
-- tables is dropped and recreated, grants are re-asserted. No table structure changes.
-- Role names arrive as the session settings aruna.app_role / aruna.service_role (scripts/migrate.ts).

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

-- Helper functions, as in 0002.
create or replace function app_tenant_id() returns uuid
  language sql stable
  as $$ select nullif(current_setting('app.tenant_id', true), '')::uuid $$;

create or replace function aruna_enable_tenant_rls(tbl regclass, tenant_col text default 'tenant_id') returns void
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

create or replace function aruna_list_tenant_ids() returns setof uuid
  language sql stable security definer
  set search_path = pg_catalog, public
  as $$ select id from public.tenants where status = 'active' order by id $$;

-- Drop every existing policy on the core tables.
do $$
declare
  p record;
begin
  for p in
    select policyname, tablename from pg_policies
    where schemaname = 'public'
      and tablename in ('tenants', 'profiles', 'playbooks', 'settings', 'audit_log')
  loop
    execute format('drop policy if exists %I on public.%I', p.policyname, p.tablename);
  end loop;
end $$;

-- Recreate the 0002 policy set.
alter table tenants enable row level security;
alter table tenants force row level security;
alter table profiles enable row level security;
alter table profiles force row level security;
alter table playbooks enable row level security;
alter table playbooks force row level security;
alter table settings enable row level security;
alter table settings force row level security;
alter table audit_log enable row level security;
alter table audit_log force row level security;

select aruna_enable_tenant_rls('tenants', 'id');
select aruna_enable_tenant_rls('profiles');
select aruna_enable_tenant_rls('playbooks');
select aruna_enable_tenant_rls('settings');

do $$
begin
  execute format('create policy tenants_bootstrap_owner_select on tenants for select to %I using (true)', current_user);
  execute format(
    'create policy profiles_login_lookup on profiles for select to %I using (email = nullif(current_setting(''app.login_email'', true), ''''))',
    current_setting('aruna.app_role'));
end $$;

-- audit_log policies and grants, as in 0002.
do $$
declare
  app_role text := current_setting('aruna.app_role');
  svc_role text := current_setting('aruna.service_role');
begin
  execute format('create policy audit_log_select on audit_log for select to %I, %I using (tenant_id = app_tenant_id())', app_role, svc_role);
  execute format('create policy audit_log_insert on audit_log for insert to %I, %I with check (tenant_id = app_tenant_id())', app_role, svc_role);

  execute 'revoke all on tenants, profiles, playbooks, settings, audit_log from public';
  execute format('revoke all on tenants, profiles, playbooks, settings, audit_log from %I, %I', app_role, svc_role);

  execute format('grant select on tenants, profiles to %I', app_role);
  execute format('grant select, insert, update on playbooks, settings to %I', app_role);
  execute format('grant select, insert on audit_log to %I', app_role);

  execute format('grant select, insert, update on tenants, profiles, playbooks, settings to %I', svc_role);
  execute format('grant select, insert on audit_log to %I', svc_role);

  execute format('grant execute on function app_tenant_id() to %I, %I', app_role, svc_role);
  execute 'revoke all on function aruna_list_tenant_ids() from public';
  execute format('revoke all on function aruna_list_tenant_ids() from %I', app_role);
  execute format('grant execute on function aruna_list_tenant_ids() to %I', svc_role);
end $$;

revoke all on function aruna_enable_tenant_rls(regclass, text) from public;
