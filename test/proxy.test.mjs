import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openBridge } from '../proxy.mjs';

function agent(id, model) {
  let route = { provider: 'magpie', model, reasoningEffort: 'high' };
  return { id, model: { current: () => ({ ...route }), select: next => { route = next; } } };
}
async function request(bridge, body = {}) {
  return fetch(`${bridge.url}/v1/messages`, { method: 'POST', headers: { 'x-api-key': bridge.token }, body: JSON.stringify({ model: 'dsh-session-model', ...body }) });
}

test('each request reads pending selection and stays isolated from other sessions', async () => {
  const one = agent('session-one', 'route/a'); const two = agent('session-two', 'route/b');
  const seen = []; let key = 'key-one';
  const fetchImpl = async (url, init) => {
    seen.push({ url: String(url), body: JSON.parse(init.body), headers: init.headers });
    return new Response('data: intact\n\n', { headers: { 'content-type': 'text/event-stream' } });
  };
  const bridges = await Promise.all([one, two].map(subject => openBridge({ agent: subject, fetchImpl, resolveKey: async () => key })));
  try {
    assert.equal(await (await request(bridges[0], { thinking: { type: 'adaptive' }, output_config: { effort: 'max' } })).text(), 'data: intact\n\n');
    one.model.select({ provider: 'magpie', model: 'route/c' }); key = 'key-two';
    await (await request(bridges[0])).text(); await (await request(bridges[1])).text();
    assert.deepEqual(seen.map(row => row.body.model), ['route/a', 'route/c', 'route/b']);
    assert.deepEqual(seen.map(row => row.headers['x-magpie-session']), ['session-one:claude-code', 'session-one:claude-code', 'session-two:claude-code']);
    assert.deepEqual(seen.map(row => row.headers['x-api-key']), ['key-one', 'key-two', 'key-two']);
    assert(seen.every(row => row.url === 'http://127.0.0.1:3425/v1/messages'));
    assert.equal(seen[0].body.thinking, undefined); assert.equal(seen[0].body.output_config, undefined);
  } finally { await Promise.all(bridges.map(bridge => bridge.close())); }
});

test('rejects unrelated credentials, endpoints, invalid JSON and non-Magpie selections', async () => {
  let forwarded = 0;
  const subject = agent('guard-test', 'route/a');
  const bridge = await openBridge({ agent: subject, resolveKey: async () => 'key', fetchImpl: async () => { forwarded++; return new Response('{}'); } });
  try {
    const invalid = await fetch(`${bridge.url}/v1/messages`, { method: 'POST', headers: { 'x-api-key': 'bad' }, body: '{}' });
    assert.equal(invalid.status, 401); await invalid.text();
    const endpoint = await fetch(`${bridge.url}/other`, { method: 'POST', headers: { 'x-api-key': bridge.token }, body: '{}' });
    assert.equal(endpoint.status, 404); await endpoint.text();
    const json = await fetch(`${bridge.url}/v1/messages`, { method: 'POST', headers: { 'x-api-key': bridge.token }, body: '{' });
    assert.equal(json.status, 400); await json.text();
    subject.model.select({ provider: 'unrelated', model: 'route/b' });
    const denied = await request(bridge); assert.equal(denied.status, 502); assert.match(await denied.text(), /Magpie/);
    assert.equal(forwarded, 0);
  } finally { await bridge.close(); }
});

test('upstream errors are surfaced without exposing credentials', async () => {
  const bridge = await openBridge({ agent: agent('error-test', 'route/a'), resolveKey: async () => 'sensitive-test-key', fetchImpl: async () => new Response(JSON.stringify({ error: { message: 'quota exhausted sensitive-test-key' } }), { status: 429 }) });
  try {
    const response = await request(bridge); const body = await response.text();
    assert.equal(response.status, 429); assert.match(body, /quota exhausted/); assert(!body.includes('sensitive-test-key'));
  } finally { await bridge.close(); }
});

test('closing aborts outstanding upstream work and closes the listening port', async () => {
  let seenSignal; let started;
  const ready = new Promise(resolve => { started = resolve; });
  const bridge = await openBridge({ agent: agent('abort-test', 'route/a'), resolveKey: async () => 'key', fetchImpl: async (_url, { signal }) => {
    seenSignal = signal; started();
    await new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  } });
  const response = request(bridge).catch(() => undefined);
  await ready; await bridge.close(); await response;
  assert.equal(seenSignal.aborted, true);
  await assert.rejects(() => request(bridge));
});

test('request deadline fails boundedly and rejects remote gateways', async () => {
  await assert.rejects(() => openBridge({ agent: agent('a', 'b'), gateway: 'https://example.com' }), /本机/);
  const bridge = await openBridge({ agent: agent('deadline', 'route/a'), resolveKey: async () => 'key', requestTimeoutMs: 30, fetchImpl: async (_url, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })) });
  try { const response = await request(bridge); assert.equal(response.status, 502); assert.match(await response.text(), /timed out/); }
  finally { await bridge.close(); }
});
