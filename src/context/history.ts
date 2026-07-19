import { ChatMessage, DeepSeekClient, ToolCall } from '../llm/deepseek.ts';

/**
 * Token 估算启发式（无需 tokenizer，快速估算）。
 * 基于 OpenAI tiktoken 的粗略近似：
 * - 中日韩字符：约 1.5-2 tokens/字（DeepSeek 用 byte-level BPE，CJK 通常 1-3 tokens）
 * - ASCII 文本：约 0.25 tokens/字符（约 4 字符/token）
 * - 每条消息有固定结构开销（role、元数据）
 */
function estimateTokens(text: string | null): number {
  if (!text) return 4; // null content 的最小开销
  let tokens = 0;
  for (const ch of text) {
    if (ch.charCodeAt(0) > 0x2000 || /[\u3000-\u9fff\uac00-\ud7af]/.test(ch)) {
      tokens += 2; // CJK 字符
    } else if (ch <= '~') {
      tokens += 0.25; // ASCII
    } else {
      tokens += 1.5; // 其他 Unicode（拉丁扩展、符号等）
    }
  }
  return Math.ceil(tokens);
}

/**
 * P2-⑦: 单条消息内容触发 snip 的 token 阈值。低于此值的消息不裁剪
 * （避免把本来就短的消息切碎，反而降低可读性）。
 */
const SNIP_MSG_TOKEN_THRESHOLD = 400;
/** snip 时保留的开头字符数 */
const SNIP_HEAD_CHARS = 800;
/** snip 时保留的结尾字符数（尾部常含错误/结论，值得保留） */
const SNIP_TAIL_CHARS = 400;

/**
 * 确定性中段裁剪：保留内容开头与结尾，掐掉中段并打标记。
 * 纯函数、可复现、无模型开销。用于压缩降级路径。
 */
function snipText(content: string): string {
  if (content.length <= SNIP_HEAD_CHARS + SNIP_TAIL_CHARS) return content;
  const head = content.slice(0, SNIP_HEAD_CHARS);
  const tail = content.slice(content.length - SNIP_TAIL_CHARS);
  const cut = content.length - SNIP_HEAD_CHARS - SNIP_TAIL_CHARS;
  return `${head}\n…[已省略中段 ${cut} 字符]…\n${tail}`;
}

/** 估算一条消息的 token 数（含结构开销） */
function estimateMessageTokens(msg: ChatMessage): number {
  let tokens = 6; // role + 结构开销
  tokens += estimateTokens(msg.content);
  if (msg.tool_calls) {
    for (const tc of msg.tool_calls) {
      tokens += 12 + estimateTokens(tc.function.name) + estimateTokens(tc.function.arguments);
    }
  }
  if (msg.tool_call_id) tokens += 6;
  if (msg.name) tokens += estimateTokens(msg.name) + 4;
  return tokens;
}

/**
 * 上下文层：多轮对话历史管理。
 *
 * 对应 learn-claude-code 的 Persistent Memory 与 Four-Layer Context Compaction。
 *
 * ## P1-2 增强：从「硬截断」升级为「智能摘要压缩」
 *
 * ### v0.1 策略（已废弃）
 * 硬编码 maxRounds=20，超出时直接丢弃最旧消息。简单但丢失重要上下文。
 *
 * ### v0.2 策略（当前，V4 迁移后升级）
 * 1. **Token 预算制**：基于 DeepSeek V4 1M 上下文窗口，设置可配置预算（默认 400K，
 *    预留空间给模型响应和工具返回值，仍远低于 1M 上限以规避长上下文衰减）。
 * 2. **阈值触发**：当估算 token 数超过预算的 80% 时触发压缩。
 * 3. **摘要式压缩**：
 *    - 保留系统提示词不变
 *    - 保留最近 N 轮（默认 5 轮）完整消息不动
 *    - 将更早的消息交给模型生成结构化中文摘要
 *    - 摘要作为一条 "context_summary" 角色的消息插入到系统提示之后
 * 4. **回退机制**：若无 LLM client 可用（构造时未传入），降级为旧的轮数截断策略。
 */
