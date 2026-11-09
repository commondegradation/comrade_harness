'use strict';

const { BrowserWindow, session } = require('electron');
const { UA } = require('./web');

const PARTITION = 'persist:comrade-browser';
const ALLOWED_PROTOCOL = /^https?:\/\//i;

const SNAPSHOT_SCRIPT = `(() => {
  const normalize = (value) => String(value || '').replace(/[\\t\\u00a0]+/g, ' ').replace(/ *\\n */g, '\\n').replace(/\\n{3,}/g, '\\n\\n').trim();
  try {
    const clone = document.body ? document.body.cloneNode(true) : null;
    if (!clone) return JSON.stringify({ title: document.title, url: location.href, text: '', links: [], inputs: [], buttons: [] });
    clone.querySelectorAll('script,style,noscript,svg,canvas,iframe,template,nav,aside,footer,dialog').forEach((el) => el.remove());
    clone.querySelectorAll('p,div,br,li,h1,h2,h3,h4,h5,h6,tr,section,article,pre,blockquote,td,th').forEach((el) => el.appendChild(document.createTextNode('\\n')));
    const article = clone.querySelector('article, main, [role="main"]');
    let text = normalize((article || clone).textContent);
    if (text.length < 120) text = normalize(clone.textContent);
    if (text.length > 24000) text = text.slice(0, 24000) + '\\n… [truncated]';

    const links = [];
    const seen = new Set();
    document.querySelectorAll('a[href]').forEach((a) => {
      if (links.length >= 80) return;
      if (!a.getClientRects().length) return;
      const href = a.href;
      if (!/^https?:/i.test(href)) return;
      const label = normalize(a.innerText || a.getAttribute('aria-label') || '');
      if (!label || label.length > 120) return;
      if (seen.has(href)) return;
      seen.add(href);
      links.push({ text: label, url: href });
    });

    const inputs = [];
    document.querySelectorAll('input, textarea, select, [contenteditable="true"]').forEach((el) => {
      if (inputs.length >= 40) return;
      if (!el.getClientRects().length) return;
      const type = (el.getAttribute('type') || el.tagName.toLowerCase()).toLowerCase();
      if (type === 'hidden' || type === 'password') return;
      inputs.push({
        tag: el.tagName.toLowerCase(),
        type,
        name: el.getAttribute('name') || '',
        id: el.id || '',
        placeholder: el.getAttribute('placeholder') || el.getAttribute('aria-label') || '',
        label: normalize(el.labels && el.labels.length ? el.labels[0].innerText : '').slice(0, 60),
        value: type === 'password' ? '' : String(el.value || '').slice(0, 80)
      });
    });

    const buttons = [];
    const seenButtons = new Set();
    document.querySelectorAll('button, [role="button"], input[type="submit"], input[type="button"]').forEach((el) => {
      if (buttons.length >= 40) return;
      if (!el.getClientRects().length) return;
      const label = normalize(el.innerText || el.value || el.getAttribute('aria-label') || '');
      if (!label || seenButtons.has(label)) return;
      seenButtons.add(label);
      buttons.push(label.slice(0, 80));
    });

    const selection = normalize(String(window.getSelection ? window.getSelection().toString() : '')).slice(0, 500);

    return JSON.stringify({
      title: document.title,
      url: location.href,
      text,
      links,
      inputs,
      buttons,
      selection,
      scroll: { y: Math.round(window.scrollY), height: Math.round(document.body ? document.body.scrollHeight : 0), viewport: window.innerHeight }
    });
  } catch (error) {
    return JSON.stringify({ title: document.title, url: location.href, text: '', links: [], inputs: [], buttons: [], error: String(error) });
  }
})()`;

const FIND_SCRIPT = (target) => `(() => {
  const needle = ${JSON.stringify(String(target || ''))};
  const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim().toLowerCase();
  let el = null;
  try {
    if (/^[#.\\[a-zA-Z]/.test(needle) && !/\\s/.test(needle)) el = document.querySelector(needle);
  } catch (error) { el = null; }
  if (!el) {
    const wanted = normalize(needle);
    const candidates = Array.from(document.querySelectorAll('a,button,[role="button"],input[type="submit"],input[type="button"],summary,label,[role="link"],[role="tab"],[role="menuitem"]'));
    el = candidates.find((node) => normalize(node.innerText || node.value || node.getAttribute('aria-label') || '') === wanted) || null;
    if (!el) el = candidates.find((node) => normalize(node.innerText || node.value || node.getAttribute('aria-label') || '').includes(wanted)) || null;
  }
  if (!el) return JSON.stringify({ ok: false, reason: 'Элемент не найден' });
  el.scrollIntoView({ block: 'center', inline: 'center' });
  const label = String(el.innerText || el.value || el.getAttribute('aria-label') || el.tagName).replace(/\\s+/g, ' ').trim().slice(0, 100);
  return JSON.stringify({ ok: true, label, tag: el.tagName.toLowerCase(), href: el.href || '' });
})()`;

