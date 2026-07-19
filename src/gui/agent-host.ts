/**
 * AgentHost —— 网页后端的 ChatContext 实现（Node 侧）。
 *
 * 与 useAgentController（React/CLI）实现同一份 ChatContext 接口，但把 UI 副作用
 * 映射到「事件」：push/append/state 等变化通过 EventEmitter 广播，由 server.ts 转发给
 * 浏览器 WebSocket 客户端。内核（runAgent 循环）完全复用 chat.ts 的 runChatTurn，
 * 业务逻辑与 CLI 零重复。
 */
import { EventEmitter } from 'node:events';
import type { AppProps, UiMessage, MsgRole } from '../app/types.ts';
import type { PermissionMode } from '../agent/loop.ts';
import type { OutputStyle } from '../agent/output-style.ts';
import { runChatTurn, type ChatContext } from '../app/chat.ts';
import { proposeRevise, applyProposal, type ReviseProposal, type ReviseResult } from '../memory/revise.ts';
import { BrowserTelemetryHub } from './telemetry-hub.ts';
import type { BrowserTelemetryEvent } from './telemetry-types.ts';

export interface StatePayload {
  busy: boolean;
  mode: PermissionMode;
  planMode: boolean;
  outputStyle: OutputStyle;
  model: string;
  currentIteration: number;
  maxIterations: number;
  /** 浏览器观察回灌开关：开 → 每轮结束后等待浏览器反馈并自动续跑调试循环 */
  browserWatch: boolean;
}

/** 浏览器观察回灌：等待浏览器反馈的窗口（毫秒）。超时无报错 = 页面健康，正常结束。 */
const BROWSER_WATCH_TIMEOUT_MS = 8000;
/** 单次用户消息触发的自动续跑上限，防止浏览器持续报错导致失控循环。 */
const MAX_AUTO_CONTINUE = 8;

/** 思考盒里的一条「观察」条目（agent 本轮的思考过程） */
export interface ThinkingEntry {
  id: number;
  /** reason=推理文字；tool=工具调用；tool_result=工具返回结果；error=本轮错误 */
  kind: 'reason' | 'tool' | 'tool_result' | 'error';
  /** tool 条目的工具名 */
  title?: string;
  text: string;
  status: 'streaming' | 'done';
}

/** 思考盒状态：thinking=正在推理/调工具；outputting=正在输出最终答案；done=本轮结束 */
export type ThinkingStatus = 'thinking' | 'outputting' | 'done';

export class AgentHost extends EventEmitter {
  props: AppProps;
  cwd: string;
  private messages: UiMessage[] = [];
  private msgId = 0;
  private activeAbort: AbortController | null = null;
  private confirmResolver: ((b: boolean) => void) | null = null;
  private askTextResolver: ((t: string) => void) | null = null;
  private mode: PermissionMode;
  private planMode = false;
  private outputStyle: OutputStyle;
  private busy = false;
  /** 迭代轮次上限：0=无上限，正整数=上限。默认 0（无上限） */
  maxIterations = 0;
  /** 待执行用户输入队列（send 入队，pump 串行消费，避免自动续跑与输入交错） */
  private queue: string[] = [];
  /** pump 是否正在执行（重入保护） */
  private processing = false;
  /** 当前已完成的迭代计数（每次 startThinkingTurn 重置，每次 beginTool 递增） */
  currentIteration = 0;

  /** 浏览器遥测集线器（由 server 在 makeHost 时挂上）；null = 未装配 */
  telemetryHub: BrowserTelemetryHub | null = null;
  /** 浏览器观察回灌开关：开启后每轮结束等待浏览器反馈并自动续跑 */
  browserWatch = false;

  // ── 思考盒（思考过程）通道 ──
  /** 当前轮次的思考条目（仅用于服务端镜像，前端各自维护副本） */
  private thinking: ThinkingEntry[] = [];
  /** 思考条目 id 计数器（与消息 id 独立，避免冲突） */
  private thinkId = 100000;
  /** 当前正在追加文字的条目 id（reason/tool 通用） */
  private curThinkId: number | null = null;
  /** 当前是否处于「输出最终答案」阶段（true → 文字写入答案气泡，否则写入思考盒） */
  private inFinal = false;
  /** 当前最终答案气泡的 id（inFinal 时由首个 appendStreaming 惰性创建） */
  private finalBubbleId: number | null = null;
  /** 本轮是否因用户中断而结束（用于结束思考轮次时发出 interrupted 状态） */
  private lastTurnInterrupted = false;
  /** 当前思考轮次 id（用于把思考盒与答案气泡关联） */
  private curTurnId = 0;
  /** 是否已有进行中的思考轮次（防止 setBusy(true) 重复开轮） */
  private thinkingTurnActive = false;

