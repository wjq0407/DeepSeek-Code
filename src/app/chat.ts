/**
 * 框架无关的编排核心（单次事实来源）。
 *
 * 把原 app.tsx 里的 `submit` + `handleCommand` + `runAgent` 事件循环完整移植为
 * 与渲染框架无关的纯逻辑：CLI（ink）与 网页（DOM + 后端）共用同一份。
 *
 * 设计：
 * - 所有「与 UI 相关的副作用」都收口到 `ChatContext` 接口（push / appendStreaming /
 *   beginTool / requestConfirm / setBusy …）。
 * - `runChatTurn(text, ctx)` 驱动一轮对话；`handleSlashCommand` 处理斜杠命令。
 * - 两个实现方：
 *     · useAgentController（React hook）—— 给 ink CLI 用，ctx 落到 React state。
 *     · AgentHost（Node EventEmitter）—— 给网页后端用，ctx 落到事件 + 内存数组。
 *   两者都只是把 ChatContext 的抽象方法映射到自己的渲染/传输层，业务逻辑零重复。
 *
 * 关键约束：本文件只能 import 内核模块与类型，绝不能 import ink / react / 任何
 * 浏览器专用物（否则网页后端一旦间接引用就会把渲染层拉进 Node）。渲染相关（如
 * thinkingIndicator 的 formatDuration）若要复用，请在下方内联等价实现。
 */
import { runAgent, type AgentEvent, type PermissionMode } from '../agent/loop.ts';
import type { StreamErrorCategory } from '../llm/deepseek.ts';
import type { OutputStyle } from '../agent/output-style.ts';
import { styleLabel, styleInstruction, parseStyle, saveStyle } from '../agent/output-style.ts';
import { detectMemoryIntent } from '../memory/intent.ts';
import { extractUserMemories } from '../memory/extractor.ts';
import { reviseMemories, type ReviseResult } from '../memory/revise.ts';
import { msgOf } from '../utils/logger.ts';
import { handleMemory, handleSkills, applyMemoryIntent } from './commands.ts';
import type { AppProps, MsgRole, UiMessage } from './types.ts';
import { TraceLogger } from '../context/trace.ts';
import { rollbackManager } from '../tools/rollback.ts';
import type { ChatMessage } from '../llm/deepseek.ts';

/**
 * UI 抽象契约：编排核心只通过它产生副作用，具体渲染/传输由实现方决定。
 * 实现方必须提供 props / cwd（核心读取内核状态用）。
 */
export interface ChatContext {
  props: AppProps;
  cwd: string;
  /** 新增一条消息，返回其 id */
  push(role: MsgRole, text: string): number;
  /** 向指定 id 的消息追加文本 */
  appendTo(id: number, chunk: string): void;
  /** 流式 assistant 文本：首段建消息，后续追加（实现方维护 streaming id） */
  appendStreaming(chunk: string, reactPhase?: 'thought' | 'action' | 'observation' | 'final' | 'progress'): void;
  /** 本轮流式文本收尾，按 progress/final 标记该消息并收束流。interrupted=true 时标记该气泡为「生成中断」 */
  endStreaming(phase?: 'progress' | 'final', interrupted?: boolean): void;
  /** 直接答复回合：把当前思考轮次已实时流到的文本晋升为最终答案气泡（清空思考盒） */
  prometeThinkingToFinal(): void;
  /** 开始一次工具调用：收束流 + 新建工具消息，返回 id 并记为 current tool */
  beginTool(toolName: string): void;
  /** 实时工具输出（实现方自行加 `  › ` 前缀） */
  appendTool(out: string): void;
  /** 工具调用结束 */
  endTool(): void;
  /**
   * 把本轮错误附加到思考盒——不创建新气泡、不清除已记录的思考。
   * 保证错误与思考过程并存（不替代），所有中间步骤可追溯。
   */
  appendError(msg: string): void;
  setBusy(b: boolean): void;
  setCost(cny: number): void;
  getState(): { mode: PermissionMode; planMode: boolean; outputStyle: OutputStyle };
  /** 迭代轮次上限（0=无上限，正整数=上限）。在 agent-host state 中发送。 */
  maxIterations: number;
  /** 设置迭代轮次上限 */
  setMaxIterations(n: number): void;
  /** 获取当前迭代计数（供 UI 显示） */
  getIterations(): number;
  /** 浏览器观察回灌开关：开 → 每轮结束等待浏览器反馈并自动续跑调试循环 */
  setBrowserWatch(b: boolean): void;
  /** 读取浏览器观察回灌开关 */
  getBrowserWatch(): boolean;
  setMode(m: PermissionMode): void;
  setPlanMode(b: boolean): void;
  setOutputStyle(s: OutputStyle): void;
  /** 注册当前活跃的 AbortController，供 ctx.abort() 中断 */
  setActiveAbort(ac: AbortController | null): void;
  /** 中断当前 Agent 运行 */
  abort(): void;
  /** 权限确认：agent 挂起等待用户 y/n */
  requestConfirm(prompt: string): Promise<boolean>;
  /** 模型主动 awaitUser：agent 挂起等待用户自由文本 */
  requestAskText(prompt: string): Promise<string>;
  getMessages(): UiMessage[];
  setMessages(ms: UiMessage[]): void;
  /** 更换 API Key（UI 专属；未实现则给提示） */
  requestKeyChange?(): void;
  /** 退出（/exit）：实现方决定如何结束（CLI=process.exit，后端=关连接） */
  onExit?(): void;
}

