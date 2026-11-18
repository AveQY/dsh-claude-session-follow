import { createRunner, statusText } from './runner.mjs';
import { CHAT_PROVIDER, createChatAdapter } from './chat-adapter.mjs';

export const name = 'claude-session-follow';
export const inject = ['commands', 'tools', 'subprocess', 'workingDirectory', 'sandboxPolicy', 'credentials', 'llm', 'agents'];

const help = `直接聊天：在模型选择器打开「Claude Code · Magpie」分组，选择一个模型，然后正常发送开发任务。
流式回复、思考和原生工具记录显示在当前聊天；正常停止按钮会终止本轮。已有 DSH 对话作为上下文，多轮可以直接继续。
在该分组内切换模型，下一次 API 请求随之切换；已发出的请求继续完成。
以下为兼容旧版的独立后台模式：
/claude <任务>：后台开始或继续，用 /claude-status 查看结果。
/claude-new <任务>：重置后台任务上下文。
/claude-status：查看独立后台任务。
/claude-cancel：停止独立后台任务。`;

export function apply(ctx, config = {}) {
  const runner = createRunner(ctx, config);
  const chat = createChatAdapter(ctx, config);
  ctx.llm.registerAdapter([CHAT_PROVIDER], chat.adapter);
  ctx.effect(() => () => Promise.all([runner.dispose(), chat.dispose()]));
  ctx.on('agent/disposed', ({ agent }) => {
    void Promise.all([runner.release(agent), chat.cancel(agent.id)]).catch(() => {});
  });
  const command = (name, description, handler, input) => ctx.commands.register({
    name, description, ...(input ? { input: { hint: input }, recordInput: true } : {}),
    async handler(invocation) {
      try { return await handler(invocation); }
      catch (error) { return { kind: 'error', text: error?.message || String(error) }; }
    },
  });
  const run = fresh => ({ agent, rawInput, signal }) => {
    if (!rawInput.trim()) return { kind: 'success', text: help };
    signal?.throwIfAborted();
    // The command request ends after this receipt; the session owns the task lifetime.
    const task = runner.start(agent, rawInput, { fresh });
    return { kind: 'success', text: statusText(task.snapshot()) };
  };
  command('claude', '让 Claude Code 使用当前会话模型开发；再次调用会继续上下文', run(false), '输入开发任务');
  command('claude-new', '用新的 Claude Code 上下文开始任务', run(true), '输入新任务');
  command('claude-status', '查看 Claude Code 进展和实际使用的模型', ({ agent }) => ({ kind: 'success', text: statusText(runner.snapshot(agent)) }));
  command('claude-cancel', '取消当前 Claude Code 任务并回收进程', async ({ agent }) => ({ kind: 'success', text: statusText(await runner.cancel(agent)) }));

  // This optional model-callable entry uses the same session-owned runner as the commands.
  // Slash commands execute directly; they do not depend on the DSH model delegating.
  ctx.tools.register({
    name: 'claude_session',
    description: 'Run native Claude Code using the CURRENT DSH session model through local Magpie. Model switches apply to each subsequent request. Session-isolated, resumable context. Use only when the user asks to use Claude Code. start returns immediately; wait returns up to 60 seconds of progress; stopping a wait leaves the task running until cancel. This differs from subagent_claude_code, which uses its own static model configuration.',
    parameters: { type: 'object', properties: {
      action: { type: 'string', enum: ['start', 'status', 'wait', 'cancel'] },
      prompt: { type: 'string', description: 'Complete development task; required for start.' },
      fresh: { type: 'boolean', description: 'Start a new Claude context; default false.' },
    }, required: ['action'], additionalProperties: false },
    output: { schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false }, render: (_args, value) => [{ type: 'text', text: value.text }] },
    isConcurrencySafe: args => args.action === 'status' || args.action === 'wait',
    async execute(args, exec) {
      if (!exec.agent) throw new Error('需要所属 DSH 会话。');
      if (args.action === 'start') {
        const task = runner.start(exec.agent, args.prompt, { fresh: args.fresh });
        return { text: statusText(task.snapshot()) };
      }
      if (args.action === 'cancel') return { text: statusText(await runner.cancel(exec.agent)) };
      if (args.action === 'wait') return { text: statusText(await runner.wait(exec.agent, exec.signal)) };
      return { text: statusText(runner.snapshot(exec.agent)) };
    },
  });
}
