-- Additive v2 migration. Keep ledgers as the legacy backup/compatibility source.
create table savin.book_state (
 user_id uuid primary key references auth.users(id) on delete cascade,
 revision uuid, last_payment text not null default '',
 v2_started boolean not null default false,
 updated_at timestamptz not null default now()
);
create table savin.tags (
 user_id uuid not null references auth.users(id) on delete cascade,
 id uuid not null, name text not null, active boolean not null,
 position bigint generated always as identity,
 primary key (user_id, id)
);
create table savin.payments (
 user_id uuid not null references auth.users(id) on delete cascade,
 id uuid not null, name text not null, active boolean not null,
 position bigint generated always as identity,
 primary key (user_id, id)
);
create table savin.entries (
 user_id uuid not null references auth.users(id) on delete cascade,
 id uuid not null, amount bigint not null check (amount > 0 and amount <= 9007199254740991), time text not null check (time ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$'), payment text not null, tags jsonb not null check (jsonb_typeof(tags) = 'array'), note text, source text,
 position bigint generated always as identity,
 primary key (user_id, id)
);
create table savin.rules (
 user_id uuid not null references auth.users(id) on delete cascade,
 id uuid not null, versions jsonb not null check (jsonb_typeof(versions) = 'array' and jsonb_array_length(versions) > 0), stopped text,
 position bigint generated always as identity,
 primary key (user_id, id)
);
create table savin.processed (
 user_id uuid not null references auth.users(id) on delete cascade,
 id text not null,
 position bigint generated always as identity,
 primary key (user_id, id)
);
create index entries_user_time_idx on savin.entries (user_id, time desc);
alter table savin.book_state enable row level security;
revoke all on savin.book_state from public, anon, authenticated;
grant select, insert, update, delete on savin.book_state to authenticated;
create policy owner_select on savin.book_state for select to authenticated using ((select auth.uid()) = user_id);
create policy owner_insert on savin.book_state for insert to authenticated with check ((select auth.uid()) = user_id);
create policy owner_update on savin.book_state for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy owner_delete on savin.book_state for delete to authenticated using ((select auth.uid()) = user_id);
alter table savin.tags enable row level security;
revoke all on savin.tags from public, anon, authenticated;
grant select, insert, update, delete on savin.tags to authenticated;
create policy owner_select on savin.tags for select to authenticated using ((select auth.uid()) = user_id);
create policy owner_insert on savin.tags for insert to authenticated with check ((select auth.uid()) = user_id);
create policy owner_update on savin.tags for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy owner_delete on savin.tags for delete to authenticated using ((select auth.uid()) = user_id);
alter table savin.payments enable row level security;
revoke all on savin.payments from public, anon, authenticated;
grant select, insert, update, delete on savin.payments to authenticated;
create policy owner_select on savin.payments for select to authenticated using ((select auth.uid()) = user_id);
create policy owner_insert on savin.payments for insert to authenticated with check ((select auth.uid()) = user_id);
create policy owner_update on savin.payments for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy owner_delete on savin.payments for delete to authenticated using ((select auth.uid()) = user_id);
alter table savin.entries enable row level security;
revoke all on savin.entries from public, anon, authenticated;
grant select, insert, update, delete on savin.entries to authenticated;
create policy owner_select on savin.entries for select to authenticated using ((select auth.uid()) = user_id);
create policy owner_insert on savin.entries for insert to authenticated with check ((select auth.uid()) = user_id);
create policy owner_update on savin.entries for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy owner_delete on savin.entries for delete to authenticated using ((select auth.uid()) = user_id);
alter table savin.rules enable row level security;
revoke all on savin.rules from public, anon, authenticated;
grant select, insert, update, delete on savin.rules to authenticated;
create policy owner_select on savin.rules for select to authenticated using ((select auth.uid()) = user_id);
create policy owner_insert on savin.rules for insert to authenticated with check ((select auth.uid()) = user_id);
create policy owner_update on savin.rules for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy owner_delete on savin.rules for delete to authenticated using ((select auth.uid()) = user_id);
alter table savin.processed enable row level security;
revoke all on savin.processed from public, anon, authenticated;
grant select, insert, update, delete on savin.processed to authenticated;
create policy owner_select on savin.processed for select to authenticated using ((select auth.uid()) = user_id);
create policy owner_insert on savin.processed for insert to authenticated with check ((select auth.uid()) = user_id);
create policy owner_update on savin.processed for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy owner_delete on savin.processed for delete to authenticated using ((select auth.uid()) = user_id);
grant usage on sequence savin.tags_position_seq to authenticated;
grant usage on sequence savin.payments_position_seq to authenticated;
grant usage on sequence savin.entries_position_seq to authenticated;
grant usage on sequence savin.rules_position_seq to authenticated;
grant usage on sequence savin.processed_position_seq to authenticated;

create function savin.read_book() returns jsonb language sql stable security invoker set search_path = '' as $$
 select jsonb_build_object('revision', s.revision, 'payload', jsonb_build_object(
 'version', 1, 'lastPayment', s.last_payment,
 'tags', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'name', name, 'active', active) order by position), '[]'::jsonb) from savin.tags where user_id = (select auth.uid())),
 'payments', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'name', name, 'active', active) order by position), '[]'::jsonb) from savin.payments where user_id = (select auth.uid())),
 'entries', (select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object('id', id, 'amount', amount, 'time', time, 'payment', payment, 'tags', tags, 'note', note, 'source', source)) order by position), '[]'::jsonb) from savin.entries where user_id = (select auth.uid())),
 'rules', (select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object('id', id, 'versions', versions, 'stopped', stopped)) order by position), '[]'::jsonb) from savin.rules where user_id = (select auth.uid())),
 'processed', (select coalesce(jsonb_agg(to_jsonb(id) order by position), '[]'::jsonb) from savin.processed where user_id = (select auth.uid()))
 )) from savin.book_state s where s.user_id = (select auth.uid()) and s.revision is not null;
