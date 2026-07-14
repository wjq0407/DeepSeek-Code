import OpenAI from 'openai';

/** 错误提取：unknown 收窄为可读信息（供 catch 块统一使用） */
export function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * 从 DeepSeek 返回的 usage 中安全提取缓存命中/未命中 token。
 * DeepSeek 在 usage 里附带 prompt_cache_hit_tokens / prompt_cache_miss_tokens，
 * 但其 OpenAI 兼容 SDK 的类型未声明这两个字段，故用宽松读取。
 */
function extractCacheTokens(u: unknown): { hit: number; miss: number } {
  const rec = u as Record<string, unknown> | null;
  const hit = typeof rec?.['prompt_cache_hit_tokens'] === 'number' ? (rec!['prompt_cache_hit_tokens'] as number) : 0;
  const miss = typeof rec?.['prompt_cache_miss_tokens'] === 'number' ? (rec!['prompt_cache_miss_tokens'] as number) : 0;
  return { hit, miss };
}

/**
 * DeepSeek 官方价格表（¥/百万 token，标准档「缓存未命中」价，非高峰时段）。
 * 用于 P5 成本估算展示。V4 引入峰谷定价（高峰时段 9:00-12:00、14:00-18:00 价格翻倍），
 * 此处取标准（非高峰）价；若调价或有缓存命中（更便宜），更新此处即可。
 *
 * 缓存定价：命中前缀缓存的输入 token 按标准 input 价的 1/10 计费
 * （DeepSeek Context Caching 官方规则，getUsageSummary 中已按 CACHE_HIT_RATIO=0.1 计算）。
 */
const PRICING: Record<string, { input: number; output: number }> = {
  // ── V4 系列（2026-07 起，1M 上下文）──
  'deepseek-v4-flash': { input: 1.0, output: 2.0 }, // 非思考模式，等价旧 deepseek-chat
  'deepseek-v4-pro': { input: 3.13, output: 6.26 }, // 思考模式，深度分析，约旧 chat 的 3 倍
  // ── 旧别名（2026-07-24 15:59 UTC 弃用，过渡期保留识别）──
  'deepseek-chat': { input: 1.0, output: 2.0 },
  'deepseek-chat-v3-250324': { input: 1.0, output: 2.0 },
  'deepseek-reasoner': { input: 4, output: 16 },
  'deepseek-reasoner-250522': { input: 4, output: 16 },
};
const DEFAULT_PRICE = { input: 1, output: 2 };

export type Role = 'system' | 'user' | 'assistant' | 'tool';

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: Role;
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface StreamEvent {
  type: 'content' | 'tool_use' | 'done' | 'error' | 'aborted';
  text?: string;
  tools?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
  error?: string;
}

/** V4 思考强度档位（low/medium 会被服务端映射为 high，xhigh 映射为 max） */
export type ReasoningEffort = 'low' | 'medium' | 'high' | 'max';

/**
 * 模型 API 层：封装 DeepSeek 原生调用。
 * DeepSeek 兼容 OpenAI 接口，使用 openai SDK + baseURL 指向 api.deepseek.com。
 *
 * ## 双模型策略（V4 迁移，2026-07）
 * - **主模型 (model)**: deepseek-v4-flash（非思考模式）— 用于 Agent Loop 主循环的流式工具调用，
 *   响应快、tool calling 精准、成本低。temperature 固定 0.1 保证确定性。
 *   ⚠️ V4 思考模式默认开启，主循环通过 extra_body.thinking={type:'disabled'} 显式关闭，
 *   以等价旧 deepseek-chat 行为，并规避「思考+工具调用需回传 reasoning_content」的 400 陷阱。
 * - **推理模型 (reasonerModel)**: deepseek-v4-pro（思考模式）— 用于 review_code / audit_dependencies
 *   / terminology / project_discover / git_commit_msg 等复合工具的二次推理，
 *   通过 reasoning_effort 控制思考强度（high/max），深度分析质量更高。
 *   若未配置则回退到主模型。
 *
 * 负责流式解析与 tool_calls 增量拼接，对上层只暴露规整的 StreamEvent。
 */
export class DeepSeekClient {
  private client: OpenAI;
  private model: string;
  private reasonerModel: string;
  /** P5: 跨调用 token 用量累加（按模型名分桶），供成本估算 */
  private usageByModel: Map<string, {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    cacheHitTokens: number;   // 命中缓存的输入 token（DeepSeek 前缀缓存）
    cacheMissTokens: number;  // 未命中缓存的输入 token
  }> = new Map();

  constructor(opts: { apiKey: string; baseURL: string; model: string; reasonerModel?: string }) {
    this.client = new OpenAI({ apiKey: opts.apiKey, baseURL: opts.baseURL });
    this.model = opts.model;
    this.reasonerModel = opts.reasonerModel ?? opts.model;
  }

  /** 获取当前主模型名称 */
  get primaryModel(): string {
    return this.model;
  }

