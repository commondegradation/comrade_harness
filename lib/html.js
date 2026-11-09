'use strict';

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', mdash: '—', ndash: '–',
  laquo: '«', raquo: '»', ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', copy: '©', reg: '®',
  trade: '™', deg: '°', euro: '€', pound: '£', yen: '¥', times: '×', divide: '÷', middot: '·',
  bull: '•', dagger: '†', permil: '‰', prime: '′', Prime: '″', larr: '←', uarr: '↑', rarr: '→',
  darr: '↓', harr: '↔', ensp: ' ', emsp: ' ', thinsp: ' ', zwnj: '', zwj: '', shy: '­',
  frac12: '½', frac14: '¼', frac34: '¾', sup2: '²', sup3: '³', micro: 'µ', para: '¶', sect: '§',
};

function decodeEntities(input) {
  if (!input) return '';
  return String(input).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]{1,31});/g, (match, body) => {
    if (body[0] === '#') {
      const isHex = body[1] === 'x' || body[1] === 'X';
      const code = parseInt(body.slice(isHex ? 2 : 1), isHex ? 16 : 10);
      if (Number.isFinite(code) && code > 0 && code <= 0x10ffff) {
        try {
          return String.fromCodePoint(code);
        } catch {
          return match;
        }
      }
      return match;
    }
    const value = NAMED_ENTITIES[body];
    return value === undefined ? match : value;
  });
}

function stripNoise(html) {
  return String(html)
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<template\b[\s\S]*?<\/template>/gi, ' ')
    .replace(/<svg\b[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<canvas\b[\s\S]*?<\/canvas>/gi, ' ')
    .replace(/<iframe\b[\s\S]*?<\/iframe>/gi, ' ')
    .replace(/<nav\b[\s\S]*?<\/nav>/gi, ' ')
    .replace(/<footer\b[\s\S]*?<\/footer>/gi, ' ')
    .replace(/<aside\b[\s\S]*?<\/aside>/gi, ' ')
    .replace(/<form\b[\s\S]*?<\/form>/gi, ' ')
    .replace(/<dialog\b[\s\S]*?<\/dialog>/gi, ' ')
    .replace(/<button\b[\s\S]*?<\/button>/gi, ' ')
    .replace(/<head\b[\s\S]*?<\/head>/gi, ' ')
    .replace(/<(input|select|textarea|label)\b[^>]*>/gi, ' ');
}

function extractTitle(html) {
  const og = /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i.exec(html);
  if (og) return decodeEntities(og[1]).trim();
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (title) return decodeEntities(title[1]).replace(/\s+/g, ' ').trim();
  const h1 = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html);
  if (h1) return decodeEntities(h1[1].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
  return '';
}

function extractMeta(html, name) {
  const re = new RegExp(`<meta[^>]+(?:name|property)=["']${name}["'][^>]+content=["']([^"']*)["']`, 'i');
  const match = re.exec(html);
  return match ? decodeEntities(match[1]).trim() : '';
}

function textLength(html) {
  return stripNoise(html).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().length;
}

