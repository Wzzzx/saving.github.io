'use strict';
// Explicit opt-in integration check. Uses a disposable, pre-provisioned user;
// credentials come from the environment and are never printed or committed.
const assert = require('node:assert/strict');
const { Client } = require('../supabase.js');
const C = require('../core.js');
async function main() {
  const email = process.env.SAVIN_TEST_EMAIL, password = process.env.SAVIN_TEST_PASSWORD;
  if (!email || !password) throw new Error('Set SAVIN_TEST_EMAIL and SAVIN_TEST_PASSWORD for a disposable test user');
  const values = new Map();
  const client = new Client({ getItem: k => values.get(k) || null, setItem: (k, v) => values.set(k, v), removeItem: k => values.delete(k) });
  try {
    await client.login(email, password);
    const existing = await client.read();
    if (existing) assert.ok(existing.payload.entries.every(e => e.note === 'Disposable smoke test'), 'only disposable test data may be overwritten');
    const payload = C.initial();
    payload.entries.push({ id: C.id(), amount: 1234, payment: payload.payments[0].id, tags: [payload.tags[0].id], time: '2026-10-24T12:00', note: 'Disposable smoke test' });
    const revision = C.id();
    await client.write(payload, revision);
    assert.deepEqual((await client.read()).payload, payload);
    payload.entries[0].amount = 5678;
    const second = C.id();
    await client.write(payload, second); await client.write(payload, second);
    const read = await client.read();
    assert.equal(read.payload.entries.length, 1); assert.equal(read.payload.entries[0].amount, 5678);
    assert.equal(read.revision, second);
    const token = await client.token();
    await assert.rejects(client.call('/rest/v1/ledgers', {
      method: 'POST', headers: { 'Content-Profile': 'savin' },
      body: JSON.stringify({ user_id: C.id(), payload, revision: C.id() })
    }, token), /row-level security/);
    await assert.rejects(client.call('/rest/v1/ledgers?select=user_id', { headers: { 'Accept-Profile': 'savin' } }), error => error.status === 401 || error.status === 403);
    client.session.expires_at = 1;
    await client.token();
    assert.equal((await client.read()).revision, second);
    console.log('PASS: real Auth login/refresh, schema API insert/update/read, retry idempotency, anonymous and cross-owner write rejection');
  } finally { await client.logout(); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
