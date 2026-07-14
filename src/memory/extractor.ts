import type { ChatMessage, DeepSeekClient } from '../llm/deepseek.ts';
import type { ConversationHistory } from '../context/history.ts';
import type { MemoryManager } from './manager.ts';

/**
 * 会话结束自动抽取用户偏好（Phase 3）：把一次会话里「跨会话稳定、可复用」的用户偏好
 * 抽成记忆条目，去重后沉淀进记忆库（fact → MEMORY.md，semantic → memories.json）。
 *
 * 设计边界（呼应既有记忆层原则）：
 * - 只服务非代码语义，抽取产物一律进记忆库，绝不进 grep 工具链。
 * - 离线/无 key/LLM 异常均安全降级为 no-op（返回 0）。
 * - 抽取用主模型（flash）+ 关思考，单次调用，成本可控。
 */

/** 一条被抽出的记忆项。 */
interface ExtractedItem {
  content: string;
  /** fact=永远成立的硬事实（进 MEMORY.md）；semantic=靠相似度召回的偏好（进 memories.json） */
  kind: 'fact' | 'semantic';
  tags: string[];
}

/** transcript 太短（字符数）则跳过，避免对 trivial 会话花 token。 */
const MIN_TRANSCRIPT_CHARS = 200;
/** 单次会话最多新增的记忆条数，防记忆库膨胀。 */
const MAX_ITEMS = 10;
/** transcript 截断上限（字符），1M 上下文足够，但抽取只需近期重点。 */
const MAX_TRANSCRIPT_CHARS = 6000;

const EXTRACT_SYS = [
  '你是一个「用户记忆萃取器」。请从一段 AI 编程助手的对话记录中，提取用户明确表达过的、',
  '跨会话稳定且可复用的偏好与约定。',
  '',
  '【只抽取以下类型】',
  '1. 编码风格：命名/格式/注释（如「偏好中文注释」「用 Tab 缩进」）。',
  '2. 语言/技术栈偏好：如「前端用 React + TS」「不用 class 组件」。',
  '3. 项目约定：用户声明的目录结构、构建命令、测试习惯。',
  '4. 用户纠正：用户说「别用 X」「我习惯 Y」这类明确指示。',
  '5. 协作偏好：如「讲解用费曼法」「图表要高对比」。',
  '',
  '【严禁抽取】',
  '- 一次性任务细节、具体文件内容、临时 bug、待办清单。',
  '- 对话里没明确表达的猜测；不要编造。',
  '',
  '【每条标注 kind】',
  '- kind="fact"：永远成立、每次会话都应注入的硬事实（如语言/栈/稳定习惯）。',
  '- kind="semantic"：靠语义相似度召回的软偏好（如「正在准备前端实习」）。',
  '- tags：1-3 个简短分类标签（如 ["编码风格"]、["前端","React"]）。',
  '',
  '【输出格式】严格 JSON 数组，不要任何解释文字：',
  '[{"content":"...","kind":"fact","tags":["..."]}, ...]',
].join('\n');

/**
 * 从对话历史构建 transcript：只保留 user/assistant（去掉 system/tool 噪声），
 * 拼成 `[用户]/[助手]` 文本并截断到尾部 MAX_TRANSCRIPT_CHARS。
 */
function buildTranscript(history: ConversationHistory): string {
  const msgs = history.getMessages().filter((m: ChatMessage) => m.role === 'user' || m.role === 'assistant');
  const text = msgs
    .map((m) => {
      const label = m.role === 'user' ? '用户' : '助手';
      const c = (m.content ?? '').trim();
      return c ? `[${label}] ${c}` : '';
    })
    .filter(Boolean)
    .join('\n');
  return text.length > MAX_TRANSCRIPT_CHARS ? text.slice(-MAX_TRANSCRIPT_CHARS) : text;
}

/** 去除 ```json 围栏并解析为 ExtractedItem[]，任何异常返回空数组（安全降级）。 */
function parseItems(raw: string): ExtractedItem[] {
  if (!raw) return [];
  // 去 ```json ... ``` 围栏
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = (fenced ? fenced[1] : raw).trim();
  let data: unknown;
  try {
    data = JSON.parse(body);
  } catch {
    return [];
  }
  // 支持顶层数组，或 {memories|items|preferences:[...]}
  const arr: unknown = Array.isArray(data)
    ? data
    : data && typeof data === 'object'
      ? (data as Record<string, unknown>).memories ??
        (data as Record<string, unknown>).items ??
        (data as Record<string, unknown>).preferences ??
        []
      : [];
  if (!Array.isArray(arr)) return [];
  const out: ExtractedItem[] = [];
  for (const item of arr) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    const content = typeof rec.content === 'string' ? rec.content.trim() : '';
    if (!content) continue;
    const kind = rec.kind === 'fact' ? 'fact' : 'semantic';
    const tags = Array.isArray(rec.tags) ? (rec.tags.filter((t) => typeof t === 'string') as string[]) : [];
    out.push({ content, kind, tags });
  }
  return out;
}

/**
 * 会话结束自动抽取并沉淀用户记忆。返回新增条数（0 表示无需新增/失败/过短）。
 * 全程 catch 不抛：离线、无 key、LLM 异常都安全降级为 0。
 */
export async function extractUserMemories(
  client: DeepSeekClient,
  history: ConversationHistory,
  store: MemoryManager,
): Promise<number> {
  try {
    const transcript = buildTranscript(history);
    if (transcript.length < MIN_TRANSCRIPT_CHARS) return 0;

    const raw = await client.complete(
      [
        { role: 'system', content: EXTRACT_SYS },
        { role: 'user', content: `对话记录：\n${transcript}` },
      ],
      0.2,
      { modelOverride: client.primaryModel, jsonMode: true, timeoutMs: 60_000 },
    );
    if (!raw || raw.startsWith('子任务调用失败')) return 0;

    const items = parseItems(raw);
    if (items.length === 0) return 0;

    let added = 0;
    for (const it of items) {
      if (added >= MAX_ITEMS) break;
      const dup = await store.isDuplicate(it.content).catch(() => false);
      if (dup) continue;
      if (it.kind === 'fact') {
        store.addFact(it.content);
      } else {
        await store.addEntry(it.content, it.tags);
      }
      added++;
    }
    return added;
  } catch {
    return 0;
  }
}
