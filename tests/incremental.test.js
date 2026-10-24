'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../core.js');
const { Client, diff } = require('../supabase.js');
const { Store } = require('../storage.js');
function setup() {
  const map = new Map();
  const storage = { getItem: k => map.get(k) ?? null, setItem: (k, v) => map.set(k, v), removeItem: k => map.delete(k) };
  const initial = C.initial();
  initial.entries.push({ id: C.id(), amount: 123, time: '2026-10-24T12:00', payment: initial.lastPayment, tags: [], note: 'original' });
  const server = { row: { payload: initial, revision: C.id() }, calls: [], loseResponse: false };
  const request = async (url, options) => {
    if (url.endsWith('/read_book')) return new Response(JSON.stringify(server.row));
    const body = JSON.parse(options.body); server.calls.push(body);
    if (body.p_revision !== server.row.revision) {
      if (body.p_base !== server.row.revision) return new Response(JSON.stringify({ message: '版本冲突' }), { status: 409 });
      for (const name of ['tags', 'payments', 'entries', 'rules', 'processed']) {
        const change = body.p_changes[name]; if (!change) continue;
        const key = value => name === 'processed' ? value : value.id;
        const rows = new Map(server.row.payload[name].map(value => [key(value), value]));
        change.remove.forEach(id => rows.delete(id));
        change.upsert.forEach(value => rows.set(key(value), value));
        server.row.payload[name] = [...rows.values()];
      }
      if ('lastPayment' in body.p_changes) server.row.payload.lastPayment = body.p_changes.lastPayment;
      server.row.revision = body.p_revision;
    }
    if (server.loseResponse) { server.loseResponse = false; throw new TypeError('Failed to fetch'); }
    return new Response(JSON.stringify({ revision: body.p_revision }));
  };
  const client = () => {
    const c = new Client(storage, request);
    c.remember({ user: { id: 'alice' }, access_token: 'test', refresh_token: 'test', expires_in: 3600 });
    return c;
  };
  return { storage, server, client };
}
test('single edit uploads one row; deletion does not rewrite following rows or configuration', () => {
  const before = C.initial();
  for (let i = 0; i < 1500; i++) before.entries.push({ id: C.id(), amount: 100, time: '2026-10-24T12:00', tags: [], payment: before.lastPayment });
  const after = structuredClone(before); after.entries[800].amount = 101;
  assert.deepEqual(diff(before, after), { entries: { upsert: [after.entries[800]], remove: [] } });
  after.entries.splice(800, 1);
  assert.deepEqual(diff(before, after), { entries: { upsert: [], remove: [before.entries[800].id] } });
  const reorderedKeys = JSON.parse(JSON.stringify(before), (k, v) => k === 'entries' ? v.map(row => Object.fromEntries(Object.entries(row).reverse())) : v);
  assert.deepEqual(diff(before, reorderedKeys), {});
});
test('lost response survives reopening and replays before later edits without duplicates', async () => {
  const f = setup(); const client = f.client(); const row = await client.read();
  const next = structuredClone(row.payload); next.entries[0].amount = 200;
  f.server.loseResponse = true;
  await assert.rejects(client.write(next, C.id()), /无法连接云端/);
  const newer = structuredClone(next); newer.entries.push({ ...next.entries[0], id: C.id(), amount: 300 });
  await f.client().write(newer, C.id());
  assert.deepEqual(f.server.calls[0], f.server.calls[1]);
  assert.equal(f.server.calls[2].p_changes.entries.upsert.length, 1);
  assert.deepEqual(f.server.row.payload, newer);
  assert.equal(JSON.parse(f.storage.getItem(client.syncKey())).pending, undefined);
});
test('conflict retains local edits and refuses to overwrite another device', async () => {
  const f = setup(), client = f.client(), row = await client.read();
  const store = new Store(f.storage, client); store.bind(); store.put(row.payload, false, row.revision);
  f.server.row.revision = C.id(); f.server.row.payload.entries[0].amount = 999;
  store.commit(store.read(), data => { data.entries[0].amount = 200; });
  await assert.rejects(store.running, /版本冲突/);
  assert.equal(store.snapshot().dirty, true);
  assert.equal(store.read().entries[0].amount, 200);
  assert.equal(f.server.row.payload.entries[0].amount, 999);
});
test('failed durable queue write sends no request; failed acknowledgement persistence safely retries', async () => {
  const f = setup(), client = f.client(), row = await client.read();
  const next = structuredClone(row.payload); next.entries[0].amount = 200;
  const setItem = f.storage.setItem;
  f.storage.setItem = () => { throw new Error('quota'); };
  await assert.rejects(client.write(next, C.id()), /quota/);
  assert.equal(f.server.calls.length, 0);
  f.storage.setItem = (k, v) => { if (!JSON.parse(v).pending) throw new Error('quota'); setItem(k, v); };
  const revision = C.id();
  await assert.rejects(client.write(next, revision), /quota/);
  f.storage.setItem = setItem;
  await f.client().write(next, revision);
  assert.deepEqual(f.server.calls[0], f.server.calls[1]);
  assert.deepEqual(f.server.row.payload, next);
});
test('sync baseline is scoped to both account and project', async () => {
  const f = setup(), client = f.client(); await client.read();
  const alice = client.syncKey();
  client.session.user.id = 'bob'; assert.equal(f.storage.getItem(client.syncKey()), null);
  client.session.user.id = 'alice'; client.config = { ...client.config, url: 'https://other.supabase.co' };
  assert.equal(f.storage.getItem(client.syncKey()), null);
  assert.ok(f.storage.getItem(alice));
});