// ── 模块级可变状态（单活跃对话假设，骨架阶段够用） ──
/** 会话结束自动抽取记忆的守卫，确保 /exit 与 waitUntilExit 两个退出路径只跑一次 */
let extractionRan = false;
/** 本轮任务起点（毫秒），用于结束后回显耗时 */
let taskStart = 0;

const SHORTCUTS = [
  '命令：',
  '  /mode explore|ask|execute   切换权限模式',
  '  /plan                       开/关规划模式（只输出计划不执行）',
  '  /style human|pro|raw      切换最终答复风格（人话/专业语言/原始）',
  '  /polish                     按当前风格润色上一条回复',
  '  /cost                       显示累计用量与费用',
  '  /clear                      清空对话上下文',
  '  /compact [n]                手动压缩上下文（保留最近 n 轮，默认 5；超预算也会自动压缩）',
  '  /watch                      切换浏览器观察回灌（开→每轮后等待浏览器报错并自动续跑调试循环）',
  '  ←                           打开会话面板（多 Agent 调度）',
  '  /set-key 或 /login          更换 API Key（保存后下次启动生效）',
  '  /memory add|fact|list|forget   管理跨会话记忆',
  '  /dream                      整理记忆库（去除过期/矛盾/冗余，需 API Key）',
  '  /rollback [n]               回退最近 n 次文件变更（默认 1；仅当前工作目录）',
  '  /resume                    从最近一次会话断点续跑（恢复历史 + 已落盘文件清单）',
  '  /skills list|allow|disallow|clear|all   查看与管理全局技能白名单',
  '  （也可直接说「记住我偏好 XXX」自动写入；复合句「记住X，然后Y」会边存边执行Y）',
  '  Ctrl+C                      中断当前思考 / 工具执行（退出请用 /exit）',
  '  PageUp / PageDown           翻页查看历史消息（思考时也可用）',
  '  Ctrl+End                    跳回最新消息，恢复自动跟随',
  '  /help 或 ?                  显示本面板',
  '  /exit 或 /quit              退出',
].join('\n');

/** 把「润色」系统提示词拼出来（原 app.tsx /polish 同款） */
function polishSystemPrompt(style: OutputStyle): string {
  const kind = style === 'human' ? '面向普通用户的人话' : '专业领域的专业语言';
  const instr = styleInstruction(style) ?? '';
  return `你是文本润色器。把用户给出的原始回复，改写为「${kind}」风格。只输出改写后的正文，不要加任何前缀、解释或引号。\n改写要求：\n${instr}`;
}

/** 时长 → 中文单位（内联，避免从 ink 组件文件导出带来渲染层依赖） */
function formatDuration(sec: number): string {
  if (sec < 60) return sec.toFixed(1) + '秒';
  if (sec < 3600) return `${Math.floor(sec / 60)}分${Math.floor(sec % 60)}秒`;
  return `${Math.floor(sec / 3600)}时${Math.floor((sec % 3600) / 60)}分${Math.floor(sec % 60)}秒`;
}

