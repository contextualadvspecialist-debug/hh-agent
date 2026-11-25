import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createJsonPoster, formatNetworkError } from '../src/http.js';
import { makeLlmClient } from '../src/llm.js';

function startServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve({
        server,
        url: `http://127.0.0.1:${addr.port}`,
        close: () => new Promise((r) => server.close(() => r()))
      });
    });
  });
}

test('createJsonPoster сбрасывает пул и прозрачно повторяет запрос при обрыве keep-alive сокета', async () => {
  let requests = 0;
  const sockets = new Set();
  const srv = await startServer((req, res) => {
    req.resume();
    requests++;
    if (requests === 2) {
      // Имитация зависшего/оборванного keep-alive сокета при смене VPN на 2-м запросе.
      req.socket.destroy();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, count: requests }));
  });
  srv.server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });

  const poster = createJsonPoster({ timeoutMs: 3000 });
  try {
    const first = await poster.post(srv.url, { step: 1 });
    assert.deepEqual(first.json(), { ok: true, count: 1 });
    const epochBefore = poster.stats().epoch;

    const second = await poster.post(srv.url, { step: 2 });
    assert.deepEqual(second.json(), { ok: true, count: 3 });
    assert.equal(requests, 3);
    assert.ok(poster.stats().epoch > epochBefore);
  } finally {
    poster.reset();
    sockets.forEach((s) => s.destroy());
    await srv.close();
  }
});

test('createJsonPoster не дублирует неидемпотентный POST при таймауте, но сбрасывает агент для следующих запросов', async () => {
  let attempts = 0;
  const sockets = new Set();
  const srv = await startServer((req, res) => {
    req.resume();
    attempts++;
    if (attempts === 1) {
      // Намеренно не отвечаем до срабатывания timeoutMs.
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, recovered: true }));
  });
  srv.server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });

  const poster = createJsonPoster({ timeoutMs: 80 });
  try {
    await assert.rejects(
      () => poster.post(srv.url, { msg: 'send' }, { idempotent: false }),
      (err) => {
        assert.equal(err.code, 'ETIMEDOUT');
        assert.match(err.message, /timeout/i);
        return true;
      }
    );
    assert.equal(attempts, 1);
    assert.equal(poster.stats().epoch, 1);

    const recovered = await poster.post(srv.url, { msg: 'next' }, { timeoutMs: 2000 });
    assert.deepEqual(recovered.json(), { ok: true, recovered: true });
    assert.equal(attempts, 2);
  } finally {
    poster.reset();
    sockets.forEach((s) => s.destroy());
    await srv.close();
  }
});

test('createJsonPoster не повторяет HTTP 500 и передаёт тело ответа дальше', async () => {
  let calls = 0;
  const srv = await startServer((req, res) => {
    req.resume();
    calls++;
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'server error' }));
  });

  const poster = createJsonPoster({ timeoutMs: 2000 });
  try {
    const res = await poster.post(srv.url, { ping: true }, { idempotent: true });
    assert.equal(calls, 1);
    assert.equal(res.ok, false);
    assert.equal(res.status, 500);
    assert.match(res.text(), /server error/);
  } finally {
    poster.reset();
    await srv.close();
  }
});

test('makeLlmClient восстанавливается после сброса соединения с диагностикой ошибки', async () => {
  let calls = 0;
  const srv = await startServer((req, res) => {
    req.resume();
    calls++;
    if (calls === 1) {
      req.socket.destroy();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: 'ок' } }] }));
  });

  const llm = makeLlmClient({ baseUrl: srv.url, apiKey: 'test-key', model: 'test-model' });
  try {
    const reply = await llm([{ role: 'user', content: 'ping' }]);
    assert.equal(reply, 'ок');
    assert.equal(calls, 2);
  } finally {
    llm.reset();
    await srv.close();
  }
});

test('formatNetworkError включает сетевой код причины', () => {
  const err = formatNetworkError(Object.assign(new Error('connect failed'), { code: 'ENOTFOUND' }), 5000);
  assert.equal(err.code, 'ENOTFOUND');
  assert.equal(err.message, 'ENOTFOUND: connect failed');
});
