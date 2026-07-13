import os from 'node:os';
import { join } from 'node:path';
import type { MemoryEntry } from './types.ts';
import { MemoryStore } from './store.ts';
import type { Embedder } from './embedder.ts';
import { composeSystemPrompt } from './composer.ts';
import type { ScoredMemory } from './retriever.ts';

/**
 * 记忆作用域：
 * - 'user'    用户级全局（~/.dsa/memory），跨所有项目共享的偏好与习惯。
 * - 'project' 项目级（<cwd>/.dsa/memory），仅当前项目有效的约定。
 *
 * 对标 Claude Code 的「全局 CLAUDE.md + 项目 CLAUDE.md」双层记忆架构。
 */
export type Scope = 'user' | 'project';

/**
 * 双层记忆聚合器：把用户级全局记忆与项目级记忆统一封装，
 * 对外暴露与单 MemoryStore 兼容的接口，让 main / app / extractor 无需关心分层。
 *
 * 设计约束（延续架构决策）：
 * - 记忆只服务非代码语义，绝不进入 grep/search 工具链。
 * - 子 Agent 不加载本管理器（隔离，保持 delegate 现状）。
 * - 无 API key / 嵌入失败时，两层都自动降级为关键词检索，不报错。
 */
export class MemoryManager {
  readonly user: MemoryStore;
  readonly project: MemoryStore;

  constructor(cwd: string, embedder: Embedder) {
    const home = process.env.HOME ?? process.env.USERPROFILE ?? os.homedir();
    this.user = new MemoryStore(join(home, '.dsa', 'memory'), embedder);
    this.project = new MemoryStore(join(cwd, '.dsa', 'memory'), embedder);
  }

  /** 读取两层的常驻事实（MEMORY.md）。 */
  loadFacts(): { user: string; project: string } {
    return { user: this.user.loadFacts(), project: this.project.loadFacts() };
  }

  /** 追加一条常驻事实；scope 默认项目级。 */
  addFact(text: string, scope: Scope = 'project'): void {
    (scope === 'user' ? this.user : this.project).addFact(text);
  }

  /** 新增一条语义记忆（写入时即嵌入缓存）；scope 默认项目级。 */
  async addEntry(content: string, tags?: string[], scope: Scope = 'project'): Promise<MemoryEntry> {
    return (scope === 'user' ? this.user : this.project).addEntry(content, tags);
  }

  /** 列出两层全部语义记忆，标注作用域。 */
  list(): Array<{ scope: Scope; entry: MemoryEntry }> {
    return [
      ...this.project.list().map((entry) => ({ scope: 'project' as Scope, entry })),
      ...this.user.list().map((entry) => ({ scope: 'user' as Scope, entry })),
    ];
  }

  /** 删除一条语义记忆；scope 指定删哪一层。 */
  forget(idPrefix: string, scope: Scope): boolean {
    return (scope === 'user' ? this.user : this.project).forget(idPrefix);
  }

  /** 合并两层语义预取（各取 top-K 再合并截断，项目级优先）。 */
  async retrieve(query: string, k = 5): Promise<MemoryEntry[]> {
    const [u, p] = await Promise.all([
      this.user.retrieve(query, k),
      this.project.retrieve(query, k),
    ]);
    return [...p, ...u].slice(0, k);
  }

  /** 合并两层带分数召回（去重判定用）。 */
  async queryScored(query: string, k = 5): Promise<ScoredMemory[]> {
    const [u, p] = await Promise.all([
      this.user.queryScored(query, k),
      this.project.queryScored(query, k),
    ]);
    return [...p, ...u];
  }

  /** 任一层命中即视为重复（语义记忆 + 常驻事实都查）。 */
  async isDuplicate(content: string): Promise<boolean> {
    return (await this.user.isDuplicate(content)) || (await this.project.isDuplicate(content));
  }

  /**
   * 一键产出最终系统提示词：两层常驻事实 + 启动语义预取。
   *
   * 相关性兜底：向量模式下对召回结果应用最低相似度阈值（VECTOR_MIN_SCORE），
   * 避免低分噪声记忆污染纯代码任务；关键词降级模式不强制阈值（降级本就宽松，
   * 仅作兜底召回，按 K 取 top 即可）。
   */
  async compose(base: string, query: string, k = 5): Promise<string> {
    const facts = this.loadFacts();
    if (!query) return composeSystemPrompt(base, facts.user, facts.project, []);
    const scored = await this.queryScored(query, k);
    const VECTOR_MIN_SCORE = 0.3;
    const retrieved = scored
      .filter((s) => s.mode === 'keyword' || s.score >= VECTOR_MIN_SCORE)
      .map((s) => s.entry);
    return composeSystemPrompt(base, facts.user, facts.project, retrieved);
  }
}
