-- Run with an administrator connection. All ledger changes are rolled back.
begin;
select set_config('request.jwt.claim.sub', (select user_id::text from savin.ledgers limit 1), true);
set local role authenticated;
do $$
declare before jsonb; after jsonb; changes jsonb; entry jsonb; old_revision uuid; new_revision uuid := gen_random_uuid(); changed_count integer;
begin
 before := savin.read_book();
 if before->'payload' is distinct from (select payload from savin.ledgers where user_id = auth.uid()) then raise exception 'migration mismatch'; end if;
 old_revision := (before->>'revision')::uuid;
 entry := before->'payload'->'entries'->0;
 entry := jsonb_set(entry, '{amount}', to_jsonb((entry->>'amount')::bigint + 1));
 changes := jsonb_build_object('entries', jsonb_build_object('upsert', jsonb_build_array(entry), 'remove', '[]'::jsonb));
 perform savin.apply_changes(old_revision, new_revision, changes);
 after := savin.read_book();
 if (after->'payload'->'entries'->0->>'amount')::bigint <> (entry->>'amount')::bigint then raise exception 'edit failed'; end if;
 if after->'payload'->'tags' is distinct from before->'payload'->'tags' then raise exception 'unrelated data changed'; end if;
 perform savin.apply_changes(old_revision, new_revision, changes);
 if savin.read_book() is distinct from after then raise exception 'replay mismatch'; end if;
 begin
  perform savin.apply_changes(old_revision, gen_random_uuid(), changes);
  raise exception 'stale write accepted';
 exception when sqlstate 'PT409' then null;
 end;
 begin
  update savin.ledgers set revision = gen_random_uuid() where user_id = auth.uid();
  raise exception 'old client accepted';
 exception when sqlstate 'PT409' then null;
 end;
 begin
  changes := jsonb_build_object('tags', jsonb_build_object('upsert', jsonb_build_array(jsonb_build_object('id', gen_random_uuid(), 'name', 'rollback-only', 'active', true))), 'entries', jsonb_build_object('upsert', jsonb_build_array(jsonb_set(entry, '{amount}', '-1'))));
  perform savin.apply_changes(new_revision, gen_random_uuid(), changes);
  raise exception 'invalid amount accepted';
 exception when check_violation then null;
 end;
 if savin.read_book() is distinct from after then raise exception 'partial transaction committed'; end if;
 update savin.entries set amount = 1 where user_id <> auth.uid();
 get diagnostics changed_count = row_count;
 if changed_count <> 0 then raise exception 'cross-owner update allowed'; end if;
 begin
  insert into savin.entries(user_id, id, amount, time, payment, tags) values(gen_random_uuid(), gen_random_uuid(), 1, '2026-10-24T12:00', '', '[]');
  raise exception 'cross-owner insert accepted';
 exception when insufficient_privilege then null;
 end;
end $$;
set local role anon;
do $$ begin
 begin perform savin.read_book(); raise exception 'anonymous read accepted'; exception when insufficient_privilege then null; end;
end $$;
rollback;
