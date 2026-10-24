begin;
insert into savin_private.api_keys(user_id,key_hash,prefix,label)
select id,sha256(convert_to('savin_key_'||repeat('a',43),'UTF8')),'test-only','rollback verification' from auth.users where email='wzx10.06@qq.com';
set local role anon;
do $$
declare profile jsonb; snapshot jsonb; after_read jsonb; fake_id uuid := gen_random_uuid(); new_revision uuid := gen_random_uuid();
begin
 perform set_config('request.headers',jsonb_build_object('x-savin-key','savin_key_'||repeat('a',43))::text,true);
 perform set_config('request.jwt.claim.sub',fake_id::text,true);
 profile:=savin.key_access('profile');
 if profile->'user'->>'id'=fake_id::text then raise exception 'caller spoofed owner'; end if;
 snapshot:=savin.key_access('read_book');
 if jsonb_array_length(snapshot->'payload'->'entries')<>23 then raise exception 'unexpected read'; end if;
 if current_setting('request.jwt.claim.sub')<>fake_id::text then raise exception 'claim context leaked'; end if;
 perform savin.key_access('apply_changes', jsonb_build_object('p_base',snapshot->>'revision','p_revision',new_revision,'p_changes',jsonb_build_object('lastPayment',snapshot->'payload'->>'lastPayment'),'user_id',fake_id));
 after_read:=savin.key_access('read_book');
 if after_read->'payload' is distinct from snapshot->'payload' or after_read->>'revision'<>new_revision::text then raise exception 'scoped write failed'; end if;
 begin perform savin.key_access('arbitrary_sql'); raise exception 'unknown action accepted'; exception when sqlstate 'PT400' then null; end;
 perform set_config('request.headers','{}',true);
 begin perform savin.key_access('read_book'); raise exception 'missing key accepted'; exception when sqlstate 'PT401' then null; end;
 begin perform 1 from savin.entries; raise exception 'anon table access'; exception when insufficient_privilege then null; end;
 begin perform 1 from savin_private.api_keys; raise exception 'anon hash access'; exception when insufficient_privilege then null; end;
end $$;
reset role;
update savin_private.api_keys set revoked_at=now() where prefix='test-only';
set local role anon;
do $$ begin
 perform set_config('request.headers',jsonb_build_object('x-savin-key','savin_key_'||repeat('a',43))::text,true);
 begin perform savin.key_access('read_book'); raise exception 'revoked key accepted'; exception when sqlstate 'PT401' then null; end;
end $$;
rollback;
