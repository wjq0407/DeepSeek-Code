import type { ToolDef } from '../tools/index.ts';
import type { DeepSeekClient } from '../llm/deepseek.ts';
import { loadMcpConfig } from './config.ts';
import { LocalToolProvider, McpToolProvider, type ToolProvider } from './provider.ts';

/**
 * 工具来源聚合器：把「本地 13 工具」与「N 个 MCP server 工具」统一聚合成一批 ToolDef[]。
 *
 * 关键卖点：Agent Loop（loop.ts）只接收 ToolDef[]，对工具来源完全无感 ——
 * 接不接 MCP、接几个，loop.ts 一行都不用改（循环不变式实战验证）。
 *
 * 无 MCP 配置时（Phase 1 默认），getAllTools() 仅返回本地 13 个工具，行为与原版完全一致。
 */
export class ToolProviderManager {
  private providers: ToolProvider[] = [];

  constructor(
    private client: DeepSeekClient,
    private projectRoot: string,
    private cwd: string,
  ) {}

  /** 初始化：固定加入本地 provider；按配置为每个 server 建一个 McpToolProvider。 */
  async init(): Promise<void> {
    this.providers = [new LocalToolProvider(this.client)];
    const cfg = await loadMcpConfig(this.projectRoot, this.cwd);
    for (const [id, serverCfg] of Object.entries(cfg.mcpServers)) {
      this.providers.push(new McpToolProvider(id, serverCfg));
    }
  }

  /** 聚合所有 provider 的工具。任一 provider 失败都被隔离，不影响其余。 */
  async getAllTools(): Promise<ToolDef[]> {
    const lists = await Promise.all(
      this.providers.map((p) =>
        p.listTools().catch((e: unknown) => {
          console.warn(`[mcp] provider ${p.id} 列举工具失败: ${String(e)}`);
          return [] as ToolDef[];
        }),
      ),
    );
    return lists.flat();
  }

  /** 退出时关闭所有 MCP 连接（本地 provider 无操作）。 */
  async closeAll(): Promise<void> {
    await Promise.all(this.providers.map((p) => p.close().catch(() => {})));
  }
}
