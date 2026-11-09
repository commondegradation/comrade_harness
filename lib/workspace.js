'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { shell, dialog } = require('electron');
const config = require('./config');

const MAX_RECENTS = 8;

function expand(input) {
  if (!input) return '';
  let value = String(input).trim();
  if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
  if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1);
  value = value.replace(/^file:\/\//, '');
  if (value === '~') value = os.homedir();
  else if (value.startsWith('~/') || value.startsWith('~\\')) value = path.join(os.homedir(), value.slice(2));
  if (!path.isAbsolute(value)) value = path.resolve(os.homedir(), value);
  return path.normalize(value);
}

function describe(target) {
  const resolved = expand(target);
  let stat = null;
  try {
    stat = fs.statSync(resolved);
  } catch {
    stat = null;
  }
  return {
    path: resolved,
    name: path.basename(resolved) || resolved,
    parent: path.dirname(resolved),
    exists: !!stat,
    isDirectory: !!stat && stat.isDirectory(),
    isFile: !!stat && stat.isFile(),
    writable: !!stat && isWritable(resolved),
    home: os.homedir(),
    platform: process.platform,
  };
}

function isWritable(target) {
  try {
    fs.accessSync(target, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function currentWorkspace() {
  const cfg = config.getConfig();
  const stored = cfg.workspace && cfg.workspace.path ? cfg.workspace.path : '';
  if (!stored) return null;
  const info = describe(stored);
  return info.exists && info.isDirectory ? info : { ...info, broken: true };
}

function pushRecent(target) {
  config.updateConfig((cfg) => {
    if (!cfg.workspace) cfg.workspace = { path: '', recents: [] };
    cfg.workspace.recents = [target, ...(cfg.workspace.recents || []).filter((item) => item !== target)].slice(0, MAX_RECENTS);
  });
}

function setWorkspace(target) {
  if (!target) return { error: 'Путь не указан' };
  const info = describe(target);
  if (!info.exists) return { error: `Папка не найдена: ${info.path}` };
  if (!info.isDirectory) return { error: 'Это файл, а не папка' };
  if (!info.writable) {
    // Read-only folders are still usable for reading, just warn.
    info.warning = 'Папка доступна только для чтения';
  }
  config.updateConfig((cfg) => {
    if (!cfg.workspace) cfg.workspace = { path: '', recents: [] };
    cfg.workspace.path = info.path;
  });
  pushRecent(info.path);
  return { workspace: { ...info, broken: false }, recents: recentWorkspaces() };
}

function clearWorkspace() {
  config.updateConfig((cfg) => {
    if (!cfg.workspace) cfg.workspace = { path: '', recents: [] };
    cfg.workspace.path = '';
  });
  return { workspace: null, recents: recentWorkspaces() };
}

function removeRecent(target) {
  config.updateConfig((cfg) => {
    if (!cfg.workspace || !Array.isArray(cfg.workspace.recents)) return;
    cfg.workspace.recents = cfg.workspace.recents.filter((item) => item !== target);
  });
  return recentWorkspaces();
}

function recentWorkspaces() {
  const cfg = config.getConfig();
  const recents = (cfg.workspace && cfg.workspace.recents) || [];
  return recents
    .map((item) => {
      const info = describe(item);
      return { ...info, missing: !info.exists || !info.isDirectory };
    })
    .filter((item) => !item.missing);
}

function workspaceState() {
  return {
    workspace: currentWorkspace(),
    recents: recentWorkspaces(),
    home: os.homedir(),
    platform: process.platform,
    suggestions: buildSuggestions(),
  };
}

function buildSuggestions() {
  const candidates = [
    { label: 'Домашняя папка', path: os.homedir() },
    { label: 'Рабочий стол', path: path.join(os.homedir(), 'Desktop') },
    { label: 'Документы', path: path.join(os.homedir(), 'Documents') },
    { label: 'Загрузки', path: path.join(os.homedir(), 'Downloads') },
    { label: 'Проекты', path: path.join(os.homedir(), 'Projects') },
    { label: 'Код', path: path.join(os.homedir(), 'Code') },
  ];
  return candidates
    .map((candidate) => {
      const info = describe(candidate.path);
      return { ...candidate, exists: info.exists && info.isDirectory };
    })
    .filter((candidate) => candidate.exists);
}

async function pickFolder(parentWindow) {
  const cfg = config.getConfig();
  const defaultPath = (cfg.workspace && cfg.workspace.path) || os.homedir();
  const result = await dialog.showOpenDialog(parentWindow, {
    title: 'Выберите рабочую папку',
    buttonLabel: 'Выбрать папку',
    defaultPath,
    properties: ['openDirectory', 'createDirectory'],
  });
  if (result.canceled || !result.filePaths.length) return { canceled: true };
  return setWorkspace(result.filePaths[0]);
}

function reveal(target) {
  let resolved = target ? expand(target) : '';
  if (!resolved) {
    const ws = currentWorkspace();
    if (!ws) return { error: 'Рабочая папка не выбрана' };
    resolved = ws.path;
  }
  try {
    const info = describe(resolved);
    if (!info.exists) return { error: 'Путь не существует' };
    if (info.isDirectory) shell.openPath(resolved);
    else shell.showItemInFolder(resolved);
    return { ok: true };
  } catch (error) {
    return { error: error.message };
  }
}

// Resolve user/tool supplied paths against the active workspace.
function resolvePath(target, { allowEmpty = false } = {}) {
  if (!target) {
    if (allowEmpty) {
      const ws = currentWorkspace();
      return ws ? ws.path : os.homedir();
    }
    throw new Error('Path is required');
  }
  let value = String(target).trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1);
  }
  if (value === '~' || value.startsWith('~/') || value.startsWith('~\\')) return expand(value);
  if (path.isAbsolute(value)) return path.normalize(value);
  const ws = currentWorkspace();
  const base = ws && !ws.broken ? ws.path : os.homedir();
  return path.resolve(base, value);
}

module.exports = {
  expand,
  describe,
  currentWorkspace,
  workspaceState,
  pickFolder,
  setWorkspace,
  clearWorkspace,
  removeRecent,
  recentWorkspaces,
  reveal,
  resolvePath,
};
