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
  /** 写入时缓存的向量；无 embedding key / 嵌入失败时缺失 */
  embedding?: number[];
}
