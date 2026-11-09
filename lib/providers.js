'use strict';

function candidateModelUrls(chatUrl) {
  let value = String(chatUrl || '').trim().replace(/\/+$/, '');
  if (!value) return [];
  if (!/^https?:\/\//i.test(value)) value = `https://${value}`;
  const candidates = [];
  if (/\/chat\/completions$/i.test(value)) {
    candidates.push(value.replace(/\/chat\/completions$/i, '/models'));
    const base = value.replace(/\/chat\/completions$/i, '');
    if (!/\/v\d+$/i.test(base)) candidates.push(`${base}/v1/models`);
  } else if (/\/models$/i.test(value)) {
    candidates.push(value);
  } else {
    candidates.push(`${value}/models`);
    if (!/\/v\d+$/i.test(value)) candidates.push(`${value}/v1/models`);
  }
  return [...new Set(candidates)];
}

async function listModels({ url, apiKey, headers = {}, timeout = 20000 }) {
  const candidates = candidateModelUrls(url);
  if (!candidates.length) return { error: 'Не задан URL провайдера' };
  const errors = [];
  for (const candidate of candidates) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const requestHeaders = { Accept: 'application/json', ...headers };
      if (apiKey) requestHeaders.Authorization = `Bearer ${apiKey}`;
      const response = await fetch(candidate, { headers: requestHeaders, signal: controller.signal });
      if (!response.ok) {
        errors.push(`${candidate}: HTTP ${response.status}`);
        continue;
      }
      const data = await response.json();
      const list = Array.isArray(data?.data) ? data.data : Array.isArray(data?.models) ? data.models : [];
      const models = list
        .map((item) => {
          if (typeof item === 'string') return { id: item, ownedBy: '' };
          const id = item.id || item.name || item.model;
          if (!id) return null;
          return { id: String(id), ownedBy: item.owned_by || item.ownedBy || item.organization || '' };
        })
        .filter(Boolean);
      if (models.length) return { models, endpoint: candidate };
      errors.push(`${candidate}: пустой список моделей`);
    } catch (error) {
      errors.push(`${candidate}: ${error.name === 'AbortError' ? 'таймаут' : error.message}`);
    } finally {
      clearTimeout(timer);
    }
  }
  return { error: `Не удалось получить список моделей. ${errors.join('; ')}` };
}

module.exports = { listModels, candidateModelUrls };
