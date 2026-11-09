'use strict';

const { app, safeStorage } = require('electron');
const fs = require('fs');
const path = require('path');

const DEFAULT_SYSTEM_PROMPT = [
  'You are Comrade, a capable AI agent working inside a local desktop harness on the user\'s computer.',
  'You are NOT Claude, ChatGPT, Gemini or any other assistant — never claim to be one of them.',
  '',
  'You have real tools. Use them instead of guessing:',
  '- File tools (read_file, write_file, edit_file, list_dir) work with absolute paths or paths relative to the workspace.',
  '- web_search searches the live internet. read_url fetches a page over HTTP (fast, no JavaScript).',
  '- browser opens pages in a real Chromium session with JavaScript, cookies and logins. Use action="open" then action="read"; click/type/press/scroll to interact. Prefer it for modern sites, SPAs and anything behind a login.',
  '- MCP and service tools (github_*, notion_*, slack_*, google_*, linear_*, jira_*) act on behalf of the user in connected services. Use them to actually do the work (read issues, create pages, send messages).',
  '',
  'Rules:',
  '1. Think step by step before acting. Keep the final answer concise and concrete.',
  '2. Do not invent URLs, file contents or API results — verify with tools.',
  '3. If a tool returns an error, do not retry the same call endlessly (max 2 attempts). Adapt or report the problem.',
  '4. When you write code or files, write the complete content, not placeholders.',
  '5. Format answers with markdown. Use fenced code blocks with a language tag.',
].join('\n');

const DEFAULTS = {
  version: 2,
  workspace: { path: '', recents: [] },
  ui: { language: 'ru', theme: 'dark' },
  agent: { maxSteps: 24, temperature: 0.7, maxTokens: 4096 },
  systemPrompt: DEFAULT_SYSTEM_PROMPT,
  browser: { visible: false, lastUrls: [] },
  mcpServers: [],
  connectors: {},
};

let cache = null;
let secrets = null;
let saveTimer = null;

function configFile() {
  return path.join(app.getPath('userData'), 'comrade-config.json');
}

function secretsFile() {
  return path.join(app.getPath('userData'), 'comrade-secrets.json');
}

function deepMerge(base, patch) {
  if (Array.isArray(patch)) return patch;
  if (!patch || typeof patch !== 'object') return patch === undefined ? base : patch;
  const out = Array.isArray(base) ? [] : { ...(base || {}) };
  for (const key of Object.keys(patch)) {
    const value = patch[key];
    if (value && typeof value === 'object' && !Array.isArray(value) && base && typeof base[key] === 'object') {
      out[key] = deepMerge(base[key], value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, file);
}

function load() {
  if (cache) return cache;
  const stored = readJson(configFile(), {});
  cache = deepMerge(DEFAULTS, stored);
  if (!Array.isArray(cache.mcpServers)) cache.mcpServers = [];
  if (!cache.workspace || typeof cache.workspace !== 'object') cache.workspace = { path: '', recents: [] };
  if (!Array.isArray(cache.workspace.recents)) cache.workspace.recents = [];
  if (!cache.connectors || typeof cache.connectors !== 'object') cache.connectors = {};
  if (!cache.ui) cache.ui = { ...DEFAULTS.ui };
  return cache;
}

function getConfig() {
  return load();
}

function saveNow() {
  if (!cache) return;
  try {
    writeJsonAtomic(configFile(), cache);
  } catch (error) {
    console.error('[config] save failed', error);
  }
}

function save() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveNow();
  }, 250);
}

function setConfig(patch) {
  const current = load();
  cache = deepMerge(current, patch);
  save();
  return cache;
}

function updateConfig(mutator) {
  const current = load();
  mutator(current);
  save();
  return current;
}

/* ------------------------------- secrets -------------------------------- */

function encryptionAvailable() {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

function loadSecrets() {
  if (secrets) return secrets;
  secrets = readJson(secretsFile(), {});
  if (!secrets || typeof secrets !== 'object') secrets = {};
  return secrets;
}

function persistSecrets() {
  try {
    writeJsonAtomic(secretsFile(), secrets || {});
  } catch (error) {
    console.error('[config] secrets save failed', error);
  }
}

function setSecret(key, value) {
  loadSecrets();
  if (value === undefined || value === null || value === '') {
    delete secrets[key];
    persistSecrets();
    return;
  }
  if (encryptionAvailable()) {
    const encrypted = safeStorage.encryptString(String(value));
    secrets[key] = { v: 1, enc: true, data: encrypted.toString('base64') };
  } else {
    secrets[key] = { v: 1, enc: false, data: Buffer.from(String(value), 'utf8').toString('base64') };
  }
  persistSecrets();
}

function getSecret(key) {
  loadSecrets();
  const entry = secrets[key];
  if (!entry) return null;
  try {
    if (entry.enc) {
      if (!encryptionAvailable()) return null;
      return safeStorage.decryptString(Buffer.from(entry.data, 'base64'));
    }
    return Buffer.from(entry.data, 'base64').toString('utf8');
  } catch (error) {
    console.error('[config] decrypt failed', key, error.message);
    return null;
  }
}

function deleteSecret(key) {
  loadSecrets();
  if (key in secrets) {
    delete secrets[key];
    persistSecrets();
  }
}

function deleteSecretsWithPrefix(prefix) {
  loadSecrets();
  let changed = false;
  for (const key of Object.keys(secrets)) {
    if (key.startsWith(prefix)) {
      delete secrets[key];
      changed = true;
    }
  }
  if (changed) persistSecrets();
}

module.exports = {
  DEFAULT_SYSTEM_PROMPT,
  DEFAULTS,
  configFile,
  secretsFile,
  encryptionAvailable,
  getConfig,
  setConfig,
  updateConfig,
  save,
  saveNow,
  getSecret,
  setSecret,
  deleteSecret,
  deleteSecretsWithPrefix,
};