  /** 最近一次 proposeRevise 的方案缓存：applyRevise 复用它，保证「预览即所见」。 */
  private lastReviseProposal: ReviseProposal | null = null;

  constructor(props: AppProps) {
    super();
    this.props = props;
    this.cwd = process.cwd();
    this.mode = props.cfg.reasonerModel ? 'ask' : 'execute';
    this.outputStyle = 'human';
  }

  private emitUpdate(id: number, text: string): void {
    this.emit('update', { id, text });
  }
  private emitState(): void {
    const s: StatePayload = {
      busy: this.busy,
      mode: this.mode,
      planMode: this.planMode,
      outputStyle: this.outputStyle,
      model: this.props.cfg.model ?? 'unknown',
      currentIteration: this.currentIteration,
      maxIterations: this.maxIterations,
      browserWatch: this.browserWatch,
    };
    this.emit('state', s);
  }

  // ── 思考盒辅助方法 ──
  /** 开新一轮思考：清空条目、分配轮次 id、广播 thinking_start */
  private startThinkingTurn(): void {
    this.thinking = [];
    this.curThinkId = null;
    this.inFinal = false;
    this.finalBubbleId = null;
    this.lastTurnInterrupted = false;
    this.currentIteration = 0;
    this.curTurnId += 1;
    this.thinkingTurnActive = true;
    this.emit('thinking_start', { turnId: this.curTurnId });
  }
  /** 结束当前思考轮次（busy=false 时调用） */
  private endThinkingTurn(): void {
    if (!this.thinkingTurnActive) return;
    this.thinkingTurnActive = false;
    this.curThinkId = null;
    // 用户中断时把状态标为 interrupted，让前端思考卡显示「生成中断」
    this.emit('thinking_status', { status: (this.lastTurnInterrupted ? 'interrupted' : 'done') as ThinkingStatus });
    this.emit('thinking_end', { turnId: this.curTurnId });
  }
  /** 新建一条思考条目并设为「当前追加目标」 */
  private newThinkEntry(kind: ThinkingEntry['kind'], title: string | undefined, text: string): number {
    const id = this.thinkId++;
    this.thinking.push({ id, kind, title, text, status: 'streaming' });
    this.curThinkId = id;
    this.emit('thinking_entry', { id, kind, title, text });
    return id;
  }
  /** 向「当前追加目标」追加文字。若没有追加目标、或追加目标不是 reason 条目，
   *  强制新开一条 reason 条目——避免把推理文字混进 tool / tool_result 里，
   *  保证思考过程每段语义独立、完整保留（不截断、不合并、不分段处理）。 */
  private appendThinking(text: string): void {
    const cur = this.curThinkId !== null ? this.thinking.find((x) => x.id === this.curThinkId) : undefined;
    if (cur && cur.kind === 'reason') {
      cur.text += text;
      this.emit('thinking_update', { id: cur.id, append: text });
      return;
    }
    // 没有追加目标、或追加目标不是 reason → 新开一条 reason 条目
    this.newThinkEntry('reason', undefined, text);
  }
  /** 关闭「当前追加目标」条目（标记为完成） */
  private closeCurThink(): void {
    if (this.curThinkId !== null) {
      const e = this.thinking.find((x) => x.id === this.curThinkId);
      if (e) e.status = 'done';
      this.curThinkId = null;
    }
  }
  /** 精简：工具输出/结果超长时截断，避免思考盒被大段文本淹没 */
  private truncate(s: string, n = 240): string {
    const t = s.trim();
    return t.length > n ? `${t.slice(0, n)}…` : t;
  }

