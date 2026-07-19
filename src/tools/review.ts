import path from 'node:path';
import { readFile, readdir, stat } from 'node:fs/promises';
import type { ToolDef } from './index.ts';
import { DeepSeekClient, ChatMessage, type JsonSchemaDef } from '../llm/deepseek.ts';
import { z } from 'zod';
import { fetchStructured, formatAnchor, PRO_COMMON_PREFIX } from './structured-parse.ts';

function resolve(p: string, cwd: string): string {
  const abs = path.isAbsolute(p) ? p : path.resolve(cwd, p);
  const rel = path.relative(cwd, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`路径遍历拒绝：${p} 不在工作目录内（cwd=${cwd}）`);
  }
  return abs;
}

/**
 * 差异化能力 ①：中文代码审查。
 * 这是 Claude Code 默认不具备的"中文语境深度审查"——不是简单 lint，而是
 * 结合中文工程表达习惯，对逻辑正确性、边界、安全、可读性、命名做结构化点评。
 * 风险 low：只读源码 + 模型生成，无任何文件系统副作用。
 */
const REVIEW_SYSTEM = `你是一名资深的代码审查专家，专门服务中文开发者团队。

规则：
- severity 含义：high=Bug/安全漏洞/数据丢失风险；medium=边界/异常处理缺失/性能；low=可读性/命名/风格。
- 只基于提供的源代码判断，不要臆造不存在的代码。
- 问题必须具体、可定位、可修复；避免空泛建议。
- 若代码质量良好，issues 数组可为空。

示例 1（代码质量良好）：
{"overall":"代码结构清晰，错误处理完整，未发现 Bug 或安全问题","riskLevel":"green","issues":[],"highlights":["使用了类型守卫避免 any","Promise.all 并发请求合理","错误信息包含上下文"],"verdict":"未发现明显问题"}

示例 2（发现高危 bug）：
{"overall":"存在 SQL 注入风险和空指针异常，建议在合并前修复","riskLevel":"red","issues":[{"severity":"high","file":"src/db/user.ts","line":45,"summary":"SQL 注入：用户输入直接拼接到查询语句","detail":"raw SQL 拼接 userId 参数，攻击者可通过特殊构造的输入执行任意 SQL 语句","suggestion":"改用参数化查询：db.query('SELECT * FROM users WHERE id = ?',[userId])"},{"severity":"medium","file":"src/db/user.ts","line":32,"summary":"连接池未设置超时","detail":"数据库连接池缺少超时配置，可能导致连接泄漏","suggestion":"添加 pool.maxWait = 5000 设置最大等待超时"}],"highlights":["目录结构清晰"],"verdict":"发现 2 个需要关注的问题，其中 1 个高危"}

示例 3（中等风险）：
{"overall":"功能实现正确但缺少边界条件处理，建议补充","riskLevel":"yellow","issues":[{"severity":"medium","file":"src/utils/paginate.ts","line":18,"summary":"pageSize 可为零或负数导致除零","detail":"未校验 pageSize 边界值，Math.ceil(total/0) 将返回 Infinity","suggestion":"在函数开头添加 if (pageSize < 1) pageSize = 20; 设置默认值"}],"highlights":["分页逻辑简洁易懂","类型定义完整"],"verdict":"发现 1 个需要关注的问题"}`;

const REVIEW_PREAMBLE = `请对以下源代码执行结构化中文代码审查。
审查维度：正确性 / 安全性 / 可读性 / 性能 / 边界条件。仅基于提供的源码判断，不臆造；
severity: high=Bug/安全/数据风险, medium=边界/异常, low=可读性/命名/风格。`;

/** zod 校验 schema */
const reviewReportSchema = z.object({
  overall: z.string().optional().default(''),
  riskLevel: z.enum(['green', 'yellow', 'red']).optional().default('green'),
  issues: z.array(z.object({
    severity: z.enum(['high', 'medium', 'low']),
    file: z.string().optional().default(''),
    line: z.number().nullable().optional().default(null),
    summary: z.string().optional().default(''),
    detail: z.string().optional().default(''),
    suggestion: z.string().optional().default(''),
  })).optional().default([]),
  highlights: z.array(z.string()).optional().default([]),
  verdict: z.string().optional().default(''),
});

/** json_schema 定义 */
export const REVIEW_JSON_SCHEMA: JsonSchemaDef = {
  name: 'review_code_report',
  strict: true,
  schema: {
    type: 'object',
    properties: {
      overall: { type: 'string' },
      riskLevel: { type: 'string', enum: ['green', 'yellow', 'red'] },
      issues: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            severity: { type: 'string', enum: ['high', 'medium', 'low'] },
            file: { type: 'string' },
            line: { type: ['number', 'null'] },
            summary: { type: 'string' },
            detail: { type: 'string' },
            suggestion: { type: 'string' },
          },
          required: ['severity', 'file', 'line', 'summary', 'detail', 'suggestion'],
          additionalProperties: false,
        },
      },
      highlights: { type: 'array', items: { type: 'string' } },
      verdict: { type: 'string' },
    },
    required: ['overall', 'riskLevel', 'issues', 'highlights', 'verdict'],
    additionalProperties: false,
  },
};

