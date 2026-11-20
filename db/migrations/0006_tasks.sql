-- Task pipeline table (task 4.2). Design §2.3 (state machine), §3 (data models, amendments #1, #4, #5).
--
-- tasks is tenant-scoped with the same RLS as the task 2.1 tables (one tenant-isolation policy
-- for the app and service roles). unique (tenant_id, id) is the target of composite foreign keys,
-- so a row elsewhere can only reference a task of its own tenant (amendment #4).
--
-- Status changes are made by exactly one server module (src/server/tasks). The database backs
-- that rule up with a trigger: a status change is refused unless the transaction carries the
-- transition marker that module sets, and a task can only be inserted as 'queued'.
create table tasks (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references tenants (id) on delete restrict,
  title               text not null check (length(btrim(title)) > 0),
  origin              text not null check (origin in ('routine', 'maestro', 'direct', 'intake')),
  agent               text not null check (length(btrim(agent)) > 0),
  status              text not null default 'queued'
                        check (status in ('queued', 'working', 'in_review', 'pending_approval', 'done', 'rejected', 'expired', 'failed')),
  payload             jsonb not null default '{}'::jsonb,
  payload_revision    integer not null default 1 check (payload_revision > 0),
  anomaly             text,
  error               text,  -- the recorded failure; required while status is 'failed'
  approval_expires_at timestamptz,
  created_by          text not null check (length(btrim(created_by)) > 0),  -- stable actor id, as in audit_log.actor_id
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (tenant_id, id),
  check (status <> 'failed' or (error is not null and length(btrim(error)) > 0))
);
create index tasks_tenant_status_idx on tasks (tenant_id, status, created_at);
select aruna_enable_tenant_rls('tasks');
-- Status guard (defence in depth behind the single state-machine module).
create function tasks_status_guard() returns trigger
  language plpgsql
  as $$
begin
  if tg_op = 'INSERT' then
    if new.status <> 'queued' then
      raise exception 'a task is created as queued, not %', new.status using errcode = 'check_violation';
    end if;
  elsif new.status is distinct from old.status
        and coalesce(current_setting('aruna.task_transition', true), '') <> 'on' then
    raise exception 'task status changes only through the task state machine'
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end $$;
create trigger tasks_status_guard
  before insert or update on tasks
  for each row execute function tasks_status_guard();
-- Grants: no DELETE for any runtime role (a task is never removed; audit rows point at it).
do $$
declare
  app_role text := current_setting('aruna.app_role');
  svc_role text := current_setting('aruna.service_role');
begin
  execute 'revoke all on tasks from public';
  execute format('grant select, insert, update on tasks to %I, %I', app_role, svc_role);
end $$;
-- The composite foreign key planned since task 2.1: an audit entry can only point at a task of
-- its own tenant. NO ACTION: deleting a task never cascades into the audit log. A null task_id
-- (tenant-level events) is unaffected.
alter table audit_log
  add constraint audit_log_task_fk
  foreign key (tenant_id, task_id) references tasks (tenant_id, id) on delete no action;
