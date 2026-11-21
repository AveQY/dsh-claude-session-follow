// Translate native Claude Code events into DSH's durable assistant stream.
// Native tools have already run: folded records, never DSH tool-call blocks.
const REPLAY_FORMAT = 'dsh-claude-session-follow/native-tools-v1';
function outputText(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(part => part?.text ?? JSON.stringify(part)).join('\n');
  return value == null ? '' : JSON.stringify(value, null, 2);
}
function fence(text) {
  const runs = String(text).match(/`+/g) || [];
  const marker = '`'.repeat(Math.max(3, ...runs.map(run => run.length + 1)));
  return `${marker}text\n${text}\n${marker}`;
}
// Model-facing handle for one durable image reference. Claude Code's Read tool
// can open image files, so the read-only stored path is enough to let it see
// the picture without re-sending bytes on every turn.
export function imageHandleText(ref, readonlyPath) {
  const digest = String(ref?.attachmentId ?? '').replace(/^sha256:/, '').slice(0, 8);
  const name = ref?.name ? ` "${ref.name}"` : '';
  const size = `${ref?.width}x${ref?.height}, ${ref?.bytes} bytes, ${ref?.mediaType}${digest ? `, sha256:${digest}` : ''}`;
  const identity = `Image${name} (${size})`;
  if (readonlyPath === undefined) {
    return `[${identity} was uploaded, but the current execution environment cannot access a readable path. Report that limitation if the image content is needed; do not claim to have seen it.]`;
  }
  return `[${identity}: read-only copy saved at "${readonlyPath}". Open that path with your Read tool to view the image; do not modify the stored copy.]`;
}

export class ClaudeStream {
  constructor({ maxToolOutput = 6000, archiveOutput } = {}) {
    this.maxToolOutput = maxToolOutput;
    this.archiveOutput = archiveOutput;
    this.assistantText = '';
    this.next = 0;
    this.open = new Map();
    this.tools = new Map();
    this.replay = new Map();
    this.partial = new Map();
    this.completed = new Set();
    this.messageId = undefined;
    this.result = undefined;
    this.usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  }
  text(text, type = 'text', assistant = true, replay) {
    if (!text) return [];
    const index = this.next++;
    if (type === 'text' && assistant) this.assistantText += text;
    if (replay) this.replay.set(index, replay);
    return [
      { type: 'block-start', index, blockType: type },
      { type: type === 'reasoning' ? 'reasoning-delta' : 'text-delta', index, text },
      { type: 'block-end', index, block: { type, text } },
    ];
  }
  get replayState() {
    // Null padding keeps every entry aligned with the durable assistant blocks.
    return { response: { format: REPLAY_FORMAT }, blocks: Array.from({ length: this.next }, (_, index) => this.replay.get(index) ?? null) };
  }
  close(key, complete = false) {
    const state = this.open.get(key);
    if (!state) return [];
    this.open.delete(key);
    if (state.type === 'tool_use') {
      if (!complete) return this.text(`⏹ ${state.name} · 参数接收中断（未确认执行）\n\n${this.detail(state.json || outputText(state.input) || '', state.name)}\n`, 'reasoning', false);
      let input = state.input;
      if (state.json) {
        try { input = JSON.parse(state.json); }
        catch { return this.text(`⚠ ${state.name} · 参数不完整（未确认执行）\n\n${this.detail(state.json, state.name)}\n`, 'reasoning', false); }
      }
      return this.tool(state.id, state.name, input);
    }
    return [{ type: 'block-end', index: state.index, block: { type: state.type, text: state.text } }];
  }
  detail(text, name) {
    if (text.length <= this.maxToolOutput) return fence(text);
    let path;
    try { path = this.archiveOutput?.(text, name); } catch {}
    const notice = path
      ? `完整输出：[${name} 输出](<${String(path).replace(/>/g, '%3E')}>)`
      : '完整输出仍保留在本轮 Claude 上下文中。';
    return `${fence(`${text.slice(0, this.maxToolOutput)}\n…（聊天预览已截断，共 ${text.length} 个字符）`)}\n${notice}`;
  }
  tool(id, name, input) {
    if (this.tools.has(id)) return [];
    this.tools.set(id, { name, finished: false });
    return this.text(`▶ ${name} · 执行中\n\n${this.detail(outputText(input), name)}\n`, 'reasoning', false, { kind: 'native-tool-call', id, name, input });
  }
  accept(message) {
    const chunks = [];
    if (message.parent_tool_use_id) return chunks; // Parent Tool result already includes child output.
    if (message.type === 'stream_event') {
      const event = message.event || {};
      if (event.type === 'message_start') {
        for (const key of [...this.open.keys()]) chunks.push(...this.close(key));
        this.messageId = event.message?.id;
        this.partial.clear();
      }
      if (event.type === 'content_block_start') {
        const block = event.content_block || {};
        const key = event.index;
        this.partial.set(key, block.type);
        if (block.type === 'tool_use') {
          this.open.set(key, { type: 'tool_use', id: block.id, name: block.name, input: block.input, json: '' });
        } else if (block.type === 'text' || block.type === 'thinking') {
          const type = block.type === 'thinking' ? 'reasoning' : 'text';
          const state = { type, index: this.next++, text: block.text || block.thinking || '' };
          this.open.set(key, state);
          chunks.push({ type: 'block-start', index: state.index, blockType: type });
          if (state.text) chunks.push({ type: type === 'text' ? 'text-delta' : 'reasoning-delta', index: state.index, text: state.text });
          if (type === 'text') this.assistantText += state.text;
        }
      }
      if (event.type === 'content_block_delta') {
        const state = this.open.get(event.index);
        if (state) {
          const delta = event.delta || {};
          if (delta.type === 'input_json_delta') state.json += delta.partial_json || '';
          else if (delta.type === 'text_delta' || delta.type === 'thinking_delta') {
            const text = delta.text || delta.thinking || '';
            state.text += text;
            chunks.push({ type: state.type === 'text' ? 'text-delta' : 'reasoning-delta', index: state.index, text });
            if (state.type === 'text') this.assistantText += text;
          }
        }
      }
      if (event.type === 'content_block_stop') chunks.push(...this.close(event.index, true));
      if (event.type === 'message_stop' && this.messageId) this.completed.add(this.messageId);
    }
    if (message.type === 'assistant') {
      const id = message.message?.id;
      const streamed = (id && (id === this.messageId || this.completed.has(id))) || (!id && this.partial.size > 0);
      for (const [index, block] of (message.message?.content || []).entries()) {
        if (block.type === 'tool_use') chunks.push(...this.tool(block.id, block.name, block.input));
        else if (!streamed || !this.partial.has(index)) {
          if (block.type === 'text') chunks.push(...this.text(block.text));
          if (block.type === 'thinking') chunks.push(...this.text(block.thinking, 'reasoning'));
        }
      }
    }
    if (message.type === 'user') {
      for (const block of message.message?.content || []) {
        if (block.type !== 'tool_result') continue;
        const tool = this.tools.get(block.tool_use_id);
        if (tool?.finished) continue;
        if (tool) tool.finished = true;
        const name = tool?.name || 'Tool';
        const detail = outputText(block.content);
        chunks.push(...this.text(`${block.is_error ? '✗' : '✓'} ${name}${block.is_error ? ' · 失败' : ' · 完成'}${detail ? `\n\n${this.detail(detail, name)}` : ''}\n`, 'reasoning', false, {
          kind: 'native-tool-result', id: block.tool_use_id, name, output: block.content ?? '', isError: block.is_error === true,
        }));
      }
    }
    if (message.type === 'system' && message.subtype === 'api_retry') {
      chunks.push(...this.text(`Claude API 暂时不可用，正在重试（${message.status || message.error_status || '上游错误'}）。\n`, 'reasoning', false));
    }
    if (message.type === 'result') {
      this.result = message;
      for (const key of [...this.open.keys()]) chunks.push(...this.close(key));
      if (message.result && !this.assistantText.trimEnd().endsWith(message.result.trim())) chunks.push(...this.text(message.result));
      if (message.usage) {
        const usage = message.usage;
        this.usage = {
          inputTokens: usage.input_tokens || 0, outputTokens: usage.output_tokens || 0,
          cacheReadTokens: usage.cache_read_input_tokens || 0, cacheWriteTokens: usage.cache_creation_input_tokens || 0,
        };
      }
    }
    return chunks;
  }
  end({ stopped = false } = {}) {
    const chunks = [...this.open.keys()].flatMap(key => this.close(key));
    for (const tool of this.tools.values()) {
      if (tool.finished) continue;
      tool.finished = true;
      chunks.push(...this.text(`${stopped ? '⏹' : '⚠'} ${tool.name} · ${stopped ? '已停止' : '未收到结果'}（执行结果未知）\n`, 'reasoning', false));
    }
    return chunks;
  }
}

export function conversationPrompt(options, fileText = ref => `[File: ${ref.name || ref.attachmentId}]`, imageText = ref => imageHandleText(ref, undefined)) {
  const messages = options.messages.map(message => ({
    role: message.role,
    ...(message.toolCallId ? { toolCallId: message.toolCallId, isError: message.isError === true } : {}),
    content: message.content.flatMap((block, index) => {
      if (block.type === 'reasoning') {
        const replay = message.source?.replayState;
        const record = replay?.response?.format === REPLAY_FORMAT && Array.isArray(replay.blocks) ? replay.blocks[index] : undefined;
        if (record?.kind === 'native-tool-call' || record?.kind === 'native-tool-result') {
          return [{ type: 'text', text: `Native Claude Code tool record (already executed; do not repeat as a new task): ${JSON.stringify(record)}` }];
        }
        return []; // Genuine thinking is not replayed as instructions or visible history.
      }
      if (block.type === 'text') return [{ type: 'text', text: block.text }];
      if (block.type === 'file') return [{ type: 'text', text: fileText(block.attachment) }];
      if (block.type === 'tool-call') return [{ type: 'tool-call', id: block.id, name: block.name, arguments: block.arguments }];
      if (block.type === 'image') return [{ type: 'text', text: imageText(block.attachment) }];
      return []; // Thinking and tool catalog updates are not executable history.
    }),
  }));
  if (options.system) messages.unshift({ role: 'system', content: [{ type: 'text', text: options.system }] });
  return `Continue the DSH conversation below. The complete retained DSH conversation is supplied as JSON; roles identify its instructions, earlier answers and tool results. Follow the latest user request and applicable instructions, retaining earlier requirements. Earlier completed actions are history, not requests to repeat them. Use your native Claude Code tools for new work. Tool names in the DSH transcript may differ from your native tools. Reply directly to the user in their language.\n\n${JSON.stringify(messages)}`;
}
