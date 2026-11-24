-- Briefings (task 10.2). Design §2.11 (briefing contract, amendment #25), §3 (data models). R9.2, R9.4.
--
-- One row per (tenant, schedule date): the unique constraint is the database backstop for the
-- idempotency contract, so re-running the routine for a date can never create a duplicate even if
-- two runs race. `date` is the schedule date in the tenant's timezone. `sections` holds the
-- collected FACTS (query results), never prose and never the assistant's name: the text is rendered
-- from these facts when read, in the viewer's language, with the name resolved live.
--
-- A stored briefing is an immutable archive: runtime roles get SELECT and INSERT only, so a row
-- can be neither updated nor deleted by the application.
create table briefings (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references tenants (id) on delete restrict,
  date       date not null,
  sections   jsonb not null check (jsonb_typeof(sections) = 'array'),
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, date)
);
select aruna_enable_tenant_rls('briefings');

do $$
declare
  app_role text := current_setting('aruna.app_role');
  svc_role text := current_setting('aruna.service_role');
begin
  execute 'revoke all on briefings from public';
  execute format('grant select, insert on briefings to %I, %I', app_role, svc_role);
end $$;
