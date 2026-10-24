'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../core.js');
const { Store } = require('../storage.js');
const { Client } = require('../supabase.js');
function memory() {
  const map = new Map();
  return { getItem: key => map.get(key) ?? null, setItem: (key, value) => map.set(key, value), removeItem: key => map.delete(key) };
}
test('network failures explain connectivity without losing the session or pending ledger', async () => {
  const storage = memory();
  const client = new Client(storage, async () => { throw new TypeError('Failed to fetch'); });
  client.remember({ user: { id: 'alice' }, access_token: 'token', refresh_token: 'refresh', expires_in: 3600 });
  const store = new Store(storage, client);
  store.bind(); store.put(C.initial(), true);
  const before = storage.getItem(store.key);
  await assert.rejects(store.sync(), /无法连接云端/);
  assert.equal(storage.getItem(store.key), before);
  assert.equal(client.session.user.id, 'alice');
  assert.match(store.status, /本地数据已保留/);
  client.request = async () => new Response(JSON.stringify({ msg: 'Invalid login credentials' }), { status: 400 });
  await assert.rejects(client.login('test@example.com', 'incorrect'), /Invalid login credentials/);
});
function fixture() {
  const storage = memory(), uploaded = [];
  const client = { config: { url: 'https://test.supabase.co' }, session: { user: { id: 'alice' } }, read: async () => null,
    write: async (payload, revision) => { uploaded.push({ payload: structuredClone(payload), revision }); } };
  const store = new Store(storage, client);
  return { storage, client, store, uploaded };
}
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
test('legacy snapshot migrates intact, retries after reopening, then stays cached', async () => {
  const f = fixture(), original = C.initial();
  original.entries.push({ id: C.id(), amount: 1234, time: '2026-10-24T09:00', tags: [original.tags[0].id], payment: original.payments[0].id, note: '午饭' });
  original.processed.push('rule:2026-10-24');
  original.tags[0].active = false;
  f.storage.setItem(C.KEY, JSON.stringify(original)); f.store.bind();
  const write = f.client.write;
  f.client.write = async () => { throw new Error('offline'); };
  await assert.rejects(f.store.sync(true), /offline/);
  assert.equal(f.store.snapshot().dirty, true);
  f.client.write = write;
  const reopened = new Store(f.storage, f.client); reopened.bind(); await reopened.sync(true);
  assert.deepEqual(f.uploaded[0].payload, original);
  assert.deepEqual(reopened.read(), original);
  assert.equal(reopened.snapshot().dirty, false);
  assert.equal('_sync' in reopened.read(), false);
  await reopened.sync(); assert.equal(f.uploaded.length, 1);
});
test('edit during upload is uploaded afterwards, old response cannot clear new revision', async () => {
  const f = fixture(); f.store.bind(); f.store.put(C.initial(), true);
  const first = deferred(), second = deferred(); let writes = 0;
  f.client.write = async payload => { f.uploaded.push(structuredClone(payload)); await (++writes === 1 ? first.promise : second.promise); };
  const sync = f.store.sync();
  f.store.commit(f.store.read(), next => { next.lastPayment = 'changed'; });
  first.resolve(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.store.snapshot().dirty, true);
  assert.equal(f.uploaded.length, 2);
  assert.equal(f.uploaded[1].lastPayment, 'changed');
  second.resolve(); await sync; assert.equal(f.store.snapshot().dirty, false);
});
test('local storage failure leaves current data unchanged and does not upload', () => {
  const f = fixture(), data = C.initial();
  f.storage.setItem = () => { throw new Error('quota'); };
  assert.throws(() => f.store.commit(data, next => { next.entries = []; next.lastPayment = 'x'; }), /quota/);
  assert.notEqual(data.lastPayment, 'x'); assert.equal(f.uploaded.length, 0);
});
test('missing cache and failed cloud read never permits an empty overwrite', async () => {
  const f = fixture(); f.store.bind(); f.client.read = async () => { throw new Error('offline'); };
  await assert.rejects(f.store.sync(true));
  assert.equal(f.store.snapshot(), null);
  assert.throws(() => f.store.commit(C.initial(), () => {}), /读取云端/);
  assert.equal(f.uploaded.length, 0);
});
test('a cached edit made during remote read wins over stale remote payload', async () => {
  const f = fixture(), read = deferred(); f.store.bind(); f.store.put(C.initial(), false);
  const remote = f.store.read(); f.client.read = () => read.promise;
  const sync = f.store.sync(true);
  f.store.commit(f.store.read(), next => { next.lastPayment = 'new'; });
  read.resolve({ payload: remote, revision: C.id() }); await sync;
  assert.equal(f.store.read().lastPayment, 'new'); assert.equal(f.uploaded[0].payload.lastPayment, 'new');
});
test('logout preserves pending data and account/project changes never upload it to another owner', async () => {
  const f = fixture(); f.store.bind(); const aliceKey = f.store.key; f.store.put(C.initial(), true);
  f.client.session = null; await f.store.sync(); assert.equal(f.uploaded.length, 0);
  f.client.session = { user: { id: 'bob' } }; f.store.bind();
  assert.equal(f.store.snapshot(), null); assert.notEqual(f.store.key, aliceKey);
  assert.equal(JSON.parse(f.storage.getItem(aliceKey))._sync.dirty, true);
  f.client.session = { user: { id: 'alice' } }; f.store.bind(); await f.store.sync();
  assert.equal(f.uploaded.length, 1);
  f.client.config.url = 'https://other.supabase.co'; await f.store.sync(); assert.equal(f.uploaded.length, 1);
});
test('invalid local or remote payload is preserved/rejected instead of overwritten', async () => {
  const f = fixture(); f.storage.setItem(C.KEY, '{broken');
  assert.throws(() => f.store.bind()); assert.equal(f.storage.getItem(C.KEY), '{broken');
  f.storage.removeItem(C.KEY); f.store.bind(); f.client.read = async () => ({ payload: {}, revision: C.id() });
  await assert.rejects(f.store.sync(true)); assert.equal(f.store.snapshot(), null);
});
test('client refreshes session once, uses user token and schema headers, verifies writes', async () => {
  const storage = memory(), calls = [], user = { id: C.id() };
  const client = new Client(storage, async (url, options) => {
    calls.push({ url, options });
    if (url.includes('/token')) return new Response(JSON.stringify({ user, access_token: 'fresh', refresh_token: 'rotated', expires_in: 3600 }));
    if (url.endsWith('/read_book')) return new Response('null');
    return new Response(JSON.stringify({ revision: JSON.parse(options.body).p_revision }));
  });
  client.remember({ user, access_token: 'old', refresh_token: 'refresh', expires_at: 1 });
  await Promise.all([client.token(), client.token()]);
  assert.equal(calls.length, 1); assert.equal(client.session.access_token, 'fresh');
  await client.read(); await client.write(C.initial(), C.id());
  assert.equal(calls[1].options.headers['Accept-Profile'], 'savin');
  assert.equal(calls[2].options.headers.Authorization, 'Bearer fresh');
  assert.equal(calls[2].options.headers['Content-Profile'], 'savin');
  assert.throws(() => client.configure(client.config.url, 'sb_secret_bad'), /公开密钥/);
  client.request = async () => new Response('[]');
  await assert.rejects(client.write(C.initial(), C.id()), /确认/);
});
