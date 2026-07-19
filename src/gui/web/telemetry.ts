/**
 * 浏览器端遥测采集客户端（随 GUI 前端打包，运行在浏览器）。
 *
 * 挂载全局错误/拒绝/控制台/网络/生命周期钩子，把运行时异常结构化后批量经 WebSocket 上报
 * 给本地服务器（initBrowserTelemetry 的 send 回调由 App.tsx 注入，复用现有 WS）。
 *
 * 设计纪律（与后端 Hub 对齐）：
 *   - 全程 try/catch 防御：遥测自身绝不抛错、绝不阻塞页面渲染/交互。
 *   - 不捕获「遥测发送」相关异常（send 失败时仅丢弃本轮批量，不重试风暴）。
 *   - 同批次内按指纹去重，避免把同一条栈刷爆缓冲；跨批次允许重复（便于调试循环
 *     判断"问题是否仍存在"）。
 *   - 页面卸载前（pagehide）尽力 flush 一次，用于判断"调试是否正常关闭"。
 */
import type { BrowserTelemetryEvent, BrowserTelemetryKind } from '../telemetry-types.ts';

type SendFn = (events: BrowserTelemetryEvent[]) => boolean;

const FLUSH_MS = 600;
const MAX_BATCH = 60;
const MAX_BUFFER = 400;

let started = false;

