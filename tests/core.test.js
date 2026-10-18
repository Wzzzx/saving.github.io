'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../core.js');
function rule(overrides = {}) {
  return { id: 'rent', versions: [{ name: '房租', amount: 120000, tags: ['home'], payment: 'cash', cycle: 'monthly', day: 8, start: '2026-01-01', from: '2026-01-01', at: '09:00', ...overrides }] };
}
function state(r = rule()) { return { ...C.initial(), rules: [r] }; }
test('amounts are exact cents and invalid precision is rejected', () => {
  assert.equal(C.parseAmount('0.01'), 1);
  assert.equal(C.parseAmount('12.3'), 1230);
  assert.equal(C.parseAmount(' 100 '), 10000);
  assert.equal(C.parseAmount('0.1') + C.parseAmount('0.2'), 30);
  for (const value of ['0', '-1', '1.001', '', '1e3', 'Infinity', '9007199254740991']) assert.throws(() => C.parseAmount(value));
});
test('monthly missed dates respect start date and due time', () => {
  const data = state();
  assert.deepEqual(C.pending(data, new Date('2026-03-08T08:59:00')).map(e => e.time), ['2026-02-08T09:00', '2026-01-08T09:00']);
  assert.equal(C.pending(data, new Date('2026-03-08T09:00:00')).length, 3);
  assert.equal(C.pending(state(rule({ start: '2026-02-10' })), new Date('2026-03-08T10:00:00')).length, 1);
});
test('daily and weekly dates include leap day and cross year boundaries', () => {
  const daily = state(rule({ cycle: 'daily', start: '2024-02-28', from: '2024-02-28' }));
  assert.deepEqual(C.pending(daily, new Date('2024-03-01T10:00:00')).map(e => e.time.slice(0, 10)), ['2024-03-01', '2024-02-29', '2024-02-28']);
  const weekly = state(rule({ cycle: 'weekly', day: 0, start: '2025-12-28', from: '2025-12-28' }));
  assert.deepEqual(C.pending(weekly, new Date('2026-01-05T10:00:00')).map(e => e.time.slice(0, 10)), ['2026-01-04', '2025-12-28']);
});
test('only selected occurrences fill, repeated fills and deletion never recreate them', () => {
  const data = state(), now = new Date('2026-03-09T10:00:00');
  const selected = C.pending(data, now).slice(0, 1);
  C.fill(data, selected); C.fill(data, selected);
  assert.equal(data.entries.length, 1);
  assert.equal(C.pending(data, now).length, 2);
  data.entries = [];
  assert.equal(C.pending(data, now).length, 2);
});
test('revision uses old price before today, new price from today, and replaces same-day changes', () => {
  const r = rule({ cycle: 'daily', start: '2026-03-06', from: '2026-03-06' });
  C.revise(r, { ...r.versions[0], amount: 200 }, '2026-03-08');
  C.revise(r, { ...r.versions.at(-1), amount: 300 }, '2026-03-08');
  assert.equal(r.versions.length, 2);
  const pending = C.pending(state(r), new Date('2026-03-09T10:00:00'));
  assert.deepEqual(pending.map(e => e.amount), [300, 300, 120000, 120000]);
  r.stopped = '2026-03-09';
  assert.deepEqual(C.pending(state(r), new Date('2026-03-12T10:00:00')).map(e => e.amount), [300, 120000, 120000]);
});
test('future rules revised before start do not leave future duplicate versions', () => {
  const r = rule({ start: '2026-12-01', from: '2026-12-01' });
  C.revise(r, { ...r.versions[0], amount: 500 }, '2026-10-18');
  assert.equal(r.versions.length, 1);
  assert.equal(C.pending(state(r), new Date('2026-11-01T10:00:00')).length, 0);
});
test('multi-tag filtering counts each entry once and respects month and payment', () => {
  const data = C.initial();
  data.entries = [
    { id: 'a', time: '2026-10-01T12:00', amount: 1234, tags: ['food', 'home'], payment: 'cash' },
    { id: 'b', time: '2026-10-02T12:00', amount: 200, tags: ['food'], payment: 'card' },
    { id: 'c', time: '2026-09-01T12:00', amount: 500, tags: ['food'], payment: 'cash' }
  ];
  assert.equal(C.filtered(data, '2026-10').reduce((sum, e) => sum + e.amount, 0), 1434);
  assert.equal(C.filtered(data, '2026-10', 'food', 'cash').length, 1);
  assert.equal(C.filtered(data, '2026-10', 'home')[0].id, 'a');
});
test('successful persistence round-trips and failure leaves original state untouched', () => {
  const data = C.initial();
  let raw;
  const storage = { getItem: () => raw ?? null, setItem: (key, value) => { raw = value; } };
  const saved = C.commit(storage, data, next => { next.lastPayment = 'test'; });
  assert.equal(C.read(storage).lastPayment, saved.lastPayment);
  assert.notEqual(data.lastPayment, 'test');
  assert.throws(() => C.commit({ setItem: () => { throw new Error('quota'); } }, data, next => { next.entries.push({ id: 'test', amount: 1, tags: [], payment: 'cash', time: '2026-10-18T12:00' }); }));
  assert.equal(data.entries.length, 0);
});
test('corrupt data is rejected without writing over it', () => {
  for (const raw of ['{bad', '{}', '{"version":2}', JSON.stringify({ ...C.initial(), rules: [{ id: 'x', versions: [{}] }] })]) {
    let wrote = false;
    assert.throws(() => C.read({ getItem: () => raw, setItem: () => { wrote = true; } }));
    assert.equal(wrote, false);
  }
});
