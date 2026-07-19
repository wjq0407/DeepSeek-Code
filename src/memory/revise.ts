import type { DeepSeekClient } from '../llm/deepseek.ts';
import type { MemoryManager, Scope } from './manager.ts';
import type { MemoryEntry } from './types.ts';

/**
 * 陈旧性治理（Dreaming 式后台修订）：定期用模型审查记忆库，清理
 * 「矛盾 / 过期 / 冗余 / 含糊」记忆，让记忆从「只增不修」进化为「会自动纠偏」。
 *
 * 对标 ChatGPT 的 Dreaming 与 Mem0 的时间线治理。核心是一次低成本的模型审查，
 * 复用为可随时调用的「记忆体检」：内部矛盾合并、过期移除、重复去重。
 *
 * 设计边界（与安全降级一致）：
 * - 离线 / 无 key / LLM 异常均安全降级为 no-op（返回空 summary、skipped=true）。
 * - 默认带节流：不足 MIN_ENTRIES 条，或距上次整理 < 24h 则跳过；
 *   手动 /dream（CLI）或 Web 手动「整理记忆」用 force=true 绕过节流。
 */

/** 记忆条目不足该数量不值得跑体检（避免对 trivial 记忆花 token）。 */
const MIN_ENTRIES = 4;
/** 自动体检最小间隔（ms）：24 小时。 */
const REVISE_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** 近期对话片段截断上限（字符），只取尾部用于发现「用户已改变主意」。 */
const MAX_CONTEXT_CHARS = 3000;

interface RevisePlan {
  deletes: string[];
  merges: { keep: string; remove: string[]; content: string }[];
  notes: string;
}

/**
 * 体检方案里单条「待办动作」的可读结构（供 UI 预览，也供 applyProposal 执行）。
 * - delete / merge_remove：最终都会把该条目 forget 进回收站（可撤销）。
 * - merge_keep：把 keep 条目更新为更干净的合并表述（target），不删除。
 * `content` 为受影响条目当前内容（预览展示），`target` 为合并后的目标内容。
 */
export type ReviseActionKind = 'delete' | 'merge_remove' | 'merge_keep';

export interface ReviseAction {
  kind: ReviseActionKind;
  scope: Scope;
  id: string;
  content: string;
  target?: string;
  reason: string;
}

/** 一次体检的「提案」（不执行）：UI 先预览它，用户确认后再 apply。 */
export interface ReviseProposal {
  actions: ReviseAction[];
  /** 模型给的一句话说明（notes） */
  summary: string;
  /** 是否跳过（不足阈值 / 节流 / 无记忆 / 失败） */
  skipped: boolean;
  /** 跳过原因（skipped=true 时有意义） */
  reason?: string;
}

const REVISE_SYS = [
  '你是一个「记忆体检器」。下面是一份 AI 编程助手的长期记忆库（跨会话复用的用户偏好/约定）。',
  '请审查这些记忆，找出并整理以下问题：',
  '1. 矛盾：两条记忆表达相反的事实或偏好（如一条说「用 React」另一条说「不用 React」）。',
  '2. 过期/被取代：某条记忆已被更具体、更新的记忆取代。',
  '3. 冗余：两条记忆意思几乎一样（重复）。',
  '4. 含糊/不可执行：记忆过于空泛、无法作为稳定偏好（如「用户很 nice」）。',
  '',
  '【整理动作】',
  '- 对矛盾/过期/冗余：保留更通用或更准确的那条作为 keep，其余放进 remove（删除）。',
  '  若需把几条合并成一条更干净的表述，给出合并后的 content。',
  '- 仅当某条确实无意义、且无合并价值时，才放入 deletes（直接删除、不合并）。',
  '【id 引用】每条记忆前方有 [8位id] 前缀，请严格使用该前缀引用。',
  '【输出格式】严格 JSON，不要任何解释文字：',
  '{"deletes":["id前缀",...],"merges":[{"keep":"keep的id前缀","remove":["要删的id前缀",...],"content":"合并后的干净表述"}],"notes":"一句话中文说明你做了什么"}',
].join('\n');