const CLICK_SCRIPT = (target) => `(() => {
  const needle = ${JSON.stringify(String(target || ''))};
  const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim().toLowerCase();
  let el = null;
  try {
    if (/^[#.\\[a-zA-Z]/.test(needle) && !/\\s/.test(needle)) el = document.querySelector(needle);
  } catch (error) { el = null; }
  if (!el) {
    const wanted = normalize(needle);
    const candidates = Array.from(document.querySelectorAll('a,button,[role="button"],input[type="submit"],input[type="button"],summary,label,[role="link"],[role="tab"],[role="menuitem"]'));
    el = candidates.find((node) => normalize(node.innerText || node.value || node.getAttribute('aria-label') || '') === wanted) || null;
    if (!el) el = candidates.find((node) => normalize(node.innerText || node.value || node.getAttribute('aria-label') || '').includes(wanted)) || null;
  }
  if (!el) return JSON.stringify({ ok: false, reason: 'Элемент не найден' });
  el.scrollIntoView({ block: 'center', inline: 'center' });
  const label = String(el.innerText || el.value || el.getAttribute('aria-label') || el.tagName).replace(/\\s+/g, ' ').trim().slice(0, 100);
  const href = el.href || (el.closest('a') ? el.closest('a').href : '');
  el.click();
  return JSON.stringify({ ok: true, label, tag: el.tagName.toLowerCase(), href });
})()`;

const TYPE_SCRIPT = (target, text, submit) => `(() => {
  const needle = ${JSON.stringify(String(target || ''))};
  const value = ${JSON.stringify(String(text ?? ''))};
  const shouldSubmit = ${submit ? 'true' : 'false'};
  const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim().toLowerCase();
  let el = null;
  try {
    if (/^[#.\\[a-zA-Z]/.test(needle) && !/\\s/.test(needle)) el = document.querySelector(needle);
  } catch (error) { el = null; }
  if (!el) {
    const wanted = normalize(needle);
    const candidates = Array.from(document.querySelectorAll('input:not([type="hidden"]):not([type="submit"]),textarea,[contenteditable="true"],[role="textbox"],select'));
    el = candidates.find((node) => {
      const haystack = normalize([node.getAttribute('name'), node.id, node.getAttribute('placeholder'), node.getAttribute('aria-label'), node.getAttribute('type')].filter(Boolean).join(' '));
      return haystack === wanted;
    }) || candidates.find((node) => {
      const haystack = normalize([node.getAttribute('name'), node.id, node.getAttribute('placeholder'), node.getAttribute('aria-label'), node.getAttribute('type')].filter(Boolean).join(' '));
      return haystack.includes(wanted);
    }) || null;
  }
  if (!el) return JSON.stringify({ ok: false, reason: 'Поле не найдено' });
  el.scrollIntoView({ block: 'center' });
  el.focus();
  if (el.isContentEditable) {
    el.textContent = value;
    el.dispatchEvent(new InputEvent('input', { bubbles: true, data: value }));
  } else {
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : (el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype);
    const setter = Object.getOwnPropertyDescriptor(proto, 'value') ? Object.getOwnPropertyDescriptor(proto, 'value').set : null;
    if (setter && el.tagName !== 'SELECT') setter.call(el, value); else el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }
  const label = String(el.getAttribute('placeholder') || el.getAttribute('name') || el.id || el.tagName).slice(0, 80);
  let submitted = false;
  if (shouldSubmit) {
    if (el.form && typeof el.form.requestSubmit === 'function') {
      el.form.requestSubmit();
      submitted = true;
    } else {
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
      el.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
      submitted = true;
    }
  }
  return JSON.stringify({ ok: true, label, submitted });
})()`;

class BrowserController {
  constructor() {
    this.win = null;
    this.visible = false;
    this.lastError = null;
    this.log = [];
  }

  pushLog(message) {
    this.log.push({ at: Date.now(), message: String(message).slice(0, 500) });
    if (this.log.length > 100) this.log.shift();
  }

