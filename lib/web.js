'use strict';

const html = require('./html');

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

const BASE_HEADERS = {
  'User-Agent': UA,
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.8,text/plain;q=0.7,*/*;q=0.5',
  'Accept-Language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7',
  'Sec-Fetch-Mode': 'navigate',
  'Upgrade-Insecure-Requests': '1',
  'Cache-Control': 'no-cache',
};

function decodeBuffer(buffer, contentType) {
  const head = buffer.slice(0, 4096).toString('latin1');
  let charset = /charset=["']?([\w-]+)/i.exec(contentType || '')?.[1];
  if (!charset) charset = /<meta[^>]+charset=["']?([\w-]+)/i.exec(head)?.[1];
  if (!charset) charset = /encoding=["']?([\w-]+)/i.exec(head)?.[1];
  charset = (charset || 'utf-8').toLowerCase();
  if (charset === 'utf8') charset = 'utf-8';
  try {
    return new TextDecoder(charset, { fatal: false }).decode(buffer);
  } catch {
    return buffer.toString('utf8');
  }
}

async function request(url, options = {}) {
  const { timeout = 25000, maxBytes = 4 * 1024 * 1024, method = 'GET', body, headers = {}, redirect = 'follow' } = options;
  if (!/^https?:\/\//i.test(url)) throw new Error('URL must start with http:// or https://');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, {
      method,
      body,
      redirect,
      signal: controller.signal,
      headers: { ...BASE_HEADERS, ...headers },
    });
    const contentType = response.headers.get('content-type') || '';
    let buffer = Buffer.alloc(0);
    if (method.toUpperCase() !== 'HEAD') {
      const reader = response.body?.getReader();
      if (reader) {
        const chunks = [];
        let total = 0;
        let truncated = false;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.length;
          if (total > maxBytes) {
            chunks.push(value.slice(0, Math.max(0, value.length - (total - maxBytes))));
            truncated = true;
            try {
              await reader.cancel();
            } catch {
              /* ignore */
            }
            break;
          }
          chunks.push(Buffer.from(value));
        }
        buffer = Buffer.concat(chunks);
        if (truncated) response.__truncated = true;
      } else {
        const arrayBuffer = await response.arrayBuffer();
        buffer = Buffer.from(arrayBuffer).slice(0, maxBytes);
      }
    }
    return {
      status: response.status,
      ok: response.ok,
      statusText: response.statusText,
      contentType,
      finalUrl: response.url || url,
      headers: response.headers,
      text: decodeBuffer(buffer, contentType),
      buffer,
      truncated: !!response.__truncated,
    };
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------- search --------------------------------- */

function normalizeDdgLink(href) {
  if (!href) return '';
  let value = href;
  if (value.startsWith('//')) value = `https:${value}`;
  try {
    const parsed = new URL(value);
    const uddg = parsed.searchParams.get('uddg');
    if (uddg) return decodeURIComponent(uddg);
  } catch {
    return '';
  }
  return value;
}