  /** 获取推理模型名称（用于复合工具的深度分析） */
  get reasoningModel(): string {
    return this.reasonerModel;
  }

  async *streamChat(
    messages: ChatMessage[],
    tools: unknown[],
    options?: { signal?: AbortSignal; timeoutMs?: number },
  ): AsyncGenerator<StreamEvent> {
    // 流级总超时：独立 AbortController，超时后切断底层 TCP 连接。
    // OpenAI SDK 的 timeout 参数对流式请求只控制 chunk 间的读取超时，
    // 若服务端发送几个 chunk 后停止发送但不关连接，for await 会永久挂起。
    // AbortSignal.any() 将用户 Ctrl+C 信号与流级超时合并——任一 abort 都切断连接。
    const streamTimeoutMs = options?.timeoutMs ?? 180_000;
    const streamTimer = new AbortController();
    const timerId = setTimeout(() => {
      streamTimer.abort(new DOMException('流式响应总时长超时', 'TimeoutError'));
    }, streamTimeoutMs);

    try {
      // 合并用户信号与流级超时信号
      const sigs: AbortSignal[] = [streamTimer.signal];
      if (options?.signal) sigs.push(options.signal);
      const mergedSignal = AbortSignal.any(sigs);

      const stream = await this.client.chat.completions.create(
        {
          model: this.model,
          messages: messages as unknown as OpenAI.Chat.ChatCompletionMessageParam[],
          tools: tools as unknown as OpenAI.Chat.ChatCompletionTool[],
          stream: true,
          temperature: 0.1,
          stream_options: { include_usage: true },
        },
        {
          signal: mergedSignal,
          extra_body: { thinking: { type: 'disabled' } },
        } as OpenAI.RequestOptions,
      );

      const toolAcc: Map<number, { id: string; name: string; args: string }> = new Map();

      for await (const chunk of stream) {
        const delta = chunk.choices?.[0]?.delta;
        if (!delta) continue;

        // P5: 收集用量（DeepSeek 在最后一个 chunk 携带 usage）
        if (chunk.usage) {
          const c = extractCacheTokens(chunk.usage);
          this.addUsage(this.model, {
            promptTokens: chunk.usage.prompt_tokens ?? 0,
            completionTokens: chunk.usage.completion_tokens ?? 0,
            totalTokens: chunk.usage.total_tokens ?? 0,
            cacheHitTokens: c.hit,
            cacheMissTokens: c.miss,
          });
        }

        if (delta.content) {
          yield { type: 'content', text: delta.content };
        }

        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index ?? 0;
            if (!toolAcc.has(idx)) toolAcc.set(idx, { id: tc.id ?? `call_${idx}`, name: '', args: '' });
            const cur = toolAcc.get(idx)!;
            if (tc.id) cur.id = tc.id;
            if (tc.function?.name) cur.name = tc.function.name;
            if (tc.function?.arguments) cur.args += tc.function.arguments;
          }
        }
      }

      if (toolAcc.size > 0) {
        const toolsParsed = [...toolAcc.values()].map((t) => {
          let args: Record<string, unknown> = {};
          try {
            args = JSON.parse(t.args || '{}');
          } catch {
            args = {};
          }
          return { id: t.id, name: t.name, arguments: args };
        });
        yield { type: 'tool_use', tools: toolsParsed };
      }

