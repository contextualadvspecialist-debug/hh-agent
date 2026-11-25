import http from 'node:http';
import https from 'node:https';

const REUSABLE_RESET_CODES = new Set(['ECONNRESET', 'EPIPE', 'ECONNABORTED']);
const IDEMPOTENT_RETRY_CODES = new Set([
  'ECONNRESET',
  'EPIPE',
  'ECONNABORTED',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'ENOTFOUND',
  'EAI_AGAIN'
]);

/**
 * Formats low-level socket or timeout errors with diagnostic codes while preserving cause.
 */
export function formatNetworkError(err, timeoutMs) {
  if (err?.name === 'TimeoutError' || err?.cause?.name === 'TimeoutError') {
    const seconds = Math.max(1, Math.round((timeoutMs ?? 0) / 1000));
    const out = new Error(timeoutMs ? `timeout after ${seconds}s` : 'request timeout', { cause: err });
    out.code = 'ETIMEDOUT';
    out.isTimeout = true;
    return out;
  }
  const code = err?.code || err?.cause?.code || '';
  const detail = err?.message || err?.cause?.message || 'network error';
  const msg = code && !String(detail).startsWith(code) ? `${code}: ${detail}` : detail;
  const out = new Error(msg, { cause: err });
  if (code) out.code = code;
  return out;
}

function sendJsonOnce(targetUrl, payloadBuffer, { agent, headers, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const parsed = targetUrl instanceof URL ? targetUrl : new URL(targetUrl);
    const transport = parsed.protocol === 'http:' ? http : https;
    const signal = timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined;
    let settled = false;
    let responseStarted = false;

    const fail = (err, reusedSocket) => {
      if (settled) return;
      settled = true;
      reject({ err, reusedSocket, responseStarted });
    };

    const req = transport.request(parsed, {
      method: 'POST',
      agent,
      signal,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': payloadBuffer.byteLength,
        ...headers
      }
    }, (res) => {
      responseStarted = true;
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('error', (err) => fail(err, Boolean(req.reusedSocket)));
      res.on('aborted', () => fail(Object.assign(new Error('response aborted'), { code: 'ECONNRESET' }), Boolean(req.reusedSocket)));
      res.on('end', () => {
        if (settled) return;
        settled = true;
        const bodyText = Buffer.concat(chunks).toString('utf8');
        const status = res.statusCode ?? 0;
        resolve({
          status,
          ok: status >= 200 && status < 300,
          text: () => bodyText,
          json: () => JSON.parse(bodyText)
        });
      });
    });

    req.on('error', (err) => fail(err, Boolean(req.reusedSocket)));
    req.end(payloadBuffer);
  });
}

/**
 * Creates a JSON POST client backed by resettable HTTP/HTTPS agents so VPN or
 * interface changes cannot wedge future requests on stale keep-alive sockets.
 */
export function createJsonPoster({ timeoutMs: defaultTimeoutMs = 70000, keepAlive = true } = {}) {
  let httpAgent = null;
  let httpsAgent = null;
  let epoch = 0;

  function agentFor(protocol) {
    if (protocol === 'http:') {
      if (!httpAgent) httpAgent = new http.Agent({ keepAlive, keepAliveMsecs: 15000, maxSockets: 8 });
      return httpAgent;
    }
    if (!httpsAgent) {
      // Disable TLS session caching so VPN endpoint shifts do not hit stale session tickets.
      httpsAgent = new https.Agent({ keepAlive, keepAliveMsecs: 15000, maxSockets: 8, maxCachedSessions: 0 });
    }
    return httpsAgent;
  }

  function reset() {
    epoch++;
    if (httpAgent) {
      httpAgent.destroy();
      httpAgent = null;
    }
    if (httpsAgent) {
      httpsAgent.destroy();
      httpsAgent = null;
    }
  }

  async function post(url, body = {}, { headers = {}, timeoutMs = defaultTimeoutMs, idempotent = false } = {}) {
    const parsed = new URL(url);
    const payloadBuffer = Buffer.from(JSON.stringify(body), 'utf8');

    for (let attempt = 0; attempt < 2; attempt++) {
      const agent = agentFor(parsed.protocol);
      try {
        return await sendJsonOnce(parsed, payloadBuffer, { agent, headers, timeoutMs });
      } catch (failure) {
        const rawErr = failure?.err ?? failure;
        const formatted = formatNetworkError(rawErr, timeoutMs);
        reset();

        const canRetryReused = Boolean(failure?.reusedSocket)
          && !failure?.responseStarted
          && REUSABLE_RESET_CODES.has(formatted.code);
        const canRetryIdempotent = idempotent
          && !formatted.isTimeout
          && (!formatted.code || IDEMPOTENT_RETRY_CODES.has(formatted.code));

        if (attempt === 0 && (canRetryReused || canRetryIdempotent)) continue;
        throw formatted;
      }
    }
  }

  return {
    post,
    reset,
    stats: () => ({ epoch, hasHttpAgent: Boolean(httpAgent), hasHttpsAgent: Boolean(httpsAgent) })
  };
}