function pickContent(html) {
  const article = /<article\b[^>]*>([\s\S]*?)<\/article>/i.exec(html);
  if (article && textLength(article[1]) > 400) return article[1];
  const main = /<main\b[^>]*>([\s\S]*?)<\/main>/i.exec(html);
  if (main && textLength(main[1]) > 400) return main[1];
  const roleMain = /<div\b[^>]*role=["']main["'][^>]*>([\s\S]*?)<\/div>/i.exec(html);
  if (roleMain && textLength(roleMain[1]) > 400) return roleMain[1];
  const body = /<body\b[^>]*>([\s\S]*)<\/body>/i.exec(html);
  return body ? body[1] : html;
}

function extractLinks(html, baseUrl, limit = 80) {
  const links = [];
  const seen = new Set();
  const re = /<a\b[^>]*href=["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = re.exec(html)) && links.length < limit) {
    const rawHref = match[1].trim();
    if (!rawHref || /^(javascript|mailto|tel|data):/i.test(rawHref)) continue;
    let absolute;
    try {
      absolute = new URL(rawHref, baseUrl).toString();
    } catch {
      continue;
    }
    if (!/^https?:/i.test(absolute)) continue;
    const text = decodeEntities(match[2].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
    if (!text || text.length > 120) continue;
    if (seen.has(absolute)) continue;
    seen.add(absolute);
    links.push({ text, url: absolute });
  }
  return links;
}

function htmlToText(html, baseUrl) {
  let working = stripNoise(html);

  // Keep code blocks intact and readable.
  const codeBlocks = [];
  working = working.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (match, inner) => {
    const languageMatch = /class=["'][^"']*language-([\w+-]+)/i.exec(match);
    const code = decodeEntities(inner.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ''));
    const fence = '```';
    codeBlocks.push(`${fence}${languageMatch ? languageMatch[1] : ''}\n${code.replace(/\n{3,}/g, '\n\n').trim()}\n${fence}`);
    return `\n\n\u0000CODE${codeBlocks.length - 1}\u0000\n\n`;
  });

  working = working.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (match, level, inner) => {
    const text = inner.replace(/<[^>]+>/g, ' ');
    return `\n\n${'#'.repeat(Math.min(3, Number(level)))} ${text}\n\n`;
  });

  working = working.replace(/<li\b[^>]*>/gi, '\n- ');
  working = working.replace(/<tr\b[^>]*>/gi, '\n');
  working = working.replace(/<\/t[dh]>/gi, ' | ');
  working = working.replace(/<br\s*\/?>/gi, '\n');
  working = working.replace(/<\/(p|div|section|article|header|blockquote|table|ul|ol|h[1-6]|main|figure)>/gi, '\n');
  working = working.replace(/<hr\b[^>]*>/gi, '\n---\n');

  working = working.replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (match, href, inner) => {
    const text = decodeEntities(inner.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
    if (!text) return ' ';
    let absolute = href;
    try {
      absolute = new URL(href, baseUrl).toString();
    } catch {
      return text;
    }
    if (!/^https?:/i.test(absolute) || text.startsWith('http')) return text;
    return `[${text}](${absolute})`;
  });

  working = working.replace(/<img\b[^>]*alt=["']([^"']*)["'][^>]*>/gi, (match, alt) => (alt ? `[image: ${alt}] ` : ' '));
  working = working.replace(/<[^>]+>/g, ' ');

  let text = decodeEntities(working);
  text = text.replace(/\u0000CODE(\d+)\u0000/g, (match, index) => codeBlocks[Number(index)] || '');
  text = text
    .split('\n')
    .map((line) => line.replace(/[ \t\u00a0]+/g, ' ').replace(/\s+\|$/, ' |').trim())
    .join('\n');
  text = text.replace(/\n{3,}/g, '\n\n').trim();
  return text;
}

function extractReadable(html, url) {
  const safeHtml = String(html).slice(0, 4_000_000);
  const title = extractTitle(safeHtml) || url;
  const description = extractMeta(safeHtml, 'og:description') || extractMeta(safeHtml, 'description');
  const content = pickContent(safeHtml);
  const links = extractLinks(content, url);
  let text = htmlToText(content, url);
  if (!text || text.length < 80) {
    // Fallback: whole document (some pages nest everything outside <body> oddly).
    const whole = htmlToText(safeHtml, url);
    if (whole.length > text.length) text = whole;
  }
  return { title, description, text, links };
}

function formatForModel({ title, description, text, links }, url, limit = 20000) {
  const parts = [];
  parts.push(`URL: ${url}`);
  if (title) parts.push(`Title: ${title}`);
  if (description) parts.push(`Description: ${description}`);
  parts.push('');
  let body = text || '(no readable text)';
  if (body.length > limit) body = `${body.slice(0, limit)}\n\n… [truncated ${body.length - limit} chars]`;
  parts.push(body);
  if (links && links.length) {
    parts.push('', 'Links on page:');
    for (const link of links.slice(0, 40)) parts.push(`- ${link.text} — ${link.url}`);
  }
  return parts.join('\n');
}

module.exports = { decodeEntities, stripNoise, extractReadable, extractLinks, htmlToText, formatForModel, extractTitle };