  // ── ChatContext 实现 ──
  push = (role: MsgRole, text: string): number => {
    // 工具结果（tool 角色）不再作为独立气泡，而是归入「思考盒」作为一条观察
    // 完整保留原始文本，不做截断——用户希望看到工具的完整输出（命令、退出码、stdout/stderr）
    if (role === 'tool') {
      this.closeCurThink();
      this.newThinkEntry('tool_result', undefined, text);
      this.closeCurThink();
      return -1;
    }
    const id = this.msgId++;
    this.messages.push({ id, role, text });
    this.emit('message', { id, role, text });
    return id;
  };
  appendTo = (id: number, chunk: string): void => {
    const m = this.messages.find((x) => x.id === id);
    if (m) {
      m.text += chunk;
      this.emitUpdate(id, m.text);
    }
  };
  appendStreaming = (chunk: string, reactPhase?: 'thought' | 'action' | 'observation' | 'final' | 'progress'): void => {
    if (reactPhase === 'final' || this.inFinal) {
      // 最终答案阶段：文字写入「答案气泡」（惰性创建并绑定当前思考轮次 id）
      if (this.finalBubbleId === null) {
        this.finalBubbleId = this.msgId++;
        const m: UiMessage = { id: this.finalBubbleId, role: 'assistant', text: '', thinkingId: this.curTurnId };
        this.messages.push(m);
        this.emit('message', m);
      }
      this.appendTo(this.finalBubbleId, chunk);
    } else {
      // 过程叙述阶段：文字归入「思考盒」
      this.appendThinking(chunk);
    }
  };
  endStreaming = (phase?: 'progress' | 'final', interrupted?: boolean): void => {
    if (interrupted) this.lastTurnInterrupted = true;
    if (phase === 'final') {
      // 进入「输出最终答案」阶段：后续 appendStreaming 写入答案气泡
      this.inFinal = true;
      this.closeCurThink();
      this.emit('thinking_status', { status: 'outputting' as ThinkingStatus });
    } else if (phase === 'progress') {
      // 本轮过程叙述结束，回到思考态
      this.inFinal = false;
      this.closeCurThink();
    }
    // 无 phase（来自 done）：仅清场，不改变 inFinal/状态
    // 用户中断：把已生成的「最终答案气泡」标记为生成中断（保留半截内容）
    if (interrupted && this.finalBubbleId !== null) {
      const m = this.messages.find((x) => x.id === this.finalBubbleId);
      if (m) {
        m.interrupted = true;
        this.emitUpdate(this.finalBubbleId, m.text);
      }
      this.emit('gen_interrupted', { id: this.finalBubbleId });
    }
  };
  /** 直接答复回合：把当前思考轮次**全部** reason 条目按原始顺序晋升为最终答案气泡，
   *  保留完整的推理链条，不做任何压缩、精简或截断。由 loop 在 !gotToolUse 收尾时触发。 */
  prometeThinkingToFinal = (): void => {
    const reasonTexts: string[] = [];
    for (const e of this.thinking) {
      if (e.kind === 'reason' && e.text.trim()) reasonTexts.push(e.text.trim());
    }
    if (reasonTexts.length === 0) return;
    const fullText = reasonTexts.join('\n');
    // 思考盒保留（不清除、不 emit thinking_clear）
    if (this.finalBubbleId === null) this.finalBubbleId = this.msgId++;
    const existing = this.messages.find((x) => x.id === this.finalBubbleId);
    if (existing) {
      existing.text += (existing.text ? '\n' : '') + fullText;
      this.emitUpdate(existing.id, existing.text);
    } else {
      const m: UiMessage = { id: this.finalBubbleId, role: 'assistant', text: fullText, thinkingId: this.curTurnId };
      this.messages.push(m);
      this.emit('message', m);
    }
    this.inFinal = true;
  };

