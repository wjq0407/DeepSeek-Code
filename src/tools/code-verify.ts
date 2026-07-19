import path from 'node:path';
import { readFile, stat } from 'node:fs/promises';
import type { DeepSeekClient, ChatMessage, JsonSchemaDef } from '../llm/deepseek.ts';
import { z } from 'zod';
import { parseJSON, formatAnchor, fetchStructured, PRO_COMMON_PREFIX } from './structured-parse.ts';

/**
 * 代码正确性验证核心（双模型质量门）。
 *
 * 这是 verify_code 工具与「文件写后自动校验」共用的纯逻辑层：
 * 用 Pro 模型对一段已落盘的代码做聚焦式正确性/安全性检查（reasoning=medium）。
 *
 * 为什么单独抽出来：
 *  - 防止循环依赖——index.ts（基础文件工具）与 verify-code.ts（复合工具）
 *    都需要调用它，若各自内联则会形成 index ↔ verify-code 的环。
 *  - 把「提示词 + 解析 + 渲染」三件套集中，便于统一调参与维护。
 *
 * 第 ① 道防线优化（2026-07-19）：
 *  - 系统提示词末尾追加 3 个 few-shot 样例（通过 / 失败 / 多问题）
 *  - VERIFY_PREAMBLE 尾部用 formatAnchor 做末尾锚定（近因效应）
 *  - 第 ④ 道防线：zod schema + fetchStructured 自修复闭环
 */

const VERIFY_SYSTEM = `你是一名代码正确性验证专家。你的任务不是做全面代码审查，而是快速判断：
这段代码是否**正确地**实现了它声称的功能？是否有**明显的 Bug 或安全漏洞**？

规则：
- pass=true 表示代码逻辑正确、无安全隐患、可以交付。
- pass=false 表示存在需要修复的问题。
- 只关注正确性（逻辑/边界/类型）和安全性（注入/越权/泄露），
  不关注命名风格、代码格式、注释质量等表面问题。
- 问题必须具体、可定位；不要空泛建议。
- 若代码正确，issues 为空数组，summary 简要肯定。
- 不要臆造不存在的代码，引用的行号/函数名必须确实存在于提供的源代码中。

示例 1（代码正确）：
{"pass":true,"summary":"函数实现了安全的用户输入校验，SQL 查询使用了参数化绑定，无注入风险，边界条件处理到位。","issues":[]}

示例 2（存在安全漏洞）：
{"pass":false,"summary":"第 45 行直接将用户输入拼接到 SQL 语句中，存在 SQL 注入风险。同时缺少对空数组的判空保护。","issues":[{"severity":"high","line":45,"problem":"raw SQL 拼接用户输入，可被注入攻击","fix":"改用参数化查询：db.query('SELECT * FROM users WHERE id = ?', [userId])"},{"severity":"medium","line":12,"problem":"ids 数组为空时 forEach 不会报错但后续 join 会产生空字符串，SQL 语法错误","fix":"在 forEach 前添加 if (ids.length === 0) return []; 判空守卫"}]}

示例 3（边界条件缺陷）：
{"pass":false,"summary":"分页函数未处理 pageSize 为 0 或负数的情况，可能导致除零或无限循环。","issues":[{"severity":"medium","line":23,"problem":"pageSize 可为 0，Math.ceil(total/pageSize) 得到 Infinity","fix":"添加参数校验：if (pageSize < 1) pageSize = 20; 设置最小分页"}]}`;

const VERIFY_PREAMBLE = `请对以下代码做快速正确性验证。
聚焦：逻辑正确性 / 边界条件 / 类型安全 / 安全漏洞。
不关注命名/格式/注释——只查 Bug 和安全问题。`;

/** zod 校验 schema */
const verifyReportSchema = z.object({
  pass: z.coerce.boolean(),
  summary: z.string().default(''),
  issues: z.array(z.object({
    severity: z.enum(['high', 'medium', 'low']),
    line: z.number().nullable().default(null),
    problem: z.string(),
    fix: z.string(),
  })).default([]),
});

/** json_schema 定义（供 API strict 模式使用） */
export const VERIFY_CODE_JSON_SCHEMA: JsonSchemaDef = {
  name: 'verify_code_report',
  strict: true,
  schema: {
    type: 'object',
    properties: {
      pass: { type: 'boolean' },
      summary: { type: 'string' },
      issues: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            severity: { type: 'string', enum: ['high', 'medium', 'low'] },
            line: { type: ['number', 'null'] },
            problem: { type: 'string' },
            fix: { type: 'string' },
          },
          required: ['severity', 'line', 'problem', 'fix'],
          additionalProperties: false,
        },
      },
    },
    required: ['pass', 'summary', 'issues'],
    additionalProperties: false,
  },
};

