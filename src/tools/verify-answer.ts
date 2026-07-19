import type { ToolDef } from './index.ts';
import { DeepSeekClient, ChatMessage, type JsonSchemaDef } from '../llm/deepseek.ts';
import { z } from 'zod';
import { formatAnchor, fetchStructured, PRO_COMMON_PREFIX } from './structured-parse.ts';

/**
 * verify_answer — 最终答复正确性验证（双模型输出质量门）。
 *
 * 定位：在 Flash 生成最终答复后、返回给用户前，由 Pro 做事实核查。
 * 这是质量控制闭环的最后一环——确保用户收到的信息准确、完整、不自相矛盾。
 *
 * 触发场景：Flash 完成多轮工具调用并准备输出最终答复时，调用本工具
 * 验证答复与对话事实（工具结果、文件内容）的一致性。
 *
 * 成本/延迟：轻量级检查（reasoning=medium），约 5-8s，约 ¥0.002/次。
 * 对于简单查詢（如"当前时间""读文件内容"），Flash 可跳过本工具。
 */

const VERIFY_ANSWER_SYSTEM = `你是一名 AI 输出质量审核员。你的任务是检查 AI 即将发给用户的最终答复，
判断其中是否存在**事实错误、逻辑矛盾、遗漏关键信息、或承诺不实**的问题。

判断标准：
- pass=true：答复可安全发送给用户。
- pass=false：存在需要修正的问题。
- risk：none=无问题；low=小问题可忽略；medium=建议修正；high=存在误导风险，必须修正。

常见问题类型：
- fact_error：声称的功能/方法不存在或不正确。
- contradiction：答复内容与上文工具结果或用户指令矛盾。
- omission：遗漏了用户明确要求的步骤/信息。
- overclaim：声称验证/测试通过，但实际未执行。
- unclear：表述模糊不清，用户难以理解。

规则：
- 只检查事实性和一致性，不评判写作风格。
- 若有问题，correction 给出具体的修正文字。
- 若答复正确无误，issues 为空数组，summary 简要肯定。
- 引用代码行号、函数名时必须确保确实存在于提供的源代码中，不得臆造。

示例 1（审核通过）：
{"pass":true,"risk":"none","summary":"答复准确描述了用户要求的功能实现，工具结果与描述一致，无事实错误或遗漏。","issues":[]}

示例 2（发现事实错误）：
{"pass":false,"risk":"high","summary":"答复声称 getUserById 函数已添加缓存层，但工具结果（read_file 返回值）显示该函数仍为直查数据库实现，与声称不符。","issues":[{"severity":"high","type":"fact_error","detail":"getUserById 未实现缓存层，但答复声称已完成该改造","correction":"答复应改为：getUserById 目前仍为直查数据库，建议在下一版迭代中引入 Redis 缓存层"}]}

示例 3（信息遗漏）：
{"pass":false,"risk":"medium","summary":"用户要求同时实现 create 和 update 两个接口，但答复仅提到了 create 接口的实现细节，遗漏了 update 部分。","issues":[{"severity":"medium","type":"omission","detail":"遗漏了 update 接口的实现","correction":"补充 update 接口的实现步骤或说明其实现状态"}]}`;

const VERIFY_ANSWER_PREAMBLE = `请审核以下 AI 准备发送给用户的最终答复。
审核维度：事实正确性 / 逻辑一致性 / 信息完整性 / 承诺真实性。只关注事实和一致性，不评判行文风格。`;

/** zod 校验 schema（类型转换 + 字段门禁） */
const verifyAnswerSchema = z.object({
  pass: z.coerce.boolean(),
  risk: z.enum(['none', 'low', 'medium', 'high']).default('none'),
  summary: z.string().default(''),
  issues: z.array(z.object({
    severity: z.enum(['high', 'medium', 'low']),
    type: z.enum(['fact_error', 'contradiction', 'omission', 'overclaim', 'unclear']),
    detail: z.string(),
    correction: z.string(),
  })).default([]),
});

/** json_schema 定义（供 API strict 模式使用） */
export const VERIFY_ANSWER_JSON_SCHEMA: JsonSchemaDef = {
  name: 'verify_answer_report',
  strict: true,
  schema: {
    type: 'object',
    properties: {
      pass: { type: 'boolean' },
      risk: { type: 'string', enum: ['none', 'low', 'medium', 'high'] },
      summary: { type: 'string' },
      issues: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            severity: { type: 'string', enum: ['high', 'medium', 'low'] },
            type: { type: 'string', enum: ['fact_error', 'contradiction', 'omission', 'overclaim', 'unclear'] },
            detail: { type: 'string' },
            correction: { type: 'string' },
          },
          required: ['severity', 'type', 'detail', 'correction'],
          additionalProperties: false,
        },
      },
    },
    required: ['pass', 'risk', 'summary', 'issues'],
    additionalProperties: false,
  },
};

