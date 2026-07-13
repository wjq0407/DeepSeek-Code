import type { DeepSeekClient } from '../llm/deepseek.ts';
import { ConversationHistory } from '../context/history.ts';
import { runAgent, type AgentEvent, type PermissionMode, type RunOptions } from './loop.ts';
import type { TraceLogger } from '../context/trace.ts';
import { SUBAGENT_SYSTEM } from './subagent.ts';
import type { ToolDef } from '../tools/index.ts';
import { SessionStore, type SessionRecord } from './session-store.ts';

/**
 * 多会话 / Agents 面板底层框架（P1：会话模型 + 非阻塞后台 runner）。
 *
 * 对标 Claude Code 的 Sessions 视图：每个会话拥有独立 ConversationHistory（上下文隔离），
 * 由 `runBackground` 以**非阻塞**方式驱动 runAgent 事件流，主聊天界面不卡死。
 * UI 面板（← 切换、↑↓ 选择、space 回复、ctrl+x 删除）留待后续阶段。
 *
 * 为避免与 delegate 工具循环依赖，本模块只定义模型与 runner，不反向 import app/cli。
 * 真实注入的 runner 默认是 runAgent；测试时可注入假 generator。
 */

export type SessionStatus = 'working' | 'needs_input' | 'completed' | 'error';

export interface Session {
  id: string;
  title: string;
  kind: 'main' | 'child';
  status: SessionStatus;
  history: ConversationHistory;
  output: string;
  pendingAsk?: { prompt: string; resolve: (b: boolean) => void };
  createdAt: number;
  updatedAt: number;
}

export interface SpawnOptions {
  client: DeepSeekClient;
  tools: ToolDef[];
  cwd: string;
  trace?: TraceLogger;
  permission?: PermissionMode;
  systemPrompt?: string;
  /** 测试注入点：返回事件生成器。默认用真实 runAgent。 */
  runner?: (input: string, runOpts: RunOptions) => AsyncGenerator<AgentEvent>;
  /** 可选：覆盖子会话的权限确认回调。不传则用「暂停并等待面板回复」机制；子 Agent 委派传 () => Promise.resolve(true) 以无人值守运行。 */
  ask?: (prompt: string) => Promise<boolean>;
}

type Listener = () => void;

export class SessionManager {
  sessions = new Map<string, Session>();
  activeId = '';
  view: 'chat' | 'panel' = 'chat';

  private listeners = new Set<Listener>();
  private optsOf = new Map<string, SpawnOptions>();

  // P5: 持久化层（可选；未 attach 时完全无副作用，保持内存态兼容）
  private store?: SessionStore;
  private persistTimer?: ReturnType<typeof setTimeout>;

  constructor(mainSession: Session) {
    this.sessions.set(mainSession.id, mainSession);
    this.activeId = mainSession.id;
  }

  /** React/ink 订阅：状态变化即触发重渲染 */
  subscribe(cb: Listener): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /**
   * P5: 绑定持久化层。绑定后任意状态变化都会节流落盘。
   */
  attachStore(store: SessionStore): void {
    this.store = store;
  }

  /**
   * 持久化当前所有 child 会话到磁盘（main 由 TraceLogger.replay 负责，此处跳过）。
   * 写失败由 SessionStore 内部静默忽略。
   */
  async persist(): Promise<void> {
    if (!this.store) return;
    for (const s of this.sessions.values()) {
      if (s.kind !== 'child') continue;
      const rec: SessionRecord = {
        id: s.id,
        title: s.title,
        kind: s.kind,
        status: s.status,
        systemPrompt: s.history.systemPromptText,
        messages: s.history.getMessages().filter((m) => m.role !== 'system'),
        output: s.output,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
        archived: false,
      };
      await this.store.save(rec);
    }
  }

