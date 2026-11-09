'use strict';

/*
 * Integration probe: drives the real app (main.js + renderer.js) against a fake
 * OpenAI-compatible streaming API, and exercises web tools, the browser tool,
 * an MCP server and a service connector. Run with:
 *     npx electron test/probe.js
 */

const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const http = require('http');
const path = require('path');

// Match the real application identity so userData/config paths are identical to `electron .`.
app.setName('comrade-harness');

const results = [];
const logs = [];
let server;
let base = '';
let serverPort = 0;
const seen = { chatRequests: [], echoToolAuth: null, pages: 0 };

function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail: typeof detail === 'string' ? detail : JSON.stringify(detail) });
}

const JS_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>JS Page</title></head>
<body>
  <h1>Заголовок страницы</h1>
  <p id="static">Статический текст для проверки.</p>
  <div id="dynamic">Ждём JavaScript…</div>
  <form action="/search">
    <input name="q" placeholder="Поиск по сайту">
    <button type="submit">Найти</button>
  </form>
  <a href="/page">Другая страница</a>
  <script>setTimeout(() => { document.getElementById('dynamic').textContent = 'Отрисовано JavaScript-ом: 42'; }, 120);</script>
</body></html>`;

const STATIC_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Static Page</title>
<meta name="description" content="Тестовая страница"></head>
<body><article><h1>Статика</h1><p>Это статическая страница с текстом. ${'Lorem ipsum dolor sit amet. '.repeat(12)}</p>
<p><a href="/page2">Ссылка на вторую страницу</a></p></article></body></html>`;

function startServer() {
  return new Promise((resolve) => {
    server = http.createServer((req, res) => {
      const url = new URL(req.url, base || 'http://127.0.0.1');
      if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
        let raw = '';
        req.on('data', (chunk) => {
          raw += chunk;
        });
        req.on('end', () => {
          let body = {};
          try {
            body = JSON.parse(raw);
          } catch {
            /* ignore */
          }
          handleChat(req, res, body);
        });
        return;
      }
      if (url.pathname === '/page') {
        seen.pages += 1;
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(STATIC_PAGE);
        return;
      }
      if (url.pathname === '/js-page') {
        seen.pages += 1;
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(JS_PAGE);
        return;
      }
      if (url.pathname === '/me') {
        if (!req.headers.authorization) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ message: 'Unauthorized' }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ login: 'tester', name: 'Test User' }));
        return;
      }
      if (url.pathname === '/echo-tool') {
        seen.echoToolAuth = req.headers.authorization || null;
        let body = '';
        req.on('data', (chunk) => {
          body += chunk;
        });
        req.on('end', () => {
          let parsed = {};
          try {
            parsed = JSON.parse(body);
          } catch {
            /* ignore */
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, echo: parsed.message || '' }));
        });
        return;
      }
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
    });
    server.listen(0, '127.0.0.1', () => {
      serverPort = server.address().port;
      base = `http://127.0.0.1:${serverPort}`;
      resolve(base);
    });
  });
}

function sseWrite(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function chatStep(body) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const toolResults = messages.filter((message) => message.role === 'tool');
  const tools = Array.isArray(body.tools) ? body.tools : [];
  const toolNames = tools.map((tool) => tool.function.name);
  const step = toolResults.length;
  return { step, toolResults, toolNames };
}

