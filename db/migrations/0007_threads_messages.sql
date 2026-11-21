-- Chat tables (task 8.1). Design §2.6 (agents and chat), §3 (data models). R4.1, R4.2, R4.4, R4.5.
--
-- threads: one Maestro thread per tenant and one thread per specialist agent per tenant. Both
-- are enforced by the database (unique (tenant_id, agent); at most one 'maestro' kind), so the
-- service's create-if-missing is race-safe.
--
-- The assistant display name is NEVER stored on a thread or a message. It lives only in
-- settings.assistant_name and every read surface resolves it live (src/server/threads), so a
-- rename touches exactly one row. For that reason a Maestro thread carries no title; a specialist
-- thread carries its (name-free) registry label.
--
-- messages: ordered by a bigint identity column `seq`, the same tiebreaker as audit_log.seq
-- (migration 0005): created_at is the transaction start time and is equal for messages written
-- in one transaction, so seq (insertion order) is what makes the order deterministic.
-- A message is immutable: runtime roles get no UPDATE and no DELETE.
create table threads (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references tenants (id) on delete restrict,
  kind       text not null check (kind in ('maestro', 'specialist')),
  agent      text not null check (agent ~ '^[a-z][a-z0-9_]{0,62}$'),
  title      text check (title is null or length(btrim(title)) > 0),
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, agent),
  check ((kind = 'maestro' and agent = 'maestro' and title is null)
      or (kind = 'specialist' and agent <> 'maestro' and title is not null))
);
select aruna_enable_tenant_rls('threads');

create table messages (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references tenants (id) on delete restrict,
  thread_id  uuid not null,
  sender     text not null check (sender in ('owner', 'agent')),
  body       text not null check (length(btrim(body)) > 0),
  task_id    uuid,
  seq        bigint generated always as identity,
  created_at timestamptz not null default now(),
  -- A message can only sit in a thread, and point at a task, of its own tenant.
  foreign key (tenant_id, thread_id) references threads (tenant_id, id) on delete restrict,
  foreign key (tenant_id, task_id) references tasks (tenant_id, id) on delete restrict
);
create index messages_thread_order_idx on messages (tenant_id, thread_id, created_at, seq);
select aruna_enable_tenant_rls('messages');

do $$
declare
  app_role text := current_setting('aruna.app_role');
  svc_role text := current_setting('aruna.service_role');
begin
  execute 'revoke all on threads, messages from public';
  execute format('grant select, insert on threads, messages to %I, %I', app_role, svc_role);
end $$;
