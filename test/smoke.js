'use strict';

/*
 * Headless-ish smoke test harness.
 *   npx electron test/smoke.js
 * Loads the real app (main.js), captures renderer console errors and a screenshot.
 */

const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const OUT_DIR = path.join(__dirname, '..', '.cache');
const shots = [];
const logs = [];

function attach(win) {
  const wc = win.webContents;
  wc.on('console-message', (event, level, message, line, sourceId) => {
    const name = ['debug', 'info', 'warning', 'error'][level] || String(level);
    logs.push(`[renderer:${name}] ${message} (${sourceId || ''}:${line})`);
  });
  wc.on('preload-error', (event, preloadPath, error) => {
    logs.push(`[preload-error] ${preloadPath}: ${error.message}`);
  });
  wc.on('render-process-gone', (event, details) => {
    logs.push(`[render-process-gone] ${JSON.stringify(details)}`);
  });
  wc.on('did-finish-load', async () => {
    try {
      await new Promise((resolve) => setTimeout(resolve, 2500));
      const errors = await wc.executeJavaScript(`(() => {
        const out = {};
        out.views = [...document.querySelectorAll('.view')].map((v) => v.id + (v.classList.contains('active') ? '*' : ''));
        out.providers = document.querySelectorAll('.provider-card').length;
        out.modelLabel = document.getElementById('model-label')?.textContent;
        out.tools = document.getElementById('tools-count')?.textContent;
        out.workspaceName = document.getElementById('workspace-name')?.textContent;
        out.history = document.querySelectorAll('.history-item').length;
        out.connectors = document.querySelectorAll('.connector-card').length;
        out.mcp = document.querySelectorAll('.mcp-card').length;
        return JSON.stringify(out);
      })()`);
      logs.push(`[dom] ${errors}`);
      const image = await wc.capturePage();
      const shot = path.join(OUT_DIR, 'smoke-chat.png');
      fs.mkdirSync(OUT_DIR, { recursive: true });
      fs.writeFileSync(shot, image.toPNG());
      shots.push(shot);

      // Visit other views and screenshot them.
      for (const view of ['providers', 'plugins', 'settings']) {
        await wc.executeJavaScript(`document.querySelector('.nav-item[data-view="${view}"]').click()`);
        await new Promise((resolve) => setTimeout(resolve, 700));
        const img = await wc.capturePage();
        const file = path.join(OUT_DIR, `smoke-${view}.png`);
        fs.writeFileSync(file, img.toPNG());
        shots.push(file);
      }

      // modals
      await wc.executeJavaScript(`document.querySelector('.nav-item[data-view="chat"]').click(); document.getElementById('workspace-card').click()`);
      await new Promise((resolve) => setTimeout(resolve, 600));
      const modalShot = path.join(OUT_DIR, 'smoke-workspace.png');
      fs.writeFileSync(modalShot, (await wc.capturePage()).toPNG());
      shots.push(modalShot);
      await wc.executeJavaScript(`document.querySelector('[data-close="modal-workspace"]').click(); document.getElementById('model-picker').click()`);
      await new Promise((resolve) => setTimeout(resolve, 600));
      const modelShot = path.join(OUT_DIR, 'smoke-models.png');
      fs.writeFileSync(modelShot, (await wc.capturePage()).toPNG());
      shots.push(modelShot);
      await wc.executeJavaScript(`document.querySelector('[data-close="modal-models"]').click()`);
    } catch (error) {
      logs.push(`[harness-error] ${error.stack || error.message}`);
    } finally {
      console.log('── renderer logs ──');
      console.log(logs.join('\n') || '(none)');
      console.log('── screenshots ──');
      console.log(shots.join('\n'));
      setTimeout(() => app.quit(), 300);
    }
  });
}

app.on('browser-window-created', (event, win) => {
  if (!win) return;
  attach(win);
});

require('../main.js');
