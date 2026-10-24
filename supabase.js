(function (root) {
  'use strict';
  const DEFAULT = { url: 'https://wvigvjmsjmyomizltahd.supabase.co', key: 'sb_publishable_i0KW8Jrf4vUzb0b-4tEzHw_9coOktId' };
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
    async read() {
      const token = await this.token();
      const rows = await this.call('/rest/v1/ledgers?select=payload,revision&user_id=eq.' + encodeURIComponent(this.session.user.id), { headers: { 'Accept-Profile': 'savin' } }, token);
      if (!Array.isArray(rows) || rows.length > 1) throw new Error('云端账本响应异常');
      return rows[0] || null;
    }
    async write(payload, revision) {
      const token = await this.token();
      const rows = await this.call('/rest/v1/ledgers?on_conflict=user_id', {
        method: 'POST', headers: { 'Content-Profile': 'savin', 'Accept-Profile': 'savin', Prefer: 'resolution=merge-duplicates,return=representation' },
        body: JSON.stringify({ user_id: this.session.user.id, payload, revision })
      }, token);
      if (!Array.isArray(rows) || rows.length !== 1 || rows[0].revision !== revision) throw new Error('未收到云端保存确认，本地数据已保留');
    }
  }
  const api = { Client, DEFAULT };
  if (typeof module !== 'undefined') module.exports = api;
  else root.SavinCloud = api;
})(globalThis);
