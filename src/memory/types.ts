/** 一条语义记忆条目（episodic memory）。 */
export interface MemoryEntry {
  /** 唯一 id（uuid） */
  id: string;
  /** 记忆文本 */
  content: string;
  /** 可选标签，便于分类检索 */
  tags?: string[];
  /** 创建时间戳（ms） */
  createdAt: number;
  /** 最近更新时间戳（ms）；新增时等于 createdAt。为陈旧性治理（Dreaming 式后台修订）预留数据基础 */
  updatedAt?: number;
  /** 写入时缓存的向量；无 embedding key / 嵌入失败时缺失 */
  embedding?: number[];
}

/**
 * 回收站条目：记忆被删除前的快照，支持撤销恢复。
 * 对齐 ChatGPT / Notion 等「删除进回收站、可恢复、超期自动清理」的软删除模式。
 */
export interface TrashItem {
  /** 回收项唯一 id（uuid），用于恢复引用 */
  trashId: string;
  /** 被删对象类型：语义记忆 / 常驻事实 */
  kind: 'entry' | 'fact';
  /** 删除时间戳（ms），用于展示与超期清理 */
  deletedAt: number;
  /** kind==='entry' 时的完整记忆快照（恢复时原样写回） */
  entry?: MemoryEntry;
  /** kind==='fact' 时的事实文本（恢复时追加回 MEMORY.md） */
  fact?: string;
}