/** 把内核 ChatMessage[] 转换为 UI 展示用的 UiMessage[]（断点续跑恢复时刷新界面） */
function chatMessagesToUi(msgs: ChatMessage[]): UiMessage[] {
  const out: UiMessage[] = [];
  let id = 0;
  for (const m of msgs) {
    if (m.role === 'system') continue;
    const text = typeof m.content === 'string' ? m.content : '';
    const tc = (m as { tool_calls?: unknown[] }).tool_calls;
    const hasTool = Array.isArray(tc) && tc.length > 0;
    if (!text && !hasTool) continue;
    const role: MsgRole = m.role === 'tool' ? 'tool' : (m.role as MsgRole);
    out.push({ id: id++, role, text: text.slice(0, 4000) });
  }
  return out;
}

/** 会话结束抽取用户偏好到记忆库（幂等守卫） */
export async function runExtraction(props: AppProps): Promise<number> {
  if (extractionRan || !props.cfg.apiKey) return 0;
  extractionRan = true;
  return extractUserMemories(props.client, props.history, props.memoryStore).catch(() => 0);
}

/** 从对话历史取尾部片段，供记忆体检发现「用户已改变主意」。 */
function recentContextOf(history: AppProps['history']): string {
  const msgs = history
    .getMessages()
    .filter((m) => m.role === 'user' || m.role === 'assistant');
  const text = msgs
    .map((m) => (m.role === 'user' ? `[用户] ${m.content ?? ''}` : `[助手] ${m.content ?? ''}`))
    .filter((s) => s.trim())
    .join('\n');
  return text.length > 3000 ? text.slice(-3000) : text;
}

/**
 * 会话结束自动整理记忆（陈旧性治理，带节流 + 幂等守卫）。
 * 复用 extractionRan 同款语义，确保退出路径只跑一次。无 key / 失败安全降级为 null。
 */
let revisionRan = false;
export async function runRevision(props: AppProps): Promise<ReviseResult | null> {
  if (revisionRan || !props.cfg.apiKey) return null;
  revisionRan = true;
  const transcript = recentContextOf(props.history);
  return reviseMemories(props.client, props.memoryStore, { recentContext: transcript, force: false }).catch(
    () => null,
  );
}

/**
 * 斜杠命令处理；返回 true 表示已处理（不跑 agent）。
 * 与渲染无关的纯逻辑，所有副作用走 ctx。
 */
