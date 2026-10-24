create schema savin;
revoke all on schema savin from public, anon;
grant usage on schema savin to authenticated;
create table savin.ledgers (
 user_id uuid primary key references auth.users(id) on delete cascade,
 payload jsonb not null check (
   jsonb_typeof(payload) = 'object'
   and payload @> '{"version":1}'
   and coalesce(jsonb_typeof(payload->'entries') = 'array', false)
   and coalesce(jsonb_typeof(payload->'tags') = 'array', false)
   and coalesce(jsonb_typeof(payload->'payments') = 'array', false)
   and coalesce(jsonb_typeof(payload->'rules') = 'array', false)
   and coalesce(jsonb_typeof(payload->'processed') = 'array', false)
 ),
 revision uuid not null,
 updated_at timestamptz not null default now()
);
alter table savin.ledgers enable row level security;
revoke all on savin.ledgers from public, anon, authenticated;
grant select, insert, update on savin.ledgers to authenticated;
create policy ledger_select on savin.ledgers for select to authenticated using ((select auth.uid()) = user_id);
create policy ledger_insert on savin.ledgers for insert to authenticated with check ((select auth.uid()) = user_id);
create policy ledger_update on savin.ledgers for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create function savin.touch_ledger() returns trigger language plpgsql security invoker set search_path = '' as $$
begin
 new.updated_at = clock_timestamp();
 return new;
end;
$$;
revoke all on function savin.touch_ledger() from public, anon, authenticated;
create trigger ledger_updated_at before insert or update on savin.ledgers for each row execute function savin.touch_ledger();
-- Existing exposed schemas verified through PostgREST before this deployment.
alter role authenticator set pgrst.db_schemas = 'public, graphql_public, savin';
notify pgrst, 'reload config';
notify pgrst, 'reload schema';
