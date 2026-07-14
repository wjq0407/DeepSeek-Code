import { writeFile, mkdir, readdir, stat, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import type { ChatMessage, ToolCall } from '../llm/deepseek.ts';

/**
 * Trace 事件类型 — 覆盖 Agent Loop 完整生命周期。
 */
export type TraceEventType =
  | 'session_start'
  | 'user_input'
  | 'model_content'      // 模型流式文本片段
  | 'model_tool_use'     // 模型决定调用工具
  | 'tool_call'          // 工具开始执行
  | 'tool_result'        // 工具返回结果
  | 'context_compact'    // 上下文压缩（P0-① 每轮迭代末尾自动压缩）
  | 'early_exit'         // 无进展/死循环提前退出（P1-⑤）
  | 'assistant_message'  // 完整 assistant 消息（文本 + tool_calls），用于会话重放
  | 'permission_request' // 权限确认请求
  | 'permission_decision'// 权限决策结果
  | 'error'              // 错误
  | 'cancelled'          // 用户主动中断当前请求
  | 'session_end';       // 会话正常结束

export interface TraceEvent {
  /** ISO 8601 时间戳 */
  timestamp: string;
  /** 事件类型 */
  type: TraceEventType;
  /** 事件载荷（类型相关） */
  payload: Record<string, unknown>;
}

/**
 * JSONL Trace 日志系统（P2-1）。
 *
 * 将每次 Agent Loop 的完整事件流追加写入 .dsa/traces/ 目录下的 JSONL 文件。
 * 每行一个 JSON 对象，包含 timestamp、type、payload。
 *
 * 用途：
 * - 出错后精确定位哪一步坏
 * - 回放完整 Agent 行为链
 * - 统计工具调用频率和成本
 */
export class TraceLogger {
  private filePath: string;
  private sessionId: string;
  private events: TraceEvent[] = [];
  private enabled: boolean;

  constructor(options?: { workspaceDir?: string; enabled?: boolean }) {
    this.enabled = options?.enabled !== false; // 默认启用
    this.sessionId = `sess_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const baseDir = options?.workspaceDir ?? process.cwd();
    const traceDir = join(baseDir, '.dsa', 'traces');
    this.filePath = join(traceDir, `${this.sessionId}.jsonl`);
  }

  get id(): string {
    return this.sessionId;
  }

  /**
   * 记录一条 trace 事件。同时写入内存缓冲和文件。
   */
  async log(type: TraceEventType, payload: Record<string, unknown>): Promise<void> {
    if (!this.enabled) return;

    const event: TraceEvent = {
      timestamp: new Date().toISOString(),
      type,
      payload,
    };

    this.events.push(event);

    try {
      await this.ensureDir();
      const line = JSON.stringify(event) + '\n';
      await writeFile(this.filePath, line, { flag: 'a' });
    } catch {
      /* 文件写入失败不阻塞主流程 */
    }
  }

  /**
   * 批量记录（用于快速连续的事件，减少 I/O）。
   */
  async logBatch(events: Array<{ type: TraceEventType; payload: Record<string, unknown> }>): Promise<void> {
    if (!this.enabled) return;

    const now = new Date().toISOString();
    const lines = events
      .map((e) => JSON.stringify({ timestamp: now, type: e.type, payload: e.payload }) + '\n')
      .join('');

    this.events.push(
      ...events.map((e) => ({ timestamp: now, type: e.type, payload: e.payload })),
    );

    try {
      await this.ensureDir();
      await writeFile(this.filePath, lines, { flag: 'a' });
    } catch {
      /* 文件写入失败不阻塞主流程 */
    }
  }

  /** 标记会话结束 */
  async end(): Promise<void> {
    await this.log('session_end', { totalEvents: this.events.length });
  }

  /** 获取当前会话已记录的事件数 */
  get eventCount(): number {
    return this.events.length;
  }

  /**
   * 静态方法：获取最近的 trace 文件摘要（CLI 启动时展示）。
   */
  static async recentSummary(workspaceDir?: string): Promise<string[]> {
    const traceDir = join(workspaceDir ?? process.cwd(), '.dsa', 'traces');
    const lines: string[] = [];

    try {
      const files = await readdir(traceDir);
      const jsonlFiles = files.filter((f) => f.endsWith('.jsonl')).sort().reverse();

      // 取最近 5 个 trace 文件
      const recent = jsonlFiles.slice(0, 5);
      if (recent.length === 0) {
        return ['暂无 trace 记录'];
      }

      lines.push(`最近 ${recent.length} 个会话 trace:`);
      for (const f of recent) {
        const fp = join(traceDir, f);
        const s = await stat(fp);
        // 读第一行获取 session_start 信息
        const content = await readFileFirstLine(fp);
        let info = f.replace('.jsonl', '');
        try {
          const firstEvent = JSON.parse(content);
          if (firstEvent.payload?.cwd) {
            info += ` (${firstEvent.payload.cwd})`;
          }
        } catch { /* 解析失败就用文件名 */ }
        lines.push(`  ${info} | ${s.size}B | ${s.mtime.toLocaleString('zh-CN')}`);
      }
    } catch {
      lines.push('（trace 目录不存在或无法读取）');
    }

    return lines;
  }

  /**
   * P5 会话恢复：解析最近的 trace 文件，重建对话消息数组。
   * 返回 user/assistant/tool 消息（不含 system，由 ConversationHistory 自带）。
   * 若无可恢复内容则返回 null。
   */
  static async replay(workspaceDir?: string): Promise<ChatMessage[] | null> {
    const traceDir = join(workspaceDir ?? process.cwd(), '.dsa', 'traces');
    try {
      const files = await readdir(traceDir);
      const jsonlFiles = files.filter((f) => f.endsWith('.jsonl')).sort().reverse();
      if (jsonlFiles.length === 0) return null;
      const fp = join(traceDir, jsonlFiles[0]);
      const content = await readFile(fp, 'utf8');
      const lines = content.split('\n').filter((l) => l.trim().length > 0);
      const messages: ChatMessage[] = [];
      let pendingToolCalls: Array<{ id: string; name: string }> = [];

      for (const line of lines) {
        let ev: TraceEvent;
        try {
          ev = JSON.parse(line) as TraceEvent;
        } catch {
          continue;
        }
        if (ev.type === 'user_input') {
          messages.push({ role: 'user', content: String(ev.payload.input ?? '') });
        } else if (ev.type === 'assistant_message') {
          const content = String(ev.payload.content ?? '');
          const raw = ev.payload.toolCalls;
          let tool_calls: ToolCall[] | undefined;
          if (Array.isArray(raw) && raw.length > 0) {
            tool_calls = (raw as Array<{ id: string; name: string; arguments: unknown }>).map((t) => ({
              id: String(t.id),
              type: 'function',
              function: { name: String(t.name), arguments: typeof t.arguments === 'string' ? t.arguments : JSON.stringify(t.arguments ?? {}) },
            }));
            pendingToolCalls = (raw as Array<{ id: string; name: string }>).map((t) => ({ id: String(t.id), name: String(t.name) }));
          }
          // 关键：无工具调用时绝不发送空数组 tool_calls（DeepSeek API 报 400）
          messages.push(tool_calls ? { role: 'assistant', content, tool_calls } : { role: 'assistant', content });
        } else if (ev.type === 'tool_result') {
          const toolCallId = String(ev.payload.toolCallId ?? pendingToolCalls[0]?.id ?? 'unknown');
          const name = String(ev.payload.name ?? pendingToolCalls.shift()?.name ?? 'tool');
          const content = String(ev.payload.output ?? ev.payload.reason ?? '');
          messages.push({ role: 'tool', tool_call_id: toolCallId, name, content });
        }
      }
      return messages.length > 0 ? messages : null;
    } catch {
      return null;
    }
  }

  private async ensureDir(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
  }
}

/** 读取文件首行（辅助函数） */
async function readFileFirstLine(path: string): Promise<string> {
  // 简化实现：读整个文件取第一行（trace 文件通常不大）
  try {
    const { readFile } = await import('node:fs/promises');
    const content = await readFile(path, 'utf8');
    return content.split('\n')[0];
  } catch {
    return '{}';
  }
}
