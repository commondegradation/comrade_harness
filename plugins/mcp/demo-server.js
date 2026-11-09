'use strict';

/*
 * Minimal MCP server (stdio, JSON-RPC 2.0, newline delimited).
 * Runs inside Electron-as-Node and exists so the MCP pipeline can be tested
 * without installing third-party packages.
 */

const os = require('os');
const readline = require('readline');

const TOOLS = [
  {
    name: 'echo',
    description: 'Echo back the provided text. Useful to verify the MCP connection.',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string', description: 'Text to echo' } },
      required: ['text'],
    },
  },
  {
    name: 'now',
    description: 'Return the current date and time with timezone.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'system_info',
    description: 'Return basic information about the machine (OS, CPU, memory, Node version).',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'random_number',
    description: 'Return a random integer between min and max (inclusive).',
    inputSchema: {
      type: 'object',
      properties: {
        min: { type: 'integer', description: 'Lower bound, default 0' },
        max: { type: 'integer', description: 'Upper bound, default 100' },
      },
    },
  },
];

function send(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function textResult(text) {
  return { content: [{ type: 'text', text }] };
}

function callTool(name, args) {
  const input = args || {};
  switch (name) {
    case 'echo':
      return textResult(`echo: ${input.text ?? ''}`);
    case 'now':
      return textResult(new Date().toString());
    case 'system_info':
      return textResult(
        [
          `platform: ${process.platform} ${process.arch}`,
          `os: ${os.type()} ${os.release()}`,
          `cpus: ${os.cpus().length} × ${os.cpus()[0]?.model || 'unknown'}`,
          `memory: ${(os.totalmem() / 1024 ** 3).toFixed(1)} GB total, ${(os.freemem() / 1024 ** 3).toFixed(1)} GB free`,
          `node: ${process.versions.node}`,
          `hostname: ${os.hostname()}`,
        ].join('\n')
      );
    case 'random_number': {
      const min = Number.isFinite(input.min) ? Math.trunc(input.min) : 0;
      const max = Number.isFinite(input.max) ? Math.trunc(input.max) : 100;
      const low = Math.min(min, max);
      const high = Math.max(min, max);
      return textResult(String(Math.floor(Math.random() * (high - low + 1)) + low));
    }
    default:
      return null;
  }
}

function handle(message) {
  if (!message || typeof message !== 'object') return;
  const { id, method, params } = message;
  if (method === undefined) return; // response from client, ignore

  if (method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: params?.protocolVersion || '2024-11-05',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'comrade-demo', version: '1.0.0' },
      },
    });
    return;
  }
  if (method === 'notifications/initialized' || method.startsWith('notifications/')) return;
  if (method === 'ping') {
    send({ jsonrpc: '2.0', id, result: {} });
    return;
  }
  if (method === 'tools/list') {
    send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
    return;
  }
  if (method === 'tools/call') {
    const name = params?.name;
    const args = params?.arguments || {};
    const result = callTool(name, args);
    if (!result) {
      send({ jsonrpc: '2.0', id, result: { isError: true, content: [{ type: 'text', text: `Unknown tool: ${name}` }] } });
      return;
    }
    send({ jsonrpc: '2.0', id, result });
    return;
  }
  if (id !== undefined) {
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
  }
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  try {
    handle(JSON.parse(trimmed));
  } catch (error) {
    process.stderr.write(`demo-mcp parse error: ${error.message}\n`);
  }
});
rl.on('close', () => process.exit(0));
