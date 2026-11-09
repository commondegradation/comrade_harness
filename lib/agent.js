'use strict';

const workspace = require('./workspace');
const { ToolRegistry } = require('./tools');

const MAX_TOOL_RESULT = 60000;

function createAbortError() {
  const error = new Error('aborted');
  error.name = 'AbortError';
  return error;
}

async function* sseEvents(body, signal) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      if (signal?.aborted) throw createAbortError();
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
      let index;
      while ((index = buffer.indexOf('\n\n')) >= 0) {
        const raw = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        const data = raw
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trim())
          .join('\n');
        if (data) yield data;
      }
    }
    const tail = buffer.trim();
    if (tail) {
      const data = tail
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim())
        .join('\n');
      if (data) yield data;
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* ignore */
    }
  }
}

function flattenText(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object') return part.text || part.content || '';
        return '';
      })
      .join('');
  }
  if (typeof value === 'object') return value.text || '';
  return String(value);
}

function extractReasoning(delta) {
  if (!delta) return '';
  return (
    flattenText(delta.reasoning_content) ||
    flattenText(delta.reasoning) ||
    flattenText(delta.thinking) ||
    flattenText(delta.thought) ||
    ''
  );
}

function normalizeChatUrl(url) {
  let value = String(url || '').trim().replace(/\/+$/, '');
  if (!value) return '';
  if (!/^https?:\/\//i.test(value)) value = `https://${value}`;
  return value;
}

class AgentRun {
  constructor({ provider, model, apiKey, headers, messages, tools, temperature, maxTokens, maxSteps, signal, emit }) {
    this.provider = provider;
    this.model = model;
    this.apiKey = apiKey;
    this.headers = headers || {};
    this.messages = messages;
    this.tools = tools;
    this.temperature = temperature;
    this.maxTokens = maxTokens;
    this.maxSteps = maxSteps;
    this.signal = signal;
    this.emit = emit;
    this.usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    this.newMessages = [];
    this.steps = 0;
  }

  async run() {
    const defs = this.tools.definitions();
    while (this.steps < this.maxSteps) {
      if (this.signal.aborted) return { aborted: true };
      this.steps += 1;
      this.emit({ type: 'step', step: this.steps, maxSteps: this.maxSteps, toolCount: defs.length });

      const result = await this.streamOnce(defs);
      if (result.aborted) return { aborted: true };

      const message = {
        role: 'assistant',
        content: result.content || null,
      };
      if (result.toolCalls.length) message.tool_calls = result.toolCalls;
      if (result.reasoning) this.emit({ type: 'reasoning-done', text: result.reasoning });
      this.messages.push(message);
      this.newMessages.push({ ...message, reasoning: result.reasoning || '' });

      if (!result.toolCalls.length) {
        return { messages: this.newMessages, usage: this.usage, steps: this.steps };
      }

      for (const call of result.toolCalls) {
        if (this.signal.aborted) return { messages: this.newMessages, usage: this.usage, steps: this.steps, aborted: true };
        const name = call.function?.name || '';
        const rawArgs = call.function?.arguments ?? '{}';
        let args = {};
        let parseError = '';
        try {
          args = typeof rawArgs === 'string' ? JSON.parse(rawArgs || '{}') : rawArgs || {};
        } catch {
          parseError = 'Аргументы инструмента не являются корректным JSON';
          args = {};
        }

        this.emit({ type: 'tool-start', id: call.id, name, args: parseError ? { __raw: rawArgs } : args, parseError });

        const started = Date.now();
        let outcome;
        if (parseError) {
          outcome = { error: `${parseError}. Передай корректный JSON в arguments.` };
        } else {
          outcome = await this.tools.execute(name, args);
        }
        const durationMs = Date.now() - started;

        let content;
        let isError = false;
        if (outcome.error) {
          content = `Error: ${outcome.error}`;
          isError = true;
        } else {
          content = typeof outcome.content === 'string' ? outcome.content : JSON.stringify(outcome.content ?? outcome);
          if (!content) content = '(пустой результат)';
        }
        if (content.length > MAX_TOOL_RESULT) content = `${content.slice(0, MAX_TOOL_RESULT)}\n… [результат обрезан]`;

        const toolMessage = { role: 'tool', tool_call_id: call.id, name, content, args };
        this.messages.push(toolMessage);
        this.newMessages.push(toolMessage);
        this.emit({ type: 'tool-result', id: call.id, name, isError, content, durationMs });
      }
    }

    this.emit({ type: 'limit', maxSteps: this.maxSteps });
    return { messages: this.newMessages, usage: this.usage, steps: this.steps, limitReached: true };
  }

  buildRequestBody(stream, defs) {
    const body = {
      model: this.model,
      messages: this.messages,
      temperature: this.temperature,
      max_tokens: this.maxTokens,
      stream,
    };
    if (defs && defs.length) {
      body.tools = defs;
      body.tool_choice = 'auto';
    }
    if (stream) body.stream_options = { include_usage: true };
    return body;
  }

  async postJob(body) {
    const url = normalizeChatUrl(this.provider.url);
    if (!url) throw new Error('Не задан URL провайдера');
    const headers = {
      'Content-Type': 'application/json',
      Accept: body.stream ? 'text/event-stream' : 'application/json',
      ...this.headers,
    };
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    this.signal.addEventListener('abort', onAbort, { once: true });
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response.ok) {
        const text = await response.text().catch(() => '');
        const error = new Error(`HTTP ${response.status}: ${extractApiError(text) || response.statusText}`);
        error.status = response.status;
        error.body = text;
        throw error;
      }
      return response;
    } catch (error) {
      if (error.name === 'AbortError') throw createAbortError();
      throw error;
    } finally {
      this.signal.removeEventListener('abort', onAbort);
    }
  }

  async streamOnce(defs) {
    const body = this.buildRequestBody(true, defs);
    this.emit({ type: 'status', status: 'request' });

    let response;
    let attempts = 0;
    while (true) {
      try {
        response = await this.postJob(body);
        break;
      } catch (error) {
        if (error.name === 'AbortError') return { aborted: true };
        const retriable = error.status === 429 || (error.status >= 500 && error.status < 600);
        if (retriable && attempts < 2) {
          attempts += 1;
          const wait = 2000 * attempts;
          this.emit({ type: 'retry', attempt: attempts, message: error.message, waitMs: wait });
          await new Promise((resolve) => setTimeout(resolve, wait));
          continue;
        }
        if (error.status === 400 && /stream_options/i.test(error.body || '')) {
          // Provider rejects stream_options: retry without it.
          delete body.stream_options;
          attempts += 1;
          if (attempts <= 3) continue;
        }
        if (error.status === 400 && /stream/i.test(error.body || '') && !/stream_options/i.test(error.body || '')) {
          this.emit({ type: 'status', status: 'non-stream' });
          return await this.nonStreamOnce(defs);
        }
        throw error;
      }
    }

    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('text/event-stream')) {
      return await this.parseJsonResponse(response);
    }

    return await this.parseStream(response);
  }

  async nonStreamOnce(defs) {
    const body = this.buildRequestBody(false, defs);
    const response = await this.postJob(body);
    return await this.parseJsonResponse(response);
  }

  async parseJsonResponse(response) {
    const text = await response.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(`Ответ провайдера не JSON: ${text.slice(0, 400)}`);
    }
    if (data.error) {
      throw new Error(extractApiError(text) || data.error.message || 'Ошибка провайдера');
    }
    const choice = data.choices?.[0];
    const message = choice?.message || {};
    const reasoning = flattenText(message.reasoning_content) || flattenText(message.reasoning) || '';
    const content = flattenText(message.content);
    if (reasoning) this.emit({ type: 'reasoning', text: reasoning });
    if (content) this.emit({ type: 'content', text: content });
    if (data.usage) this.addUsage(data.usage);
    const toolCalls = (message.tool_calls || []).map((call, index) => ({
      id: call.id || `call_${index}_${Date.now()}`,
      type: 'function',
      function: { name: call.function?.name || '', arguments: typeof call.function?.arguments === 'string' ? call.function.arguments : JSON.stringify(call.function?.arguments || {}) },
    }));
    return { content, reasoning, toolCalls };
  }

  async parseStream(response) {
    let content = '';
    let reasoning = '';
    const toolCalls = new Map();
    let finishReason = null;
    const startedAt = Date.now();
    let firstTokenAt = 0;

    for await (const data of sseEvents(response.body, this.signal)) {
      if (this.signal.aborted) return { aborted: true };
      if (data === '[DONE]') break;
      let chunk;
      try {
        chunk = JSON.parse(data);
      } catch {
        continue;
      }
      if (chunk.error) {
        throw new Error(chunk.error.message || JSON.stringify(chunk.error).slice(0, 300));
      }
      if (chunk.usage) this.addUsage(chunk.usage);
      const choice = chunk.choices?.[0];
      if (!choice) continue;
      const delta = choice.delta || choice.message || {};
      if (choice.finish_reason) finishReason = choice.finish_reason;

      const reasoningDelta = extractReasoning(delta);
      if (reasoningDelta) {
        if (!firstTokenAt) {
          firstTokenAt = Date.now();
          this.emit({ type: 'first-token', latencyMs: firstTokenAt - startedAt });
        }
        reasoning += reasoningDelta;
        this.emit({ type: 'reasoning', text: reasoningDelta });
      }

      const contentDelta = flattenText(delta.content);
      if (contentDelta) {
        if (!firstTokenAt) {
          firstTokenAt = Date.now();
          this.emit({ type: 'first-token', latencyMs: firstTokenAt - startedAt });
        }
        content += contentDelta;
        this.emit({ type: 'content', text: contentDelta });
      }

      if (Array.isArray(delta.tool_calls)) {
        for (const call of delta.tool_calls) {
          const index = Number.isInteger(call.index) ? call.index : toolCalls.size;
          const existing = toolCalls.get(index) || {
            id: '',
            type: 'function',
            function: { name: '', arguments: '' },
          };
          if (call.id) existing.id = call.id;
          if (call.function?.name) existing.function.name = (existing.function.name || '') + call.function.name;
          if (call.function?.arguments) existing.function.arguments += call.function.arguments;
          toolCalls.set(index, existing);
        }
      }
    }

    const calls = [...toolCalls.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, value], index) => ({
        id: value.id || `call_${index}_${Date.now()}`,
        type: 'function',
        function: { name: value.function.name, arguments: value.function.arguments || '{}' },
      }))
      .filter((call) => call.function.name);

    if (!content && !calls.length && finishReason && finishReason !== 'stop') {
      this.emit({ type: 'warning', message: `Модель завершила ответ без текста (finish_reason=${finishReason})` });
    }
    return { content, reasoning, toolCalls: calls };
  }

  addUsage(usage) {
    if (!usage) return;
    this.usage.promptTokens += Number(usage.prompt_tokens || 0);
    this.usage.completionTokens += Number(usage.completion_tokens || 0);
    this.usage.totalTokens += Number(usage.total_tokens || 0);
    this.emit({ type: 'usage', usage: { ...this.usage } });
  }
}