$$;

create function savin.apply_changes(p_base uuid, p_revision uuid, p_changes jsonb)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare owner_id uuid := auth.uid(); current_revision uuid;
begin
 if owner_id is null then raise exception '请先登录'; end if;
 if p_revision is null or p_changes is null or jsonb_typeof(p_changes) <> 'object' then raise exception '同步数据格式错误'; end if;
 insert into savin.book_state(user_id) values(owner_id) on conflict do nothing;
 select revision into current_revision from savin.book_state where user_id = owner_id for update;
 -- A response lost after commit is safe to replay.
 if current_revision = p_revision then return jsonb_build_object('revision', p_revision); end if;
 if current_revision is distinct from p_base then
   raise sqlstate 'PT409' using message = '云端已有其他修改，本地数据已保留。请先导出本地备份后处理版本冲突';
 end if;
 delete from savin.tags where user_id = owner_id and id::text in (select jsonb_array_elements_text(coalesce(p_changes->'tags'->'remove', '[]'::jsonb)));
 insert into savin.tags(user_id, id, name, active)
 select owner_id, (v->>'id')::uuid, v->>'name', (v->>'active')::boolean from jsonb_array_elements(coalesce(p_changes->'tags'->'upsert', '[]'::jsonb)) as x(v)
 on conflict (user_id, id) do update set name = excluded.name, active = excluded.active;
 delete from savin.payments where user_id = owner_id and id::text in (select jsonb_array_elements_text(coalesce(p_changes->'payments'->'remove', '[]'::jsonb)));
 insert into savin.payments(user_id, id, name, active)
 select owner_id, (v->>'id')::uuid, v->>'name', (v->>'active')::boolean from jsonb_array_elements(coalesce(p_changes->'payments'->'upsert', '[]'::jsonb)) as x(v)
 on conflict (user_id, id) do update set name = excluded.name, active = excluded.active;
 delete from savin.entries where user_id = owner_id and id::text in (select jsonb_array_elements_text(coalesce(p_changes->'entries'->'remove', '[]'::jsonb)));
 insert into savin.entries(user_id, id, amount, time, payment, tags, note, source)
 select owner_id, (v->>'id')::uuid, (v->>'amount')::bigint, v->>'time', v->>'payment', v->'tags', v->>'note', v->>'source' from jsonb_array_elements(coalesce(p_changes->'entries'->'upsert', '[]'::jsonb)) as x(v)
 on conflict (user_id, id) do update set amount = excluded.amount, time = excluded.time, payment = excluded.payment, tags = excluded.tags, note = excluded.note, source = excluded.source;
 delete from savin.rules where user_id = owner_id and id::text in (select jsonb_array_elements_text(coalesce(p_changes->'rules'->'remove', '[]'::jsonb)));
 insert into savin.rules(user_id, id, versions, stopped)
 select owner_id, (v->>'id')::uuid, v->'versions', v->>'stopped' from jsonb_array_elements(coalesce(p_changes->'rules'->'upsert', '[]'::jsonb)) as x(v)
 on conflict (user_id, id) do update set versions = excluded.versions, stopped = excluded.stopped;
 delete from savin.processed where user_id = owner_id and id::text in (select jsonb_array_elements_text(coalesce(p_changes->'processed'->'remove', '[]'::jsonb)));
 insert into savin.processed(user_id, id)
 select owner_id, v #>> '{}' from jsonb_array_elements(coalesce(p_changes->'processed'->'upsert', '[]'::jsonb)) as x(v)
 on conflict (user_id, id) do nothing;
 update savin.book_state set revision = p_revision, last_payment = case when p_changes ? 'lastPayment' then p_changes->>'lastPayment' else last_payment end, v2_started = true, updated_at = clock_timestamp() where user_id = owner_id;
 return jsonb_build_object('revision', p_revision);
