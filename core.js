(function (root) {
  'use strict';
  const KEY = 'saving.v1';
  const id = () => globalThis.crypto.randomUUID();
  const pad = n => String(n).padStart(2, '0');
  const dateKey = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const localTime = (d = new Date()) => `${dateKey(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const money = cents => (cents / 100).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  function parseAmount(value) {
    const s = String(value).trim();
    if (!/^\d+(?:\.\d{1,2})?$/.test(s)) throw new Error('请输入大于 0、最多两位小数的金额');
    const [whole, fraction = ''] = s.split('.');
    const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
    if (!Number.isSafeInteger(cents) || cents <= 0) throw new Error('金额需大于 0，且不能过大');
    return cents;
  }
  function initial() {
    const tags = ['餐饮', '交通', '购物', '房租', '生活', '娱乐'].map(name => ({ id: id(), name, active: true }));
    const payments = ['微信', '支付宝', '现金', '银行卡'].map(name => ({ id: id(), name, active: true }));
    return { version: 1, tags, payments, entries: [], rules: [], processed: [], lastPayment: payments[0].id };
  }
  function validate(data) {
    if (!data || data.version !== 1 || !['tags', 'payments', 'entries', 'rules', 'processed'].every(k => Array.isArray(data[k]))) throw new Error('本地数据无法读取，请先导出备份；现有数据未被覆盖');
    for (const item of [...data.tags, ...data.payments]) {
      if (typeof item.id !== 'string' || typeof item.name !== 'string' || typeof item.active !== 'boolean') throw new Error('本地配置格式异常，现有数据未被覆盖');
    }
    for (const e of data.entries) {
      if (typeof e.id !== 'string' || !Number.isSafeInteger(e.amount) || e.amount <= 0 || typeof e.time !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(e.time) || !Array.isArray(e.tags) || typeof e.payment !== 'string') throw new Error('账目格式异常，现有数据未被覆盖');
    }
    for (const r of data.rules) {
      if (typeof r.id !== 'string' || !Array.isArray(r.versions) || !r.versions.length) throw new Error('固定支出格式异常，现有数据未被覆盖');
      for (const v of r.versions) {
        if (!['daily', 'weekly', 'monthly'].includes(v.cycle) || !Number.isSafeInteger(v.amount) || v.amount <= 0 || !Array.isArray(v.tags) || typeof v.payment !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v.from) || !/^\d{4}-\d{2}-\d{2}$/.test(v.start) || !/^\d{2}:\d{2}$/.test(v.at) || (v.cycle === 'monthly' && (!Number.isInteger(v.day) || v.day < 1 || v.day > 28)) || (v.cycle === 'weekly' && (!Number.isInteger(v.day) || v.day < 0 || v.day > 6))) throw new Error('固定支出配置异常，现有数据未被覆盖');
      }
    }
    return data;
  }
  function read(storage) {
    const raw = storage.getItem(KEY);
    return raw === null ? initial() : validate(JSON.parse(raw));
  }
  function commit(storage, current, change) {
    const next = structuredClone(current);
    change(next);
    validate(next);
    storage.setItem(KEY, JSON.stringify(next));
    return next;
  }
  function pending(data, now = new Date()) {
    const today = dateKey(now);
    const done = new Set(data.processed);
    const result = [];
    for (const rule of data.rules) {
      rule.versions.forEach((v, i) => {
        const from = v.start > v.from ? v.start : v.from;
        const until = rule.versions[i + 1]?.from || rule.stopped || '9999-12-31';
        const cursor = new Date(`${from}T12:00:00`);
        for (let date = dateKey(cursor); date <= today && date < until; cursor.setDate(cursor.getDate() + 1), date = dateKey(cursor)) {
          if (v.cycle === 'weekly' && cursor.getDay() !== v.day) continue;
          if (v.cycle === 'monthly' && cursor.getDate() !== v.day) continue;
          const key = `${rule.id}:${date}`;
          const time = `${date}T${v.at}`;
          if (!done.has(key) && time <= localTime(now)) result.push({ key, ruleId: rule.id, name: v.name, amount: v.amount, tags: [...v.tags], payment: v.payment, time });
        }
      });
    }
    return result.sort((a, b) => b.time.localeCompare(a.time));
  }
  function fill(data, selected) {
    const done = new Set(data.processed);
    for (const item of selected) {
      if (done.has(item.key)) continue;
      data.entries.push({ id: id(), amount: item.amount, tags: [...item.tags], payment: item.payment, time: item.time, source: item.key });
      data.processed.push(item.key);
      done.add(item.key);
    }
  }
  function revise(rule, version, today) {
    rule.versions = rule.versions.filter(v => v.from < today);
    rule.versions.push({ ...version, from: today });
  }
  function filtered(data, month, tag = '', payment = '') {
    return data.entries.filter(e => e.time.startsWith(month) && (!tag || e.tags.includes(tag)) && (!payment || e.payment === payment)).sort((a, b) => b.time.localeCompare(a.time));
  }
  const api = { KEY, id, dateKey, localTime, money, parseAmount, initial, validate, read, commit, pending, fill, revise, filtered };
  if (typeof module !== 'undefined') module.exports = api;
  else root.Ledger = api;
})(globalThis);
