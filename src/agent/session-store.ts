import { mkdir, writeFile, readFile, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { ChatMessage } from '../llm/deepseek.ts';

/**
 * P5 会话持久化层。
 *
 * 把多会话面板里的会话（主要是后台 child 子 Agent 会话）序列化到磁盘，
 * 进程重启后可由 SessionManager.restore() 重新加载，面板里即可看到历史会话。
 *
 * 存储布局：`<workspaceDir>/.dsa/sessions/{id}.json`
 * 每个文件是一个自包含的 SessionRecord，包含：
 * - 元数据：id / title / kind / status / createdAt / updatedAt
 * - systemPrompt：用于重建 ConversationHistory（恢复时不复用运行时 system）
 * - messages：对话消息数组（不含 system，恢复时由 ConversationHistory 自带 system 接管）
 * - output：会话最终输出文本（面板预览用）
 *
 * 设计取舍：
 * - 只持久化 child 会话，main 当前会话由 TraceLogger.replay 负责（避免两套管线冲突）。
 * - 写失败静默忽略，不阻塞主流程（持久化是增强特性，不应影响 Agent 运行）。
 */

export type StoredSessionStatus = 'working' | 'needs_input' | 'completed' | 'error';

export interface SessionRecord {
  id: string;
  title: string;
  kind: 'main' | 'child';
  status: StoredSessionStatus;
  /** 重建 history 用；child 默认 SUBAGENT_SYSTEM */
  systemPrompt: string;
  /** 不含 system 的消息数组 */
  messages: ChatMessage[];
  output: string;
  createdAt: number;
  updatedAt: number;
  /** 标记来源：true 表示跨进程恢复的历史存档（区别于本次运行产生的会话） */
  archived: boolean;
}

export class SessionStore {
  private dir: string;

  constructor(workspaceDir: string) {
    this.dir = join(workspaceDir, '.dsa', 'sessions');
  }

  private async ensureDir(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
  }

  /** 写入（覆盖）单个会话 */
  async save(rec: SessionRecord): Promise<void> {
    try {
      await this.ensureDir();
      await writeFile(join(this.dir, `${rec.id}.json`), JSON.stringify(rec), 'utf8');
    } catch {
      /* 写失败不阻塞主流程 */
    }
  }

  /** 删除单个会话文件（移除会话时调用） */
  async remove(id: string): Promise<void> {
    try {
      await unlink(join(this.dir, `${id}.json`));
    } catch {
      /* 文件不存在等错误忽略 */
    }
  }

  /** 加载目录下全部会话记录（损坏文件跳过） */
  async loadAll(): Promise<SessionRecord[]> {
    try {
      await this.ensureDir();
      const files = (await readdir(this.dir)).filter((f) => f.endsWith('.json'));
      const out: SessionRecord[] = [];
      for (const f of files) {
        try {
          const txt = await readFile(join(this.dir, f), 'utf8');
          const rec = JSON.parse(txt) as SessionRecord;
          if (rec && typeof rec.id === 'string') out.push(rec);
        } catch {
          /* 跳过损坏文件 */
        }
      }
      // 按更新时间升序，保证面板顺序稳定（旧在上）
      out.sort((a, b) => a.updatedAt - b.updatedAt);
      return out;
    } catch {
      return [];
    }
  }
}
