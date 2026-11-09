'use strict';

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { app } = require('electron');
const config = require('../config');
const oauth = require('./oauth');

const TRUNCATE = 16000;

function getByPath(object, dotPath) {
  if (!dotPath) return '';
  return String(dotPath)
    .split('.')
    .reduce((acc, key) => (acc && acc[key] !== undefined ? acc[key] : undefined), object);
}

function secretKey(id, part) {
  return `connector.${id}.${part}`;
}

class ConnectorManager extends EventEmitter {
  constructor() {
    super();
    this.manifests = null;
    this.userDir = path.join(app.getPath('userData'), 'connectors');
  }

  loadManifests(force = false) {
    if (this.manifests && !force) return this.manifests;
    const dirs = [path.join(__dirname, '..', '..', 'plugins', 'connectors'), this.userDir];
    const found = new Map();
    for (const dir of dirs) {
      let files = [];
      try {
        files = fs.readdirSync(dir).filter((file) => file.endsWith('.json'));
      } catch {
        continue;
      }
      for (const file of files) {
        try {
          const manifest = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
          if (!manifest.id || !Array.isArray(manifest.tools)) continue;
          if (!manifest.auth) manifest.auth = { type: 'token' };
          manifest.source = dir === this.userDir ? 'user' : 'builtin';
          manifest.file = path.join(dir, file);
          found.set(manifest.id, manifest);
        } catch (error) {
          console.error(`[connectors] failed to load ${file}: ${error.message}`);
        }
      }
    }
    this.manifests = [...found.values()];
    return this.manifests;
  }

  getManifest(id) {
    return this.loadManifests().find((manifest) => manifest.id === id) || null;
  }

  state(id) {
    const cfg = config.getConfig();
    return (cfg.connectors && cfg.connectors[id]) || {};
  }

  tokens(id) {
    return {
      token: config.getSecret(secretKey(id, 'token')),
      refresh: config.getSecret(secretKey(id, 'refresh')),
      expiresAt: Number(config.getSecret(secretKey(id, 'expires')) || 0),
    };
  }

  isConnected(id) {
    const state = this.state(id);
    const { token } = this.tokens(id);
    return !!(token && state.account) || !!(token && state.connectedAt);
  }

  list() {
    const manifests = this.loadManifests();
    const cfg = config.getConfig();
    return manifests.map((manifest) => {
      const state = (cfg.connectors && cfg.connectors[manifest.id]) || {};
      const { token, expiresAt } = this.tokens(manifest.id);
      const connected = !!token;
      return {
        id: manifest.id,
        name: manifest.name,
        description: manifest.description || '',
        category: manifest.category || '',
        icon: manifest.icon || '',
        color: manifest.color || '',
        docsUrl: manifest.docsUrl || '',
        source: manifest.source,
        authType: manifest.auth.type,
        auth: {
          type: manifest.auth.type,
          tokenLabel: manifest.auth.tokenLabel || 'Токен',
          tokenHint: manifest.auth.tokenHint || '',
          tokenPlaceholder: manifest.auth.tokenPlaceholder || '',
          helpUrl: manifest.auth.helpUrl || '',
          usernameLabel: manifest.auth.usernameLabel || '',
          usernamePlaceholder: manifest.auth.usernamePlaceholder || '',
          oauth: manifest.auth.oauth
            ? {
                clientIdLabel: manifest.auth.oauth.clientIdLabel || 'Client ID',
                clientSecretLabel: manifest.auth.oauth.clientSecretLabel || 'Client Secret',
                clientHelpUrl: manifest.auth.oauth.clientHelpUrl || '',
                scopes: manifest.auth.oauth.scopes || [],
              }
            : null,
        },
        settings: (manifest.settings || []).map((field) => ({
          ...field,
          value: (state.settings && state.settings[field.key]) || '',
        })),
        enabled: state.enabled !== false && connected,
        connected,
        account: state.account || '',
        authMode: state.authMode || (manifest.auth.type === 'basic' ? 'basic' : 'token'),
        clientId: state.clientId || '',
        username: state.username || '',
        expiresAt: expiresAt || null,
        toolCount: manifest.tools.length,
        tools: manifest.tools.map((tool) => ({ name: tool.name, description: tool.description || '' })),
      };
    });
  }

  saveState(id, patch) {
    const cfg = config.getConfig();
    const connectors = { ...(cfg.connectors || {}) };
    connectors[id] = { ...(connectors[id] || {}), ...patch };
    config.setConfig({ connectors });
    this.emit('status');
    return connectors[id];
  }

  setEnabled(id, enabled) {
    return this.saveState(id, { enabled: !!enabled });
  }

