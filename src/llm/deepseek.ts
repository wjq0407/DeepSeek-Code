import OpenAI from 'openai';
import { fetchSSE, type FetchSSEResult, type SSEErrorKind, SSEHttpError } from './sse';

/** 错误提取：unknown 收窄为可读信息（供 catch 块统一使用） */
export function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** 服务端错误的分类（用于前端差异化提示） */
export type StreamErrorCategory = 'moderation' | 'token_limit' | 'server_unavailable' | 'unknown';

/**
 * 把服务端错误归并为 4 类，供前端展示不同提示：
 *  - moderation：内容审核拒绝（不发内容，需调整提问）
 *  - token_limit：上下文/token 超限（需压缩或新开会话）
 *  - server_unavailable：限流 / 5xx 暂时不可用（可重试）
 *  - unknown：其他（展示原始错误）
 *
 * @param status HTTP 状态码（stream-level 错误无 HTTP 状态时传 0）
 * @param bodyError 服务端错误体（含 code/message），可为字符串或对象
 */
export function classifyLLMError(
  status: number,
  bodyError?: { code?: string | null; message?: string } | string,
): StreamErrorCategory {
  const msg = typeof bodyError === 'string' ? bodyError : (bodyError?.message ?? '');
  const code = typeof bodyError === 'string' ? undefined : bodyError?.code;
  const text = `${code ?? ''} ${msg}`.toLowerCase();

  // 1) 内容审核拒绝
  if (code === 'content_moderation' || /moderation|审核|敏感|inappropriate|policy/i.test(text)) {
    return 'moderation';
  }
  // 2) token / 上下文超限
  if (
    status === 413 ||
    code === 'context_length_exceeded' ||
    /maximum context length|token.{0,12}(limit|exceed|超限)|上下文长度|max.{0,6}tokens/i.test(text)
  ) {
    return 'token_limit';
  }
  // 3) 服务端暂时不可用：限流 / 5xx
  if (status === 429 || status === 500 || status === 502 || status === 503 || status === 504) {
    return 'server_unavailable';
  }
  // 4xx 其他 / 无状态码：再按关键词兜底一次，否则 unknown
  if (/moderation|审核|敏感/i.test(text)) return 'moderation';
  if (/maximum context length|上下文长度|token.{0,12}(limit|exceed)/i.test(text)) return 'token_limit';
  return 'unknown';
}

/** 从 SSEHttpError 的错误体里提取 {code,message}（供 classifyLLMError 使用） */
function extractBodyError(e: unknown): { code?: string | null; message?: string } | undefined {
  if (e instanceof SSEHttpError && e.body) {
    try {
      const j = JSON.parse(e.body) as Record<string, unknown>;
      const err = j['error'] as Record<string, unknown> | undefined;
      if (err) return { code: (err['code'] as string | null) ?? null, message: (err['message'] as string) ?? '' };
    } catch {
      return { message: e.body };
    }
  }
  return undefined;
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
  /** 服务端错误分类（仅 type==='error' 时有意义），供前端差异化提示 */
  errorCategory?: StreamErrorCategory;
}

/** V4 思考强度档位（low/medium 会被服务端映射为 high，xhigh 映射为 max） */
export type ReasoningEffort = 'low' | 'medium' | 'high' | 'max';

