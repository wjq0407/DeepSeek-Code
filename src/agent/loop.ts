import { DeepSeekClient, ChatMessage, ToolCall } from '../llm/deepseek.ts';
import { errMsg } from '../llm/deepseek.ts';
import { ToolDef, ToolResult, isDestructive, createTools } from '../tools/index.ts';
import { ConversationHistory } from '../context/history.ts';
import { TraceLogger, type TraceEventType } from '../context/trace.ts';
import { logger } from '../utils/logger.ts';

export type PermissionMode = 'explore' | 'ask' | 'execute';

export interface AgentEvent {
  type: 'assistant_text' | 'assistant_phase' | 'tool_call' | 'tool_result' | 'tool_stream' | 'permission' | 'error' | 'done';
  text?: string;
  toolName?: string;
  args?: unknown;
  result?: string;
  granted?: boolean;
  error?: string;
  /**
   * P2-⑨ 任务级 progress/final 标记：仅 assistant_phase 事件携带。
   * - 'progress'：该轮 assistant 文本是「过程叙述」（本轮后续会调用工具）
   * - 'final'：该轮 assistant 文本是「最终答复」（本轮不再调用工具）
   */
  phase?: 'progress' | 'final';
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
  /** P2-3: 最大自我重试次数（Reflection 深化） */
  maxRetries?: number;
  /** P4-UX: 工具执行期间的实时流式输出回调（如 run_command 的 stdout） */
  onToolProgress?: (toolName: string, text: string) => void;
  /** P1-⑥: 模型主动 awaitUser 时的自由文本回复回调（区别于权限确认的布尔 ask） */
  askText?: (prompt: string) => Promise<string>;
  /** 可取消当前 Agent 运行的 AbortSignal */
  signal?: AbortSignal;
}

