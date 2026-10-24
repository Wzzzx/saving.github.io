'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Client } = require('../supabase.js');
const C = require('../core.js');
const key = 'savin_key_' + 'a'.repeat(43); // Public test fixture, never a real credential.
function memory() {
  const values = new Map();
  return { getItem: k => values.get(k) ?? null, setItem: (k, v) => values.set(k, v), removeItem: k => values.delete(k) };
}
test('key session persists, scopes the cache, uses headers and never requests a password token', async () => {
  const storage = memory(), calls = [];
  const request = async (url, options) => {
    calls.push({ url, options });
    const body = JSON.parse(options.body);
    if (body.p_action === 'profile') return new Response(JSON.stringify({ user: { id: 'alice' }, key_id: 'key-id', expires_at: '2027-10-24' }));
    if (body.p_action === 'read_book') return new Response('null');
    return new Response(JSON.stringify({ revision: body.p_args.p_revision }));
  };
  const client = new Client(storage, request);
  await client.loginKey(' ' + key + ' ');
  const reopened = new Client(storage, request);
  assert.match(reopened.syncKey(), /:alice$/);
  await reopened.read(); await reopened.write(C.initial(), C.id());
  assert.equal(calls.length, 3);
  for (const call of calls) {
    assert.ok(call.url.endsWith('/rpc/key_access'));
    assert.equal(call.options.headers['X-Savin-Key'], key);
    assert.equal(call.options.headers.Authorization, undefined);
    assert.equal(call.options.body.includes(key), false);
  }
  await reopened.logout();
  assert.equal(storage.getItem(reopened.sessionKey()), null);
  assert.equal(calls.length, 3);
});
test('invalid or revoked keys do not replace the existing session', async () => {
  const storage = memory(); let calls = 0;
  const client = new Client(storage, async () => { calls++; return new Response('{}', { status: 401 }); });
  client.remember({ user: { id: 'alice' }, access_token: 'old', refresh_token: 'refresh', expires_in: 3600 });
  await assert.rejects(client.loginKey('sb_publishable_wrong'), /个人 API Key/);
  assert.equal(calls, 0);
  await assert.rejects(client.loginKey(key), /已撤销/);
  assert.equal(client.session.access_token, 'old');
  assert.equal(new Client(storage).session.access_token, 'old');
});
test('failed local credential persistence never reports a connected session', async () => {
  const storage = memory(); storage.setItem = () => { throw new Error('quota'); };
  const client = new Client(storage, async () => new Response(JSON.stringify({ user: { id: 'alice' }, key_id: 'test' })));
  await assert.rejects(client.loginKey(key), /quota/);
  assert.equal(client.session, null);
});
