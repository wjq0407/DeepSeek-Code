import { writeFile, readFile, rm, mkdir, readdir, stat } from 'node:fs/promises';
import { join, dirname, relative, isAbsolute } from 'node:path';

/**
 * 文件级回滚管理器（模块单例）。
 *
 * 解决的问题：多步任务没有回滚能力——某一步把文件写坏了，
 * 之前只能靠回忆 + 手动改回，或从头重跑整个任务。
 *
 * 设计：
 *  - 每个「会改变文件」的工具（create/edit/delete_file）在落盘前调用
 *    snapshot() 记录变更前状态：
 *      create -> 标记「此前不存在」（还原 = 删除刚创建的文件）
 *      edit   -> 存原文件全文（还原 = 写回原文）
 *      delete -> 存被删文件全文（还原 = 重新写回）
 *  - /rollback [n] 撤销最近 n 次文件变更（默认 1 次）。
 *  - 内存栈跨整个会话累积（上限 200），同时把备份内容镜像落盘到
 *    <cwd>/.dsa/backups/，即使进程崩溃、文件已写出，也能从磁盘恢复。
 *  - 按工作目录（cwd）作用域隔离：/rollback 只回退当前 cwd 下的变更，
 *    不会误伤 delegate 子 Agent（其 cwd 不同）的写入。
 *
 * 关键安全约束：rollback 自身执行的「还原写盘」不再入栈，避免
 * 「回滚也能被无限回滚」导致的状态抖动。
 */
export type RollOp = 'create' | 'edit' | 'delete';

export interface RollSnapshot {
  id: string;
  ts: number;
  op: RollOp;
  /** 绝对路径 */
  path: string;
  /** edit/delete 前的文件内容；create 时为 undefined（表示此前不存在） */
  before?: string;
  /** 磁盘备份文件名（.bak），无则 undefined */
  bakFile?: string;
}

const MAX_MEMORY = 200;
const MAX_DISK_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 天
const MAX_BAK_BYTES = 2_000_000; // 超过 2MB 的文件不保留内存副本（只镜像磁盘）
const MEM_RAM_BUDGET = 64 * 1024 * 1024; // 内存中 before 副本累计上限，超过则淘汰最旧副本（靠磁盘 bak 还原）

class RollBackManager {
  private stack: RollSnapshot[] = [];
  private ramBytes = 0; // 内存中 before 副本累计字节数（用于预算淘汰）
  private cwd = process.cwd();

  /** 工具执行时通过 ctx.cwd 告知当前工作目录（每次 snapshot 同步） */
  private dirFor(cwd: string): string {
    return join(cwd, '.dsa', 'backups');
  }

