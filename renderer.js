'use strict';

/* ══════════════════════════════════════════════════════════════════════════
   Comrade Harness — renderer
   UI state lives here; everything privileged goes through window.comrade (IPC).
   ══════════════════════════════════════════════════════════════════════════ */

const api = window.comrade;
const $ = (id) => document.getElementById(id);
const h = (tag, attrs = {}, ...children) => {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'html') node.innerHTML = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else node.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children.flat()) {
    if (child === undefined || child === null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
};

const store = {
  get(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw === null ? fallback : JSON.parse(raw);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* ignore */
    }
  },
  remove(key) {
    try {
      localStorage.removeItem(key);
    } catch {
      /* ignore */
    }
  },
};

const state = {
  config: null,
  workspace: null,
  recents: [],
  suggestions: [],
  providers: [],
  activeModel: { providerId: '', modelId: '' },
  chats: [],
  activeChatId: null,
  attachments: [],
  connectors: [],
  mcp: [],
  mcpPresets: [],
  toolList: [],
  live: null,
  currentView: 'chat',
  generating: false,
  editingProviderId: null,
  editingConnector: null,
  editingMcpId: null,
  connectorMode: 'token',
  platform: 'darwin',
  sidebarCollapsed: false,
};

const ICONS = {
  spinner: '<div class="spinner"></div>',
  check: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"></polyline></svg>',
  cross: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>',
  tool: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"></path></svg>',
  brain: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M9.5 2A2.5 2.5 0 0 1 12 4.5v15a2.5 2.5 0 0 1-4.96.44 2.5 2.5 0 0 1-2.96-3.08 3 3 0 0 1-.34-5.58 2.5 2.5 0 0 1 1.32-4.24 2.5 2.5 0 0 1 1.98-3A2.5 2.5 0 0 1 9.5 2z"></path><path d="M14.5 2A2.5 2.5 0 0 0 12 4.5v15a2.5 2.5 0 0 0 4.96.44 2.5 2.5 0 0 0 2.96-3.08 3 3 0 0 0 .34-5.58 2.5 2.5 0 0 0-1.32-4.24 2.5 2.5 0 0 0-1.98-3A2.5 2.5 0 0 0 14.5 2z"></path></svg>',
  folder: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>',
  chevron: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"></polyline></svg>',
  globe: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="10"></circle><line x1="2" y1="12" x2="22" y2="12"></line><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"></path></svg>',
};

/* ───────────────────────────── markdown ───────────────────────────── */

marked.setOptions({ gfm: true, breaks: true, headerIds: false, mangle: false });

const ALLOWED_TAGS = new Set([
  'P', 'BR', 'HR', 'STRONG', 'EM', 'DEL', 'CODE', 'PRE', 'BLOCKQUOTE', 'A', 'IMG',
  'UL', 'OL', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TH', 'TD',
  'DIV', 'SPAN', 'SUP', 'SUB', 'INPUT',
]);

function sanitizeHtml(html) {
  const doc = new DOMParser().parseFromString(`<div id="root">${html}</div>`, 'text/html');
  const root = doc.getElementById('root');
  const walk = (node) => {
    for (const child of [...node.children]) {
      if (!ALLOWED_TAGS.has(child.tagName)) {
        child.replaceWith(...child.childNodes);
        continue;
      }
      for (const attr of [...child.attributes]) {
        const name = attr.name.toLowerCase();
        const value = attr.value;
        if (name.startsWith('on')) child.removeAttribute(attr.name);
        else if ((name === 'href' || name === 'src') && /^\s*(javascript|data:text\/html|vbscript):/i.test(value)) child.removeAttribute(attr.name);
        else if (name === 'style') child.removeAttribute(attr.name);
      }
      if (child.tagName === 'A') {
        child.setAttribute('target', '_blank');
        child.setAttribute('rel', 'noreferrer');
      }
      if (child.tagName === 'IMG') {
        child.setAttribute('loading', 'lazy');
      }
      walk(child);
    }
  };
  walk(root);
  return root.innerHTML;
}

function renderMarkdown(text) {
  if (!text) return '';
  try {
    return sanitizeHtml(marked.parse(text));
  } catch {
    const escaped = String(text).replace(/[&<>]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[ch]);
    return `<p>${escaped}</p>`;
  }
}

function decorateCodeBlocks(container) {
  container.querySelectorAll('pre').forEach((pre) => {
    if (pre.querySelector('.copy-code')) return;
    const button = h('button', { class: 'copy-code', type: 'button', text: 'копировать' });
    button.addEventListener('click', async () => {
      const code = pre.querySelector('code');
      const text = (code || pre).innerText;
      try {
        await navigator.clipboard.writeText(text);
        button.textContent = 'скопировано';
        setTimeout(() => {
          button.textContent = 'копировать';
        }, 1400);
      } catch {
        toast('Не удалось скопировать', 'error');
      }
    });
    pre.appendChild(button);
  });
}

/* ───────────────────────────── helpers ───────────────────────────── */

function toast(message, kind = '', timeout = 4200) {
  const host = $('toast-host');
  const node = h('div', { class: `toast ${kind}` }, h('span', { text: message }));
  const close = h('button', { class: 'toast-close', type: 'button', html: ICONS.cross });
  close.addEventListener('click', () => node.remove());
  node.appendChild(close);
  host.appendChild(node);
  setTimeout(() => node.remove(), timeout);
}

function openModal(id) {
  document.querySelectorAll('.modal').forEach((modal) => {
    if (modal.id !== id) modal.hidden = true;
  });
  const modal = $(id);
  if (modal) {
    modal.hidden = false;
    const focusable = modal.querySelector('input, textarea, select, button');
    setTimeout(() => focusable?.focus(), 30);
  }
}

function closeModal(id) {
  const modal = $(id);
  if (modal) modal.hidden = true;
}

function closeAllModals() {
  document.querySelectorAll('.modal').forEach((modal) => {
    modal.hidden = true;
  });
}

document.addEventListener('click', (event) => {
  const closer = event.target.closest('[data-close]');
  if (closer) {
    closeModal(closer.dataset.close);
    return;
  }
  if (event.target.classList.contains('modal')) closeAllModals();
  const link = event.target.closest('.msg-text a[href], .field-col a[href], .hint-box a[href]');
  if (link && /^https?:/i.test(link.getAttribute('href') || '')) {
    event.preventDefault();
    api.app.openExternal(link.getAttribute('href'));
  }
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    const open = document.querySelector('.modal:not([hidden])');
    if (open) {
      open.hidden = true;
      event.preventDefault();
    }
  }
});

function formatTime(ts) {
  if (!ts) return '';
  try {
    return new Date(ts).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

function trimPath(p, max = 42) {
  if (!p) return '';
  const homedir = state.home || '';
  let value = p;
  if (homedir && value.startsWith(homedir)) value = `~${value.slice(homedir.length)}`;
  if (value.length <= max) return value;
  const parts = value.split(/[\\/]/);
  if (parts.length <= 2) return value;
  return `${parts[0]}/…/${parts.slice(-2).join('/')}`;
}

function providerLetter(name) {
  return String(name || '?').trim().charAt(0).toUpperCase();
}

/* ───────────────────────────── workspace ───────────────────────────── */

async function loadWorkspace(withSuggestions = false) {
  const snapshot = await api.workspace.state();
  state.workspace = snapshot.workspace;
  state.recents = snapshot.recents || [];
  state.suggestions = snapshot.suggestions || [];
  state.home = snapshot.home;
  state.platform = snapshot.platform || state.platform;
  renderWorkspace();
  if (withSuggestions) renderWorkspaceModal();
}

function renderWorkspace() {
  const card = $('workspace-card');
  const ws = state.workspace;
  const empty = !ws || ws.broken;
  card.classList.toggle('has-path', !empty);
  card.classList.toggle('is-empty', empty);

  if (empty) {
    $('workspace-name').textContent = ws?.broken ? 'Папка недоступна' : 'Выбрать папку…';
    $('workspace-path').textContent = ws?.broken ? trimPath(ws.path, 40) : 'агент будет работать здесь';
    card.title = ws?.path || 'Выбрать рабочую папку';
  } else {
    $('workspace-name').textContent = ws.name;
    $('workspace-path').textContent = trimPath(ws.parent, 40);
    card.title = ws.path;
  }
  $('workspace-reveal').hidden = empty;
  $('workspace-hint').textContent = empty ? 'папка не выбрана' : ws.path;
  $('workspace-hint').title = empty ? '' : ws.path;

  const chips = $('workspace-chips');
  chips.innerHTML = '';
  if (!empty && ws.writable === false) {
    chips.appendChild(h('span', { class: 'tag', text: 'только чтение' }));
  }
  if (!empty) {
    const change = h('button', { class: 'mini-link', type: 'button', text: 'сменить' });
    change.addEventListener('click', (event) => {
      event.stopPropagation();
      openWorkspaceModal();
    });
    chips.appendChild(change);
  }
}

function openWorkspaceModal() {
  const input = $('workspace-input');
  input.value = state.workspace && !state.workspace.broken ? state.workspace.path : '';
  $('workspace-error').hidden = true;
  renderWorkspaceModal();
  openModal('modal-workspace');
  setTimeout(() => {
    input.focus();
    input.select();
  }, 40);
}

function renderWorkspaceModal() {
  const recents = $('workspace-recents');
  recents.innerHTML = '';
  if (!state.recents.length) {
    recents.appendChild(h('div', { class: 'muted small', text: 'Пока пусто — выбери папку через «Обзор…»' }));
  }
  for (const item of state.recents) {
    const button = h(
      'button',
      { class: 'recent-item', type: 'button', title: item.path },
      h('span', { class: 'tool-icon', html: ICONS.folder }),
      h('span', { class: 'recent-meta' }, h('div', { class: 'recent-name', text: item.name }), h('div', { class: 'recent-path', text: item.path })),
    );
    const remove = h('button', { class: 'recent-remove', type: 'button', title: 'Убрать из недавних', html: ICONS.cross });
    remove.addEventListener('click', async (event) => {
      event.stopPropagation();
      state.recents = await api.workspace.removeRecent(item.path);
      renderWorkspaceModal();
    });
    button.appendChild(remove);
    button.addEventListener('click', () => applyWorkspace(item.path));
    recents.appendChild(button);
  }

  const suggestions = $('workspace-suggestions');
  suggestions.innerHTML = '';
  for (const item of state.suggestions) {
    const button = h(
      'button',
      { class: 'recent-item', type: 'button', title: item.path },
      h('span', { class: 'tool-icon', html: ICONS.folder }),
      h('span', { class: 'recent-meta' }, h('div', { class: 'recent-name', text: item.label }), h('div', { class: 'recent-path', text: item.path })),
    );
    button.addEventListener('click', () => applyWorkspace(item.path));
    suggestions.appendChild(button);
  }
}

async function applyWorkspace(target) {
  const result = await api.workspace.set(target);
  if (result.error) {
    $('workspace-error').hidden = false;
    $('workspace-error').textContent = result.error;
    return false;
  }
  state.workspace = result.workspace;
  state.recents = result.recents || [];
  renderWorkspace();
  renderWorkspaceModal();
  closeModal('modal-workspace');
  toast(`Рабочая папка: ${result.workspace.name}`, 'success');
  if (result.workspace.warning) toast(result.workspace.warning, 'error');
  refreshToolsCount();
  return true;
}

function bindWorkspace() {
  $('workspace-card').addEventListener('click', openWorkspaceModal);
  $('workspace-card').addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      openWorkspaceModal();
    }
  });
  $('workspace-browse').addEventListener('click', async () => {
    const result = await api.workspace.pick();
    if (result.canceled) return;
    if (result.error) {
      $('workspace-error').hidden = false;
      $('workspace-error').textContent = result.error;
      return;
    }
    state.workspace = result.workspace;
    state.recents = result.recents || [];
    renderWorkspace();
    renderWorkspaceModal();
    closeModal('modal-workspace');
    toast(`Рабочая папка: ${result.workspace.name}`, 'success');
    refreshToolsCount();
  });
  $('workspace-apply').addEventListener('click', () => {
    const value = $('workspace-input').value.trim();
    if (value) applyWorkspace(value);
  });
  $('workspace-input').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      $('workspace-apply').click();
    }
  });
  $('workspace-clear').addEventListener('click', async () => {
    await api.workspace.clear();
    await loadWorkspace();
    closeModal('modal-workspace');
    toast('Рабочая папка сброшена');
  });
  $('workspace-reveal').addEventListener('click', (event) => {
    event.stopPropagation();
    api.workspace.reveal();
  });
  api.app.onMenuPickWorkspace(() => openWorkspaceModal());
}

