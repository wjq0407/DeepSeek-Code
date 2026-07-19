import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { MemoryEntry, TrashItem } from './types.ts';
import type { Embedder } from './embedder.ts';
import { retrieve, retrieveScored, keywordScore, type ScoredMemory } from './retriever.ts';

/**
 * 记忆库：单作用域（baseDir 指定目录）双轨记忆的落盘与 CRUD。
 *
 * 两轨：
 * 1. 常驻事实 MEMORY.md —— 人类可读，每次会话整段注入系统提示词（类 Claude Code 的 CLAUDE.md）。
 * 2. 语义记忆 memories.json —— MemoryEntry[]，带 embedding 缓存，启动时语义预取召回。
 *
 * 设计约束（来自架构决策）：
 * - 记忆只服务非代码语义，绝不进入 grep/search 工具链（避免污染代码检索）。
 * - 子 Agent 不加载本库（隔离，保持 delegate 现状）。
 * - 所有写操作落盘；嵌入失败不影响事实记忆与关键词降级检索。
 */
const FACTS_FILE = 'MEMORY.md';
const INDEX_FILE = 'memories.json';
const TRASH_FILE = 'trash.json';
/** 回收站保留时长（ms）：30 天后超期项在下次读取时自动清理。 */
const TRASH_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * 单作用域记忆库。baseDir 由调用方决定：
 * - 项目级 = <cwd>/.dsa/memory
 * - 用户级全局 = ~/.dsa/memory
 * 两层由 MemoryManager 聚合（见 manager.ts）。
 */
export class MemoryStore {
  private dir: string;
  private embedder: Embedder;

  /** ✅ 性能：readIndex 内存缓存，避免每次操作都从磁盘全量重读+解析 JSON */
  private _indexCache: MemoryEntry[] | null = null;
  private _indexDirty = true;
  /** ✅ 性能：MEMORY.md 事实缓存 */
  private _factsCache: string | null = null;
  private _factsDirty = true;

  constructor(baseDir: string, embedder: Embedder) {
    this.dir = baseDir;
    this.embedder = embedder;
  }

