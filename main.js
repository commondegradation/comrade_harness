'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell, Menu, safeStorage } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

const config = require('./lib/config');
const workspace = require('./lib/workspace');
const providers = require('./lib/providers');
const web = require('./lib/web');
const { BrowserController } = require('./lib/browser');
const { McpManager } = require('./lib/mcp/manager');
const { ConnectorManager } = require('./lib/connectors');
const { runAgent } = require('./lib/agent');
const { ToolRegistry } = require('./lib/tools');

const APP_NAME = 'Comrade Harness';
const activeRuns = new Map();

let mainWindow = null;
let browser = null;
let mcpManager = null;
let connectors = null;
let quitting = false;

/* ------------------------------- helpers -------------------------------- */

function resolveAsset(relative) {
  const base = __dirname;
  const inside = path.join(base, relative);
  if (!base.includes('.asar')) return inside;
  const unpacked = path.join(base.replace(/\.asar(?=($|\/))/, '.asar.unpacked'), relative);
  if (fs.existsSync(unpacked)) return unpacked;
  return inside;
}

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

function currentWindowBounds() {
  const cfg = config.getConfig();
  return (cfg.ui && cfg.ui.windowBounds) || null;
}

function saveWindowBounds() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized() || mainWindow.isFullScreen()) return;
  const bounds = mainWindow.getBounds();
  config.updateConfig((cfg) => {
    if (!cfg.ui) cfg.ui = {};
    cfg.ui.windowBounds = bounds;
  });
}

/* -------------------------------- window -------------------------------- */