export class ConversationHistory {
  private messages: ChatMessage[] = [];
  private systemPrompt: string;
  private maxTokens: number;
  private keepRecentRounds: number;
  private client?: DeepSeekClient;
  private compactionCount: number = 0;

  /** 缓存 getMessages() 结果，避免 Agent Loop 每轮 O(n*m) 重建 */
  private _cached: ChatMessage[] | null = null;
  private _dirty: boolean = true;

  private invalidateCache(): void {
    this._dirty = true;
    this._cached = null;
  }

  constructor(
    systemPrompt: string,
    options?: {
      /** Token 预算上限（默认 400000，适配 DeepSeek V4 1M 上下文窗口） */
      maxTokens?: number;
      /** 压缩时保留的最近完整轮数（默认 5） */
      keepRecentRounds?: number;
      /** 用于摘要压缩的 LLM 客户端（不传则降级为截断模式） */
      client?: DeepSeekClient;
    },
  ) {
    this.systemPrompt = systemPrompt;
    this.maxTokens = options?.maxTokens ?? 400_000;
    this.keepRecentRounds = options?.keepRecentRounds ?? 5;
    this.client = options?.client;
    this.messages.push({ role: 'system', content: systemPrompt });
  }

  addUser(text: string): void {
    this.messages.push({ role: 'user', content: text });
    this.invalidateCache();
  }

  addAssistant(content: string, toolCalls?: ToolCall[]): void {
    this.messages.push({ role: 'assistant', content, tool_calls: toolCalls });
    this.invalidateCache();
  }

  addToolResult(toolCallId: string, name: string, content: string): void {
    this.messages.push({ role: 'tool', tool_call_id: toolCallId, name, content });
    this.invalidateCache();
  }

  getMessages(): ChatMessage[] {
    // ✅ 缓存加速：Agent Loop 每轮调用 getMessages()，仅在消息变更后重建
    if (!this._dirty && this._cached) return this._cached;

    // 兜底：防止压缩/持久化/循环内插入 user 等把 assistant 的 tool_calls 和 tool 结果消息截断，
    // 导致 API 报 400。核心规则：
    // 1. 每个带 tool_calls 的 assistant 后面必须紧邻所有对应 tool 结果；
    // 2. 若缺失/被截断，则丢弃该 assistant 的 tool_calls 及全部相关 tool 结果；
    // 3. 最后删除任何没有对应前置 assistant tool_calls 的孤儿 tool 消息。
    const fixed: ChatMessage[] = [];
    const dropToolIds = new Set<string>();
    for (let i = 0; i < this.messages.length; i++) {
      const msg = this.messages[i];
      if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
        const expectedIds = new Set(msg.tool_calls.map((tc) => tc.id));
        const foundIds = new Set<string>();
        for (let j = i + 1; j < this.messages.length; j++) {
          const next = this.messages[j];
          if (next.role === 'tool' && next.tool_call_id) foundIds.add(next.tool_call_id);
          if (next.role === 'user' || next.role === 'assistant') break;
        }
        const missing = [...expectedIds].filter((id) => !foundIds.has(id));
        if (missing.length > 0) {
          // 部分工具结果缺失：整组 tool_calls 及其全部 tool 结果都丢弃，避免孤儿 tool 消息。
          for (const id of expectedIds) dropToolIds.add(id);
          fixed.push({
            ...msg,
            content: `${msg.content ?? ''}\n[上下文压缩导致 ${missing.length} 条工具调用结果缺失]`,
            tool_calls: undefined,
          });
          continue;
        }
      }
      fixed.push(msg);
    }
    let out = fixed.filter(
      (m) => !(m.role === 'tool' && m.tool_call_id && dropToolIds.has(m.tool_call_id)),
    );

