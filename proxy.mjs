import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { once } from 'node:events';

export function currentRoute(agent, providers = ['magpie', 'magpie-anthropic']) {
  const route = agent.model?.current();
  if (!route?.model || !route?.provider) throw new Error('请先在 DSH 会话中选择模型。');
  if (!providers.includes(route.provider)) throw new Error(`当前提供方 ${route.provider} 未配置为 Magpie 路由，请选择 Magpie 模型。`);
  return { provider: route.provider, model: route.model, ...(route.reasoningEffort ? { reasoningEffort: route.reasoningEffort } : {}) };
}

function equalSecret(a, b) {
  const left = Buffer.from(typeof a === 'string' ? a : '');
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function errorResponse(res, status, message) {
  if (res.destroyed) return;
  if (res.headersSent) { res.destroy(); return; }
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message } }));
}

export async function openBridge({ agent, gateway = 'http://127.0.0.1:3425', providers, resolveKey, signal, requestTimeoutMs = 180000, onRequest = () => {}, onError = () => {}, headers: attributionHeaders = {}, fetchImpl = fetch }) {
  const target = new URL(gateway);
  if (target.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname)) {
    throw new Error('Magpie gateway 必须是本机 HTTP 地址。');
  }
  if (target.href.includes('@') || target.search || target.hash) throw new Error('Magpie 地址不能包含凭据、查询或片段。');
  target.pathname = target.pathname.replace(/\/(?:v1\/?)?$/, '') + '/v1/';
  const token = randomBytes(32).toString('hex');
  const lifetime = new AbortController();
  const sockets = new Set();
  const pending = new Set();
  let closed;
  const server = http.createServer((req, res) => {
    const task = serve(req, res).catch(error => {
      const message = error?.message || String(error);
      onError(message);
      errorResponse(res, error.status || 502, message);
    });
    pending.add(task);
    void task.finally(() => pending.delete(task));
  });
  server.requestTimeout = requestTimeoutMs;
  server.headersTimeout = Math.min(30000, requestTimeoutMs);
  server.on('connection', socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  async function serve(req, res) {
    const auth = req.headers['x-api-key'] || req.headers.authorization?.replace(/^Bearer /i, '');
    if (!equalSecret(auth, token)) { errorResponse(res, 401, 'Invalid local bridge credential'); req.resume(); return; }
    const url = new URL(req.url, 'http://127.0.0.1');
    const allowed = ['/v1/messages', '/v1/messages/count_tokens'];
    if (req.method !== 'POST' || !allowed.includes(url.pathname)) { errorResponse(res, 404, 'Unsupported Claude bridge endpoint'); req.resume(); return; }
    if (signal?.aborted || lifetime.signal.aborted) { errorResponse(res, 503, 'Claude task stopped'); return; }
    const parts = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 32 * 1024 * 1024) { errorResponse(res, 413, 'Claude request exceeds 32 MiB'); return; }
      parts.push(chunk);
    }
    let payload;
    try { payload = JSON.parse(Buffer.concat(parts).toString('utf8')); }
    catch { errorResponse(res, 400, 'Invalid JSON request'); return; }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) { errorResponse(res, 400, 'Invalid request object'); return; }
    // Read the live pending selection, not the process-start model or a global default.
    const route = currentRoute(agent, providers);
    payload.model = route.model;
    // Claude-only adaptive thinking/effort flags are not portable between model families.
    // Magpie's route effort is carried separately, when present.
    delete payload.thinking;
    if (payload.output_config) {
      delete payload.output_config.effort;
      if (!Object.keys(payload.output_config).length) delete payload.output_config;
    }
    const key = await resolveKey();
    if (!key) throw new Error('MAGPIE_GATEWAY_KEY 未配置；无法访问本机 Magpie。');
    const disconnected = new AbortController();
    const disconnect = () => { if (!res.writableFinished) disconnected.abort(new Error('Claude client disconnected')); };
    res.once('close', disconnect);
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(new Error('Magpie request timed out')), requestTimeoutMs);
    timer.unref?.();
    const signals = [lifetime.signal, disconnected.signal, deadline.signal, ...(signal ? [signal] : [])];
    const requestSignal = AbortSignal.any(signals);
    const startedAt = new Date().toISOString();
    onRequest({ ...route, startedAt, endpoint: url.pathname });
    try {
      const headers = {
        ...attributionHeaders,
        'content-type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'x-magpie-session': `${agent.id}:claude-code`,
      };
      if (route.reasoningEffort) headers['x-magpie-effort'] = route.reasoningEffort;
      const upstream = await fetchImpl(new URL(url.pathname.replace('/v1/', ''), target), {
        method: 'POST', headers, body: JSON.stringify(payload), signal: requestSignal, redirect: 'error',
      });
      if (!upstream.ok) {
        const text = (await upstream.text()).slice(0, 4000);
        let detail = text;
        try { detail = JSON.parse(text).error?.message || text; } catch {}
        const message = `Magpie HTTP ${upstream.status}: ${detail.split(key).join('[redacted]')}`;
        onError(message);
        errorResponse(res, upstream.status, message);
        return;
      }
      res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') || 'application/json', 'cache-control': 'no-store' });
      if (upstream.body) {
        for await (const chunk of upstream.body) {
          if (res.destroyed) break;
          if (!res.write(chunk)) await once(res, 'drain', { signal: requestSignal });
        }
      }
      if (!res.destroyed) res.end();
    } finally {
      clearTimeout(timer);
      res.off('close', disconnect);
    }
  }
  const close = () => closed ??= (async () => {
    lifetime.abort(new Error('Claude bridge closed'));
    for (const socket of sockets) socket.destroy();
    if (server.listening) await new Promise(resolve => server.close(resolve));
    await Promise.allSettled([...pending]);
    signal?.removeEventListener('abort', abort);
  })();
  const abort = () => { void close(); };
  signal?.throwIfAborted();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  const address = server.address();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) { await close(); signal.throwIfAborted(); }
  return { url: `http://127.0.0.1:${address.port}`, token, close };
}
