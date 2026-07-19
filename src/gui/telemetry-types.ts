/**
 * 浏览器遥测：前后端共用结构化类型。
 *
 * 用途：前端（网页 GUI / 或外部浏览器页面）把运行时错误、控制台日志、网络失败、
 * 页面生命周期事件采集后，经 WS（或 HTTP /api/telemetry）上报给本地服务器，服务器再把
 * 这些记录作为「观察数据」回灌进 AI 的调试循环，使调试循环得以延续。
 *
 * 该文件被两端共享：Node 侧（server.ts / telemetry-hub.ts / agent-host.ts）与浏览器侧
 * （vite 打包的 web 前端）都 import 它，因此不得 import 任何 Node / 浏览器专有 API。
 */

export type BrowserTelemetryKind =
  | 'error' // 未捕获的 JS 运行时错误（window.onerror）
  | 'unhandledrejection' // 未处理的 Promise 拒绝
  | 'console' // console.error / console.warn
  | 'network' // fetch / XHR 请求失败或 HTTP 非 2xx
  | 'lifecycle'; // 页面加载 / 卸载（判断网页是否正常加载、调试是否正常关闭）

export interface BrowserTelemetryEvent {
  kind: BrowserTelemetryKind;
  /** console: 'error' | 'warn'；lifecycle: 'load' | 'unload' */
  level?: string;
  message: string;
  /** 错误发生的脚本 URL（error 事件 / 网络请求） */
  source?: string;
  /** 错误行号 / 列号（error 事件） */
  line?: number;
  col?: number;
  /** 错误堆栈（error / unhandledrejection） */
  stack?: string;
  /** 网络请求 URL；lifecycle 时为页面 URL */
  url?: string;
  /** 网络请求方法 */
  method?: string;
  /** 网络响应状态码（仅 network 且收到响应时） */
  status?: number;
  /** 采集时刻的 Unix 毫秒时间戳 */
  timestamp: number;
  /** 采集时的 location.href（用于定位是哪个页面上报的） */
  page?: string;
  /**
   * 去重指纹：kind + 关键内容哈希。同一错误高频重复时用于客户端去重，
   * 避免把同一栈刷爆缓冲区。服务端不依赖此字段。
   */
  fingerprint?: string;
}

/** 前端 → 服务端 的上报消息负载 */
export interface TelemetryEnvelope {
  type: 'telemetry';
  events: BrowserTelemetryEvent[];
}