/* ───────────────────────────── providers ───────────────────────────── */

const PROVIDER_PRESETS = [
  { key: 'openai', name: 'OpenAI', url: 'https://api.openai.com/v1/chat/completions', models: 'gpt-4o-mini\ngpt-4o\ngpt-4.1\no3-mini\no4-mini' },
  { key: 'deepseek', name: 'DeepSeek', url: 'https://api.deepseek.com/chat/completions', models: 'deepseek-chat\ndeepseek-reasoner' },
  {
    key: 'openrouter',
    name: 'OpenRouter',
    url: 'https://openrouter.ai/api/v1/chat/completions',
    models: 'openai/gpt-4o-mini\nanthropic/claude-3.7-sonnet\ndeepseek/deepseek-r1\ngoogle/gemini-2.0-flash-001\nqwen/qwen-2.5-72b-instruct',
  },
  { key: 'groq', name: 'Groq', url: 'https://api.groq.com/openai/v1/chat/completions', models: 'llama-3.3-70b-versatile\ndeepseek-r1-distill-llama-70b\nqwen-2.5-coder-32b' },
  { key: 'mistral', name: 'Mistral', url: 'https://api.mistral.ai/v1/chat/completions', models: 'mistral-large-latest\nmistral-small-latest\nopen-mistral-nemo' },
  {
    key: 'google',
    name: 'Google Gemini',
    url: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    models: 'gemini-2.0-flash\ngemini-2.5-pro\ngemini-2.5-flash',
  },
  { key: 'xai', name: 'xAI', url: 'https://api.x.ai/v1/chat/completions', models: 'grok-3-mini\ngrok-2-latest' },
  { key: 'together', name: 'Together', url: 'https://api.together.xyz/v1/chat/completions', models: 'meta-llama/Llama-3.3-70B-Instruct-Turbo\nQwen/Qwen2.5-Coder-32B-Instruct' },
  { key: 'ollama', name: 'Ollama (локально)', url: 'http://127.0.0.1:11434/v1/chat/completions', models: 'qwen2.5-coder:7b\nllama3.2' },
  { key: 'lmstudio', name: 'LM Studio (локально)', url: 'http://127.0.0.1:1234/v1/chat/completions', models: 'local-model' },
];

const LEGACY_SEED = {
  id: 'comrade-platform',
  name: 'Comrade Platform',
  url: 'https://d13dbe1c5c87d6.lhr.life/v1/chat/completions',
  apiKey: 'cmr-222c1dfd3c22764892bebc132c9ec9611214d3dca56ca92d',
  models: [{ id: 'comrade-pi', label: 'comrade-pi' }],
  headers: {},
};

