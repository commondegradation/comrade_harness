'use strict';

const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const readline = require('readline');

const PROTOCOL_VERSION = '2024-11-05';
const CLIENT_INFO = { name: 'comrade-harness', version: '2.0.0' };

class McpError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

class McpClient extends EventEmitter {
  constructor(server) {
    super();
    this.server = server;
    this.transport = server.transport === 'http' ? 'http' : 'stdio';
    this.child = null;
    this.proc = null;
    this.pending = new Map();
    this.nextId = 1;
    this.initialized = false;
    this.serverInfo = null;
    this.protocolVersion = null;
    this.sessionId = null;
    this.stderr = '';
    this.tools = [];
    this.closed = false;
  }

  async start() {
    if (this.transport === 'http') {
      await this.request('initialize', this.initializeParams(), 30000);
      await this.notify('notifications/initialized', {});
      this.initialized = true;
      await this.refreshTools();
      return this;
    }
    await this.startStdio();
    return this;
  }

  initializeParams() {
    return {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { roots: { listChanged: false } },
      clientInfo: CLIENT_INFO,
    };
  }

  startStdio() {
    return new Promise((resolve, reject) => {
      const { command, args = [], env = {}, cwd } = this.server;
      if (!command) {
        reject(new McpError('Не задана команда запуска MCP-сервера'));
        return;
      }
      const childEnv = { ...process.env, ...env };
      let child;
      try {
        child = spawn(command, Array.isArray(args) ? args : String(args).split(/\s+/).filter(Boolean), {
          cwd: cwd || undefined,
          env: childEnv,
          stdio: ['pipe', 'pipe', 'pipe'],
          shell: process.platform === 'win32',
        });
      } catch (error) {
        reject(new McpError(`Не удалось запустить ${command}: ${error.message}`));
        return;
      }
      this.child = child;
      this.proc = child;

      let settled = false;
      const fail = (error) => {
        if (settled) return;
        settled = true;
        reject(error);
      };

      child.on('error', (error) => {
        this.emit('stderr', `spawn error: ${error.message}`);
        fail(new McpError(`Ошибка запуска ${command}: ${error.message}`));
      });

      child.on('exit', (code, signal) => {
        this.closed = true;
        for (const [id, entry] of this.pending) {
          clearTimeout(entry.timer);
          entry.reject(new McpError(`MCP-сервер завершился (${signal || code})`));
          this.pending.delete(id);
        }
        this.emit('exit', { code, signal });
      });

      child.stderr.on('data', (chunk) => {
        const text = chunk.toString('utf8');
        this.stderr = (this.stderr + text).slice(-8000);
        this.emit('stderr', text.trim());
      });

      const rl = readline.createInterface({ input: child.stdout });
      rl.on('line', (line) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
          this.emit('stderr', trimmed);
          return;
        }
        try {
          this.handleMessage(JSON.parse(trimmed));
        } catch (error) {
          this.emit('stderr', `bad JSON from server: ${trimmed.slice(0, 200)}`);
        }
      });

      // MCP handshake
      this.request('initialize', this.initializeParams(), 45000)
        .then(async (result) => {
          this.serverInfo = result?.serverInfo || null;
          this.protocolVersion = result?.protocolVersion || PROTOCOL_VERSION;
          this.initialized = true;
          await this.notify('notifications/initialized', {});
          await this.refreshTools();
          if (!settled) {
            settled = true;
            resolve(this);
          }
        })
        .catch((error) => fail(error));
    });
  }

  handleMessage(message) {
    if (message.id !== undefined && message.id !== null && (message.result !== undefined || message.error !== undefined)) {
      const entry = this.pending.get(message.id);
      if (!entry) return;
      clearTimeout(entry.timer);
      this.pending.delete(message.id);
      if (message.error) entry.reject(new McpError(message.error.message || 'MCP error', message.error.code));
      else entry.resolve(message.result);
      return;
    }
    if (message.method && message.id !== undefined && message.id !== null) {
      // Server -> client request. We only support ping, everything else is rejected politely.
      if (message.method === 'ping') {
        this.send({ jsonrpc: '2.0', id: message.id, result: {} });
      } else {
        this.send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not supported by client' } });
      }
      return;
    }
    if (message.method) {
      this.emit('notification', message);
      if (message.method === 'notifications/tools/list_changed') {
        this.refreshTools().catch(() => {});
      }
    }
  }

  send(payload) {
    if (this.transport === 'http') return; // handled elsewhere
    if (!this.child || !this.child.stdin.writable) throw new McpError('MCP-процесс не запущен');
    this.child.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  request(method, params, timeout = 30000) {
    if (this.transport === 'http') return this.httpRequest(method, params, timeout);
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new McpError(`MCP: таймаут запроса ${method}`));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.send({ jsonrpc: '2.0', id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  notify(method, params) {
    if (this.transport === 'http') {
      return this.httpPost({ jsonrpc: '2.0', method, params }).then(() => undefined);
    }
    try {
      this.send({ jsonrpc: '2.0', method, params });
    } catch {
      /* ignore */
    }
    return Promise.resolve();
  }

  async httpPost(payload) {
    const headers = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...(this.server.headers || {}),
    };
    if (this.sessionId) headers['Mcp-Session-Id'] = this.sessionId;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(30000, Number(this.server.timeout) || 0));
    try {
      const response = await fetch(this.server.url, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      const sessionHeader = response.headers.get('mcp-session-id');
      if (sessionHeader) this.sessionId = sessionHeader;
      return response;
    } finally {
      clearTimeout(timer);
    }
  }

  async httpRequest(method, params, timeout = 30000) {
    if (!this.server.url) throw new McpError('Не задан URL MCP-сервера');
    const payload = { jsonrpc: '2.0', id: this.nextId++, method, params };
    let response;
    try {
      response = await this.httpPost(payload);
    } catch (error) {
      throw new McpError(`MCP HTTP: ${error.name === 'AbortError' ? 'таймаут' : error.message}`);
    }
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new McpError(`MCP HTTP ${response.status}: ${body.slice(0, 500) || response.statusText}`);
    }
    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('text/event-stream') && response.body) {
      const result = await this.readSseResponse(response.body, payload.id, timeout);
      if (result.error) throw new McpError(result.error.message || 'MCP error', result.error.code);
      return result.result;
    }
    const text = await response.text();
    if (!text.trim()) return {};
    try {
      const parsed = JSON.parse(text);
      if (parsed.error) throw new McpError(parsed.error.message || 'MCP error', parsed.error.code);
      return parsed.result;
    } catch (error) {
      throw new McpError(`MCP HTTP: не удалось разобрать ответ (${text.slice(0, 200)})`);
    }
  }

  async readSseResponse(body, requestId, timeout) {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const deadline = Date.now() + timeout;
    try {
      while (Date.now() < deadline) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
        let index;
        while ((index = buffer.indexOf('\n\n')) >= 0) {
          const rawEvent = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          const dataLines = rawEvent
            .split('\n')
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).trim());
          if (!dataLines.length) continue;
          const data = dataLines.join('\n');
          if (!data || data === '[DONE]') continue;
          let parsed;
          try {
            parsed = JSON.parse(data);
          } catch {
            continue;
          }
          if (parsed.id === requestId || parsed.id === undefined) {
            if (parsed.method) this.handleMessage(parsed);
            else return parsed;
          }
        }
      }
      throw new McpError('MCP SSE: таймаут ответа');
    } finally {
      try {
        reader.cancel();
      } catch {
        /* ignore */
      }
    }
  }

  async refreshTools() {
    const tools = [];
    let cursor;
    let guard = 0;
    do {
      const result = await this.request('tools/list', cursor ? { cursor } : {}, 30000);
      for (const tool of result?.tools || []) {
        if (tool && tool.name) tools.push(tool);
      }
      cursor = result?.nextCursor;
      guard += 1;
    } while (cursor && guard < 10);
    this.tools = tools;
    return tools;
  }

  async callTool(name, args) {
    const result = await this.request('tools/call', { name, arguments: args || {} }, 180000);
    if (!result) return { content: '', isError: false };
    if (result.isError) {
      const text = flattenContent(result.content);
      return { content: text || 'MCP tool returned an error', isError: true };
    }
    return { content: flattenContent(result.content), isError: false, raw: result };
  }

  async stop() {
    this.closed = true;
    if (this.transport === 'http') {
      try {
        await this.notify('notifications/cancelled', {});
      } catch {
        /* ignore */
      }
      return;
    }
    if (!this.child) return;
    const child = this.child;
    this.child = null;
    const killTimer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
    }, 2000);
    try {
      child.stdin.end();
      child.kill('SIGTERM');
    } catch {
      /* ignore */
    }
    await new Promise((resolve) => {
      if (child.exitCode !== null) {
        clearTimeout(killTimer);
        resolve();
        return;
      }
      child.once('exit', () => {
        clearTimeout(killTimer);
        resolve();
      });
      setTimeout(() => {
        clearTimeout(killTimer);
        resolve();
      }, 2500);
    });
  }

  status() {
    return {
      running: this.transport === 'http' ? this.initialized : !!this.child && !this.closed,
      initialized: this.initialized,
      serverInfo: this.serverInfo,
      protocolVersion: this.protocolVersion,
      tools: this.tools.map((tool) => ({ name: tool.name, description: tool.description || '' })),
      stderr: this.stderr.slice(-2000),
    };
  }
}

function flattenContent(content) {
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (!item) return '';
        if (item.type === 'text') return item.text || '';
        if (item.type === 'image') return `[image ${item.mimeType || ''}]`;
        if (item.type === 'resource') return `[resource ${item.resource?.uri || ''}] ${item.resource?.text || ''}`;
        return typeof item === 'string' ? item : JSON.stringify(item);
      })
      .filter(Boolean)
      .join('\n');
  }
  return JSON.stringify(content);
}

module.exports = { McpClient, McpError, flattenContent };
