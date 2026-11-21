import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { ClaudeStream, conversationPrompt, imageHandleText } from '../chat-stream.mjs';
import { CHAT_PROVIDER, createChatAdapter } from '../chat-adapter.mjs';

const event = value => ({ type: 'stream_event', event: value });
const textOf = chunks => chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text).join('');
const reasoningOf = chunks => chunks.filter(chunk => chunk.type === 'reasoning-delta').map(chunk => chunk.text).join('');
const user = text => ({ role: 'user', content: [{ type: 'text', text }] });

test('native partial events stream once; native tools and results never become executable DSH calls', () => {
  const stream = new ClaudeStream();
  const chunks = [
    event({ type: 'message_start', message: { id: 'a' } }),
    event({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }),
    event({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Plan' } }),
    event({ type: 'content_block_stop', index: 0 }),
    event({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }),
    event({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Hello' } }),
    event({ type: 'content_block_stop', index: 1 }),
    event({ type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'read-1', name: 'Read', input: {} } }),
    event({ type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"file_path":"input.txt"}' } }),
    event({ type: 'content_block_stop', index: 2 }),
    { type: 'assistant', message: { id: 'a', content: [{ type: 'thinking', thinking: 'Plan' }, { type: 'text', text: 'Hello' }, { type: 'tool_use', id: 'read-1', name: 'Read', input: { file_path: 'input.txt' } }] } },
    event({ type: 'message_stop' }),
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'read-1', content: 'nonce ``` important' }] } },
    { type: 'result', result: 'Hello', usage: { input_tokens: 10, output_tokens: 7, cache_read_input_tokens: 20, cache_creation_input_tokens: 4 } },
  ].flatMap(message => stream.accept(message));
  assert.equal(textOf(chunks).split('Hello').length - 1, 1);
  assert.equal(reasoningOf(chunks).split('▶ Read · 执行中').length - 1, 1);
  assert.match(reasoningOf(chunks), /✓ Read · 完成/);
  assert.match(reasoningOf(chunks), /````text\nnonce ``` important/);
  assert.equal(chunks.some(chunk => chunk.blockType === 'tool-call' || chunk.type === 'tool-call-delta'), false);
  assert.match(reasoningOf(chunks), /Plan/);
  const toolBlocks = chunks.filter(chunk => chunk.type === 'block-end' && /Read ·/.test(chunk.block.text));
  assert(toolBlocks.length >= 2);
  for (const block of toolBlocks) assert.equal(block.block.type, 'reasoning');
  assert(!textOf(chunks).includes('Read ·'));
  assert.deepEqual(stream.usage, { inputTokens: 10, outputTokens: 7, cacheReadTokens: 20, cacheWriteTokens: 4 });
  const starts = chunks.filter(chunk => chunk.type === 'block-start');
  assert.equal(new Set(starts.map(chunk => chunk.index)).size, starts.length);
  assert.equal(chunks.filter(chunk => chunk.type === 'block-end').length, starts.length);
});

test('folded native tool records replay through aligned hidden metadata, not visible reasoning', () => {
  const stream = new ClaudeStream();
  const chunks = [
    ...stream.text('Private plan', 'reasoning'),
    ...[
      { type: 'assistant', message: { id: 'replay-message', content: [{ type: 'text', text: 'Visible reply' }, { type: 'tool_use', id: 'r1', name: 'Read', input: { file_path: 'input.txt' } }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'r1', content: 'full result nonce ``` kept' }] } },
    ].flatMap(message => stream.accept(message)),
  ];
  const replay = stream.replayState;
  const content = chunks.filter(chunk => chunk.type === 'block-end').map(chunk => chunk.block);
  assert.equal(replay.blocks.length, content.length);
  assert.deepEqual(replay.blocks.filter(Boolean).map(record => record.kind), ['native-tool-call', 'native-tool-result']);
  assert.equal(replay.blocks.find(record => record?.kind === 'native-tool-result').output, 'full result nonce ``` kept');
  const message = { role: 'assistant', source: { kind: 'model', provider: CHAT_PROVIDER, model: 'test/model', replayState: replay }, content };
  const prompt = conversationPrompt({ messages: [message] });
  assert.match(prompt, /Native Claude Code tool record \(already executed/);
  assert(prompt.includes('full result nonce ``` kept'));
  assert.deepEqual(replay.blocks.find(record => record?.kind === 'native-tool-call').input, { file_path: 'input.txt' });
  assert.match(prompt, /file_path/);
  assert.match(prompt, /input\.txt/);
  assert(prompt.includes('Visible reply'));
  assert(!prompt.includes('Private plan'));
  assert(!prompt.includes('▶ Read'));
  const withoutReplay = conversationPrompt({ messages: [{ ...message, source: { kind: 'model', provider: CHAT_PROVIDER, model: 'test/model' } }] });
  assert(!withoutReplay.includes('full result nonce'));
});