function loadProviders() {
  const stored = store.get('comrade.providers', null);
  if (Array.isArray(stored) && stored.length) {
    state.providers = stored.map(normalizeProvider).filter(Boolean);
  } else {
    // Migrate the legacy single-model format if present.
    const legacy = store.get('providers', null);
    if (Array.isArray(legacy) && legacy.length) {
      state.providers = legacy.map((item) =>
        normalizeProvider({
          id: item.id || `p_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
          name: item.name || 'Provider',
          url: item.url,
          apiKey: item.apiKey,
          models: item.model ? [{ id: item.model, label: item.model }] : [],
        }),
      );
    } else {
      state.providers = [normalizeProvider(LEGACY_SEED)];
    }
  }
  const savedModel = store.get('comrade.activeModel', null);
  if (savedModel && savedModel.providerId && savedModel.modelId) state.activeModel = savedModel;
  ensureActiveModel();
  store.set('comrade.providers', state.providers);
}

function normalizeProvider(item) {
  if (!item) return null;
  const models = Array.isArray(item.models)
    ? item.models
        .map((model) => {
          if (typeof model === 'string') return { id: model, label: model };
          if (!model || !model.id) return null;
          return { id: String(model.id), label: String(model.label || model.id) };
        })
        .filter(Boolean)
    : [];
  return {
    id: String(item.id || `p_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`),
    name: String(item.name || 'Provider'),
    url: String(item.url || ''),
    apiKey: String(item.apiKey || ''),
    models,
    headers: item.headers && typeof item.headers === 'object' ? item.headers : {},
  };
}

function saveProviders() {
  store.set('comrade.providers', state.providers);
  store.set('comrade.activeModel', state.activeModel);
}

function getActiveModel() {
  const provider = state.providers.find((item) => item.id === state.activeModel.providerId) || state.providers[0];
  if (!provider) return null;
  const model = provider.models.find((item) => item.id === state.activeModel.modelId) || provider.models[0];
  if (!model) return { provider, model: null };
  return { provider, model };
}

function ensureActiveModel() {
  const current = getActiveModel();
  if (!current) {
    state.activeModel = { providerId: '', modelId: '' };
    return;
  }
  state.activeModel = { providerId: current.provider.id, modelId: current.model ? current.model.id : '' };
  saveProviders();
}

function selectModel(providerId, modelId) {
  state.activeModel = { providerId, modelId };
  saveProviders();
  renderModelPickerLabel();
  renderProviders();
  closeModal('modal-models');
}

function renderModelPickerLabel(extra) {
  const current = getActiveModel();
  const label = $('model-label');
  const hint = $('provider-hint');
  const dot = document.querySelector('.model-dot');
  if (!current || !current.model) {
    label.textContent = 'Модель не выбрана';
    hint.textContent = state.providers.length ? 'выбери модель' : 'добавь провайдера';
    dot.classList.add('offline');
    return;
  }
  label.textContent = current.model.label || current.model.id;
  const providerHintText = `${current.provider.name}${extra ? ` · ${extra}` : ''}`;
  hint.textContent = providerHintText;
  dot.classList.remove('offline');
}

async function renderProviders() {
  const list = $('provider-list');
  list.innerHTML = '';
  $('providers-empty').hidden = state.providers.length > 0;
  if (!state.providers.length) return;

  for (const provider of state.providers) {
    const current = getActiveModel();
    const card = h('div', { class: `provider-card ${current && current.provider.id === provider.id ? 'active-provider' : ''}` });
    card.appendChild(h('div', { class: 'provider-avatar', text: providerLetter(provider.name) }));

    const main = h('div', { class: 'provider-main' });
    const nameRow = h('div', { class: 'provider-name' }, provider.name);
    if (current && current.provider.id === provider.id) nameRow.appendChild(h('span', { class: 'tag', text: 'активный' }));
    if (!provider.apiKey) nameRow.appendChild(h('span', { class: 'tag', text: 'без ключа' }));
    main.appendChild(nameRow);
    main.appendChild(h('div', { class: 'provider-url', text: provider.url || '—' }));

    const modelsRow = h('div', { class: 'provider-models' });
    if (!provider.models.length) modelsRow.appendChild(h('span', { class: 'muted small', text: 'модели не добавлены' }));
    for (const model of provider.models) {
      const isCurrent = current && current.provider.id === provider.id && current.model && current.model.id === model.id;
      const chip = h('button', { class: 'model-chip' + (isCurrent ? ' current' : ''), type: 'button', text: model.label || model.id, title: model.id });
      chip.addEventListener('click', () => selectModel(provider.id, model.id));
      modelsRow.appendChild(chip);
    }
    main.appendChild(modelsRow);
    card.appendChild(main);

    const actions = h('div', { class: 'provider-actions' });
    const edit = h('button', { class: 'ghost-btn', type: 'button', text: 'Изменить' });
    edit.addEventListener('click', () => openProviderModal(provider));
    const remove = h('button', { class: 'ghost-btn danger', type: 'button', text: 'Удалить' });
    remove.addEventListener('click', () => {
      if (!confirm(`Удалить провайдера «${provider.name}»?`)) return;
      state.providers = state.providers.filter((item) => item.id !== provider.id);
      ensureActiveModel();
      saveProviders();
      renderProviders();
      renderModelPickerLabel();
      renderModelList();
    });
    actions.append(edit, remove);
    card.appendChild(actions);
    list.appendChild(card);
  }
}

function openProviderModal(provider = null) {
  state.editingProviderId = provider ? provider.id : null;
  $('provider-modal-title').textContent = provider ? 'Изменить провайдера' : 'Новый провайдер';
  $('provider-name').value = provider?.name || '';
  $('provider-url').value = provider?.url || '';
  $('provider-key').value = provider?.apiKey || '';
  $('provider-models').value = provider ? provider.models.map((model) => (model.label && model.label !== model.id ? `${model.id} = ${model.label}` : model.id)).join('\n') : '';
  $('provider-headers').value = provider && Object.keys(provider.headers || {}).length ? JSON.stringify(provider.headers) : '';
  $('provider-models-status').textContent = '';
  renderProviderPresets();
  openModal('modal-provider');
}

function renderProviderPresets() {
  const row = $('provider-presets');
  row.innerHTML = '';
  for (const preset of PROVIDER_PRESETS) {
    const chip = h('button', { class: 'preset-chip', type: 'button', text: preset.name });
    chip.addEventListener('click', () => {
      $('provider-name').value = preset.name;
      $('provider-url').value = preset.url;
      $('provider-models').value = preset.models;
      $('provider-key').focus();
    });
    row.appendChild(chip);
  }
}

function parseModelsInput(value) {
  return String(value || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [id, ...rest] = line.split('=');
      const modelId = id.trim();
      const label = rest.join('=').trim();
      return { id: modelId, label: label || modelId };
    });
}

async function loadModelsFromApi() {
  const url = $('provider-url').value.trim();
  const apiKey = $('provider-key').value.trim();
  const status = $('provider-models-status');
  if (!url) {
    status.textContent = 'Сначала заполни API URL';
    return;
  }
  status.textContent = 'Запрашиваю список моделей…';
  const result = await api.providers.listModels({ url, apiKey });
  if (result.error) {
    status.textContent = result.error;
    return;
  }
  const textarea = $('provider-models');
  const existing = new Set(parseModelsInput(textarea.value).map((model) => model.id));
  const merged = [...existing];
  for (const model of result.models) {
    if (!merged.includes(model.id)) merged.push(model.id);
  }
  textarea.value = merged.join('\n');
  status.textContent = `Загружено моделей: ${result.models.length} (${result.endpoint})`;
}

function saveProviderFromModal() {
  const name = $('provider-name').value.trim();
  const url = $('provider-url').value.trim();
  const apiKey = $('provider-key').value.trim();
  const models = parseModelsInput($('provider-models').value);
  let headers = {};
  const headersRaw = $('provider-headers').value.trim();
  if (headersRaw) {
    try {
      headers = JSON.parse(headersRaw);
    } catch {
      toast('Доп. заголовки должны быть корректным JSON', 'error');
      return;
    }
  }
  if (!name || !url) {
    toast('Нужны название и API URL', 'error');
    return;
  }
  if (!models.length) {
    toast('Добавь хотя бы одну модель', 'error');
    return;
  }
  if (state.editingProviderId) {
    const provider = state.providers.find((item) => item.id === state.editingProviderId);
    if (provider) Object.assign(provider, { name, url, apiKey, models, headers });
  } else {
    state.providers.push(normalizeProvider({ id: `p_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`, name, url, apiKey, models, headers }));
  }
  ensureActiveModel();
  saveProviders();
  renderProviders();
  renderModelPickerLabel();
  renderModelList();
  closeModal('modal-provider');
  toast(`Провайдер «${name}» сохранён`, 'success');
}

function renderModelList(filter = '') {
  const container = $('model-list');
  container.innerHTML = '';
  const needle = filter.trim().toLowerCase();
  const current = getActiveModel();
  let total = 0;
  for (const provider of state.providers) {
    const models = provider.models.filter((model) => !needle || `${model.id} ${model.label}`.toLowerCase().includes(needle));
    if (!models.length) continue;
    total += models.length;
    container.appendChild(h('div', { class: 'model-group-label', text: provider.name }));
    for (const model of models) {
      const isCurrent = current && current.provider.id === provider.id && current.model && current.model.id === model.id;
      const item = h(
        'button',
        { class: 'model-item' + (isCurrent ? ' current' : ''), type: 'button' },
        h('span', { class: 'model-dot' + (provider.apiKey ? '' : ' offline') }),
        h('span', { text: model.label || model.id }),
      );
      if (isCurrent) item.appendChild(h('span', { class: 'check', html: ICONS.check }));
      item.addEventListener('click', () => selectModel(provider.id, model.id));
      container.appendChild(item);
    }
  }
  if (!total) {
    container.appendChild(h('div', { class: 'muted small', text: state.providers.length ? 'Ничего не найдено' : 'Провайдеры не добавлены' }));
  }
  if (!state.providers.length) {
    const add = h('button', { class: 'ghost-btn', type: 'button', text: 'Добавить провайдера' });
    add.style.marginTop = '10px';
    add.addEventListener('click', () => {
      closeModal('modal-models');
      switchView('providers');
      openProviderModal();
    });
    container.appendChild(add);
  }
}

function bindProviders() {
  $('add-provider').addEventListener('click', () => openProviderModal());
  $('provider-save').addEventListener('click', saveProviderFromModal);
  $('provider-load-models').addEventListener('click', loadModelsFromApi);
  $('model-picker').addEventListener('click', () => {
    renderModelList($('model-search').value);
    openModal('modal-models');
    setTimeout(() => $('model-search').focus(), 40);
  });
  $('model-search').addEventListener('input', (event) => renderModelList(event.target.value));
  $('model-manage').addEventListener('click', () => {
    closeModal('modal-models');
    switchView('providers');
  });
}

/* ───────────────────────────── chat state ───────────────────────────── */

const DEFAULT_SYSTEM_PROMPT = [
  'You are Comrade, a capable AI agent working inside a local desktop harness on the user\'s computer.',
  'You are NOT Claude, ChatGPT, Gemini or any other assistant — never claim to be one of them.',
  '',
  'You have real tools. Use them instead of guessing:',
  '- File tools (read_file, write_file, edit_file, list_dir) work with absolute paths or paths relative to the workspace.',
  '- web_search searches the live internet. read_url fetches a page over HTTP (fast, no JavaScript).',
  '- browser opens pages in a real Chromium session with JavaScript, cookies and logins.',
  '- MCP and service tools act on behalf of the user in connected services.',
  '',
  'Rules:',
  '1. Think step by step before acting. Keep the final answer concise and concrete.',
  '2. Do not invent URLs, file contents or API results — verify with tools.',
  '3. If a tool returns an error, do not retry the same call endlessly (max 2 attempts).',
  '4. When you write code or files, write the complete content, not placeholders.',
  '5. Format answers with markdown. Use fenced code blocks with a language tag.',
].join('\n');

function loadChats() {
  state.chats = store.get('comrade.chats', []) || [];
  state.activeChatId = store.get('comrade.activeChatId', null);
  if (!Array.isArray(state.chats)) state.chats = [];
  state.chats = state.chats.filter((chat) => chat && Array.isArray(chat.messages));
  if (!state.chats.length) {
    createChat({ silent: true });
  } else if (!getActiveChat()) {
    state.activeChatId = state.chats[0].id;
  }
}

function saveChats() {
  store.set('comrade.chats', state.chats);
  store.set('comrade.activeChatId', state.activeChatId);
}

function getActiveChat() {
  return state.chats.find((chat) => chat.id === state.activeChatId) || null;
}

function createChat({ silent = false } = {}) {
  const id = `c_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const chat = {
    id,
    title: 'Новый чат',
    messages: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  state.chats.unshift(chat);
  state.activeChatId = id;
  saveChats();
  if (!silent) {
    renderChatHistory();
    renderMessages();
    $('input').focus();
  }
  return chat;
}

function switchChat(id) {
  if (state.generating) {
    toast('Дождись ответа или останови генерацию', 'error');
    return;
  }
  state.activeChatId = id;
  saveChats();
  renderChatHistory();
  renderMessages();
}

function deleteChat(id) {
  state.chats = state.chats.filter((chat) => chat.id !== id);
  if (state.activeChatId === id) {
    if (state.chats.length) state.activeChatId = state.chats[0].id;
    else createChat({ silent: true });
  }
  saveChats();
  renderChatHistory();
  renderMessages();
}

function renderChatHistory() {
  const list = $('chat-history');
  list.innerHTML = '';
  if (!state.chats.length) {
    list.appendChild(h('div', { class: 'history-empty', text: 'Нет чатов' }));
    return;
  }
  const sorted = [...state.chats].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  for (const chat of sorted) {
    const item = h(
      'div',
      { class: 'history-item' + (chat.id === state.activeChatId ? ' active' : ''), role: 'button', tabindex: '0' },
      h('span', { class: 'history-title', text: chat.title || 'Новый чат', title: chat.title || '' }),
    );
    const del = h('button', { class: 'history-delete', type: 'button', title: 'Удалить чат', html: ICONS.cross });
    del.addEventListener('click', (event) => {
      event.stopPropagation();
      deleteChat(chat.id);
    });
    item.appendChild(del);
    item.addEventListener('click', () => switchChat(chat.id));
    item.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') switchChat(chat.id);
    });
    list.appendChild(item);
  }
}

/* ───────────────────────────── message rendering ───────────────────────────── */

function isToolMessage(message) {
  return message.role === 'tool' || (message.role === 'function');
}

function toolMeta(name) {
  const registry = {
    read_file: { label: 'Чтение файла', icon: '📄' },
    write_file: { label: 'Запись файла', icon: '💾' },
    edit_file: { label: 'Правка файла', icon: '✏️' },
    list_dir: { label: 'Список файлов', icon: '📁' },
    web_search: { label: 'Поиск в сети', icon: '🔎' },
    read_url: { label: 'Загрузка страницы', icon: '🌐' },
    browser: { label: 'Браузер', icon: '🧭' },
  };
  if (registry[name]) return registry[name];
  if (String(name).startsWith('mcp_')) return { label: name.replace(/^mcp_[^_]+_/, '').replace(/_/g, ' '), icon: '🔌' };
  return { label: String(name || '').replace(/_/g, ' '), icon: '🛠' };
}

function summarizeArgs(args) {
  if (!args || typeof args !== 'object') return '';
  const entries = Object.entries(args);
  if (!entries.length) return '';
  const parts = entries.map(([key, value]) => {
    let text = typeof value === 'string' ? value : JSON.stringify(value);
    if (text === undefined) text = '';
    if (text.length > 70) text = `${text.slice(0, 70)}…`;
    return `${key}: ${text.replace(/\s+/g, ' ')}`;
  });
  return parts.join(' · ');
}

function buildToolCard({ name, args, content, isError, status = 'done', durationMs }) {
  const meta = toolMeta(name);
  const card = h('div', { class: 'tool-card collapsed' + (isError ? ' is-error' : '') });
  const head = h('div', { class: 'tool-card-head' });
  const iconWrap = h('span', { class: `tool-icon ${status === 'running' ? '' : isError ? 'err' : 'ok'}` });
  iconWrap.innerHTML = status === 'running' ? ICONS.spinner : isError ? ICONS.cross : ICONS.check;
  const argsText = summarizeArgs(args);
  head.append(
    iconWrap,
    h('span', { class: 'tool-name', text: meta.label }),
    h('span', { class: 'tool-args', text: argsText, title: argsText }),
    h(
      'span',
      { class: 'tool-status' },
      status === 'running' ? 'выполняется…' : durationMs ? `${(durationMs / 1000).toFixed(1)} с` : '',
      h('span', { class: 'tool-icon', html: ICONS.chevron }),
    ),
  );
  head.addEventListener('click', () => card.classList.toggle('collapsed'));
  const body = h('div', { class: 'tool-body', text: content || '' });
  card.append(head, body);
  card._update = ({ isError: err, content: text, durationMs: ms }) => {
    card.classList.toggle('is-error', !!err);
    iconWrap.className = `tool-icon ${err ? 'err' : 'ok'}`;
    iconWrap.innerHTML = err ? ICONS.cross : ICONS.check;
    head.querySelector('.tool-status').firstChild.textContent = ms ? `${(ms / 1000).toFixed(1)} с` : 'готово';
    body.textContent = text || '';
    if (err) card.classList.remove('collapsed');
  };
  return card;
}

function buildThinkingBlock(text, { collapsed = true, streaming = false, chars = 0 } = {}) {
  const block = h('div', { class: 'thinking' + (collapsed ? ' collapsed' : '') + (streaming ? ' thinking-streaming' : '') });
  const head = h('div', { class: 'thinking-head' });
  const icon = h('span', { class: 'tool-icon' });
  icon.innerHTML = ICONS.brain;
  const label = h('span', { class: 'thinking-label', text: 'Размышление' });
  const count = h('span', { class: 'thinking-count', text: chars ? `${chars} симв.` : '' });
  const chevron = h('span', { class: 'chevron', html: ICONS.chevron });
  head.append(icon, label, count, chevron);
  const body = h('div', { class: 'thinking-body', text });
  head.addEventListener('click', () => block.classList.toggle('collapsed'));
  block.append(head, body);
  block._setText = (value, streamingFlag) => {
    body.textContent = value;
    count.textContent = value ? `${value.length.toLocaleString('ru-RU')} симв.` : '';
    block.classList.toggle('thinking-streaming', !!streamingFlag);
    if (body.scrollHeight > body.clientHeight) body.scrollTop = body.scrollHeight;
  };
  block._setStreaming = (flag) => block.classList.toggle('thinking-streaming', !!flag);
  block.scrollToEnd = () => {
    body.scrollTop = body.scrollHeight;
  };
  block._setText(text, streaming);
  return block;
}

function buildAssistantNode(message) {
  const node = h('div', { class: 'msg assistant' });
  if (message.reasoning) {
    node.appendChild(buildThinkingBlock(message.reasoning, { collapsed: true }));
  }
  const content = typeof message.content === 'string' ? message.content : '';
  if (content.trim()) {
    const text = h('div', { class: 'msg-text', html: renderMarkdown(content) });
    decorateCodeBlocks(text);
    node.appendChild(text);
  }
  const meta = h('div', { class: 'msg-meta' });
  const modelLabel = message.modelLabel || '';
  if (modelLabel) meta.appendChild(h('span', { text: modelLabel }));
  if (message.createdAt) meta.appendChild(h('span', { text: formatTime(message.createdAt) }));
  const copy = h('button', { class: 'meta-btn', type: 'button', text: 'копировать' });
  copy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(content);
      copy.textContent = 'скопировано';
      setTimeout(() => {
        copy.textContent = 'копировать';
      }, 1200);
    } catch {
      toast('Не удалось скопировать', 'error');
    }
  });
  meta.appendChild(copy);
  node.appendChild(meta);
  return node;
}

function buildWelcome() {
  const wrap = h('div', { class: 'welcome' });
  wrap.appendChild(h('h1', { class: 'welcome-title', text: 'Into the Unknown' }));
  wrap.appendChild(
    h('p', {
      class: 'welcome-text',
      text: 'Comrade работает в твоей папке, ходит по сайтам, помнит размышления модели и может действовать в твоих сервисах через плагины.',
    }),
  );
  const ws = state.workspace;
  const wsCard = h(
    'div',
    { class: 'welcome-workspace', role: 'button', tabindex: '0' },
    h('span', { class: 'workspace-icon', html: ICONS.folder }),
    h(
      'div',
      {},
      h('div', { text: ws && !ws.broken ? `Рабочая папка: ${ws.path}` : 'Выбери рабочую папку — агент будет работать в ней' }),
      h('div', { class: 'muted small', text: ws && !ws.broken ? 'нажми, чтобы сменить' : 'нажми, чтобы выбрать' }),
    ),
  );
  wsCard.addEventListener('click', openWorkspaceModal);
  wsCard.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') openWorkspaceModal();
  });
  wrap.appendChild(wsCard);

  const suggestions = h('div', { class: 'welcome-actions' });
  const samples = [
    'Посмотри, что в рабочей папке, и предложи план',
    'Найди в интернете свежие новости по теме и сделай выжимку',
    'Проверь мой GitHub и покажи открытые issues',
  ];
  for (const sample of samples) {
    const button = h('button', { class: 'suggestion', type: 'button', text: sample });
    button.addEventListener('click', () => {
      $('input').value = sample;
      autoGrowInput();
      $('input').focus();
    });
    suggestions.appendChild(button);
  }
  wrap.appendChild(suggestions);
  return wrap;
}