function extractApiError(text) {
  if (!text) return '';
  try {
    const parsed = JSON.parse(text);
    const message = parsed.error?.message || parsed.error?.error?.message || parsed.error || parsed.message || parsed.detail;
    if (message) return typeof message === 'string' ? message : JSON.stringify(message);
  } catch {
    /* not json */
  }
  return text.slice(0, 600);
}

function buildSystemMessages({ systemPrompt, extraContext }) {
  const parts = [String(systemPrompt || '').trim()].filter(Boolean);
  const ws = workspace.currentWorkspace();
  const factLines = [];
  if (ws && !ws.broken) factLines.push(`Workspace folder: ${ws.path}`);
  else factLines.push('Workspace folder: not selected (relative file paths resolve against the home folder).');
  factLines.push(`Current date: ${new Date().toLocaleString('ru-RU')} (${Intl.DateTimeFormat().resolvedOptions().timeZone})`);
  factLines.push(`Platform: ${process.platform}`);
  if (extraContext) factLines.push(extraContext);
  parts.push(`# Environment\n${factLines.join('\n')}`);
  return parts.join('\n\n');
}

async function runAgent(options) {
  const {
    requestId,
    provider,
    model,
    apiKey,
    headers,
    history,
    systemPrompt,
    extraContext,
    temperature,
    maxTokens,
    maxSteps,
    signal,
    emit,
    browser,
    mcpManager,
    connectorManager,
  } = options;

  const tools = new ToolRegistry({ browser, mcpManager, connectorManager });
  const systemContent = buildSystemMessages({ systemPrompt, extraContext });
  const messages = [{ role: 'system', content: systemContent }, ...sanitizeHistory(history)];

  const run = new AgentRun({
    provider,
    model,
    apiKey,
    headers,
    messages,
    tools,
    temperature,
    maxTokens,
    maxSteps: Math.max(1, Math.min(60, Number(maxSteps) || 24)),
    signal,
    emit: (event) => emit({ ...event, requestId }),
  });

  return run.run();
}

function sanitizeHistory(history) {
  const out = [];
  for (const message of Array.isArray(history) ? history : []) {
    if (!message || !message.role) continue;
    if (message.role === 'system') continue;
    const clean = { role: message.role };
    if (message.content !== undefined && message.content !== null && message.content !== '') clean.content = message.content;
    else if (message.role === 'assistant') clean.content = null;
    if (message.tool_calls && message.tool_calls.length) {
      clean.tool_calls = message.tool_calls.map((call, index) => ({
        id: call.id || `call_${index}`,
        type: 'function',
        function: {
          name: call.function?.name || '',
          arguments: typeof call.function?.arguments === 'string' ? call.function.arguments : JSON.stringify(call.function?.arguments || {}),
        },
      }));
    }
    if (message.role === 'tool') {
      if (!message.tool_call_id) continue;
      clean.tool_call_id = message.tool_call_id;
      if (message.name) clean.name = message.name;
      clean.content = typeof message.content === 'string' ? message.content : JSON.stringify(message.content);
    }
    out.push(clean);
  }
  return out;
}

module.exports = { runAgent, sanitizeHistory, extractApiError, normalizeChatUrl };
