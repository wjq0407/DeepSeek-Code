import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Tool, CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { isHttpConfig, type McpServerConfig } from './config.ts';

/** Promise 超时包装：超过 ms 则 reject（带可辨识错误信息），避免 connect/listTools 永久挂起。 */
function withTimeout<T>(p: Promise<T>, ms: number, msg: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(msg)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

/**
 * 封装单个 MCP server 的连接与原始 RPC 调用。
 * 只负责「连上 / 列出工具 / 调用工具 / 断开」，不关心工具语义映射。
 * 传输方式由配置决定：stdio（本地子进程）或 http（远程 Streamable HTTP）。
 */
export class McpConnection {
  readonly id: string;
  private client: Client;
  private connected = false;

  constructor(id: string, private config: McpServerConfig) {
    this.id = id;
    this.client = McpConnection.createClient();
  }

  private static createClient(): Client {
    return new Client(
      { name: 'deepseek-code-agent', version: '0.1.0' },
      { capabilities: {} },
    );
  }

  /** 惰性连接：多次调用安全，只在首次真正建连。 */
  async connect(): Promise<void> {
    if (this.connected) return;
    const transport = isHttpConfig(this.config)
      ? new StreamableHTTPClientTransport(new URL(this.config.url), {
          requestInit: { headers: this.config.headers ?? {} },
        })
      : new StdioClientTransport({
          command: this.config.command,
          args: this.config.args ?? [],
          // 继承父进程环境（保证能找到 npx / node），再叠加 server 指定变量
          env: { ...process.env, ...(this.config.env ?? {}) } as Record<string, string>,
        });
    await withTimeout(
      this.client.connect(transport),
      30_000,
      `MCP 连接超时(${this.id})：server 可能未启动或在启动中挂起（请检查 Docker / 配置）`,
    );
    this.connected = true;
  }

  async listTools(): Promise<Tool[]> {
    await this.connect();
    const { tools } = await withTimeout(
      this.client.listTools(),
      30_000,
      `MCP 列举工具超时(${this.id})：server 已连但不响应 list_tools`,
    );
    return tools;
  }

  /**
   * 调用远端工具。
   * - signal：用户中断（Ctrl+C）时由 Agent Loop 透传，可即时中止底层请求。
   * - timeoutMs：硬性超时兜底。浏览器类 server（playwright）在网页被关闭后底层
   *   请求会挂起，若无超时则 Agent 主循环永久死锁。超时后抛错，由调用方兜底为
   *   工具失败（不死锁），并触发连接自愈（resetConnection）。
   */
  async callTool(
    name: string,
    args: Record<string, unknown>,
    options?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<CallToolResult> {
    try {
      await this.connect();
      const reqOptions: { signal?: AbortSignal; timeout?: number } = {};
      if (options?.signal) reqOptions.signal = options.signal;
      if (options?.timeoutMs !== undefined) reqOptions.timeout = options.timeoutMs;
      return (await this.client.callTool(
        { name, arguments: args },
        undefined,
        reqOptions,
      )) as CallToolResult;
    } catch (e) {
      // 自愈：任何失败（超时 / 中断 / 连接断开）都废弃旧连接，下次调用惰性重连。
      // 典型场景：playwright 浏览器被关闭 → 下次调用自动拉起新浏览器。
      await this.resetConnection();
      throw e;
    }
  }

  /** 废弃当前连接：关闭并重建一个全新 Client 实例，绕过 Protocol 的「已连接」守卫。 */
  private async resetConnection(): Promise<void> {
    try {
      await this.client.close();
    } catch {
      /* 已断开或从未连接，忽略 */
    }
    this.client = McpConnection.createClient();
    this.connected = false;
  }

  async close(): Promise<void> {
    if (this.connected) {
      try {
        await this.client.close();
      } catch {
        /* 忽略关闭时的异常 */
      }
    }
    // 始终重建实例，保证后续 connect 从干净状态开始（与 resetConnection 一致）
    this.client = McpConnection.createClient();
    this.connected = false;
  }
}
