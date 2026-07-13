import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { createRequire } from 'node:module';
import { DeepSeekClient } from '../llm/deepseek.ts';
import { ConversationHistory } from '../context/history.ts';
import { TraceLogger } from '../context/trace.ts';
import { SYSTEM_PROMPT } from '../agent/system-prompt.ts';
import type { ChatMessage } from '../llm/deepseek.ts';
import { Embedder } from '../memory/embedder.ts';
import { MemoryManager } from '../memory/manager.ts';
import { createDelegateTool, SUBAGENT_SYSTEM } from '../agent/subagent.ts';
import { createTools, isDestructive } from '../tools/index.ts';
import { ToolProviderManager } from '../mcp/manager.ts';
import { SessionManager, type Session } from '../agent/session.ts';
import { SessionStore } from '../agent/session-store.ts';
import { startApp } from './app.tsx';

function loadEnv(): { apiKey: string; baseURL: string; model: string; reasonerModel?: string } {
  const candidates = [
    resolve(process.cwd(), '.env'),
    resolve(import.meta.dirname ?? '.', '../../.env'),
    resolve(os.homedir(), '.dsa', '.env'),
  ];
  for (const c of candidates) {
    try {
      const txt = readFileSync(c, 'utf8');
      const kv: Record<string, string> = {};
      for (const line of txt.split('\n')) {
        const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
        if (m) kv[m[1]] = m[2].replace(/^["']|["']$/g, '');
      }
      if (kv.DEEPSEEK_API_KEY)
        return {
          apiKey: kv.DEEPSEEK_API_KEY,
          baseURL: kv.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
          model: kv.MODEL_ID || 'deepseek-v4-flash',
          reasonerModel: kv.REASONER_MODEL_ID || undefined,
        };
    } catch {
      /* 尝试下一个候选 */
    }
  }
  throw new Error('未找到 DEEPSEEK_API_KEY，请在项目根目录或 ~/.dsa/.env 放置 .env');
}

async function main(): Promise<void> {
  const cfg = loadEnv();
  // 版本号统一取自 package.json，避免 README / Banner / package.json 三处不一致
  const version = `v${(createRequire(import.meta.url)('../package.json').version as string) ?? '0.1.0'}`;
  const client = new DeepSeekClient(cfg);
  const cwd = process.cwd();

  // 记忆层：嵌入器 + 双层记忆（用户级全局 ~/.dsa/memory + 项目级 <cwd>/.dsa/memory）
  const embedder = new Embedder(); // 本地 BGE 模型，离线免 key；无模型时自动降级关键词
  const memory = new MemoryManager(cwd, embedder);

  // 重建 trace logger（使用正确的 cwd）
  const traceLogger = new TraceLogger({ workspaceDir: cwd });

  // 会话恢复信息（提前计算：既用于 /resume，也作为启动语义预取的 query）
  const recentTraces = await TraceLogger.recentSummary(cwd);
  const lastSessionMessages = await TraceLogger.replay(cwd);

  // 记忆注入：用户级 + 项目级常驻事实 + 启动语义预取（用上次会话上下文作 query）
  const query = lastUserQuery(lastSessionMessages ?? []);
  const systemPrompt = await memory.compose(SYSTEM_PROMPT, query, 5);

  const history = new ConversationHistory(systemPrompt, { client });

  const mainSession: Session = {
    id: 'main',
    title: 'main',
    kind: 'main',
    status: 'working',
    history,
    output: '',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  const sessionManager = new SessionManager(mainSession);

  // P5: 会话持久化层 — 启动即从磁盘恢复历史 child 会话（跨进程保留）
  const sessionStore = new SessionStore(cwd);
  sessionManager.attachStore(sessionStore);
  const restoredCount = await sessionManager.restore();

  // P4: 子 Agent 委派框架 — 桥接进会话面板（派发的子任务作为后台会话可见、可恢复）
  // 子 Agent 无人值守自动放行，但保留安全底线：破坏性命令（rm -rf /、git push --force 等）
  // 不被自动批准，ask 返回 false 让 loop 升级为人工确认，避免子 Agent 误执行不可逆操作。
  const delegateTool = createDelegateTool({
    runner: async (input: string): Promise<string> => {
      const session = sessionManager.spawn(input, {
        client,
        tools: createTools(client),
        cwd,
        trace: new TraceLogger({ workspaceDir: cwd }),
        permission: 'execute',
        ask: (question?: string) => Promise.resolve(!isDestructive(question ?? '')),
      });
      const done = await sessionManager.whenDone(session.id);
      return done.output.slice(-2000); // 截断防污染主上下文
    },
  });
  // MCP 集成（Phase 1）：用 ToolProviderManager 聚合 本地 + MCP 工具。
  // 当前无 mcp.json 配置时仅返回本地 13 个工具，运行态仍是 14（13 + delegate），
  // Agent Loop 代码零改动。接真实 server 后工具数会自动扩展。
  const toolManager = new ToolProviderManager(client, cwd);
  await toolManager.init();
  const mcpTools = await toolManager.getAllTools();
  const tools = [...mcpTools, delegateTool];

  // 退出时清理 MCP 连接（无 server 时为空操作；不抢占 ink 自身的退出处理）
  const cleanup = () => {
    void toolManager.closeAll();
  };
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  await startApp({
    client,
    history,
    tools,
    cfg,
    traceLogger,
    initialResume: lastSessionMessages,
    recentTraces,
    sessionManager,
    restoredSessions: restoredCount,
    memoryStore: memory,
    version,
  });
}

/** 取最近一条用户消息，作为启动语义预取的 query（无则返回空串）。 */
function lastUserQuery(messages: ReadonlyArray<ChatMessage>): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === 'user' && typeof m.content === 'string' && m.content.trim()) {
      return m.content.trim();
    }
  }
  return '';
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
