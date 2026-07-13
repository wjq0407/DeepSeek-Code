import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Tool, CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { isHttpConfig, type McpServerConfig } from './config.ts';

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
    this.client = new Client(
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
    await this.client.connect(transport);
    this.connected = true;
  }

  async listTools(): Promise<Tool[]> {
    await this.connect();
    const { tools } = await this.client.listTools();
    return tools;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    await this.connect();
    return (await this.client.callTool({ name, arguments: args })) as CallToolResult;
  }

  async close(): Promise<void> {
    if (!this.connected) return;
    try {
      await this.client.close();
    } catch {
      /* 忽略关闭时的异常 */
    }
    this.connected = false;
  }
}
