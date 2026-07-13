/**
 * Phase 3 验证：本地 HTTP MCP server 端到端连通。
 *
 * 启动一个本地 Streamable HTTP server（`mcp-http-echo-server.ts`），再走我们项目自己的
 * McpToolProvider（HTTP 分支）完成 tools/list + tools/call，证明：
 *   1. client.ts 的 StreamableHTTPClientTransport 分支能正常建连/列举/调用；
 *   2. 同一套 ToolProvider 抽象对 stdio / http 完全透明（loop.ts 仍零改动）；
 *   3. MCP tool 的 readOnlyHint 注解被映射成 risk='low'。
 *
 * 运行：npm run check:mcp:http
 */
import type { DeepSeekClient } from '../src/llm/deepseek.ts';
import { McpToolProvider } from '../src/mcp/provider.ts';
import type { HttpServerConfig } from '../src/mcp/config.ts';
import { startEchoServer } from './mcp-http-echo-server.ts';

// 列举工具不需要真实 LLM，用最小桩
const stubClient = new Proxy(
  {},
  { get: () => async () => { throw new Error('stub'); } },
) as unknown as DeepSeekClient;

const server = await startEchoServer();
console.log(`[1] 本地 HTTP MCP server 已启动: ${server.url}`);

const config: HttpServerConfig = { type: 'http', url: server.url, headers: {} };
const provider = new McpToolProvider('echo', config);

console.log('[2] 经 StreamableHTTPClientTransport 拉取 tools/list...');
const tools = await provider.listTools();

console.log('----------------------------------------');
console.log(`HTTP MCP 工具数: ${tools.length}`);
for (const t of tools) console.log(`  - ${t.name} [risk=${t.risk}]`);
console.log('----------------------------------------');

let ok = true;
const names = new Set(tools.map((t) => t.name));
if (!names.has('echo__echo') || !names.has('echo__add')) {
  console.error('❌ 未找到预期工具 echo__echo / echo__add');
  ok = false;
}

// 验证 tools/call 往返 + 只读注解 → risk=low 映射
const echoTool = tools.find((t) => t.name === 'echo__echo');
if (echoTool) {
  const res = await echoTool.execute({ text: 'hello over http' });
  console.log(`[3] 调用 echo__echo('hello over http') => ok=${res.ok}`);
  console.log(`    输出: ${res.output}`);
  if (!res.ok || !res.output.includes('hello over http')) {
    console.error('❌ echo 往返失败');
    ok = false;
  }
  if (echoTool.risk !== 'low') {
    console.error(`❌ readOnlyHint 未映射为 low（实际 ${echoTool.risk}）`);
    ok = false;
  }
}

const addTool = tools.find((t) => t.name === 'echo__add');
if (addTool) {
  const res = await addTool.execute({ a: 2, b: 3 });
  console.log(`[4] 调用 echo__add(2,3) => ${res.output}`);
  if (!res.ok || !res.output.includes('5')) {
    console.error('❌ add 往返失败');
    ok = false;
  }
}

await provider.close();
await server.close();

if (ok) {
  console.log('\n✅ Phase 3 验证成功：同一套 McpToolProvider 经 StreamableHTTP 透明工作。');
  process.exit(0);
} else {
  console.error('\n❌ Phase 3 验证存在失败项。');
  process.exit(1);
}
