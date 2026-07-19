/**
 * 内核装配（CLI 与 网页后端共用的「组装」逻辑）。
 *
 * 把原 main.ts 里「组装 AppProps」的全部代码抽到这里，由 main.ts（终端登录后）
 * 与 server.ts（无头启动）共同调用。这样内核只组装一次、定义一处，UI 形态随便换。
 */
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { DeepSeekClient } from '../llm/deepseek.ts';
import { ConversationHistory } from '../context/history.ts';
import { TraceLogger } from '../context/trace.ts';
import { SYSTEM_PROMPT } from '../agent/system-prompt.ts';
import type { ChatMessage } from '../llm/deepseek.ts';
import { Embedder } from '../memory/embedder.ts';
import { MemoryManager } from '../memory/manager.ts';
import { createDelegateTool } from '../agent/subagent.ts';
import { createTools, isDestructive } from '../tools/index.ts';
import { ToolProviderManager } from '../mcp/manager.ts';
import { SessionManager, type Session } from '../agent/session.ts';
import { SessionStore } from '../agent/session-store.ts';
import { SkillManager } from '../skills/loader.ts';
import { createUseSkillTool } from '../tools/use_skill.ts';
import type { Credentials } from './auth.ts';
import type { AppProps } from '../app/types.ts';

/** 全局信号清理函数集合（每个 assembleAppProps 注册一个），仅注册一次处理器避免监听器无限累积 */
const signalCleanups = new Set<() => void>();
let signalHandlerRegistered = false;
function registerSignalCleanup(fn: () => void): void {
  signalCleanups.add(fn);
  if (!signalHandlerRegistered) {
    signalHandlerRegistered = true;
    const handler = (): void => {
      for (const c of signalCleanups) {
        try {
          c();
        } catch {
          /* 忽略单个清理失败 */
        }
      }
    };
    process.on('SIGINT', handler);
    process.on('SIGTERM', handler);
  }
}

/**
 * 装配一份完整的 AppProps（内核全部服务已初始化，可直接交给任意 UI 层）。
 *
 * @param creds    DeepSeek 凭证
 * @param opts.dataDir  内核「用户数据」根目录（会话/历史/记忆/日志落盘处）。
 *                      - 不传 → 用 process.cwd()（CLI 终端行为，保持原样）。
 *                      - 网页版传每账号目录 ~/.dsa/users/<username>，实现「每账号独立」。
 *                      注意：技能目录(SkillManager)始终用 projectRoot（应用级能力，不随账号变）；
 *                      工具的「工作目录」与此 dataDir 一致（即每账号独立沙箱）。
 * @param opts.workspace  agent 真正「编辑/浏览」的代码项目目录（文件工具、git、delegate 子代理的工作根）。
 *                      - 不传 → 与 dataDir 一致（CLI 直接在该目录运行，二者本就相同）。
 *                      - 网页版传用户在设置里指定的「项目目录」，使 agent 操作的是用户自己的项目，
 *                        而非工具源码或每账号数据目录；会话/记忆/Trace 仍按 dataDir 隔离。
 */
export async function assembleAppProps(
  creds: Credentials,
  opts?: { dataDir?: string; workspace?: string },
): Promise<AppProps> {
  const projectRoot = resolve(import.meta.dirname ?? '.', '../../');
  const cwd = opts?.dataDir ?? process.cwd();
  const workspace = opts?.workspace ?? cwd;

  const cfg: Credentials & { baseURL: string; model: string } = {
    apiKey: creds.apiKey,
    baseURL: creds.baseURL || 'https://api.deepseek.com',
    model: creds.model || 'deepseek-v4-flash',
    reasonerModel: creds.reasonerModel,
  };
  const version = `v${(createRequire(import.meta.url)('../../package.json').version as string) ?? '0.1.0'}`;
  const client = new DeepSeekClient(cfg);

  const embedder = new Embedder();
  const memory = new MemoryManager(cwd, embedder);

  // 技能目录用应用根（projectRoot），不随账号 dataDir 变化——技能是应用级能力
  const skillManager = new SkillManager(projectRoot);
  await skillManager.init();

  const traceLogger = new TraceLogger({ workspaceDir: cwd });

  const recentTraces = await TraceLogger.recentSummary(cwd);
  const lastSessionMessages = await TraceLogger.replay(cwd);

  const query = lastUserQuery(lastSessionMessages ?? []);
  const systemPrompt =
    (await memory.compose(SYSTEM_PROMPT, query, 5)) +
    (skillManager.renderCatalog() ? '\n\n' + skillManager.renderCatalog() : '');

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

  const sessionStore = new SessionStore(cwd);
  sessionManager.attachStore(sessionStore);
  const restoredCount = await sessionManager.restore();

  const delegateTool = createDelegateTool({
    runner: async (input: string, signal?: AbortSignal): Promise<string> => {
      const session = sessionManager.spawn(input, {
        client,
        tools: createTools(client),
        cwd: workspace,
        trace: new TraceLogger({ workspaceDir: workspace }),
        permission: 'execute',
        signal,
        ask: (question?: string) => Promise.resolve(!isDestructive(question ?? '')),
      });
      const done = await sessionManager.whenDone(session.id, signal);
      return done.output.slice(-2000);
    },
  });

  const toolManager = new ToolProviderManager(client, projectRoot, workspace);
  await toolManager.init();
  const mcpTools = await toolManager.getAllTools();
  const tools = [...mcpTools, delegateTool, createUseSkillTool(skillManager)];

  const cleanup = () => {
    void toolManager.closeAll();
  };
  registerSignalCleanup(cleanup);

  return {
    client,
    history,
    tools,
    cfg,
    traceLogger,
    recentTraces,
    sessionManager,
    restoredSessions: restoredCount,
    memoryStore: memory,
    version,
    skillManager,
  };
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
