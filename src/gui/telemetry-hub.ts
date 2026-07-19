/**
 * 浏览器遥测集线器（服务端 / 单连接粒度）。
 *
 * 职责：接收来自浏览器的遥测事件，缓冲起来，供 AgentHost 的调试循环在「等待浏览器反馈」
 * 窗口内消费。核心设计要点：
 *   - 有界环形缓冲（MAX_BUFFER），超出丢弃最旧，避免长会话内存膨胀。
 *   - waitForEvents(timeoutMs) 是「超时即返回」语义：无论是否收到事件，到点都 resolve
 *     （携带当前累积，可能为空）。这样调试循环永远不会因等待浏览器而永久挂起。
 *   - 非阻塞 drain()：取出并清空当前缓冲，供回灌成新一轮观察数据。
 */
import type { BrowserTelemetryEvent } from './telemetry-types.ts';

const MAX_BUFFER = 400;

export class BrowserTelemetryHub {
  private events: BrowserTelemetryEvent[] = [];
  private waiters: Array<(e: BrowserTelemetryEvent[]) => void> = [];

  /** 追加单条事件（带容量裁剪） */
  push(ev: BrowserTelemetryEvent): void {
    this.events.push(ev);
    if (this.events.length > MAX_BUFFER) {
      this.events.splice(0, this.events.length - MAX_BUFFER);
    }
    const w = this.waiters.shift();
    if (w) w(this.drain());
  }

  /** 批量追加 */
  pushMany(evs: BrowserTelemetryEvent[]): void {
    for (const e of evs) this.push(e);
  }

  /** 取出并清空当前缓冲 */
  drain(): BrowserTelemetryEvent[] {
    const out = this.events;
    this.events = [];
    return out;
  }

  /** 当前缓冲是否为空（仅用于非阻塞快路径判断，不保证并发安全） */
  isEmpty(): boolean {
    return this.events.length === 0;
  }

  /**
   * 等待浏览器上报。
   * - 若已有积压事件：立即返回并清空缓冲。
   * - 否则挂起，直到（a）有新事件到达（返回并清空）或（b）超时（返回当前累积，可能为空）。
   * 永不 reject —— 超时是正常路径，调试循环据此判断「页面健康、无报错」。
   */
  waitForEvents(timeoutMs: number): Promise<BrowserTelemetryEvent[]> {
    return new Promise<BrowserTelemetryEvent[]>((resolve) => {
      if (this.events.length > 0) {
        resolve(this.drain());
        return;
      }
      const fire = (drained?: BrowserTelemetryEvent[]): void => {
        if (timer) clearTimeout(timer);
        resolve(drained ?? this.drain());
      };
      const timer = setTimeout(fire, timeoutMs);
      this.waiters.push(fire);
    });
  }
}