  beginTool = (toolName: string): void => {
    this.inFinal = false;
    this.closeCurThink();
    this.currentIteration++;
    // 工具调用：在思考盒开一条 tool 条目（同时保留 artifact 供右侧面板展示）
    this.curThinkId = this.newThinkEntry('tool', toolName, '');
    this.emit('artifact', {
      id: this.curThinkId,
      kind: 'tool',
      title: toolName,
      content: '',
    });
    this.emit('thinking_status', { status: 'thinking' as ThinkingStatus });
    this.emitState(); // 每次工具调用都更新迭代计数
  };
  appendTool = (out: string): void => {
    // 工具输出：追加到当前 tool 思考条目，完整保留原始文本，不做截断。
    if (this.curThinkId !== null) {
      const e = this.thinking.find((x) => x.id === this.curThinkId);
      if (e) {
        e.text += (e.text ? '\n' : '') + out;
        this.emit('thinking_update', { id: e.id, append: `\n${out}` });
      }
      this.emit('artifact_update', { id: this.curThinkId, append: out });
    }
  };
  endTool = (): void => {
    this.closeCurThink();
  };
  /**
   * 把本轮错误附加到思考盒中——不创建新气泡、不清除已记录的思考。
   * 保证错误与思考过程并存（不替代），所有中间步骤可追溯。
   */
  appendError = (msg: string): void => {
    this.closeCurThink();
    this.newThinkEntry('error', '错误', this.truncate(msg, 480));
    this.closeCurThink();
  };
  setBusy = (b: boolean): void => {
    if (b && !this.busy) {
      // 进入一轮新的 agent 工作：开启思考轮次
      this.startThinkingTurn();
      this.emit('thinking_status', { status: 'thinking' as ThinkingStatus });
    } else if (!b && this.busy) {
      this.endThinkingTurn();
    }
    this.busy = b;
    this.emitState();
  };
  setCost = (_cny: number): void => {
    /* 成本由核心以系统消息展示，无需单独广播 */
  };
  getState = () => ({ mode: this.mode, planMode: this.planMode, outputStyle: this.outputStyle });
  setMaxIterations = (n: number): void => {
    this.maxIterations = n;
    // 切到有限模式时重置迭代计数
    this.currentIteration = 0;
    this.emitState();
  };
  getIterations = (): number => this.currentIteration;
  setBrowserWatch = (b: boolean): void => {
    this.browserWatch = b;
    this.emitState();
  };
  getBrowserWatch = (): boolean => this.browserWatch;
  setMode = (m: PermissionMode): void => {
    this.mode = m;
    this.emitState();
  };
  setPlanMode = (b: boolean): void => {
    this.planMode = b;
    this.emitState();
  };
  setOutputStyle = (s: OutputStyle): void => {
    this.outputStyle = s;
    this.emitState();
  };
  setActiveAbort = (ac: AbortController | null): void => {
    this.activeAbort = ac;
  };
  abort = (): void => {
    this.activeAbort?.abort();
  };
  requestConfirm = (prompt: string): Promise<boolean> =>
    new Promise<boolean>((resolve) => {
      this.confirmResolver = resolve;
      this.emit('confirm', prompt);
    });
  resolveConfirm = (yes: boolean): void => {
    const r = this.confirmResolver;
    this.confirmResolver = null;
    r?.(yes);
  };
  requestAskText = (prompt: string): Promise<string> =>
    new Promise<string>((resolve) => {
      this.askTextResolver = resolve;
      this.emit('asktext', prompt);
    });
  resolveAskText = (text: string): void => {
    const r = this.askTextResolver;
    this.askTextResolver = null;
    r?.(text);
  };
  getMessages = (): UiMessage[] => this.messages;
  setMessages = (ms: UiMessage[]): void => {
    this.messages = ms;
    // 保证后续 push 的 id 不与会话恢复消息冲突
    this.msgId = ms.reduce((max, m) => Math.max(max, m.id + 1), 0);
    this.emit('reset', ms);
  };
  /** 静默回填消息数组，不发出 reset 事件（防止前端清空思考卡片） */
  setMessagesSilent = (ms: UiMessage[]): void => {
    this.messages = ms;
    this.msgId = ms.reduce((max, m) => Math.max(max, m.id + 1), 0);
  };
  requestKeyChange = (): void => {
    // 网页版：广播事件让前端打开「API 设置」浮层，用户可直接改 Key
    this.emit('keychange');
  };
  onExit = (): void => {
    this.emit('exit');
  };

  /** 跑一轮对话（内核逻辑全在 chat.ts）。改为队列 + 串行 pump，避免续跑与用户输入交错。 */
  send = (text: string): void => {
    this.queue.push(text);
    void this.pump();
  };

  /** 串行执行队列：每轮结束后若开了 browserWatch，等待浏览器反馈并自动续跑调试循环。 */
  private async pump(): Promise<void> {
    if (this.processing) return;
    this.processing = true;
    try {
      while (this.queue.length) {
        const t = this.queue.shift()!;
        await runChatTurn(t, this as unknown as ChatContext);
        await this.maybeContinueFromTelemetry();
      }
    } finally {
      this.processing = false;
    }
  }

