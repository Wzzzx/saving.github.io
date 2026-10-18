'use strict';
const C = window.Ledger;
const app = document.querySelector('#app');
const dialog = document.querySelector('#backfill');
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const label = (list, id) => list.find(item => item.id === id)?.name || '已删除';
let data, storage, readError = '', rawBackup = '';
let page = 'record', editing = '', editingRule = '';
let month = C.dateKey(new Date()).slice(0, 7), filterTag = '', filterPayment = '';
let draft = { amount: '', tags: [], payment: '', time: C.localTime() };
let toastTimer;
try {
  storage = window.localStorage;
  rawBackup = storage.getItem(C.KEY) || '';
  data = C.read(storage);
  draft.payment = data.payments.find(p => p.active && p.id === data.lastPayment)?.id || data.payments.find(p => p.active)?.id || '';
} catch (error) {
  readError = '无法读取本地数据。现有数据不会被覆盖，请先复制备份。';
}
function toast(message) {
  const el = document.querySelector('#toast');
  el.textContent = message;
  el.classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('visible'), 2400);
}
function errorText(message, target = app) {
  const el = target.querySelector('.form-error');
  if (el) el.textContent = message;
  else toast(message);
}
function save(change, target = app) {
  try {
    data = C.commit(storage, data, change);
    return true;
  } catch (error) {
    errorText('未保存成功，请检查浏览器存储空间或设置。输入内容已保留。', target);
    return false;
  }
}
function heading(title, subtitle = '') {
  return `<div class="heading"><div><p class="eyebrow">DAILY NOTES</p><h1>${title}</h1>${subtitle ? `<p class="subtitle">${subtitle}</p>` : ''}</div></div>`;
}
function chips(list, selected, kind) {
  return `<div class="chips" data-kind="${kind}">${list.filter(item => item.active || selected.includes(item.id)).map(item => `<button type="button" class="chip ${item.active ? '' : 'archived'}" data-id="${esc(item.id)}" aria-pressed="${selected.includes(item.id)}">${esc(item.name)}${item.active ? '' : '（已停用）'}</button>`).join('') || '<p class="notice">请先到设置页添加选项。</p>'}</div>`;
}
function choices(tags, payment) {
  return `<div class="field"><div class="field-title">花在哪里 <small>标签 · 可多选</small></div>${chips(data.tags, tags, 'tags')}</div><div class="field"><div class="field-title">付款方式 <small>单选</small></div>${chips(data.payments, [payment], 'payment')}</div>`;
}
function selected(form, kind) {
  return [...form.querySelectorAll(`[data-kind="${kind}"] [aria-pressed="true"]`)].map(el => el.dataset.id);
}
function bindChips(form) {
  form.querySelectorAll('.chips').forEach(group => group.addEventListener('click', event => {
    const button = event.target.closest('button[data-id]');
    if (!button) return;
    const was = button.getAttribute('aria-pressed') === 'true';
    if (group.dataset.kind === 'payment') group.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', 'false'));
    button.setAttribute('aria-pressed', group.dataset.kind === 'payment' || !was ? 'true' : 'false');
  }));
}
function captureDraft() {
  if (page !== 'record') return;
  const form = app.querySelector('#entry-form');
  if (form) draft = { amount: form.elements.amount.value, tags: selected(form, 'tags'), payment: selected(form, 'payment')[0] || '', time: form.elements.time.value };
}
function go(next) {
  captureDraft();
  page = next;
  render();
  window.scrollTo(0, 0);
}
function render() {
  document.querySelectorAll('#nav button').forEach(b => {
    if (b.dataset.page === page || (page === 'edit' && b.dataset.page === 'history') || (['rule', 'export'].includes(page) && b.dataset.page === 'settings')) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  });
  if (readError) {
    app.innerHTML = `${heading('暂时无法读取')}<p class="form-error">${esc(readError)}</p><label for="raw-data">本地原始数据</label><textarea id="raw-data" readonly>${esc(rawBackup)}</textarea><button type="button" class="primary" id="raw-copy">复制备份</button>`;
    document.querySelector('#raw-copy').onclick = () => copyText(rawBackup, document.querySelector('#raw-data'));
    return;
  }
  if (page === 'record' || page === 'edit') renderEntry();
  else if (page === 'history') renderHistory();
  else if (page === 'settings') renderSettings();
  else if (page === 'rule') renderRule();
  else if (page === 'export') renderExport();
}
function renderEntry() {
  const entry = page === 'edit' ? data.entries.find(e => e.id === editing) : null;
  if (page === 'edit' && !entry) return go('history');
  const value = entry ? { ...entry, amount: (entry.amount / 100).toFixed(2) } : draft;
  if (!entry && !data.payments.some(p => p.active && p.id === value.payment)) value.payment = data.payments.find(p => p.active)?.id || '';
  if (!entry) value.tags = value.tags.filter(id => data.tags.some(t => t.id === id && t.active));
  app.innerHTML = `${entry ? '<button class="back" type="button" id="back">‹ 返回明细</button>' : ''}${heading(entry ? '修改这笔支出' : '记一笔', entry ? '调整一下，让账目准确。' : '不用想太多，记下就好。')}<form id="entry-form" novalidate><div class="amount-card"><label for="amount">支出金额</label><div class="amount-line"><span class="currency">¥</span><input id="amount" name="amount" type="text" inputmode="decimal" autocomplete="off" placeholder="0.00" value="${esc(value.amount)}" aria-label="支出金额（人民币）" required></div><div class="amount-foot">人民币 CNY</div></div>${choices(value.tags, value.payment)}<div class="field"><label for="time">记账时间</label><input class="wide" id="time" name="time" type="datetime-local" value="${esc(value.time)}" required></div><p class="form-error" role="alert"></p><button class="primary" type="submit">${entry ? '保存修改' : '记好了'}</button>${entry ? '<button class="delete danger" type="button" id="delete-entry">删除这笔支出</button>' : '<p class="hint">留一点记录，让生活有迹可循。</p>'}</form>`;
  const form = app.querySelector('form');
  bindChips(form);
  if (entry) {
    document.querySelector('#back').onclick = () => go('history');
    document.querySelector('#delete-entry').onclick = () => {
      if (!window.confirm('删除这笔支出？')) return;
      if (save(next => { next.entries = next.entries.filter(e => e.id !== entry.id); })) { go('history'); toast('已删除'); }
    };
  }
  form.onsubmit = event => {
    event.preventDefault();
    let amount;
    try { amount = C.parseAmount(form.elements.amount.value); } catch (error) { return errorText(error.message); }
    const payment = selected(form, 'payment')[0];
    const time = form.elements.time.value;
    if (!payment) return errorText('请选择付款方式，可在设置中添加');
    if (!time || !Number.isFinite(new Date(time).getTime())) return errorText('请选择有效的记账时间');
    const tags = selected(form, 'tags');
    const result = { ...(entry || {}), id: entry?.id || C.id(), amount, tags, payment, time };
    if (!save(next => {
      if (entry) next.entries[next.entries.findIndex(e => e.id === entry.id)] = result;
      else next.entries.push(result);
      next.lastPayment = payment;
    })) return;
    if (entry) { go('history'); toast('已保存修改'); }
    else {
      draft = { amount: '', tags, payment, time: C.localTime() };
      render();
      toast('记好了');
      document.querySelector('#amount').focus({ preventScroll: true });
    }
  };
}
function options(list, current, all) {
  return `<option value="">${all}</option>${list.map(item => `<option value="${esc(item.id)}" ${item.id === current ? 'selected' : ''}>${esc(item.name)}</option>`).join('')}`;
}
function renderHistory() {
  const entries = C.filtered(data, month, filterTag, filterPayment);
  const sum = entries.reduce((total, e) => total + BigInt(e.amount), 0n);
  const total = `${(sum / 100n).toLocaleString('zh-CN')}.${String(sum % 100n).padStart(2, '0')}`;
  let previous = '';
  const rows = entries.map(e => {
    const date = e.time.slice(0, 10);
    const dayHeading = date !== previous ? `<div class="day-title"><span>${esc(date)}</span></div>` : '';
    previous = date;
    const names = e.tags.map(id => label(data.tags, id));
    return `${dayHeading}<button type="button" class="entry" data-entry="${esc(e.id)}"><span class="entry-icon" aria-hidden="true">${esc((names[0] || '支出').slice(0, 1))}</span><span class="entry-main"><span class="entry-title">${esc(names.join(' · ') || '未分类')}</span><span class="entry-meta">${esc(label(data.payments, e.payment))} · ${esc(e.time.slice(11))}${e.source ? ' · 固定支出' : ''}</span></span><strong class="entry-amount">−${C.money(e.amount)}</strong></button>`;
  }).join('');
  app.innerHTML = `${heading('日常明细', '每一笔，都是生活的小片段。')}<label class="field-title" for="month">查看月份</label><input class="wide" id="month" type="month" value="${esc(month)}"><div class="summary"><p>${filterTag || filterPayment ? '筛选支出' : '本月支出'}</p><strong>¥ ${total}</strong><small>${entries.length} 笔记录</small></div><div class="filters"><select id="filter-tag" aria-label="按标签筛选">${options(data.tags, filterTag, '全部标签')}</select><select id="filter-payment" aria-label="按付款方式筛选">${options(data.payments, filterPayment, '全部付款方式')}</select></div>${rows || '<div class="empty"><span class="empty-symbol">○</span>这里还没有记录<br>去记下今天的第一笔吧。</div>'}`;
  document.querySelector('#month').onchange = e => { if (e.target.value) { month = e.target.value; renderHistory(); } };
  document.querySelector('#filter-tag').onchange = e => { filterTag = e.target.value; renderHistory(); };
  document.querySelector('#filter-payment').onchange = e => { filterPayment = e.target.value; renderHistory(); };
  app.querySelectorAll('[data-entry]').forEach(el => el.onclick = () => { editing = el.dataset.entry; go('edit'); });
}
function configPanel(kind, title, placeholder) {
  return `<section class="panel"><div class="panel-head"><h2>${title}</h2><small>修改后自动保存</small></div>${data[kind].filter(i => i.active).map(i => `<div class="config-row" data-kind="${kind}" data-config-id="${esc(i.id)}"><input aria-label="${title}名称" maxlength="20" value="${esc(i.name)}"><button type="button" class="config-remove" aria-label="删除${esc(i.name)}">×</button></div>`).join('')}<form class="add-row" data-add="${kind}"><input name="name" maxlength="20" aria-label="新增${title}" placeholder="${placeholder}" required><button class="secondary" type="submit">添加</button></form></section>`;
}
function cycleText(v) {
  return v.cycle === 'daily' ? '每天' : v.cycle === 'weekly' ? `每周${['日', '一', '二', '三', '四', '五', '六'][v.day]}` : `每月 ${v.day} 日`;
}
function renderSettings() {
  app.innerHTML = `${heading('按你的习惯', '简单设置，之后记得更轻松。')}<p class="form-error" role="alert"></p>${configPanel('tags', '支出标签', '例如：咖啡')}${configPanel('payments', '付款方式', '例如：信用卡')}<section class="panel"><div class="panel-head"><h2>固定支出</h2><button class="text-button" type="button" id="add-rule">＋ 添加</button></div>${data.rules.filter(r => !r.stopped).map(r => { const v = r.versions.at(-1); return `<div class="rule-row"><button type="button" data-rule="${esc(r.id)}"><strong>${esc(v.name)} <span style="float:right">¥ ${C.money(v.amount)}</span></strong><small>${cycleText(v)} · ${esc(v.at)} · ${esc(label(data.payments, v.payment))}</small></button></div>`; }).join('') || '<p class="notice">房租、水电、订阅，到期后选一下就能补记。</p>'}<button class="text-button" type="button" id="check-pending">查看待补记录</button></section><section class="panel"><div class="panel-head"><h2>留一份备份</h2></div><p class="notice">账目只保存在当前浏览器。清理网站数据前，记得导出。</p><button class="secondary wide" type="button" id="export">复制全部数据</button></section>`;
  app.querySelectorAll('[data-add]').forEach(form => form.onsubmit = event => {
    event.preventDefault();
    const kind = form.dataset.add, name = form.elements.name.value.trim();
    if (!name) return errorText('名称不能为空');
    if (data[kind].some(i => i.active && i.name === name)) return errorText('这个名称已经有了');
    if (save(next => { const item = { id: C.id(), name, active: true }; next[kind].push(item); if (kind === 'payments' && !next[kind].some(p => p.active && p.id === next.lastPayment)) next.lastPayment = item.id; })) { renderSettings(); toast('已添加'); }
  });
  app.querySelectorAll('[data-config-id]').forEach(row => {
    const kind = row.dataset.kind, id = row.dataset.configId;
    const input = row.querySelector('input');
    const remove = row.querySelector('.config-remove');
    input.addEventListener('blur', () => {
      const name = input.value.trim();
      if (name === data[kind].find(i => i.id === id).name) return;
      if (!name) return errorText('名称不能为空');
      if (data[kind].some(i => i.active && i.id !== id && i.name === name)) return errorText('这个名称已经有了');
      if (save(next => { next[kind].find(i => i.id === id).name = name; })) {
        input.value = name;
        remove.setAttribute('aria-label', `删除${name}`);
        errorText('');
      }
    });
    input.addEventListener('keydown', event => {
      if (event.key === 'Enter' && !event.isComposing) {
        event.preventDefault();
        input.blur();
      }
    });
    remove.addEventListener('click', () => {
      const inUse = data.rules.some(r => !r.stopped && (kind === 'tags' ? r.versions.at(-1).tags.includes(id) : r.versions.at(-1).payment === id));
      if (inUse) return errorText('有固定支出正在使用此选项，请先修改对应固定支出');
      if (save(next => { next[kind].find(i => i.id === id).active = false; })) { renderSettings(); toast('已删除，历史账目保留'); }
    });
  });
  document.querySelector('#add-rule').onclick = () => { editingRule = ''; go('rule'); };
  app.querySelectorAll('[data-rule]').forEach(el => el.onclick = () => { editingRule = el.dataset.rule; go('rule'); });
  document.querySelector('#check-pending').onclick = () => showPending(true);
  document.querySelector('#export').onclick = exportData;
}
function renderRule() {
  const rule = data.rules.find(r => r.id === editingRule);
  const v = rule?.versions.at(-1) || { name: '', amount: 0, tags: [], payment: data.payments.find(p => p.active && p.id === data.lastPayment)?.id || data.payments.find(p => p.active)?.id || '', cycle: 'monthly', day: 1, at: '09:00', start: C.dateKey(new Date()) };
  app.innerHTML = `<button class="back" type="button" id="back">‹ 返回设置</button>${heading(rule ? '修改固定支出' : '添加固定支出')}<form id="rule-form" novalidate><div class="field"><label for="rule-name">名称</label><input class="wide" id="rule-name" name="name" maxlength="30" placeholder="例如：每月房租" value="${esc(v.name)}" required></div><div class="field"><label for="rule-amount">金额（元）</label><input class="wide" id="rule-amount" name="amount" inputmode="decimal" placeholder="0.00" value="${v.amount ? (v.amount / 100).toFixed(2) : ''}" required></div>${choices(v.tags, v.payment)}<div class="row"><div class="field"><label for="cycle">周期</label><select id="cycle" name="cycle"><option value="daily">每天</option><option value="weekly">每周</option><option value="monthly">每月</option></select></div><div class="field" id="day-field"><label for="rule-day">哪一天</label><select id="rule-day" name="day"></select></div></div><div class="row"><div class="field"><label for="start">开始日期</label><input id="start" name="start" type="date" value="${esc(v.start)}" required></div><div class="field"><label for="at">记账时间</label><input id="at" name="at" type="time" value="${esc(v.at)}" required></div></div><p class="notice">${rule ? '修改从今天起生效，之前遗漏仍按原配置补记。' : '从开始日期计算待补记录，由你勾选后记账。'} 每月支持 1—28 日。</p><p class="form-error" role="alert"></p><button class="primary" type="submit">保存固定支出</button>${rule ? '<button class="delete danger" type="button" id="delete-rule">删除固定支出</button>' : ''}</form>`;
  const form = document.querySelector('#rule-form');
  bindChips(form);
  form.elements.cycle.value = v.cycle;
  const updateDays = () => {
    const weekly = form.elements.cycle.value === 'weekly';
    document.querySelector('#day-field').hidden = form.elements.cycle.value === 'daily';
    form.elements.day.innerHTML = (weekly ? [1, 2, 3, 4, 5, 6, 0] : Array.from({ length: 28 }, (_, i) => i + 1)).map(day => `<option value="${day}">${weekly ? '周' + ['日', '一', '二', '三', '四', '五', '六'][day] : day + ' 日'}</option>`).join('');
    if ([...form.elements.day.options].some(o => Number(o.value) === v.day)) form.elements.day.value = v.day;
  };
  updateDays();
  form.elements.cycle.onchange = updateDays;
  document.querySelector('#back').onclick = () => go('settings');
  form.onsubmit = event => {
    event.preventDefault();
    let amount;
    try { amount = C.parseAmount(form.elements.amount.value); } catch (error) { return errorText(error.message); }
    const name = form.elements.name.value.trim(), payment = selected(form, 'payment')[0];
    const start = form.elements.start.value, at = form.elements.at.value;
    if (!name || !payment || !start || !at || !form.checkValidity()) return errorText('请填写名称、付款方式和有效的日期时间');
    const today = C.dateKey(new Date());
    const version = { name, amount, tags: selected(form, 'tags'), payment, start, at, cycle: form.elements.cycle.value, day: Number(form.elements.day.value), from: rule ? today : start };
    if (!save(next => {
      if (rule) C.revise(next.rules.find(r => r.id === rule.id), version, today);
      else next.rules.push({ id: C.id(), versions: [version] });
    })) return;
    go('settings'); toast('固定支出已保存');
  };
  if (rule) document.querySelector('#delete-rule').onclick = () => {
    if (!window.confirm('停止这项固定支出？已有账目保留，今天之前的遗漏仍可补齐。')) return;
    if (save(next => { next.rules.find(r => r.id === rule.id).stopped = C.dateKey(new Date()); })) { go('settings'); toast('已停止固定支出'); }
  };
}
function showPending(manual = false) {
  const items = C.pending(data);
  if (!items.length) { if (manual) toast('没有待补记录'); return; }
  dialog.innerHTML = `<h2 id="backfill-title">有 ${items.length} 笔固定支出待补</h2><p class="subtitle">选中需要记下的，其余留到下次。</p><form><div class="pending-list">${items.map((item, i) => `<label class="pending-item"><input type="checkbox" name="pending" value="${i}"><span>${esc(item.name)}<small>${esc(item.time.replace('T', ' '))} · ${esc(label(data.payments, item.payment))}</small></span><strong>¥ ${C.money(item.amount)}</strong></label>`).join('')}</div><p class="form-error" role="alert"></p><div class="dialog-actions"><button class="secondary" id="skip" type="button">暂时不补</button><button class="primary" type="submit" disabled>补齐选中记录</button></div></form>`;
  const form = dialog.querySelector('form');
  form.onchange = () => { const count = form.querySelectorAll(':checked').length; const button = form.querySelector('[type=submit]'); button.disabled = !count; button.textContent = count ? `补齐 ${count} 笔` : '补齐选中记录'; };
  document.querySelector('#skip').onclick = () => dialog.close();
  form.onsubmit = event => {
    event.preventDefault();
    const chosen = [...form.querySelectorAll(':checked')].map(el => items[Number(el.value)]);
    if (!chosen.length) return;
    if (!save(next => C.fill(next, chosen), dialog)) return;
    dialog.close();
    captureDraft(); render(); toast(`已补齐 ${chosen.length} 笔`);
  };
  dialog.showModal();
}
async function copyText(text, textarea) {
  try { await navigator.clipboard.writeText(text); toast('已复制'); return true; }
  catch (error) { if (textarea) { textarea.focus(); textarea.select(); toast('请长按文本，手动复制'); } return false; }
}
async function exportData() {
  const text = JSON.stringify(data, null, 2);
  if (!await copyText(text)) { go('export'); toast('自动复制不可用，请手动复制'); }
}
function renderExport() {
  app.innerHTML = `<button class="back" id="back" type="button">‹ 返回设置</button>${heading('复制一份备份', '包含全部账目、标签、付款方式和固定支出。')}<label class="field-title" for="export-data">全部数据</label><textarea id="export-data" readonly>${esc(JSON.stringify(data, null, 2))}</textarea><button class="primary" style="margin-top:18px" id="copy" type="button">复制数据</button><p class="hint">自动复制不可用时，可长按文本全选复制。</p>`;
  document.querySelector('#back').onclick = () => go('settings');
  document.querySelector('#copy').onclick = () => copyText(document.querySelector('#export-data').value, document.querySelector('#export-data'));
}
document.querySelector('#nav').addEventListener('click', event => {
  const button = event.target.closest('[data-page]');
  if (button) go(button.dataset.page);
});
render();
if (!readError) showPending();