export function initBrowserTelemetry(send: SendFn): void {
  if (started || typeof window === 'undefined') return;
  started = true;

  const buffer: BrowserTelemetryEvent[] = [];
  let timer: ReturnType<typeof setInterval> | null = null;

  const trim = (s: unknown, n = 600): string => {
    const t = typeof s === 'string' ? s : s == null ? '' : String(s);
    return t.length > n ? t.slice(0, n) + '…' : t;
  };

  const fp = (e: BrowserTelemetryEvent): string =>
    [e.kind, e.level ?? '', (e.message || '').slice(0, 120), e.url ?? '', e.status ?? ''].join('|');

  const push = (e: BrowserTelemetryEvent): void => {
    try {
      buffer.push(e);
      if (buffer.length > MAX_BUFFER) buffer.splice(0, buffer.length - MAX_BUFFER);
    } catch {
      /* noop */
    }
  };

  const flush = (): void => {
    if (buffer.length === 0) return;
    // 同批次去重：保留首次出现的指纹
    const seen = new Set<string>();
    const batch = buffer.splice(0, MAX_BATCH).filter((e) => {
      const k = fp(e);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    if (batch.length === 0) return;
    try {
      send(batch);
    } catch {
      // 发送失败（如 WS 已断开）：丢弃，避免堆积
    }
  };

  const startTimer = (): void => {
    if (timer == null) timer = setInterval(flush, FLUSH_MS);
  };

  const mk = (kind: BrowserTelemetryKind, partial: Partial<BrowserTelemetryEvent>): BrowserTelemetryEvent => {
    const { message, ...rest } = partial;
    return {
      kind,
      message: message ?? '(unknown)',
      timestamp: Date.now(),
      page: typeof location !== 'undefined' ? location.href : undefined,
      ...rest,
    };
  };

  try {
    // 1) 未捕获的 JS 运行时错误
    window.addEventListener(
      'error',
      (ev: Event) => {
        const e = ev as ErrorEvent;
        if (e && (e.message || e.error)) {
          push(
            mk('error', {
              message: trim(e.message),
              source: e.filename,
              line: e.lineno,
              col: e.colno,
              stack: e.error?.stack ? trim(e.error.stack, 1500) : undefined,
            }),
          );
          startTimer();
        }
      },
      true,
    );

    // 2) 未处理的 Promise 拒绝
    window.addEventListener('unhandledrejection', (ev: PromiseRejectionEvent) => {
      const r = ev.reason;
      const err = r instanceof Error ? r : null;
      push(
        mk('unhandledrejection', {
          message: trim(err ? err.message : `Promise rejected: ${typeof r === 'object' ? JSON.stringify(r)?.slice(0, 300) : String(r)}`),
          stack: err?.stack ? trim(err.stack, 1500) : undefined,
        }),
      );
      startTimer();
    });

    // 3) console.error / console.warn（保留原实现，仅旁路采集）
    const wrapConsole = (level: 'error' | 'warn'): void => {
      const orig = (console as unknown as Record<string, (...a: unknown[]) => void>)[level];
      if (typeof orig !== 'function') return;
      (console as unknown as Record<string, (...a: unknown[]) => void>)[level] = (...args: unknown[]) => {
        try {
          const msg = args
            .map((a) => (a instanceof Error ? `${a.message}\n${a.stack ?? ''}` : typeof a === 'object' ? JSON.stringify(a) : String(a)))
            .join(' ');
          push(mk('console', { level, message: trim(msg, 1200) }));
          startTimer();
        } catch {
          /* noop */
        }
        orig.apply(console, args);
      };
    };
    wrapConsole('error');
    wrapConsole('warn');

    // 4) fetch 失败 / 非 2xx
    const nativeFetch = window.fetch?.bind(window);
    if (nativeFetch) {
      window.fetch = ((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request)?.url;
        const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
        return nativeFetch(input, init).then(
          (res: Response) => {
            if (res.status >= 400) {
              push(mk('network', { level: 'error', method, url, status: res.status, message: trim(`HTTP ${res.status} ${res.statusText || ''}`.trim()) }));
              startTimer();
            }
            return res;
          },
          (err: unknown) => {
            push(
              mk('network', {
                level: 'error',
                method,
                url,
                message: trim(`网络请求失败: ${err instanceof Error ? err.message : String(err)}`),
              }),
            );
            startTimer();
            throw err;
          },
        );
      }) as typeof window.fetch;
    }

    // 5) XMLHttpRequest 失败 / 非 2xx
    const nativeXHROpen = XMLHttpRequest.prototype.open;
    const nativeXHRSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = (function (
      this: XMLHttpRequest,
      method: string,
      url: string | URL,
      async: boolean = true,
      user?: string | null,
      password?: string | null,
    ): void {
      const meta = this as unknown as { __tm_method?: string; __tm_url?: string };
      meta.__tm_method = method;
      meta.__tm_url = typeof url === 'string' ? url : url.href;
      return nativeXHROpen.call(this, method, url, async, user, password);
    }) as typeof XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.send = (function (
      this: XMLHttpRequest,
      body?: Document | XMLHttpRequestBodyInit | null,
    ): void {
      const meta = this as unknown as { __tm_method?: string; __tm_url?: string; __tm_done?: boolean };
      const method = meta.__tm_method ?? 'GET';
      const url = meta.__tm_url;
      const onState = (): void => {
        if (this.readyState === XMLHttpRequest.DONE && !meta.__tm_done) {
          meta.__tm_done = true;
          if (this.status >= 400) {
            push(mk('network', { level: 'error', method, url, status: this.status, message: trim(`HTTP ${this.status}`.trim()) }));
            startTimer();
          }
        }
      };
      this.addEventListener('readystatechange', onState);
      this.addEventListener('error', () => {
        if (!meta.__tm_done) {
          meta.__tm_done = true;
          push(mk('network', { level: 'error', method, url, message: trim('XHR 请求失败（网络错误）') }));
          startTimer();
        }
      });
      return nativeXHRSend.call(this, body);
    }) as typeof XMLHttpRequest.prototype.send;

    // 6) 页面生命周期：加载完成 + 卸载（判断"网页是否正常加载 / 调试是否正常关闭"）
    push(mk('lifecycle', { level: 'load', message: '页面已加载', url: typeof location !== 'undefined' ? location.href : undefined }));
    window.addEventListener('pagehide', () => {
      try {
        push(mk('lifecycle', { level: 'unload', message: '页面正在卸载（调试会话结束）', url: typeof location !== 'undefined' ? location.href : undefined }));
        flush(); // 尽力在卸载前把本批上报出去
      } catch {
        /* noop */
      }
    });

    startTimer();
  } catch {
    // 初始化失败不影响主程序
  }
}