function renderVerifyAnswerJSON(
  rawText: string,
  result: { ok: boolean; data?: { pass: boolean; risk?: string; summary?: string; issues?: Array<{ severity: string; type: string; detail: string; correction: string }> }; errors?: string[] },
): string {
  if (!result.ok) {
    return `[JSON 解析失败，返回原始输出]\n${rawText}\n[错误: ${result.errors?.join('; ')}]`;
  }

  const parsed = result.data!;
  const lines: string[] = [];

  const statusIcon = parsed.pass ? 'PASS' : 'FAIL';
  const riskLabel =
    parsed.risk === 'high' ? '高风险' :
    parsed.risk === 'medium' ? '中风险' :
    parsed.risk === 'low' ? '低风险' : '无风险';
  lines.push(`## 答复审核: ${statusIcon} (${riskLabel})`);
  if (parsed.summary) lines.push(parsed.summary);

  const issues = parsed.issues ?? [];
  if (issues.length > 0) {
    lines.push('');
    lines.push('### 发现问题');
    for (const issue of issues) {
      const sev =
        issue.severity === 'high' ? 'HIGH' :
        issue.severity === 'medium' ? 'MED' : 'LOW';
      const typeMap: Record<string, string> = {
        fact_error: '事实错误',
        contradiction: '前后矛盾',
        omission: '信息遗漏',
        overclaim: '过度承诺',
        unclear: '表述不清',
      };
      lines.push(`- **[${sev}] ${typeMap[issue.type] || issue.type}**`);
      if (issue.detail) lines.push(`  问题: ${issue.detail}`);
      if (issue.correction) lines.push(`  建议: ${issue.correction}`);
    }
  } else {
    lines.push('');
    lines.push('未发现问题，答复可安全发送。');
  }

  return lines.join('\n');
}

export function createVerifyAnswerTool(client: DeepSeekClient): ToolDef {
  return {
    name: 'verify_answer',
    description:
      '【双模型质量门】在发送最终答复给用户前，由推理模型（Pro）审核答复的事实正确性和一致性。检查：是否存在事实错误、前后矛盾、信息遗漏、过度承诺。若审核发现 high/medium 风险问题，你必须根据 correction 修正答复后再发送。简单查询（如读文件内容、当前时间）可跳过本验证。',
    risk: 'low',
    parameters: {
      type: 'object',
      properties: {
        answer: {
          type: 'string',
          description: '你准备发送给用户的最终答复全文',
        },
        context_summary: {
          type: 'string',
          description:
            '本轮对话的关键上下文摘要：用户要求了什么、你调用了哪些工具、各工具的关键结果。帮助审核员判断答复是否遗漏或歪曲事实。',
        },
      },
      required: ['answer'],
    },
    async execute(args, ctx) {
      const answer = String(args.answer ?? '');
      if (answer.trim().length === 0) {
        return { ok: true, output: '答复为空，无需审核。' };
      }

      const contextLine = args.context_summary
        ? `对话上下文:\n${String(args.context_summary)}`
        : '对话上下文: 未提供（仅基于答复本身审核）';

      const user = `待审核答复:\n---\n${answer.slice(0, 3000)}\n---\n\n${contextLine}`;

      // 末尾锚定：格式要求压入最后一条 user 消息的末尾
      const anchoredPreamble = `${VERIFY_ANSWER_PREAMBLE} ${formatAnchor(
        'pass:bool, risk:"none"|"low"|"medium"|"high", summary:string, issues:{severity,type,detail,correction}[]',
        '禁止输出 Markdown 或其他格式，只输出纯 JSON 对象。',
      )}`;

      const msgs: ChatMessage[] = [
        { role: 'system', content: PRO_COMMON_PREFIX },
        { role: 'system', content: VERIFY_ANSWER_SYSTEM },
        { role: 'user', content: anchoredPreamble },
        { role: 'user', content: user },
      ];

      const result = await fetchStructured(client, msgs, verifyAnswerSchema, VERIFY_ANSWER_JSON_SCHEMA, {
        maxRetries: 2,
        reasoningEffort: 'medium',
        signal: ctx.signal,
      });

      const rendered = renderVerifyAnswerJSON(result.rawText, result);
      return {
        ok: true,
        output: `# 答复审核 (verify_answer) | 模型: ${client.reasoningModel}\n\n${rendered}`,
      };
    },
  };
}
