(function (root) {
  'use strict';
  const DEFAULT = { url: 'https://wvigvjmsjmyomizltahd.supabase.co', key: 'sb_publishable_i0KW8Jrf4vUzb0b-4tEzHw_9coOktId' };
  const C = typeof module !== 'undefined' ? require('./core.js') : root.Ledger;
  const collections = ['tags', 'payments', 'entries', 'rules', 'processed'];
  const canonical = value => JSON.stringify(value, (_, v) => v && !Array.isArray(v) && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v);
  function diff(base, next) {
    const changes = {};
    for (const name of collections) {
      const key = value => name === 'processed' ? value : value.id;
      const previous = new Map((base?.[name] || []).map(value => [key(value), value]));
      const current = new Map(next[name].map(value => [key(value), value]));
      const upsert = [...current].filter(([id, value]) => canonical(value) !== canonical(previous.get(id))).map(([, value]) => value);
      const remove = [...previous.keys()].filter(id => !current.has(id));
      if (upsert.length || remove.length) changes[name] = { upsert, remove };
    }
    if (!base || base.lastPayment !== next.lastPayment) changes.lastPayment = next.lastPayment || '';
    return changes;
  }
  class Client {
    constructor(storage, request = globalThis.fetch.bind(globalThis)) {
      this.storage = storage;
      this.request = request;
      this.config = JSON.parse(storage.getItem('saving.cloud.config') || 'null') || DEFAULT;
      this.session = JSON.parse(storage.getItem(this.sessionKey()) || 'null');
    }
    sessionKey() { return 'saving.cloud.session:' + this.config.url; }
    configure(url, key) {
      const parsed = new URL(url.trim());
      if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) throw new Error('请填写 HTTPS 项目根地址');
      if (!/^sb_publishable_[A-Za-z0-9_-]+$/.test(key.trim())) throw new Error('请使用 sb_publishable_ 开头的公开密钥，不要使用管理员密钥');
      const config = { url: parsed.origin, key: key.trim() };
      this.storage.setItem('saving.cloud.config', JSON.stringify(config));
      this.config = config;
      this.session = JSON.parse(this.storage.getItem(this.sessionKey()) || 'null');
    }
    async call(path, options = {}, token) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15000);
      try {
        const response = await this.request(this.config.url + path, {
          ...options, signal: controller.signal,
          headers: { apikey: this.config.key, 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}), ...options.headers }
        });
        const raw = await response.text();
        let value;
        try { value = raw ? JSON.parse(raw) : null; } catch { throw new Error('云端返回异常，请稍后重试'); }
        if (!response.ok) {
          const error = new Error(response.status === 401 ? '登录已过期，请重新登录' : (value?.msg || value?.message || value?.error_description || '云端请求失败'));
          error.status = response.status;
          throw error;
        }
        return value;
      } catch (error) {
        if (error.name === 'AbortError') throw new Error('连接超时，本地数据已保留');
        if (error instanceof TypeError) throw new Error('无法连接云端，请检查网络或切换 Wi-Fi / 手机流量后重试，并确认设置中的项目 URL 正确。本地数据已保留');
        throw error;
      } finally { clearTimeout(timer); }
    }
    remember(session) {
      if (!session?.user?.id || !session.access_token || !session.refresh_token) throw new Error('登录响应不完整');
      session.expires_at = session.expires_at || Math.floor(Date.now() / 1000) + session.expires_in;
      this.storage.setItem(this.sessionKey(), JSON.stringify(session));
      this.session = session;
      return session;
    }
    async login(email, password) {
      return this.remember(await this.call('/auth/v1/token?grant_type=password', { method: 'POST', body: JSON.stringify({ email, password }) }));
    }
    async keyCall(key, action, args = {}) {
      try {
        return await this.call('/rest/v1/rpc/key_access', {
          method: 'POST', headers: { 'Content-Profile': 'savin', 'Accept-Profile': 'savin', 'X-Savin-Key': key },
          body: JSON.stringify({ p_action: action, p_args: args })
        });
      } catch (error) {
        if (error.status === 401) error.message = '个人 API Key 无效、已过期或已撤销';
        throw error;
      }
    }
    async loginKey(value) {
      const key = value.trim();
      if (!/^savin_key_[A-Za-z0-9_-]{43}$/.test(key)) throw new Error('请填写 savin_key_ 开头的个人 API Key');
      const profile = await this.keyCall(key, 'profile');
      if (!profile?.user?.id || !profile.key_id) throw new Error('密钥验证响应不完整');
      const session = { user: profile.user, api_key: key, key_id: profile.key_id, key_expires_at: profile.expires_at };
      this.storage.setItem(this.sessionKey(), JSON.stringify(session));
      this.session = session;
      return session;
    }
    async token() {
      if (!this.session) throw new Error('请先登录，待上传数据保留在本机');
      if (this.session.expires_at * 1000 > Date.now() + 60000) return this.session.access_token;
      if (!this.refreshing) this.refreshing = this.call('/auth/v1/token?grant_type=refresh_token', {
        method: 'POST', body: JSON.stringify({ refresh_token: this.session.refresh_token })
      }).then(session => this.remember(session)).finally(() => { this.refreshing = null; });
      await this.refreshing;
      return this.session.access_token;
    }
    async logout() {
      const token = this.session?.access_token;
      this.storage.removeItem(this.sessionKey());
      this.session = null;
      if (token) { try { await this.call('/auth/v1/logout?scope=local', { method: 'POST' }, token); } catch { /* Local logout works offline. */ } }
    }
    syncKey() { return 'saving.sync.v2:' + this.config.url + ':' + this.session.user.id; }
    async rpc(name, args = {}) {
      if (this.session?.api_key) return this.keyCall(this.session.api_key, name, args);
      return this.call('/rest/v1/rpc/' + name, {
        method: 'POST', headers: { 'Content-Profile': 'savin', 'Accept-Profile': 'savin' }, body: JSON.stringify(args)
      }, await this.token());
    }
    async read() {
      const row = await this.rpc('read_book');
      if (row !== null && (!row?.revision || !row.payload)) throw new Error('云端账本响应异常');
      if (row) C.validate(row.payload);
      // Do not discard a request whose response may have been lost.
      const saved = JSON.parse(this.storage.getItem(this.syncKey()) || 'null');
      if (saved?.pending) throw new Error('仍有待确认的上传，请先重试同步');
      this.storage.setItem(this.syncKey(), JSON.stringify({ base: row }));
      return row;
    }
    async write(payload, revision) {
      C.validate(payload);
      const key = this.syncKey();
      let saved = JSON.parse(this.storage.getItem(key) || 'null');
      if (!saved) { await this.read(); saved = JSON.parse(this.storage.getItem(key)); }
      const flush = async () => {
        const pending = saved.pending;
        const ack = await this.rpc('apply_changes', pending.request);
        if (ack?.revision !== pending.request.p_revision) throw new Error('未收到云端保存确认，本地数据已保留');
        saved = { base: { payload: pending.payload, revision: ack.revision } };
        this.storage.setItem(key, JSON.stringify(saved));
      };
      // Replay exactly the same transaction before sending later offline edits.
      if (saved.pending) await flush();
      if (saved.base?.revision === revision) return;
      saved.pending = {
        request: { p_base: saved.base?.revision || null, p_revision: revision, p_changes: diff(saved.base?.payload, payload) },
        payload: structuredClone(payload)
      };
      this.storage.setItem(key, JSON.stringify(saved));
      await flush();
    }
  }
  const api = { Client, DEFAULT, diff };
  if (typeof module !== 'undefined') module.exports = api;
  else root.SavinCloud = api;
})(globalThis);
