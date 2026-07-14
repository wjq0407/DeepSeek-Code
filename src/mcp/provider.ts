import { createTools, type ToolDef, type ToolResult, type Risk, type ToolContext } from '../tools/index.ts';
import type { DeepSeekClient } from '../llm/deepseek.ts';
import { msgOf } from '../utils/logger.ts';
import { McpConnection } from './client.ts';
import type { McpServerConfig } from './config.ts';
import type { Tool, CallToolResult } from '@modelcontextprotocol/sdk/types.js';

/**
 * 统一工具来源抽象：本地工具与 MCP 工具都实现同一接口。
 * 这样 Agent Loop 拿到的永远是一批 ToolDef[]，不关心工具来自进程内还是远端。
 */
export interface ToolProvider {
  /** 唯一标识；MCP provider 用作工具命名前缀（如 "github"），本地固定 "local"。 */
  readonly id: string;
  /** 列出该 provider 提供的工具（已映射为统一 ToolDef）。 */
  listTools(): Promise<ToolDef[]>;
  /** 释放底层资源（退出时调用）。 */
  close(): Promise<void>;
}

/** 本地工具 provider：直接包装现有 createTools(client)。 */
export class LocalToolProvider implements ToolProvider {
  readonly id = 'local';
  constructor(private client: DeepSeekClient) {}
  async listTools(): Promise<ToolDef[]> {
    return createTools(this.client);
  }
  async close(): Promise<void> {
    /* 本地工具无需清理 */
  }
}

/**
 * MCP 工具 provider：持有一个 McpConnection，把远端 tools/list 映射成 ToolDef。
 * 每个映射出的 ToolDef.execute 内部走 tools/call 把请求发给远端 server。
 */
export class McpToolProvider implements ToolProvider {
  readonly id: string;
  private conn: McpConnection;

  constructor(id: string, config: McpServerConfig) {
    this.id = id;
    this.conn = new McpConnection(id, config);
  }

  async listTools(): Promise<ToolDef[]> {
    try {
      const tools = await this.conn.listTools();
      return tools.map((t) => this.toToolDef(t));
    } catch (e: unknown) {
      // 单个 server 连不上不应拖垮整个 agent：跳过并告警
      console.warn(`[mcp] 连接 ${this.id} 失败，已跳过该 server: ${msgOf(e)}`);
      return [];
    }
  }

  /** 由 MCP tool annotations 推断风险等级，复用现有确认闸权。 */
  private riskOf(t: Tool): Risk {
    const a = t.annotations;
    if (a?.destructiveHint) return 'high';
    if (a?.readOnlyHint) return 'low';
    return 'mid';
  }

  /** 远端 tool → 统一 ToolDef（命名加 server 前缀防冲突）。 */
  private toToolDef(t: Tool): ToolDef {
    const remoteName = t.name;
    return {
      name: `${this.id}__${remoteName}`,
      description: t.description ?? '',
      // MCP 的 inputSchema 本就是 JSON Schema，直接复用
      parameters: (t.inputSchema ?? { type: 'object', properties: {} }) as Record<string, unknown>,
      risk: this.riskOf(t),
      // 关键修复：把 ctx（含 signal）透传给 callWrapped，否则 Ctrl+C 无法中断 MCP 调用、
      // 且浏览器类 server 挂起时 agent 死锁。
      execute: (args, ctx) => this.callWrapped(remoteName, args, ctx),
    };
  }

  /**
   * MCP 调用统一超时（与本地 run_command 策略对齐，略短）。
   * 浏览器类 server（playwright）在网页被关闭后底层请求会挂起，无超时则 agent 死锁。
   */
  private static readonly CALL_TIMEOUT_MS = 90_000;

  private async callWrapped(
    remoteName: string,
    args: Record<string, unknown>,
    ctx?: ToolContext,
  ): Promise<ToolResult> {
    try {
      const res = await this.conn.callTool(remoteName, args, {
        signal: ctx?.signal,
        timeoutMs: McpToolProvider.CALL_TIMEOUT_MS,
      });
      const isError = res.isError === true;
      return { ok: !isError, output: contentToText(res) };
    } catch (e: unknown) {
      // callTool 内部已做连接自愈（resetConnection），此处仅把错误翻译为友好文案。
      const raw = msgOf(e);
      const isAbort = e instanceof Error && (e.name === 'AbortError' || /abort/i.test(e.message));
      const isTimeout = /timeout|RequestTimeout/i.test(raw);
      let hint = '';
      if (isAbort) hint = '（用户已中断）';
      else if (isTimeout)
        hint =
          '（MCP 调用超时，疑似浏览器被关闭或页面卡死。已自动重置连接，请重新打开页面后重试，或输入 /exit 退出）';
      return { ok: false, output: `MCP 调用失败(${this.id}/${remoteName}): ${raw}${hint}` };
    }
  }

  async close(): Promise<void> {
    await this.conn.close();
  }
}

/** 把 MCP 返回的 content 块折叠成纯文本结果。 */
function contentToText(res: CallToolResult): string {
  const blocks = res.content ?? [];
  const text = blocks
    .map((b) => {
      if (b.type === 'text') return b.text;
      if (b.type === 'image') return `[image: ${b.mimeType ?? 'unknown'}]`;
      if (b.type === 'resource') return `[resource: ${b.resource?.uri ?? ''}]`;
      return '';
    })
    .join('\n')
    .trim();
  return text || '(空结果)';
}