    // 最后兜底：遍历一次，确保不存在没有对应 assistant tool_calls 的 tool 消息。
    const seenToolCallIds = new Set<string>();
    const cleaned: ChatMessage[] = [];
    for (const msg of out) {
      if (msg.role === 'assistant' && msg.tool_calls) {
        for (const tc of msg.tool_calls) seenToolCallIds.add(tc.id);
      }
      if (msg.role === 'tool' && msg.tool_call_id && !seenToolCallIds.has(msg.tool_call_id)) {
        continue; // 孤儿 tool 消息，跳过
      }
      cleaned.push(msg);
    }
    out = cleaned;

    this._cached = out;
    this._dirty = false;
    return out;
  }

  /**
   * P5 会话恢复：从外部消息数组重建历史（跳过 system，保留内部自带 system）。
   */
  loadMessages(messages: ChatMessage[]): void {
    const sys = this.messages[0];
    const incoming = messages.filter((m) => m.role !== 'system');
    this.messages = [sys, ...incoming];
    this.invalidateCache();
  }

  clear(): void {
    this.messages = [{ role: 'system', content: this.systemPrompt }];
    this.compactionCount = 0;
    this.invalidateCache();
  }

  /** 估算当前上下文总 token 数 */
  estimateTotalTokens(): number {
    return this.messages.reduce((sum, msg) => sum + estimateMessageTokens(msg), 0);
  }

  /**
   * 压缩上下文。现在可能是异步的（需要调用模型做摘要）。
   * 调用方应 await 此方法。
   *
   * @param options.force           跳过 token 预算 / 轮数阈值，强制压缩（供 /compact 手动命令使用）
   * @param options.keepRecentRounds 覆盖保留的最近完整轮数（默认用构造时的 keepRecentRounds）
   */
  async compact(
    options?: { signal?: AbortSignal; force?: boolean; keepRecentRounds?: number },
  ): Promise<void> {
    const sys = this.messages[0];
    const rest = this.messages.slice(1);
    const keep = options?.keepRecentRounds ?? this.keepRecentRounds;

    // 快速检查：如果消息量很少，不需要压缩（除非强制）
    if (!options?.force && rest.length <= this.keepRecentRounds * 2) return;

    const totalTokens = rest.reduce((sum, msg) => sum + estimateMessageTokens(msg), 0);

    // 未超预算也不压缩（除非强制）
    if (!options?.force && totalTokens < this.maxTokens * 0.8) return;

    // 有 LLM 客户端 → 摘要压缩
    if (this.client) {
      await this.summarizeCompact(sys, rest, options?.signal, keep);
      return;
    }

    // 无客户端 → 降级为旧版截断
    this.truncateCompact(sys, rest, keep);
  }

  /**
   * 摘要式压缩：用模型将旧对话生成中文摘要，保留最近 N 轮完整。
   */
  private async summarizeCompact(
    sys: ChatMessage,
    rest: ChatMessage[],
    signal?: AbortSignal,
    keep: number = this.keepRecentRounds,
  ): Promise<void> {
    const rounds = this.splitIntoRounds(rest);
    const keepRounds = keep;
    const splitIdx = Math.max(0, rounds.length - keepRounds);
    const toSummarize = rounds.slice(0, splitIdx).flat();
    const toKeep = rounds.slice(splitIdx).flat();

    if (toSummarize.length === 0) return;

    // 构建待摘要的对话文本
    const dialogueText = toSummarize
      .map((msg) => {
        const roleLabel = msg.role === 'user' ? '用户' : msg.role === 'assistant' ? '助手' : `[工具:${msg.name ?? msg.tool_call_id}]`;
        const preview = (msg.content ?? '').slice(0, 500);
        return `${roleLabel}: ${preview}${(msg.content ?? '').length > 500 ? '...(截断)' : ''}`;
      })
      .join('\n');

    const summaryPrompt = [
      {
        role: 'system' as const,
        content:
          '你是一个对话摘要助手。请用简体中文将以下多轮对话压缩成一份结构化摘要。\n' +
          '要求：\n' +
          '1. 保留所有关键决策、文件操作结果、错误信息和用户明确要求。\n' +
          '2. 省略冗余的过程性内容（如重复确认、中间输出）。\n' +
          '3. 按主题分段，每段 1-3 句话。\n' +
          '4. 输出控制在 800 字以内。\n' +
          '5. 不要编造原文没有的信息。',
      },
      {
        role: 'user' as const,
        content: `请压缩以下对话为摘要（这是第 ${this.compactionCount + 1} 次压缩）：\n\n${dialogueText}`,
      },
    ];

    try {
      // 上下文摘要属于系统级压缩任务：用主模型（flash）且关闭思考，
      // 避免每次压缩都触发推理模型（v4-pro）的昂贵深度推理，控制成本。
      const summary = await this.client!.complete(summaryPrompt, 0.2, {
        modelOverride: this.client!.primaryModel,
        // 压缩摘要是主循环每轮末尾的 await 点：透传 signal 让用户 Ctrl+C 能中断；
        // 显式 60s 超时避免服务端假死时 compact() 永久挂起主循环。
        signal,
        timeoutMs: 60_000,
      });
      this.compactionCount++;

      // 用特殊的 context_summary 角色插入摘要
      const summaryMsg: ChatMessage = {
        role: 'user',
        content: `[上下文摘要 #${this.compactionCount} — 已压缩 ${toSummarize.length} 条消息]\n${summary}`,
      };

      this.messages = [sys, summaryMsg, ...toKeep];
      this.invalidateCache();
    } catch {
      // 摘要失败 → 降级为截断
      this.truncateCompact(sys, rest);
    }
  }

  /**
   * 将消息按 user 消息切分为完整对话轮次。
   * 一轮 = 一条 user 消息 + 随后的 assistant 消息及其所有 tool 结果消息，
   * 直到下一条 user 消息或结束。这样压缩时不会撕开 assistant 的 tool_calls 与 tool 结果。
   */
  private splitIntoRounds(messages: ChatMessage[]): ChatMessage[][] {
    const rounds: ChatMessage[][] = [];
    let current: ChatMessage[] = [];
    for (const msg of messages) {
      if (msg.role === 'user') {
        if (current.length > 0) rounds.push(current);
        current = [msg];
      } else {
        current.push(msg);
      }
    }
    if (current.length > 0) rounds.push(current);
    return rounds;
  }

  /**
   * P2-⑦ 确定性 snip 降级压缩（无需 LLM，无客户端 / 摘要失败时使用）。
   *
   * 按完整对话轮次保留：assistant 的 tool_calls 与后续所有 tool 结果消息会被
   * 同一条 round 包住，避免被截断导致 API 报 400。
   */
  private truncateCompact(
    sys: ChatMessage,
    rest: ChatMessage[],
    keep: number = this.keepRecentRounds,
  ): void {
    const rounds = this.splitIntoRounds(rest);
    const keepRounds = keep;
    const budget = this.maxTokens * 0.8;

    // 前 (rounds.length - keepRounds) 个 round 是"较旧半区"，对其中长消息做 snip
    const oldRounds = rounds.slice(0, Math.max(0, rounds.length - keepRounds));
    const oldEndIndex = oldRounds.reduce((sum, r) => sum + r.length, 0);

    const snipped = rest.map((msg, i) => {
      if (i >= oldEndIndex) return msg; // 最近完整轮次保留不动
      const content = msg.content ?? '';
      if (estimateTokens(content) <= SNIP_MSG_TOKEN_THRESHOLD) return msg;
      return { ...msg, content: snipText(content) };
    });

    const snippedTotal = snipped.reduce((sum, m) => sum + estimateMessageTokens(m), 0);
    if (snippedTotal < budget) {
      this.messages = [sys, ...snipped];
      this.invalidateCache();
      return;
    }

    // 第 2 级：snip 后仍超预算 → 硬丢最旧 rounds，保留最近完整轮次
    const kept = snipped.slice(oldEndIndex);
    this.messages = [sys, ...kept];
    this.invalidateCache();
  }

  /** P5: 暴露系统提示词，供会话持久化时记录 systemPrompt（恢复时重建 history 用） */
  get systemPromptText(): string {
    return this.systemPrompt;
  }
}
