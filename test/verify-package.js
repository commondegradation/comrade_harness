'use strict';

/*
 * Проверка внутренностей собранного приложения: пути внутри app.asar,
 * манифесты коннекторов, распакованный MCP-сервер и его реальный запуск.
 * Запускается «как node» из собранного приложения:
 *   ELECTRON_RUN_AS_NODE=1 "…/Comrade Harness.app/Contents/MacOS/Comrade Harness" test/verify-package.js "/path/to/app"
 */

const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail: String(detail) });
}

function mcpHandshake(serverPath, binary) {
  return new Promise((resolve) => {
    const child = execFile(binary, [serverPath], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } }, (error) => {
      if (error && !resolve.__done) {
        resolve.__done = true;
        resolve({ error: error.message });
      }
    });
    let buffer = '';
    let stage = 0;
    let tools = [];
    const timer = setTimeout(() => {
      if (!resolve.__done) {
        resolve.__done = true;
        child.kill();
        resolve({ error: 'timeout' });
      }
    }, 15000);

    const finish = (value) => {
      if (resolve.__done) return;
      resolve.__done = true;
      clearTimeout(timer);
      child.kill();
      resolve(value);
    };

    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString();
      let index;
      while ((index = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (!line) continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (stage === 0 && message.result?.serverInfo) {
          stage = 1;
          child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
          child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })}\n`);
        } else if (stage === 1 && Array.isArray(message.result?.tools)) {
          tools = message.result.tools.map((tool) => tool.name);
          child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'echo', arguments: { text: 'ping' } } })}\n`);
          stage = 2;
        } else if (stage === 2 && message.result?.content) {
          finish({ tools, echo: message.result.content[0]?.text, serverInfo: 'ok' });
        }
      }
    });
    child.on('error', (error) => finish({ error: error.message }));

    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'verify', version: '1' } } })}\n`);
  });
}

(async () => {
  const appPath = process.argv[2] || path.join(__dirname, '..', 'dist', 'mac-arm64', 'Comrade Harness.app');
  const resources = path.join(appPath, 'Contents', 'Resources');
  const asar = path.join(resources, 'app.asar');
  const unpacked = path.join(resources, 'app.asar.unpacked');

  check('app.asar существует', fs.existsSync(asar), asar);
  if (!fs.existsSync(asar)) {
    report();
    return;
  }

  // 1. Ключевые файлы внутри asar
  const rootFiles = ['main.js', 'preload.js', 'renderer.js', 'index.html', 'style.css', 'vendor/marked.umd.js', 'assets/icon.icns', 'assets/icon.ico'];
  for (const file of rootFiles) {
    check(`в asar есть ${file}`, fs.existsSync(path.join(asar, file)));
  }
  check('в asar есть шрифты', fs.existsSync(path.join(asar, 'assets', 'fonts', 'climate-crisis-latin.woff2')));
  check('в asar есть lib/agent.js и lib/browser.js', fs.existsSync(path.join(asar, 'lib', 'agent.js')) && fs.existsSync(path.join(asar, 'lib', 'browser.js')));

  // 2. Пресеты MCP
  try {
    const presets = JSON.parse(fs.readFileSync(path.join(asar, 'plugins', 'mcp-presets.json'), 'utf8'));
    check('пресеты MCP читаются из asar', Array.isArray(presets.presets) && presets.presets.length >= 8, `${presets.presets?.length} пресетов`);
  } catch (error) {
    check('пресеты MCP читаются из asar', false, error.message);
  }

  // 3. Манифесты коннекторов
  try {
    const dir = path.join(asar, 'plugins', 'connectors');
    const files = fs.readdirSync(dir).filter((file) => file.endsWith('.json'));
    const parsed = files.map((file) => JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')));
    const withTools = parsed.filter((manifest) => Array.isArray(manifest.tools) && manifest.tools.length);
    const withAuth = parsed.filter((manifest) => manifest.auth && manifest.auth.type);
    check('манифесты коннекторов читаются из asar', files.length >= 7 && withTools.length === files.length && withAuth.length === files.length, files.join(', '));
  } catch (error) {
    check('манифесты коннекторов читаются из asar', false, error.message);
  }

  // 4. Распакованный MCP-сервер и его запуск
  const demo = path.join(unpacked, 'plugins', 'mcp', 'demo-server.js');
  check('демо-MCP-сервер распакован из asar', fs.existsSync(demo), demo);
  if (fs.existsSync(demo)) {
    const handshake = await mcpHandshake(demo, process.execPath);
    check('распакованный MCP-сервер отвечает на handshake', !handshake.error && handshake.tools?.length === 4, handshake.error || `инструменты: ${handshake.tools?.join(', ')}`);
    check('инструмент echo через распакованный сервер работает', handshake.echo === 'echo: ping', handshake.echo || '(нет ответа)');
  }

  // 5. Иконка приложения и Info.plist
  const plist = path.join(appPath, 'Contents', 'Info.plist');
  if (fs.existsSync(plist)) {
    const raw = fs.readFileSync(plist, 'utf8');
    check('Info.plist содержит идентификатор приложения', raw.includes('com.comrade.harness'), '');
    check('Info.plist содержит русскую локаль', raw.includes('ru'), '');
  }
  check('иконка приложения на месте', fs.existsSync(path.join(resources, 'icon.icns')));

  // 6. package.json внутри asar (имя и главный файл)
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(asar, 'package.json'), 'utf8'));
    check('package.json внутри asar корректен', pkg.main === 'main.js', `main=${pkg.main}, name=${pkg.name}`);
  } catch (error) {
    check('package.json внутри asar корректен', false, error.message);
  }

  report();

  function report() {
    const failed = results.filter((result) => !result.ok);
    console.log('\n══════ ПРОВЕРКА СОБРАННОГО ПРИЛОЖЕНИЯ ══════');
    for (const result of results) {
      console.log(`${result.ok ? '✅' : '❌'} ${result.name}${result.ok || !result.detail ? '' : ` → ${result.detail}`}`);
    }
    console.log(`\nИтого: ${results.length - failed.length}/${results.length}`);
    process.exit(failed.length ? 1 : 0);
  }
})();
