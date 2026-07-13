import type { Scope } from './manager.ts';

/**
 * 自然语言记忆意图识别（纯函数，无副作用，便于单测）。
 *
 * 目标：让用户在对话里直接说「记住我偏好 XXX」就自动写入记忆库，
 * 不必手敲 `/memory add|fact`。这是 `/memory` 命令的自然语言快捷入口。
 *
 * 设计原则：
 * - 只识别「句首触发词开头」的纯记忆指令，降低误触发（避免把普通对话里
 *   偶然出现的「记住」当成写入指令）。
 * - 命中返回结构化 intent；未命中返回 null，交回主流程走正常 agent。
 * - 作用域 / 记忆类型都从措辞里推断，给合理默认值，绝不依赖用户懂命令语法。
 * - 复合句「记住X，然后Y」：拆出记忆正文 X 与真实任务 Y，记忆入库、任务照常跑。
 */

/** 一条被识别出的记忆写入意图。 */
export interface MemoryIntent {
  /** 要写入的记忆正文（已剥离触发词、任务部分与首尾标点）。 */
  content: string;
  /** 作用域：含「全局/所有项目」等词→user，否则 project。 */
  scope: Scope;
  /**
   * 记忆类型：
   * - fact     稳定偏好/习惯/约定 → 常驻事实（每次会话注入），默认值。
   * - semantic 情境性、可能变化的信息 → 语义记忆（按需召回）。
   */
  kind: 'fact' | 'semantic';
  /**
   * 复合句里「记忆指令之外」的真实任务。
   * 例：「记住我偏好 pnpm，帮我初始化项目」→ rest = "帮我初始化项目"。
   * 纯记忆指令（无后续任务）为 null，主流程存完即止、不跑 agent。
   */
  rest: string | null;
}

/**
 * 句首触发短语：可选礼貌前缀（请/帮我/麻烦/给我）+ 记忆动词 + 可选标点。
 * 匹配到的整段会从原文剥掉，剩余部分即「记忆正文 + 可选任务」。
 */
const TRIGGER =
  /^\s*(?:请|帮我|麻烦|给我|给你|你要|你得|你要不)?\s*(?:记住|记一下|记下来|记下|牢记|记录一下|记录下来|记录下|记录)\s*[:：,，、\s]*/;

/** 作用域提示：命中则写用户级全局。 */
const GLOBAL_HINT = /(全局|所有项目|跨项目|每个项目|所有的项目|通用偏好|不分项目)/;

/** 语义记忆提示（情境性、可能随时间变化）：命中则写 semantic 而非 fact。 */
const SEMANTIC_HINT = /(正在|目前|现在在|这次|最近|暂时|当前在做|这段时间)/;

/** 剩余正文若以这些语气/否定词开头，多半是疑问或口头语（如「记住了吗」「记下没」），
 *  不是真正要写入的内容 → 判为未命中。 */
const NON_CONTENT_LEAD = /^(了|吗|吧|没|嘛|呢|啊|？|\?|。|！|!)/;

/** 记忆正文最短长度（去标点后），过短视为无有效内容。 */
const MIN_CONTENT_LEN = 2;

/** 复合句边界：标点（记忆与任务的硬分隔）。 */
const TASK_SEP = /[，,。；;、]/;
/**
 * 复合句边界（无标点时）：纯从句连接词，其后通常另起一个任务。
 * 注意只放「连接词」不放动词，避免把记忆正文里的「然后/另外」误判成任务起点。
 */
const TASK_BARE = /(?:然后|另外|顺便|接着|之后|同时|并且|再(?:次|说)?)/;

/**
 * 把「记忆正文 + 可选任务」拆开。
 * 优先按标点切（记忆正文不含标点更干净），其次按无标点的从句连接词切。
 * 命中返回 { memory, rest }；纯记忆指令返回 { memory, rest: null }。
 */
function splitTask(content: string): { memory: string; rest: string | null } {
  const sep = TASK_SEP.exec(content);
  const bare = TASK_BARE.exec(content);
  let idx = -1;
  let len = 0;
  if (sep && (!bare || sep.index <= bare.index)) {
    idx = sep.index;
    len = 1; // 标点只切一刀，rest 从标点后开始
  } else if (bare) {
    idx = bare.index;
    len = bare[0].length; // 连接词本身不进 rest
  }
  if (idx === -1) return { memory: content, rest: null };
  const memory = content.slice(0, idx).trim();
  const rest = content.slice(idx + len).trim();
  if (!memory || !rest) return { memory: content, rest: null };
  return { memory, rest };
}

/**
 * 识别一句用户输入是否是「让我记住某事」的指令。
 * @returns 命中返回 MemoryIntent（含可选 rest 任务）；否则 null。
 */
export function detectMemoryIntent(input: string): MemoryIntent | null {
  const text = input.trim();
  if (!text) return null;

  const m = TRIGGER.exec(text);
  if (!m) return null;

  // 剥掉触发短语，得到候选「记忆正文 + 可选任务」
  let raw = text.slice(m[0].length).trim();
  if (!raw) return null; // 只说了「记一下」没内容
  if (NON_CONTENT_LEAD.test(raw)) return null; // 「记住了吗」这类语气句

  // 拆分记忆正文与可能附带的真实任务
  const { memory, rest } = splitTask(raw);

  // 作用域 / 类型都基于「干净的记忆正文」判定，不被任务部分干扰
  const scope: Scope = GLOBAL_HINT.test(memory) ? 'user' : 'project';
  const kind: 'fact' | 'semantic' = SEMANTIC_HINT.test(memory) ? 'semantic' : 'fact';

  // 去掉记忆正文尾部多余标点
  const content = memory.replace(/[。，,、；;\s]+$/, '').trim();

  // 有效长度校验（中文按字符，去掉标点空白后计数）
  const bare = content.replace(/[\s\p{P}]/gu, '');
  if (bare.length < MIN_CONTENT_LEN) return null;

  return { content, scope, kind, rest };
}