async function collectCode(target: string): Promise<{ meta: string; code: string }> {
  const s = await stat(target);
  if (s.isFile()) {
    const content = await readFile(target, 'utf8');
    return { meta: `文件: ${target}`, code: content.slice(0, 14000) };
  }
  const exts = [
    '.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.java', '.rs',
    '.vue', '.c', '.cpp', '.h', '.rb', '.php',
  ];
  const files: string[] = [];
  async function walk(d: string): Promise<void> {
    if (files.length >= 8) return;
    let entries;
    try {
      entries = await readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (files.length >= 8) break;
      const full = path.join(d, e.name);
      if (e.isDirectory()) {
        if (['node_modules', '.git', 'dist', 'build', '.next', 'target', 'venv'].includes(e.name)) continue;
        await walk(full);
      } else if (exts.some((ext) => e.name.endsWith(ext))) {
        files.push(full);
      }
    }
  }
  await walk(target);
  let code = '';
  let meta =
    `目录: ${target}\n收集源码文件（最多 8 个）:\n` +
    files.map((f) => `- ${path.relative(target, f)}`).join('\n') +
    '\n\n';
  for (const f of files) {
    const c = await readFile(f, 'utf8');
    code += `\n// === 文件: ${path.relative(target, f)} ===\n` + c.slice(0, 2500);
    if (code.length > 14000) {
      code = code.slice(0, 14000);
      meta += '\n（代码已截断至约 14k 字符以控制上下文）';
      break;
    }
  }
  if (files.length === 0) meta += '\n（该目录下未发现可审查的源码文件）';
  return { meta, code };
}

function renderReview(r: { overall?: string; riskLevel?: string; issues?: Array<{ severity?: string; file?: string; line?: number | null; summary?: string; detail?: string; suggestion?: string }>; highlights?: string[]; verdict?: string }): string {
  const lines: string[] = [];

  if (r.overall) {
    lines.push(`## 总体评价`);
    lines.push(r.overall);
    lines.push('');
  }

  const issues = r.issues ?? [];
  if (issues.length > 0) {
    lines.push('## 问题清单');
    lines.push('');
    lines.push('| 严重性 | 位置 | 问题描述 | 改进建议 |');
    lines.push('|--------|------|---------|---------|');
    for (const issue of issues) {
      const sev =
        issue.severity === 'high' ? '高危' :
        issue.severity === 'medium' ? '中危' : '建议';
      const loc = issue.file ? `${issue.file}${issue.line ? `:${issue.line}` : ''}` : '-';
      lines.push(`| ${sev} | ${loc} | ${issue.summary || '-'} | ${issue.suggestion || '-'} |`);
    }
    lines.push('');

    const detailed = issues.filter((i) => i.severity === 'high' || i.severity === 'medium');
    if (detailed.length > 0) {
      lines.push('## 详细分析');
      lines.push('');
      for (const issue of detailed) {
        lines.push(`### ${issue.summary || '问题'}`);
        if (issue.detail) lines.push(issue.detail);
        if (issue.suggestion) {
          lines.push('');
          lines.push(`**建议**: ${issue.suggestion}`);
        }
        lines.push('');
      }
    }
  }

  const highlights = r.highlights ?? [];
  if (highlights.length > 0) {
    lines.push('## 亮点');
    lines.push('');
    for (const h of highlights) lines.push(`- ${h}`);
    lines.push('');
  }

  if (r.verdict) {
    lines.push(`## 结论`);
    lines.push(r.verdict);
  }

  return lines.length > 0 ? lines.join('\n') : '(审查报告为空)';
}

export function createReviewTool(client: DeepSeekClient): ToolDef {
  return {
    name: 'review_code',
    description:
      '【差异化能力】对指定文件或目录做中文代码审查：检查逻辑正确性、边界情况、安全性、可读性与命名，返回结构化中文审查报告。只读、无副作用，适合在写完/改完代码后用中文复盘质量。',
    risk: 'low',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '要审查的文件或目录路径（相对工作目录或绝对）' },
        focus: {
          type: 'string',
          description: '审查重点，可选。如「安全性」「并发」「性能」「可读性」，默认综合审查',
        },
      },
      required: ['path'],
    },
    async execute(args, ctx) {
      const target = resolve(String(args.path), ctx.cwd);
      try {
        const s = await stat(target);
        if (!s.isFile() && !s.isDirectory()) {
          return { ok: false, output: `路径不存在或不可访问: ${target}` };
        }
        const { meta, code } = await collectCode(target);
        if (code.trim().length === 0) {
          return { ok: true, output: `# 中文代码审查\n${meta}\n\n（无可审查的源码内容）` };
        }
        const focus = args.focus ? String(args.focus) : '综合（正确性 / 边界 / 安全 / 可读性 / 命名）';
        const user = `审查重点: ${focus}\n\n源代码:\n\`\`\`\n${code}\n\`\`\`\n\n${meta}`;

        const anchoredPreamble = `${REVIEW_PREAMBLE} ${formatAnchor(
          'overall:string, riskLevel:"green"|"yellow"|"red", issues:{severity,file,line,summary,detail,suggestion}[], highlights:string[], verdict:string',
          '禁止输出 Markdown 或其他格式，只输出纯 JSON 对象。',
        )}`;

        const msgs: ChatMessage[] = [
          { role: 'system', content: PRO_COMMON_PREFIX },
          { role: 'system', content: REVIEW_SYSTEM },
          { role: 'user', content: anchoredPreamble },
          { role: 'user', content: user },
        ];

        const result = await fetchStructured(client, msgs, reviewReportSchema, REVIEW_JSON_SCHEMA, {
          maxRetries: 2,
          reasoningEffort: 'high',
          signal: ctx.signal,
        });

        if (!result.ok) {
          return {
            ok: true,
            output: `# 中文代码审查（review_code）\n目标: ${target} | 模型: ${client.reasoningModel}\n\n[JSON 解析失败，返回原始输出]\n${result.rawText}`,
          };
        }

        const rendered = renderReview(result.data!);
        return {
          ok: true,
          output: `# 中文代码审查（review_code）\n目标: ${target} | 模型: ${client.reasoningModel}\n\n${rendered}`,
        };
      } catch (e: unknown) {
        return { ok: false, output: `审查失败: ${e instanceof Error ? e.message : String(e)}` };
      }
    },
  };
}