/** JSON Schema 定义（供 API json_schema / grammar 使用）。定义在 deepseek.ts 以避免循环导入。 */
export interface JsonSchemaDef {
  name: string;
  strict: boolean;
  schema: Record<string, unknown>;
}

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
  private apiKey: string;
  private baseURL: string;
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
    this.apiKey = opts.apiKey;
    this.baseURL = opts.baseURL;
    this.model = opts.model;
    // 推理模型默认 deepseek-v4-pro（思考模式）；未配置时回退到固定 pro，而非主模型，
    // 以保障双模型策略始终分离（主模型跑 Loop、推理模型做深度二次推理）。
    this.reasonerModel = opts.reasonerModel || 'deepseek-v4-pro';
  }

  /**
   * 轻量校验凭证是否可用（BYOK 场景：用户在网页填 Key 后即时验证）。
   * 走 `GET /models`，不消耗 token、不产生对话费用；401/403 即判定 Key 无效。
   */
  static async validate(opts: {
    apiKey: string;
    baseURL?: string;
  }): Promise<{ ok: true } | { ok: false; error: string }> {
    if (!opts.apiKey || !opts.apiKey.trim()) return { ok: false, error: 'API Key 不能为空' };
    const client = new OpenAI({
      apiKey: opts.apiKey.trim(),
      baseURL: opts.baseURL?.trim() || 'https://api.deepseek.com',
    });
    try {
      await client.models.list();
      return { ok: true };
    } catch (e: unknown) {
      const status = (e as { status?: number })?.status;
      if (status === 401 || status === 403) return { ok: false, error: 'API Key 无效或已过期（认证失败）' };
      return { ok: false, error: errMsg(e) };
    }
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
    // 流级总超时：覆盖「本次流式响应的整体生成时长」（默认 180s）。
    // 原生 EventSource / OpenAI SDK 的 timeout 仅控制 chunk 间读取超时，
    // 若服务端发几个 chunk 后停发但不关连接，for await 会永久挂起。
    // 此处用独立计时器在超时后直接 sse.abort() 切断底层连接。
    const streamTimeoutMs = options?.timeoutMs ?? 180_000;
    let streamTimedOut = false;

    // ── 异步队列：桥接 fetchSSE 的「回调式」流式到本生成器的 yield ──
    type QItem = { kind: 'event'; e: StreamEvent } | { kind: 'end' };
    const queue: QItem[] = [];
    const waiters: Array<(v: QItem) => void> = [];
    const enqueue = (item: QItem): void => {
      const w = waiters.shift();
      if (w) { w(item); return; } // 有直接等待者则投递，避免重复入队
      queue.push(item);
    };
    const dequeue = (): Promise<QItem> => {
      if (queue.length) return Promise.resolve(queue.shift()!);
      return new Promise<QItem>((resolve) => { waiters.push(resolve); });
    };

    // tool_calls 增量拼接（与 OpenAI SDK 版一致）
    const toolAcc: Map<number, { id: string; name: string; args: string }> = new Map();

    let finished = false;
    let lastErr: { error: unknown; attempt: number; kind: SSEErrorKind } | null = null;
    const TIMEOUT_MSG = `流式响应超时（${Math.round(streamTimeoutMs / 1000)}s），可能上下文过大或服务繁忙，请重试或缩小任务范围`;

    const parseTools = (acc: Map<number, { id: string; name: string; args: string }>): Array<{ id: string; name: string; arguments: Record<string, unknown> }> => {
      return [...acc.values()].map((t) => {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(t.args || '{}');
        } catch {
          args = {};
        }
        return { id: t.id, name: t.name, arguments: args };
      });
    };

    // 正常/异常收尾：把积攒的 tool_use 与终态事件依次入队，并标记结束。
    const finish = (success: boolean, errText?: string, category?: StreamErrorCategory): void => {
      if (finished) return;
      finished = true;
      if (toolAcc.size > 0) {
        enqueue({ kind: 'event', e: { type: 'tool_use', tools: parseTools(toolAcc) } });
      }
      if (success) enqueue({ kind: 'event', e: { type: 'done' } });
      else enqueue({ kind: 'event', e: { type: 'error', error: errText ?? '流式连接异常中断', errorCategory: category } });
      enqueue({ kind: 'end' });
    };
    const emitAborted = (): void => {
      if (finished) return;
      finished = true;
      enqueue({ kind: 'event', e: { type: 'aborted' } });
      enqueue({ kind: 'end' });
    };

    // 解析单个 OpenAI chunk JSON（data 字段），分发 content / tool_calls / usage。
    const handleChunk = (data: string): void => {
      let chunk: Record<string, unknown>;
      try {
        chunk = JSON.parse(data) as Record<string, unknown>;
      } catch {
        return;
      }
      // 流级错误对象（DeepSeek / OpenAI 兼容在 body 内下发 {error:{...}}，不进入 choices）
      const topErr = chunk['error'] as Record<string, unknown> | undefined;
      if (topErr && typeof topErr === 'object') {
        const bodyError: { code?: string | null; message?: string } = {
          code: (topErr['code'] as string | null) ?? null,
          message: (topErr['message'] as string) ?? '',
        };
        finish(
          false,
          (bodyError.message || '生成被服务端拒绝') + (bodyError.code ? `（${bodyError.code}）` : ''),
          classifyLLMError(0, bodyError),
        );
        return;
      }
      // 用量（DeepSeek 在最后一个 chunk 的顶层携带 usage）
      const usage = chunk['usage'] as Record<string, unknown> | undefined;
      if (usage) {
        const c = extractCacheTokens(usage);
        this.addUsage(this.model, {
          promptTokens: (usage['prompt_tokens'] as number) ?? 0,
          completionTokens: (usage['completion_tokens'] as number) ?? 0,
          totalTokens: (usage['total_tokens'] as number) ?? 0,
          cacheHitTokens: c.hit,
          cacheMissTokens: c.miss,
        });
      }
      const choices = chunk['choices'] as Array<Record<string, unknown>> | undefined;
      const delta = choices?.[0]?.['delta'] as Record<string, unknown> | undefined;
      if (!delta) return;
      const content = delta['content'] as string | undefined;
      if (content) enqueue({ kind: 'event', e: { type: 'content', text: content } });
      const toolCalls = delta['tool_calls'] as Array<Record<string, unknown>> | undefined;
      if (toolCalls) {
        for (const tc of toolCalls) {
          const idx = (tc['index'] as number) ?? 0;
          if (!toolAcc.has(idx)) toolAcc.set(idx, { id: (tc['id'] as string) ?? `call_${idx}`, name: '', args: '' });
          const cur = toolAcc.get(idx)!;
          if (tc['id']) cur.id = tc['id'] as string;
          const fn = tc['function'] as Record<string, unknown> | undefined;
          if (fn?.['name']) cur.name = fn['name'] as string;
          if (fn?.['arguments']) cur.args += fn['arguments'] as string;
        }
      }
    };

    // 直连 DeepSeek / OpenAI 兼容的 /chat/completions（POST + Bearer 鉴权 + 流式）。
    // 走 fetchSSE 手写 SSE 解析，绕开 EventSource 仅 GET 的限制，
    // 并获：连接建立 10s 超时、断线自动重连、lastEventId 续传（服务端支持时）。
    const base = this.baseURL.replace(/\/+$/, '');
    let sse: FetchSSEResult | null = null;
    const timerId = setTimeout(() => {
      streamTimedOut = true;
      sse?.abort(); // 整体生成时长超时 → 切断连接（fetchSSE 内部判定为 aborted）
    }, streamTimeoutMs);

    sse = fetchSSE({
      url: `${base}/chat/completions`,
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.model,
        messages: messages as unknown as OpenAI.Chat.ChatCompletionMessageParam[],
        tools: tools as unknown as OpenAI.Chat.ChatCompletionTool[],
        stream: true,
        temperature: 0.1,
        stream_options: { include_usage: true },
        thinking: { type: 'disabled' }, // 等价于 SDK 的 extra_body.thinking（V4 关闭思考，规避 400 陷阱）
      }),
      signal: options?.signal,
      connectTimeoutMs: 10_000, // 连接建立超时（仅「请求 → 响应头」），生成时长不在此限
      inactivityTimeoutMs: 0, // 禁用流内无数据超时：整体时长统一由上面的 streamTimeoutMs 控制
      maxRetries: 5, // 网络断开自动重连上限（DeepSeek 不发 id:，重连为「重新生成 + 已显示内容保留」）
      onMessage: (msg) => handleChunk(msg.data), // [DONE] 不会到达此处（fetchSSE 已拦截并触发 onDone）
      onDone: () => finish(true),
      onError: (info) => { lastErr = info; }, // 仅暂存，真正报错在 onEnd 终态时统一抛出（避免重连前误报）
      onEnd: (reason) => {
        if (reason === 'done') finish(true); // 正常 [DONE] 收尾（onDone 已先调用）
        else if (reason === 'aborted') {
          // 用户中断 或 整体生成时长超时（二者都经由 sse.abort()）
          if (streamTimedOut) finish(false, TIMEOUT_MSG, 'server_unavailable');
          else emitAborted();
        } else {
          // server-closed（流异常结束且无 [DONE]）/ max-retries（重连耗尽）→ 报错
          const status = lastErr?.error instanceof SSEHttpError ? lastErr.error.status : 0;
          const bodyErr = extractBodyError(lastErr?.error);
          const category = classifyLLMError(status, bodyErr);
          finish(false, lastErr ? errMsg(lastErr.error) : '流式连接异常中断', category);
        }
      },
    });

    try {
      while (true) {
        const item = await dequeue();
        if (item.kind === 'end') break;
        yield item.e;
      }
    } finally {
      clearTimeout(timerId);
      sse.abort(); // 生成器被消费方提前关闭（如用户中断 for-await）时也清理底层连接
    }
  }

  /**
   * 非流式补全（用于工具内部的子任务，如中文代码审查、依赖审计）。
   * 不携带 tools，避免子任务中模型再次触发工具循环（对应路线：复合工具）。
   *
   * @param messages 对话消息
   * @param temperature 温度（分析任务默认 0.3；思考模式下该值被忽略，不影响结果）
   * @param options.modelOverride 指定使用的模型（不传则用 reasonerModel，即 v4-pro）
   * @param options.jsonMode 是否启用 JSON 结构化输出模式（基础约束：仅保证合法 JSON 对象）
   * @param options.jsonSchema 严格 JSON Schema 模式（高级约束：API 层锁定字段名/类型/枚举值）；
   *        与 jsonMode 互斥，优先级更高。格式见 JsonSchemaDef。
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
      /** 严格 JSON Schema 模式（优先级高于 jsonMode） */
      jsonSchema?: JsonSchemaDef;
      reasoning?: { effort?: ReasoningEffort };
      signal?: AbortSignal;
      /** 硬性超时兜底（毫秒）。防止服务端假死导致 complete() 永久挂起。默认 180s。 */
      timeoutMs?: number;
    },
  ): Promise<string> {
    const useModel = options?.modelOverride ?? this.reasonerModel;
    const effort = options?.reasoning?.effort ?? 'high';
    try {
      // 结构化输出优先级：jsonSchema > jsonMode > 无约束
      const responseFormat = options?.jsonSchema
        ? { type: 'json_schema' as const, json_schema: options.jsonSchema }
        : options?.jsonMode
          ? { type: 'json_object' as const }
          : undefined;

      const params = {
        model: useModel,
        messages: messages as unknown as OpenAI.Chat.ChatCompletionMessageParam[],
        stream: false,
        temperature,
        ...(responseFormat ? { response_format: responseFormat } : {}),
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

  /** P3.9 按模型计算缓存命中率（0–1），供 /cost 展示。 */
  getCacheHitRate(model: string): number {
    const u = this.usageByModel.get(model);
    if (!u) return 0;
    const total = u.cacheHitTokens + u.cacheMissTokens;
    return total > 0 ? u.cacheHitTokens / total : 0;
  }

  /** P5 成本估算：重置累计用量（新会话开始时调用） */
  resetUsage(): void {
    this.usageByModel.clear();
  }
}