  saveSettings(id, settings) {
    const manifest = this.getManifest(id);
    if (!manifest) throw new Error('Коннектор не найден');
    const clean = {};
    for (const field of manifest.settings || []) {
      const value = String(settings?.[field.key] ?? '').trim();
      if (field.required && !value) throw new Error(`Заполни поле «${field.label}»`);
      clean[field.key] = value;
    }
    return this.saveState(id, { settings: clean });
  }

  storeTokens(id, token, { authMode = 'oauth2' } = {}) {
    if (!token || !token.access_token) throw new Error('Сервис не вернул access_token');
    config.setSecret(secretKey(id, 'token'), token.access_token);
    if (token.refresh_token) config.setSecret(secretKey(id, 'refresh'), token.refresh_token);
    if (token.expires_at) config.setSecret(secretKey(id, 'expires'), String(token.expires_at));
    this.saveState(id, { authMode, connectedAt: Date.now(), enabled: true });
  }

  async validateToken(id, token, extra = {}) {
    const manifest = this.getManifest(id);
    if (!manifest) throw new Error('Коннектор не найден');
    const validate = manifest.auth.validate;
    if (!validate) return { ok: true, label: '' };
    const settings = extra.settings || this.state(id).settings || {};
    const username = extra.username || this.state(id).username || '';
    const spec = {
      method: validate.method || 'GET',
      url: validate.url,
      query: validate.query,
      body: validate.body,
    };
    const result = await this.executeHttp(manifest, spec, {}, {
      token,
      username,
      settings,
      timeout: 20000,
      raw: true,
    });
    if (result.error) throw new Error(result.error);
    let parsed = null;
    try {
      parsed = JSON.parse(result.text);
    } catch {
      parsed = null;
    }
    let label = parsed ? getByPath(parsed, validate.labelPath) : '';
    if (!label && parsed) {
      label = parsed.login || parsed.name || parsed.email || parsed.emailAddress || parsed.displayName || parsed.nickname || '';
    }
    if (!label && manifest.auth.type === 'basic') label = username;
    return { ok: true, label: String(label || ''), raw: parsed };
  }

  async connectToken(id, payload = {}) {
    const manifest = this.getManifest(id);
    if (!manifest) throw new Error('Коннектор не найден');
    const token = String(payload.token || '').trim();
    if (!token && manifest.auth.type !== 'basic') throw new Error('Введи токен доступа');
    if (manifest.auth.type === 'basic') {
      if (!payload.username || !token) throw new Error('Нужны email и API-токен');
    }
    if (payload.settings) this.saveSettings(id, payload.settings);
    const existingSettings = this.state(id).settings || {};
    if (payload.clientId) this.saveState(id, { clientId: payload.clientId.trim() });
    if (payload.clientSecret) config.setSecret(secretKey(id, 'clientSecret'), payload.clientSecret.trim());
    if (payload.username) this.saveState(id, { username: payload.username.trim() });

    const validation = await this.validateToken(id, token, {
      settings: payload.settings || existingSettings,
      username: payload.username,
    });
    this.storeTokens(
      id,
      { access_token: token, expires_at: null },
      { authMode: manifest.auth.type === 'basic' ? 'basic' : 'token' }
    );
    this.saveState(id, { account: validation.label || (payload.username || 'подключено'), connectedAt: Date.now(), enabled: true });
    return { ok: true, account: validation.label || '' };
  }

  async connectOAuth(id, payload = {}) {
    const manifest = this.getManifest(id);
    if (!manifest) throw new Error('Коннектор не найден');
    const oauthConfig = manifest.auth.oauth;
    if (!oauthConfig) throw new Error('Этот коннектор не поддерживает OAuth');
    const clientId = String(payload.clientId || this.state(id).clientId || '').trim();
    const clientSecret = String(payload.clientSecret || config.getSecret(secretKey(id, 'clientSecret')) || '').trim();
    if (!clientId) throw new Error('Укажи OAuth Client ID');
    if (oauthConfig.needsClientSecret && !clientSecret) throw new Error('Укажи OAuth Client Secret');
    if (payload.settings) this.saveSettings(id, payload.settings);
    this.saveState(id, { clientId });
    if (clientSecret) config.setSecret(secretKey(id, 'clientSecret'), clientSecret);

    const token = await oauth.authorize({
      auth: oauthConfig,
      clientId,
      clientSecret,
      connectorName: manifest.name,
      onStatus: (status) => this.emit('oauth', { id, ...status }),
    });

    const validation = await this.validateToken(id, token.access_token, {
      settings: this.state(id).settings || {},
    });
    this.storeTokens(id, token, { authMode: 'oauth2' });
    this.saveState(id, {
      account: validation.label || 'подключено',
      connectedAt: Date.now(),
      enabled: true,
    });
    return { ok: true, account: validation.label || '' };
  }