/** 解析模型返回的整理方案；任何异常/非法都降级为空方案（安全）。 */
function parsePlan(raw: string, validIds: Set<string>): RevisePlan {
  if (!raw) return { deletes: [], merges: [], notes: '' };
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = (fenced ? fenced[1] : raw).trim();
  let data: unknown;
  try {
    data = JSON.parse(body);
  } catch {
    return { deletes: [], merges: [], notes: '' };
  }
  const obj = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>;
  const idsOf = (v: unknown): string[] => {
    if (!Array.isArray(v)) return [];
    return v
      .map((x) => (typeof x === 'string' ? x.slice(0, 8) : ''))
      .filter((x) => x && validIds.has(x));
  };
  const mergesRaw = Array.isArray(obj.merges) ? (obj.merges as unknown[]) : [];
  const merges = mergesRaw
    .map((m) => {
      if (!m || typeof m !== 'object') return null;
      const rec = m as Record<string, unknown>;
      const keep = typeof rec.keep === 'string' ? rec.keep.slice(0, 8) : '';
      if (!keep || !validIds.has(keep)) return null;
      const content = typeof rec.content === 'string' ? rec.content.trim() : '';
      if (!content) return null;
      return { keep, remove: idsOf(rec.remove).filter((x) => x !== keep), content };
    })
    .filter((x): x is { keep: string; remove: string[]; content: string } => x !== null);
  return {
    deletes: idsOf(obj.deletes),
    merges,
    notes: typeof obj.notes === 'string' ? obj.notes.trim() : '',
  };
}

export interface ReviseResult {
  /** 删除（含合并时被移除）的条数 */
  deleted: number;
  /** 合并的组数 */
  merged: number;
  /** 给用户的简短中文说明 */
  summary: string;
  /** 是否跳过（不足阈值 / 节流 / 无记忆 / 失败） */
  skipped: boolean;
  /** 跳过原因（skipped=true 时有意义） */
  reason?: string;
}

/**
 * 生成体检「提案」——只调用模型、解析方案、组装可读动作，**不执行任何删除/合并**。
 * 返回的是给用户预览的清单；真正的落盘在 applyProposal 里按用户确认进行。
 *
 * @param opts.recentContext 可选：用户近期对话片段，用于发现「用户已改变主意」与旧记忆冲突。
 * @param opts.force true 时跳过节流强制整理（/dream 命令、Web 手动整理用）。
 */