      yield { type: 'done' };
    } catch (e: unknown) {
      // 区分三类终止原因：
      // 1. 流级总超时（我们的 AbortController）→ 显式报超时，不冒充用户中断
      // 2. 用户 Ctrl+C（options.signal 已 abort）→ 用户中断
      // 3. 网络/API 错误 → 通用错误
      const isStreamTimeout =
        e instanceof DOMException && e.name === 'TimeoutError';
      const isUserAbort = options?.signal?.aborted;
      const isGenericAbort =
        !isStreamTimeout && !isUserAbort && e instanceof Error && e.name === 'AbortError';

      if (isStreamTimeout) {
        yield {
          type: 'error',
          error: `流式响应超时（${Math.round(streamTimeoutMs / 1000)}s），可能上下文过大或服务繁忙，请重试或缩小任务范围`,
        };
      } else if (isUserAbort || isGenericAbort) {
        yield { type: 'aborted' };
      } else {
        yield { type: 'error', error: errMsg(e) };
      }
    } finally {
      clearTimeout(timerId);
    }
  }

  /**
   * 非流式补全（用于工具内部的子任务，如中文代码审查、依赖审计）。
   * 不携带 tools，避免子任务中模型再次触发工具循环（对应路线：复合工具）。
   *
   * @param messages 对话消息
   * @param temperature 温度（分析任务默认 0.3；思考模式下该值被忽略，不影响结果）
   * @param options.modelOverride 指定使用的模型（不传则用 reasonerModel，即 v4-pro）
   * @param options.jsonMode 是否启用 JSON 结构化输出模式
   * @param options.reasoning 思考模式配置：开启后通过 extra_body.thinking 启用 V4 思考，
   *        并以 reasoning_effort 控制强度（low/medium→high，high/max 为真实档位）。
   *        复合工具（review/audit/terminology/discover/git_commit_msg）应开启以最大化分析质量；
   *        系统任务（如 history 摘要压缩）保持关闭以省成本。
   */
  async complete(
    messages: ChatMessage[],
    temperature = 0.3,
    options?: {
      modelOverride?: string;
      jsonMode?: boolean;
      reasoning?: { effort?: ReasoningEffort };
      signal?: AbortSignal;
      /** 硬性超时兜底（毫秒）。防止服务端假死导致 complete() 永久挂起。默认 180s。 */
      timeoutMs?: number;
    },
  ): Promise<string> {
    const useModel = options?.modelOverride ?? this.reasonerModel;
    const effort = options?.reasoning?.effort ?? 'high';
    try {
      const params = {
        model: useModel,
        messages: messages as unknown as OpenAI.Chat.ChatCompletionMessageParam[],
        stream: false,
        temperature,
        ...(options?.jsonMode ? { response_format: { type: 'json_object' } } : {}),
        ...(options?.reasoning ? { reasoning_effort: effort } : {}),
      } as unknown as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming;

      const reqOptions = {
        signal: options?.signal,
        // 子任务调用硬性超时兜底：与 streamChat 同理，避免复合工具/压缩摘要卡死主循环。
        timeout: options?.timeoutMs ?? 180_000,
        extra_body: {
          thinking: options?.reasoning ? { type: 'enabled' as const } : { type: 'disabled' as const },
        },
      } as OpenAI.RequestOptions;

      const resp = await this.client.chat.completions.create(params, reqOptions);
      if (resp.usage) {
        const c = extractCacheTokens(resp.usage);
        this.addUsage(useModel, {
          promptTokens: resp.usage.prompt_tokens ?? 0,
          completionTokens: resp.usage.completion_tokens ?? 0,
          totalTokens: resp.usage.total_tokens ?? 0,
          cacheHitTokens: c.hit,
          cacheMissTokens: c.miss,
        });
      }
      return resp.choices?.[0]?.message?.content ?? '';
    } catch (e: unknown) {
      if (options?.signal?.aborted ?? (e instanceof Error && e.name === 'AbortError')) {
        return '（子任务已取消）';
      }
      return `子任务调用失败(${useModel}): ${errMsg(e)}`;
    }
  }

  /**
   * P5 成本估算：累加单次调用用量（按模型分桶）。
   */
  private addUsage(model: string, u: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    cacheHitTokens: number;
    cacheMissTokens: number;
  }): void {
    const cur = this.usageByModel.get(model) ?? {
      promptTokens: 0, completionTokens: 0, totalTokens: 0, cacheHitTokens: 0, cacheMissTokens: 0,
    };
    cur.promptTokens += u.promptTokens;
    cur.completionTokens += u.completionTokens;
    cur.totalTokens += u.totalTokens;
    cur.cacheHitTokens += u.cacheHitTokens;
    cur.cacheMissTokens += u.cacheMissTokens;
    this.usageByModel.set(model, cur);
  }

  /**
   * P5 成本估算：返回按模型汇总的用量与费用（¥），含缓存命中统计。
   */
  getUsageSummary(): {
    models: Array<{
      model: string;
      promptTokens: number;
      completionTokens: number;
      totalTokens: number;
      cacheHitTokens: number;
      cacheMissTokens: number;
      costCny: number;
    }>;
    totalTokens: number;
    totalCostCny: number;
    totalCacheHitTokens: number;
    totalCacheMissTokens: number;
  } {
    const models: Array<{
      model: string;
      promptTokens: number;
      completionTokens: number;
      totalTokens: number;
      cacheHitTokens: number;
      cacheMissTokens: number;
      costCny: number;
    }> = [];
    let totalTokens = 0;
    let totalCostCny = 0;
    let totalCacheHitTokens = 0;
    let totalCacheMissTokens = 0;
    for (const [model, u] of this.usageByModel.entries()) {
      const price = PRICING[model] ?? DEFAULT_PRICE;
      // 缓存命中 token 按 DeepSeek 缓存价（标准 input 的 1/10）计费，见下方 PRICING 说明
      const CACHE_HIT_RATIO = 0.1;
      const costCny =
        (u.cacheHitTokens / 1_000_000) * price.input * CACHE_HIT_RATIO +
        (u.cacheMissTokens / 1_000_000) * price.input +
        (u.completionTokens / 1_000_000) * price.output;
      totalTokens += u.totalTokens;
      totalCostCny += costCny;
      totalCacheHitTokens += u.cacheHitTokens;
      totalCacheMissTokens += u.cacheMissTokens;
      models.push({ model, ...u, costCny });
    }
    return { models, totalTokens, totalCostCny, totalCacheHitTokens, totalCacheMissTokens };
  }

  /** P5 成本估算：重置累计用量（新会话开始时调用） */
  resetUsage(): void {
    this.usageByModel.clear();
  }
}