export async function handleSlashCommand(text: string, ctx: ChatContext): Promise<boolean> {
  if (text === '/exit' || text === '/quit') {
    await ctx.props.sessionManager.flush().catch(() => {});
    const n = await runExtraction(ctx.props);
    if (n > 0) ctx.push('system', `会话结束，已自动沉淀 ${n} 条用户偏好到记忆库`);
    const rev = await runRevision(ctx.props);
    if (rev && !rev.skipped && (rev.deleted > 0 || rev.merged > 0)) {
      ctx.push('system', `记忆体检：${rev.summary}`);
    }
    ctx.onExit?.();
    return true;
  }
  if (text === '/help' || text === '?' || text === '？') {
    ctx.push('system', SHORTCUTS);
    return true;
  }
  if (text === '/clear') {
    ctx.props.history.clear();
    ctx.setMessages([]);
    ctx.push('system', '已清空对话上下文');
    return true;
  }
  if (text === '/compact' || text.startsWith('/compact ')) {
    const arg = text.split(/\s+/)[1];
    let keepRounds: number | undefined;
    if (arg && /^\d+$/.test(arg)) keepRounds = parseInt(arg, 10);
    const before = ctx.props.history.getMessages().length;
    const beforeTok = ctx.props.history.estimateTotalTokens();
    ctx.push('system', '正在压缩上下文…');
    try {
      await ctx.props.history.compact({ signal: undefined, force: true, keepRecentRounds: keepRounds });
    } catch (e) {
      ctx.push('system', `⚠️ 压缩失败：${e instanceof Error ? e.message : String(e)}`);
      return true;
    }
    const after = ctx.props.history.getMessages().length;
    const afterTok = ctx.props.history.estimateTotalTokens();
    // 压缩后内部 history 已变，刷新 UI 消息列表，让用户看到对话被摘要替代
    ctx.setMessages(chatMessagesToUi(ctx.props.history.getMessages()));
    if (after === before) {
      ctx.push(
        'system',
        'ℹ️ 当前上下文较短或已在预算内，无需压缩。可指定保留轮数强制压缩，如 /compact 2',
      );
    } else {
      ctx.push(
        'system',
        `✅ 上下文已压缩：${before}→${after} 条消息，${Math.round(beforeTok / 1000)}k→${Math.round(afterTok / 1000)}k tokens` +
          (keepRounds != null ? `（保留最近 ${keepRounds} 轮）` : ''),
      );
    }
    if (ctx.props.traceLogger) {
      await ctx.props.traceLogger.log('manual_compact', { before, after, beforeTok, afterTok, keepRounds });
    }
    return true;
  }
  if (text === '/watch') {
    const next = !ctx.getBrowserWatch();
    ctx.setBrowserWatch(next);
    if (ctx.props.traceLogger) {
      await ctx.props.traceLogger.log('browser_watch', { enabled: next });
    }
    ctx.push(
      'system',
      next
        ? '👁 浏览器观察回灌已开启：每轮结束后会等待浏览器反馈（约 8 秒），若页面上报错误/日志则自动续跑调试循环，直到页面健康或达到续跑上限。'
        : '👁 浏览器观察回灌已关闭：浏览器报错仅实时展示，不再自动触发续跑。',
    );
    return true;
  }
  if (text === '/memory' || text.startsWith('/memory ')) {
    await handleMemory(text, ctx.props.memoryStore, ctx.push);
    return true;
  }
  if (text === '/skills' || text.startsWith('/skills ')) {
    await handleSkills(text, ctx.props.skillManager, ctx.push);
    return true;
  }
  if (text === '/cost') {
    const usage = ctx.props.client.getUsageSummary();
    if (usage.totalTokens === 0) {
      ctx.push('system', '暂无用量记录');
    } else {
      const lines = usage.models
        .map(
          (m) => {
            const hitBase = m.cacheHitTokens + m.cacheMissTokens;
            const hitRate = hitBase > 0 ? `🎯${Math.round((m.cacheHitTokens / hitBase) * 100)}%` : '';
            return `  ${m.model}: 输入 ${m.promptTokens} / 输出 ${m.completionTokens} = ${m.totalTokens}tok | ¥${m.costCny.toFixed(4)}${hitRate ? ` ${hitRate}` : ''}`;
          },
        )
        .join('\n');
      let total = `  合计: ${usage.totalTokens}tok | ¥${usage.totalCostCny.toFixed(4)}`;
      if (usage.totalCacheHitTokens > 0) {
        const base = usage.totalCacheHitTokens + usage.totalCacheMissTokens;
        const rate = Math.round((usage.totalCacheHitTokens / base) * 100);
        total += ` | 🎯 缓存命中 ${usage.totalCacheHitTokens}tok(${rate}%)`;
      }
      ctx.push('system', `=== 累计用量与费用 ===\n${lines}\n${total}`);
    }
    return true;
  }
  if (text.startsWith('/mode')) {
    const m = text.split(' ')[1];
    if (m === 'explore' || m === 'ask' || m === 'execute') {
      ctx.setMode(m);
      const label: Record<string, string> = {
        ask: '任务助理（对话 / 提问，需要你确认才动手）',
        explore: '研究模式（只读探索，不会改动任何文件）',
        execute: '自动执行（Agent 直接干活，无需逐步确认）',
      };
      ctx.push('system', `🔐 权限模式已切换为：${label[m] ?? m}`);
    } else {
      ctx.push('system', '用法: /mode explore|ask|execute');
    }
    return true;
  }
  if (text === '/plan') {
    const next = !ctx.getState().planMode;
    ctx.setPlanMode(next);
    ctx.push('system', `规划模式已${next ? '开启（Agent 将先输出计划）' : '关闭（正常执行）'}`);
    return true;
  }
  if (text === '/style' || text.startsWith('/style ')) {
    const arg = text.slice('/style'.length).trim();
    const cur = ctx.getState().outputStyle;
    if (!arg) {
      ctx.push('system', `当前输出风格：${styleLabel(cur)}  （可选：human 人话 / professional 专业语言 / raw 原始）`);
    } else {
      const s = parseStyle(arg);
      if (!s) {
        ctx.push('system', '用法：/style human | professional | raw');
      } else {
        ctx.setOutputStyle(s);
        saveStyle(ctx.cwd, s);
        ctx.push('system', `输出风格已切换为：${styleLabel(s)}`);
      }
    }
    return true;
  }
  if (text === '/polish' || text.startsWith('/polish ')) {
    const cur = ctx.getState().outputStyle;
    if (cur === 'raw') {
      ctx.push('system', '当前风格为「原始」，无需润色；可用 /style human|professional 切换');
      return true;
    }
    const msgs = ctx.getMessages();
    const lastIdx = [...msgs].reverse().findIndex((m) => m.role === 'assistant' && m.text.trim());
    if (lastIdx === -1) {
      ctx.push('system', '没有可润色的历史回复');
      return true;
    }
    const idx = msgs.length - 1 - lastIdx;
    const original = msgs[idx].text;
    let out = '';
    for await (const ev of ctx.props.client.streamChat(
      [
        { role: 'system', content: polishSystemPrompt(cur) },
        { role: 'user', content: original },
      ],
      [],
      { signal: undefined, timeoutMs: 120_000 },
    )) {
      if (ev.type === 'content' && ev.text) out += ev.text;
      else if (ev.type === 'error') {
        ctx.push('system', `润色失败：${ev.error}`);
        return true;
      }
    }
    if (out.trim()) {
      const polished = out.trim();
      ctx.setMessages(msgs.map((m, i) => (i === idx ? { ...m, text: polished } : m)));
      ctx.push('system', `已按「${styleLabel(cur)}」风格润色上一条回复`);
    } else {
      ctx.push('system', '润色未产生内容');
    }
    return true;
  }
  if (text === '/set-key' || text === '/login') {
    if (ctx.requestKeyChange) ctx.requestKeyChange();
    else ctx.push('system', '更换 API Key 需在终端版执行 /set-key，或编辑 ~/.dsa/credentials.json');
    return true;
  }
  if (text === '/dream') {
    if (!ctx.props.cfg.apiKey) {
      ctx.push('system', '整理记忆需要 API Key，请先在设置中配置');
      return true;
    }
    ctx.push('system', '正在对记忆库做体检（检测过期 / 矛盾 / 冗余）…');
    const transcript = recentContextOf(ctx.props.history);
    const rev = await reviseMemories(ctx.props.client, ctx.props.memoryStore, {
      recentContext: transcript,
      force: true,
    }).catch(() => null);
    if (!rev) ctx.push('system', '记忆体检失败（模型调用异常），已跳过');
    else if (rev.skipped) ctx.push('system', rev.reason ?? '本次无需整理');
    else
      ctx.push(
        'system',
        `记忆体检完成：${rev.summary}${rev.deleted || rev.merged ? '' : '（记忆已较干净）'}`,
      );
    return true;
  }
  if (text === '/rollback' || text.startsWith('/rollback ')) {
    const arg = text.split(/\s+/)[1];
    const steps = arg ? parseInt(arg, 10) : 1;
    const report = await rollbackManager.rollback(Number.isFinite(steps) ? steps : 1, ctx.cwd);
    if (ctx.props.traceLogger) {
      await ctx.props.traceLogger.log('rollback', { steps: Number.isFinite(steps) ? steps : 1, cwd: ctx.cwd });
    }
    ctx.push('system', report);
    return true;
  }
  if (text === '/resume' || text.startsWith('/resume ')) {
    const meta = await TraceLogger.replayMeta(ctx.cwd);
    if (!meta.messages || meta.messages.length === 0) {
      ctx.push('system', '⚠️ 没有可恢复的会话（未找到历史 trace）。');
      return true;
    }
    ctx.props.history.clear();
    ctx.props.history.loadMessages(meta.messages);
    const goal = meta.lastGoal.trim().slice(0, 400) || '（未知目标）';
    const fileList = meta.filesWritten.length
      ? meta.filesWritten.map((f) => `  · ${f}`).join('\n')
      : '  （无文件写入记录）';
    const note =
      `【断点续跑】你此前在做一个任务：\n> ${goal}\n\n` +
      `以下文件已经落盘（不要重复创建 / 修改）：\n${fileList}\n\n` +
      `请基于现有进度继续完成剩余工作，不要重复已经做过的步骤。`;
    ctx.props.history.addUser(note);
    const ui = chatMessagesToUi(meta.messages);
    ui.push({ id: ui.length, role: 'user', text: note });
    ctx.setMessages(ui);
    if (ctx.props.traceLogger) {
      await ctx.props.traceLogger.log('resume', { goal: goal.slice(0, 200), files: meta.filesWritten.length });
    }
    ctx.push(
      'system',
      `✅ 已恢复上次会话（${meta.messages.length} 条消息）。可直接说「继续」让 Agent 接着做。`,
    );
    return true;
  }
  return false;
}

