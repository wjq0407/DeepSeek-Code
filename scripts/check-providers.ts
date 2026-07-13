/**
 * Phase 1 回归验证：在「无 MCP 配置」下，ToolProviderManager.getAllTools()
 * 必须恰好返回 13 个本地工具，且名字集合与原版 createTools() 完全一致。
 *
 * 运行：npm run check:providers  （或直接 npx tsx scripts/check-providers.ts）
 * 不依赖任何 API key / 网络。
 */
import path from 'node:path';
import os from 'node:os';
import { ToolProviderManager } from '../src/mcp/manager.ts';
import { createTools } from '../src/tools/index.ts';
import type { DeepSeekClient } from '../src/llm/deepseek.ts';

const EXPECTED = [
  'read_file',
  'create_file',
  'edit_file',
  'delete_file',
  'run_command',
  'search_code',
  'git_status',
  'git_diff',
  'git_commit_msg',
  'review_code',
  'audit_dependencies',
  'terminology',
  'project_discover',
];

async function main(): Promise<void> {
  // 用一个不存在的临时目录作 cwd，确保不会读到真实的 mcp.json
  const cwd = path.resolve(os.tmpdir(), 'dsa-regression-noop');
  const stubClient = {} as unknown as DeepSeekClient;

  const mgr = new ToolProviderManager(stubClient, cwd);
  await mgr.init();
  const tools = await mgr.getAllTools();
  await mgr.closeAll();

  const names = tools.map((t) => t.name).sort();
  const expectedSorted = [...EXPECTED].sort();

  let failed = false;
  const fail = (msg: string) => {
    failed = true;
    console.error('  ✗ ' + msg);
  };
  const ok = (msg: string) => console.log('  ✓ ' + msg);

  // 1. 数量
  if (tools.length === EXPECTED.length) ok(`工具数量 = ${tools.length}（符合预期）`);
  else fail(`工具数量 = ${tools.length}，预期 ${EXPECTED.length}`);

  // 2. 名字集合一致
  const sameSet =
    names.length === expectedSorted.length && names.every((n, i) => n === expectedSorted[i]);
  if (sameSet) ok(`名字集合与 createTools() 完全一致：${names.join(', ')}`);
  else fail(`名字集合不一致\n    实际: ${names.join(', ')}\n    预期: ${expectedSorted.join(', ')}`);

  // 3. 无 MCP 前缀（说明没有误加载远程 server）
  if (names.some((n) => n.includes('__'))) fail('出现了 MCP 前缀命名，说明误加载了 server');
  else ok('无 MCP 前缀命名');

  // 4. 无重名
  const dup = names.filter((n, i) => names.indexOf(n) !== i);
  if (dup.length === 0) ok('无重名工具');
  else fail(`存在重名：${dup.join(', ')}`);

  // 5. 交叉验证：直接调 createTools 也必须一致
  const direct = createTools(stubClient).map((t) => t.name).sort();
  if (JSON.stringify(direct) === JSON.stringify(expectedSorted)) ok('与 createTools() 直出结果一致（抽象层未改变本地工具）');
  else fail('与 createTools() 直出结果不一致');

  console.log('');
  if (failed) {
    console.error('❌ 回归验证失败');
    process.exit(1);
  }
  console.log('✅ Phase 1 回归验证通过：ToolProviderManager 在无 MCP 配置下行为与原版一致');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
