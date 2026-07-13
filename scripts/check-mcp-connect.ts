/**
 * MCP 连接自检脚本（Phase 2 验证用）
 *
 * 作用：复用已实现的 ToolProviderManager 抽象层，真实拉起配置的 MCP server，
 * 把「本地工具 + MCP 工具」聚合后打印数量与名称，验证
 * 「loop.ts 零改动、工具来源从本地扩到远程」这条核心链路是否打通。
 *
 * 运行：
 *   export GITHUB_PAT=ghp_xxx      # Windows PowerShell: $env:GITHUB_PAT='ghp_xxx'
 *   npm run check:mcp
 *
 * 预期：GITHUB_PAT 设置且 docker 镜像已拉取时，MCP 工具数 > 0，
 *       名字形如 github__get_me / github__search_repositories ...
 *       合计 = 14（13 本地 + delegate）+ GitHub 工具数。
 * 若 MCP 工具数为 0：检查上方 [mcp] provider 失败警告（多为 token 未设或镜像未拉）。
 */
import { ToolProviderManager } from '../src/mcp/manager.ts';
import type { DeepSeekClient } from '../src/llm/deepseek.ts';

// 仅列举工具，不需要真实 LLM，用最小桩代替（任意方法都返回拒绝的 async）
const stubClient = new Proxy(
  {},
  { get: () => async () => { throw new Error('stub'); } },
) as unknown as DeepSeekClient;

const cwd = process.cwd();
const mgr = new ToolProviderManager(stubClient, cwd);

console.log('[1] 初始化 ToolProviderManager（读取 .dsa/mcp.json）...');
await mgr.init();

console.log(
  `[2] GITHUB_PAT 已设置: ${
    process.env.GITHUB_PAT ? `是 (长度 ${process.env.GITHUB_PAT.length})` : '否'
  }`,
);

console.log('[3] 聚合所有工具（本地 + MCP）...');
const all = await mgr.getAllTools();

const local = all.filter((t) => !t.name.includes('__'));
const mcp = all.filter((t) => t.name.includes('__'));

console.log('----------------------------------------');
console.log(`本地工具: ${local.length}`);
console.log(`MCP  工具: ${mcp.length}`);
console.log(`合计    : ${all.length}`);
console.log('----------------------------------------');

if (mcp.length > 0) {
  console.log('MCP 工具名（按 server 前缀）:');
  for (const t of mcp) console.log('  - ' + t.name);
  console.log('\n✅ Phase 2 连通成功：loop.ts 未改，工具数已自动扩展。');
} else {
  console.log('未检测到 MCP 工具。若已配置 server 但仍为 0：');
  console.log('  · 确认 GITHUB_PAT 已在环境变量中（export/set 后重开终端）');
  console.log('  · 确认 docker 镜像已拉取（docker pull ghcr.io/github/github-mcp-server）');
  console.log('  · 查看上方 [mcp] provider 失败警告获取具体原因。');
}

await mgr.closeAll();
