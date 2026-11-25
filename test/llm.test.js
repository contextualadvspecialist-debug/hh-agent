import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { llmReady, makeLlmClient } from '../src/llm.js';

function startMockServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const raw = Buffer.concat(chunks).toString('utf8');
      const body = raw ? JSON.parse(raw) : null;
      await handler(req, body, res);
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve({ server, baseUrl: `http://127.0.0.1:${addr.port}` });
    });
  });
}

test('llmReady проверяет наличие baseUrl, apiKey и model', () => {
  assert.equal(llmReady(null), false);
  assert.equal(llmReady({ baseUrl: 'http://localhost', apiKey: '', model: 'm' }), false);
  assert.equal(llmReady({ baseUrl: 'http://localhost', apiKey: 'k', model: 'm' }), true);
  assert.equal(makeLlmClient({ baseUrl: '', apiKey: 'k', model: 'm' }), null);
});

test('makeLlmClient возвращает текст и передаёт data.usage в onUsage', async () => {
  let seenAuth = '';
  let seenPayload = null;
  const { server, baseUrl } = await startMockServer((req, body, res) => {
    seenAuth = req.headers.authorization || '';
    seenPayload = body;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      model: 'gpt-test',
      choices: [{ message: { content: '{"score": 91}' } }],
      usage: { prompt_tokens: 120, completion_tokens: 45 }
    }));
  });

  const usages = [];
  const client = makeLlmClient(
    { baseUrl: `${baseUrl}/`, apiKey: 'secret-key', model: 'gpt-default', reasoningEffort: 'low' },
    { onUsage: (u) => usages.push(u) }
  );

  try {
    const text = await client([{ role: 'user', content: 'ping' }], { json: true, maxTokens: 300 });
    assert.equal(text, '{"score": 91}');
    assert.equal(seenAuth, 'Bearer secret-key');
    assert.deepEqual(seenPayload.response_format, { type: 'json_object' });
    assert.equal(seenPayload.reasoning_effort, 'low');
    assert.equal(seenPayload.max_tokens, 300);
    assert.deepEqual(usages, [{
      model: 'gpt-test',
      promptTokens: 120,
      completionTokens: 45,
      totalTokens: 165
    }]);
  } finally {
    client.reset();
    await new Promise((r) => server.close(r));
  }
});

test('makeLlmClient работает без usage, при ошибке в onUsage и бросает ошибку на HTTP 429', async () => {
  let round = 0;
  const { server, baseUrl } = await startMockServer((_req, _body, res) => {
    round++;
    if (round === 1) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{ message: { content: 'ok' } }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
      }));
      return;
    }
    res.writeHead(429, { 'Content-Type': 'text/plain' });
    res.end('rate limit exceeded');
  });

  const client = makeLlmClient(
    { baseUrl, apiKey: 'k', model: 'm' },
    { onUsage: () => { throw new Error('telemetry failure'); } }
  );

  try {
    const origWarn = console.warn;
    console.warn = () => {};
    let out;
    try {
      out = await client([{ role: 'user', content: 'hi' }]);
    } finally {
      console.warn = origWarn;
    }
    assert.equal(out, 'ok');
    await assert.rejects(() => client([{ role: 'user', content: 'hi' }]), /LLM 429: rate limit exceeded/);
  } finally {
    client.reset();
    await new Promise((r) => server.close(r));
  }
});