function handleChat(req, res, body) {
  const { step, toolResults, toolNames } = chatStep(body);
  seen.chatRequests.push({
    step,
    model: body.model,
    toolCount: toolNames.length,
    hasReasoningFieldSupported: true,
    messages: body.messages.length,
    auth: req.headers.authorization || null,
  });

  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });

  const sendReasoning = (text) => {
    for (const chunk of text.match(/[\s\S]{1,24}/g) || []) {
      sseWrite(res, { choices: [{ index: 0, delta: { reasoning_content: chunk } }] });
    }
  };
  const sendContent = (text) => {
    for (const chunk of text.match(/[\s\S]{1,20}/g) || []) {
      sseWrite(res, { choices: [{ index: 0, delta: { content: chunk } }] });
    }
  };
  const sendToolCall = (name, args, id) => {
    sseWrite(res, { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: '' } }] } }] });
    sseWrite(res, { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify(args) } }] } }] });
    sseWrite(res, { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
  };

  const mcpEcho = toolNames.find((name) => /^mcp_.*_echo$/.test(name));

  if (step === 0) {
    sendReasoning('Сначала посмотрю статическую страницу, потом отрисую динамическую.');
    sendToolCall('read_url', { url: `${base}/page` }, 'call_read');
  } else if (step === 1) {
    sendReasoning('Теперь открою страницу в браузере, чтобы выполнился JavaScript.');
    sendToolCall('browser', { action: 'open', url: `${base}/js-page` }, 'call_browser');
  } else if (step === 2) {
    sendReasoning('Проверю текст на динамической странице.');
    sendToolCall('browser', { action: 'read' }, 'call_browser_read');
  } else if (step === 3) {
    sendToolCall('testservice_echo', { message: 'проверка коннектора' }, 'call_connector');
  } else if (step === 4 && mcpEcho) {
    sendToolCall(mcpEcho, { text: 'ping' }, 'call_mcp');
  } else {
    sendReasoning('Все данные собраны, формирую итог.');
    sendContent('# Итог\n\nПроверено: статика, браузер, коннектор' + (mcpEcho ? ', MCP' : '') + '.\n\n```js\nconsole.log("ok");\n```\n');
    sseWrite(res, { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
    sseWrite(res, { usage: { prompt_tokens: 1200, completion_tokens: 240, total_tokens: 1440 }, choices: [] });
  }
  res.write('data: [DONE]\n\n');
  res.end();
}

function writeTestConnector() {
  const dir = path.join(app.getPath('userData'), 'connectors');
  fs.mkdirSync(dir, { recursive: true });
  const manifest = {
    id: 'testservice',
    name: 'Test Service',
    category: 'Тест',
    icon: 'test',
    description: 'Локальный коннектор для проверки пайплайна.',
    auth: {
      type: 'token',
      header: 'Authorization',
      prefix: 'Bearer ',
      tokenLabel: 'Test token',
      tokenHint: 'любой токен',
      validate: { method: 'GET', url: `${base}/me`, labelPath: 'login' },
    },
    tools: [
      {
        name: 'testservice_echo',
        description: 'Echo a message through the test service.',
        method: 'POST',
        url: `${base}/echo-tool`,
        body: { message: '{message}' },
        args: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] },
      },
    ],
  };
  fs.writeFileSync(path.join(dir, 'testservice.json'), JSON.stringify(manifest, null, 2));
  return path.join(dir, 'testservice.json');
}

/*
 * Проверка темы и логотипа по настоящим пикселям экрана: скриншот делается
 * в главном процессе, а анализируется в рендерере через canvas.
 */
async function themeLogoCheck(wc) {
  const js = (code) => wc.executeJavaScript(code, true);
  const out = {};

  for (const theme of ['dark', 'light']) {
    await js(`(async () => { await persistConfig({ ui: { ...(state.config.ui || {}), theme: '${theme}' } }); applyTheme(); await new Promise((r) => setTimeout(r, 150)); return true; })()`);
    const rects = JSON.parse(
      await js(`(() => {
        const img = document.getElementById('app-logo');
        const logo = img.getBoundingClientRect();
        const sidebar = document.querySelector('.sidebar').getBoundingClientRect();
        return JSON.stringify({
          file: img.src.split('/').pop(),
          logo: { x: logo.x, y: logo.y, w: logo.width, h: logo.height },
          sidebar: { x: sidebar.x, y: sidebar.y, w: sidebar.width, h: sidebar.height }
        });
      })()`),
    );

    const shot = await wc.capturePage();
    const dataUrl = shot.toDataURL();
    const stats = JSON.parse(
      await js(`(async () => {
        const image = new Image();
        image.src = ${JSON.stringify(dataUrl)};
        await image.decode();
        const canvas = document.createElement('canvas');
        canvas.width = image.width;
        canvas.height = image.height;
        const context = canvas.getContext('2d');
        context.drawImage(image, 0, 0);
        const dpr = image.width / window.innerWidth;
        const sample = (rect) => {
          const x = Math.max(0, Math.round(rect.x * dpr));
          const y = Math.max(0, Math.round(rect.y * dpr));
          const w = Math.max(1, Math.round(rect.w * dpr));
          const h = Math.max(1, Math.round(rect.h * dpr));
          const data = context.getImageData(x, y, w, h).data;
          const lums = [];
          let sum = 0;
          for (let i = 0; i < data.length; i += 4) {
            const lum = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
            lums.push(lum);
            sum += lum;
          }
          return {
            mean: Math.round(sum / lums.length),
            bright: +(100 * lums.filter((l) => l > 150).length / lums.length).toFixed(1),
            dark: +(100 * lums.filter((l) => l < 80).length / lums.length).toFixed(1)
          };
        };
        return JSON.stringify({ logo: sample(${JSON.stringify(rects.logo)}), sidebar: sample(${JSON.stringify(rects.sidebar)}), dpr });
      })()`),
    );
    out[theme] = { file: rects.file, ...stats };
  }

  await js(`(async () => { await persistConfig({ ui: { ...(state.config.ui || {}), theme: 'dark' } }); applyTheme(); return true; })()`);

  const dark = out.dark;
  const light = out.light;
  check(
    'Тёмная тема: фон тёмный, логотип светлый и заметный',
    dark.sidebar.mean < 95 && dark.logo.bright > 20 && dark.logo.mean - dark.sidebar.mean > 20,
    JSON.stringify(dark),
  );
  check(
    'Светлая тема: фон светлый, логотип тёмный и заметный',
    light.sidebar.mean > 175 && light.logo.dark > 20 && light.sidebar.mean - light.logo.mean > 20,
    JSON.stringify(light),
  );
  check(
    'Файлы логотипов соответствуют теме',
    dark.file === 'logo-black.png' && light.file === 'logo-white.png',
    `${dark.file} / ${light.file}`,
  );
}