function renderMessages() {
  const container = $('messages');
  container.innerHTML = '';
  const chat = getActiveChat();
  if (!chat || !chat.messages.length) {
    container.appendChild(buildWelcome());
    return;
  }

  let index = 0;
  while (index < chat.messages.length) {
    const message = chat.messages[index];
    if (message.role === 'user') {
      container.appendChild(h('div', { class: 'msg user' }, h('div', { class: 'msg-bubble', text: message.content || '' })));
      index += 1;
      continue;
    }
    if (message.role === 'system') {
      container.appendChild(h('div', { class: 'msg system' }, h('div', { class: 'msg-bubble', text: message.content || '' })));
      index += 1;
      continue;
    }
    if (message.role === 'assistant') {
      const hasContent = (message.content || '').trim();
      const hasReasoning = (message.reasoning || '').trim();
      const hasCalls = Array.isArray(message.tool_calls) && message.tool_calls.length;
      // Collect the tool results that follow this assistant message.
      const toolMessages = [];
      let cursor = index + 1;
      while (cursor < chat.messages.length && isToolMessage(chat.messages[cursor])) {
        toolMessages.push(chat.messages[cursor]);
        cursor += 1;
      }
      if (hasContent || hasReasoning || toolMessages.length) {
        const node = buildAssistantNode({ ...message, content: hasContent ? message.content : '' });
        for (const tool of toolMessages) {
          node.appendChild(buildToolCard({ name: tool.name, args: tool.args || parseMaybeJson(tool.argsRaw), content: tool.content, isError: /^Error:/.test(tool.content || '') }));
        }
        container.appendChild(node);
      }
      index = cursor;
      continue;
    }
    if (isToolMessage(message)) {
      container.appendChild(buildToolCard({ name: message.name, args: message.args, content: message.content, isError: /^Error:/.test(message.content || '') }));
      index += 1;
      continue;
    }
    index += 1;
  }
  scrollToBottom(true);
}

function parseMaybeJson(value) {
  if (!value) return null;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return { raw: value };
  }
}

function scrollToBottom(force = false) {
  const scroller = $('messages-scroll');
  if (!scroller) return;
  const distance = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
  if (force || distance < 160) scroller.scrollTop = scroller.scrollHeight;
}

/* ───────────────────────────── live turn ───────────────────────────── */

function createLiveTurn(requestId) {
  const chat = getActiveChat();
  if (!chat) return null;
  const container = $('messages');
  if (container.querySelector('.welcome')) container.innerHTML = '';
  const node = h('div', { class: 'msg assistant live' });
  container.appendChild(node);
  const status = h('div', { class: 'status-row' });
  node.appendChild(status);

  const live = {
    requestId,
    node,
    status,
    thinkingEl: null,
    thinkingText: '',
    textEl: null,
    textRaw: '',
    contentRaw: '',
    reasoningRaw: '',
    toolCards: new Map(),
    startedAt: Date.now(),
    renderScheduled: false,
    usage: null,
    steps: 0,
    maxSteps: 0,
    firstTokenAt: 0,
  };
  state.live = live;
  setLiveStatus('Думаю…');
  scrollToBottom(true);
  return live;
}