/**
 * 把服务端错误分类映射为面向用户的友好提示（需求③：区分审核拒绝 / token 超限 / 服务不可用）。
 * 原始错误文本仍通过 ctx.appendError 进入思考盒，这里只负责给用户一句能懂的话。
 */
function friendlyErrorMessage(category: StreamErrorCategory | undefined, raw: string): string {
  switch (category) {
    case 'moderation':
      return '🚫 内容审核未通过：服务端拒绝生成该内容（可能涉及敏感/违规话题）。请调整提问方式或措辞后重试。';
    case 'token_limit':
      return '📏 上下文 / token 超出上限：当前对话历史过长，已无法继续生成。建议执行 /compact 压缩历史，或新开一个会话再试。';
    case 'server_unavailable':
      return '🔌 服务端暂时不可用（限流或服务过载）：请稍候片刻后重试；若持续出现，请检查 API Key 配额或网络连通性。';
    default:
      return `⚠️ 生成出错：${raw || '未知错误'}`;
  }
}

/** 把 runAgent 的一个事件映射到 ctx 的 UI 副作用（两个实现方共用） */
function applyRunAgentEvent(ev: AgentEvent, ctx: ChatContext): void {
  if (ev.type === 'assistant_text' && ev.text) {
    ctx.appendStreaming(ev.text, ev.reactPhase);
  } else if (ev.type === 'assistant_phase') {
    ctx.endStreaming(ev.phase);
  } else if (ev.type === 'assistant_promote') {
    ctx.prometeThinkingToFinal();
  } else if (ev.type === 'tool_call') {
    ctx.beginTool(ev.toolName ?? 'tool');
    // use_skill 特殊处理：让用户看到「AI 已调用技能」的友好提示，
    // 而非仅依赖底层的 tool_result 技术输出
    if ((ev.toolName ?? '') === 'use_skill') {
      const argName = String((ev.args as { name?: unknown } | undefined)?.name ?? '').trim();
      ctx.push(
        'system',
        argName
          ? `📚 AI 已调用技能：${argName}（完整使用指引已加载，下一步将按其执行）`
          : '📚 AI 已调用技能加载工具。',
      );
    }
  } else if (ev.type === 'tool_result') {
    ctx.push('tool', `[工具结果] ${String(ev.result ?? '')}`);
  } else if (ev.type === 'error') {
    // 错误必须进思考盒（与原思考过程并存，不替代）——保留中间步骤可追溯
    ctx.appendError(ev.error ?? '未知错误');
    // 同时给一句按分类的友好提示（审核拒绝 / token 超限 / 服务不可用），让用户立刻知道怎么处理
    ctx.push('system', friendlyErrorMessage(ev.errorCategory, ev.error ?? '未知错误'));
  } else if (ev.type === 'system') {
    // 系统提示（如轮次预警），渲染为独立的系统消息，不混入助手气泡
    ctx.push('system', ev.text ?? '');
  } else if (ev.type === 'done') {
    // 用户中断（user_abort）时把最终答案气泡标记为「生成中断」
    ctx.endStreaming(undefined, ev.reason === 'user_abort');
    const usage = ctx.props.client.getUsageSummary();
    ctx.setCost(usage.totalCostCny);
    if (usage.totalTokens > 0) {
      const parts = usage.models
        .map((m) => `${m.model}: ${m.totalTokens}tok(¥${m.costCny.toFixed(4)})`)
        .join(' | ');
      let line = `💰 累计 ${parts} | 合计 ¥${usage.totalCostCny.toFixed(4)}`;
      if (usage.totalCacheHitTokens > 0) {
        const base = usage.totalCacheHitTokens + usage.totalCacheMissTokens;
        const rate = Math.round((usage.totalCacheHitTokens / base) * 100);
        line += ` | 🎯 缓存命中 ${usage.totalCacheHitTokens}tok(${rate}%)`;
      }
      ctx.push('system', line);
    }
    const dur = (Date.now() - taskStart) / 1000;
    ctx.push('system', `⏱ 本次任务耗时 ${formatDuration(dur)}`);
    if (ev.reason && ev.reason !== 'model_stop') {
      const stopLabels: Record<string, string> = {
        user_abort: '⏹ 已因用户中断而停止',
        no_progress: '⚠️ 工具连续失败，已提前结束',
        no_observable_progress: '⚠️ 连续多轮无实质进展，疑似空转，已提前结束',
        repeat_loop: '⚠️ 检测到重复/周期工具调用，疑似死循环，已提前结束',
        max_iterations: '⏱ 已达最大迭代轮数上限，已结束',
      };
      ctx.push('system', stopLabels[ev.reason] ?? `⚠️ 停止原因: ${ev.reason}`);
    }
  }
}