  disconnect(id) {
    config.deleteSecretsWithPrefix(`connector.${id}.`);
    const cfg = config.getConfig();
    const connectors = { ...(cfg.connectors || {}) };
    if (connectors[id]) {
      connectors[id] = { ...connectors[id], enabled: false, account: '', connectedAt: null };
    }
    config.setConfig({ connectors });
    this.emit('status');
    return { ok: true };
  }

  async ensureFreshToken(id) {
    const manifest = this.getManifest(id);
    const { token, refresh, expiresAt } = this.tokens(id);
    if (!token) throw new Error(`${manifest?.name || id}: не подключено`);
    if (!expiresAt || expiresAt > Date.now() + 60_000) return token;
    if (!refresh || !manifest?.auth?.oauth) {
      throw new Error(`${manifest?.name || id}: токен истёк, подключись заново`);
    }
    const clientId = this.state(id).clientId;
    const clientSecret = config.getSecret(secretKey(id, 'clientSecret'));
    this.emit('oauth', { id, phase: 'refreshing', message: 'Обновляю токен…' });
    const refreshed = await oauth.refreshToken({ auth: manifest.auth.oauth, clientId, clientSecret, refreshToken: refresh });
    this.storeTokens(id, refreshed, { authMode: 'oauth2' });
    return refreshed.access_token;
  }

  toolDefinitions() {
    const defs = [];
    const seen = new Set();
    for (const manifest of this.loadManifests()) {
      const state = this.state(manifest.id);
      if (state.enabled === false) continue;
      const { token } = this.tokens(manifest.id);
      if (!token) continue;
      for (const tool of manifest.tools) {
        if (seen.has(tool.name)) continue;
        seen.add(tool.name);
        defs.push({
          type: 'function',
          function: {
            name: tool.name,
            description: `${tool.description || ''} (${manifest.name}, действует от имени пользователя)`.slice(0, 900),
            parameters: tool.args || { type: 'object', properties: {} },
          },
        });
      }
    }
    return defs;
  }

  async callTool(name, args = {}) {
    for (const manifest of this.loadManifests()) {
      const tool = manifest.tools.find((item) => item.name === name);
      if (!tool) continue;
      const state = this.state(manifest.id);
      if (state.enabled === false) throw new Error(`${manifest.name} отключён в плагинах`);
      const token = await this.ensureFreshToken(manifest.id);
      const result = await this.executeHttp(manifest, tool, args, {
        token,
        username: state.username || '',
        settings: state.settings || {},
        timeout: tool.timeout || 60000,
      });
      if (result.error) return { error: result.error };
      return { content: result.formatted, raw: result.text };
    }
    throw new Error(`Инструмент ${name} не найден среди плагинов`);
  }