  /**
   * 浏览器观察回灌：把浏览器端报错作为「新一轮观察数据」续跑调试循环。
   * - browserWatch 关：仅排空已缓冲的遥测（前端已实时展示），不自动续跑。
   * - browserWatch 开：等待浏览器反馈窗口（超时=页面健康）；收到报错则合成诊断提示，
   *   作为下一轮用户输入回灌，最多续跑 MAX_AUTO_CONTINUE 次防止失控。
   */
  private async maybeContinueFromTelemetry(): Promise<void> {
    if (!this.telemetryHub) return;
    if (!this.browserWatch) {
      // 非阻塞：仅清掉积压缓冲（前端已实时展示，这里不重复打扰）
      this.telemetryHub.drain();
      return;
    }
    let cont = 0;
    while (cont < MAX_AUTO_CONTINUE) {
      const events = await this.telemetryHub.waitForEvents(BROWSER_WATCH_TIMEOUT_MS);
      if (events.length === 0) break; // 超时无报错 → 页面健康，正常结束
      const prompt = this.synthesizePrompt(events);
      await runChatTurn(prompt, this as unknown as ChatContext);
      cont++;
    }
  }

  /** 把一批浏览器遥测渲染成给 AI 的诊断提示（作为新一轮观察数据回灌） */
  private synthesizePrompt(events: BrowserTelemetryEvent[]): string {
    const lines = events
      .slice(0, 15)
      .map((e) => {
        const loc = e.source ? ` (${e.source}${e.line ? ':' + e.line : ''})` : '';
        const tag = `[${e.kind}${e.level ? ':' + e.level : ''}]`;
        return `- ${tag} ${String(e.message ?? '').slice(0, 240)}${loc}`;
      })
      .join('\n');
    return (
      '[浏览器端诊断反馈] 你刚才的修改已反映在浏览器中，但页面运行时上报了以下错误/日志，' +
      '请据此诊断根因并修复；修复后请说明如何验证页面已恢复正常：\n' +
      lines
    );
  }

  /** 连接建立后由 server 调用：欢迎语 + 初始状态 */
  welcome(): void {
    const n = this.props.restoredSessions ?? 0;
    this.push('system', '网页版已连接，直接输入即可对话（输入 /help 查看命令）。');
    if (n > 0) this.push('system', `已恢复 ${n} 个历史会话。`);
    this.emitState();
  }

  /** 构造体检用的近期对话上下文（复用当前消息流，发现「用户已改变主意」）。 */
  private buildReviseContext(): string {
    return this.getMessages()
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .map((m) => (m.role === 'user' ? `[用户] ${m.text}` : `[助手] ${m.text}`))
      .filter((s) => s.trim())
      .join('\n')
      .slice(-3000);
  }

  /**
   * 网页端「整理记忆」第一步：跑模型体检，生成预览方案（**不执行**）。
   * 把方案缓存在 lastReviseProposal，供 applyRevise 复用，保证"所预览即所应用"。
   * 需要 API Key（要调用模型）。失败安全降级为 skipped。
   */
  async proposeRevise(): Promise<ReviseProposal> {
    try {
      const proposal = await proposeRevise(this.props.client, this.props.memoryStore, {
        recentContext: this.buildReviseContext(),
        force: true,
      });
      this.lastReviseProposal = proposal;
      return proposal;
    } catch {
      return { actions: [], summary: '', skipped: true, reason: '记忆体检失败（模型调用异常），已跳过' };
    }
  }

  /**
   * 网页端「整理记忆」第二步：应用用户确认过的方案（默认复用预览时缓存的方案）。
   * 无缓存时退化为重新 propose + apply。删除项会进回收站，故可撤销。
   */
  async applyRevise(): Promise<ReviseResult> {
    const proposal =
      this.lastReviseProposal ??
      (await proposeRevise(this.props.client, this.props.memoryStore, {
        recentContext: this.buildReviseContext(),
        force: true,
      }));
    this.lastReviseProposal = null;
    if (proposal.skipped) {
      return { deleted: 0, merged: 0, summary: '', skipped: true, reason: proposal.reason };
    }
    try {
      return applyProposal(this.props.memoryStore, proposal);
    } catch {
      return { deleted: 0, merged: 0, summary: '', skipped: true, reason: '记忆体检执行失败（写入异常），已跳过' };
    }
  }
}
