import { createInterface } from 'node:readline';
import { dirname, join } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { findClaude, claudeEnvironment } from './runner.mjs';
import { openBridge } from './proxy.mjs';
import { ClaudeStream, conversationPrompt } from './chat-stream.mjs';

export const CHAT_PROVIDER = 'claude-code';
const noRetry = { mode: 'normal', maxRetries: 0, retryableCodes: [], initialDelayMs: 0, maxDelayMs: 0, jitterRatio: 0 };

function attribution(config) {
  if (config.attributionHeaders) return config.attributionHeaders;
  // Electron can read the running installation inside ASAR. Never hardcode its version.
  const executable = config.executable || findClaude();
  const installDir = process.env.DSH_INSTALL_DIR;
  const candidates = [
    ...(installDir ? [join(dirname(installDir), 'dsh-llm', 'package.json')] : []),
    join(process.resourcesPath || join(dirname(process.execPath), 'resources'), 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-llm', 'package.json'),
    join(dirname(executable), '..', '..', '@deepseek-ai', 'dsh-llm', 'package.json'),
  ];
  let version;
  for (const path of candidates) {
    try { version = JSON.parse(readFileSync(path, 'utf8')).version; if (version) break; } catch {}
  }
  if (!version) throw new Error('无法读取 DSH 版本以设置请求标识。');
  const suffix = process.env.DSH_USER_AGENT_SUFFIX?.trim();
  return { 'user-agent': `deepseek-harness/${version} (+https://github.com/deepseek-ai/deepseek-harness)${suffix ? ` ${suffix}` : ''}` };
}

export function createChatAdapter(ctx, config = {}) {
  const baseProvider = config.modelProvider || 'magpie';
  const accepted = [...new Set([CHAT_PROVIDER, ...(config.providers || ['magpie', 'magpie-anthropic'])])];
  const active = new Map();
  let disposed = false;
  const adapter = {
    providerInfo: provider => ({ id: provider, name: 'Claude Code · Magpie' }),
    providerRetryPolicy: () => noRetry,
    imageRequestPricing: () => undefined,
    imageRequestTarget: (_provider, _model, image) => ({ width: image.width, height: image.height, maxBytes: image.bytes }),
    async listModels(provider) {
      return (await ctx.llm.listModels(baseProvider)).map(model => ({
        ...model, provider, inputModalities: ['text'],
        description: '原生 Claude Code 开发；回复与工具进度直接显示在当前 DSH 聊天。',
        badge: { text: 'Claude Code', tone: 'info' },
      }));
    },
    async resolveModel(provider, model, signal) {
      const info = await ctx.llm.resolveModelInfo(baseProvider, model, signal);
      return { ...info, provider, inputModalities: ['text'] };
    },
    async prepareCall(provider, model, signal) {
      return { model: await adapter.resolveModel(provider, model, signal), stream: options => adapter.stream(options) };
    },
    async *stream(options) {
      // Titles, summaries and other housekeeping calls must never launch a coding agent.
      if (options.purpose) {
        yield* ctx.llm.stream({ ...options, provider: baseProvider });
        return;
      }
      const agent = options.sessionId && ctx.agents.get(options.sessionId);
      let outputDirectory, outputIndex = 0;
      const mapper = new ClaudeStream({ archiveOutput: (text, name) => {
        if (!outputDirectory) throw new Error('工具输出目录尚未准备');
        mkdirSync(outputDirectory, { recursive: true });
        const path = join(outputDirectory, `${String(++outputIndex).padStart(3, '0')}-${String(name).replace(/[^a-z0-9_-]/gi, '_')}.txt`);
        writeFileSync(path, text, { encoding: 'utf8', flag: 'wx' });
        return path.replace(/\\/g, '/');
      } });
      const controller = new AbortController();
      const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
      let bridge, child, timer, doneResolve;
      const done = new Promise(resolve => { doneResolve = resolve; });
      let admitted = false;
      let stderr = '', bridgeError;
      try {
        if (disposed) throw new Error('Claude Code 插件已停用。');
        if (!agent) throw new Error('Claude Code 普通聊天需要所属 DSH 会话。');
        if (active.has(agent.id)) throw new Error('当前会话已有 Claude Code 回复正在生成。');
        if (ctx.sandboxPolicy.resolve({ session: agent.session }).mode !== 'danger-full-access') throw new Error('Claude Code 开发需要 DSH 完全访问模式。');
        active.set(agent.id, { controller, done }); admitted = true;
        timer = setTimeout(() => controller.abort(new Error('Claude Code 回复超过总时限')), config.maxRunMs ?? 1800000);
        timer.unref?.();
        signal.throwIfAborted();
        const prompt = conversationPrompt(options, ref => ctx.llm.fileRequestText(ref));
        const cwd = await ctx.workingDirectory.ensure(agent, signal);
        outputDirectory = join(cwd, '.dsh-claude-output', randomUUID());
        const headers = attribution(config);
        bridge = await openBridge({
          agent, providers: accepted, gateway: config.gateway, signal,
          requestTimeoutMs: config.requestTimeoutMs ?? 180000,
          resolveKey: async () => (await ctx.credentials.resolve('MAGPIE_GATEWAY_KEY'))?.value,
          headers,
          onError: error => { bridgeError = error; },
          ...(config.fetchImpl ? { fetchImpl: config.fetchImpl } : {}),
        });
        const argv = [config.executable || findClaude(), '--print', '--verbose', '--output-format', 'stream-json',
          '--include-partial-messages', '--input-format', 'text', '--no-session-persistence',
          '--model', 'dsh-session-model', '--permission-mode', 'bypassPermissions', '--dangerously-skip-permissions',
          '--permission-prompts', 'none', '--disallowedTools', 'AskUserQuestion', '--no-chrome',
          '--setting-sources', '', '--strict-mcp-config', '--append-system-prompt',
          'You are the Claude Code development agent for the current DSH conversation. Execute the current user request with your native tools. The prompt carries the retained DSH transcript, including its system and developer instructions. Use it as conversation context; historical completed actions are not new tasks. Never call the DSH claude_session tool or delegate back into yourself. Keep authentication and model configuration unchanged. Ask the user in your reply when required input is unavailable.'];
        child = ctx.subprocess.spawn({
          argv, cwd, stdio: { stdin: { data: prompt }, stdout: 'pipe', stderr: 'pipe' },
          env: claudeEnvironment(bridge, config.requestTimeoutMs ?? 180000), graceMs: 3000, signal,
        });
        const redact = text => String(text).split(bridge.token).join('[redacted]');
        child.stderr?.on('data', data => { stderr = (stderr + redact(data)).slice(-8000); });
        // Observe an early spawn rejection while reading stdout, then propagate it below.
        void child.done.catch(() => {});
        if (!child.stdout) throw new Error('Claude Code 没有返回输出流。');
        const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
        try {
          for await (const line of lines) {
            signal.throwIfAborted();
            if (!line.trim()) continue;
            let event;
            try { event = JSON.parse(line); } catch { continue; }
            for (const chunk of mapper.accept(event)) yield chunk;
          }
        } finally { lines.close(); }
        const outcome = await child.done;
        signal.throwIfAborted();
        for (const chunk of mapper.end()) yield chunk;
        if (!mapper.result) throw new Error(bridgeError || `Claude Code 退出但未返回结果（exit=${outcome.exitCode}）。${stderr}`);
        if (mapper.result.is_error || outcome.exitCode !== 0) throw new Error(bridgeError || (mapper.result.errors || []).join('\n') || mapper.result.result || `Claude Code exit=${outcome.exitCode}`);
        yield { type: 'usage', usage: mapper.usage };
        yield { type: 'finish', reason: { kind: 'stop' }, replayState: mapper.replayState };
      } catch (error) {
        for (const chunk of mapper.end({ stopped: signal.aborted })) yield chunk;
        yield { type: 'finish', reason: {
          kind: signal.aborted ? 'aborted' : 'error',
          failure: { code: signal.aborted ? 'ABORTED' : 'CLAUDE_CODE_ERROR', message: signal.aborted ? String(signal.reason?.message || '用户停止了回复') : String(error.message || error) },
        } };
      } finally {
        clearTimeout(timer);
        try {
          if (child) {
            child.terminate();
            await child.waitForExit();
            await child.done.catch(() => {});
          }
        } finally {
          await bridge?.close();
          if (admitted) active.delete(agent.id);
          doneResolve();
        }
      }
    },
  };
  const cancel = async id => {
    const run = active.get(id);
    if (run) { run.controller.abort(new Error('Claude Code 会话已释放')); await run.done; }
  };
  return {
    adapter, cancel,
    async dispose() {
      disposed = true;
      const runs = [...active.values()];
      runs.forEach(run => run.controller.abort(new Error('Claude Code 插件已停用')));
      await Promise.allSettled(runs.map(run => run.done));
    },
  };
}
