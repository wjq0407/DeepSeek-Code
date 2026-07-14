import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * 历史对话可视化面板的数据源：deepseek-code-agent 自己的聊天记录。
 *
 * 与 WorkBuddy 全局库（~/.workbuddy/workbuddy.db 的 sessions 表）无关——
 * 那个库是 IDE 跨所有项目的会话汇总，不属于本 deepseek 项目。
 * 本项目真实的聊天记录由 TraceLogger 持久化在 `<cwd>/.dsa/traces/*.jsonl`，
 * 每个文件是一个独立会话（session_start / user_input / assistant_message …）。
 * 另有少量子 Agent 会话存档在 `<cwd>/.dsa/sessions/*.json`（通常为空，合并时无害）。
 */

/** 一条历史会话（已归一化，来源均为 deepseek 自身） */
export interface HistoryItem {
  id: string;
  title: string;
  cwd: string;
  model: string | null;
  status: string;
  /** 固定为 'deepseek'，便于未来区分其他来源 */
  sourceMode: string | null;
  /** 会话权限模式（来自 session_start.permission）：ask / execute / explore / bypass 等 */
  permissionMode: string | null;
  createdAt: number;
  updatedAt: number;
  source: 'deepseek-trace' | 'deepseek-local';
  /** 会话内的 assistant 消息数（用于 KPI 与列表展示） */
  messageCount: number;
}

/** 解析单个 trace jsonl，提取会话元数据；格式不符返回 null */
function parseTrace(id: string, txt: string, fallbackCwd: string): HistoryItem | null {
  const lines = txt.split('\n').filter(Boolean);
  if (lines.length === 0) return null;
  let start: Record<string, unknown> | null = null;
  let title: string | null = null;
  let createdAt = 0;
  let updatedAt = 0;
  let messageCount = 0;
  let hasExit = false;
  for (const ln of lines) {
    let ev: Record<string, any>;
    try {
      ev = JSON.parse(ln);
    } catch {
      continue;
    }
    const ts = typeof ev.timestamp === 'string' ? Date.parse(ev.timestamp) : 0;
    if (ts) {
      if (!createdAt) createdAt = ts;
      updatedAt = ts;
    }
    if (ev.type === 'session_start') {
      start = ev.payload ?? {};
    } else if (ev.type === 'user_input') {
      const inp = ev.payload?.input;
      if (typeof inp === 'string' && !title) title = inp;
      if (inp === 'exit' || inp === '/exit') hasExit = true;
    } else if (ev.type === 'assistant_message') {
      messageCount++;
    }
  }
  if (!start) return null;
  return {
    id,
    title: title ?? '(无标题)',
    cwd: typeof start.cwd === 'string' ? start.cwd : fallbackCwd,
    model: (start.model as string | undefined) ?? null,
    status: hasExit ? 'completed' : 'working',
    sourceMode: 'deepseek',
    permissionMode: (start.permission as string | undefined) ?? null,
    createdAt,
    updatedAt,
    source: 'deepseek-trace',
    messageCount,
  };
}

/** 读取 <cwd>/.dsa/traces/*.jsonl —— deepseek 自身的历史聊天记录 */
async function readTraces(cwd: string): Promise<HistoryItem[]> {
  const dir = join(cwd, '.dsa', 'traces');
  try {
    const files = (await readdir(dir)).filter((f) => f.endsWith('.jsonl'));
    const out: HistoryItem[] = [];
    for (const f of files) {
      try {
        const txt = await readFile(join(dir, f), 'utf8');
        const item = parseTrace(f.replace(/\.jsonl$/, ''), txt, cwd);
        if (item) out.push(item);
      } catch {
        /* 跳过损坏文件 */
      }
    }
    return out;
  } catch {
    return [];
  }
}

/** 读取 <cwd>/.dsa/sessions/*.json —— 子 Agent 会话存档（当前通常为空，合并时无害） */
async function readLocalSessions(cwd: string): Promise<HistoryItem[]> {
  const dir = join(cwd, '.dsa', 'sessions');
  try {
    const files = (await readdir(dir)).filter((f) => f.endsWith('.json'));
    const out: HistoryItem[] = [];
    for (const f of files) {
      try {
        const rec = JSON.parse(await readFile(join(dir, f), 'utf8')) as Record<string, unknown>;
        if (!rec || typeof rec.id !== 'string') continue;
        out.push({
          id: rec.id,
          title: typeof rec.title === 'string' ? rec.title : '(无标题)',
          cwd,
          model: null,
          status: typeof rec.status === 'string' ? rec.status : 'unknown',
          sourceMode: 'deepseek',
          permissionMode: null,
          createdAt: Number(rec.createdAt ?? 0),
          updatedAt: Number(rec.updatedAt ?? 0),
          source: 'deepseek-local',
          messageCount: 0,
        });
      } catch {
        /* 跳过损坏文件 */
      }
    }
    return out;
  } catch {
    return [];
  }
}

/** 合并两个来源；traces 在前，local 在后，按 id 去重；按创建时间倒序。 */
export async function loadHistorySessions(cwd: string): Promise<HistoryItem[]> {
  const [trace, local] = await Promise.all([readTraces(cwd), readLocalSessions(cwd)]);
  const seen = new Set<string>();
  const merged: HistoryItem[] = [];
  for (const r of trace) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    merged.push(r);
  }
  for (const r of local) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    merged.push(r);
  }
  merged.sort((a, b) => b.createdAt - a.createdAt);
  return merged;
}
