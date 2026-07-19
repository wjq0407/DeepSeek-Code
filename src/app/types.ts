/**
 * 共享类型：UI 层（ink CLI / 网页 DOM）与内核（Agent Loop）之间的契约。
 *
 * 这些类型只依赖内核模块的类型（全部 type-only 导入），不含任何运行时依赖，
 * 因此即便被「网页前端」以 `import type` 引入也绝不会把 Node 内核拉进浏览器包。
 */
import type { DeepSeekClient } from '../llm/deepseek.ts';
import type { ConversationHistory } from '../context/history.ts';
import type { TraceLogger } from '../context/trace.ts';
import type { ToolDef } from '../tools/index.ts';
import type { SessionManager } from '../agent/session.ts';
import type { MemoryManager } from '../memory/manager.ts';
import type { SkillManager } from '../skills/loader.ts';

/** 消息角色（UI 与内核共用） */
export type MsgRole = 'user' | 'assistant' | 'tool' | 'system' | 'error';

/** UI 层展示的一条消息 */
export interface UiMessage {
  id: number;
  role: MsgRole;
  text: string;
  /** P2-⑨ 任务级标记：progress=过程叙述（暗显），final=最终答复（正常） */
  phase?: 'progress' | 'final';
  /** 该答案气泡对应的「思考盒」轮次 id（仅最终答复气泡带，用于前端把思考卡渲染在气泡上方） */
  thinkingId?: number;
  /** 该气泡因用户中断而只生成了部分内容（前端展示「生成中断」徽章） */
  interrupted?: boolean;
}

/** 内核注入 UI 的 props 契约（main.ts / assemble.ts 负责装配） */
export interface AppProps {
  client: DeepSeekClient;
  history: ConversationHistory;
  tools: ToolDef[];
  cfg: { apiKey: string; baseURL: string; model: string; reasonerModel?: string };
  traceLogger: TraceLogger;
  recentTraces: string[];
  sessionManager: SessionManager;
  /** P5: 启动时从磁盘恢复的历史会话数量（>0 时首屏提示） */
  restoredSessions?: number;
  /** 记忆层：跨会话用户记忆 + 轻量 RAG 预取 */
  memoryStore: MemoryManager;
  /** 应用版本号（来自 package.json，避免与 package.json 多处不一致） */
  version: string;
  /** 技能子系统管理器（项目级 + 全局级，白名单过滤） */
  skillManager: SkillManager;
}
