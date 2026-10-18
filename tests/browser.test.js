'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const browser = [process.env.CHROME_PATH, 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(p => p && fs.existsSync(p));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
test('mobile browser: record, edit, filters, recurring, persistence and failure recovery', { skip: !browser, timeout: 60000 }, async () => {
  const server = http.createServer((req, res) => {
    const name = req.url.split('?')[0];
    const files = { '/': 'index.html', '/index.html': 'index.html', '/app.js': 'app.js', '/core.js': 'core.js', '/style.css': 'style.css' };
    if (!files[name]) { res.writeHead(404); res.end(); return; }
    res.setHeader('Content-Type', name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : 'text/html; charset=utf-8');
    res.end(fs.readFileSync(path.join(root, files[name])));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'saving-browser-'));
  const child = spawn(browser, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-extensions', 'about:blank'], { windowsHide: true, stdio: 'ignore' });
  let launchError;
  child.on('error', error => { launchError = error; });
  let socket;
  try {
    const portFile = path.join(profile, 'DevToolsActivePort');
    for (let i = 0; !fs.existsSync(portFile) && i < 100; i++) { if (launchError) throw launchError; await delay(100); }
    assert.ok(fs.existsSync(portFile), 'browser debugging port is available');
    const port = fs.readFileSync(portFile, 'utf8').split('\n')[0];
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    socket = new WebSocket(targets.find(t => t.type === 'page').webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
    let sequence = 0;
    const waiting = new Map(), runtimeErrors = [];
    socket.onmessage = event => {
      const message = JSON.parse(event.data);
      if (message.method === 'Runtime.exceptionThrown') runtimeErrors.push(message.params.exceptionDetails.text);
      if (message.id) { const entry = waiting.get(message.id); waiting.delete(message.id); if (message.error) entry.reject(new Error(message.error.message)); else entry.resolve(message.result); }
    };
    const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++sequence; waiting.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })); });
    const run = async fn => {
      const result = await send('Runtime.evaluate', { expression: `(${fn.toString()})()`, awaitPromise: true, returnByValue: true, userGesture: true });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
      return result.result.value;
    };
    await send('Runtime.enable');
    await send('Page.enable');
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await send('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/` });
    for (let i = 0; i < 100; i++) { if (await run(() => !!document.querySelector('#entry-form'))) break; await delay(50); }
    assert.equal(await run(() => document.querySelector('h1').textContent), '记一笔');
    assert.ok(await run(() => document.documentElement.scrollWidth <= innerWidth));
    assert.ok(await run(() => document.querySelector('#entry-form .primary').getBoundingClientRect().bottom <= document.querySelector('#nav').getBoundingClientRect().top), 'save button visible above navigation');
    await run(() => {
      document.querySelector('#amount').value = '12.34';
      document.querySelector('#note').value = '<b>午饭</b>';
      document.querySelector('[data-page=settings]').click();
      document.querySelector('[data-page=record]').click();
      const tags = document.querySelectorAll('[data-kind=tags] button'); tags[0].click(); tags[1].click();
      document.querySelector('#entry-form').requestSubmit();
    });
    assert.equal(await run(() => JSON.parse(localStorage.getItem('saving.v1')).entries[0].amount), 1234);
    assert.equal(await run(() => document.querySelector('#amount').value), '');
    assert.equal(await run(() => JSON.parse(localStorage.getItem('saving.v1')).entries[0].note), '<b>午饭</b>');
    assert.equal(await run(() => document.querySelector('#note').value), '');
    assert.equal(await run(() => document.querySelectorAll('[data-kind=tags] [aria-pressed=true]').length), 2);
    await run(() => { document.querySelector('#amount').value = '0.001'; document.querySelector('form').requestSubmit(); });
    assert.ok(await run(() => document.querySelector('.form-error').textContent.includes('两位小数')));
    await run(() => { document.querySelector('#amount').value = '25.60'; document.querySelector('form').requestSubmit(); document.querySelector('[data-page=history]').click(); });
    assert.equal(await run(() => document.querySelectorAll('.entry').length), 2);
    assert.equal(await run(() => document.querySelector('.entry-note').textContent), '<b>午饭</b>');
    assert.equal(await run(() => document.querySelectorAll('.entry-note b').length), 0);
    await run(() => { document.querySelector('.entry-note').closest('button').click(); });
    assert.equal(await run(() => document.querySelector('#note').value), '<b>午饭</b>');
    await run(() => { document.querySelector('#note').value = '午饭和咖啡'; document.querySelector('form').requestSubmit(); });
    assert.equal(await run(() => document.querySelector('.entry-note').textContent), '午饭和咖啡');
    assert.equal(await run(() => document.querySelector('.summary strong').textContent), '¥ 37.94');
    await run(() => { document.querySelector('.entry').click(); document.querySelector('#amount').value = '10'; document.querySelector('form').requestSubmit(); });
    assert.equal(await run(() => JSON.parse(localStorage.getItem('saving.v1')).entries.some(e => e.amount === 1000)), true);
    await run(() => { document.querySelector('#filter-tag').selectedIndex = 1; document.querySelector('#filter-tag').dispatchEvent(new Event('change')); });
    assert.equal(await run(() => document.querySelectorAll('.entry').length), 2);
    await run(() => {
      document.querySelector('[data-page=settings]').click();
      const form = document.querySelector('[data-add=tags]'); form.elements.name.value = '<b>咖啡</b>'; form.requestSubmit();
    });
    assert.equal(await run(() => [...document.querySelectorAll('.config-row input')].some(i => i.value === '<b>咖啡</b>')), true);
    assert.equal(await run(() => document.querySelectorAll('.config-row b').length), 0);
    await run(() => {
      document.querySelector('#add-rule').click();
      const f = document.querySelector('#rule-form'); f.elements.name.value = '每日咖啡'; f.elements.amount.value = '8.5';
      f.elements.cycle.value = 'daily'; f.elements.cycle.dispatchEvent(new Event('change'));
      const yesterday = new Date(); yesterday.setDate(yesterday.getDate() - 1);
      f.elements.start.value = Ledger.dateKey(yesterday); f.elements.at.value = '00:00'; f.requestSubmit();
      document.querySelector('#check-pending').click();
    });
    assert.equal(await run(() => document.querySelectorAll('#backfill input').length), 2);
    await run(() => { document.querySelector('#backfill input').click(); document.querySelector('#backfill form').requestSubmit(); });
    assert.equal(await run(() => JSON.parse(localStorage.getItem('saving.v1')).processed.length), 1);
    await send('Page.reload');
    for (let i = 0; i < 100; i++) { if (await run(() => !!document.querySelector('#backfill[open]'))) break; await delay(50); }
    assert.equal(await run(() => document.querySelectorAll('#backfill input').length), 1);
    await run(() => { document.querySelector('#skip').click(); document.querySelector('#amount').value = '7.89'; window.originalSet = Storage.prototype.setItem; Storage.prototype.setItem = () => { throw new Error('quota'); }; document.querySelector('#entry-form').requestSubmit(); });
    assert.equal(await run(() => document.querySelector('#amount').value), '7.89');
    assert.ok(await run(() => document.querySelector('.form-error').textContent.includes('未保存成功')));
    await run(() => { Storage.prototype.setItem = window.originalSet; document.querySelector('#entry-form').requestSubmit(); });
    assert.equal(await run(() => JSON.parse(localStorage.getItem('saving.v1')).entries.length), 4);
    await run(() => {
      document.querySelector('[data-page=settings]').click();
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => { throw new Error('denied'); } } });
      document.querySelector('#export').click();
    });
    for (let i = 0; i < 40; i++) { if (await run(() => !!document.querySelector('#export-data'))) break; await delay(50); }
    assert.equal(await run(() => JSON.parse(document.querySelector('#export-data').value).entries.length), 4);
    await run(() => document.querySelector('[data-page=record]').click());
    await delay(2600);
    fs.mkdirSync(path.join(root, '.artifacts'), { recursive: true });
    const screenshot = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(root, '.artifacts', 'mobile-record.png'), Buffer.from(screenshot.data, 'base64'));
    await send('Emulation.setDeviceMetricsOverride', { width: 320, height: 640, deviceScaleFactor: 1, mobile: true });
    assert.ok(await run(() => document.documentElement.scrollWidth <= innerWidth), 'no horizontal overflow on narrow phone');
    await run(() => localStorage.setItem('saving.v1', '{broken'));
    await send('Page.reload');
    for (let i = 0; i < 100; i++) { if (await run(() => !!document.querySelector('#raw-data'))) break; await delay(50); }
    assert.equal(await run(() => localStorage.getItem('saving.v1')), '{broken');
    assert.equal(await run(() => document.querySelector('#raw-data').value), '{broken');
    assert.deepEqual(runtimeErrors, []);
  } finally {
    socket?.close();
    child.kill();
    await new Promise(resolve => server.close(resolve));
    // The isolated temporary browser profile is retained for diagnostics.
  }
});
