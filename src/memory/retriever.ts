import type { MemoryEntry } from './types.ts';

/**
 * 语义检索：从记忆库里挑 top-K 与 query 最相关的条目。
 *
 * - 有 query 向量且条目有向量 → 余弦相似度（我们聊过的「比两串数字方向近不近」）。
 * - 任一侧无向量（无 key / 嵌入失败）→ 降级为关键词重叠打分，绝不报错。
 */

/** 一条带分数的检索结果。mode 标记本次打分走的是向量还是关键词降级。 */
export interface ScoredMemory {
  entry: MemoryEntry;
  score: number;
  mode: 'vector' | 'keyword';
}

/** 余弦相似度：0°→1（同向），90°→0（无关），180°→-1（反向）。长度不匹配返回 0。 */
export function cosine(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

/** 把文本切成词元：CJK 按单字切、ASCII 按连续字母数字成词。用于降级打分。 */
function segment(text: string): string[] {
  const matches = text
    .toLowerCase()
    .match(/[一-龥]|[a-z0-9]+/gi);
  return matches ? matches.filter(Boolean) : [];
}

/**
 * 关键词重叠降级：Dice 系数 = 2·共同词元数 / (|q| + |c|)，范围 [0,1] 且对称。
 * 用于无 key / 嵌入失败时的兜底召回与去重。导出供 store 做事实去重。
 */
export function keywordScore(query: string, content: string): number {
  const q = segment(query);
  const c = segment(content);
  if (q.length === 0 || c.length === 0) return 0;
  const setC = new Set(c);
  let common = 0;
  for (const w of q) if (setC.has(w)) common++;
  return (2 * common) / (q.length + c.length);
}

/**
 * 带分数的检索：从记忆库里挑 top-K 与 query 最相关的条目，返回 {entry, score, mode}。
 * 用于去重（需要分数阈值）和常规召回。
 *
 * @param queryEmbedding 已嵌入的 query 向量（null = 触发关键词降级）
 * @param query 原始 query 文本（用于降级）
 * @param entries 候选记忆
 * @param k 返回条数
 */
export function retrieveScored(
  queryEmbedding: number[] | null,
  query: string,
  entries: MemoryEntry[],
  k = 5,
): ScoredMemory[] {
  if (entries.length === 0) return [];
  const scored = entries.map((e) => {
    const useVector = Boolean(queryEmbedding && e.embedding);
    const score = useVector
      ? cosine(queryEmbedding as number[], e.embedding as number[])
      : keywordScore(query, e.content);
    return { entry: e, score, mode: useVector ? ('vector' as const) : ('keyword' as const) };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, k).filter((s) => s.score > 0);
}

/**
 * 不带分数的召回（对外兼容原签名）：等价于 retrieveScored(...).map(s => s.entry)。
 */
export function retrieve(
  queryEmbedding: number[] | null,
  query: string,
  entries: MemoryEntry[],
  k = 5,
): MemoryEntry[] {
  return retrieveScored(queryEmbedding, query, entries, k).map((s) => s.entry);
}