  private ensure(): void {
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true });
  }

  /** 原子写：先写临时文件再 rename，避免崩溃/并发导致 MEMORY.md / memories.json 半截损坏 */
  private atomicWrite(p: string, data: string): void {
    this.ensure();
    const tmp = `${p}.tmp`;
    writeFileSync(tmp, data, 'utf8');
    renameSync(tmp, p);
  }

  /** 读取常驻事实全文；文件不存在返回空串。使用缓存避免重复 I/O。 */
  loadFacts(): string {
    if (!this._factsDirty && this._factsCache !== null) return this._factsCache;
    const p = join(this.dir, FACTS_FILE);
    if (!existsSync(p)) {
      this._factsCache = '';
      this._factsDirty = false;
      return '';
    }
    this._factsCache = readFileSync(p, 'utf8').trim();
    this._factsDirty = false;
    return this._factsCache;
  }

  /** 追加一条常驻事实到 MEMORY.md。 */
  addFact(text: string): void {
    this.ensure();
    const p = join(this.dir, FACTS_FILE);
    const existing = this.loadFacts();
    const line = `- ${text.trim()}\n`;
    const sep = existing && !existing.endsWith('\n') ? '\n' : '';
    this.atomicWrite(p, existing + sep + line);
    // ✅ 写完后更新缓存，而非标记脏（避免下次重读整个文件）
    this._factsCache = existing + sep + line;
    this._factsDirty = false;
  }

  private readIndex(): MemoryEntry[] {
    // ✅ 缓存：脏标记为 false 且缓存非 null 时直接返回内存副本
    if (!this._indexDirty && this._indexCache !== null) return this._indexCache;
    const p = join(this.dir, INDEX_FILE);
    if (!existsSync(p)) {
      this._indexCache = [];
      this._indexDirty = false;
      return [];
    }
    try {
      const raw = readFileSync(p, 'utf8');
      const arr = JSON.parse(raw);
      this._indexCache = Array.isArray(arr) ? (arr as MemoryEntry[]) : [];
    } catch {
      this._indexCache = [];
    }
    this._indexDirty = false;
    return this._indexCache;
  }

  private writeIndex(entries: MemoryEntry[]): void {
    this.ensure();
    this._indexCache = entries;
    this._indexDirty = false;
    // ✅ 紧凑 JSON（去掉 null, 2），减少序列化开销和文件尺寸
    this.atomicWrite(join(this.dir, INDEX_FILE), JSON.stringify(entries));
  }

  /** 标记索引缓存脏，下次 readIndex 时重新从磁盘读取 */
  private invalidateIndex(): void {
    this._indexDirty = true;
  }

  /** 新增一条语义记忆（写入时即嵌入并缓存向量）。 */
  async addEntry(content: string, tags?: string[]): Promise<MemoryEntry> {
    const embedding = await this.embedder.embed(content);
    const entry: MemoryEntry = {
      id: randomUUID(),
      content: content.trim(),
      tags,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      embedding: embedding ?? undefined,
    };
    const all = this.readIndex();
    all.push(entry);
    this.writeIndex(all);
    return entry;
  }

  /** 列出全部语义记忆。 */
  list(): MemoryEntry[] {
    return this.readIndex();
  }

  /** 清空全部语义记忆（保留 MEMORY.md 常驻事实）；被清空的条目进回收站可恢复。 */
  clear(): void {
    const all = this.readIndex();
    if (all.length > 0) {
      this.pushTrash(all.map((entry) => this.entryTrash(entry)));
    }
    this.writeIndex([]);
  }

  /** 按 id 前缀删除一条语义记忆（list 展示的是前 8 位，用户粘贴前缀即可）；删除进回收站可恢复。 */
  forget(idPrefix: string): boolean {
    const all = this.readIndex();
    const removed = all.filter((e) => e.id.startsWith(idPrefix));
    if (removed.length === 0) return false;
    const next = all.filter((e) => !e.id.startsWith(idPrefix));
    this.pushTrash(removed.map((entry) => this.entryTrash(entry)));
    this.writeIndex(next);
    return true;
  }

  /** 按内容删除 MEMORY.md 中的一条常驻事实（精确匹配去 `- ` 前缀后的文本）；删除进回收站可恢复。 */
  forgetFact(content: string): boolean {
    const p = join(this.dir, FACTS_FILE);
    if (!existsSync(p)) return false;
    const lines = readFileSync(p, 'utf8').split('\n');
    const target = content.trim();
    const idx = lines.findIndex((l) => l.replace(/^- /, '').trim() === target);
    if (idx === -1) return false;
    lines.splice(idx, 1);
    writeFileSync(p, lines.join('\n'), 'utf8');
    this.pushTrash([{ trashId: randomUUID(), kind: 'fact', deletedAt: Date.now(), fact: target }]);
    return true;
  }

  /** 更新一条语义记忆的内容（保留 id/createdAt，刷新 updatedAt）；供陈旧性治理合并使用。 */
  updateEntry(id: string, content: string): boolean {
    const all = this.readIndex();
    const idx = all.findIndex((e) => e.id === id);
    if (idx === -1) return false;
    all[idx] = { ...all[idx], content: content.trim(), updatedAt: Date.now() };
    this.writeIndex(all);
    return true;
  }

  // ── 回收站（软删除 / 恢复） ──

  /** 把一条语义记忆包装成回收项快照。 */
  private entryTrash(entry: MemoryEntry): TrashItem {
    return { trashId: randomUUID(), kind: 'entry', deletedAt: Date.now(), entry };
  }

  private readTrash(): TrashItem[] {
    const p = join(this.dir, TRASH_FILE);
    if (!existsSync(p)) return [];
    try {
      const arr = JSON.parse(readFileSync(p, 'utf8'));
      if (!Array.isArray(arr)) return [];
      // 读取时顺手清理超期回收项（30 天）
      const now = Date.now();
      const alive = (arr as TrashItem[]).filter((t) => now - (t.deletedAt ?? 0) < TRASH_TTL_MS);
      if (alive.length !== arr.length) this.writeTrash(alive);
      return alive;
    } catch {
      return [];
    }
  }

  private writeTrash(items: TrashItem[]): void {
    this.ensure();
    this.atomicWrite(join(this.dir, TRASH_FILE), JSON.stringify(items, null, 2));
  }

  /** 追加回收项（最新的排前面）。 */
  private pushTrash(items: TrashItem[]): void {
    if (items.length === 0) return;
    const cur = this.readTrash();
    this.writeTrash([...items, ...cur]);
  }

  /** 列出回收站全部条目（已自动过滤超期项）。 */
  listTrash(): TrashItem[] {
    return this.readTrash();
  }

  /** 从回收站恢复一条（entry 写回 memories.json，fact 追加回 MEMORY.md）。 */
  restore(trashId: string): boolean {
    const cur = this.readTrash();
    const item = cur.find((t) => t.trashId === trashId);
    if (!item) return false;
    if (item.kind === 'entry' && item.entry) {
      const all = this.readIndex();
      // 避免重复恢复：同 id 已存在则跳过写入
      if (!all.some((e) => e.id === item.entry!.id)) {
        all.push({ ...item.entry, updatedAt: Date.now() });
        this.writeIndex(all);
      }
    } else if (item.kind === 'fact' && item.fact) {
      this.addFact(item.fact);
    } else {
      return false;
    }
    this.writeTrash(cur.filter((t) => t.trashId !== trashId));
    return true;
  }

  /** 永久清空回收站。 */
  purgeTrash(): void {
    this.writeTrash([]);
  }

  private metaPath(): string {
    return join(this.dir, 'meta.json');
  }

  /** 读取作用域元数据（当前用于陈旧性治理的 lastReviseAt 时间戳）。 */
  getMeta(): { lastReviseAt?: number } {
    try {
      const p = this.metaPath();
      if (!existsSync(p)) return {};
      const obj = JSON.parse(readFileSync(p, 'utf8'));
      return obj && typeof obj === 'object' ? obj : {};
    } catch {
      return {};
    }
  }

  /** 合并写入作用域元数据。 */
  setMeta(patch: { lastReviseAt?: number }): void {
    this.ensure();
    const cur = this.getMeta();
    this.atomicWrite(this.metaPath(), JSON.stringify({ ...cur, ...patch }, null, 2));
  }

  /** 启动语义预取：用 query 检索 top-K 相关记忆（无向量时自动关键词降级）。 */
  async retrieve(query: string, k = 5): Promise<MemoryEntry[]> {
    const qEmbed = await this.embedder.embed(query);
    return retrieve(qEmbed, query, this.readIndex(), k);
  }

  /** 带分数的召回（去重用，需要分数阈值判断是否重复）。 */
  async queryScored(query: string, k = 5): Promise<ScoredMemory[]> {
    const qEmbed = await this.embedder.embed(query);
    return retrieveScored(qEmbed, query, this.readIndex(), k);
  }

  /**
   * 判断 content 是否与现有记忆重复（语义记忆 + 常驻事实都查）。
   * - 向量模式：cosine ≥ 0.82 视为重复。
   * - 关键词降级（无 key/无向量）：重叠率 ≥ 0.6 视为重复。
   * 常驻事实（MEMORY.md）无向量，仅按关键词重叠判定。
   */
  async isDuplicate(content: string): Promise<boolean> {
    const top = (await this.queryScored(content, 1))[0];
    if (top && top.score >= (top.mode === 'vector' ? 0.82 : 0.6)) return true;
    // 常驻事实逐行比较（避免整坨 MEMORY.md 越攒越稀释相似度）
    const facts = this.loadFacts();
    if (facts) {
      const lines = facts
        .split('\n')
        .map((l) => l.replace(/^- /, '').trim())
        .filter(Boolean);
      for (const line of lines) {
        if (keywordScore(content, line) >= 0.6) return true;
      }
    }
    return false;
  }
}