  /** 节流落盘：高频 notify 合并为 600ms 一次写盘 */
  private schedulePersist(): void {
    if (!this.store) return;
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => {
      this.persistTimer = undefined;
      void this.persist();
    }, 600);
  }

  /**
   * P5: 启动时从磁盘恢复历史 child 会话。返回恢复的会话数量。
   * 恢复的会话标记为 archived，状态强制为终态（历史会话不可能是 needs_input）。
   */
  async restore(): Promise<number> {
    if (!this.store) return 0;
    const recs = await this.store.loadAll();
    let n = 0;
    for (const rec of recs) {
      if (rec.kind !== 'child') continue;
      if (this.sessions.has(rec.id)) continue;
      const history = new ConversationHistory(rec.systemPrompt);
      history.loadMessages(rec.messages);
      const session: Session = {
        id: rec.id,
        title: rec.title,
        kind: 'child',
        status: rec.status === 'needs_input' ? 'completed' : rec.status,
        history,
        output: rec.output,
        createdAt: rec.createdAt,
        updatedAt: rec.updatedAt,
      };
      this.sessions.set(rec.id, session);
      n++;
    }
    if (n > 0) this.notify();
    return n;
  }

  /** 退出前立即落盘：清掉节流定时器并同步（await）写盘 */
  async flush(): Promise<void> {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = undefined;
    }
    await this.persist();
  }

  private notify(): void {
    for (const l of this.listeners) l();
    this.schedulePersist();
  }

  /** 派生当前三分组（Needs input / Working / Completed/Error），供后续 UI 使用 */
  groups(): {
    needsInput: Session[];
    working: Session[];
    completed: Session[];
  } {
    const needsInput: Session[] = [];
    const working: Session[] = [];
    const completed: Session[] = [];
    for (const s of this.sessions.values()) {
      if (s.kind === 'main') continue;
      if (s.status === 'needs_input') needsInput.push(s);
      else if (s.status === 'working') working.push(s);
      else completed.push(s);
    }
    return { needsInput, working, completed };
  }

  /** 派生一个子会话并启动后台运行（立即返回，不阻塞调用方） */
  spawn(task: string, opts: SpawnOptions): Session {
    const id = `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const history = new ConversationHistory(opts.systemPrompt ?? SUBAGENT_SYSTEM);
    const session: Session = {
      id,
      title: task.slice(0, 24) || '(空任务)',
      kind: 'child',
      status: 'working',
      history,
      output: '',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.sessions.set(id, session);
    this.optsOf.set(id, opts);
    this.runBackground(session, task, opts);
    this.notify();
    return session;
  }

  /** 非阻塞 runner：消费 runAgent 事件流，更新会话状态并通知订阅者 */
  private runBackground(session: Session, input: string, opts: SpawnOptions): void {
    const runner = opts.runner ?? defaultRunner;
    // 权限确认回调：默认「暂停并等待面板回复」；传入 opts.ask 时（如子 Agent 委派）直接采用
    const ask =
      opts.ask ??
      ((prompt: string) =>
        new Promise<boolean>((resolve) => {
          session.status = 'needs_input';
          session.pendingAsk = { prompt, resolve };
          session.updatedAt = Date.now();
          this.notify();
        }));
    const runOpts: RunOptions = {
      client: opts.client,
      history: session.history,
      permission: opts.permission ?? 'execute',
      tools: opts.tools,
      cwd: opts.cwd,
      trace: opts.trace,
      ask,
    };

    void (async () => {
      try {
        session.status = 'working';
        session.updatedAt = Date.now();
        this.notify();
        for await (const ev of runner(input, runOpts)) {
          if (ev.type === 'assistant_text') session.output += ev.text ?? '';
          else if (ev.type === 'error') session.status = 'error';
          session.updatedAt = Date.now();
          this.notify();
        }
        // 正常走完且没在等输入 -> 完成（ask 跨异步边界，TS 无法收窄，故转 string 比较）
        if ((session.status as string) !== 'needs_input') session.status = 'completed';
        // 会话结束立即落盘（不依赖节流），保证重启后可见
        await this.persist();
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        session.output += `\n[error] ${msg}`;
        session.status = 'error';
      }
      session.updatedAt = Date.now();
      this.notify();
    })();
  }

  /** 回复一个等待输入的会话：释放 ask 挂起的 Promise，原生成器继续跑 */
  resume(id: string): void {
    const s = this.sessions.get(id);
    if (!s || !s.pendingAsk) return;
    const ask = s.pendingAsk;
    s.pendingAsk = undefined;
    s.status = 'working';
    s.updatedAt = Date.now();
    ask.resolve(true);
    this.notify();
  }

  /** 删除一个子会话（主会话不可删） */
  remove(id: string): void {
    const s = this.sessions.get(id);
    if (!s || s.kind === 'main') return;
    // 若正在等输入，先拒绝以免挂死生成器
    if (s.pendingAsk) s.pendingAsk.resolve(false);
    this.sessions.delete(id);
    this.optsOf.delete(id);
    if (this.store) void this.store.remove(id);
    this.notify();
  }

  /**
   * P1-③ Fork 分叉：克隆父会话的完整对话历史到一个全新的子会话，用于 A/B 探索。
   * 新会话复用父会话的运行参数（client/tools/cwd/permission…），初始状态 `completed`，
   * 等待用户给出「分支续写指令」后由 `continueSession` 驱动。
   * 返回新会话；父不存在时返回 null。
   */
  fork(parentId: string): Session | null {
    const parent = this.sessions.get(parentId);
    if (!parent) return null;
    const id = `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const history = new ConversationHistory(parent.history.systemPromptText);
    // 深拷贝父会话消息（跳过 system，由新 history 自带），保留工具调用链以便续写
    history.loadMessages(parent.history.getMessages().filter((m) => m.role !== 'system'));
    const session: Session = {
      id,
      title: `↳ ${parent.title}`.slice(0, 24),
      kind: 'child',
      status: 'completed', // 等待分支续写指令
      history,
      output: parent.output,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.sessions.set(id, session);
    const popts = this.optsOf.get(parentId);
    if (popts) this.optsOf.set(id, { ...popts });
    this.notify();
    return session;
  }

  /**
   * P1-③ 继续一个已存在的子会话（用于 fork 分支的续写）。
   * 复用其历史与运行参数，以 `task` 作为新一轮用户输入非阻塞驱动 runAgent。
   */
  continueSession(id: string, task: string): void {
    const s = this.sessions.get(id);
    const opts = this.optsOf.get(id);
    if (!s || !opts) return;
    s.status = 'working';
    s.updatedAt = Date.now();
    this.notify();
    this.runBackground(s, task, opts);
  }

  /** 等待某个子会话跑完（completed/error），返回最终 Session。供 delegate 桥接等需同步等待场景使用 */
  whenDone(id: string): Promise<Session> {
    const s = this.sessions.get(id);
    if (!s) return Promise.reject(new Error(`session not found: ${id}`));
    if (s.status === 'completed' || s.status === 'error') return Promise.resolve(s);
    return new Promise<Session>((resolve) => {
      const unsub = this.subscribe(() => {
        const cur = this.sessions.get(id);
        if (!cur || cur.status === 'completed' || cur.status === 'error') {
          unsub();
          resolve(cur ?? s);
        }
      });
    });
  }
}

/** 默认 runner：真实 runAgent（生产环境） */
async function* defaultRunner(
  input: string,
  runOpts: RunOptions,
): AsyncGenerator<AgentEvent> {
  yield* runAgent(input, runOpts);
}