async function probe(wc) {
  const js = (code) => wc.executeJavaScript(code, true);

  // ── 1. UI structure ────────────────────────────────────────────────
  const structure = JSON.parse(
    await js(`JSON.stringify({
      navItems: document.querySelectorAll('.nav-item').length,
      providers: document.querySelectorAll('.provider-card').length,
      modelLabel: document.getElementById('model-label').textContent,
      workspace: document.getElementById('workspace-name').textContent,
      composer: !!document.getElementById('composer'),
      welcome: !!document.querySelector('.welcome')
    })`),
  );
  check('UI: базовые элементы отрисованы', structure.navItems === 4 && structure.providers >= 1 && structure.composer, JSON.stringify(structure));

  // ── 2. Markdown + sanitizing ───────────────────────────────────────
  const md = await js(`(() => {
    const html = renderMarkdown('# H1\\n\\n<script>window.__pwned = true<\\/script>\\n\\n- a\\n- b\\n\\n\`\`\`js\\nconst x = 1;\\n\`\`\`');
    return JSON.stringify({ html, pwned: !!window.__pwned, hasH1: /<h1/.test(html), hasScript: /<script/i.test(html), hasPre: /<pre/.test(html) });
  })()`);
  const mdResult = JSON.parse(md);
  check('Markdown: заголовки/списки/код рендерятся', mdResult.hasH1 && mdResult.hasPre, mdResult.html.slice(0, 80));
  check('Markdown: <script> вырезан', !mdResult.hasScript && !mdResult.pwned);

  // ── 3. Providers modal + presets ───────────────────────────────────
  const providerModal = JSON.parse(
    await js(`(() => {
      document.querySelector('.nav-item[data-view="providers"]').click();
      openProviderModal();
      const presets = document.querySelectorAll('#provider-presets .preset-chip').length;
      document.querySelector('#provider-presets .preset-chip').click();
      const filled = { name: document.getElementById('provider-name').value, url: document.getElementById('provider-url').value, models: document.getElementById('provider-models').value.split('\\n').length };
      document.querySelector('[data-close="modal-provider"]').click();
      return JSON.stringify({ presets, filled });
    })()`),
  );
  check('Провайдеры: пресеты и автозаполнение', providerModal.presets >= 8 && providerModal.filled.models > 1, JSON.stringify(providerModal));

  // ── 4. Workspace modal ─────────────────────────────────────────────
  const wsModal = JSON.parse(
    await js(`(() => {
      openWorkspaceModal();
      const out = {
        suggestions: document.querySelectorAll('#workspace-suggestions .recent-item').length,
        inputVisible: !!document.getElementById('workspace-input').offsetParent,
        recents: document.querySelectorAll('#workspace-recents .recent-item').length
      };
      document.querySelector('[data-close="modal-workspace"]').click();
      return JSON.stringify(out);
    })()`),
  );
  check('Выбор папки: модалка с быстрым доступом', wsModal.suggestions >= 1 && wsModal.inputVisible, JSON.stringify(wsModal));

  // ── 5. Model picker ────────────────────────────────────────────────
  const modelPicker = JSON.parse(
    await js(`(() => {
      document.getElementById('model-picker').click();
      const items = document.querySelectorAll('#model-list .model-item').length;
      document.querySelector('[data-close="modal-models"]').click();
      return JSON.stringify({ items });
    })()`),
  );
  check('Переключатель моделей работает', modelPicker.items >= 1, JSON.stringify(modelPicker));

  // ── 6. MCP demo server ─────────────────────────────────────────────
  const mcpSetup = JSON.parse(
    await js(`(async () => {
      const presets = await api.mcp.presets();
      const demo = presets.find((preset) => preset.id === 'demo');
      const saved = await api.mcp.save({ name: demo.name, transport: demo.transport, command: demo.command, args: demo.args, enabled: true });
      const started = await api.mcp.start(saved.id);
      const list = await api.mcp.list();
      const server = list.find((item) => item.id === saved.id);
      window.__mcpId = saved.id;
      return JSON.stringify({ presetCount: presets.length, startError: started.error || null, id: saved.id, running: server?.running, tools: (server?.tools || []).map((tool) => tool.name) });
    })()`),
  );
  check('MCP: демо-сервер запускается и отдаёт инструменты', mcpSetup.running && mcpSetup.tools.includes('echo'), JSON.stringify(mcpSetup));
  global.__mcpId = mcpSetup.id;

  // ── 7. Connector: token → validate → save ──────────────────────────
  const connector = JSON.parse(
    await js(`(async () => {
      const list = await api.connectors.reload();
      const test = list.find((item) => item.id === 'testservice');
      if (!test) return JSON.stringify({ found: false });
      openConnectorModal(test);
      const modalOpen = !document.getElementById('modal-connector').hidden;
      const result = await api.connectors.connectToken('testservice', { token: 'secret-123', settings: {} });
      document.querySelector('[data-close="modal-connector"]').click();
      const after = (await api.connectors.list()).find((item) => item.id === 'testservice');
      return JSON.stringify({ found: true, modalOpen, result, connected: after?.connected, account: after?.account, toolCount: after?.toolCount });
    })()`),
  );
  check('Коннектор: токен проверен и сохранён', connector.connected && connector.account === 'tester', JSON.stringify(connector));

  // ── 8. Full agent run through the fake provider ────────────────────
  const run = JSON.parse(
    await js(`(async () => {
      state.providers = [{ id: 'fake', name: 'Fake', url: '${base}/v1/chat/completions', apiKey: 'sk-test', models: [{ id: 'fake-model', label: 'fake-model' }], headers: {} }];
      state.activeModel = { providerId: 'fake', modelId: 'fake-model' };
      saveProviders();
      renderProviders();
      renderModelPickerLabel();
      document.querySelector('.nav-item[data-view="chat"]').click();
      createChat({ silent: true });
      renderMessages();
      document.getElementById('input').value = 'Проверь всё';
      await sendMessage();
      const chat = getActiveChat();
      const kinds = chat.messages.map((message) => message.role + (message.tool_calls ? ':tools' : ''));
      const tools = chat.messages.filter((message) => message.role === 'tool').map((message) => ({ name: message.name, content: (message.content || '').slice(0, 240) }));
      const final = [...chat.messages].reverse().find((message) => message.role === 'assistant' && message.content);
      const dom = {
        thinking: document.querySelectorAll('.thinking').length,
        toolCards: document.querySelectorAll('.tool-card').length,
        assistantNodes: document.querySelectorAll('.msg.assistant').length,
        assistantBg: getComputedStyle(document.querySelector('.msg.assistant')).backgroundColor,
        assistantBorder: getComputedStyle(document.querySelector('.msg.assistant')).borderTopWidth,
        assistantWidth: document.querySelector('.msg.assistant').getBoundingClientRect().width,
        containerWidth: document.getElementById('messages').getBoundingClientRect().width,
        thinkingVisible: !!document.querySelector('.thinking .thinking-body'),
        codeBlocks: document.querySelectorAll('.msg-text pre').length,
        copyButtons: document.querySelectorAll('.copy-code').length
      };
      return JSON.stringify({ kinds, tools, finalContent: final ? final.content.slice(0, 200) : null, finalReasoning: final ? (final.reasoning || '').slice(0, 60) : null, dom, usage: chat.lastUsage || null, title: chat.title });
    })()`),
  );

  const toolNames = (run.tools || []).map((tool) => tool.name);
  const readResult = (run.tools || []).find((tool) => tool.name === 'read_url') || {};
  const browserResults = (run.tools || []).filter((tool) => tool.name === 'browser');
  const connectorResult = (run.tools || []).find((tool) => tool.name === 'testservice_echo') || {};
  const mcpResult = (run.tools || []).find((tool) => /^mcp_.*_echo$/.test(tool.name)) || {};

  check('Агент: 6 шагов и 5 вызовов инструментов', run.kinds.filter((kind) => kind.startsWith('tool')).length === 5, JSON.stringify(run.kinds));
  check('Инструмент read_url вернул текст страницы', /Статика/.test(readResult.content || ''), (readResult.content || '').slice(0, 120));
  check('Браузер отрисовал JavaScript', /Отрисовано JavaScript-ом: 42/.test((browserResults[1] || {}).content || ''), ((browserResults[1] || {}).content || '').slice(0, 140));
  check('Коннектор выполнил запрос от имени пользователя', /"ok": true/.test(connectorResult.content || ''), connectorResult.content);
  check('MCP-инструмент вызван и ответил', /echo: ping/.test(mcpResult.content || ''), mcpResult.content);
  check('Финальный ответ содержит markdown', /Итог/.test(run.finalContent || ''), run.finalContent);
  check('Размышления сохранены в истории', !!run.finalReasoning, run.finalReasoning || '');
  check('UI: блок размышлений отображён', run.dom.thinking >= 1, JSON.stringify(run.dom));
  check('UI: карточки инструментов отображены', run.dom.toolCards === 5, String(run.dom.toolCards));
  check('UI: ответ без пузыря на фоне', run.dom.assistantBg === 'rgba(0, 0, 0, 0)' && run.dom.assistantBorder === '0px', `${run.dom.assistantBg} / ${run.dom.assistantBorder}`);
  check('UI: ответ на всю ширину колонки', run.dom.assistantWidth > run.dom.containerWidth * 0.9, `${run.dom.assistantWidth} vs ${run.dom.containerWidth}`);
  check('UI: код в ответе с кнопкой копирования', run.dom.codeBlocks >= 1, JSON.stringify(run.dom));
  check('Usage учтён', run.usage && run.usage.totalTokens === 1440, JSON.stringify(run.usage));
  check('Заголовок чата из первого сообщения', run.title === 'Проверь всё', run.title);

  // ── 9. Streaming behaviour with a live turn ────────────────────────
  const streaming = JSON.parse(
    await js(`(async () => {
      createChat({ silent: true });
      renderMessages();
      const live = createLiveTurn('r_probe');
      handleAgentEvent({ requestId: 'r_probe', type: 'step', step: 1, maxSteps: 10 });
      handleAgentEvent({ requestId: 'r_probe', type: 'reasoning', text: 'Размышляю: ' });
      handleAgentEvent({ requestId: 'r_probe', type: 'reasoning', text: 'нужно проверить два варианта.' });
      await new Promise((resolve) => setTimeout(resolve, 30));
      const thinkingText = document.querySelector('.thinking-body').textContent;
      const thinkingStreaming = document.querySelector('.thinking').classList.contains('thinking-streaming');
      const thinkingExpanded = !document.querySelector('.thinking').classList.contains('collapsed');
      handleAgentEvent({ requestId: 'r_probe', type: 'content', text: 'Первый вариант ' });
      handleAgentEvent({ requestId: 'r_probe', type: 'tool-start', id: 'x1', name: 'read_url', args: { url: 'http://x' } });
      handleAgentEvent({ requestId: 'r_probe', type: 'tool-result', id: 'x1', name: 'read_url', isError: false, content: 'результат', durationMs: 1200 });
      handleAgentEvent({ requestId: 'r_probe', type: 'content', text: 'Готово.' });
      await new Promise((resolve) => setTimeout(resolve, 140));
      return JSON.stringify({
        thinkingText,
        thinkingStreaming,
        thinkingExpanded,
        textSegments: document.querySelectorAll('.msg.assistant .msg-text').length,
        toolCards: document.querySelectorAll('.msg.assistant .tool-card').length,
        statusText: document.querySelector('.status-row') ? document.querySelector('.status-row').textContent : ''
      });
    })()`),
  );
  check('Стриминг: текст размышлений виден во время генерации', /Размышляю.*варианта/s.test(streaming.thinkingText) && streaming.thinkingExpanded, JSON.stringify(streaming));
  check('Стриминг: после инструмента начинается новый текстовый блок', streaming.textSegments >= 2, JSON.stringify(streaming));
  check('Стриминг: карточка инструмента добавлена', streaming.toolCards === 1, JSON.stringify(streaming));

  // ── 10. Abort path ─────────────────────────────────────────────────
  const aborted = JSON.parse(
    await js(`(async () => {
      const chat = getActiveChat();
      const assistantCountBefore = chat.messages.filter((message) => message.role === 'assistant').length;
      finishTurn({ messages: [], usage: { totalTokens: 5 }, aborted: true }, { aborted: true, chat });
      const after = getActiveChat();
      return JSON.stringify({ before: assistantCountBefore, kinds: after.messages.map((message) => message.role), generating: state.generating });
    })()`),
  );
  check('Останов генерации корректно завершает ход', aborted.generating === false, JSON.stringify(aborted));

  // ── 11. Provider auth header is forwarded ──────────────────────────
  const authOk = seen.chatRequests.every((request) => request.auth === 'Bearer sk-test');
  check('API-ключ провайдера уходит в запросе', authOk, JSON.stringify(seen.chatRequests.map((request) => request.auth)));
  check('Коннектор получил Authorization от пользователя', seen.echoToolAuth === 'Bearer secret-123', String(seen.echoToolAuth));
  check('Инструменты попадают в запрос к модели', seen.chatRequests[0].toolCount >= 8, String(seen.chatRequests[0]?.toolCount));

  // ── 12. Settings persistence ───────────────────────────────────────
  const settings = JSON.parse(
    await js(`(async () => {
      document.querySelector('.nav-item[data-view="settings"]').click();
      const temperature = { slider: !!document.getElementById('temp-range'), steps: document.getElementById('steps-input').value, prompt: document.getElementById('system-prompt').value.length };
      return JSON.stringify(temperature);
    })()`),
  );
  check('Настройки: параметры агента и промпт доступны', settings.slider && Number(settings.steps) >= 1 && settings.prompt > 50, JSON.stringify(settings));
}

