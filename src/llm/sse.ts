/**
 * fetchSSE —— 基于 fetch + ReadableStream 的 SSE 手动解析流式客户端。
 *
 * 解决原生 EventSource 的两大限制：
 *  1) EventSource 仅支持 GET，无法在请求体携带对话历史、也无法在 header 携带鉴权；
 *  2) EventSource 的重连是协议内建的（依赖 `retry:` 与自动重连），不可定制「断点续传」
 *     与「区分网络断开 / 服务端主动关闭」。
 *
 * 本模块自行实现：
 *  - POST + 任意 header（鉴权）
 *  - 逐字节读取 ReadableStream，按 SSE 规范手动解析 `data:` / `event:` / `id:` / `retry:`
 *  - 连接建立超时（仅覆盖「发起请求 → 拿到响应头」阶段，生成时长不限制）
 *  - 断线重连：监听 reader 异常 = 网络断开 → 重连；流正常结束（done）= 服务端主动关闭 → 不重连
 *  - lastEventId：解析 `id:` 字段并缓存，重连时通过 `Last-Event-ID` 请求头透传
 *    （服务端支持即从断点续传）
 *
 * ⚠️ 关于「续传」的现实约束：多数商用 LLM API（如 DeepSeek / OpenAI）的流式响应
 *  **只发 `data:` 行**，不发 `id:` 行，也不支持 `Last-Event-ID` 续传。此时
 *  lastEventId 始终为空，重连退化为「重新生成」。把续传做成「可插拔能力」：
 *  一旦服务端真的返回 `id:` 行，本模块自动启用续传——上层无需改代码。
 *
 * 该模块前后端通用（浏览器 fetch / Node 端 fetch 均可用），是「大模型流式输出对接前端」
 * 这类场景的核心客户端。
 */

export interface SSEMessage {
  event: string;
  data: string;
  id?: string;
}

export type SSEErrorKind = 'connect-timeout' | 'inactivity' | 'network';

export interface FetchSSEOptions {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  /** 请求体；可为函数，重连时重新求值（默认同一份）。 */
  body?: string | (() => string);
  /** 用户主动中断信号（如 Ctrl+C）。 */
  signal?: AbortSignal;
  /** 连接建立超时（ms），仅覆盖「发起请求 → 拿到响应头」。默认 10000。 */
  connectTimeoutMs?: number;
  /** 流内无新数据超时（ms）；任意窗口内无任何 chunk 则断开重连。默认 180000。<=0 禁用。 */
  inactivityTimeoutMs?: number;
  /** 最大重连次数（不含首次）。默认 10。 */
  maxRetries?: number;
  /** 重连退避基数（ms），指数增长。默认 1000。 */
  baseRetryDelayMs?: number;
  maxRetryDelayMs?: number;
  onOpen?: (info: { status: number; attempt: number }) => void;
  onMessage?: (msg: SSEMessage) => void;
  /** 收到 `data:[DONE]` 或流正常结束（无 DONE）时触发。 */
  onDone?: () => void;
  onError?: (info: { error: unknown; attempt: number; kind: SSEErrorKind }) => void;
  onReconnect?: (info: { attempt: number; lastEventId: string | null; delayMs: number }) => void;
  onEnd?: (reason: 'done' | 'server-closed' | 'aborted' | 'max-retries') => void;
  /** 自定义是否重连；默认网络/超时错误均重连（HTTP 4xx 由模块内部判定为不重连）。 */
  shouldReconnect?: (kind: SSEErrorKind) => boolean;
}

export interface FetchSSEResult {
  abort: () => void;
  getLastEventId: () => string | null;
}

class SSEConnectError extends Error {
  kind: SSEErrorKind;
  constructor(kind: SSEErrorKind, message: string, cause?: unknown) {
    super(message);
    this.name = 'SSEConnectError';
    this.kind = kind;
    if (cause !== undefined) (this as { cause?: unknown }).cause = cause;
  }
}

