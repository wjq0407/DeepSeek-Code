/**
 * 本地 HTTP MCP 测试服务器（Phase 3 验证用）。
 *
 * 作用：用官方 SDK 的 server 端起一个 Streamable HTTP server，暴露两个只读工具
 * （echo / add），供 `scripts/check-mcp-http.ts` 验证我们项目的
 * StreamableHTTPClientTransport + McpToolProvider 在 HTTP 下能正确 list + call。
 *
 * 设计要点：
 *  - 进程内启动、用完即关，不依赖任何外部网络/鉴权，确定性可重复。
 *  - 无状态模式（sessionIdGenerator: undefined）+ 直接 JSON 响应（enableJsonResponse）。
 *  - ⚠️ Stateless 模式下，SDK 要求「每个 HTTP 请求必须用全新的 transport 实例」
 *    （WebStandardStreamableHTTPServerTransport 有 _hasHandledRequest 守卫，复用会 500）。
 *    因此这里每个请求都 new 一个 transport，并配一个全新的 McpServer（connect 不允许重复）。
 */
import http from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

export interface EchoServerHandle {
  url: string;
  close: () => Promise<void>;
}

/** 每请求构建一个全新的 McpServer 并注册工具（stateless 模式 connect 不可复用）。 */
function buildServer(): McpServer {
  const server = new McpServer(
    { name: 'echo-http-test', version: '0.0.0' },
    { capabilities: {} },
  );
  server.registerTool(
    'echo',
    {
      title: 'Echo',
      description: '回显输入文本（只读）',
      inputSchema: { text: z.string() },
      annotations: { readOnlyHint: true },
    },
    async ({ text }) => ({ content: [{ type: 'text', text: String(text) }] }),
  );
  server.registerTool(
    'add',
    {
      title: 'Add',
      description: '返回两个整数之和（只读）',
      inputSchema: { a: z.number(), b: z.number() },
      annotations: { readOnlyHint: true },
    },
    async ({ a, b }) => ({ content: [{ type: 'text', text: String(a + b) }] }),
  );
  return server;
}

export async function startEchoServer(): Promise<EchoServerHandle> {
  const httpServer = http.createServer((req, res) => {
    // 每个请求：全新 transport + 全新 server（stateless 不可复用）
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    transport.onerror = (e) => console.error('[echo-server] transport.onerror:', e);
    const server = buildServer();

    server
      .connect(transport)
      .then(() => transport.handleRequest(req, res))
      .catch((err: unknown) => {
        console.error('[echo-server] request error:', err);
        if (!res.headersSent) {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: String(err) }));
        }
      });

    // 请求结束（无论成功失败）释放该请求独占的 transport/server
    res.on('close', () => {
      transport.close().catch(() => {});
      server.close().catch(() => {});
    });
  });

  await new Promise<void>((resolve) => {
    httpServer.listen(0, '127.0.0.1', () => resolve());
  });
  const addr = httpServer.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  const url = `http://127.0.0.1:${port}/mcp`;

  return {
    url,
    close: async () => {
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
}