const toModelTools = (tools: ToolDef[]) =>
  tools.map((t) => ({
    type: 'function' as const,
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));

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

  // ════════════════════════════════════════
  // P2-3: Plan Mode — 只输出计划，不执行工具
  // ════════════════════════════════════════
  if (opts.planMode) {
    const planInstruction =
      '\n\n【Plan Mode 已开启】请先不要执行任何工具调用。用中文输出你的执行计划：\n' +
      '1. 你打算做什么（目标）\n' +
      '2. 分步骤说明每一步要调用的工具和参数（不实际调用）\n' +
      '3. 预期结果是什么\n' +
      '格式简洁，用编号列表即可。';

    // 临时注入规划指令到用户消息末尾
    const lastMsg = opts.history.getMessages();
    if (lastMsg.length > 0) {
      const last = lastMsg[lastMsg.length - 1];
      if (last.role === 'user') {
        last.content = (last.content || '') + planInstruction;
      }
    }

    // 单次模型调用获取计划
    const modelTools = toModelTools(tools);
    let planContent = '';
    for await (const ev of opts.client.streamChat(lastMsg, modelTools, { signal: opts.signal, timeoutMs: 180_000 })) {
      if (ev.type === 'content' && ev.text) {
        planContent += ev.text;
        yield { type: 'assistant_text', text: ev.text };
      } else if (ev.type === 'error') {
        yield { type: 'error', error: ev.error };
        return;
      } else if (ev.type === 'aborted') {
        yield { type: 'assistant_text', text: '\n（用户已中断计划生成）' };
        yield { type: 'done' };
        return;
      }
    }
    yield { type: 'done' };
    return;
  }
  // ════════════════════════════════════════

  const modelTools = toModelTools(tools);
  const maxIter = opts.maxIterations ?? 12;
  const maxRetries = opts.maxRetries ?? 3; // P2-3: Reflection 重试上限
  let iterations = 0;
  // P1-⑤ 无进展 early-exit 计数器
  let noProgressStreak = 0; // 连续「工具全失败/被拒」轮数
  let repeatCount = 0; // 连续「工具调用完全重复」轮数
  let lastIterSig = ''; // 上一轮工具调用签名（name+args 集合）
  const NO_PROGRESS_LIMIT = 3; // 连续 N 轮无有效进展 → 提前结束
  const REPEAT_LIMIT = 3; // 连续 N 轮工具调用完全一致 → 提前结束

  while (iterations < maxIter) {
    // 用户主动中断：立即结束，不再开启新一轮
    if (opts.signal?.aborted) {
      yield { type: 'assistant_text', text: '\n（用户已中断）' };
      yield { type: 'done' };
      return;
    }
    iterations++;
    logger.debug(`[agent loop] iteration ${iterations}/${maxIter}`);
    const messages = opts.history.getMessages();
    let accContent = '';
    let pendingToolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }> = [];
    let gotToolUse = false;

    for await (const ev of opts.client.streamChat(messages, modelTools, { signal: opts.signal, timeoutMs: 180_000 })) {
      if (ev.type === 'content' && ev.text) {
        accContent += ev.text;
        yield { type: 'assistant_text', text: ev.text };
      } else if (ev.type === 'tool_use' && ev.tools) {
        pendingToolCalls = ev.tools;
        gotToolUse = true;
        // Trace: 模型决定调用工具
        if (trace) {
          await trace.log('model_tool_use', { tools: ev.tools.map((t) => t.name) });
        }
      } else if (ev.type === 'error') {
        if (trace) await trace.log('error', { phase: 'streaming', error: ev.error });
        yield { type: 'error', error: ev.error };
        return;
      } else if (ev.type === 'aborted') {
        if (trace) await trace.log('cancelled', { phase: 'streaming' });
        // 用户中断了流式生成：把已生成的文本作为最终答复收尾
        if (accContent.trim()) {
          opts.history.addAssistant(accContent, undefined);
        }
        yield { type: 'assistant_text', text: '\n（用户已中断）' };
        yield { type: 'done' };
        return;
      }
    }

    const assistantToolCalls: ToolCall[] = pendingToolCalls.map((t) => ({
      id: t.id,
      type: 'function',
      function: { name: t.name, arguments: JSON.stringify(t.arguments) },
    }));
    opts.history.addAssistant(accContent, gotToolUse ? assistantToolCalls : undefined);

    // Trace: 记录完整 assistant 消息（含 tool_calls），供会话重放
    if (trace) {
      await trace.log('assistant_message', {
        content: accContent,
        toolCalls: assistantToolCalls.map((t) => ({ id: t.id, name: t.function.name, arguments: t.function.arguments })),
      });
    }

    // P2-⑨ 任务级 progress/final 标记：本轮若还要调用工具 → 过程叙述；否则 → 最终答复。
    // 确定性区分，无需模型显式输出 <progress>/<final> 标记。
    if (accContent.trim()) {
      yield { type: 'assistant_phase', phase: gotToolUse ? 'progress' : 'final' };
    }

    if (!gotToolUse) {
      await opts.history.compact({ signal: opts.signal });
      yield { type: 'done' };
      return;
    }

    // 执行每个工具调用，经过权限闸门
    const iterToolResults: boolean[] = []; // 本轮各工具是否成功，供 early-exit 判定
    const iterSigParts: string[] = []; // 本轮工具调用签名，供重复检测
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
          yield { type: 'tool_result', toolName: tc.name, result: `用户回复: ${reply}` };
          iterToolResults.push(true);
          continue;
        }

        // 记录本轮工具调用签名（name+args），供重复检测（与 awaitUser 分支互斥）
        iterSigParts.push(`${tc.name}:${JSON.stringify(tc.arguments)}`);
        const def = toolMap.get(tc.name);
        if (!def) {
          const msg = `未知工具: ${tc.name}`;
          opts.history.addToolResult(tc.id, tc.name, JSON.stringify({ ok: false, output: msg }));
          yield { type: 'tool_result', toolName: tc.name, result: msg };
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
          yield { type: 'tool_result', toolName: tc.name, result: denyMsg };
          iterToolResults.push(false);
          continue;
        }

        // Trace: 工具开始执行
        if (trace) await trace.log('tool_call', { tool: tc.name, args: tc.arguments });
        yield { type: 'tool_call', toolName: tc.name, args: tc.arguments };
        const res: ToolResult = await def.execute(tc.arguments as Record<string, unknown>, {
          cwd: opts.cwd,
          signal: opts.signal,
          onProgress: opts.onToolProgress
            ? (text: string) => opts.onToolProgress!(tc.name, text)
            : undefined,
        });

        // P2-⑧ 统一工具结果预算截断：回灌上下文前先按预算裁剪，避免单个超大结果撑爆窗口
        const clampedOutput = clampToolOutput(res.output);
        // P2-3 Reflection: 工具失败时注入反思消息，让 Agent 自我纠正
        if (!res.ok) {
          const reflectionMsg =
            `[工具执行失败 — 请自我纠正]\n` +
            `工具: ${tc.name}\n` +
            `参数: ${JSON.stringify(tc.arguments)}\n` +
            `错误: ${clampedOutput}\n\n` +
            `请分析失败原因，调整策略后重试（换参数、换工具、或换方法）。` +
            `若连续多次失败，请向用户说明情况并请求指示。`;
          opts.history.addToolResult(tc.id, tc.name, JSON.stringify({ ok: false, output: reflectionMsg }));
          if (trace) await trace.log('tool_result', { tool: tc.name, toolCallId: tc.id, name: tc.name, ok: false, output: clampedOutput.slice(0, 3000), reflected: true });
          yield { type: 'tool_result', toolName: tc.name, result: `[失败] ${res.output.slice(0, 500)} → Agent 将自我纠正...` };
          iterToolResults.push(false);
          // 不 continue —— 让循环继续，Agent 会在下一轮收到反思消息并尝试修正
        } else {
          opts.history.addToolResult(tc.id, tc.name, JSON.stringify({ ok: true, output: clampedOutput }));
          if (trace) await trace.log('tool_result', { tool: tc.name, toolCallId: tc.id, name: tc.name, ok: true, output: clampedOutput.slice(0, 3000) });
          yield { type: 'tool_result', toolName: tc.name, result: res.output };
          iterToolResults.push(true);
        }
      } catch (e: unknown) {
        // 任何工具执行路径（包括 awaitUser/ask/exe 抛异常）都必须给当前 tool_call 补一条结果，
        // 否则 assistant 的 tool_calls 后面缺 tool 消息，API 会报 400。
        const isAbort = opts.signal?.aborted || (e instanceof Error && e.name === 'AbortError');
        const err = isAbort ? '用户已中断此工具执行' : `工具执行异常: ${errMsg(e)}`;
        opts.history.addToolResult(tc.id, tc.name, JSON.stringify({ ok: false, output: err }));
        if (trace) await trace.log('tool_result', { tool: tc.name, toolCallId: tc.id, name: tc.name, ok: false, output: err });
        yield { type: 'tool_result', toolName: tc.name, result: err };
        iterToolResults.push(false);
        if (isAbort) {
          yield { type: 'done' };
          return;
        }
      }
    }

    // P1-⑤ 无进展 early-exit：连续工具全失败 或 工具调用完全重复 → 提前结束，避免无意义烧 token
    const anySuccess = iterToolResults.some(Boolean);
    const iterSig = [...iterSigParts].sort().join('|'); // 无序比较：同集合即同签名
    if (anySuccess) noProgressStreak = 0;
    else noProgressStreak++;
    if (iterSig.length > 0 && iterSig === lastIterSig) repeatCount++;
    else repeatCount = 0;
    lastIterSig = iterSig;

    if (noProgressStreak >= NO_PROGRESS_LIMIT) {
      const msg = `连续 ${noProgressStreak} 轮工具调用均无有效进展（可能全部失败或被拒绝），提前结束以避免无意义循环。请检查工具可用性、参数或调整指令后重试。`;
      if (trace) await trace.log('early_exit', { reason: 'no_progress', streak: noProgressStreak });
      yield { type: 'assistant_text', text: msg };
      yield { type: 'done' };
      return;
    }
    if (repeatCount >= REPEAT_LIMIT) {
      const msg = `连续 ${repeatCount} 轮模型发出了完全相同的工具调用（疑似陷入死循环），提前结束。请调整指令或更换策略。`;
      if (trace) await trace.log('early_exit', { reason: 'repeat', streak: repeatCount });
      yield { type: 'assistant_text', text: msg };
      yield { type: 'done' };
      return;
    }

    // P0-①: 每轮迭代末尾检查并压缩上下文，避免长任务连续工具轮次中上下文无限膨胀。
    // compact() 内部按 token 预算阈值（默认 80%）决定是否真正压缩，未超阈值则零开销返回。
    if (gotToolUse) {
      await opts.history.compact({ signal: opts.signal });
      if (trace) await trace.log('context_compact', { estimateTokens: opts.history.estimateTotalTokens() });
    }
    // 继续循环，把工具结果回灌给模型
  }

  // Trace: 会话正常结束
  if (trace) await trace.end();
  yield { type: 'done' };
}
