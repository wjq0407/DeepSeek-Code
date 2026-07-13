import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { homedir } from 'node:os';

/**
 * MCP 服务器配置 —— 格式对齐 WorkBuddy 的 `mcpServers` 约定。
 *
 * stdio 型（本地子进程，最常见）：
 *   { command: "npx", args: ["-y", "@modelcontextprotocol/server-github"], env?: {...} }
 * http 型（远程 Streamable HTTP）：
 *   { type: "http", url: "https://.../mcp/", headers?: { Authorization: "Bearer ${TOKEN}" } }
 *
 * 注意：env / headers 里的 `${VAR}` 会在加载时被进程环境变量展开，
 * 绝不把密钥硬编码进仓库。
 */

export interface StdioServerConfig {
  type?: 'stdio';
  command: string;
  args?: string[];
  /** 传给子进程的环境变量；值支持 ${ENV} 占位符 */
  env?: Record<string, string>;
}

export interface HttpServerConfig {
  type: 'http';
  url: string;
  headers?: Record<string, string>;
}

export type McpServerConfig = StdioServerConfig | HttpServerConfig;

export interface McpConfigFile {
  mcpServers: Record<string, McpServerConfig>;
}

/** 把字符串中的 ${VAR} 用进程环境变量展开；缺失则替换为空串并告警。 */
function expandEnv(input: string): string {
  return input.replace(/\$\{([A-Z0-9_]+)\}/gi, (_, name: string) => {
    const v = process.env[name];
    if (v === undefined) {
      // 占位符未提供时给空串，避免把字面 "${X}" 当值发给远端
      return '';
    }
    return v;
  });
}

function expandRecord(rec?: Record<string, string>): Record<string, string> | undefined {
  if (!rec) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(rec)) out[k] = expandEnv(v);
  return out;
}

/** 单个 server 配置内联展开（env/headers 里的占位符）。 */
function resolveConfig(cfg: McpServerConfig): McpServerConfig {
  if (cfg.type === 'http') {
    return { ...cfg, headers: expandRecord(cfg.headers) };
  }
  return { ...cfg, env: expandRecord(cfg.env) };
}

/**
 * 加载 MCP 配置：项目级 <cwd>/.dsa/mcp.json 优先，用户级 ~/.dsa/mcp.json 作兜底。
 * 两者都存在时按 server 名合并（项目覆盖同名项）。
 * 文件不存在时返回空配置（不抛错，Phase 1 无 server 时即走此路径）。
 */
export async function loadMcpConfig(cwd: string): Promise<McpConfigFile> {
  const projectPath = path.resolve(cwd, '.dsa', 'mcp.json');
  const globalPath = path.resolve(homedir(), '.dsa', 'mcp.json');

  const read = async (p: string): Promise<Record<string, McpServerConfig>> => {
    try {
      const txt = await readFile(p, 'utf8');
      const parsed = JSON.parse(txt) as Partial<McpConfigFile>;
      return parsed.mcpServers ?? {};
    } catch {
      return {};
    }
  };

  const globalServers = await read(globalPath);
  const projectServers = await read(projectPath);

  // 合并：全局打底，项目同名覆盖
  const merged: Record<string, McpServerConfig> = { ...globalServers, ...projectServers };
  const resolved: Record<string, McpServerConfig> = {};
  for (const [name, cfg] of Object.entries(merged)) {
    resolved[name] = resolveConfig(cfg);
  }
  return { mcpServers: resolved };
}

/** 判断单个配置是 stdio 还是 http（默认 stdio）。 */
export function isHttpConfig(cfg: McpServerConfig): cfg is HttpServerConfig {
  return cfg.type === 'http';
}