function setLiveStatus(text, detail = '') {
  const live = state.live;
  if (!live) return;
  live.status.innerHTML = '';
  live.status.append(h('span', { class: 'spinner' }), h('span', { text }));
  if (detail) live.status.appendChild(h('span', { class: 'status-detail', text: detail }));
  if (!live.status.parentElement) live.node.appendChild(live.status);
  else live.node.appendChild(live.status);
  scrollToBottom();
}

function hideLiveStatus() {
  const live = state.live;
  if (!live) return;
  live.status.remove();
}

function ensureThinkingBlock() {
  const live = state.live;
  if (!live) return null;
  if (!live.thinkingEl) {
    live.thinkingEl = buildThinkingBlock('', { collapsed: false, streaming: true });
    live.node.insertBefore(live.thinkingEl, live.status);
  }
  return live.thinkingEl;
}

function ensureTextBlock() {
  const live = state.live;
  if (!live) return null;
  if (!live.textEl) {
    live.textEl = h('div', { class: 'msg-text' });
    live.node.insertBefore(live.textEl, live.status);
  }
  return live.textEl;
}

function splitReasoningTags(text) {
  if (!/<(thinking|think|reasoning)>/i.test(text)) return { reasoning: '', content: text };
  let reasoning = '';
  let content = '';
  let index = 0;
  while (index < text.length) {
    const rest = text.slice(index);
    const openMatch = /<(?:thinking|think|reasoning)>/i.exec(rest);
    if (!openMatch) {
      content += rest;
      break;
    }
    content += rest.slice(0, openMatch.index);
    const start = index + openMatch.index + openMatch[0].length;
    const tail = text.slice(start);
    const closeMatch = /<\/(?:thinking|think|reasoning)>/i.exec(tail);
    if (!closeMatch) {
      reasoning += tail;
      index = text.length;
      break;
    }
    reasoning += tail.slice(0, closeMatch.index);
    index = start + closeMatch.index + closeMatch[0].length;
  }
  return { reasoning: reasoning.trim(), content };
}

function scheduleLiveTextRender() {
  const live = state.live;
  if (!live || live.renderScheduled) return;
  live.renderScheduled = true;
  setTimeout(() => {
    live.renderScheduled = false;
    if (!state.live || state.live !== live || !live.textEl) return;
    live.textEl.innerHTML = renderMarkdown(live.contentRaw);
    scrollToBottom();
  }, 60);
}

function appendReasoningDelta(text) {
  const live = state.live;
  if (!live || !text) return;
  live.reasoningRaw += text;
  const block = ensureThinkingBlock();
  block._setText(live.reasoningRaw, true);
  block.scrollToEnd();
  scrollToBottom();
}

function appendContentDelta(text) {
  const live = state.live;
  if (!live || !text) return;
  live.textRaw += text;
  const split = splitReasoningTags(live.textRaw);
  if (split.reasoning) {
    live.reasoningRaw = split.reasoning;
    const block = ensureThinkingBlock();
    block._setText(split.reasoning, !split.content);
    block.scrollToEnd();
  }
  live.contentRaw = split.content;
  if (live.contentRaw.trim()) {
    ensureTextBlock();
    scheduleLiveTextRender();
  }
  scrollToBottom();
}

