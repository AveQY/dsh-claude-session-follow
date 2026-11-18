import { createRequire } from 'node:module';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { currentRoute, openBridge } from './proxy.mjs';

export function findClaude(profileDirectory = process.env.DSH_PROFILE_DIR) {
  if (!profileDirectory) throw new Error('DSH_PROFILE_DIR 未设置，无法定位已安装的 Claude Code。');
  const require = createRequire(join(profileDirectory, 'package.json'));
  const plugin = require.resolve('@deepseek-ai/dsh-subagent-claude-code/package.json');
  const sdk = createRequire(plugin).resolve('@anthropic-ai/claude-agent-sdk');
  return createRequire(sdk).resolve(`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/claude.exe`);
}

export function claudeEnvironment(bridge, timeoutMs) {
  return {
    ANTHROPIC_BASE_URL: bridge.url,
    ANTHROPIC_API_KEY: bridge.token,
    ANTHROPIC_AUTH_TOKEN: bridge.token,
    ANTHROPIC_MODEL: 'dsh-session-model',
    ANTHROPIC_DEFAULT_SONNET_MODEL: 'dsh-session-model',
    ANTHROPIC_DEFAULT_OPUS_MODEL: 'dsh-session-model',
    ANTHROPIC_DEFAULT_HAIKU_MODEL: 'dsh-session-model',
    ANTHROPIC_DEFAULT_FABLE_MODEL: 'dsh-session-model',
    CLAUDE_CODE_SUBAGENT_MODEL: 'dsh-session-model',
    ANTHROPIC_SMALL_FAST_MODEL: 'dsh-session-model',
    CLAUDE_CODE_OAUTH_TOKEN: undefined,
    CLAUDE_CODE_USE_BEDROCK: undefined,
    CLAUDE_CODE_USE_VERTEX: undefined,
    CLAUDE_CODE_USE_FOUNDRY: undefined,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
    CLAUDECODE: undefined,
    HTTP_PROXY: undefined, HTTPS_PROXY: undefined, ALL_PROXY: undefined,
    http_proxy: undefined, https_proxy: undefined, all_proxy: undefined,
    NO_PROXY: '127.0.0.1,localhost,::1', no_proxy: '127.0.0.1,localhost,::1',
    API_TIMEOUT_MS: String(timeoutMs),
    CLAUDE_CODE_MAX_RETRIES: '0',
  };
}