/**
 * 跑一轮对话（CLI 与网页后端共用）。
 * 负责：命令优先 / 自然语言记忆意图 / 调用 runAgent 循环 / 流式事件映射到 ctx。
 */
export async function runChatTurn(raw: string, ctx: ChatContext): Promise<void> {
  const text = raw.trim();
  if (!text) return;

  // 斜杠命令属于「元操作」而非对话内容：不回显为「你」的消息气泡
  // （避免把 /mode ask 这类指令当成对话显示出来），由各命令处理函数自行
  // 推送 system 提醒（如「权限模式已切换为: ask」「规划模式已开启…」）。
  // 仅自然语言才作为用户消息显示。
  const isCommand = text.startsWith('/');
  if (!isCommand) {
    ctx.push('user', text);
  }

  let runText = text;
  if (isCommand) {
    const handled = await handleSlashCommand(text, ctx);
    if (handled) return;
  } else {
    const intent = detectMemoryIntent(text);
    if (intent) {
      await applyMemoryIntent(intent, ctx.props.memoryStore, ctx.push);
      if (intent.rest && intent.rest.trim()) runText = intent.rest.trim();
      else return; // 纯记忆指令，存完即止
    }
  }

  ctx.setBusy(true);
  const abortController = new AbortController();
  ctx.setActiveAbort(abortController);
  taskStart = Date.now();

  try {
    for await (const ev of runAgent(runText, {
      client: ctx.props.client,
      history: ctx.props.history,
      permission: ctx.getState().mode,
      cwd: ctx.cwd,
      tools: ctx.props.tools,
      signal: abortController.signal,
      ask: ctx.requestConfirm,
      askText: ctx.requestAskText,
      trace: ctx.props.traceLogger,
      planMode: ctx.getState().planMode,
      outputStyle: ctx.getState().outputStyle,
      maxIterations: ctx.maxIterations || undefined, // 0=无上限，不传则默认无上限
      onToolProgress: (toolName: string, out: string) => {
        // 实时工具输出：仅当确实在执行某工具时挂到当前工具消息
        if (toolName) ctx.appendTool(out);
      },
    })) {
      applyRunAgentEvent(ev, ctx);
    }
  } catch (e: unknown) {
    // 异常也进思考盒（与本轮已记录的步骤并存），不创建独立错误气泡覆盖上下文
    ctx.appendError(msgOf(e));
  } finally {
    ctx.setBusy(false);
    ctx.setActiveAbort(null);
  }
}