async function cleanup(wc) {
  const js = (code) => wc.executeJavaScript(code, true);
  try {
    await js(`(async () => {
      if (window.__mcpId) await api.mcp.remove(window.__mcpId);
      await api.connectors.disconnect('testservice');
      ['comrade.providers','comrade.activeModel','comrade.chats','comrade.activeChatId'].forEach((key) => localStorage.removeItem(key));
      return true;
    })()`);
  } catch (error) {
    logs.push(`cleanup renderer failed: ${error.message}`);
  }
  try {
    fs.rmSync(path.join(app.getPath('userData'), 'connectors', 'testservice.json'), { force: true });
  } catch {
    /* ignore */
  }
}

function attach(win) {
  const wc = win.webContents;
  wc.on('console-message', (event, level, message, line, sourceId) => {
    const name = ['debug', 'info', 'warning', 'error'][level] || String(level);
    if (name === 'error' || name === 'warning') logs.push(`[renderer:${name}] ${message} (${sourceId || ''}:${line})`);
  });
  wc.on('preload-error', (event, preloadPath, error) => logs.push(`[preload-error] ${preloadPath}: ${error.message}`));
  wc.on('render-process-gone', (event, details) => logs.push(`[render-process-gone] ${JSON.stringify(details)}`));

  wc.on('did-finish-load', async () => {
    try {
      await new Promise((resolve) => setTimeout(resolve, 2200));
      await probe(wc);
      await themeLogoCheck(wc);
    } catch (error) {
      check('Проба завершилась без исключения', false, error.stack || error.message);
    } finally {
      await cleanup(wc);
      const failed = results.filter((result) => !result.ok);
      console.log('\n══════ РЕЗУЛЬТАТЫ ПРОВЕРКИ ══════');
      for (const result of results) {
        console.log(`${result.ok ? '✅' : '❌'} ${result.name}${result.ok ? '' : ` → ${result.detail}`}`);
      }
      console.log(`\nИтого: ${results.length - failed.length}/${results.length} проверок пройдено`);
      if (logs.length) {
        console.log('\n── сообщения рендерера ──');
        console.log(logs.slice(0, 40).join('\n'));
      }
      console.log('\n── запросы к фейковой модели ──');
      console.log(JSON.stringify(seen.chatRequests, null, 1));
      setTimeout(() => app.exit(failed.length ? 1 : 0), 300);
    }
  });
}

app.on('browser-window-created', (event, win) => {
  if (win && !win.__probed) {
    win.__probed = true;
    attach(win);
  }
});

(async () => {
  await app.whenReady();
  await startServer();
  writeTestConnector();
  require('../main.js');
})().catch((error) => {
  console.error('harness failed', error);
  app.exit(1);
});