export function createRunner(ctx, config = {}) {
  const states = new Map();
  const providers = config.providers || ['magpie', 'magpie-anthropic'];
  const maxRunMs = config.maxRunMs ?? 1800000;
  const requestTimeoutMs = config.requestTimeoutMs ?? 180000;
  let disposed = false;
  function stateOf(agent) {
    let state = states.get(agent.id);
    if (!state) {
      state = { sessionId: agent.id, status: 'idle', nativeSessionId: randomUUID(), initialized: false, requests: [], tools: [], text: '' };
      states.set(agent.id, state);
    }
    return state;
  }
  function snapshot(agent) {
    const state = stateOf(agent);
    let selected;
    try { selected = currentRoute(agent, providers); } catch (error) { selected = { error: error.message }; }
    return {
      status: state.status, selected, lastRequest: state.requests.at(-1), requests: state.requests.slice(-12),
      tools: state.tools.slice(-20), result: state.text, error: state.error,
      startedAt: state.startedAt, finishedAt: state.finishedAt, cwd: state.cwd,
      nativeSessionId: state.nativeSessionId, resumed: state.resumed || false,
    };
  }
  function start(agent, prompt, { signal, fresh = false, cwd } = {}) {
    if (disposed) throw new Error('Claude 插件已停用。');
    if (typeof prompt !== 'string' || !prompt.trim()) throw new Error('请输入开发任务，例如 /claude 检查当前项目并修复测试。');
    currentRoute(agent, providers);
    const state = stateOf(agent);
    if (state.active) throw new Error('这个会话已有 Claude 任务运行中。使用 /claude-status 查看，或 /claude-cancel 取消。');
    const policy = ctx.sandboxPolicy.resolve({ session: agent.session });
    if (policy.mode !== 'danger-full-access') throw new Error('当前版本仅在 DSH 完全访问模式下运行 Claude Code；受限模式不会启动外部进程。');
    if (fresh) { state.nativeSessionId = randomUUID(); state.initialized = false; }
    state.status = 'starting'; state.text = ''; state.error = undefined;
    state.requests = []; state.tools = []; state.startedAt = new Date().toISOString(); state.finishedAt = undefined;
    const controller = new AbortController();
    const active = { controller, done: undefined };
    state.active = active;
    const abort = () => controller.abort(signal.reason || new Error('任务已取消'));
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const timer = setTimeout(() => controller.abort(new Error('Claude 任务超过总时限')), maxRunMs);
    timer.unref?.();
    active.done = execute(agent, state, prompt, controller.signal, cwd).catch(error => {
      state.status = controller.signal.aborted ? 'cancelled' : 'error';
      state.error = controller.signal.aborted ? String(controller.signal.reason?.message || '任务已取消') : error.message;
    }).finally(() => {
      clearTimeout(timer); signal?.removeEventListener('abort', abort);
      state.finishedAt = new Date().toISOString();
      if (state.active === active) state.active = undefined;
    }).then(() => snapshot(agent));
    return { done: active.done, snapshot: () => snapshot(agent), cancel: () => controller.abort(new Error('用户取消了 Claude 任务')) };
  }
  async function execute(agent, state, prompt, signal, requestedCwd) {
    let bridge, child;
    const cwd = requestedCwd || await ctx.workingDirectory.ensure(agent, signal);
    if (state.initialized && state.cwd !== cwd) { state.nativeSessionId = randomUUID(); state.initialized = false; }
    state.cwd = cwd;
    const executable = config.executable || findClaude();
    let result;
    let stderr = '';
    try {
      signal.throwIfAborted();
      bridge = await openBridge({
        agent, gateway: config.gateway, providers, requestTimeoutMs, signal,
        resolveKey: async () => (await ctx.credentials.resolve('MAGPIE_GATEWAY_KEY'))?.value,
        onRequest: route => { state.requests.push(route); if (state.requests.length > 100) state.requests.shift(); state.status = 'running'; },
        onError: message => { state.error = message; },
      });
      const argv = [executable, '--print', '--verbose', '--output-format', 'stream-json', '--input-format', 'text',
        '--model', 'dsh-session-model', '--permission-mode', 'bypassPermissions', '--dangerously-skip-permissions',
        '--permission-prompts', 'none', '--disallowedTools', 'AskUserQuestion', '--no-chrome',
        '--setting-sources', '', '--strict-mcp-config',
        '--append-system-prompt', 'You are running inside a DSH session through its local Magpie gateway. Use the current working directory. Do not change model or authentication configuration. Perform the user task with your native development tools. Ask questions in your final text if information is missing.'];
      state.resumed = state.initialized;
      argv.push(state.initialized ? '--resume' : '--session-id', state.nativeSessionId);
      const env = claudeEnvironment(bridge, requestTimeoutMs);
      child = ctx.subprocess.spawn({ argv, cwd, stdio: { stdin: { data: prompt }, stdout: 'pipe', stderr: 'pipe' }, env, graceMs: 3000, signal });
      const redact = text => String(text).split(bridge.token).join('[redacted]');
      child.stderr?.on('data', data => { stderr = (stderr + redact(data)).slice(-8000); });
      if (!child.stdout) throw new Error('Claude Code 没有返回输出流。');
      const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
      const consume = (async () => {
        for await (const line of lines) {
          if (!line.trim()) continue;
          let message;
          try { message = JSON.parse(line); } catch { continue; }
          if (message.type === 'system' && message.subtype === 'init') { state.status = 'running'; state.initialized = true; }
          if (message.type === 'system' && message.subtype === 'api_retry') {
            state.error = `Claude API 重试：${message.error || message.status || JSON.stringify(message).slice(0, 400)}`;
          }
          if (message.type === 'assistant') {
            for (const block of message.message?.content || []) {
              if (block.type === 'text') state.text = (state.text + block.text + '\n').slice(-64000);
              if (block.type === 'tool_use') { state.tools.push(block.name); if (state.tools.length > 100) state.tools.shift(); }
            }
          }
          if (message.type === 'result') result = message;
        }
      })();
      await Promise.all([consume, child.done]);
      if (signal.aborted) signal.throwIfAborted();
      const outcome = await child.done;
      if (!result) throw new Error(state.error || `Claude Code 退出但未返回结果（exit=${outcome.exitCode}）。${stderr}`);
      if (result.result) state.text = redact(result.result).slice(-64000);
      if (result.is_error || outcome.exitCode !== 0) throw new Error(state.error || (result.errors || []).join('\n') || state.text || `Claude Code exit=${outcome.exitCode}`);
      state.status = 'completed';
      state.error = undefined;
    } finally {
      if (child) {
        child.terminate();
        await child.waitForExit();
        await child.done.catch(() => {});
      }
      await bridge?.close();
    }
  }
  async function cancel(agent) {
    const active = stateOf(agent).active;
    if (!active) return snapshot(agent);
    active.controller.abort(new Error('用户取消了 Claude 任务'));
    return active.done;
  }
  async function wait(agent, signal, waitMs = 55000) {
    const active = stateOf(agent).active;
    if (!active) return snapshot(agent);
    let timer;
    let abort;
    try {
      signal?.throwIfAborted();
      await Promise.race([active.done, new Promise((resolve, reject) => {
        timer = setTimeout(resolve, waitMs);
        abort = () => reject(signal.reason || new Error('等待已取消'));
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort();
      })]);
      return snapshot(agent);
    } finally {
      clearTimeout(timer);
      if (abort) signal?.removeEventListener('abort', abort);
    }
  }
  async function release(agent) {
    const state = states.get(agent.id);
    if (!state) return;
    await cancel(agent);
    states.delete(agent.id);
  }
  async function dispose() {
    disposed = true;
    const all = [...states.values()].filter(state => state.active).map(state => state.active);
    all.forEach(active => active.controller.abort(new Error('Claude 插件已停用')));
    await Promise.allSettled(all.map(active => active.done));
    states.clear();
  }
  return { start, snapshot, cancel, wait, release, dispose };
}

export function statusText(value) {
  const labels = { idle: '尚未启动', starting: '启动中', running: '运行中', completed: '已完成', error: '失败', cancelled: '已取消' };
  const lines = [`Claude Code：${labels[value.status] || value.status}`];
  if (value.selected?.model) lines.push(`当前 DSH 选择：${value.selected.provider} / ${value.selected.model}`);
  if (value.selected?.error) lines.push(value.selected.error);
  if (value.lastRequest) lines.push(`最近转发模型：${value.lastRequest.model}`);
  if (value.cwd) lines.push(`工作目录：${value.cwd}`);
  if (value.tools.length) lines.push(`最近工具：${value.tools.join(' → ')}`);
  if (value.error) lines.push(`原因：${value.error}`);
  if (value.result) lines.push('', value.result);
  if (value.status === 'running' || value.status === 'starting') lines.push('', '任务运行中；/claude-status 查看进展，/claude-cancel 取消。切换模型从下一次请求生效。');
  return lines.join('\n');
}