test('tool logs do not hide result-only answers and long output is archived with a bounded preview', () => {
  let archived;
  const stream = new ClaudeStream({ maxToolOutput: 40, archiveOutput: (text, name) => { archived = { text, name }; return 'D:/owned/full output.txt'; } });
  const output = 'large output '.repeat(100);
  const chunks = [
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't', name: 'Read', input: {} }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't', content: output }] } },
    { type: 'result', result: 'Final user answer' },
  ].flatMap(message => stream.accept(message));
  assert.match(textOf(chunks), /Final user answer/);
  assert.match(reasoningOf(chunks), /\[Read 输出\]\(<D:\/owned\/full output.txt>\)/);
  assert(reasoningOf(chunks).length < output.length);
  assert(!textOf(chunks).includes('Read ·'));
  assert.deepEqual(archived, { text: output, name: 'Read' });
});

test('interruption distinguishes executing tools from incomplete parameters', () => {
  const stream = new ClaudeStream();
  stream.accept({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'running', name: 'Bash', input: { command: 'long work' } }] } });
  stream.accept(event({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'partial', name: 'Write', input: {} } }));
  stream.accept(event({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"file_path":' } }));
  const chunks = stream.end({ stopped: true });
  assert.match(reasoningOf(chunks), /Bash · 已停止.*执行结果未知/);
  assert.match(reasoningOf(chunks), /Write · 参数接收中断/);
  assert(!reasoningOf(chunks).includes('Write · 执行中'));
  assert.equal(textOf(chunks), '');
  assert.equal(reasoningOf(stream.end({ stopped: true })), '');
});

test('full retained history carries prior instructions, tool output and latest request across fresh processes', () => {
  const history = [
    { role: 'system', content: [{ type: 'text', text: 'Keep original requirement' }] },
    user('Remember nonce-123'),
    { role: 'assistant', content: [{ type: 'text', text: 'Completed earlier' }, { type: 'reasoning', text: 'private scratch' }] },
    { role: 'tool', toolCallId: 't1', content: [{ type: 'text', text: 'read result 456' }] },
    user('Continue using that nonce'),
  ];
  const prompt = conversationPrompt({ messages: history });
  for (const expected of ['Keep original requirement', 'nonce-123', 'Completed earlier', 'read result 456', 'Continue using that nonce']) assert(prompt.includes(expected));
  assert(!prompt.includes('private scratch'));
  assert.match(prompt, /Earlier completed actions are history/);
  const files = conversationPrompt({ messages: [{ role: 'user', content: [{ type: 'file', attachment: { name: 'spec.md' } }] }] }, ref => `Read ${ref.name} at owned-path`);
  assert.match(files, /Read spec.md at owned-path/);
});

function harness({ automatic = true, services = {} } = {}) {
  let launchCount = 0, terminationCount = 0, lastSpec, released = false;
  const agents = new Map(['one', 'two'].map(id => [id, { id, session: {}, model: { current: () => ({ provider: CHAT_PROVIDER, model: 'test/model' }) } }]));
  const children = [];
  const auxiliary = [];
  const ctx = {
    get: key => services[key],
    agents: { get: id => agents.get(id) },
    sandboxPolicy: { resolve: () => ({ mode: 'danger-full-access' }) },
    workingDirectory: { ensure: async (_agent, signal) => { signal.throwIfAborted(); return process.cwd(); } },
    credentials: { resolve: async () => ({ value: 'test-key' }) },
    llm: {
      listModels: async () => [{ provider: 'magpie', id: 'test/model', name: 'Test' }],
      resolveModelInfo: async () => ({ provider: 'magpie', id: 'test/model', name: 'Test', context: { contextWindow: 200000 } }),
      async *stream(options) { auxiliary.push(options); yield { type: 'finish', reason: { kind: 'stop' } }; },
    },
    subprocess: { spawn(spec) {
      launchCount++; lastSpec = spec;
      const stdout = new PassThrough(); const stderr = new PassThrough();
      let finish;
      const done = new Promise(resolve => { finish = resolve; });
      let ended = false;
      const end = code => { if (ended) return; ended = true; stdout.end(); stderr.end(); finish({ exitCode: code }); spec.signal.removeEventListener('abort', abort); };
      const terminate = () => { terminationCount++; released = true; end(1); };
      const abort = () => terminate();
      spec.signal.addEventListener('abort', abort, { once: true });
      const send = value => stdout.write(`${JSON.stringify(value)}\n`);
      const child = { stdout, stderr, done, terminate, waitForExit: async () => { await done; return true; }, send, end };
      children.push(child);
      if (automatic) queueMicrotask(() => {
        send({ type: 'assistant', message: { id: `m${launchCount}`, content: [{ type: 'text', text: 'Native reply' }] } });
        send({ type: 'result', result: 'Native reply', usage: { input_tokens: 3, output_tokens: 2 } });
        end(0);
      });
      return child;
    } },
  };
  const chat = createChatAdapter(ctx, { executable: 'unused-test-cli', attributionHeaders: { 'user-agent': 'deepseek-harness/test' }, maxRunMs: 5000 });
  return { chat, ctx, agents, children, auxiliary,
    get launches() { return launchCount; }, get terminations() { return terminationCount; }, get spec() { return lastSpec; }, get released() { return released; },
    options: id => ({ provider: CHAT_PROVIDER, model: 'test/model', sessionId: id, messages: [user(`Task for ${id}`)] }),
  };
}
const collect = async iterable => { const result = []; for await (const chunk of iterable) result.push(chunk); return result; };

test('image blocks project to a readable path handle and degrade when no path resolves', () => {
  const image = { type: 'image', attachment: { attachmentId: 'sha256:abcdef0123456789', mediaType: 'image/jpeg', bytes: 99, width: 30, height: 40, name: 'photo.jpg' } };
  const withPath = conversationPrompt({ messages: [{ role: 'user', content: [image] }] }, undefined, ref => imageHandleText(ref, 'D:/x/photo.jpg'));
  assert(withPath.includes('photo.jpg'));
  assert(withPath.includes('30x40, 99 bytes, image/jpeg, sha256:abcdef01'));
  assert(withPath.includes('D:/x/photo.jpg'));
  assert(withPath.includes('Read tool'));
  const noPath = conversationPrompt({ messages: [{ role: 'user', content: [image] }] });
  assert(noPath.includes('cannot access a readable path'));
  assert(noPath.includes('do not claim'));
  assert(!noPath.includes('D:/x/photo.jpg'));
});

test('adapter resolves image attachments to a process path the Claude subprocess can open', async () => {
  const app = harness({ services: {
    attachments: { imageHostPath: ref => `C:/store/${String(ref.attachmentId).replace(/^sha256:/, '')}.png` },
    fs: { processPathFromHostPath: hostPath => hostPath.replace('C:/store/', 'D:/world/') },
  } });
  const image = { role: 'user', content: [{ type: 'image', attachment: { attachmentId: 'sha256:abcdef0123456789', mediaType: 'image/png', bytes: 1234, width: 10, height: 20, name: 'shot.png' } }] };
  try {
    const chunks = await collect(app.chat.adapter.stream({ ...app.options('one'), messages: [image] }));
    assert.equal(textOf(chunks), 'Native reply');
    const data = app.spec.stdio.stdin.data;
    assert(data.includes('Image'));
    assert(data.includes('shot.png'));
    assert(data.includes('read-only copy saved at'));
    assert(data.includes('D:/world/abcdef0123456789.png'));
    assert(!data.includes('cannot access a readable path'));
    assert(!data.includes('图片尚未投影'));
    assert.deepEqual((await app.chat.adapter.resolveModel(CHAT_PROVIDER, 'test/model')).inputModalities, ['text', 'image']);
    assert.deepEqual((await app.chat.adapter.listModels(CHAT_PROVIDER))[0].inputModalities, ['text', 'image']);
  } finally { await app.chat.dispose(); }
});

test('normal chat sends complete history and streams final reply, with stateless persistence and cleanup', async () => {
  const app = harness();
  try {
    const chunks = await collect(app.chat.adapter.stream(app.options('one')));
    assert.equal(textOf(chunks), 'Native reply');
    assert.equal(chunks.at(-1).reason.kind, 'stop');
    assert.equal(chunks.at(-1).replayState.response.format, 'dsh-claude-session-follow/native-tools-v1');
    assert.equal(chunks.at(-1).replayState.blocks.length, chunks.filter(chunk => chunk.type === 'block-end').length);
    assert.equal(app.launches, 1); assert.equal(app.released, true);
    assert(app.spec.argv.includes('--include-partial-messages'));
    assert(app.spec.argv.includes('--no-session-persistence'));
    assert(!app.spec.argv.includes('--resume'));
    assert.match(app.spec.stdio.stdin.data, /Task for one/);
    const models = await app.chat.adapter.listModels(CHAT_PROVIDER);
    assert.equal(models[0].provider, CHAT_PROVIDER);
    assert.equal(app.chat.adapter.providerRetryPolicy().maxRetries, 0);
  } finally { await app.chat.dispose(); }
});

test('housekeeping purposes delegate to Magpie without starting Claude Code', async () => {
  const app = harness();
  const input = { ...app.options('one'), purpose: 'session-title' };
  try {
    await collect(app.chat.adapter.stream(input));
    assert.equal(app.launches, 0);
    assert.equal(app.auxiliary[0].provider, 'magpie');
    assert.equal(input.provider, CHAT_PROVIDER);
  } finally { await app.chat.dispose(); }
});

test('stop aborts native process and port; other sessions remain independent', async () => {
  const app = harness({ automatic: false });
  const one = new AbortController(), two = new AbortController();
  const a = collect(app.chat.adapter.stream({ ...app.options('one'), signal: one.signal }));
  const b = collect(app.chat.adapter.stream({ ...app.options('two'), signal: two.signal }));
  while (app.children.length < 2) await new Promise(resolve => setImmediate(resolve));
  const duplicate = await collect(app.chat.adapter.stream(app.options('one')));
  assert.equal(duplicate.at(-1).reason.kind, 'error');
  const url = app.spec.env.ANTHROPIC_BASE_URL;
  one.abort(new Error('Stop button'));
  assert.equal((await a).at(-1).reason.kind, 'aborted');
  assert.equal(app.spec.signal.aborted, false);
  two.abort();
  assert.equal((await b).at(-1).reason.kind, 'aborted');
  assert.equal(app.launches, 2);
  await assert.rejects(() => fetch(url));
  await app.chat.dispose();
});

test('consumer early exit terminates process instead of leaving detached work', async () => {
  const app = harness({ automatic: false });
  const stream = app.chat.adapter.stream(app.options('one'));
  const first = stream.next();
  while (!app.children.length) await new Promise(resolve => setImmediate(resolve));
  app.children[0].send({ type: 'assistant', message: { id: 'early', content: [{ type: 'text', text: 'partial' }] } });
  assert.equal((await first).value.type, 'block-start');
  await stream.return();
  assert(app.terminations > 0);
  await app.chat.dispose();
});
