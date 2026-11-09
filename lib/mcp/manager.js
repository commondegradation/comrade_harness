'use strict';

const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const config = require('../config');
const { McpClient } = require('./client');

const APP_ROOT = path.join(__dirname, '..', '..');
const DEMO_SERVER = path.join(APP_ROOT, 'plugins', 'mcp', 'demo-server.js');

// Bundled MCP servers can be referenced with placeholders that we resolve at start time.
function resolvePlaceholders(server) {
  const resolved = { ...server, args: Array.isArray(server.args) ? [...server.args] : [], env: { ...(server.env || {}) } };
  let needsNodeMode = false;

  if (resolved.command === '__electron_node__') {
    resolved.command = process.execPath;
    needsNodeMode = true;
  }
  resolved.args = resolved.args.map((arg) => {
    if (arg === '__demo_server__') {
      const unpacked = DEMO_SERVER.replace(/\.asar(?=($|\/))/, '.asar.unpacked');
      needsNodeMode = true;
      return fs.existsSync(unpacked) ? unpacked : DEMO_SERVER;
    }
    return arg;
  });

  if (needsNodeMode) resolved.env.ELECTRON_RUN_AS_NODE = '1';
  return resolved;
}

function sanitizeName(value) {
  return String(value || '')
    .replace(/[^a-zA-Z0-9_-]+/g, '_')
    .replace(/_{2,}/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 56);
}

class McpManager extends EventEmitter {
  constructor() {
    super();
    this.clients = new Map();
    this.toolIndex = new Map();
    this.starting = new Map();
    this.lastErrors = new Map();
  }

  servers() {
    const cfg = config.getConfig();
    return Array.isArray(cfg.mcpServers) ? cfg.mcpServers : [];
  }

  getServer(id) {
    return this.servers().find((server) => server.id === id) || null;
  }

  saveServer(server) {
    const cfg = config.getConfig();
    const list = Array.isArray(cfg.mcpServers) ? cfg.mcpServers.slice() : [];
    const index = list.findIndex((item) => item.id === server.id);
    if (index >= 0) list[index] = { ...list[index], ...server };
    else list.push(server);
    config.setConfig({ mcpServers: list });
    return server;
  }

  removeServer(id) {
    this.stop(id).catch(() => {});
    const cfg = config.getConfig();
    const list = (cfg.mcpServers || []).filter((server) => server.id !== id);
    config.setConfig({ mcpServers: list });
    this.clients.delete(id);
    return { ok: true };
  }

  async start(id) {
    const server = this.getServer(id);
    if (!server) throw new Error('MCP-сервер не найден');
    if (this.starting.has(id)) return this.starting.get(id);
    const existing = this.clients.get(id);
    if (existing && existing.status().running) return existing;

    const promise = (async () => {
      if (existing) await existing.stop().catch(() => {});
      const client = new McpClient(resolvePlaceholders(server));
      client.on('stderr', (text) => {
        this.emit('log', { serverId: id, text });
      });
      client.on('exit', () => {
        this.clients.delete(id);
        this.rebuildIndex();
        this.emit('status');
      });
      client.on('notification', (message) => {
        if (message.method === 'notifications/tools/list_changed') {
          this.rebuildIndex();
          this.emit('status');
        }
      });
      this.clients.set(id, client);
      try {
        await client.start();
        this.lastErrors.delete(id);
      } catch (error) {
        this.clients.delete(id);
        this.lastErrors.set(id, error.message);
        this.emit('status');
        throw error;
      }
      this.rebuildIndex();
      this.emit('status');
      return client;
    })();

    this.starting.set(id, promise);
    try {
      return await promise;
    } finally {
      this.starting.delete(id);
    }
  }

  async stop(id) {
    const client = this.clients.get(id);
    this.clients.delete(id);
    this.rebuildIndex();
    if (client) await client.stop().catch(() => {});
    this.emit('status');
  }

  async restart(id) {
    await this.stop(id);
    return this.start(id);
  }

  async stopAll() {
    const ids = [...this.clients.keys()];
    await Promise.all(ids.map((id) => this.stop(id).catch(() => {})));
  }