/**
 * 服务端返回非 2xx 响应时抛出，保留原始 HTTP 状态码与响应体，供上层按状态码/错误体分类错误
 * （内容审核拒绝 / token 超限 / 服务端暂时不可用 等）。
 */
export class SSEHttpError extends Error {
  status: number;
  statusText: string;
  /** 原始响应体文本（如 API 的 JSON 错误体），可能为空。 */
  body?: string;
  constructor(status: number, statusText: string, body?: string) {
    super(body ? `HTTP ${status} ${statusText}: ${body}` : `HTTP ${status} ${statusText}`);
    this.name = 'SSEHttpError';
    this.status = status;
    this.statusText = statusText;
    this.body = body;
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export function fetchSSE(opts: FetchSSEOptions): FetchSSEResult {
  const connectTimeoutMs = opts.connectTimeoutMs ?? 10_000;
  const inactivityTimeoutMs = opts.inactivityTimeoutMs ?? 180_000;
  const maxRetries = opts.maxRetries ?? 10;
  const baseRetryDelayMs = opts.baseRetryDelayMs ?? 1_000;
  const maxRetryDelayMs = opts.maxRetryDelayMs ?? 30_000;

  let lastEventId: string | null = null;
  let stopped = false;
  let attempt = 0;
  let currentCtrl: AbortController | null = null;

  const userSig = opts.signal;
  if (userSig) {
    if (userSig.aborted) stopped = true;
    userSig.addEventListener('abort', () => {
      stopped = true;
      currentCtrl?.abort();
    });
  }

  const connectOnce = async (): Promise<'done' | 'server-closed'> => {
    const ctrl = new AbortController();
    currentCtrl = ctrl;
    let timeoutKind: 'connect' | 'inactivity' | null = null;

    const connTimer = setTimeout(() => {
      timeoutKind = 'connect';
      ctrl.abort(new DOMException('连接建立超时', 'TimeoutError'));
    }, connectTimeoutMs);

    let inactivityTimer: ReturnType<typeof setTimeout> | undefined;
    const resetInactivity = (): void => {
      if (inactivityTimeoutMs <= 0) return;
      if (inactivityTimer) clearTimeout(inactivityTimer);
      inactivityTimer = setTimeout(() => {
        timeoutKind = 'inactivity';
        ctrl.abort(new DOMException('流无数据超时', 'TimeoutError'));
      }, inactivityTimeoutMs);
    };
    resetInactivity();

    const onUserAbort = (): void => ctrl.abort();
    if (userSig) userSig.addEventListener('abort', onUserAbort);

    const headers: Record<string, string> = {
      Accept: 'text/event-stream',
      ...(opts.headers ?? {}),
    };
    if (lastEventId) headers['Last-Event-ID'] = lastEventId;

    const body = typeof opts.body === 'function' ? opts.body() : opts.body;

    let resp: Response;
    try {
      resp = await fetch(opts.url, {
        method: opts.method ?? 'POST',
        headers,
        body,
        signal: ctrl.signal,
      });
    } catch (e) {
      clearTimeout(connTimer);
      if (inactivityTimer) clearTimeout(inactivityTimer);
      if (userSig) userSig.removeEventListener('abort', onUserAbort);
      // 连接建立阶段超时（拿到响应头之前）归类为 connect-timeout；其余网络错误为 network
      throw new SSEConnectError(
        timeoutKind === 'connect' ? 'connect-timeout' : 'network',
        e instanceof Error ? e.message : String(e),
        e,
      );
    }
    clearTimeout(connTimer);

    if (userSig?.aborted) {
      if (inactivityTimer) clearTimeout(inactivityTimer);
      userSig.removeEventListener('abort', onUserAbort);
      throw new DOMException('用户中断', 'AbortError');
    }
    if (!resp.ok) {
      if (inactivityTimer) clearTimeout(inactivityTimer);
      userSig?.removeEventListener('abort', onUserAbort);
      let bodyText: string | undefined;
      try {
        bodyText = await resp.text();
      } catch {
        /* 读取失败不影响主错误抛出 */
      }
      throw new SSEHttpError(resp.status, resp.statusText, bodyText);
    }

    opts.onOpen?.({ status: resp.status, attempt });
    const stream = resp.body;
    if (!stream) {
      if (inactivityTimer) clearTimeout(inactivityTimer);
      userSig?.removeEventListener('abort', onUserAbort);
      throw new Error('响应无 body（非流式）');
    }

    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    const dispatch = (raw: string): 'done' | void => {
      const lines = raw.replace(/\r\n|\r/g, '\n').split('\n');
      let event = 'message';
      let data = '';
      let id: string | undefined;
      for (const line of lines) {
        if (line === '' || line.startsWith(':')) continue;
        const sep = line.indexOf(':');
        const field = sep === -1 ? line : line.slice(0, sep);
        let value = sep === -1 ? '' : line.slice(sep + 1);
        if (value.startsWith(' ')) value = value.slice(1);
        if (field === 'event') event = value;
        else if (field === 'data') data += (data ? '\n' : '') + value;
        else if (field === 'id') {
          id = value;
          lastEventId = value;
        }
        // retry: 可由调用方读取；此处忽略（重连退避由模块统一控制）
      }
      if (!data) return;
      if (data === '[DONE]') {
        opts.onDone?.();
        return 'done';
      }
      opts.onMessage?.({ event, data, id });
    };

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          if (inactivityTimer) clearTimeout(inactivityTimer);
          userSig?.removeEventListener('abort', onUserAbort);
          return 'server-closed';
        }
        resetInactivity();
        buffer += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buffer.indexOf('\n\n')) !== -1) {
          const raw = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const r = dispatch(raw);
          if (r === 'done') {
            if (inactivityTimer) clearTimeout(inactivityTimer);
            userSig?.removeEventListener('abort', onUserAbort);
            return 'done';
          }
        }
      }
    } catch (e) {
      if (inactivityTimer) clearTimeout(inactivityTimer);
      userSig?.removeEventListener('abort', onUserAbort);
      throw new SSEConnectError(
        timeoutKind === 'connect' ? 'connect-timeout'
          : timeoutKind === 'inactivity' ? 'inactivity'
            : 'network',
        e instanceof Error ? e.message : String(e),
        e,
      );
    }
  };

  // 后台运行（不 await：调用方通过队列/回调消费）
  void (async () => {
    while (!stopped) {
      attempt++;
      try {
        const end = await connectOnce();
        stopped = true;
        opts.onEnd?.(end === 'done' ? 'done' : 'server-closed');
        return;
      } catch (e) {
        if (stopped || userSig?.aborted) {
          opts.onEnd?.('aborted');
          return;
        }
        const kind: SSEErrorKind = e instanceof SSEConnectError ? e.kind : 'network';
        const isHttp4xx =
          (e instanceof SSEHttpError && e.status >= 400 && e.status < 500) ||
          (e instanceof Error && /^HTTP 4\d\d/.test(e.message));
        const willRetry =
          !isHttp4xx &&
          attempt <= maxRetries &&
          (opts.shouldReconnect ? opts.shouldReconnect(kind) : true);
        opts.onError?.({ error: e, attempt, kind });
        if (isHttp4xx || !willRetry) {
          stopped = true;
          opts.onEnd?.(isHttp4xx ? 'server-closed' : 'max-retries');
          return;
        }
        const delay = Math.min(baseRetryDelayMs * 2 ** (attempt - 1), maxRetryDelayMs);
        opts.onReconnect?.({ attempt, lastEventId, delayMs: delay });
        await sleep(delay);
        if (stopped || userSig?.aborted) {
          opts.onEnd?.('aborted');
          return;
        }
      }
    }
  })();

  return {
    abort: () => {
      stopped = true;
      currentCtrl?.abort();
    },
    getLastEventId: () => lastEventId,
  };
}
