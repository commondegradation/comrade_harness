'use strict';

const fsTools = require('./fs-tools');
const web = require('./web');
const { formatSnapshot } = require('./browser');

const BUILTIN_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description:
        'Read a text file. Paths may be absolute or relative to the workspace. Returns numbered lines. Use offset/limit for big files.',
      parameters: {
        type: 'object',
        properties: {
          filePath: { type: 'string', description: 'File path' },
          offset: { type: 'integer', description: 'First line (1-based), default 1' },
          limit: { type: 'integer', description: 'Max lines, default 1200' },
        },
        required: ['filePath'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Create or overwrite a file with the given content. Creates parent directories.',
      parameters: {
        type: 'object',
        properties: {
          filePath: { type: 'string' },
          content: { type: 'string', description: 'Full file content' },
        },
        required: ['filePath', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'edit_file',
      description:
        'Replace an exact snippet in a file. Safer than write_file for small changes. oldString must match exactly (including indentation).',
      parameters: {
        type: 'object',
        properties: {
          filePath: { type: 'string' },
          oldString: { type: 'string', description: 'Exact text to replace' },
          newString: { type: 'string', description: 'Replacement text' },
          replaceAll: { type: 'boolean', description: 'Replace every occurrence' },
        },
        required: ['filePath', 'oldString', 'newString'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_dir',
      description: 'List files and folders inside a directory (relative paths resolve against the workspace).',
      parameters: {
        type: 'object',
        properties: {
          dirPath: { type: 'string', description: 'Directory path, empty for the workspace root' },
          depth: { type: 'integer', description: 'Recursion depth 1-4, default 2' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'web_search',
      description: 'Search the live internet (DuckDuckGo/Bing). Returns titles, URLs and snippets. Use it instead of guessing URLs.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: 'Search query' } },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_url',
      description:
        'Fetch a web page or API over HTTP and return readable text (fast, no JavaScript). Use for static pages, docs, JSON APIs. For JS-heavy sites use browser.',
      parameters: {
        type: 'object',
        properties: { url: { type: 'string', description: 'Absolute http(s) URL' } },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser',
      description:
        'Open pages in a real Chromium session (JavaScript, cookies, logins persist). Actions: open {url}, read {}, click {target}, type {target,text,submit}, press {key}, scroll {direction,amount}, back {}, forward {}, wait {ms}. Click/type target accepts a CSS selector or visible text. Always read the page after opening.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['open', 'read', 'click', 'type', 'press', 'scroll', 'back', 'forward', 'wait'],
            description: 'Browser action',
          },
          url: { type: 'string', description: 'URL for action=open' },
          target: { type: 'string', description: 'CSS selector or visible text for click/type' },
          text: { type: 'string', description: 'Text for action=type' },
          submit: { type: 'boolean', description: 'Submit the form/field after typing' },
          key: { type: 'string', description: 'Key for action=press (Enter, Tab, Escape, ArrowDown…)' },
          direction: { type: 'string', enum: ['up', 'down'], description: 'Scroll direction' },
          amount: { type: 'integer', description: 'Scroll pixels' },
          ms: { type: 'integer', description: 'Wait milliseconds' },
        },
        required: ['action'],
      },
    },
  },
];

class ToolRegistry {
  constructor({ browser, mcpManager, connectorManager }) {
    this.browser = browser;
    this.mcpManager = mcpManager;
    this.connectorManager = connectorManager;
  }

  definitions() {
    const defs = [...BUILTIN_TOOLS];
    try {
      defs.push(...this.mcpManager.toolDefinitions());
    } catch (error) {
      console.error('[tools] mcp definitions failed', error.message);
    }
    try {
      defs.push(...this.connectorManager.toolDefinitions());
    } catch (error) {
      console.error('[tools] connector definitions failed', error.message);
    }
    return defs;
  }

  async execute(name, args) {
    const input = args && typeof args === 'object' ? args : {};
    try {
      switch (name) {
        case 'read_file':
          return fsTools.readFileTool(input);
        case 'write_file':
          return fsTools.writeFileTool(input);
        case 'edit_file':
          return fsTools.editFileTool(input);
        case 'list_dir':
          return fsTools.listDirTool(input);
        case 'web_search':
          return await web.searchWeb(input.query);
        case 'read_url':
          return await web.fetchAndExtract(input.url);
        case 'browser':
          return await this.runBrowser(input);
        default:
          break;
      }

      if (this.mcpManager.toolDefinitions().some((def) => def.function.name === name)) {
        const result = await this.mcpManager.callTool(name, input);
        return result.isError ? { error: result.content } : { content: result.content };
      }

      const connectorNames = new Set(this.connectorManager.toolDefinitions().map((def) => def.function.name));
      if (connectorNames.has(name)) {
        return await this.connectorManager.callTool(name, input);
      }

      return { error: `Неизвестный инструмент: ${name}` };
    } catch (error) {
      return { error: `${name}: ${error.message}` };
    }
  }

  async runBrowser(input) {
    const action = String(input.action || 'read').toLowerCase();
    const browser = this.browser;
    switch (action) {
      case 'open': {
        if (!input.url) return { error: 'Для action=open нужен url' };
        const page = await browser.navigate(String(input.url).trim());
        if (page.error) return { error: page.error };
        return { content: formatSnapshot(page) };
      }
      case 'read': {
        const page = await browser.snapshot();
        return { content: formatSnapshot(page) };
      }
      case 'click': {
        const page = await browser.click(input.target);
        if (page.error) return { error: `${page.error}${page.hint ? ` ${page.hint}` : ''}` };
        return { content: formatSnapshot(page) };
      }
      case 'type': {
        const page = await browser.type(input.target, input.text, input.submit);
        if (page.error) return { error: `${page.error}${page.hint ? ` ${page.hint}` : ''}` };
        return { content: formatSnapshot(page) };
      }
      case 'press': {
        const page = await browser.press(input.key || 'Enter');
        return { content: formatSnapshot(page) };
      }
      case 'scroll': {
        const page = await browser.scroll(input.direction === 'up' ? 'up' : 'down', input.amount);
        return { content: formatSnapshot(page) };
      }
      case 'back': {
        const page = await browser.back();
        return { content: formatSnapshot(page) };
      }
      case 'forward': {
        const page = await browser.forward();
        return { content: formatSnapshot(page) };
      }
      case 'wait': {
        const page = await browser.wait(input.ms);
        return { content: formatSnapshot(page) };
      }
      default:
        return { error: `Неизвестное действие браузера: ${action}` };
    }
  }
}

module.exports = { ToolRegistry, BUILTIN_TOOLS };