async function sendMessage() {
  if (state.generating) {
    stopGenerating();
    return;
  }
  const input = $('input');
  let text = input.value.trim();
  if (!text && !state.attachments.length) return;

  const chat = getActiveChat() || createChat({ silent: true });
  const current = getActiveModel();
  if (!current || !current.model) {
    toast('Сначала выбери модель', 'error');
    renderModelList('');
    openModal('modal-models');
    return;
  }

  let fullText = text;
  if (state.attachments.length) {
    const blocks = state.attachments.map((file) => `--- ${file.name} (${file.path}) ---\n${file.content}`).join('\n\n');
    fullText = blocks + (text ? `\n\n${text}` : '');
  }

  chat.messages.push({ role: 'user', content: fullText, createdAt: Date.now() });
  if (!chat.title || chat.title === 'Новый чат') {
    const firstLine = (text || state.attachments.map((file) => file.name).join(', ')).split('\n')[0];
    chat.title = firstLine.slice(0, 48) || 'Новый чат';
  }
  chat.updatedAt = Date.now();
  input.value = '';
  autoGrowInput();
  state.attachments = [];
  renderAttachments();
  saveChats();
  renderChatHistory();
  renderMessages();

  state.generating = true;
  $('send').classList.add('stopping');
  $('composer').classList.add('generating');

  const requestId = `r_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const live = createLiveTurn(requestId);
  const config = state.config || {};
  const agentCfg = config.agent || {};

  const payload = {
    requestId,
    provider: { url: current.provider.url, apiKey: current.provider.apiKey, headers: current.provider.headers || {} },
    model: current.model.id,
    messages: historyForModel(chat),
    systemPrompt: config.systemPrompt || DEFAULT_SYSTEM_PROMPT,
    temperature: Number.isFinite(agentCfg.temperature) ? agentCfg.temperature : 0.7,
    maxTokens: Number.isFinite(agentCfg.maxTokens) ? agentCfg.maxTokens : 4096,
    maxSteps: Number.isFinite(agentCfg.maxSteps) ? agentCfg.maxSteps : 24,
    extraContext: buildExtraContext(),
    modelLabel: `${current.provider.name} · ${current.model.label || current.model.id}`,
  };

  let result;
  try {
    result = await api.agent.run(payload);
  } catch (error) {
    result = { error: error.message };
  }
  finishTurn(result, { aborted: !!result?.aborted, chat });
}

function buildExtraContext() {
  const lines = [];
  const connected = state.connectors.filter((connector) => connector.connected);
  if (connected.length) lines.push(`Connected services (tools available): ${connected.map((item) => `${item.name} as ${item.account || 'user'}`).join(', ')}`);
  const mcpRunning = state.mcp.filter((server) => server.running);
  if (mcpRunning.length) lines.push(`Running MCP servers: ${mcpRunning.map((server) => server.name).join(', ')}`);
  if (state.workspace && !state.workspace.broken) lines.push(`Selected workspace: ${state.workspace.path}`);
  return lines.join('\n');
}

function historyForModel(chat) {
  const messages = chat.messages
    .filter((message) => ['user', 'assistant', 'tool'].includes(message.role))
    .map((message) => {
      const clean = { role: message.role };
      if (message.role === 'assistant') {
        clean.content = message.content || null;
        if (message.tool_calls) clean.tool_calls = message.tool_calls;
      } else if (message.role === 'tool') {
        clean.tool_call_id = message.tool_call_id;
        clean.name = message.name;
        clean.content = message.content;
      } else {
        clean.content = message.content;
      }
      return clean;
    });
  // Keep the context bounded: keep the system-relevant start and the most recent turns.
  const MAX = 70;
  if (messages.length <= MAX) return messages;
  const head = messages.slice(0, 2);
  const tail = messages.slice(-(MAX - 2));
  // Never start the tail with an orphan tool message.
  while (tail.length && tail[0].role === 'tool') tail.shift();
  return [...head, ...tail];
}

function finishTurn(result, { aborted, chat } = {}) {
  const live = state.live;
  state.generating = false;
  $('send').classList.remove('stopping');
  $('composer').classList.remove('generating');

  if (live) {
    if (live.thinkingEl) live.thinkingEl._setStreaming(false);
    hideLiveStatus();
  }

  const newMessages = Array.isArray(result?.messages) ? result.messages : [];
  const modelLabel = getActiveModel() ? `${getActiveModel().provider.name} · ${(getActiveModel().model?.label || getActiveModel().model?.id) || ''}` : '';
  for (const message of newMessages) {
    if (message.role === 'assistant' && message.content === null && !message.reasoning && !message.tool_calls) continue;
    chat.messages.push({ ...message, createdAt: Date.now(), modelLabel });
  }

  if (aborted && live && live.textRaw.trim()) {
    // Preserve the partially streamed answer.
    chat.messages.push({
      role: 'assistant',
      content: live.contentRaw || live.textRaw,
      reasoning: live.reasoningRaw || '',
      createdAt: Date.now(),
      modelLabel,
    });
  }

  if (result?.usage) chat.lastUsage = result.usage;
  if (result?.error) {
    chat.messages.push({ role: 'system', content: `Ошибка провайдера: ${result.error}`, createdAt: Date.now() });
    toast('Ошибка запроса к модели', 'error');
  }
  if (result?.limitReached) {
    chat.messages.push({ role: 'system', content: `Достигнут лимит шагов (${result.steps}). Можно продолжить новым сообщением.`, createdAt: Date.now() });
  }
  if (aborted && !result?.error) {
    chat.messages.push({ role: 'system', content: 'Генерация остановлена.', createdAt: Date.now() });
  }

  chat.updatedAt = Date.now();
  saveChats();
  state.live = null;
  renderChatHistory();
  renderMessages();
  scrollToBottom(true);
  refreshToolsCount();
  $('input').focus();
}

function stopGenerating() {
  const live = state.live;
  if (!live) return;
  api.agent.abort(live.requestId);
  if (live.thinkingEl) live.thinkingEl._setStreaming(false);
  setLiveStatus('Останавливаю…');
}

function handleAgentEvent(event) {
  const live = state.live;
  if (!live || event.requestId !== live.requestId) return;
  switch (event.type) {
    case 'step':
      live.steps = event.step;
      live.maxSteps = event.maxSteps;
      setLiveStatus('Думаю…', `шаг ${event.step}/${event.maxSteps}`);
      break;
    case 'status':
      if (event.status === 'request') setLiveStatus('Запрос к модели…');
      else if (event.status === 'non-stream') setLiveStatus('Поток недоступен — жду полный ответ…');
      break;
    case 'retry':
      setLiveStatus(`Повтор запроса (${event.attempt})…`, event.message?.slice(0, 80) || '');
      break;
    case 'first-token':
      if (!live.firstTokenAt) {
        live.firstTokenAt = Date.now();
        const latency = ((Date.now() - live.startedAt) / 1000).toFixed(1);
        setLiveStatus('Печатает…', `${latency} с`);
      }
      break;
    case 'reasoning':
      appendReasoningDelta(event.text);
      break;
    case 'reasoning-done':
      if (live.thinkingEl) live.thinkingEl._setStreaming(false);
      break;
    case 'content':
      appendContentDelta(event.text);
      break;
    case 'tool-start': {
      live.textEl = null;
      live.textRaw = '';
      live.contentRaw = '';
      const card = buildToolCard({ name: event.name, args: event.args, content: '', isError: false, status: 'running' });
      live.node.insertBefore(card, live.status);
      live.toolCards.set(event.id, card);
      setLiveStatus(`Инструмент: ${toolMeta(event.name).label}`);
      scrollToBottom();
      break;
    }
    case 'tool-result': {
      const card = live.toolCards.get(event.id);
      if (card && card._update) card._update({ isError: event.isError, content: event.content, durationMs: event.durationMs });
      setLiveStatus(event.isError ? 'Инструмент вернул ошибку' : 'Продолжаю…');
      live.reasoningRaw = '';
      live.thinkingRaw = '';
      if (live.thinkingEl) {
        live.thinkingEl._setStreaming(false);
        live.thinkingEl = null;
      }
      break;
    }
    case 'usage':
      live.usage = event.usage;
      break;
    case 'warning':
      toast(event.message);
      break;
    case 'limit':
      hideLiveStatus();
      break;
    case 'error':
      setLiveStatus('Ошибка');
      live.node.appendChild(h('div', { class: 'msg-text', html: renderMarkdown(`**Ошибка:** ${event.message}`) }));
      break;
    default:
      break;
  }
}

function autoGrowInput() {
  const input = $('input');
  input.style.height = 'auto';
  input.style.height = `${Math.min(220, input.scrollHeight)}px`;
}

function renderAttachments() {
  const host = $('attachments');
  host.innerHTML = '';
  state.attachments.forEach((file, index) => {
    const chip = h(
      'div',
      { class: 'attachment', title: file.path },
      h('span', { text: file.name }),
      h('button', { type: 'button', html: ICONS.cross }),
    );
    chip.querySelector('button').addEventListener('click', () => {
      state.attachments.splice(index, 1);
      renderAttachments();
    });
    host.appendChild(chip);
  });
}

async function addAttachment(filePath, name) {
  if (state.attachments.some((file) => file.path === filePath)) return;
  const result = await api.fs.readText(filePath);
  if (result.error) {
    toast(`${name || 'Файл'}: ${result.error}`, 'error');
    return;
  }
  state.attachments.push({ path: result.path || filePath, name: result.name || name, content: result.content });
  renderAttachments();
}

function bindChat() {
  $('new-chat').addEventListener('click', () => createChat());
  $('clear-history').addEventListener('click', () => {
    if (!confirm('Удалить все чаты? Это действие необратимо.')) return;
    state.chats = [];
    createChat({ silent: true });
    saveChats();
    renderChatHistory();
    renderMessages();
  });
  $('send').addEventListener('click', sendMessage);
  const input = $('input');
  input.addEventListener('input', autoGrowInput);
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      sendMessage();
    }
  });
  $('attach-btn').addEventListener('click', async () => {
    const files = await api.app.pickFiles();
    for (const file of files) {
      if (file.error) toast(`${file.name}: ${file.error}`, 'error');
      else if (!state.attachments.some((item) => item.path === file.path)) state.attachments.push({ path: file.path, name: file.name, content: file.content });
    }
    renderAttachments();
  });

  api.agent.onEvent(handleAgentEvent);

  // drag & drop
  let overlay = null;
  window.addEventListener('dragover', (event) => {
    if (!event.dataTransfer) return;
    event.preventDefault();
    if (!overlay) {
      overlay = h('div', { class: 'drop-overlay' }, h('div', { class: 'drop-overlay-inner' }, h('span', { html: ICONS.folder }), 'Отпусти папку (рабочая область) или файл (вложение)'));
      document.body.appendChild(overlay);
    }
  });
  window.addEventListener('dragleave', (event) => {
    if (event.relatedTarget === null && overlay) {
      overlay.remove();
      overlay = null;
    }
  });
  window.addEventListener('drop', async (event) => {
    event.preventDefault();
    if (overlay) {
      overlay.remove();
      overlay = null;
    }
    const files = [...(event.dataTransfer?.files || [])];
    for (const file of files) {
      const filePath = api.app.getPathForFile(file);
      if (!filePath) continue;
      const info = await api.workspace.describe(filePath);
      if (info.isDirectory) {
        await applyWorkspace(filePath);
        break;
      }
      await addAttachment(filePath, file.name);
    }
  });
}

/* ───────────────────────────── plugins: services ───────────────────────────── */

async function loadConnectors() {
  try {
    state.connectors = await api.connectors.list();
  } catch (error) {
    state.connectors = [];
  }
  renderConnectors();
  refreshToolsCount();
  updatePluginsBadge();
}

function updatePluginsBadge() {
  const count = state.connectors.filter((connector) => connector.connected).length + state.mcp.filter((server) => server.running).length;
  const badge = $('plugins-badge');
  badge.hidden = count === 0;
  badge.textContent = String(count);
}

function renderConnectors() {
  const grid = $('connector-grid');
  grid.innerHTML = '';
  if (!state.connectors.length) {
    grid.appendChild(h('div', { class: 'muted small', text: 'Коннекторы не загружены' }));
    return;
  }
  for (const connector of state.connectors) {
    const card = h('div', { class: 'connector-card' + (connector.connected ? ' connected' : '') });
    const avatar = h('div', { class: 'connector-avatar', text: providerLetter(connector.name) });
    if (connector.color) {
      avatar.style.background = connector.color;
      avatar.style.color = '#101010';
    }
    const top = h('div', { class: 'connector-top' }, avatar);
    const titleWrap = h('div', {}, h('div', { class: 'connector-name' }, connector.name));
    if (connector.connected) titleWrap.firstChild.appendChild(h('span', { class: 'tag', text: 'подключено' }));
    titleWrap.appendChild(h('div', { class: 'connector-cat', text: `${connector.category} · ${connector.toolCount} инструментов` }));
    top.appendChild(titleWrap);
    card.appendChild(top);
    card.appendChild(h('div', { class: 'connector-desc', text: connector.description }));

    const foot = h('div', { class: 'connector-foot' });
    const status = h('div', { class: 'connector-status' + (connector.connected ? ' online' : '') });
    status.append(h('span', { class: 'dot' }));
    const accountText = connector.connected ? connector.account || 'аккаунт подключён' : 'не подключено';
    status.append(h('span', { class: 'account', text: accountText, title: accountText }));
    foot.appendChild(status);

    const actions = h('div', { class: 'row-actions' });
    if (connector.connected) {
      const toggle = h('label', { class: 'switch', title: connector.enabled ? 'Выключить инструменты' : 'Включить инструменты' });
      const checkbox = h('input', { type: 'checkbox' });
      checkbox.checked = !!connector.enabled;
      checkbox.addEventListener('change', async () => {
        await api.connectors.setEnabled(connector.id, checkbox.checked);
        await loadConnectors();
      });
      toggle.append(checkbox, h('span'));
      actions.appendChild(toggle);
      const disconnect = h('button', { class: 'ghost-btn danger', type: 'button', text: 'Отключить' });
      disconnect.addEventListener('click', async () => {
        if (!confirm(`Отключить ${connector.name}? Токен будет удалён.`)) return;
        await api.connectors.disconnect(connector.id);
        await loadConnectors();
        toast(`${connector.name} отключён`);
      });
      actions.appendChild(disconnect);
    } else {
      const connect = h('button', { class: 'primary-btn', type: 'button', text: 'Подключить' });
      connect.addEventListener('click', () => openConnectorModal(connector));
      actions.appendChild(connect);
    }
    foot.appendChild(actions);
    card.appendChild(foot);
    grid.appendChild(card);
  }
}

function openConnectorModal(connector) {
  state.editingConnector = connector;
  state.connectorMode = connector.auth.oauth ? 'oauth' : connector.authType === 'basic' ? 'token' : 'token';
  $('connector-avatar').textContent = providerLetter(connector.name);
  $('connector-avatar').style.background = connector.color || '';
  $('connector-avatar').style.color = connector.color ? '#101010' : '';
  $('connector-title').textContent = connector.name;
  $('connector-desc').textContent = connector.description;

  // Settings fields (e.g. Jira site domain).
  const settingsHost = $('connector-settings');
  settingsHost.innerHTML = '';
  for (const field of connector.settings || []) {
    const wrap = h('div', { class: 'field-col' });
    wrap.appendChild(h('label', { for: `connector-setting-${field.key}`, text: field.label + (field.required ? ' *' : '') }));
    const input = h('input', {
      type: 'text',
      id: `connector-setting-${field.key}`,
      placeholder: field.placeholder || '',
      value: field.value || '',
      spellcheck: 'false',
    });
    input.dataset.settingKey = field.key;
    wrap.appendChild(input);
    if (field.hint) wrap.appendChild(h('p', { class: 'muted small', text: field.hint }));
    settingsHost.appendChild(wrap);
  }

  const modesHost = $('connector-modes');
  modesHost.innerHTML = '';
  if (connector.auth.oauth) {
    modesHost.hidden = false;
    const oauthBtn = h('button', { class: 'seg' + (state.connectorMode === 'oauth' ? ' active' : ''), type: 'button', text: 'Вход через сервис' });
    const tokenBtn = h('button', { class: 'seg' + (state.connectorMode === 'token' ? ' active' : ''), type: 'button', text: connector.authType === 'basic' ? 'Email + токен' : 'Токен' });
    oauthBtn.addEventListener('click', () => {
      state.connectorMode = 'oauth';
      renderConnectorMode();
    });
    tokenBtn.addEventListener('click', () => {
      state.connectorMode = 'token';
      renderConnectorMode();
    });
    modesHost.append(oauthBtn, tokenBtn);
  } else {
    modesHost.hidden = true;
  }

  $('connector-client-id').value = connector.clientId || '';
  $('connector-client-id-label').textContent = connector.auth.oauth?.clientIdLabel || 'OAuth Client ID';
  $('connector-client-secret-label').textContent = connector.auth.oauth?.clientSecretLabel || 'OAuth Client Secret';
  $('connector-oauth-hint').textContent = connector.auth.oauth
    ? `Создай OAuth-приложение (Desktop/loopback) у провайдера и вставь Client ID. Redirect URI добавляется автоматически (127.0.0.1).${connector.auth.oauth.scopes?.length ? ` Scopes: ${connector.auth.oauth.scopes.join(', ')}` : ''}`
    : '';

  $('connector-token').value = '';
  $('connector-token').placeholder = connector.auth.tokenPlaceholder || 'вставь токен';
  $('connector-token-label').textContent = connector.auth.tokenLabel || 'Токен';
  $('connector-token-hint').textContent = connector.auth.tokenHint || '';
  $('connector-username-row').hidden = connector.authType !== 'basic';
  $('connector-username').value = connector.username || '';
  $('connector-username-label').textContent = connector.auth.usernameLabel || 'Email';
  $('connector-username').placeholder = connector.auth.usernamePlaceholder || '';

  const help = $('connector-help');
  const helpUrl = connector.auth.helpUrl || connector.auth.oauth?.clientHelpUrl || connector.docsUrl;
  help.href = helpUrl || '#';
  help.hidden = !helpUrl;
  help.textContent = helpUrl ? 'Где взять доступ →' : '';

  $('connector-progress').hidden = true;
  $('connector-submit').disabled = false;
  $('connector-submit').textContent = 'Подключить';
  renderConnectorMode();
  openModal('modal-connector');
}

function renderConnectorMode() {
  const connector = state.editingConnector;
  if (!connector) return;
  const mode = state.connectorMode;
  const oauthFields = $('connector-oauth-fields');
  const tokenFields = $('connector-token-fields');
  oauthFields.hidden = mode !== 'oauth';
  tokenFields.hidden = mode === 'oauth';
  document.querySelectorAll('#connector-modes .seg').forEach((button, index) => {
    button.classList.toggle('active', index === (mode === 'oauth' ? 0 : 1));
  });
  $('connector-submit').textContent = mode === 'oauth' ? 'Войти через сервис' : 'Подключить';
}

function readConnectorSettings() {
  const settings = {};
  document.querySelectorAll('#connector-settings [data-setting-key]').forEach((input) => {
    settings[input.dataset.settingKey] = input.value.trim();
  });
  return settings;
}

async function submitConnector() {
  const connector = state.editingConnector;
  if (!connector) return;
  const submit = $('connector-submit');
  const progress = $('connector-progress');
  const settings = readConnectorSettings();
  submit.disabled = true;

  if (state.connectorMode === 'oauth') {
    const clientId = $('connector-client-id').value.trim();
    const clientSecret = $('connector-client-secret').value.trim();
    if (!clientId) {
      toast('Нужен OAuth Client ID', 'error');
      submit.disabled = false;
      return;
    }
    progress.hidden = false;
    progress.innerHTML = '';
    progress.append(h('span', { class: 'spinner' }), h('span', { text: 'Открываю браузер…' }));
    const result = await api.connectors.connectOAuth(connector.id, { clientId, clientSecret, settings });
    if (result.error) {
      progress.hidden = false;
      progress.innerHTML = '';
      progress.append(h('span', { class: 'tool-icon err', html: ICONS.cross }), h('span', { text: result.error }));
      submit.disabled = false;
      return;
    }
    closeModal('modal-connector');
    toast(`${connector.name}: ${result.account || 'подключено'}`, 'success');
    await loadConnectors();
    return;
  }

  const token = $('connector-token').value.trim();
  const username = $('connector-username').value.trim();
  if (!token) {
    toast('Введи токен', 'error');
    submit.disabled = false;
    return;
  }
  progress.hidden = false;
  progress.innerHTML = '';
  progress.append(h('span', { class: 'spinner' }), h('span', { text: 'Проверяю доступ…' }));
  const result = await api.connectors.connectToken(connector.id, { token, username, settings, clientId: $('connector-client-id').value.trim(), clientSecret: $('connector-client-secret').value.trim() });
  submit.disabled = false;
  if (result.error) {
    progress.innerHTML = '';
    progress.append(h('span', { class: 'tool-icon err', html: ICONS.cross }), h('span', { text: result.error }));
    return;
  }
  closeModal('modal-connector');
  toast(`${connector.name}: ${result.account || 'подключено'}`, 'success');
  await loadConnectors();
}

function bindConnectorOAuthEvents() {
  api.connectors.onOAuth((payload) => {
    const connector = state.editingConnector;
    if (connector && payload.id !== connector.id) return;
    const progress = $('connector-progress');
    progress.hidden = false;
    progress.innerHTML = '';
    const icon = h('span', { class: 'tool-icon' });
    icon.innerHTML = payload.phase === 'done' ? ICONS.check : ICONS.spinner;
    progress.appendChild(icon);
    const textWrap = h('div', {}, h('div', { text: payload.message || payload.phase }));
    if (payload.authUrl) {
      const link = h('a', { class: 'auth-link', href: payload.authUrl, target: '_blank', rel: 'noreferrer', text: 'Открыть ссылку вручную' });
      link.addEventListener('click', (event) => {
        event.preventDefault();
        api.app.openExternal(payload.authUrl);
      });
      textWrap.appendChild(link);
    }
    progress.appendChild(textWrap);
  });
  api.connectors.onStatus(() => {
    loadConnectors();
  });
}

/* ───────────────────────────── plugins: MCP ───────────────────────────── */

async function loadMcp() {
  try {
    state.mcp = await api.mcp.list();
  } catch {
    state.mcp = [];
  }
  renderMcp();
  refreshToolsCount();
  updatePluginsBadge();
}

function renderMcp() {
  const list = $('mcp-list');
  list.innerHTML = '';
  if (!state.mcp.length) {
    list.appendChild(h('div', { class: 'muted small', text: 'MCP-серверы не добавлены. Нажми «Добавить MCP сервер» — там есть готовые пресеты.' }));
    return;
  }
  for (const server of state.mcp) {
    const stateClass = server.running ? 'online' : server.lastError ? 'error' : server.starting ? 'starting' : '';
    const card = h('div', { class: 'mcp-card' });
    card.appendChild(h('span', { class: `dot-state ${stateClass}` }));
    const main = h('div', { class: 'mcp-main' });
    main.appendChild(h('div', { class: 'mcp-name', text: server.name }));
    const metaText = server.transport === 'http' ? server.url : `${server.command} ${(server.args || []).join(' ')}`.trim();
    main.appendChild(h('div', { class: 'mcp-meta', text: metaText, title: metaText }));
    if (server.running && server.tools.length) {
      const tools = h('div', { class: 'mcp-tools' });
      for (const tool of server.tools.slice(0, 12)) tools.appendChild(h('span', { class: 'mcp-tool', text: tool.name, title: tool.description }));
      main.appendChild(tools);
    }
    if (server.lastError) main.appendChild(h('div', { class: 'mcp-error', text: server.lastError }));
    card.appendChild(main);

    const actions = h('div', { class: 'mcp-actions' });
    if (server.running) {
      const stop = h('button', { class: 'ghost-btn', type: 'button', text: 'Стоп' });
      stop.addEventListener('click', async () => {
        await api.mcp.stop(server.id);
        await loadMcp();
      });
      actions.appendChild(stop);
    } else {
      const start = h('button', { class: 'ghost-btn', type: 'button', text: 'Запустить' });
      start.addEventListener('click', async () => {
        start.disabled = true;
        const result = await api.mcp.start(server.id);
        if (result.error) toast(result.error, 'error');
        await loadMcp();
      });
      actions.appendChild(start);
    }
    const edit = h('button', { class: 'icon-btn', type: 'button', title: 'Изменить', html: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>' });
    edit.addEventListener('click', () => openMcpModal(server));
    const remove = h('button', { class: 'icon-btn', type: 'button', title: 'Удалить', html: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"></path></svg>' });
    remove.addEventListener('click', async () => {
      if (!confirm(`Удалить MCP-сервер «${server.name}»?`)) return;
      await api.mcp.remove(server.id);
      await loadMcp();
    });
    actions.append(edit, remove);
    card.appendChild(actions);
    list.appendChild(card);
  }
}

async function loadMcpPresets() {
  try {
    state.mcpPresets = await api.mcp.presets();
  } catch {
    state.mcpPresets = [];
  }
}

function openMcpModal(server = null) {
  state.editingMcpId = server ? server.id : null;
  $('mcp-modal-title').textContent = server ? 'Изменить MCP сервер' : 'Новый MCP сервер';
  $('mcp-name').value = server ? server.name : '';
  $('mcp-transport').value = server ? server.transport : 'stdio';
  $('mcp-command').value = server ? server.command : '';
  $('mcp-args').value = server ? (server.args || []).join(' ') : '';
  $('mcp-url').value = server ? server.url : '';
  $('mcp-headers').value = '';
  $('mcp-env').value = '';
  $('mcp-presets-wrap').hidden = !!server;
  renderMcpPresets();
  updateMcpTransportFields();
  openModal('modal-mcp');
}

function renderMcpPresets() {
  const host = $('mcp-presets');
  host.innerHTML = '';
  for (const preset of state.mcpPresets) {
    const card = h(
      'button',
      { class: 'preset-card', type: 'button' },
      h('strong', { text: preset.name }),
      h('span', { text: preset.description || '' }),
    );
    card.addEventListener('click', () => {
      $('mcp-name').value = preset.name;
      $('mcp-transport').value = preset.transport || 'stdio';
      $('mcp-command').value = preset.command || '';
      $('mcp-args').value = (preset.args || []).join(' ');
      $('mcp-url').value = preset.url || '';
      const env = preset.env || {};
      $('mcp-env').value = Object.entries(env).map(([key, value]) => `${key}=${value}`).join('\n');
      if (preset.requires) $('mcp-form-hint').textContent = `Требуется: ${preset.requires}`;
      updateMcpTransportFields();
    });
    host.appendChild(card);
  }
}

function updateMcpTransportFields() {
  const transport = $('mcp-transport').value;
  $('mcp-stdio-fields').hidden = transport !== 'stdio';
  $('mcp-http-fields').hidden = transport !== 'http';
}

function parseEnvLines(text) {
  const env = {};
  for (const line of String(text || '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const index = trimmed.indexOf('=');
    if (index === -1) continue;
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim();
    if (key) env[key] = value;
  }
  return env;
}

async function saveMcpFromModal() {
  const transport = $('mcp-transport').value;
  let headers = {};
  const headersRaw = $('mcp-headers').value.trim();
  if (headersRaw) {
    try {
      headers = JSON.parse(headersRaw);
    } catch {
      toast('Заголовки должны быть корректным JSON', 'error');
      return;
    }
  }
  const record = {
    id: state.editingMcpId || undefined,
    name: $('mcp-name').value.trim() || 'MCP сервер',
    transport,
    command: $('mcp-command').value.trim(),
    args: $('mcp-args').value.trim().split(/\s+/).filter(Boolean),
    env: parseEnvLines($('mcp-env').value),
    url: $('mcp-url').value.trim(),
    headers,
    enabled: true,
  };
  const saved = await api.mcp.save(record);
  if (saved.error) {
    toast(saved.error, 'error');
    return;
  }
  closeModal('modal-mcp');
  const started = await api.mcp.start(saved.id);
  if (started.error) toast(started.error, 'error');
  await loadMcp();
  toast(`MCP «${record.name}» сохранён`, 'success');
}

/* ───────────────────────────── tools count ───────────────────────────── */

async function refreshToolsCount() {
  try {
    state.toolList = await api.tools.list();
  } catch {
    state.toolList = [];
  }
  const pill = $('tools-pill');
  $('tools-count').textContent = String(state.toolList.length);
  pill.title = state.toolList.length ? `Доступно инструментов: ${state.toolList.length}\n${state.toolList.map((tool) => tool.name).join(', ')}` : 'Инструменты не загружены';
  updatePluginsBadge();
}

/* ───────────────────────────── settings ───────────────────────────── */

function applyTheme() {
  const theme = state.config?.ui?.theme || 'dark';
  document.body.classList.toggle('light', theme === 'light');
  const logo = $('app-logo');
  // Внимание: имена файлов означают фон, для которого нарисован логотип.
  // logo-black.png — светлый логотип (для тёмной темы), logo-white.png — тёмный логотип (для светлой).
  if (logo) logo.src = theme === 'light' ? 'assets/logo-white.png' : 'assets/logo-black.png';
}

function fillSettingsInputs() {
  const config = state.config || {};
  const agent = config.agent || {};
  $('temp-range').value = String(agent.temperature ?? 0.7);
  $('temp-value').textContent = String(agent.temperature ?? 0.7);
  $('tokens-input').value = String(agent.maxTokens ?? 4096);
  $('steps-input').value = String(agent.maxSteps ?? 24);
  $('system-prompt').value = config.systemPrompt || DEFAULT_SYSTEM_PROMPT;
  $('theme-select').value = config.ui?.theme || 'dark';
}

async function persistConfig(patch) {
  state.config = { ...(state.config || {}), ...patch };
  await api.config.set(patch);
}

function bindSettings() {
  $('theme-select').addEventListener('change', async (event) => {
    await persistConfig({ ui: { ...(state.config.ui || {}), theme: event.target.value } });
    applyTheme();
  });
  $('temp-range').addEventListener('input', (event) => {
    $('temp-value').textContent = event.target.value;
  });
  $('temp-range').addEventListener('change', async (event) => {
    const value = parseFloat(event.target.value);
    await persistConfig({ agent: { ...(state.config.agent || {}), temperature: value } });
  });
  $('tokens-input').addEventListener('change', async (event) => {
    const value = Math.max(256, Math.min(200000, parseInt(event.target.value, 10) || 4096));
    event.target.value = String(value);
    await persistConfig({ agent: { ...(state.config.agent || {}), maxTokens: value } });
  });
  $('steps-input').addEventListener('change', async (event) => {
    const value = Math.max(1, Math.min(60, parseInt(event.target.value, 10) || 24));
    event.target.value = String(value);
    await persistConfig({ agent: { ...(state.config.agent || {}), maxSteps: value } });
  });
  $('system-prompt').addEventListener('change', async (event) => {
    await persistConfig({ systemPrompt: event.target.value });
    toast('Системный промпт сохранён', 'success');
  });
  $('reset-system-prompt').addEventListener('click', async () => {
    $('system-prompt').value = DEFAULT_SYSTEM_PROMPT;
    await persistConfig({ systemPrompt: DEFAULT_SYSTEM_PROMPT });
    toast('Промпт сброшен');
  });
  $('open-browser').addEventListener('click', async () => {
    await api.browser.open();
    updateBrowserStatus();
  });
  $('browser-pill').addEventListener('click', async () => {
    await api.browser.open();
    updateBrowserStatus();
    toast('Окно браузера агента открыто');
  });
  $('clear-browser').addEventListener('click', async () => {
    if (!confirm('Очистить cookie и данные сайтов браузера агента?')) return;
    await api.browser.clear();
    toast('Данные сайтов очищены');
    updateBrowserStatus();
  });
}

async function updateBrowserStatus() {
  const status = await api.browser.status();
  const host = $('browser-status');
  if (status.url) host.textContent = `Открыт: ${status.url}`;
  else if (status.open) host.textContent = 'Окно открыто, страница не загружена';
  else host.textContent = 'Браузер не открывался';
}

/* ───────────────────────────── navigation ───────────────────────────── */

function switchView(view) {
  state.currentView = view;
  document.querySelectorAll('.view').forEach((node) => node.classList.toggle('active', node.id === `view-${view}`));
  document.querySelectorAll('.nav-item').forEach((node) => node.classList.toggle('active', node.dataset.view === view));
  if (view === 'providers') renderProviders();
  if (view === 'plugins') {
    loadConnectors();
    loadMcp();
  }
  if (view === 'settings') {
    fillSettingsInputs();
    updateBrowserStatus();
  }
}

function bindNavigation() {
  document.querySelectorAll('.nav-item').forEach((item) => {
    item.addEventListener('click', () => switchView(item.dataset.view));
  });
  $('collapse-sidebar').addEventListener('click', () => {
    state.sidebarCollapsed = !state.sidebarCollapsed;
    document.body.classList.toggle('sidebar-collapsed', state.sidebarCollapsed);
  });
  document.querySelectorAll('#plugins-tabs .seg').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('#plugins-tabs .seg').forEach((node) => node.classList.toggle('active', node === tab));
      $('tab-services').hidden = tab.dataset.tab !== 'services';
      $('tab-mcp').hidden = tab.dataset.tab !== 'mcp';
    });
  });
  $('add-mcp').addEventListener('click', () => openMcpModal());
  $('reload-mcp').addEventListener('click', () => loadMcp());
  $('mcp-transport').addEventListener('change', updateMcpTransportFields);
  $('mcp-save').addEventListener('click', saveMcpFromModal);
  $('connector-submit').addEventListener('click', submitConnector);
  api.mcp.onStatus(() => loadMcp());
}

/* ───────────────────────────── keyboard ───────────────────────────── */

function bindShortcuts() {
  window.addEventListener('keydown', (event) => {
    const mod = event.metaKey || event.ctrlKey;
    if (!mod) return;
    const key = event.key.toLowerCase();
    if (key === 'n') {
      event.preventDefault();
      createChat();
    } else if (key === 'k') {
      event.preventDefault();
      renderModelList('');
      openModal('modal-models');
    } else if (key === 'o') {
      event.preventDefault();
      openWorkspaceModal();
    }
  });
}

/* ───────────────────────────── init ───────────────────────────── */

async function init() {
  const info = await api.app.info();
  state.platform = info.platform;
  document.body.classList.add(`platform-${info.platform}`);
  if (info.platform !== 'darwin' && info.platform !== 'win32' && info.platform !== 'linux') {
    document.body.classList.add('platform-darwin');
  }

  state.config = await api.config.get();

  $('app-version').textContent = `Comrade Harness ${info.version}`;
  $('userdata-path').textContent = info.userData;
  $('encryption-status').textContent = info.encryptedSecrets ? 'включено (Keychain/DPAPI)' : 'недоступно — токены хранятся в открытом виде';
  $('user-connectors-path').textContent = `${info.userData}/connectors`;

  applyTheme();
  fillSettingsInputs();

  loadProviders();
  renderProviders();
  renderModelPickerLabel();
  renderModelList('');

  await loadWorkspace(true);
  loadChats();
  renderChatHistory();
  renderMessages();
  renderAttachments();

  bindWorkspace();
  bindProviders();
  bindChat();
  bindSettings();
  bindNavigation();
  bindConnectorOAuthEvents();
  bindShortcuts();

  await loadMcpPresets();
  await loadConnectors();
  await loadMcp();
  await refreshToolsCount();
  updateBrowserStatus();

  api.app.onPlatform((payload) => {
    state.platform = payload.platform;
  });

  if (!state.providers.some((provider) => provider.models.length)) {
    setTimeout(() => {
      toast('Добавь провайдера и модели, чтобы начать', 'error', 6000);
      switchView('providers');
    }, 600);
  }
  autoGrowInput();
}

init().catch((error) => {
  console.error(error);
  toast(`Ошибка запуска: ${error.message}`, 'error', 8000);
});