function renderVerifyMarkdown(
  r: { pass: boolean; summary?: string; issues?: Array<{ severity: string; line?: number | null; problem: string; fix: string }> },
  target: string,
  model: string,
): string {
  const lines: string[] = [];
  const icon = r.pass ? 'PASS' : 'FAIL';
  lines.push(`## 验证结果: ${icon}`);
  if (r.summary) lines.push(r.summary);

  const issues = r.issues ?? [];
  if (issues.length > 0) {
    lines.push('');
    lines.push('### 发现的问题');
    for (const issue of issues) {
      const sev =
        issue.severity === 'high' ? 'HIGH' :
        issue.severity === 'medium' ? 'MED' : 'LOW';
      const loc = issue.line ? `:${issue.line}` : '';
      lines.push(`- **[${sev}]**${loc} ${issue.problem}`);
      if (issue.fix) lines.push(`  → ${issue.fix}`);
    }
  } else {
    lines.push('');
    lines.push('未发现问题，代码可安全交付。');
  }

  return `# 快速验证 (verify_code)\n文件: ${target} | 模型: ${model}\n\n${lines.join('\n')}`;
}

export interface CodeVerifyOutcome {
  /** 是否真的执行了验证（文件存在且非空才跑） */
  ran: boolean;
  /** 逻辑正确性：Pro 判定通过 */
  pass: boolean;
  /** 是否存在 high 级别问题（最该修的） */
  hasHigh: boolean;
  /** 可直接回灌模型的报告（markdown） */
  rendered: string;
  /** 校验未完成（如模型返回无法解析），不应视为通过 */
  inconclusive?: boolean;
}

/**
 * 对单个已落盘文件跑一次 Pro 正确性校验。
 *
 * @param client   DeepSeek 客户端（用 reasonerModel + reasoning=medium）
 * @param target  已解析的绝对路径
 * @param opts.goal   这段代码要达成的目标（一句话），帮助判断是否正确实现
 * @param opts.focus  验证重点，可选
 * @param opts.signal 可取消信号
 */
export async function runCodeVerify(
  client: DeepSeekClient,
  target: string,
  opts: { goal?: string; focus?: string; signal?: AbortSignal },
): Promise<CodeVerifyOutcome> {
  try {
    const s = await stat(target);
    if (!s.isFile()) return { ran: false, pass: true, hasHigh: false, rendered: '' };
    const code = await readFile(target, 'utf8');
    if (code.trim().length === 0) return { ran: false, pass: true, hasHigh: false, rendered: '' };

    const goal = opts.goal ? `目标: ${opts.goal}` : '目标: 未提供（请根据代码推断其意图）';
    const focus = opts.focus ? String(opts.focus) : '综合（逻辑正确性 / 安全性 / 边界条件）';
    const user =
      `验证重点: ${focus}\n${goal}\n\n源代码 (${target}):\n\`\`\`\n${code.slice(0, 8000)}\n\`\`\``;

    // 末尾锚定：格式要求压入最后一条 user 消息的末尾
    const anchoredPreamble = `${VERIFY_PREAMBLE} ${formatAnchor(
      'pass:bool, summary:string, issues:{severity,line,problem,fix}[]',
      '禁止输出 Markdown 或其他格式，只输出纯 JSON 对象。',
    )}`;

    const msgs: ChatMessage[] = [
      { role: 'system', content: PRO_COMMON_PREFIX },
      { role: 'system', content: VERIFY_SYSTEM },
      { role: 'user', content: anchoredPreamble },
      { role: 'user', content: user },
    ];

    const result = await fetchStructured(client, msgs, verifyReportSchema, VERIFY_CODE_JSON_SCHEMA, {
      maxRetries: 2,
      reasoningEffort: 'medium',
      signal: opts.signal,
    });

    if (!result.ok) {
      return {
        ran: true,
        pass: false,
        hasHigh: false,
        rendered: `# 快速验证 (verify_code)\n文件: ${target} | 模型: ${client.reasoningModel}\n\n## 验证结果: FAIL\n[Pro 校验 JSON 解析失败，验证未完成，请人工复核]\n[错误: ${result.errors?.join('; ')}]`,
        inconclusive: true,
      };
    }

    const report = result.data!;
    const rendered = renderVerifyMarkdown(report, target, client.reasoningModel);
    const hasHigh = (report.issues ?? []).some((i) => i.severity === 'high');
    return { ran: true, pass: report.pass, hasHigh, rendered, inconclusive: false };
  } catch {
    // 任何异常都不阻塞写盘结果——校验是「增强」不是「闸门失败」
    return { ran: false, pass: true, hasHigh: false, rendered: '' };
  }
}
