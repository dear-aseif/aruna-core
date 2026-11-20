-- Audit service (task 4.1): operator sessions get their own audit actor.
-- Carried obligation from gate ruling 2.3: until now operator sessions were recorded as
-- actor 'system' because audit_log.actor only allowed owner/agent/system.
-- Existing rows are unaffected (every old value stays allowed).

alter table audit_log drop constraint audit_log_actor_check;
alter table audit_log add constraint audit_log_actor_check
  check (actor in ('owner', 'agent', 'system', 'operator'));

-- Chronological order inside one transaction. created_at is now(), which is identical for every
-- entry written in the same transaction, so per-task history needs a tiebreaker that follows
-- insertion order. Existing rows get values assigned by the identity rewrite.
alter table audit_log add column seq bigint generated always as identity;
create index audit_log_tenant_task_order_idx on audit_log (tenant_id, task_id, created_at, seq) where task_id is not null;