function createWindow() {
  const saved = currentWindowBounds();
  const isMac = process.platform === 'darwin';
  mainWindow = new BrowserWindow({
    width: saved?.width || 1360,
    height: saved?.height || 900,
    x: saved?.x,
    y: saved?.y,
    minWidth: 960,
    minHeight: 640,
    show: false,
    icon: path.join(__dirname, 'assets/icon.png'),
    backgroundColor: '#131313',
    title: APP_NAME,
    ...(isMac ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 16, y: 18 } } : { autoHideMenuBar: true }),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
      spellcheck: true,
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('resize', saveWindowBounds);
  mainWindow.on('move', saveWindowBounds);
  mainWindow.on('close', () => {
    saveWindowBounds();
    config.saveNow();
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file://')) {
      event.preventDefault();
      if (/^https?:/i.test(url)) shell.openExternal(url);
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));
  mainWindow.webContents.on('did-finish-load', () => {
    send('app:platform', { platform: process.platform, version: app.getVersion(), encrypted: safeStorage.isEncryptionAvailable() });
  });
}

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac
      ? [
          {
            label: APP_NAME,
            submenu: [
              { role: 'about', label: 'О Comrade Harness' },
              { type: 'separator' },
              { role: 'hide', label: 'Скрыть' },
              { role: 'hideOthers', label: 'Скрыть остальные' },
              { role: 'unhide', label: 'Показать все' },
              { type: 'separator' },
              { role: 'quit', label: 'Выйти' },
            ],
          },
        ]
      : []),
    {
      label: 'Файл',
      submenu: [
        { label: 'Выбрать рабочую папку…', accelerator: 'CmdOrCtrl+O', click: () => send('menu:pick-workspace') },
        { label: 'Открыть браузер Comrade', click: () => browser.showWindow(true).catch(() => {}) },
        { type: 'separator' },
        isMac ? { role: 'close', label: 'Закрыть окно' } : { role: 'quit', label: 'Выход' },
      ],
    },
    {
      label: 'Правка',
      submenu: [
        { role: 'undo', label: 'Отменить' },
        { role: 'redo', label: 'Повторить' },
        { type: 'separator' },
        { role: 'cut', label: 'Вырезать' },
        { role: 'copy', label: 'Скопировать' },
        { role: 'paste', label: 'Вставить' },
        { role: 'selectAll', label: 'Выбрать всё' },
      ],
    },
    {
      label: 'Вид',
      submenu: [
        { role: 'reload', label: 'Перезагрузить' },
        { role: 'toggleDevTools', label: 'Инструменты разработчика' },
        { type: 'separator' },
        { role: 'resetZoom', label: 'Обычный масштаб' },
        { role: 'zoomIn', label: 'Увеличить' },
        { role: 'zoomOut', label: 'Уменьшить' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: 'Полный экран' },
      ],
    },
    { role: 'windowMenu', label: 'Окно' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/* --------------------------------- IPC ---------------------------------- */

function registerIpc() {
  ipcMain.handle('app:info', () => ({
    platform: process.platform,
    arch: process.arch,
    version: app.getVersion(),
    name: APP_NAME,
    home: os.homedir(),
    encryptedSecrets: safeStorage.isEncryptionAvailable(),
    userData: app.getPath('userData'),
  }));

  ipcMain.handle('app:open-external', (event, url) => {
    if (!/^https?:\/\//i.test(String(url || ''))) return { error: 'Разрешены только http(s) ссылки' };
    shell.openExternal(url);
    return { ok: true };
  });

  ipcMain.handle('app:pick-files', async () => {
    const result = await dialog.showOpenDialog(mainWindow, { properties: ['openFile', 'multiSelections'] });
    if (result.canceled) return [];
    return result.filePaths.map((filePath) => {
      try {
        const stat = fs.statSync(filePath);
        if (stat.size > 2 * 1024 * 1024) {
          return { path: filePath, name: path.basename(filePath), error: 'Файл больше 2 МБ' };
        }
        return { path: filePath, name: path.basename(filePath), content: fs.readFileSync(filePath, 'utf8') };
      } catch (error) {
        return { path: filePath, name: path.basename(filePath), error: error.message };
      }
    });
  });

  ipcMain.handle('config:get', () => {
    const cfg = config.getConfig();
    return {
      workspace: cfg.workspace,
      ui: cfg.ui,
      agent: cfg.agent,
      systemPrompt: cfg.systemPrompt,
      browser: cfg.browser,
      encryptionAvailable: config.encryptionAvailable(),
    };
  });

  ipcMain.handle('config:set', (event, patch) => {
    if (!patch || typeof patch !== 'object') return { error: 'Некорректные настройки' };
    const allowed = ['ui', 'agent', 'systemPrompt', 'browser'];
    const clean = {};
    for (const key of allowed) {
      if (patch[key] !== undefined) clean[key] = patch[key];
    }
    config.setConfig(clean);
    return { ok: true };
  });

  /* ----------------------------- workspace ----------------------------- */
  ipcMain.handle('workspace:state', () => workspace.workspaceState());
  ipcMain.handle('workspace:pick', () => workspace.pickFolder(mainWindow));
  ipcMain.handle('workspace:set', (event, target) => workspace.setWorkspace(target));
  ipcMain.handle('workspace:clear', () => workspace.clearWorkspace());
  ipcMain.handle('workspace:remove-recent', (event, target) => workspace.removeRecent(target));
  ipcMain.handle('workspace:reveal', (event, target) => workspace.reveal(target));
  ipcMain.handle('workspace:describe', (event, target) => workspace.describe(target));

  /* -------------------------------- fs --------------------------------- */
  ipcMain.handle('fs:read-text', (event, filePath) => {
    try {
      const info = workspace.describe(filePath);
      if (!info.exists) return { error: 'Файл не найден' };
      const stat = fs.statSync(info.path);
      if (stat.size > 1024 * 1024) return { error: 'Файл слишком большой для предпросмотра' };
      return { content: fs.readFileSync(info.path, 'utf8'), name: info.name, path: info.path, size: stat.size };
    } catch (error) {
      return { error: error.message };
    }
  });

  /* ------------------------------- agent -------------------------------- */
  ipcMain.handle('agent:run', async (event, payload = {}) => {
    const requestId = String(payload.requestId || Date.now());
    if (activeRuns.has(requestId)) return { error: 'Запрос уже выполняется' };
    const controller = new AbortController();
    activeRuns.set(requestId, controller);
    try {
      const provider = payload.provider || {};
      const apiKey = typeof provider.apiKey === 'string' ? provider.apiKey.trim() : '';
      const result = await runAgent({
        requestId,
        provider: { url: provider.url },
        model: payload.model,
        apiKey,
        headers: provider.headers || {},
        history: payload.messages || [],
        systemPrompt: payload.systemPrompt,
        extraContext: payload.extraContext || '',
        temperature: Number.isFinite(payload.temperature) ? payload.temperature : 0.7,
        maxTokens: Number.isFinite(payload.maxTokens) ? payload.maxTokens : 4096,
        maxSteps: payload.maxSteps,
        signal: controller.signal,
        emit: (agentEvent) => send('agent:event', agentEvent),
        browser,
        mcpManager,
        connectorManager: connectors,
      });
      return result;
    } catch (error) {
      const aborted = controller.signal.aborted || error.name === 'AbortError';
      if (!aborted) send('agent:event', { requestId, type: 'error', message: error.message });
      return { error: aborted ? null : error.message, aborted };
    } finally {
      activeRuns.delete(requestId);
    }
  });

  ipcMain.handle('agent:abort', (event, requestId) => {
    const controller = activeRuns.get(String(requestId));
    if (controller) controller.abort();
    return { ok: true };
  });

  /* -------------------------------- web --------------------------------- */
  ipcMain.handle('web:search', (event, query) => web.searchWeb(query));
  ipcMain.handle('web:fetch', (event, url) => web.fetchAndExtract(url));

  /* ------------------------------ browser ------------------------------- */
  ipcMain.handle('browser:status', () => browser.status());
  ipcMain.handle('browser:show', (event, show) => browser.showWindow(show !== false));
  ipcMain.handle('browser:open', (event, url) => browser.openVisible(url));
  ipcMain.handle('browser:clear', () => browser.clearData());

  /* ----------------------------- providers ------------------------------ */
  ipcMain.handle('tools:list', () => {
    const registry = new ToolRegistry({ browser, mcpManager, connectorManager: connectors });
    return registry.definitions().map((def) => ({ name: def.function.name, description: def.function.description }));
  });

  ipcMain.handle('providers:list-models', (event, provider = {}) =>
    providers.listModels({ url: provider.url, apiKey: provider.apiKey, headers: provider.headers || {} })
  );

  /* -------------------------------- mcp --------------------------------- */
  ipcMain.handle('mcp:list', () => mcpManager.status());
  ipcMain.handle('mcp:presets', () => {
    try {
      const raw = fs.readFileSync(resolveAsset('plugins/mcp-presets.json'), 'utf8');
      const parsed = JSON.parse(raw);
      return parsed.presets || [];
    } catch (error) {
      return [];
    }
  });

  ipcMain.handle('mcp:save', (event, server = {}) => {
    try {
      const id = String(server.id || `mcp_${Date.now()}`).replace(/[^a-zA-Z0-9_-]/g, '_');
      const existing = mcpManager.getServer(id);
      const record = {
        id,
        name: String(server.name || existing?.name || 'MCP сервер').slice(0, 80),
        description: String(server.description || existing?.description || '').slice(0, 400),
        transport: server.transport === 'http' ? 'http' : 'stdio',
        enabled: server.enabled !== false,
        command: String(server.command || '').trim(),
        args: Array.isArray(server.args) ? server.args.map(String) : String(server.args || '').split(/\s+/).filter(Boolean),
        env: server.env && typeof server.env === 'object' ? server.env : {},
        url: String(server.url || '').trim(),
        headers: server.headers && typeof server.headers === 'object' ? server.headers : {},
      };
      if (record.transport === 'stdio' && !record.command) return { error: 'Укажи команду запуска' };
      if (record.transport === 'http' && !/^https?:\/\//i.test(record.url)) return { error: 'Укажи http(s) URL сервера' };
      mcpManager.saveServer(record);
      return { ok: true, id };
    } catch (error) {
      return { error: error.message };
    }
  });

  ipcMain.handle('mcp:remove', (event, id) => {
    mcpManager.removeServer(id);
    return { ok: true };
  });

  ipcMain.handle('mcp:start', async (event, id) => {
    try {
      await mcpManager.start(id);
      return { ok: true };
    } catch (error) {
      return { error: error.message };
    }
  });

  ipcMain.handle('mcp:stop', async (event, id) => {
    await mcpManager.stop(id);
    return { ok: true };
  });

  ipcMain.handle('mcp:test', async (event, id) => mcpManager.test(id));

  /* ----------------------------- connectors ----------------------------- */
  ipcMain.handle('connectors:list', () => connectors.list());
  ipcMain.handle('connectors:reload', () => {
    connectors.loadManifests(true);
    return connectors.list();
  });
  ipcMain.handle('connectors:connect-token', async (event, id, payload) => {
    try {
      const result = await connectors.connectToken(id, payload || {});
      return result;
    } catch (error) {
      return { error: error.message };
    }
  });
  ipcMain.handle('connectors:connect-oauth', async (event, id, payload) => {
    try {
      const result = await connectors.connectOAuth(id, payload || {});
      return result;
    } catch (error) {
      return { error: error.message };
    }
  });
  ipcMain.handle('connectors:disconnect', (event, id) => connectors.disconnect(id));
  ipcMain.handle('connectors:set-enabled', (event, id, enabled) => connectors.setEnabled(id, enabled));
  ipcMain.handle('connectors:save-settings', (event, id, settings) => {
    try {
      connectors.saveSettings(id, settings);
      return { ok: true };
    } catch (error) {
      return { error: error.message };
    }
  });
  ipcMain.handle('connectors:call-tool', async (event, name, args) => {
    try {
      return await connectors.callTool(name, args || {});
    } catch (error) {
      return { error: error.message };
    }
  });
}

/* -------------------------------- boot --------------------------------- */

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    if (process.platform === 'win32') app.setAppUserModelId('com.comrade.harness');

    browser = new BrowserController();
    mcpManager = new McpManager();
    connectors = new ConnectorManager();

    mcpManager.on('status', () => send('mcp:status', mcpManager.status()));
    mcpManager.on('log', (payload) => send('mcp:log', payload));
    connectors.on('oauth', (payload) => send('connector:oauth', payload));
    connectors.on('status', () => send('connectors:status', connectors.list()));

    registerIpc();
    buildMenu();
    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });

    // Start enabled MCP servers in the background so their tools are ready.
    setTimeout(() => {
      mcpManager.autoStart().catch((error) => console.error('[mcp] autostart failed', error.message));
    }, 1200);
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', async () => {
    if (quitting) return;
    quitting = true;
    config.saveNow();
    try {
      await Promise.race([mcpManager.stopAll(), new Promise((resolve) => setTimeout(resolve, 1500))]);
    } catch {
      /* ignore */
    }
    if (browser) browser.destroy();
  });
}