end;
$$;
revoke all on function savin.read_book(), savin.apply_changes(uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function savin.read_book(), savin.apply_changes(uuid, uuid, jsonb) to authenticated;

-- Backfill every account in the same transaction, retaining the source rows.
insert into savin.book_state(user_id, revision, last_payment)
select user_id, revision, coalesce(payload->>'lastPayment', '') from savin.ledgers;
insert into savin.tags(user_id, id, name, active)
select l.user_id, (v->>'id')::uuid, v->>'name', (v->>'active')::boolean from savin.ledgers l cross join lateral jsonb_array_elements(l.payload->'tags') with ordinality as x(v, ord) order by l.user_id, ord;
insert into savin.payments(user_id, id, name, active)
select l.user_id, (v->>'id')::uuid, v->>'name', (v->>'active')::boolean from savin.ledgers l cross join lateral jsonb_array_elements(l.payload->'payments') with ordinality as x(v, ord) order by l.user_id, ord;
insert into savin.entries(user_id, id, amount, time, payment, tags, note, source)
select l.user_id, (v->>'id')::uuid, (v->>'amount')::bigint, v->>'time', v->>'payment', v->'tags', v->>'note', v->>'source' from savin.ledgers l cross join lateral jsonb_array_elements(l.payload->'entries') with ordinality as x(v, ord) order by l.user_id, ord;
insert into savin.rules(user_id, id, versions, stopped)
select l.user_id, (v->>'id')::uuid, v->'versions', v->>'stopped' from savin.ledgers l cross join lateral jsonb_array_elements(l.payload->'rules') with ordinality as x(v, ord) order by l.user_id, ord;
insert into savin.processed(user_id, id)
select l.user_id, v #>> '{}' from savin.ledgers l cross join lateral jsonb_array_elements(l.payload->'processed') with ordinality as x(v, ord) order by l.user_id, ord;

-- Existing deployed clients may continue to write until this account first uses v2.
-- After cutover reject old writes rather than overwrite newer normalized data.
create function savin.mirror_legacy() returns trigger language plpgsql security invoker set search_path = '' as $$
declare state savin.book_state; changes jsonb;
begin
 if new.user_id is distinct from auth.uid() then raise exception '账号不匹配'; end if;
 insert into savin.book_state(user_id) values(new.user_id) on conflict do nothing;
 select * into state from savin.book_state where user_id = new.user_id for update;
 if state.v2_started then raise sqlstate 'PT409' using message = '云端存储已升级，请刷新网页后重试。本地数据已保留'; end if;
 changes := jsonb_build_object('lastPayment', coalesce(new.payload->>'lastPayment', ''),
 'tags', jsonb_build_object('upsert', new.payload->'tags', 'remove', (select coalesce(jsonb_agg(id), '[]'::jsonb) from savin.tags where user_id = new.user_id)),
 'payments', jsonb_build_object('upsert', new.payload->'payments', 'remove', (select coalesce(jsonb_agg(id), '[]'::jsonb) from savin.payments where user_id = new.user_id)),
 'entries', jsonb_build_object('upsert', new.payload->'entries', 'remove', (select coalesce(jsonb_agg(id), '[]'::jsonb) from savin.entries where user_id = new.user_id)),
 'rules', jsonb_build_object('upsert', new.payload->'rules', 'remove', (select coalesce(jsonb_agg(id), '[]'::jsonb) from savin.rules where user_id = new.user_id)),
 'processed', jsonb_build_object('upsert', new.payload->'processed', 'remove', (select coalesce(jsonb_agg(id), '[]'::jsonb) from savin.processed where user_id = new.user_id)));
 -- Old requests can reuse a revision; changes still need to be applied on insert.
 perform savin.apply_changes(state.revision, gen_random_uuid(), changes);
 update savin.book_state set revision = new.revision, v2_started = false where user_id = new.user_id;
 return new;
end;
$$;
revoke all on function savin.mirror_legacy() from public, anon, authenticated;
create trigger mirror_legacy after insert or update on savin.ledgers for each row execute function savin.mirror_legacy();
notify pgrst, 'reload schema';

