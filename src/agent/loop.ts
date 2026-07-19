import { DeepSeekClient, ChatMessage, ToolCall, StreamErrorCategory } from '../llm/deepseek.ts';
import { errMsg } from '../llm/deepseek.ts';
import { ToolDef, ToolResult, isDestructive, createTools } from '../tools/index.ts';
import { runTaskFidelity } from '../tools/verify-task.ts';
import { ConversationHistory } from '../context/history.ts';
import { TraceLogger, type TraceEventType } from '../context/trace.ts';
import { logger } from '../utils/logger.ts';
import { type OutputStyle, styleInstruction } from './output-style.ts';
import { regexExtractJSON } from '../tools/structured-parse.ts';
import { z } from 'zod';

export type PermissionMode = 'explore' | 'ask' | 'execute';

export interface AgentEvent {
  type: 'assistant_text' | 'assistant_phase' | 'assistant_promote' | 'tool_call' | 'tool_result' | 'tool_stream' | 'permission' | 'error' | 'done' | 'system';
  text?: string;
  toolName?: string;
  args?: unknown;
  result?: string;
  granted?: boolean;
  error?: string;
  /** 服务端错误分类（仅 type==='error' 时有意义），供上层差异化提示 */
  errorCategory?: StreamErrorCategory;
  /**
   * ReAct 可观测：当前推理-行动循环的步数（从 1 开始递增）。
   * 同一轮中的 thought → action → observation 共享相同的 step，下一轮 step+1。
   */
  step?: number;
  /**
   * ReAct 可观测：当前事件的显式推理阶段标签。
   * - 'thought'：模型在思考/推理（assistant_text 在 tool_use 之前）
   * - 'action'：模型决定调用工具（tool_call 事件）
   * - 'observation'：工具执行结果（tool_result 事件）
   * - 'final'：最终答复（assistant_phase final）
   * - 'progress'：过程叙述（assistant_phase progress）
   */
  reactPhase?: 'thought' | 'action' | 'observation' | 'final' | 'progress';
  /**
   * P2-⑨ 任务级 progress/final 标记：仅 assistant_phase 事件携带。
   * - 'progress'：该轮 assistant 文本是「过程叙述」（本轮后续会调用工具）
   * - 'final'：该轮 assistant 文本是「最终答复」（本轮不再调用工具）
   */
  phase?: 'progress' | 'final';
  /**
   * 停止原因（P1-⑤ 增强）：标记每条退出路径的判定来源，使循环为何停止可观测。
   * - model_stop：模型本轮未调工具，主动结束
   * - user_abort：用户通过 signal 中断
   * - no_progress：工具连续全部失败/被拒
   * - no_observable_progress：连续多轮既无世界状态变更、又反复观察相同目标（空转）
   * - repeat_loop：连续多轮发出字节完全相同的工具调用（死循环）
   * - max_iterations：达到迭代轮数硬上限
   */
  reason?: 'model_stop' | 'user_abort' | 'no_progress' | 'no_observable_progress' | 'repeat_loop' | 'max_iterations';
}

export interface RunOptions {
  client: DeepSeekClient;
  history: ConversationHistory;
  permission: PermissionMode;
  tools?: ToolDef[];
  cwd: string;
  ask: (prompt: string) => Promise<boolean>;
  maxIterations?: number;
  /** P2-1: Trace 日志记录器（可选，不传则不记录） */
  trace?: TraceLogger;
  /** P2-3: Plan Mode 开关。true 时 Agent 只输出计划不执行工具 */
  planMode?: boolean;
  /** P-Auto: 全自动 Plan & Act 开关（默认 true）。
   *  true：未手动开 planMode 时，对每个新请求做一次轻量复杂度分类，
   *        复杂任务自动生成计划并直接执行（不弹确认框）。
   *  false：关闭自动规划，仅手动 /plan 触发（保留确认框）。
   *  注意：手动 /plan 始终保留确认框（用户终审权），与 autoPlan 无关。 */
  autoPlan?: boolean;
  /** P2-3: 最大自我重试次数（Reflection 深化） */
  maxRetries?: number;
  /** P4-UX: 工具执行期间的实时流式输出回调（如 run_command 的 stdout） */
  onToolProgress?: (toolName: string, text: string) => void;
  /** P1-⑥: 模型主动 awaitUser 时的自由文本回复回调（区别于权限确认的布尔 ask） */
  askText?: (prompt: string) => Promise<string>;
  /** 可取消当前 Agent 运行的 AbortSignal */
  signal?: AbortSignal;
  /** P6 输出风格：把风格指令按轮注入到最后一条 user 消息（本地副本，不污染 history/trace） */
  outputStyle?: OutputStyle;
}

