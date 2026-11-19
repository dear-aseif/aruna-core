-- Auth sessions (task 2.2). Design "Auth and operations contract" and §2.9.
--
-- Auth.js runs with DATABASE sessions, so revoking a row ends the session. `profiles` (0002)
-- already plays the Auth.js "user" table (one login, one tenant, argon2id hash); no accounts
-- or verification-token tables exist because there is no OAuth/email sign-in and no signup.
--
-- Column shape follows the Auth.js sessions table (token, user, expiry), with three
-- deliberate differences: the token is stored as a SHA-256 hash (a database read never
-- yields a usable cookie value; design §2.9 also says session tokens are never exported),
-- the row carries tenant_id (bound to the profile by a composite foreign key, so a session
-- can never point at a profile of another tenant), and revocation is a timestamp rather
-- than a delete (the row stays as evidence).

create table sessions (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references tenants (id) on delete restrict,
  user_id            uuid not null,
  session_token_hash text not null check (session_token_hash ~ '^[0-9a-f]{64}$'),
  expires_at         timestamptz not null,
  revoked_at         timestamptz,
  created_at         timestamptz not null default now(),
  foreign key (tenant_id, user_id) references profiles (tenant_id, user_id) on delete restrict
);
create unique index sessions_token_hash_key on sessions (session_token_hash);
create index sessions_tenant_user_idx on sessions (tenant_id, user_id);

select aruna_enable_tenant_rls('sessions');

do $$
declare
  app_role text := current_setting('aruna.app_role');
  svc_role text := current_setting('aruna.service_role');
begin
  -- Session bootstrap lookup: before the tenant is known, the app role may read only the
  -- single session whose token hash equals the transaction-local app.session_token_hash.
  -- No setting means no row. The tenant is then taken from that row, never from the client.
  execute format(
    'create policy sessions_token_lookup on sessions for select to %I using (session_token_hash = nullif(current_setting(''app.session_token_hash'', true), ''''))',
    app_role);

  execute 'revoke all on sessions from public';
  -- No DELETE for anyone: sessions are revoked (revoked_at), not removed.
  execute format('grant select, insert, update on sessions to %I, %I', app_role, svc_role);
end $$;
