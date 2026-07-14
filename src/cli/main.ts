import { resolve } from 'node:path';
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
import { resolveCredentials, saveCredentials, loadStoredCredentials, maskKey, type Credentials } from './auth.ts';
import { runLogin } from './login.tsx';

async function main(): Promise<void> {
  // 项目根目录：全局命令可能在任意目录启动，但配置/凭证应锚定在项目根
  const projectRoot = resolve(import.meta.dirname ?? '.', '../../');
  const cwd = process.cwd();

  // ── 凭证解析 + 登录门禁 ──
  // --set-key / -k：强制重新输入（用于「下次登录替换 Key」）
  const forceSetKey = process.argv.includes('--set-key') || process.argv.includes('-k');
  let creds = await resolveCredentials(projectRoot, cwd);
  const firstRun = !creds;

  if (forceSetKey || !creds) {
    const entered = await runLogin(firstRun);
    if (!entered) {
      // 用户取消：首次必须给 Key，否则退出；更换时回退到已保存凭证
      if (firstRun) {
        console.error('已取消登录，无法启动（需要 API Key）。');
        process.exit(1);
      }
      creds = await loadStoredCredentials();
      if (!creds) {
        console.error('已取消，且无可用凭证。');
        process.exit(1);
      }
    } else {
      creds = entered;
      await saveCredentials(creds);
      console.log('[auth] 已保存 API Key 到 ~/.dsa/credentials.json');
    }
  } else {
    console.log(`[auth] 使用已保存的 API Key（${maskKey(creds.apiKey)}）`);
  }

  const cfg: Credentials & { baseURL: string; model: string } = {
    apiKey: creds.apiKey,
    baseURL: creds.baseURL || 'https://api.deepseek.com',
    model: creds.model || 'deepseek-v4-flash',
    reasonerModel: creds.reasonerModel,
  };
  // 版本号统一取自 package.json，避免 README / Banner / package.json 三处不一致
  const version = `v${(createRequire(import.meta.url)('../../package.json').version as string) ?? '0.1.0'}`;
  const client = new DeepSeekClient(cfg);

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
    runner: async (input: string, signal?: AbortSignal): Promise<string> => {
      const session = sessionManager.spawn(input, {
        client,
        tools: createTools(client),
        cwd,
        trace: new TraceLogger({ workspaceDir: cwd }),
        permission: 'execute',
        signal,
        ask: (question?: string) => Promise.resolve(!isDestructive(question ?? '')),
      });
      const done = await sessionManager.whenDone(session.id, signal);
      return done.output.slice(-2000); // 截断防污染主上下文
    },
  });
  // MCP 集成（Phase 1）：用 ToolProviderManager 聚合 本地 + MCP 工具。
  // 当前无 mcp.json 配置时仅返回本地 13 个工具，运行态仍是 14（13 + delegate），
  // Agent Loop 代码零改动。接真实 server 后工具数会自动扩展。
  const toolManager = new ToolProviderManager(client, projectRoot, cwd);
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
