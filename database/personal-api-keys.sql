-- Personal credentials are separate from the public Supabase publishable key.
create schema savin_private;
revoke all on schema savin_private from public;
create role savin_key_gateway nologin nosuperuser nocreatedb nocreaterole noinherit nobypassrls;
-- Hosted Supabase owns auth; inherit its standard authenticated schema access.
grant authenticated to savin_key_gateway with inherit true;
alter role savin_key_gateway inherit;
grant savin_key_gateway to postgres;
grant usage on schema savin_private, savin, auth to savin_key_gateway;
grant execute on function auth.uid() to savin_key_gateway;

create table savin_private.api_keys (
 id uuid primary key default gen_random_uuid(),
 user_id uuid not null references auth.users(id) on delete cascade,
 key_hash bytea not null unique check (octet_length(key_hash) = 32),
 prefix text not null,
 label text not null,
 created_at timestamptz not null default now(),
 expires_at timestamptz not null default (now() + interval '365 days'),
 revoked_at timestamptz
);
create index api_keys_user_idx on savin_private.api_keys(user_id);
alter table savin_private.api_keys enable row level security;
revoke all on savin_private.api_keys from public, anon, authenticated;
grant select on savin_private.api_keys to savin_key_gateway;
create policy gateway_lookup on savin_private.api_keys for select to savin_key_gateway using (true);
grant select, insert, update, delete on savin.book_state to savin_key_gateway;
create policy key_owner on savin.book_state for all to savin_key_gateway using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
grant select, insert, update, delete on savin.entries to savin_key_gateway;
create policy key_owner on savin.entries for all to savin_key_gateway using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
grant usage on sequence savin.entries_position_seq to savin_key_gateway;
grant select, insert, update, delete on savin.tags to savin_key_gateway;
create policy key_owner on savin.tags for all to savin_key_gateway using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
grant usage on sequence savin.tags_position_seq to savin_key_gateway;
grant select, insert, update, delete on savin.payments to savin_key_gateway;
create policy key_owner on savin.payments for all to savin_key_gateway using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
grant usage on sequence savin.payments_position_seq to savin_key_gateway;
grant select, insert, update, delete on savin.rules to savin_key_gateway;
create policy key_owner on savin.rules for all to savin_key_gateway using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
grant usage on sequence savin.rules_position_seq to savin_key_gateway;
grant select, insert, update, delete on savin.processed to savin_key_gateway;
create policy key_owner on savin.processed for all to savin_key_gateway using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
grant usage on sequence savin.processed_position_seq to savin_key_gateway;
grant execute on function savin.read_book(), savin.apply_changes(uuid, uuid, jsonb) to savin_key_gateway;

create function savin_private.key_request(p_action text, p_args jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
 secret text := coalesce(nullif(current_setting('request.headers', true), '')::jsonb->>'x-savin-key', '');
 key_row savin_private.api_keys;
 previous_sub text := current_setting('request.jwt.claim.sub', true);
 previous_claims text := current_setting('request.jwt.claims', true);
 result jsonb;
begin
 if secret !~ '^savin_key_[A-Za-z0-9_-]{43}$' then
  raise sqlstate 'PT401' using message = '个人 API Key 无效或已失效';
 end if;
 select * into key_row from savin_private.api_keys
 where key_hash = pg_catalog.sha256(pg_catalog.convert_to(secret, 'UTF8'))
 and revoked_at is null and expires_at > now();
 if not found then raise sqlstate 'PT401' using message = '个人 API Key 无效或已失效'; end if;
 -- The caller cannot choose the owner. Replace both claim forms only for this call.
 perform set_config('request.jwt.claim.sub', key_row.user_id::text, true);
 perform set_config('request.jwt.claims', jsonb_build_object('sub', key_row.user_id, 'role', 'authenticated')::text, true);
 if p_action = 'profile' then
  result := jsonb_build_object('user', jsonb_build_object('id', key_row.user_id), 'key_id', key_row.id, 'expires_at', key_row.expires_at);
 elsif p_action = 'read_book' then
  result := savin.read_book();
 elsif p_action = 'apply_changes' then
  result := savin.apply_changes((p_args->>'p_base')::uuid, (p_args->>'p_revision')::uuid, p_args->'p_changes');
 else
  raise sqlstate 'PT400' using message = '不支持的个人密钥操作';
 end if;
 perform set_config('request.jwt.claim.sub', coalesce(previous_sub, ''), true);
 perform set_config('request.jwt.claims', coalesce(previous_claims, ''), true);
 return result;
 -- An error rolls back the local claim changes along with the statement.
end;
$$;
-- The definer has no BYPASSRLS and does not own any business tables.
grant create on schema savin_private to savin_key_gateway;
alter function savin_private.key_request(text, jsonb) owner to savin_key_gateway;
revoke create on schema savin_private from savin_key_gateway;
revoke all on function savin_private.key_request(text, jsonb) from public;

create function savin.key_access(p_action text, p_args jsonb default '{}'::jsonb)
returns jsonb language sql security invoker set search_path = '' as $$
 select savin_private.key_request(p_action, p_args);
$$;
revoke all on function savin.key_access(text, jsonb) from public;
grant usage on schema savin, savin_private to anon, authenticated;
grant execute on function savin_private.key_request(text, jsonb), savin.key_access(text, jsonb) to anon, authenticated;
notify pgrst, 'reload schema';
