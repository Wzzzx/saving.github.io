(function (root) {
  'use strict';
  const C = typeof module !== 'undefined' ? require('./core.js') : root.Ledger;
  // Payload and dirty revision share one localStorage write: never acknowledge a
  // local edit without durably recording that it still needs uploading.
  class Store {
    constructor(storage, client, changed = () => {}) {
      this.storage = storage; this.client = client; this.changed = changed;
      this.key = storage.getItem('saving.active') || C.KEY;
      this.status = ''; this.running = null; this.loading = false;
    }
    snapshot() {
      const raw = this.storage.getItem(this.key);
      if (raw === null) return null;
      const value = JSON.parse(raw);
      const sync = value._sync || { dirty: true, revision: C.id() };
      delete value._sync;
      return { payload: C.validate(value), ...sync };
    }
    read() { return this.snapshot()?.payload || C.initial(); }
    put(payload, dirty, revision = C.id()) {
      C.validate(payload);
      this.storage.setItem(this.key, JSON.stringify({ ...payload, _sync: { dirty, revision } }));
    }
    commit(current, change) {
      if (this.loading) throw new Error('正在读取云端，请稍后重试');
      if (this.key !== C.KEY && !this.snapshot()) throw new Error('请先成功读取云端账本');
      const next = structuredClone(current); change(next);
      this.put(next, true);
      this.setStatus('已保存到本机，待上传');
      void this.sync().catch(() => {});
      return next;
    }
    setStatus(message) { this.status = message; this.changed(message); }
    ownerKey() { return this.client.session ? 'saving.cache:' + this.client.config.url + ':' + this.client.session.user.id : null; }
    bind() {
      const key = this.ownerKey();
      if (!key) return;
      if (this.key === C.KEY) {
        const legacy = this.snapshot();
        if (legacy) {
          this.storage.setItem(key, JSON.stringify({ ...legacy.payload, _sync: { dirty: true, revision: C.id() } }));
        }
      }
      this.storage.setItem('saving.active', key);
      this.key = key;
      // Keep the legacy source as a recovery backup; saving.active prevents remigration.
    }
    async sync(pull = false) {
      if (this.running) return this.running;
      if (!this.client.session || this.key !== this.ownerKey()) {
        this.setStatus('仅保存在本机，登录后自动上传'); return;
      }
      this.running = this.perform(pull).finally(() => { this.running = null; this.loading = false; });
      return this.running;
    }
    async perform(pull) {
      try {
        let local = this.snapshot();
        if (!local || (pull && !local.dirty)) {
          // Existing cache remains editable. A new edit during GET wins locally.
          this.loading = !local;
          this.setStatus('正在读取云端');
          const remote = await this.client.read();
          const latest = this.snapshot();
          if (!latest?.dirty) {
            if (remote) this.put(C.validate(remote.payload), false, remote.revision);
            else if (!latest) this.put(C.initial(), true);
          }
          this.loading = false;
          local = this.snapshot();
        }
        while (local?.dirty) {
          this.setStatus('已保存到本机，正在上传');
          await this.client.write(local.payload, local.revision);
          const latest = this.snapshot();
          if (latest?.revision === local.revision) this.put(latest.payload, false, latest.revision);
          local = this.snapshot();
        }
        this.setStatus('已同步');
      } catch (error) {
        this.setStatus('同步未完成：' + error.message);
        throw error;
      }
    }
  }
  if (typeof module !== 'undefined') module.exports = { Store };
  else root.SavinStorage = { Store };
})(globalThis);
