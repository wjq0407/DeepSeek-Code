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
  }

  addAssistant(content: string, toolCalls?: ToolCall[]): void {
    this.messages.push({ role: 'assistant', content, tool_calls: toolCalls });
  }

  addToolResult(toolCallId: string, name: string, content: string): void {
    this.messages.push({ role: 'tool', tool_call_id: toolCallId, name, content });
  }

  getMessages(): ChatMessage[] {
    return this.messages;
  }

  /**
   * P5 会话恢复：从外部消息数组重建历史（跳过 system，保留内部自带 system）。
   */
  loadMessages(messages: ChatMessage[]): void {
    const sys = this.messages[0];
    const incoming = messages.filter((m) => m.role !== 'system');
    this.messages = [sys, ...incoming];
  }

  clear(): void {
    this.messages = [{ role: 'system', content: this.systemPrompt }];
    this.compactionCount = 0;
  }

  /** 估算当前上下文总 token 数 */
  estimateTotalTokens(): number {
    return this.messages.reduce((sum, msg) => sum + estimateMessageTokens(msg), 0);
  }

  /**
   * 压缩上下文。现在可能是异步的（需要调用模型做摘要）。
   * 调用方应 await 此方法。
   */
  async compact(): Promise<void> {
    const sys = this.messages[0];
    const rest = this.messages.slice(1);

    // 快速检查：如果消息量很少，不需要压缩
    if (rest.length <= this.keepRecentRounds * 2) return;

    const totalTokens = rest.reduce((sum, msg) => sum + estimateMessageTokens(msg), 0);

    // 未超预算也不压缩
    if (totalTokens < this.maxTokens * 0.8) return;

    // 有 LLM 客户端 → 摘要压缩
    if (this.client) {
      await this.summarizeCompact(sys, rest);
      return;
    }

    // 无客户端 → 降级为旧版截断
    this.truncateCompact(sys, rest);
  }

  /**
   * 摘要式压缩：用模型将旧对话生成中文摘要，保留最近 N 轮完整。
   */
  private async summarizeCompact(sys: ChatMessage, rest: ChatMessage[]): Promise<void> {
    const splitIdx = Math.max(0, rest.length - this.keepRecentRounds * 2);
    const toSummarize = rest.slice(0, splitIdx);
    const toKeep = rest.slice(splitIdx);

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
      });
      this.compactionCount++;

      // 用特殊的 context_summary 角色插入摘要
      const summaryMsg: ChatMessage = {
        role: 'user',
        content: `[上下文摘要 #${this.compactionCount} — 已压缩 ${toSummarize.length} 条消息]\n${summary}`,
      };

      this.messages = [sys, summaryMsg, ...toKeep];
    } catch {
      // 摘要失败 → 降级为截断
      this.truncateCompact(sys, rest);
    }
  }

  /**
   * P2-⑦ 确定性 snip 降级压缩（无需 LLM，无客户端 / 摘要失败时使用）。
   *
   * 相比旧版「直接丢弃最旧整条消息」，本策略分两级、优先保留对话结构：
   * 1. **snip 级**：对「较旧半区」的每条消息内容做确定性 head+tail 截断
   *    （保留开头与结尾、掐掉中段并打标记）。最近 N 轮完整保留不动。
   *    若截断后总量已回落到预算内 → 保留全部消息结构（仅内容变短）。
   * 2. **硬丢级**：snip 后仍超预算 → 退回旧版行为，丢弃最旧消息只留最近部分。
   *
   * 好处：确定性、可复现、零模型开销；长任务里 grep/read 等历史大结果被压扁，
   * 而不是把整轮上下文丢光，模型仍能看到「发生过什么」的骨架。
   */
  private truncateCompact(sys: ChatMessage, rest: ChatMessage[]): void {
    const keepCount = this.keepRecentRounds * 2;
    const budget = this.maxTokens * 0.8;

    // ── 第 1 级：对较旧半区逐条 snip（保留结构）──
    const splitIdx = Math.max(0, rest.length - keepCount);
    const snipped = rest.map((msg, i) => {
      if (i >= splitIdx) return msg; // 最近 N 轮完整保留
      const content = msg.content ?? '';
      if (estimateTokens(content) <= SNIP_MSG_TOKEN_THRESHOLD) return msg;
      return { ...msg, content: snipText(content) };
    });

    const snippedTotal = snipped.reduce((sum, m) => sum + estimateMessageTokens(m), 0);
    if (snippedTotal < budget) {
      this.messages = [sys, ...snipped];
      return;
    }

    // ── 第 2 级：snip 后仍超预算 → 硬丢最旧，保留最近部分（对已 snip 的消息）──
    const keep = snipped.slice(-keepCount);
    this.messages = [sys, ...keep];
  }

  /** P5: 暴露系统提示词，供会话持久化时记录 systemPrompt（恢复时重建 history 用） */
  get systemPromptText(): string {
    return this.systemPrompt;
  }
}