  ensure() {
    if (this.win && !this.win.isDestroyed()) return this.win;

    const ses = session.fromPartition(PARTITION);
    ses.setUserAgent(UA);
    ses.setPermissionRequestHandler((webContents, permission, callback) => {
      const allowed = ['clipboard-read', 'clipboard-sanitized-write', 'notifications'];
      callback(allowed.includes(permission));
    });

    this.win = new BrowserWindow({
      width: 1280,
      height: 900,
      show: this.visible,
      title: 'Comrade Browser',
      backgroundColor: '#ffffff',
      webPreferences: {
        partition: PARTITION,
        javascript: true,
        images: false,
        webgl: false,
        backgroundThrottling: false,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        spellcheck: false,
        safeDialogs: true,
        autoplayPolicy: 'user-gesture-required',
      },
    });

    const wc = this.win.webContents;
    wc.setWindowOpenHandler(({ url }) => {
      if (ALLOWED_PROTOCOL.test(url)) {
        this.navigate(url).catch(() => {});
      }
      return { action: 'deny' };
    });
    wc.on('will-navigate', (event, url) => {
      if (!ALLOWED_PROTOCOL.test(url)) event.preventDefault();
    });
    wc.session.on('will-download', (event) => {
      event.preventDefault();
      this.pushLog('download blocked');
    });
    wc.on('render-process-gone', (event, details) => {
      this.pushLog(`renderer gone: ${details.reason}`);
      this.lastError = `Страница упала: ${details.reason}`;
    });
    wc.on('did-fail-load', (event, code, description, validatedURL) => {
      if (code === -3) return; // aborted (navigation replaced)
      this.lastError = `Не удалось загрузить ${validatedURL}: ${description} (${code})`;
      this.pushLog(this.lastError);
    });
    this.win.on('closed', () => {
      this.win = null;
    });
    return this.win;
  }

  async navigate(url) {
    if (!ALLOWED_PROTOCOL.test(url)) throw new Error('Разрешены только http:// и https:// адреса');
    const win = this.ensure();
    const wc = win.webContents;
    this.lastError = null;
    this.pushLog(`open ${url}`);
    const loadPromise = wc.loadURL(url).catch((error) => {
      if (!/ERR_ABORTED/.test(error.message)) this.lastError = error.message;
    });
    await Promise.race([loadPromise, new Promise((resolve) => setTimeout(resolve, 40000))]);
    await this.settle();
    if (this.lastError) {
      return { error: this.lastError };
    }
    return this.snapshot();
  }

  async settle(minDelay = 700, maxWait = 8000) {
    const win = this.win;
    if (!win || win.isDestroyed()) return;
    const started = Date.now();
    let stable = 0;
    await new Promise((resolve) => setTimeout(resolve, minDelay));
    while (Date.now() - started < maxWait) {
      let ready = 'complete';
      let loading = true;
      try {
        ready = await win.webContents.executeJavaScript('document.readyState', true);
        loading = win.webContents.isLoading();
      } catch {
        break;
      }
      if (ready === 'complete' && !loading) {
        stable += 1;
        if (stable >= 2) break;
      } else {
        stable = 0;
      }
      await new Promise((resolve) => setTimeout(resolve, 350));
    }
    await new Promise((resolve) => setTimeout(resolve, 350));
  }

