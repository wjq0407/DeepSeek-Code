import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { MemoryEntry } from './types.ts';
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

/**
 * 单作用域记忆库。baseDir 由调用方决定：
 * - 项目级 = <cwd>/.dsa/memory
 * - 用户级全局 = ~/.dsa/memory
 * 两层由 MemoryManager 聚合（见 manager.ts）。
 */
export class MemoryStore {
  private dir: string;
  private embedder: Embedder;

  constructor(baseDir: string, embedder: Embedder) {
    this.dir = baseDir;
    this.embedder = embedder;
  }

  private ensure(): void {
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true });
  }

  /** 读取常驻事实全文；文件不存在返回空串。 */
  loadFacts(): string {
    const p = join(this.dir, FACTS_FILE);
    if (!existsSync(p)) return '';
    return readFileSync(p, 'utf8').trim();
  }

  /** 追加一条常驻事实到 MEMORY.md。 */
  addFact(text: string): void {
    this.ensure();
    const p = join(this.dir, FACTS_FILE);
    const existing = existsSync(p) ? readFileSync(p, 'utf8') : '';
    const line = `- ${text.trim()}\n`;
    const sep = existing && !existing.endsWith('\n') ? '\n' : '';
    writeFileSync(p, existing + sep + line, 'utf8');
  }

  private readIndex(): MemoryEntry[] {
    const p = join(this.dir, INDEX_FILE);
    if (!existsSync(p)) return [];
    try {
      const raw = readFileSync(p, 'utf8');
      const arr = JSON.parse(raw);
      return Array.isArray(arr) ? (arr as MemoryEntry[]) : [];
    } catch {
      return [];
    }
  }

  private writeIndex(entries: MemoryEntry[]): void {
    this.ensure();
    writeFileSync(join(this.dir, INDEX_FILE), JSON.stringify(entries, null, 2), 'utf8');
  }

  /** 新增一条语义记忆（写入时即嵌入并缓存向量）。 */
  async addEntry(content: string, tags?: string[]): Promise<MemoryEntry> {
    const embedding = await this.embedder.embed(content);
    const entry: MemoryEntry = {
      id: randomUUID(),
      content: content.trim(),
      tags,
      createdAt: Date.now(),
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

  /** 按 id 前缀删除一条语义记忆（list 展示的是前 8 位，用户粘贴前缀即可）。 */
  forget(idPrefix: string): boolean {
    const all = this.readIndex();
    const next = all.filter((e) => !e.id.startsWith(idPrefix));
    if (next.length === all.length) return false;
    this.writeIndex(next);
    return true;
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
