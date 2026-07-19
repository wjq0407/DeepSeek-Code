import { DeepSeekClient, ChatMessage, type JsonSchemaDef } from '../llm/deepseek.ts';
import { ConversationHistory } from '../context/history.ts';
import { z } from 'zod';
import { fetchStructured, formatAnchor, type ParseResult, PRO_COMMON_PREFIX } from './structured-parse.ts';

/**
 * runTaskFidelity — 任务级语义保真审计（双模型质量金字塔·顶层闸门）。
 *
 * 定位：在 Agent 完成多轮工具操作、准备输出最终答复前，由 Pro 站在
 * 「整个任务」的视角审计——到底有没有真的达成用户意图？有没有漏掉子需求、
 * 写出半成品、或「声称已验证但实际没跑」？
 *
 * 与 verify_answer（逐条答复事实核查）正交：
 *   - verify_answer 看「这一句答复」对不对；
 *   - 本函数看「整轮工作」对不对、全不全。
 *
 * 关键设计：审计依据是【内核从 history 抽出的真实工具记录】（落盘事实），
 * 而非 Flash 的自述——延续 P0 以来「不轻信模型 ok 声明」的哲学：
 * 模型说「已创建、已测试通过」不可信，只有工具返回的真实结果可信。
 *
 * 调用方式：内核侧直接调用（非模型工具），在 Elevate 质量轮里随 verify_answer
 * 一起注入，作为对 Flash 的硬性约束。reasoning=medium 控制成本，约 5-8s。
 */

const TASK_FIDELITY_SYSTEM = `你是一名严谨的「任务交付审核员」。你的职责不是检查单条答复的措辞，而是判断【整个任务】是否真正达成用户的意图。

你拿到的是：
① 用户的原始请求
② 本次会话中 Agent 实际执行的操作记录（直接来自工具的真实返回，不是 Agent 的自述）

判断标准：
- pass=true：任务实质完成，用户能直接使用成果。
- pass=false：存在必须修复的缺口（must_fix 非空）。
- risk：none=完好；low=小瑕疵；medium=建议修；high=有误导/残缺交付风险，必须修正。

常见问题类型：
- 漏做子需求：用户要 A+B+C，只做了 A。
- 吹验证：操作记录里没有 run_command / build / test，但 Agent 却声称「已测试通过」。
- 半成品：文件创建了但核心逻辑是空壳 / 占位 / TODO / 未接管线。
- 跑偏：做的事和用户请求无关。

规则：
- 只基于【用户请求】和【真实操作记录】判断，不凭空假设。
- 若操作记录为空或极简，说明无法核实，给 medium 风险并建议补验证。
- 若 pass=false，must_fix 必须给出具体、可执行的修复项。

示例 1（任务完成）：
{"pass":true,"risk":"none","summary":"用户要求创建用户管理 API 的三个接口（create/read/delete），三条接口均已创建并通过验证，任务实质完成。","completeness":"全部 3 个子需求已覆盖：create 接口（完整 CRUD）、read 接口（含分页）、delete 接口（含软删除）","gaps":[],"must_fix":[],"suggestions":["建议为 delete 接口添加级联删除测试"]}

示例 2（漏做子需求）：
{"pass":false,"risk":"high","summary":"用户要求创建用户管理 API 的 3 个接口（create/read/delete），但 review 接口仅创建了路由骨架、未实现查询逻辑，delete 接口完全缺失。","completeness":"3 个子需求仅完成 1.5 个：create 完成、read 半完成（缺查询逻辑）、delete 未开始","gaps":["read 接口缺少数据库查询实现","delete 接口未创建"],"must_fix":["实现 read 接口的数据库查询逻辑（含分页、筛选）","创建 delete 接口并实现软删除"],"suggestions":["统一三个接口的错误处理模式"]}

示例 3（操作记录极简无法核实）：
{"pass":false,"risk":"medium","summary":"操作记录仅显示 read_file 读取了一个文件，无任何 create/edit 操作，无法核实 Agent 是否真的完成了用户请求的功能实现。","completeness":"无法判断，操作记录不足","gaps":["缺少文件创建/修改记录","缺少编译/测试验证记录"],"must_fix":["补充完整的功能实现操作（create_file / edit_file）","完成后运行编译和测试验证"],"suggestions":[]}`;

const TASK_FIDELITY_PREAMBLE = `请站在「整个任务」视角审计交付质量。
审计依据：用户原始请求 + 本次真实工具操作记录（落盘事实）。
只关注「任务是否真的做对、做全」，不评判行文风格。`;

/** zod 校验 schema */
const taskFidelitySchema = z.object({
  pass: z.coerce.boolean(),
  risk: z.enum(['none', 'low', 'medium', 'high']).default('none'),
  summary: z.string().default(''),
  completeness: z.string().optional().default(''),
  gaps: z.array(z.string()).default([]),
  must_fix: z.array(z.string()).default([]),
  suggestions: z.array(z.string()).default([]),
});