  async snapshot() {
    const win = this.ensure();
    const raw = await win.webContents.executeJavaScript(SNAPSHOT_SCRIPT, true);
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      data = { title: '', url: win.webContents.getURL(), text: String(raw || ''), links: [], inputs: [], buttons: [] };
    }
    data.text = String(data.text || '').slice(0, 24000);
    data.links = (data.links || []).slice(0, 80);
    data.inputs = (data.inputs || []).slice(0, 40);
    data.buttons = (data.buttons || []).slice(0, 40);
    return data;
  }

  async click(target) {
    if (!target) return { error: 'Укажи селектор или текст элемента' };
    const win = this.ensure();
    const before = win.webContents.getURL();
    const raw = await win.webContents.executeJavaScript(CLICK_SCRIPT(target), true);
    const result = safeParse(raw);
    this.pushLog(`click "${target}" -> ${result.ok ? result.label : 'not found'}`);
    if (!result.ok) return { error: result.reason || 'Элемент не найден', hint: 'Открой действие read, чтобы увидеть доступные кнопки и ссылки.' };
    await this.settle(900, 10000);
    const after = win.webContents.getURL();
    const page = await this.snapshot();
    return { ...page, action: 'click', clicked: result.label, navigated: before !== after };
  }

  async type(target, text, submit) {
    if (!target) return { error: 'Укажи поле (селектор, name или placeholder)' };
    const win = this.ensure();
    const raw = await win.webContents.executeJavaScript(TYPE_SCRIPT(target, text, !!submit), true);
    const result = safeParse(raw);
    this.pushLog(`type "${target}" -> ${result.ok ? 'ok' : 'not found'}`);
    if (!result.ok) return { error: result.reason || 'Поле не найдено', hint: 'Открой действие read, чтобы увидеть список полей ввода.' };
    await this.settle(900, 10000);
    const page = await this.snapshot();
    return { ...page, action: 'type', field: result.label, submitted: !!result.submitted };
  }

  async press(key) {
    const win = this.ensure();
    const map = {
      Enter: { keyCode: 'Return', key: 'Enter' },
      Tab: { keyCode: 'Tab', key: 'Tab' },
      Escape: { keyCode: 'Escape', key: 'Escape' },
      ArrowDown: { keyCode: 'Down', key: 'ArrowDown' },
      ArrowUp: { keyCode: 'Up', key: 'ArrowUp' },
      PageDown: { keyCode: 'PageDown', key: 'PageDown' },
      PageUp: { keyCode: 'PageUp', key: 'PageUp' },
      Space: { keyCode: 'Space', key: ' ' },
    };
    const entry = map[key] || { keyCode: key, key };
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: entry.keyCode });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: entry.keyCode });
    this.pushLog(`press ${key}`);
    await this.settle(700, 6000);
    return this.snapshot();
  }

  async scroll(direction, amount) {
    const win = this.ensure();
    const delta = direction === 'up' ? -1 : 1;
    const step = Math.min(3000, Math.max(200, Number(amount) || 800));
    await win.webContents.executeJavaScript(`window.scrollBy(0, ${delta * step}); true`, true);
    await new Promise((resolve) => setTimeout(resolve, 400));
    const page = await this.snapshot();
    return { ...page, action: 'scroll' };
  }

  async back() {
    const win = this.ensure();
    if (win.webContents.canGoBack()) {
      win.webContents.goBack();
      await this.settle(800, 8000);
    }
    return this.snapshot();
  }

  async forward() {
    const win = this.ensure();
    if (win.webContents.canGoForward()) {
      win.webContents.goForward();
      await this.settle(800, 8000);
    }
    return this.snapshot();
  }

  async wait(ms) {
    const delay = Math.min(10000, Math.max(100, Number(ms) || 1000));
    await new Promise((resolve) => setTimeout(resolve, delay));
    return this.snapshot();
  }

  async showWindow(show) {
    const win = this.ensure();
    this.visible = show !== false;
    if (this.visible) {
      win.show();
      win.focus();
    } else {
      win.hide();
    }
    return { visible: this.visible, url: win.webContents.getURL() };
  }

  async openVisible(url) {
    const win = this.ensure();
    this.visible = true;
    win.show();
    if (url && ALLOWED_PROTOCOL.test(url)) await this.navigate(url);
    win.focus();
    return { visible: true, url: win.webContents.getURL() };
  }

  async clearData() {
    const ses = session.fromPartition(PARTITION);
    await ses.clearStorageData();
    await ses.clearCache();
    this.pushLog('site data cleared');
    return { ok: true };
  }

  status() {
    const win = this.win && !this.win.isDestroyed() ? this.win : null;
    return {
      open: !!win,
      visible: !!win && win.isVisible(),
      url: win ? win.webContents.getURL() : '',
      title: win ? win.getTitle() : '',
      lastError: this.lastError,
      log: this.log.slice(-12),
    };
  }

  destroy() {
    if (this.win && !this.win.isDestroyed()) this.win.destroy();
    this.win = null;
  }
}

function safeParse(raw) {
  if (raw && typeof raw === 'object') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return { ok: false, reason: 'Не удалось разобрать ответ страницы' };
  }
}

function formatSnapshot(page, limit = 16000) {
  if (!page) return 'Пустая страница';
  if (page.error) return `Ошибка: ${page.error}`;
  const lines = [];
  lines.push(`URL: ${page.url}`);
  if (page.title) lines.push(`Title: ${page.title}`);
  if (page.action === 'click' && page.clicked) lines.push(`Клик: ${page.clicked}${page.navigated ? ' (страница сменилась)' : ''}`);
  if (page.action === 'type' && page.field) lines.push(`Поле: ${page.field}${page.submitted ? ' (отправлено)' : ''}`);
  lines.push('');
  let text = page.text || '(текста нет)';
  if (text.length > limit) text = `${text.slice(0, limit)}\n… [truncated]`;
  lines.push(text);
  if (page.inputs && page.inputs.length) {
    lines.push('', 'Поля ввода (для action="type"):');
    for (const input of page.inputs.slice(0, 12)) {
      const bits = [input.name && `name=${input.name}`, input.id && `id=${input.id}`, input.placeholder && `placeholder="${input.placeholder}"`, `type=${input.type}`].filter(Boolean);
      lines.push(`- ${bits.join(' ')}`);
    }
  }
  if (page.buttons && page.buttons.length) {
    lines.push('', `Кнопки (для action="click"): ${page.buttons.slice(0, 18).map((label) => `"${label}"`).join(', ')}`);
  }
  if (page.links && page.links.length) {
    lines.push('', 'Ссылки:');
    for (const link of page.links.slice(0, 25)) lines.push(`- ${link.text} — ${link.url}`);
  }
  return lines.join('\n');
}

module.exports = { BrowserController, formatSnapshot, ALLOWED_PROTOCOL };