  async autoStart() {
    const enabled = this.servers().filter((server) => server.enabled !== false);
    for (const server of enabled) {
      try {
        await this.start(server.id);
      } catch (error) {
        this.emit('log', { serverId: server.id, text: `start failed: ${error.message}` });
      }
    }
  }

  rebuildIndex() {
    this.toolIndex.clear();
    for (const [serverId, client] of this.clients) {
      const server = this.getServer(serverId);
      const prefix = sanitizeName(server?.prefix || server?.name || serverId);
      for (const tool of client.tools) {
        const exposed = `mcp_${sanitizeName(serverId)}_${sanitizeName(tool.name)}`;
        this.toolIndex.set(exposed, {
          exposed,
          serverId,
          serverName: server?.name || serverId,
          prefix,
          toolName: tool.name,
          description: tool.description || '',
          inputSchema: tool.inputSchema || { type: 'object', properties: {} },
        });
      }
    }
  }

  toolDefinitions() {
    this.rebuildIndex();
    const defs = [];
    for (const entry of this.toolIndex.values()) {
      defs.push({
        type: 'function',
        function: {
          name: entry.exposed,
          description: `[MCP: ${entry.serverName}] ${entry.description}`.slice(0, 900),
          parameters: normalizeSchema(entry.inputSchema),
        },
      });
    }
    return defs;
  }

  async callTool(exposedName, args) {
    const entry = this.toolIndex.get(exposedName);
    if (!entry) throw new Error(`MCP tool ${exposedName} не найден (сервер не запущен?)`);
    let client = this.clients.get(entry.serverId);
    if (!client || !client.status().running) {
      await this.start(entry.serverId);
      client = this.clients.get(entry.serverId);
      this.rebuildIndex();
    }
    if (!client) throw new Error('MCP-сервер не запущен');
    return client.callTool(entry.toolName, args || {});
  }

  displayCommand(server) {
    const resolved = resolvePlaceholders(server);
    const command = resolved.command === process.execPath ? 'node (встроенный в приложение)' : resolved.command;
    const args = resolved.args.map((arg) => (arg === DEMO_SERVER || arg === DEMO_SERVER.replace(/\.asar(?=($|\/))/, '.asar.unpacked') ? 'plugins/mcp/demo-server.js' : arg));
    return { command, args };
  }

  status() {
    const list = this.servers().map((server) => {
      const client = this.clients.get(server.id);
      const display = this.displayCommand(server);
      const status = client ? client.status() : null;
      const serverTools = status ? status.tools : [];
      return {
        id: server.id,
        name: server.name,
        description: server.description || '',
        transport: server.transport || 'stdio',
        command: display.command || '',
        args: display.args || [],
        url: server.url || '',
        enabled: server.enabled !== false,
        running: !!status && status.running,
        tools: serverTools,
        toolCount: serverTools.length,
        serverInfo: status?.serverInfo || null,
        protocolVersion: status?.protocolVersion || null,
        stderr: status?.stderr || '',
        lastError: this.lastErrors?.get(server.id) || '',
        starting: this.starting.has(server.id),
      };
    });
    return list;
  }

  async test(id) {
    const server = this.getServer(id);
    if (!server) return { error: 'Сервер не найден' };
    try {
      const client = await this.start(id);
      return { ok: true, tools: client.tools.map((tool) => ({ name: tool.name, description: tool.description || '' })), serverInfo: client.serverInfo };
    } catch (error) {
      return { error: error.message };
    }
  }
}

function normalizeSchema(schema) {
  if (!schema || typeof schema !== 'object') return { type: 'object', properties: {} };
  const clone = JSON.parse(JSON.stringify(schema));
  if (!clone.type) clone.type = 'object';
  if (clone.type !== 'object') {
    return { type: 'object', properties: { value: clone } };
  }
  if (!clone.properties) clone.properties = {};
  // Some servers emit non-standard keys; keep the schema but strip UI-only annotations.
  delete clone.$schema;
  return clone;
}

module.exports = { McpManager, sanitizeName };