function parseDuckDuckGo(htmlText) {
  const results = [];
  const blockRe = /<a[^>]+class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = blockRe.exec(htmlText)) && results.length < 12) {
    const url = normalizeDdgLink(html.decodeEntities(match[1]));
    const title = html.decodeEntities(match[2].replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
    if (!url || !title) continue;
    results.push({ title, url, snippet: '' });
  }
  if (!results.length) {
    const liteRe = /<a[^>]+class="result-link"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    while ((match = liteRe.exec(htmlText)) && results.length < 12) {
      const url = normalizeDdgLink(html.decodeEntities(match[1]));
      const title = html.decodeEntities(match[2].replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
      if (url && title) results.push({ title, url, snippet: '' });
    }
  }
  const snippets = [...htmlText.matchAll(/class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/gi)].map((item) =>
    html.decodeEntities(item[1].replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim()
  );
  results.forEach((result, index) => {
    if (snippets[index]) result.snippet = snippets[index];
  });
  return results;
}

function parseBingRss(xml) {
  const results = [];
  const itemRe = /<item>([\s\S]*?)<\/item>/gi;
  let match;
  while ((match = itemRe.exec(xml)) && results.length < 12) {
    const block = match[1];
    const title = html.decodeEntities((/<title>([\s\S]*?)<\/title>/i.exec(block) || [])[1] || '').trim();
    const link = html.decodeEntities((/<link>([\s\S]*?)<\/link>/i.exec(block) || [])[1] || '').trim();
    const description = html
      .decodeEntities((/<description>([\s\S]*?)<\/description>/i.exec(block) || [])[1] || '')
      .replace(/<[^>]+>/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (title && link) results.push({ title, url: link, snippet: description.slice(0, 300) });
  }
  return results;
}

function dedupeResults(results) {
  const seen = new Set();
  const out = [];
  for (const result of results) {
    let key = result.url;
    try {
      const parsed = new URL(result.url);
      key = `${parsed.hostname}${parsed.pathname}`.replace(/\/$/, '');
    } catch {
      /* keep url */
    }
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(result);
  }
  return out;
}

async function searchWeb(query) {
  const q = String(query || '').trim();
  if (!q) return { error: 'Пустой поисковый запрос' };
  const attempts = [];
  const errors = [];

  // 1. DuckDuckGo HTML (good snippets, tolerant of bots)
  try {
    const res = await request(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`, { timeout: 20000 });
    if (res.ok) {
      const parsed = parseDuckDuckGo(res.text);
      if (parsed.length) attempts.push(...parsed.map((item) => ({ ...item, engine: 'duckduckgo' })));
      else errors.push('duckduckgo: no results parsed');
    } else {
      errors.push(`duckduckgo: HTTP ${res.status}`);
    }
  } catch (error) {
    errors.push(`duckduckgo: ${error.message}`);
  }

  // 2. DuckDuckGo lite
  if (attempts.length < 5) {
    try {
      const res = await request(`https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(q)}`, { timeout: 20000 });
      if (res.ok) {
        const parsed = parseDuckDuckGo(res.text);
        if (parsed.length) attempts.push(...parsed.map((item) => ({ ...item, engine: 'duckduckgo-lite' })));
      }
    } catch (error) {
      errors.push(`ddg-lite: ${error.message}`);
    }
  }

  // 3. Bing RSS
  if (attempts.length < 5) {
    try {
      const res = await request(`https://www.bing.com/search?q=${encodeURIComponent(q)}&format=rss&count=20`, { timeout: 20000 });
      if (res.ok) {
        const parsed = parseBingRss(res.text);
        if (parsed.length) attempts.push(...parsed.map((item) => ({ ...item, engine: 'bing' })));
        else errors.push('bing: no results parsed');
      } else {
        errors.push(`bing: HTTP ${res.status}`);
      }
    } catch (error) {
      errors.push(`bing: ${error.message}`);
    }
  }

  const results = dedupeResults(attempts).slice(0, 10);
  if (!results.length) {
    return { error: `Поиск не удался. ${errors.join('; ')}` };
  }
  const lines = results.map((result, index) => {
    const snippet = result.snippet ? `\n   ${result.snippet}` : '';
    return `${index + 1}. ${result.title}\n   ${result.url}${snippet}`;
  });
  return {
    content: `Результаты поиска «${q}»:\n\n${lines.join('\n\n')}\n\nПодсказка: открой нужный результат через read_url (быстро) или browser (если сайт на JavaScript).`,
    results,
  };
}

/* ------------------------------ page fetch ------------------------------ */

async function fetchAndExtract(targetUrl, options = {}) {
  const url = String(targetUrl || '').trim();
  if (!/^https?:\/\//i.test(url)) return { error: 'URL должен начинаться с http:// или https://' };
  try {
    const res = await request(url, { timeout: options.timeout || 30000, maxBytes: 5 * 1024 * 1024 });
    if (!res.ok) {
      const hint =
        res.status === 403 || res.status === 401
          ? '\nСайт требует авторизацию или блокирует простые запросы. Попробуй инструмент browser (action="open") — он открывает страницу в настоящем Chromium.'
          : res.status === 404
            ? '\nСтраница не найдена — проверь URL.'
            : '';
      return { error: `HTTP ${res.status} ${res.statusText} для ${url}.${hint}`, status: res.status };
    }

    const type = (res.contentType || '').toLowerCase();
    if (type.includes('application/pdf')) {
      return {
        content: `URL: ${res.finalUrl}\nPDF-документ (${res.buffer.length} байт). Прямой текст PDF недоступен через read_url — используй инструмент browser (action="open"), он умеет отображать PDF, либо скачай файл.`,
      };
    }
    if (type.includes('application/json') || type.includes('+json')) {
      let text = res.text;
      try {
        text = JSON.stringify(JSON.parse(text), null, 2);
      } catch {
        /* keep raw */
      }
      return { content: `URL: ${res.finalUrl}\nJSON ответ:\n\n${text.slice(0, 20000)}${text.length > 20000 ? '\n… [truncated]' : ''}` };
    }
    if (type.includes('text/plain') || type.includes('text/csv') || type.includes('text/markdown')) {
      const text = res.text;
      return { content: `URL: ${res.finalUrl}\n\n${text.slice(0, 20000)}${text.length > 20000 ? '\n… [truncated]' : ''}` };
    }
    if (!type.includes('html') && !type.includes('xml') && type && !type.startsWith('text/')) {
      return { error: `Неподдерживаемый тип содержимого: ${type} (${res.buffer.length} байт)` };
    }

    const extracted = html.extractReadable(res.text, res.finalUrl);
    const content = html.formatForModel(extracted, res.finalUrl, 20000);
    return { content, title: extracted.title, links: extracted.links, truncated: res.truncated };
  } catch (error) {
    if (error.name === 'AbortError') return { error: 'Таймаут: сайт не ответил за 30 секунд.' };
    return { error: `Сетевая ошибка: ${error.message}` };
  }
}

module.exports = { searchWeb, fetchAndExtract, request, UA, BASE_HEADERS, decodeBuffer };