const toModelTools = (tools: ToolDef[]) =>
  tools.map((t) => ({
    type: 'function' as const,
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));

/** 会改变世界状态（文件 / 工作树 / 派生子 Agent）的工具，用于「可观测进展」判定。 */
const MUTATING_TOOLS = new Set([
  'write_file', 'create_file', 'edit_file', 'delete_file', 'run_command',
  'git_commit', 'git_add', 'git_reset', 'delegate',
]);

/**
 * 从一次工具调用提取「主要操作目标」键，用于世界状态指纹。
 * 目标相同（如反复 read_file 同一路径、反复 grep 同一关键词）会被指纹归并，
 * 从而让「忙着但原地打转」的空转循环可被检测到。
 */
function extractTarget(tc: { name: string; arguments: Record<string, unknown> }): string {
  const a = tc.arguments ?? {};
  switch (tc.name) {
    case 'read_file':
    case 'edit_file':
    case 'create_file':
    case 'write_file':
    case 'delete_file':
      return `${tc.name}:${String(a.path ?? '')}`;
    case 'grep':
    case 'search_content':
    case 'search_code':
      return `${tc.name}:${String(a.pattern ?? '')}:${String(a.path ?? a.dir ?? '')}`;
    case 'search_files':
      return `search_files:${String(a.pattern ?? '')}:${String(a.dir ?? '')}`;
    case 'run_command':
      return `run_command:${String(a.command ?? '').replace(/\s+/g, ' ').trim()}`;
    case 'list_dir':
      return `list_dir:${String(a.path ?? '')}`;
    case 'todo_write':
      return `todo_write:${((a.todos as Array<{status:string}>) ?? []).filter(t => t.status === 'completed').length}`;
  default:
    return tc.name;
  }
}

/**
 * P-Auto: 任务复杂度分类器（全自动 Plan & Act 的「眼睛」）。
 *
 * 判断「本轮用户请求」是否需要先规划再执行：
 *  - 需要规划：多步骤任务、跨多个文件/模块、架构设计、重构、从零搭建、
 *              破坏性较大的操作、需求有歧义需先澄清。
 *  - 不需规划：读单个文件、查概念/问问题、改一个文件的小处、一步明确的操作。
 *
 * 设计：单次廉价调用（无工具、短输出、20s 超时），不入主循环、不计迭代轮数。
 * 失败兜底：任何异常/解析失败 → 返回 {complex:false}，走正常执行，绝不阻塞用户。
 *
 * P3.7 升级：新增 effort 档位（small/medium/large），用于动态调自动迭代上限。
 *
 * @returns { complex, reason, effort }
 */
const complexitySchema = z.object({
  complex: z.coerce.boolean(),
  reason: z.string().default(''),
  effort: z.enum(['small', 'medium', 'large']).default('medium'),
});

async function assessComplexity(
  client: DeepSeekClient,
  lastUser: string,
  signal?: AbortSignal,
): Promise<{ complex: boolean; reason: string; effort: 'small' | 'medium' | 'large' }> {
  const sys =
    '你是任务复杂度分类器。判断用户请求是否需要「先规划再执行」。\n' +
    '【需要规划】多步骤任务、涉及多个文件/模块、需要架构设计、重构、从零搭建功能、跨文件改动、破坏性较大的操作、需求有歧义需先澄清。\n' +
    '【不需要规划】读单个文件、查概念/问问题、改一个文件的一小处、一步就能完成的明确操作。\n' +
    '同时估算规模：small(1-3步)/medium(4-7步)/large(8+步)。\n' +
    '只输出一行 JSON：{"complex": true/false, "effort":"small|medium|large", "reason": "一句话理由"}。不要输出其他任何内容。';
  let raw = '';
  try {
    for await (const ev of client.streamChat(
      [
        { role: 'system', content: sys },
        { role: 'user', content: lastUser },
      ],
      [],
      { signal, timeoutMs: 20_000 },
    )) {
      if (ev.type === 'content' && ev.text) raw += ev.text;
      else if (ev.type === 'error') break;
    }
  } catch {
    return { complex: false, reason: 'classifier error, fallback to direct', effort: 'medium' };
  }
  // 正则抠取含 complex 字段的 JSON 对象 + zod 校验（兼容模型夹带额外文本的场景）
  const result = regexExtractJSON(raw, 'complex', complexitySchema);
  if (!result.ok) return { complex: false, reason: 'no valid json, fallback to direct', effort: 'medium' };
  return { complex: result.data!.complex, reason: result.data!.reason ?? '', effort: result.data!.effort ?? 'medium' };
}

/**
 * 序列级循环检测：识别尾部是否构成「周期循环」（如 A→B→C→A→B→C）。
 *
 * 优化设计（v2）：
 * - 最小周期 3：排除 A↔B 这种「读-写-读-写」的合法健康模式（这种是正常节奏，不是死循环）。
 * - 至少 3 次完整重复：要求 3p 个 roundKey 形成 3 次周期模式，比 2 次更可靠。
 * - 自救回合：调用方传 cycleRescueCount 计数，连续两次检测到同一周期才终止，
 *   中间插入一条 user 指令让模型换策略。
 * - 排除常量周期：周期内必须有 ≥2 个不同值（避免把 `search_code:xxx:yyy` 误判为常量循环）。
 */
/** 格式化权限确认提示，提升可读性与风险感知 */
function formatPermissionPrompt(
  toolName: string,
  args: unknown,
  risk: 'low' | 'mid' | 'high',
  forceConfirm = false,
): string {
  const riskBadge = risk === 'high' ? '[高危]' : risk === 'mid' ? '[中危]' : '[低危]';
  const header = forceConfirm
    ? `⚠️ 检测到破坏性命令，即便在 execute 模式也需确认 ${riskBadge}`
    : `🔐 工具 ${toolName} 需要确认执行 ${riskBadge}`;
  let detail = '';
  if (toolName === 'run_command') {
    const cmd = String((args as Record<string, unknown>)?.command ?? '');
    detail = `\n  命令: ${cmd.length > 120 ? cmd.slice(0, 120) + '…' : cmd}`;
  } else if (toolName === 'delete_file') {
    detail = `\n  路径: ${String((args as Record<string, unknown>)?.path ?? '')}`;
  } else {
    detail = `\n  参数: ${JSON.stringify(args).slice(0, 200)}`;
  }
  return `${header}${detail}\n  是否允许？(yes/no) `;
}

/** 格式化写前 diff 审批提示：把工具意图与「将要发生的变更」预览合并展示 */
function buildFileReviewPrompt(
  toolName: string,
  args: unknown,
  diff: string,
  risk: 'low' | 'mid' | 'high',
): string {
  const riskBadge = risk === 'high' ? '[高危]' : risk === 'mid' ? '[中危]' : '[低危]';
  let detail = '';
  if (toolName === 'delete_file') {
    detail = `\n  路径: ${String((args as Record<string, unknown>)?.path ?? '')}`;
  } else if (toolName === 'edit_file') {
    detail = `\n  路径: ${String((args as Record<string, unknown>)?.path ?? '')}`;
  } else if (toolName === 'create_file') {
    detail = `\n  路径: ${String((args as Record<string, unknown>)?.path ?? '')}`;
  }
  return `🔍 写前审批 ${toolName} ${riskBadge}${detail}\n${diff}\n  是否允许此文件变更？(yes/no) `;
}

/**
 * P2-⑧ 统一工具结果预算：单个工具结果回灌上下文前的最大字符数。
 * 超出者做确定性 head+tail 截断，防止单个超大结果（如 read 大文件、
 * grep 海量命中、命令刷屏输出）瞬间撑爆上下文预算。
 */
const TOOL_RESULT_BUDGET = 12_000;
const TOOL_RESULT_HEAD = 8_000;
const TOOL_RESULT_TAIL = 3_000;

/**
 * 确定性截断工具结果输出：保留开头与结尾（尾部常含错误/结论），掐掉中段并打标记。
 * 纯函数、可复现。返回值直接用于回灌 history 与展示。
 */
function clampToolOutput(output: string): string {
  if (output.length <= TOOL_RESULT_BUDGET) return output;
  const head = output.slice(0, TOOL_RESULT_HEAD);
  const tail = output.slice(output.length - TOOL_RESULT_TAIL);
  const cut = output.length - TOOL_RESULT_HEAD - TOOL_RESULT_TAIL;
  return `${head}\n…[工具结果过长，已省略中段 ${cut} 字符 — 如需完整内容请缩小范围重试]…\n${tail}`;
}

/**
 * Agent 运行时层：核心 Agent Loop（对应 learn-claude-code 的循环不变式）。
 * while stop_reason == 'tool_use': 调模型 → 追加 assistant → 权限闸门 → 执行工具 → 回灌结果 → 继续
 * 循环固定，变化的是工具、权限与上下文。
 */
export async function* runAgent(userInput: string, opts: RunOptions): AsyncGenerator<AgentEvent> {
  const trace = opts.trace;
  const tools = opts.tools ?? createTools(opts.client);
  const toolMap = new Map(tools.map((t) => [t.name, t]));
  opts.history.addUser(userInput);

  // Trace: 会话开始 + 用户输入
  if (trace) {
    await trace.log('session_start', { cwd: opts.cwd, permission: opts.permission, model: opts.client.primaryModel });
    await trace.log('user_input', { input: userInput.slice(0, 500) });
  }

  // ════════════════════════════════════════════════════════
  // Plan & Act（全自动升级）：
  //   手动 /plan  → 生成计划 → 弹确认框（用户保留终审权）
  //   自动识别复杂 → 生成计划 → 直接执行（全自动，不弹框）
  // 旧行为：planMode=true → 生成计划 → 直接 return（Plan Only）
  // ════════════════════════════════════════════════════════
  // —— 全自动：未手动开 planMode 时，对每个新请求做一次轻量复杂度分类 ——
  let autoPlanned = false;
  let planText = ''; // P1.2 计划合规检验：计划原文（用于周期性提醒，需在 doPlan 块外侧声明）
  if (!opts.planMode && opts.autoPlan !== false) {
    const msgs = opts.history.getMessages();
    const lastUser = [...msgs].reverse().find((m) => m.role === 'user');
    if (lastUser && lastUser.content) {
      const assessment = await assessComplexity(
        opts.client,
        String(lastUser.content),
        opts.signal,
      );
      if (assessment.complex) {
        autoPlanned = true;
        if (trace) await trace.log('auto_plan', { reason: assessment.reason, effort: assessment.effort });
      }
    }
  }

  const doPlan = opts.planMode || autoPlanned;
  if (doPlan) {
    const planInstruction =
      '\n\n【规划模式】请先不要执行任何工具调用。用中文输出你的执行计划：\n' +
      '1. 目标：你打算做什么（一句话）\n' +
      '2. 步骤：分步列出每步要调用的工具、参数、预期结果（编号）\n' +
      '3. 验证：每步完成后如何验证\n' +
      '格式简洁，用编号列表即可。';

    const lastMsg = opts.history.getMessages();
    if (lastMsg.length > 0) {
      const last = lastMsg[lastMsg.length - 1];
      if (last.role === 'user') {
        last.content = (last.content || '') + planInstruction;
      }
    }

    const modelTools = toModelTools(tools);
    let planContent = '';
    for await (const ev of opts.client.streamChat(lastMsg, modelTools, { signal: opts.signal, timeoutMs: 180_000 })) {
      if (ev.type === 'content' && ev.text) {
        planContent += ev.text;
        yield { type: 'assistant_text', text: ev.text };
      } else if (ev.type === 'error') {
        yield { type: 'error', error: ev.error, errorCategory: ev.errorCategory };
        return;
      } else if (ev.type === 'aborted') {
        yield { type: 'done', reason: 'user_abort' };
        return;
      }
    }
    // 存储计划用于后续迭代的合规提醒（P1.2）
    planText = planContent;

    // 计划生成完成 → 存入历史
    opts.history.addAssistant(planContent, undefined);
    if (trace) await trace.log('plan_generated', { planLen: planContent.length, auto: autoPlanned });

    let confirmed = true;
    if (opts.planMode && !autoPlanned) {
      // —— 手动 /plan：保留确认框，用户有终审权 ——
      confirmed = await opts.ask(
        `执行计划已生成。是否按此计划执行？\n\n` +
        planContent.slice(0, 300) + (planContent.length > 300 ? '...' : '') +
        `\n\n选择「是」将自动进入执行模式，按计划逐步执行。选择「否」则保留计划在对话中（后续可继续确认）。`
      );
      yield { type: 'permission', toolName: 'plan_confirm', granted: confirmed };
      if (trace) await trace.log('plan_decision', { confirmed, auto: false });
    } else {
      // —— 全自动：复杂任务自动规划后直接执行，不弹框 ——
      if (trace) await trace.log('plan_decision', { confirmed: true, auto: true });
    }

    if (!confirmed) {
      yield { type: 'assistant_text', text: '\n（计划已暂存。你可以说「按计划执行」或「确认执行」来继续。）' };
      yield { type: 'done', reason: 'model_stop' };
      return;
    }

    // 计划注入上下文，自动进入执行
    yield { type: 'assistant_text', text: '\n（已确认，进入执行模式...）\n' };
    opts.history.addUser(
      `[系统] 以下执行计划已${autoPlanned ? '由系统自动生成并确认' : '经用户确认'}。请严格按照计划步骤执行——\n` +
      `每完成一步做简要汇报，遇到问题及时反馈，不要跳过任何步骤。\n\n` +
      `执行计划:\n${planContent}`
    );
    // fall through → 进入正常 Agent Loop（不 return）
  }
  // ════════════════════════════════════════════════════════

  const modelTools = toModelTools(tools);
  const maxIter = opts.maxIterations ?? 0;
  const limited = maxIter > 0;
  const effectiveMax = limited ? maxIter : Infinity;
  const WARN_AHEAD = 2;
  const maxRetries = opts.maxRetries ?? 3; // 连续全失败轮数上限
  let iterations = 0;
  // DriftTracker: 世界状态增量追踪器（替代旧 failStreak/stallStreak/repeatCount/detectCycle）
  // 核心思想：追踪世界状态的实际变化，而非工具调用的模式匹配
  const drift = {
    window: [] as Array<{ reads: Set<string>; writes: Set<string>; allFailed: boolean }>,
    maxWindow: 5,
    failStreak: 0,       // 连续全失败（保留，简单有效）
    stallWarnings: 0,    // 连续无新文件探索的警告次数
    record(reads: string[], writes: string[], allFailed: boolean) {
      this.window.push({ reads: new Set(reads), writes: new Set(writes), allFailed });
      if (this.window.length > this.maxWindow) this.window.shift();
      if (allFailed) this.failStreak++; else this.failStreak = 0;
    },
    /** 判断最近是否有新进展：读了新文件 或 写了文件 */
    hasRecentProgress(): boolean {
      if (this.window.length < 2) return true; // 前2轮直接放行
      const recent = this.window.slice(-2);
      const prior = this.window.slice(0, -2);
      const priorReads = new Set(prior.flatMap(r => [...r.reads]));
      const priorWrites = new Set(prior.flatMap(r => [...r.writes]));
      // 1. 最近轮次读了新文件（扩展了知识边界）
      const newReads = recent.flatMap(r => [...r.reads]).filter(f => !priorReads.has(f));
      if (newReads.length > 0) return true;
      // 2. 最近轮次写了文件（产生了实际变更）
      const anyWrite = recent.some(r => r.writes.size > 0);
      if (anyWrite) return true;
      return false;
    },
  };
  let totalToolRounds = 0; // 全会话累计「调了工具」的轮数，供 C2 主停止完成校验
  let everMutated = false; // 全会话是否曾改变世界状态，供 C2 主停止完成校验
  let didElevate = false; // 双模型 Elevate 闸：本轮是否已触发过 Pro 审核（防死循环）
  let selfReviewed = false; // P1.1 Flash 自检：本轮是否已完成自我审查（防重复）
  let replanAttempted = false; // P2.5 中继重新规划：是否已尝试过 replan（防无限循环）
  // P1 防循环新增（Claude Code 对比分析）
  let lastOutputLen = 0; // 上轮文本输出长度，供递减检测
  let diminishingCount = 0; // 连续递减轮数
  let lastTodoCount = 0; // 上轮 Todo 完成数，供进度 nag
  let roundsWithoutTodo = 0; // 连续未更新 Todo 的轮数
  const DIMINISHING_LIMIT = 4; // 连续 N 轮递减 → 可能文本循环
  const TODO_NAG_AFTER = 3; // 连续 N 轮不更新 Todo → 提醒
  const perToolFailures = new Map<string, number>(); // P1: 每个工具的累计失败次数（Reflection 升级用）
  let step = 1; // ReAct 可观测：当前推理-行动步数（每进入新一轮 +1）

  while (iterations < effectiveMax) {
    // 用户主动中断：立即结束，不再开启新一轮
    if (opts.signal?.aborted) {
      yield { type: 'assistant_phase', phase: 'final' };
      yield { type: 'done', reason: 'user_abort' };
      return;
    }
    iterations++;
    step++; // ReAct: 新一轮推理-行动步数
    logger.debug(`[agent loop] iteration ${iterations}${limited ? `/${maxIter}` : ''}`);

    // ═══════════════════════════════════════════════════════════════
    // 第 maxIter 轮（末轮）：强制总结 — 前 maxIter-1 轮用于实际工作，最后一轮
    // 生成结构化总结（已完成 + 剩余规划），发送完整回覆而非报错。
    // 关闭工具调用，让模型专注产出高质量总结而非继续执行。
    // ═══════════════════════════════════════════════════════════════
    if (limited && iterations === maxIter) {
      const summaryPrompt =
        `你已经用完了所有工作轮次（前 ${maxIter - 1} 轮）。现在是第 ${maxIter} 轮——**总结轮**，你不能调用任何工具。\n\n` +
        '请生成一份完整的项目进展报告，包含以下两部分：\n\n' +
        '## 一、已完成工作总结\n' +
        `回顾前 ${maxIter - 1} 轮的操作，逐条列出：\n` +
        '- 完成了哪些任务（具体到文件/功能/改动）\n' +
        '- 每项任务的结果（成功/部分完成/失败及原因）\n' +
        '- 做了哪些验证（构建/测试/审查）及其结果\n\n' +
        '## 二、待完成工作规划\n' +
        '对于尚未完成的任务：\n' +
        '- 列出剩余待办，按优先级排序（高/中/低）\n' +
        '- 每项给出具体的下一步操作建议（调什么工具、改什么文件、注意什么坑）\n' +
        '- 预估每个待办需要的工作量\n\n' +
        '要求：\n' +
        '- 用中文输出，格式清晰，用户能一目了然地知道进度和后续步骤\n' +
        '- 不要泛泛而谈，要具体到文件路径、函数名、命令等细节\n' +
        '- 如果某项任务失败，诚实标注并给出备选方案\n' +
        '- 不要写"我可以继续"之类的——直接告诉用户怎么继续';

      opts.history.addUser(summaryPrompt);
      const summaryMessages = [...opts.history.getMessages()];

      // 总结轮：实时逐字流出（不再整段缓冲），消除「等待完整内容」的长时间空白。
      // 严格顺序：先 phase('final') 让前端把后续文字路由到答案气泡，再逐 token 流出。
      let summaryBuf = '';
      let summaryAborted = false;
      yield { type: 'assistant_phase', phase: 'final', step, reactPhase: 'final' };
      try {
        for await (const ev of opts.client.streamChat(summaryMessages, [], { signal: opts.signal, timeoutMs: 120_000 })) {
          if (ev.type === 'content' && ev.text) {
            summaryBuf += ev.text;
            // 逐 token 实时流出（与模型实际输出速度同步，前端按到达逐字渲染）
            yield { type: 'assistant_text', text: ev.text, step, reactPhase: 'final' };
          } else if (ev.type === 'tool_use') {
            // 模型尝试调工具但 tools=[] 时应忽略，继续等文本输出
            logger.debug('[agent loop] summary round ignored tool_use');
          } else if (ev.type === 'aborted') {
            // 用户中断总结生成：保留已生成的总结，交由上层标记为「生成中断」
            summaryAborted = true;
            break;
          } else if (ev.type === 'error') {
            logger.error('[agent loop] summary round stream error: ' + String(ev.error || 'unknown'));
            // API 报错：同上交给上层按分类展示友好提示，不再污染正文
            yield { type: 'error', error: ev.error, errorCategory: ev.errorCategory };
            return;
          }
        }
      } catch (e: unknown) {
        logger.error('[agent loop] summary round exception: ' + (e instanceof Error ? e.message : String(e)));
        summaryBuf = `## 总结生成异常\n\n系统在处理总结时遇到异常，请查看前 ${maxIter - 1} 轮的操作记录。\n\n异常: ${e instanceof Error ? e.message : String(e)}`;
        yield { type: 'assistant_text', text: summaryBuf, step, reactPhase: 'final' };
      }

      if (summaryAborted) {
        opts.history.addAssistant(summaryBuf, undefined);
        if (trace) await trace.log('assistant_message', { content: summaryBuf, summaryRound: true, interrupted: true });
        yield { type: 'done', reason: 'user_abort' };
        return;
      }

      opts.history.addAssistant(summaryBuf, undefined);
      if (trace) await trace.log('assistant_message', { content: summaryBuf, summaryRound: true });

      await opts.history.compact({ signal: opts.signal });
      yield { type: 'done', reason: 'model_stop' };
      return;
    }

    // 本地副本：往最后一条 user 消息追加输出风格指令（不写回 history/trace）。
    // 若本轮末尾是 tool 结果（多轮任务常见），则补一条 user 风格指令，
    // 确保模型在生成最终答复（及每一轮）时都看到风格要求。
    const messages = [...opts.history.getMessages()];
    if (opts.outputStyle && opts.outputStyle !== 'raw') {
      const instr = styleInstruction(opts.outputStyle);
      if (instr) {
        const last = messages[messages.length - 1];
        if (last && last.role === 'user') {
          last.content = `${last.content || ''}\n\n${instr}`;
        } else {
          messages.push({ role: 'user', content: instr });
        }
      }
    }

    // P1.2 计划合规检验：每 3 轮附加一条简短的计划对齐提醒（不污染 history/trace）
    if (planText && iterations % 3 === 0 && iterations > 1) {
      const planReminder = `[系统提醒] 你正在按计划执行（第 ${iterations} 轮）。请简要确认当前操作与计划步骤一致，如有偏离请主动说明。`;
      const last = messages[messages.length - 1];
      if (last && last.role === 'user') {
        last.content = `${last.content || ''}\n\n${planReminder}`;
      } else {
        messages.push({ role: 'user', content: planReminder });
      }
    }

    // ════════════════════════════════════════════════════════
    // P6 轮次预警：进入最后 WARN_AHEAD 个工作轮时，给模型 + 用户双向预警，
    // 避免「12 轮硬切无预警、总结被惊到」。
    //   - 模型侧：注入「轮次额度即将耗尽、立即收尾」指令（写入本地 messages 副本，
    //     不污染 history/trace），让它优雅收尾、产出有意义的总结，而非被半途截断。
    //   - 用户侧：yield 一条 system 提示，提前告知「即将自动总结」，不再惊到。
    // 注意：此处 iterations 必然 < maxIter（总结轮已在上方 early-return），
    // 所以只需判断 iterations >= maxIter - WARN_AHEAD。
    // ════════════════════════════════════════════════════════
    if (limited && iterations >= maxIter - WARN_AHEAD) {
      const workLeft = maxIter - iterations; // 还能调工具的工作轮数（含本轮）
      // ① 模型侧预警（本地副本，不写回 history/trace）
      messages.push({
        role: 'user',
        content:
          `[系统预警] 轮次额度即将耗尽：你仅剩 ${workLeft} 轮可调用工具（当前第 ${iterations} 轮，第 ${maxIter} 轮为强制总结轮、不能调工具）。请立即收尾：\n` +
          `- 优先确保核心目标已落盘/已验证；\n` +
          `- 不要开启新的大块工作，避免被强制截断在半途；\n` +
          `- 未完成的次要事项，留到总结轮的「待完成工作规划」里列出具体下一步，不要硬撑执行。`,
      });
      // ② 用户侧预警（系统提示，不渲染为助手回答）
      yield {
        type: 'system',
        text:
          `⏳ 轮次预警：任务仅剩 ${workLeft} 轮工作机会（第 ${maxIter} 轮将自动生成进展总结）。如需调整范围，现在可补充指令。`,
      };
    }
    let accContent = '';
    let pendingToolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }> = [];
    let gotToolUse = false;
    let sawToolUse = false;
    let hasRunTools = false;

    for await (const ev of opts.client.streamChat(messages, modelTools, { signal: opts.signal, timeoutMs: 180_000 })) {
      if (ev.type === 'content' && ev.text) {
        accContent += ev.text;
        const rp: 'thought' | 'final' = hasRunTools ? 'final' : 'thought';
        // 实时逐字流出到思考盒（乐观视为「思考/过程叙述」）。
        // 若为直接答复回合，文字已实时出现在思考盒，收尾时由 assistant_promote
        // 晋升为最终答案气泡——全程无「等待完整内容」的空白。
        yield { type: 'assistant_text', text: ev.text, step, reactPhase: rp };
      } else if (ev.type === 'tool_use' && ev.tools) {
        sawToolUse = true;
        gotToolUse = true;
        hasRunTools = true; // 本轮后续文本（若模型在 tool_use 后仍输出文字）视为「最终回复」
        pendingToolCalls = ev.tools;
        // Trace: 模型决定调用工具
        if (trace) {
          await trace.log('model_tool_use', { tools: ev.tools.map((t) => t.name) });
        }
      } else if (ev.type === 'error') {
        if (trace) await trace.log('error', { phase: 'streaming', error: ev.error });
        yield { type: 'error', error: ev.error, errorCategory: ev.errorCategory };
        return;
      } else if (ev.type === 'aborted') {
        if (trace) await trace.log('cancelled', { phase: 'streaming' });
        // 用户中断了流式生成：把已生成的文本作为最终答复收尾，并保持干净（不污染正文）。
        // 「生成中断」标记交由上层（chat.ts / host）在 done reason=user_abort 时打在答案气泡上。
        yield { type: 'assistant_phase', phase: 'final' };
        if (accContent.trim()) {
          opts.history.addAssistant(accContent, undefined);
          yield { type: 'assistant_text', text: accContent };
        }
        yield { type: 'done', reason: 'user_abort' };
        return;
      }
    }

    // ═══════════════════════════════════════════════════════════
    // P0 Pro 质量闸门分级触发（2026-07-19 升级）：
    //
    //   Level 1 — 写操作（everMutated=true）：全检
    //     → verify-task（任务级语义保真审计）
    //     → verify-answer（最终答复事实核查）
    //
    //   Level 2 — 多轮读操作（totalToolRounds >= 3 且 everMutated=false）：轻检
    //     → 仅 verify-answer（关注事实错误和逻辑矛盾，不审任务完整度）
    //
    //   Level 3 — 单轮简单查询：跳过全部 Pro 审查
    //
    //   约束：不在最后一个工作轮触发；且 didElevate 防重复。
    // ═══════════════════════════════════════════════════════════
    const canElevate = !gotToolUse && !didElevate && (!limited || iterations < maxIter - 1);
    // P1.1 Flash 自检：对于未被 Elevate 覆盖的中等规模任务（2-3 轮工具操作），
    // 注入一条自检提示让 Flash 先自查再输出——不增额外 Pro 调用，仅 1 轮额外迭代。
    const willElevate = canElevate && (everMutated || totalToolRounds >= 3);
    if (!willElevate && !gotToolUse && !selfReviewed && totalToolRounds >= 2) {
      selfReviewed = true;
      const reviewPrompt =
        '[系统自动] 在输出最终答复前，请用一句话自我核对：\n' +
        '① 是否遗漏了用户的任何要求？② 答复中是否有事实错误或前后矛盾？\n' +
        '如果有问题，请在下一轮输出中修正；如果确认无误，直接输出最终答复。';
      opts.history.addUser(reviewPrompt);
      if (trace) await trace.log('self_review', { totalToolRounds });
      logger.debug('[agent loop] self-review injected (moderate task, no Elevate)');
      continue;
    }
    if (canElevate && everMutated) {
      // Level 1: 写操作 — 全检
      didElevate = true;
      // P2 任务级语义保真闸门（内核侧、基于真实落盘记录）：
      // 在最终答复前，用 Pro 审计「整轮工作」是否真的达成用户意图——
      // 漏子需求 / 半成品 / 声称已验证实际未跑。审计依据是内核从 history
      // 抽出的真实工具结果，而非 Flash 自述（延续 P0「不轻信 ok 声明」哲学）。
      try {
        const fidelityNote = await runTaskFidelity(opts.client, opts.history, { signal: opts.signal });
        if (fidelityNote) {
          opts.history.addUser(
            '[系统自动] 任务级交付审计已完成，结果如下。在输出最终答复前，请先处理其中的 must_fix（必须修复项）；若 pass=false，不要声称任务已完成。\n\n' +
            fidelityNote,
          );
          if (trace) await trace.log('task_fidelity', { triggered: true });
        }
      } catch (e: unknown) {
        logger.warn('[agent loop] task fidelity check failed: ' + errMsg(e));
      }
      const elevatePrompt =
        '[系统自动] 在输出最终答复给用户前，先调用 verify_answer 工具审核你的答复是否准确、完整、一致。\n' +
        '你需要提供两个参数：\n' +
        '  - answer：你准备发给用户的答复全文\n' +
        '  - context_summary：本轮你做了哪些操作、各工具的关键结果（帮助审核员判断你是否遗漏或歪曲了事实）\n' +
        '审核通过后，根据审核结果修正答复再发送给用户。';
      opts.history.addUser(elevatePrompt);
      if (trace) await trace.log('elevate', { level: 1, reason: 'full_gate', totalToolRounds, everMutated });
      logger.debug('[agent loop] Elevate L1 — full gate (verify-task + verify-answer)');
      continue;
    } else if (canElevate && totalToolRounds >= 3) {
      // Level 2: 多轮读操作 — 轻检（仅 verify-answer）
      didElevate = true;
      const lightPrompt =
        '[系统自动] 本轮进行了多轮信息检索和分析（未修改文件）。在输出最终答复前，请先调用 verify_answer 工具审核你的答复是否准确、一致、无事实错误。\n' +
        '你需要提供两个参数：\n' +
        '  - answer：你准备发给用户的答复全文\n' +
        '  - context_summary：本轮你检索了哪些信息、各工具的关键结果（帮助审核员判断你是否遗漏或歪曲了事实）\n' +
        '审核通过后，根据审核结果修正答复再发送。';
      opts.history.addUser(lightPrompt);
      if (trace) await trace.log('elevate', { level: 2, reason: 'read_heavy_light_gate', totalToolRounds });
      logger.debug('[agent loop] Elevate L2 — light gate (verify-answer only)');
      continue;
    }

    // P2-⑨ 任务级 progress/final 标记：本轮若还要调用工具 → 过程叙述；否则 → 最终答复。
    // 确定性区分，无需模型显式输出 <progress>/<final> 标记。
    if (accContent.trim()) {
      if (gotToolUse) {
        // 本轮调用了工具：过程叙述结束，继续下一轮
        yield { type: 'assistant_phase', phase: 'progress', step, reactPhase: 'progress' };
      } else {
        // 本轮无工具：最终答复。文字此前已实时流入思考盒，现晋升为最终答案气泡
        // （agent-host 把当前思考轮次的 reason 条目文本「复制」到答案气泡，思考盒保留在界面、不清除）。
        yield { type: 'assistant_promote' };
        yield { type: 'assistant_phase', phase: 'final', step, reactPhase: 'final' };
      }
    }

    if (!gotToolUse) {
      // P1 输出递减检测：模型不调工具但文本输出持续缩短 → 可能卡住/重复
      const outLen = accContent.trim().length;
      if (outLen < lastOutputLen && outLen < 80) {
        diminishingCount++;
      } else {
        diminishingCount = 0;
      }
      lastOutputLen = outLen;
      if (diminishingCount >= DIMINISHING_LIMIT) {
        const msg = `连续 ${DIMINISHING_LIMIT} 轮文本输出递减且均不足 80 字，疑似陷入无意义重复。提前结束。`;
        if (trace) await trace.log('early_exit', { reason: 'diminishing_output', streak: diminishingCount });
        yield { type: 'assistant_phase', phase: 'final' };
        yield { type: 'assistant_text', text: msg };
        yield { type: 'done', reason: 'no_progress' };
        return;
      }
      // P1 未完成措辞检测：模型说"可以继续"但被判为完成 → 注入继续提示
      const unfinishedHints = /可以继续|还需要|接下来|下一[步轮]|剩余(步骤|工作|任务)/;
      if (unfinishedHints.test(accContent) && !selfReviewed && !didElevate) {
        opts.history.addUser('[系统提示] 你的答复暗示任务还未完成。如有剩余步骤，请继续调用工具执行；如已完成，请明确说明。');
        continue;
      }
      // C2: 轻量完成校验 —— 模型声称完成，但若此前已进行多轮实质工具操作、
      // 最终答复却过短（<20 字），很可能「答一半就停」。仅告警、仍正常结束，避免无限循环。
      if (totalToolRounds >= 2 && everMutated && accContent.trim().length < 20) {
        const warn = '⚠️ 模型给出的结束答复过短，任务可能未完成（此前已进行多轮工具操作）。建议复核结果。';
        if (trace) await trace.log('early_exit', { reason: 'model_stop_short', finalLen: accContent.trim().length, toolRounds: totalToolRounds });
        yield { type: 'assistant_text', text: warn };
      }
      await opts.history.compact({ signal: opts.signal });
      yield { type: 'done', reason: 'model_stop' };
      return;
    }

    // ⚠️ 关键：addAssistant 在此位置——Elevate/Replan 已通过，tool 执行即将开始。
    // 过早→Elevate continue 留孤儿 tool_calls；过晚→tool 消息缺前导 assistant → API 400。
    const assistantToolCalls: ToolCall[] = pendingToolCalls.map((t) => ({
      id: t.id,
      type: 'function',
      function: { name: t.name, arguments: JSON.stringify(t.arguments) },
    }));
    opts.history.addAssistant(accContent, assistantToolCalls);
    if (trace) {
      await trace.log('assistant_message', {
        content: accContent,
        toolCalls: assistantToolCalls.map((t) => ({ id: t.id, name: t.function.name, arguments: t.function.arguments })),
      });
    }

    // 执行每个工具调用，经过权限闸门
    const iterToolResults: boolean[] = []; // 本轮各工具是否成功，供 early-exit 判定
    const iterSigParts: string[] = []; // 本轮工具调用签名，供重复检测
    const roundTargets: string[] = []; // 本轮各工具调用的主要操作目标，供世界状态指纹
    let roundMutated = false; // 本轮是否有 mutating 工具成功执行（改变了世界状态）
    const successChecks: string[] = []; // P2.6 成功路径验证：等本轮全部 tool 结果落盘后再统一插入，避免 user 消息楔入 tool 结果之间破坏 API 顺序
    for (const tc of pendingToolCalls) {
      try {
        // P1-⑥ 模型主动 awaitUser：中途向用户提问，等回复后再继续（在权限闸门之前拦截）
        if (tc.name === 'awaitUser') {
          const question = String((tc.arguments as Record<string, unknown>).question ?? '').trim();
          let reply: string;
          if (opts.askText) {
            // 优先走自由文本：模型本意是「问一个开放问题」，应原样回灌用户回答
            reply = await opts.askText(question || '（模型未提供问题）');
          } else {
            // 退化到 yes/no 确认：诚实返回机器可读的确认结果，而非伪装成自由文本模板
            const confirmed = await opts.ask(question || '（模型请求确认）');
            reply = confirmed ? '(yes)' : '(no)';
          }
          opts.history.addToolResult(tc.id, tc.name, JSON.stringify({ ok: true, output: reply }));
          if (trace) await trace.log('tool_result', { tool: tc.name, awaitUser: true, reply: reply.slice(0, 500) });
          yield { type: 'tool_result', toolName: tc.name, result: `用户回复: ${reply}`, step, reactPhase: 'observation' };
          iterToolResults.push(true);
          roundMutated = true; // 用户已参与，不视为空转
          continue;
        }

        // 记录本轮工具调用签名（name+args），供重复检测（与 awaitUser 分支互斥）
        iterSigParts.push(`${tc.name}:${JSON.stringify(tc.arguments)}`);
        // 记录本轮主要操作目标，供世界状态指纹（与 awaitUser 分支互斥）
        roundTargets.push(extractTarget(tc));
        const def = toolMap.get(tc.name);
        if (!def) {
          const msg = `未知工具: ${tc.name}`;
          opts.history.addToolResult(tc.id, tc.name, JSON.stringify({ ok: false, output: msg }));
          yield { type: 'tool_result', toolName: tc.name, result: msg, step, reactPhase: 'observation' };
          iterToolResults.push(false);
          continue;
        }

        // 权限闸门 + 文件写前 diff 审批（P0-②）
        // 设计：文件写类工具（def.preview 存在）在执行前必须展示 diff 并由用户确认，
        // 与权限确认合并为单次询问，避免重复弹窗。explore 模式直接拦截（文件工具均 mid/high）。
        const destructive = tc.name === 'run_command' && isDestructive(String((tc.arguments as Record<string, unknown>).command ?? ''));
        const effectiveRisk = destructive ? 'high' : def.risk;
        const isFileWrite = !!def.preview;
        let granted = true;

        if (opts.permission === 'explore') {
          if (effectiveRisk !== 'low') {
            granted = false;
            if (trace) await trace.log('permission_decision', { tool: tc.name, mode: 'explore', risk: effectiveRisk, granted: false });
            yield { type: 'permission', toolName: tc.name, granted: false };
          }
        } else if (opts.permission === 'ask') {
          if (isFileWrite) {
            const diff = await def.preview!(tc.arguments as Record<string, unknown>, { cwd: opts.cwd });
            granted = await opts.ask(buildFileReviewPrompt(tc.name, tc.arguments, diff, effectiveRisk));
            if (trace) await trace.log('permission_decision', { tool: tc.name, mode: 'ask', fileReview: true, granted });
            yield { type: 'permission', toolName: tc.name, granted };
          } else if (effectiveRisk === 'high') {
            granted = await opts.ask(formatPermissionPrompt(tc.name, tc.arguments, effectiveRisk));
            if (trace) await trace.log('permission_decision', { tool: tc.name, mode: 'ask', risk: effectiveRisk, granted });
            yield { type: 'permission', toolName: tc.name, granted };
          }
        } else if (opts.permission === 'execute') {
          if (destructive) {
            granted = await opts.ask(formatPermissionPrompt(tc.name, tc.arguments, effectiveRisk, true));
            if (trace) await trace.log('permission_decision', { tool: tc.name, mode: 'execute+destructive', granted });
            yield { type: 'permission', toolName: tc.name, granted };
          } else if (isFileWrite) {
            // 即便 execute 模式，文件写也需 diff 确认（安全底线：写盘不可逆）
            const diff = await def.preview!(tc.arguments as Record<string, unknown>, { cwd: opts.cwd });
            granted = await opts.ask(buildFileReviewPrompt(tc.name, tc.arguments, diff, effectiveRisk));
            if (trace) await trace.log('permission_decision', { tool: tc.name, mode: 'execute', fileReview: true, granted });
            yield { type: 'permission', toolName: tc.name, granted };
          }
        }

        if (!granted) {
          const denyMsg = `用户拒绝执行 ${tc.name}（权限模式: ${opts.permission}）`;
          opts.history.addToolResult(tc.id, tc.name, JSON.stringify({ ok: false, output: denyMsg }));
          if (trace) await trace.log('tool_result', { tool: tc.name, toolCallId: tc.id, name: tc.name, denied: true, reason: denyMsg });
          yield { type: 'tool_result', toolName: tc.name, result: denyMsg, step, reactPhase: 'observation' };
          iterToolResults.push(false);
          continue;
        }

        // Trace: 工具开始执行
        if (trace) await trace.log('tool_call', { tool: tc.name, args: tc.arguments });
        yield { type: 'tool_call', toolName: tc.name, args: tc.arguments, step, reactPhase: 'action' };
        const res: ToolResult = await def.execute(tc.arguments as Record<string, unknown>, {
          cwd: opts.cwd,
          signal: opts.signal,
          onProgress: opts.onToolProgress
            ? (text: string) => opts.onToolProgress!(tc.name, text)
            : undefined,
        });

        // P2-⑧ 统一工具结果预算截断：回灌上下文前先按预算裁剪，避免单个超大结果撑爆窗口
        const clampedOutput = clampToolOutput(res.output);
        // P1 Reflection 渐进升级：按工具失败次数递进式注入分析提示
        if (!res.ok) {
          const failN = (perToolFailures.get(tc.name) ?? 0) + 1;
          perToolFailures.set(tc.name, failN);
          iterToolResults.push(false);

          // 渐进升级提示（3 级），帮模型更精准地找到失败根因
          let diagnostic: string;
          if (failN === 1) {
            diagnostic =
              `请分析失败原因（工具: ${tc.name}），调整策略后重试——` +
              `可以换参数、换工具、或换方法。`;
          } else if (failN === 2) {
            diagnostic =
              `这个工具已连续失败 ${failN} 次。请深入思考：\n` +
              `- 参数是否正确？是否漏了必要的前置步骤？\n` +
              `- 换个工具能否达到相同目标？（如 read_file 失败可试试 search_code 定位）\n` +
              `- 是否需要先检查当前工作区状态？`;
          } else {
            diagnostic =
              `这个工具已失败 ${failN} 次。强烈建议停止对这个工具的尝试，并考虑：\n` +
              `- 向用户说明你遇到的问题并请求澄清或指示\n` +
              `- 调用 verify_code 或 review_code 检查已生成的代码是否有问题\n` +
              `- 重新审视用户原始需求，确认是否误解了任务方向`;
          }
          const reflectionMsg =
            `[工具执行失败 (第 ${failN} 次) — 请自我纠正]\n` +
            `工具: ${tc.name}\n参数: ${JSON.stringify(tc.arguments)}\n` +
            `错误: ${clampedOutput}\n\n${diagnostic}`;
          opts.history.addToolResult(tc.id, tc.name, JSON.stringify({ ok: false, output: reflectionMsg }));
          if (trace) await trace.log('tool_result', { tool: tc.name, toolCallId: tc.id, name: tc.name, ok: false, failCount: failN, reflected: true });
          yield { type: 'tool_result', toolName: tc.name, result: `[失败#${failN}] ${res.output.slice(0, 300)}... → Agent 将自我纠正`, step, reactPhase: 'observation' };
          // 不 continue —— 让循环继续，Agent 会在下一轮收到反思消息并尝试修正
        } else {
          // 成功：重置该工具失败计数
          perToolFailures.delete(tc.name);
          opts.history.addToolResult(tc.id, tc.name, JSON.stringify({ ok: true, output: clampedOutput }));
          if (trace) await trace.log('tool_result', { tool: tc.name, toolCallId: tc.id, name: tc.name, ok: true, output: clampedOutput.slice(0, 3000) });
          yield { type: 'tool_result', toolName: tc.name, result: res.output, step, reactPhase: 'observation' };
          iterToolResults.push(true);
          if (MUTATING_TOOLS.has(tc.name)) roundMutated = true; // 改变了世界状态
          // P2.6 成功路径验证：写操作成功后附加轻量验证提示，但先收集，等本回合全部 tool 结果落盘后再统一插入 user 消息，避免破坏 tool 消息连续性
          if (MUTATING_TOOLS.has(tc.name) && res.ok) {
            successChecks.push(`[系统提示] ${tc.name} 已执行成功。请在下一轮给出推理时，用一句话确认：产出是否符合预期？（如「文件已创建，入口逻辑正确」）`);
          }
        }
      } catch (e: unknown) {
        // 任何工具执行路径（包括 awaitUser/ask/exe 抛异常）都必须给当前 tool_call 补一条结果，
        // 否则 assistant 的 tool_calls 后面缺 tool 消息，API 会报 400。
        const isAbort = opts.signal?.aborted || (e instanceof Error && e.name === 'AbortError');
        const err = isAbort ? '用户已中断此工具执行' : `工具执行异常: ${errMsg(e)}`;
        opts.history.addToolResult(tc.id, tc.name, JSON.stringify({ ok: false, output: err }));
        if (trace) await trace.log('tool_result', { tool: tc.name, toolCallId: tc.id, name: tc.name, ok: false, output: err });
        yield { type: 'tool_result', toolName: tc.name, result: err, step, reactPhase: 'observation' };
        iterToolResults.push(false);
        if (isAbort) {
          yield { type: 'assistant_phase', phase: 'final' };
          yield { type: 'done', reason: 'user_abort' };
          return;
        }
      }
    }

    // P2.6 成功路径验证：本轮所有工具结果都已落盘后，再统一插入验证提示，避免 user 消息楔入 tool 结果之间导致 API 400。
    if (successChecks.length > 0) {
      opts.history.addUser(successChecks.join('\n'));
    }

    // ════════════════════════════════════════════════════════
    // DriftTracker 世界状态增量判定（替代旧 failStreak/stallStreak/repeatCount/detectCycle）
    // 核心：追踪"是否读了新文件 / 写了文件"，而非匹配工具调用模式。
    // 哈希工程中反复读同一参考文件 + 写不同文件 = 有进展，不会被误判。
    // ════════════════════════════════════════════════════════
    const anySuccess = iterToolResults.some(Boolean);
    drift.record(
      roundTargets.filter(t => t.startsWith('read_file:') || t.startsWith('search_code:') || t.startsWith('search_files:') || t.startsWith('grep:') || t.startsWith('list_dir:')),
      roundTargets.filter(t => t.startsWith('edit_file:') || t.startsWith('write_file:') || t.startsWith('create_file:') || t.startsWith('run_command:') || t.startsWith('delete_file:')),
      !anySuccess,
    );
    totalToolRounds++;
    if (roundMutated) everMutated = true;

    const hasProgress = drift.hasRecentProgress();

    // 守卫 1: 连续全失败 → 终止（简单有效，保留原逻辑）
    if (drift.failStreak >= maxRetries) {
      const msg = `连续 ${drift.failStreak} 轮工具调用全部失败或被拒绝，提前结束。`;
      if (trace) await trace.log('early_exit', { reason: 'no_progress', streak: drift.failStreak });
      yield { type: 'assistant_text', text: msg };
      yield { type: 'done', reason: 'no_progress' };
      return;
    }

    // 守卫 2: DriftTracker 无新进展（未读新文件且未写文件）
    if (!hasProgress) {
      drift.stallWarnings++;
      if (drift.stallWarnings === 3) {
        opts.history.addUser('[系统提醒] 已连续 3 轮未探索新文件或产生文件变更。建议确认当前方向是否正确，或换一个角度重新审视问题。');
      } else if (drift.stallWarnings === 5) {
        const msg = '已连续 5 轮无新进展（未读新文件、未写文件）。任务可能陷入停滞，提前结束。';
        if (trace) await trace.log('early_exit', { reason: 'no_observable_progress', warnings: drift.stallWarnings });
        yield { type: 'assistant_text', text: msg };
        yield { type: 'done', reason: 'no_observable_progress' };
        return;
      }
    } else {
      drift.stallWarnings = 0;
    }

    // 守卫 3: replan（保留）
    if (!replanAttempted && drift.failStreak >= 2 && drift.stallWarnings >= 2 && totalToolRounds >= 3) {
      replanAttempted = true;
      drift.failStreak = 0;
      drift.stallWarnings = 0;
      const replanMsg =
        `[系统自动] 当前任务已进行 ${totalToolRounds} 轮，但最近几轮出现连续失败且无实质进展。\n` +
        `请暂停当前路径，重新规划剩余步骤：\n` +
        `1. 梳理已完成的成果（哪些文件/功能已经就绪？）\n` +
        `2. 识别卡住的原因（工具参数错误？缺少前置条件？方向错了？）\n` +
        `3. 给出新的执行计划（用编号列表列出剩余步骤）\n` +
        `不要重复已失败的相同操作。如果新计划仍不奏效，系统会提前结束以避免死循环。`;
      opts.history.addUser(replanMsg);
      if (trace) await trace.log('early_exit', { reason: 'replan_injected' });
      logger.debug('[agent loop] replan injected');
      continue;
    }

    // P0-①: 每轮迭代末尾检查并压缩上下文，避免长任务连续工具轮次中上下文无限膨胀。
    // compact() 内部按 token 预算阈值（默认 80%）决定是否真正压缩，未超阈值则零开销返回。
    if (gotToolUse) {
      await opts.history.compact({ signal: opts.signal });
      if (trace) await trace.log('context_compact', { estimateTokens: opts.history.estimateTotalTokens() });
      // P1 Todo 进度 nag：检测模型是否在维护进度清单
      // 检查两种来源：① todo_write 工具调用 ② assistant 文本中的 [x] 标记
      const todoToolCall = roundTargets.find(t => t.startsWith('todo_write:'));
      const todosFromTool = todoToolCall ? parseInt(todoToolCall.split(':')[1] || '0', 10) : -1;
      const todosFromText = (accContent.match(/\[x\]/g) || []).length + (accContent.match(/\[>\]/g) || []).length;
      const todosDone = todosFromTool >= 0 ? todosFromTool : todosFromText;
      const updatedTodo = todosFromTool >= 0 || todosFromText !== lastTodoCount;
      if (!updatedTodo) {
        roundsWithoutTodo++;
        if (roundsWithoutTodo >= TODO_NAG_AFTER) {
          opts.history.addUser(`[系统提醒] 已 ${roundsWithoutTodo} 轮未更新进度。请确认当前进度并更新 Todo 清单（用 [x] 标记已完成项）。`);
          roundsWithoutTodo = 0;
        }
      } else {
        roundsWithoutTodo = 0;
        lastTodoCount = todosDone;
      }
      // P1 Compact 后身份重注：压缩后消息过少时重建上下文锚点
      const currentMsgs = opts.history.getMessages();
      if (currentMsgs.length <= 3) {
        opts.history.addUser(
          `[身份恢复] 你是 DeepSeek 编程助手。当前工作目录: ${opts.cwd}。正在执行的任务计划已保留在对话中。请继续你的工作。`,
        );
      }
    }
    // 继续循环，把工具结果回灌给模型
  }

  // 兜底：正常流程在 iter===maxIter 时已进入总结轮并 return，
  // 走到这里说明 while 条件异常退出（逻辑 bug），保留此兜底避免静默结束。
  if (trace) await trace.end();
  if (trace) await trace.log('early_exit', { reason: 'max_iterations_fallback', iterations: maxIter });
  yield { type: 'assistant_phase', phase: 'final' };
  yield { type: 'assistant_text', text: `已达到最大迭代轮数上限（${maxIter} 轮），任务强制结束。如果结果未达预期，可以让我继续或调整指令。` };
  yield { type: 'done', reason: 'max_iterations' };
}