  /**
   * 在文件工具落盘前调用：记录「变更前」状态。
   * @param op      操作类型
   * @param absPath 绝对路径
   * @param before  edit/delete 前的原文（create 不传）
   * @param cwd     当前工作目录（来自 ctx.cwd，用于磁盘隔离）
   */
  async snapshot(op: RollOp, absPath: string, before?: string, cwd = this.cwd): Promise<void> {
    this.cwd = cwd;
    const id = `rb_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const snap: RollSnapshot = { id, ts: Date.now(), op, path: absPath, before };

    // 镜像落盘：edit/delete 存原文（create 不存，还原=删除），供内存副本被淘汰后仍能还原。
    // 不再因文件过大而跳过磁盘镜像（磁盘由 7 天 GC 兜底），确保还原可用。
    if (before !== undefined) {
      try {
        const dir = this.dirFor(cwd);
        await mkdir(dir, { recursive: true });
        const bak = join(dir, `${id}.bak`);
        await writeFile(bak, before, 'utf8');
        snap.bakFile = bak;
      } catch {
        /* 镜像失败不阻塞主流程 */
      }
    }

    // 内存预算：仅小文件（≤ MAX_BAK_BYTES）保留 RAM 副本；大文件只在磁盘 bak，节省内存。
    if (snap.before && snap.before.length > MAX_BAK_BYTES) snap.before = undefined;
    if (snap.before) this.ramBytes += snap.before.length;
    // 超过预算则淘汰最旧快照的 RAM 副本（磁盘 bak 仍在，还原不受影响）
    while (this.ramBytes > MEM_RAM_BUDGET && this.stack.length > 0) {
      const victim = this.stack[0];
      if (victim.before) {
        this.ramBytes -= victim.before.length;
        victim.before = undefined; // 仅丢 RAM 副本，保留快照与磁盘 bak
      } else {
        this.stack.shift(); // 无 RAM 副本可淘汰则直接丢弃该快照
      }
    }

    this.stack.push(snap);
    if (this.stack.length > MAX_MEMORY) {
      const dropped = this.stack.shift();
      if (dropped?.before) this.ramBytes -= dropped.before.length;
    }
  }

  /** 当前可回滚栈（新 -> 旧） */
  list(): RollSnapshot[] {
    return [...this.stack].reverse();
  }

  /**
   * 撤销最近 steps 次文件变更（默认 1）。
   * 仅作用于 cwd 作用域内的快照，避免误伤其他工作目录（如子 Agent）。
   * @returns 人类可读报告
   */
  async rollback(steps = 1, cwd = this.cwd): Promise<string> {
    const targetCwd = cwd || this.cwd;
    if (this.stack.length === 0) {
      return '⚠️ 没有可回滚的文件变更（本次会话尚未写/改/删过文件）。';
    }
    // 仅取当前 cwd 下的快照索引（降序），其余工作目录的写入不动。
    // 用 path.relative 判定归属，兼容正反斜杠混用（如网页端传正斜杠 cwd）。
    const underCwd = (p: string): boolean => {
      const rel = relative(targetCwd, p);
      return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
    };
    const si = this.stack
      .map((s, i) => ({ s, i }))
      .filter(({ s }) => underCwd(s.path))
      .map(({ i }) => i);
    if (si.length === 0) {
      return `⚠️ 当前工作目录下没有可回滚的文件变更（${targetCwd}）。`;
    }
    const n = Math.min(Math.max(1, steps | 0), si.length);
    const pick = si.slice(si.length - n); // 最近 n 个
    const done: string[] = [];
    // 降序删除，保证 index 不偏移
    for (const idx of [...pick].reverse()) {
      const s = this.stack[idx];
      if (!s) continue;
      try {
        if (s.op === 'create') {
          await rm(s.path, { recursive: false, force: true }); // 还原 = 删除刚创建的文件
          done.push(`↩ 撤销创建: ${s.path}`);
        } else {
          // 优先用内存 before；若已被内存预算淘汰，则从磁盘 bak 读回原文还原
          const content =
            s.before ?? (s.bakFile ? await readFile(s.bakFile, 'utf8').catch(() => '') : '');
          await mkdir(dirname(s.path), { recursive: true });
          await writeFile(s.path, content, 'utf8'); // 还原 = 写回 before
          done.push(`↩ 还原${s.op === 'edit' ? '修改' : '删除'}: ${s.path}`);
        }
        if (s.bakFile) {
          try {
            await rm(s.bakFile, { force: true });
          } catch {
            /* ignore */
          }
        }
      } catch (e: unknown) {
        done.push(`⚠️ 还原失败 ${s.path}: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        this.stack.splice(idx, 1); // 还原写盘本身不入栈
      }
    }
    return `已回滚最近 ${done.length} 次文件变更：\n${done.join('\n')}`;
  }

  /** 进程退出/启动时清理过期磁盘备份（>7 天） */
  async gc(cwd = this.cwd): Promise<void> {
    try {
      const dir = this.dirFor(cwd);
      const files = await readdir(dir);
      const now = Date.now();
      for (const f of files) {
        if (!f.endsWith('.bak')) continue;
        try {
          const st = await stat(join(dir, f));
          if (now - st.mtimeMs > MAX_DISK_AGE_MS) await rm(join(dir, f), { force: true });
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* 目录不存在 */
    }
  }
}

/** 单例：所有文件工具与 /rollback 命令共用，跨任务累积回滚栈 */
export const rollbackManager = new RollBackManager();