/** json_schema 定义（供 API strict 模式使用） */
const TASK_FIDELITY_JSON_SCHEMA: JsonSchemaDef = {
  name: 'task_fidelity_report',
  strict: true,
  schema: {
    type: 'object',
    properties: {
      pass: { type: 'boolean' },
      risk: { type: 'string', enum: ['none', 'low', 'medium', 'high'] },
      summary: { type: 'string' },
      completeness: { type: 'string' },
      gaps: { type: 'array', items: { type: 'string' } },
      must_fix: { type: 'array', items: { type: 'string' } },
      suggestions: { type: 'array', items: { type: 'string' } },
    },
    required: ['pass', 'risk', 'summary', 'gaps', 'must_fix', 'suggestions'],
    additionalProperties: false,
  },
};

function renderTaskFidelity(r: { pass: boolean; risk?: string; summary?: string; completeness?: string; gaps?: string[]; must_fix?: string[]; suggestions?: string[] }): string {
  const lines: string[] = [];
  const statusIcon = r.pass ? 'PASS' : 'FAIL';
  const riskLabel =
    r.risk === 'high' ? '高风险' :
    r.risk === 'medium' ? '中风险' :
    r.risk === 'low' ? '低风险' : '无风险';
  lines.push(`## 任务交付审计: ${statusIcon} (${riskLabel})`);
  if (r.summary) lines.push(r.summary);
  if (r.completeness) lines.push(`完整度: ${r.completeness}`);

  const mustFix = r.must_fix ?? [];
  const gaps = r.gaps ?? [];
  const suggestions = r.suggestions ?? [];

  if (mustFix.length > 0) {
    lines.push('');
    lines.push('### 必须修复 (must_fix)');
    for (const g of mustFix) lines.push(`- ${g}`);
  }
  if (gaps.length > 0) {
    lines.push('');
    lines.push('### 遗漏子需求 (gaps)');
    for (const g of gaps) lines.push(`- ${g}`);
  }
  if (suggestions.length > 0) {
    lines.push('');
    lines.push('### 改进建议');
    for (const s of suggestions) lines.push(`- ${s}`);
  }
  if (mustFix.length === 0 && gaps.length === 0) {
    lines.push('');
    lines.push('未发现问题，任务可认定交付。');
  }

  return lines.join('\n');
}

/**
 * 抽取用户的【原始请求】：第一条非系统注入的 user 消息。
 */
function extractRequest(messages: ChatMessage[]): string {
  for (const m of messages) {
    if (m.role !== 'user') continue;
    const c = (m.content ?? '').trim();
    if (!c) continue;
    if (
      c.startsWith('[系统') ||
      c.startsWith('[上下文摘要') ||
      c.startsWith('[系统自动')
    ) {
      continue;
    }
    return c.slice(0, 1500);
  }
  return '';
}

/**
 * 抽取【真实操作记录】。
 */
function extractWorkLog(messages: ChatMessage[]): string {
  const ops: string[] = [];
  for (const m of messages) {
    if (m.role !== 'tool') continue;
    const name = m.name ?? m.tool_call_id ?? 'tool';
    let ok = true;
    let out = m.content ?? '';
    try {
      const p = JSON.parse(m.content ?? '{}');
      if (typeof p.ok === 'boolean') ok = p.ok;
      if (typeof p.output === 'string') out = p.output;
    } catch {
      // 解析失败则用原始内容
    }
    const snippet = out.replace(/\s+/g, ' ').slice(0, 180);
    ops.push(`[${ok ? 'OK' : 'FAIL'}] ${name}${snippet ? ' | ' + snippet : ''}`);
  }
  if (ops.length === 0) return '';
  return ops.slice(-50).join('\n');
}

/**
 * 任务级语义保真审计。返回 Markdown 渲染结果（注入给 Flash 作为硬性约束），
 * 若无可审计内容（无请求 / 无操作记录）返回 null（调用方跳过注入）。
 */
export async function runTaskFidelity(
  client: DeepSeekClient,
  history: ConversationHistory,
  opts?: { signal?: AbortSignal },
): Promise<string | null> {
  const messages = history.getMessages();
  const request = extractRequest(messages);
  const workLog = extractWorkLog(messages);
  if (!request || !workLog) return null;

  const user = `【用户原始请求】\n${request}\n\n【本次真实操作记录】（来自工具返回，按时间顺序）\n${workLog}`;

  // 末尾锚定：格式要求压入最后一条 user 消息的末尾
  const anchoredPreamble = `${TASK_FIDELITY_PREAMBLE} ${formatAnchor(
    'pass:bool, risk:"none"|"low"|"medium"|"high", summary:string, completeness:string, gaps:string[], must_fix:string[], suggestions:string[]',
    '禁止输出 Markdown 或其他格式，只输出纯 JSON 对象。',
  )}`;

  const msgs: ChatMessage[] = [
    { role: 'system', content: PRO_COMMON_PREFIX },
    { role: 'system', content: TASK_FIDELITY_SYSTEM },
    { role: 'user', content: anchoredPreamble },
    { role: 'user', content: user },
  ];

  const result = await fetchStructured(client, msgs, taskFidelitySchema, TASK_FIDELITY_JSON_SCHEMA, {
    maxRetries: 2,
    reasoningEffort: 'medium',
    signal: opts?.signal,
  });

  if (!result.ok) {
    return `[任务级交付审计 JSON 解析失败]\n${result.rawText}\n[错误: ${result.errors?.join('; ')}]`;
  }

  return renderTaskFidelity(result.data!);
}
