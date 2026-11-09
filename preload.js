'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

function on(channel, callback) {
  const listener = (event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('comrade', {
  app: {
    info: () => ipcRenderer.invoke('app:info'),
    openExternal: (url) => ipcRenderer.invoke('app:open-external', url),
    pickFiles: () => ipcRenderer.invoke('app:pick-files'),
    getPathForFile: (file) => {
      try {
        return webUtils ? webUtils.getPathForFile(file) : file && file.path;
      } catch {
        return file && file.path;
      }
    },
    onPlatform: (callback) => on('app:platform', callback),
    onMenuPickWorkspace: (callback) => on('menu:pick-workspace', () => callback()),
  },

  config: {
    get: () => ipcRenderer.invoke('config:get'),
    set: (patch) => ipcRenderer.invoke('config:set', patch),
  },

  workspace: {
    state: () => ipcRenderer.invoke('workspace:state'),
    pick: () => ipcRenderer.invoke('workspace:pick'),
    set: (target) => ipcRenderer.invoke('workspace:set', target),
    clear: () => ipcRenderer.invoke('workspace:clear'),
    removeRecent: (target) => ipcRenderer.invoke('workspace:remove-recent', target),
    reveal: (target) => ipcRenderer.invoke('workspace:reveal', target),
    describe: (target) => ipcRenderer.invoke('workspace:describe', target),
  },

  fs: {
    readText: (filePath) => ipcRenderer.invoke('fs:read-text', filePath),
  },

  agent: {
    run: (payload) => ipcRenderer.invoke('agent:run', payload),
    abort: (requestId) => ipcRenderer.invoke('agent:abort', requestId),
    onEvent: (callback) => on('agent:event', callback),
  },

  web: {
    search: (query) => ipcRenderer.invoke('web:search', query),
    fetch: (url) => ipcRenderer.invoke('web:fetch', url),
  },

  browser: {
    status: () => ipcRenderer.invoke('browser:status'),
    show: (show) => ipcRenderer.invoke('browser:show', show),
    open: (url) => ipcRenderer.invoke('browser:open', url),
    clear: () => ipcRenderer.invoke('browser:clear'),
  },

  providers: {
    listModels: (provider) => ipcRenderer.invoke('providers:list-models', provider),
  },

  tools: {
    list: () => ipcRenderer.invoke('tools:list'),
  },

  mcp: {
    list: () => ipcRenderer.invoke('mcp:list'),
    presets: () => ipcRenderer.invoke('mcp:presets'),
    save: (server) => ipcRenderer.invoke('mcp:save', server),
    remove: (id) => ipcRenderer.invoke('mcp:remove', id),
    start: (id) => ipcRenderer.invoke('mcp:start', id),
    stop: (id) => ipcRenderer.invoke('mcp:stop', id),
    test: (id) => ipcRenderer.invoke('mcp:test', id),
    onStatus: (callback) => on('mcp:status', callback),
    onLog: (callback) => on('mcp:log', callback),
  },

  connectors: {
    list: () => ipcRenderer.invoke('connectors:list'),
    reload: () => ipcRenderer.invoke('connectors:reload'),
    connectToken: (id, payload) => ipcRenderer.invoke('connectors:connect-token', id, payload),
    connectOAuth: (id, payload) => ipcRenderer.invoke('connectors:connect-oauth', id, payload),
    disconnect: (id) => ipcRenderer.invoke('connectors:disconnect', id),
    setEnabled: (id, enabled) => ipcRenderer.invoke('connectors:set-enabled', id, enabled),
    saveSettings: (id, settings) => ipcRenderer.invoke('connectors:save-settings', id, settings),
    callTool: (name, args) => ipcRenderer.invoke('connectors:call-tool', name, args),
    onOAuth: (callback) => on('connector:oauth', callback),
    onStatus: (callback) => on('connectors:status', callback),
  },
});
