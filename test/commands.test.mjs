import { test } from 'node:test';
import assert from 'node:assert/strict';
import { apply } from '../index.js';

function harness() {
  const commands = new Map();
  const tools = new Map();
  const cleanups = [];
  let taskSignal;
  let launches = 0;
  let policy = 'danger-full-access';
  const agent = { id: 'command-test', session: {}, model: { current: () => ({ provider: 'magpie', model: 'test/model' }) } };
  const ctx = {
    llm: { registerAdapter() {} },
    agents: { get: () => agent },
    commands: { register: command => commands.set(command.name, command) },
    tools: { register: tool => tools.set(tool.name, tool) },
    effect: setup => cleanups.push(setup()),
    on() {},
    sandboxPolicy: { resolve: () => ({ mode: policy }) },
    credentials: { resolve: async () => ({ value: 'test-key' }) },
    workingDirectory: { ensure: async (_agent, signal) => {
      launches++;
      taskSignal = signal;
      signal.throwIfAborted();
      await new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    } },
    subprocess: { spawn() { throw new Error('Unreleased working-directory gate must prevent spawning'); } },
  };
  apply(ctx, { executable: 'unused-test-executable', maxRunMs: 5000 });
  return {
    call: (name, rawInput = '', signal) => commands.get(name).handler({ agent, rawInput, signal }),
    tool: (args, signal) => tools.get('claude_session').execute(args, { agent, signal }),
    dispose: () => Promise.all(cleanups.map(cleanup => cleanup())),
    get taskSignal() { return taskSignal; },
    get launches() { return launches; },
    setPolicy: value => { policy = value; },
  };
}

async function promptly(promise) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Command blocked on the background task')), 300);
    })]);
  } finally { clearTimeout(timer); }
}

test('slash launch returns while task is pending; status and explicit cancel stay usable', async () => {
  const app = harness();
  const request = new AbortController();
  try {
    const started = await promptly(app.call('claude', 'Check this project', request.signal));
    assert.equal(started.kind, 'success');
    assert.match(started.text, /启动中/);
    assert.match(started.text, /claude-status/);
    request.abort(new Error('Command receipt request ended'));
    assert.equal(app.taskSignal.aborted, false);
    assert.match((await app.call('claude-status')).text, /启动中/);
    const duplicate = await app.call('claude-new', 'Another task');
    assert.equal(duplicate.kind, 'error');
    assert.match(duplicate.text, /已有 Claude 任务/);
    const cancelled = await promptly(app.call('claude-cancel'));
    assert.equal(cancelled.kind, 'success');
    assert.match(cancelled.text, /已取消/);
    assert.equal(app.taskSignal.aborted, true);
    assert.equal(app.launches, 1);
  } finally { await app.dispose(); }
});

test('help, aborted commands and restricted sessions never launch a task', async () => {
  const app = harness();
  try {
    assert.match((await app.call('claude')).text, /后台/);
    const request = new AbortController(); request.abort(new Error('Already cancelled'));
    assert.equal((await app.call('claude', 'Task', request.signal)).kind, 'error');
    app.setPolicy('workspace-write');
    const denied = await app.call('claude', 'Task');
    assert.equal(denied.kind, 'error');
    assert.match(denied.text, /完全访问/);
    assert.equal(app.launches, 0);
  } finally { await app.dispose(); }
});

test('aborting a progress wait preserves the background task; cancel stops it', async () => {
  const app = harness();
  try {
    await app.tool({ action: 'start', prompt: 'Task' });
    const request = new AbortController();
    const waiting = app.tool({ action: 'wait' }, request.signal);
    request.abort(new Error('Stop waiting'));
    await assert.rejects(waiting, /Stop waiting/);
    assert.equal(app.taskSignal.aborted, false);
    assert.match((await app.tool({ action: 'cancel' })).text, /已取消/);
  } finally { await app.dispose(); }
});
