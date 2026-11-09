'use strict';

const crypto = require('crypto');
const http = require('http');
const { shell } = require('electron');

function base64url(buffer) {
  return Buffer.from(buffer)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function listen(server, port = 0) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server.address().port));
  });
}

function closeServer(server) {
  return new Promise((resolve) => {
    try {
      server.close(() => resolve());
    } catch {
      resolve();
    }
    setTimeout(resolve, 500);
  });
}

function htmlPage(title, message) {
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>${title}</title>
  <style>body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#141414;color:#fff;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
  .card{max-width:480px;padding:40px;border:1px solid #333;border-radius:16px;background:#1c1c1c;text-align:center}
  h1{font-size:20px;margin:0 0 12px}p{color:#a0a0a0;line-height:1.5;margin:0}</style></head>
  <body><div class="card"><h1>${title}</h1><p>${message}</p></div></body></html>`;
}

function parseTokenResponse(text, contentType) {
  if (!text) return {};
  if ((contentType || '').includes('json') || /^\s*\{/.test(text)) {
    try {
      return JSON.parse(text);
    } catch {
      /* fall through */
    }
  }
  const params = new URLSearchParams(text);
  const out = {};
  for (const [key, value] of params.entries()) out[key] = value;
  return out;
}

async function exchangeToken({ tokenUrl, params, headers = {} }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    const response = await fetch(tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
        ...headers,
      },
      body: new URLSearchParams(params).toString(),
      signal: controller.signal,
    });
    const text = await response.text();
    const parsed = parseTokenResponse(text, response.headers.get('content-type'));
    if (!response.ok || parsed.error) {
      const message = parsed.error_description || parsed.error || text.slice(0, 400) || `HTTP ${response.status}`;
      throw new Error(`OAuth: ${message}`);
    }
    return parsed;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Interactive OAuth 2.0 authorization-code flow with a loopback redirect and PKCE.
 * Opens the system browser and resolves with the token response.
 */
async function authorize({ auth, clientId, clientSecret, connectorName, onStatus }) {
  if (!auth || !auth.authorizationUrl || !auth.tokenUrl) throw new Error('Коннектор не поддерживает OAuth');
  if (!clientId) throw new Error('Нужен OAuth Client ID (создай приложение у провайдера)');

  const verifier = base64url(crypto.randomBytes(48));
  const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
  const state = base64url(crypto.randomBytes(16));
  const server = http.createServer();
  const port = await listen(server, 0);
  const redirectUri = `http://127.0.0.1:${port}/callback`;

  const url = new URL(auth.authorizationUrl);
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('state', state);
  if (Array.isArray(auth.scopes) && auth.scopes.length) url.searchParams.set('scope', auth.scopes.join(' '));
  if (auth.pkce !== false) {
    url.searchParams.set('code_challenge', challenge);
    url.searchParams.set('code_challenge_method', 'S256');
  }
  for (const [key, value] of Object.entries(auth.extraAuthParams || {})) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
  }

  const authUrl = url.toString();
  onStatus?.({
    phase: 'waiting',
    message: `Открываю браузер для входа в ${connectorName || 'сервис'}…`,
    authUrl,
    redirectUri,
  });

  try {
    await shell.openExternal(authUrl);
  } catch {
    onStatus?.({ phase: 'waiting', message: 'Не удалось открыть браузер автоматически — открой ссылку вручную.', authUrl });
  }

  const code = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('Время ожидания входа истекло (5 минут)'));
      closeServer(server);
    }, 300000);

    server.on('request', (request, response) => {
      const requestUrl = new URL(request.url, redirectUri);
      if (requestUrl.pathname !== '/callback') {
        response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        response.end('Not found');
        return;
      }
      const error = requestUrl.searchParams.get('error');
      const returnedState = requestUrl.searchParams.get('state');
      const returnedCode = requestUrl.searchParams.get('code');
      if (error) {
        clearTimeout(timeout);
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        response.end(htmlPage('Не удалось войти', `Сервис вернул ошибку: ${error}`));
        closeServer(server);
        reject(new Error(`Авторизация отклонена: ${error}`));
        return;
      }
      if (returnedState !== state) {
        clearTimeout(timeout);
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        response.end(htmlPage('Ошибка', 'Неверный state — попробуй ещё раз.'));
        closeServer(server);
        reject(new Error('OAuth: неверный state (возможная CSRF-атака)'));
        return;
      }
      if (!returnedCode) {
        clearTimeout(timeout);
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        response.end(htmlPage('Ошибка', 'Сервис не вернул код авторизации.'));
        closeServer(server);
        reject(new Error('OAuth: сервис не вернул код'));
        return;
      }
      clearTimeout(timeout);
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end(htmlPage('Готово', 'Вход выполнен. Можно закрыть эту страницу и вернуться в Comrade Harness.'));
      closeServer(server);
      resolve(returnedCode);
    });

    server.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });

  onStatus?.({ phase: 'exchanging', message: 'Получаю токен…' });

  const params = {
    grant_type: 'authorization_code',
    code,
    client_id: clientId,
    redirect_uri: redirectUri,
  };
  if (auth.pkce !== false) params.code_verifier = verifier;
  if (clientSecret) params.client_secret = clientSecret;

  const token = await exchangeToken({ tokenUrl: auth.tokenUrl, params });
  onStatus?.({ phase: 'done', message: 'Токен получен' });
  return {
    ...token,
    expires_at: token.expires_in ? Date.now() + Number(token.expires_in) * 1000 : null,
  };
}

async function refreshToken({ auth, clientId, clientSecret, refreshToken: refresh }) {
  const params = {
    grant_type: 'refresh_token',
    refresh_token: refresh,
    client_id: clientId,
  };
  if (clientSecret) params.client_secret = clientSecret;
  const token = await exchangeToken({ tokenUrl: auth.tokenUrl, params });
  return {
    ...token,
    refresh_token: token.refresh_token || refresh,
    expires_at: token.expires_in ? Date.now() + Number(token.expires_in) * 1000 : null,
  };
}

module.exports = { authorize, refreshToken, exchangeToken };