export async function proposeRevise(
  client: DeepSeekClient,
  store: MemoryManager,
  opts: { recentContext?: string; force?: boolean } = {},
): Promise<ReviseProposal> {
  const entries = store.list();
  const skippedBase: ReviseProposal = { actions: [], summary: '', skipped: true };

  if (!opts.force) {
    if (entries.length < MIN_ENTRIES) {
      return { ...skippedBase, reason: `记忆条目不足 ${MIN_ENTRIES} 条，暂无需整理` };
    }
    const last = store.user.getMeta().lastReviseAt ?? 0;
    if (Date.now() - last < REVISE_INTERVAL_MS) {
      return { ...skippedBase, reason: '距上次整理不足 24 小时，已跳过（可输入 /dream 强制整理）' };
    }
  }
  if (entries.length === 0) {
    return { ...skippedBase, reason: '暂无可整理的记忆' };
  }

  // 建立 8位id → {scope, fullId, entry} 映射（用 8 位前缀便于模型引用，且 uuid 前缀实际唯一）
  const map = new Map<string, { scope: Scope; fullId: string; entry: MemoryEntry }>();
  const listed = entries
    .map((e) => {
      const id8 = e.entry.id.slice(0, 8);
      map.set(id8, { scope: e.scope, fullId: e.entry.id, entry: e.entry });
      return `- [${id8}] (${e.scope}) ${e.entry.content}`;
    })
    .join('\n');

  const ctx = opts.recentContext
    ? `\n\n【用户近期对话片段，用于发现「用户已改变主意」与旧记忆冲突的情况】\n${opts.recentContext.slice(-MAX_CONTEXT_CHARS)}`
    : '';

  const userMsg = `以下是当前记忆库的全部语义记忆：\n${listed}${ctx}\n\n请审查并返回整理方案（严格 JSON）：`;

  let plan: RevisePlan = { deletes: [], merges: [], notes: '' };
  try {
    const raw = await client.complete(
      [
        { role: 'system', content: REVISE_SYS },
        { role: 'user', content: userMsg },
      ],
      0.2,
      { modelOverride: client.primaryModel, jsonMode: true, timeoutMs: 90_000 },
    );
    if (raw && !raw.startsWith('子任务调用失败')) {
      plan = parsePlan(raw, new Set(map.keys()));
    }
  } catch {
    return { ...skippedBase, reason: '记忆体检调用模型失败，已跳过' };
  }

  // 把模型的结构化方案翻译成可读、可执行的动作清单（供 UI 预览与后续 apply）
  const actions: ReviseAction[] = [];
  for (const id8 of plan.deletes) {
    const m = map.get(id8);
    if (m) {
      actions.push({
        kind: 'delete',
        scope: m.scope,
        id: m.fullId,
        content: m.entry.content,
        reason: '模型判定为过期 / 冗余 / 矛盾，建议删除',
      });
    }
  }
  for (const mg of plan.merges) {
    const keepM = map.get(mg.keep);
    if (!keepM) continue;
    for (const r of mg.remove) {
      const rm = map.get(r);
      if (rm && rm.fullId !== keepM.fullId) {
        actions.push({
          kind: 'merge_remove',
          scope: rm.scope,
          id: rm.fullId,
          content: rm.entry.content,
          reason: `重复 / 被取代，将并入：${mg.content}`,
        });
      }
    }
    actions.push({
      kind: 'merge_keep',
      scope: keepM.scope,
      id: keepM.fullId,
      content: keepM.entry.content,
      target: mg.content,
      reason: `保留并合并更新为：${mg.content}`,
    });
  }

  return { actions, summary: plan.notes, skipped: false };
}

/**
 * 执行一份体检提案：删除/合并动作落盘（删除项先进回收站，可撤销），并刷新整理时间戳。
 * 与 proposeRevise 解耦，使 Web 端可以先预览、用户确认后再 apply。
 */
export function applyProposal(store: MemoryManager, proposal: ReviseProposal): ReviseResult {
  let deleted = 0;
  let merged = 0;
  for (const a of proposal.actions) {
    if (a.kind === 'delete' || a.kind === 'merge_remove') {
      if (store.forget(a.id.slice(0, 8), a.scope)) deleted++;
    } else if (a.kind === 'merge_keep') {
      const target = a.scope === 'user' ? store.user : store.project;
      if (target.updateEntry(a.id, a.target ?? a.content)) merged++;
    }
  }
  // 记录整理时间（两层都写，保证节流一致）
  store.user.setMeta({ lastReviseAt: Date.now() });
  store.project.setMeta({ lastReviseAt: Date.now() });

  const summary = proposal.summary || `记忆体检完成：删除 ${deleted} 条、合并 ${merged} 组。`;
  return { deleted, merged, summary, skipped: false };
}

/**
 * CLI 直接整理（/dream 命令、退出时自动体检）：propose + apply 一步到位。
 * Web 端不再走这里，改为先 propose 预览、用户确认后再 apply。
 */
export async function reviseMemories(
  client: DeepSeekClient,
  store: MemoryManager,
  opts: { recentContext?: string; force?: boolean } = {},
): Promise<ReviseResult> {
  const proposal = await proposeRevise(client, store, opts);
  if (proposal.skipped) {
    return { deleted: 0, merged: 0, summary: '', skipped: true, reason: proposal.reason };
  }
  return applyProposal(store, proposal);
}