  async executeHttp(manifest, spec, args = {}, ctx = {}) {
    const mergedArgs = { ...(spec.defaults || {}), ...(args || {}) };
    const templateContext = {
      args: mergedArgs,
      settings: ctx.settings || {},
      token: ctx.token || '',
      username: ctx.username || '',
    };

    let urlString;
    try {
      urlString = interpolate(spec.url, templateContext, { encode: true });
    } catch (error) {
      return { error: `Не удалось собрать URL: ${error.message}` };
    }
    if (!urlString) return { error: 'В запросе не хватает обязательных аргументов для URL' };

    let url;
    try {
      url = new URL(urlString);
    } catch {
      return { error: `Некорректный URL: ${urlString}` };
    }

    for (const [key, value] of Object.entries(spec.query || {})) {
      const resolved = interpolate(value, templateContext, { encode: false });
      if (resolved === undefined || resolved === null || resolved === '') continue;
      url.searchParams.set(key, String(resolved));
    }

    const headers = {
      Accept: 'application/json',
      'User-Agent': 'ComradeHarness/2.0',
      ...(manifest.headers || {}),
      ...(spec.headers || {}),
    };
    for (const [key, value] of Object.entries(spec.headers || {})) {
      const resolved = interpolate(value, templateContext, { encode: false });
      if (resolved !== undefined) headers[key] = String(resolved);
    }

    const auth = manifest.auth || {};
    if (ctx.token) {
      if (auth.type === 'basic') {
        const username = ctx.username || this.state(manifest.id).username || '';
        headers.Authorization = `Basic ${Buffer.from(`${username}:${ctx.token}`).toString('base64')}`;
      } else {
        headers[auth.header || 'Authorization'] = `${auth.prefix ?? 'Bearer '}${ctx.token}`;
      }
    }

    let body;
    if (spec.compose === 'rfc822') {
      const raw = buildRfc822(mergedArgs);
      body = JSON.stringify({ raw: Buffer.from(raw, 'utf8').toString('base64url') });
      headers['Content-Type'] = 'application/json';
    } else if (spec.body !== undefined) {
      const resolved = interpolate(spec.body, templateContext, { encode: false });
      if (typeof resolved === 'string') {
        body = resolved;
        headers['Content-Type'] = spec.bodyType || 'text/plain; charset=utf-8';
      } else if (resolved !== undefined) {
        body = JSON.stringify(resolved);
        headers['Content-Type'] = 'application/json';
      }
    }

    const controller = new AbortController();
    const timeout = Math.max(5000, Number(ctx.timeout) || 60000);
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await fetch(url, {
        method: (spec.method || 'GET').toUpperCase(),
        headers,
        body: body !== undefined && (spec.method || 'GET').toUpperCase() !== 'GET' ? body : undefined,
        signal: controller.signal,
      });
      const text = await response.text();
      const contentType = response.headers.get('content-type') || '';

      let parsed = null;
      if (contentType.includes('json') || /^\s*[[{]/.test(text)) {
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = null;
        }
      }

      const okField = manifest.jsonOkField;
      if (parsed && okField && parsed[okField] === false) {
        const message = getByPath(parsed, manifest.jsonErrorField || 'error') || 'API вернул ok=false';
        return { error: `${manifest.name}: ${message}`, text, status: response.status };
      }

      if (!response.ok) {
        const apiMessage =
          (parsed && (parsed.error?.message || parsed.message || parsed.error_description || parsed.error)) ||
          text.slice(0, 700) ||
          response.statusText;
        const hint = response.status === 401 || response.status === 403 ? ' Проверь токен и права доступа.' : '';
        return {
          error: `${manifest.name}: HTTP ${response.status} — ${typeof apiMessage === 'string' ? apiMessage : JSON.stringify(apiMessage)}.${hint}`,
          text,
          status: response.status,
        };
      }

      const pretty = parsed ? JSON.stringify(parsed, null, 2) : text;
      let formatted = pretty;
      if (formatted.length > TRUNCATE) formatted = `${formatted.slice(0, TRUNCATE)}\n… [обрезано, всего ${pretty.length} символов]`;
      return {
        ok: true,
        status: response.status,
        text,
        parsed,
        formatted: `HTTP ${response.status} • ${manifest.name}\n${formatted || '(пустой ответ)'}`,
      };
    } catch (error) {
      if (error.name === 'AbortError') return { error: `${manifest.name}: таймаут запроса (${timeout} мс)` };
      return { error: `${manifest.name}: ${error.message}` };
    } finally {
      clearTimeout(timer);
    }
  }
}

function interpolate(value, ctx, options = {}) {
  if (typeof value === 'string') {
    const jsonMatch = /^\{\{json:([\w.]+)\}\}$/.exec(value.trim());
    if (jsonMatch) {
      const raw = resolvePath(jsonMatch[1], ctx);
      return raw;
    }
    let missing = false;
    const out = value.replace(/\{([\w.]+)\}/g, (match, key) => {
      const raw = resolvePath(key, ctx);
      if (raw === undefined || raw === null || raw === '') {
        missing = true;
        return '';
      }
      const text = typeof raw === 'object' ? JSON.stringify(raw) : String(raw);
      return options.encode ? encodeURIComponent(text) : text;
    });
    if (missing && out.trim() === '') return undefined;
    return out;
  }
  if (Array.isArray(value)) {
    return value.map((item) => interpolate(item, ctx, options)).filter((item) => item !== undefined);
  }
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      const resolved = interpolate(item, ctx, options);
      if (resolved !== undefined) out[key] = resolved;
    }
    return out;
  }
  return value;
}

function resolvePath(dotPath, ctx) {
  const [head, ...rest] = dotPath.split('.');
  let value;
  if (ctx.args && head in ctx.args) value = ctx.args[head];
  else if (ctx.settings && head in ctx.settings) value = ctx.settings[head];
  else if (head === 'token') value = ctx.token;
  else if (head === 'username') value = ctx.username;
  for (const part of rest) value = value?.[part];
  return value;
}

function buildRfc822(args) {
  const to = String(args.to || '').trim();
  const subject = String(args.subject || '').trim();
  const body = String(args.body || '');
  const cc = String(args.cc || '').trim();
  const lines = [`To: ${to}`, `Subject: =?UTF-8?B?${Buffer.from(subject, 'utf8').toString('base64')}?=`];
  if (cc) lines.push(`Cc: ${cc}`);
  lines.push('MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', Buffer.from(body, 'utf8').toString('base64'));
  return lines.join('\r\n');
}

module.exports = { ConnectorManager };
