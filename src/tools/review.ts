import path from 'node:path';
import { readFile, readdir, stat } from 'node:fs/promises';
import type { ToolDef } from './index.ts';
import { DeepSeekClient, ChatMessage } from '../llm/deepseek.ts';

/** 代码审查报告的 JSON 结构（由 reasoner 模型产出，经 JSON mode 保证可解析） */
interface ReviewIssue {
  severity?: string;
  file?: string;
  line?: number | null;
  summary?: string;
  detail?: string;
  suggestion?: string;
}
interface ReviewReport {
  overall?: string;
  riskLevel?: string;
  issues?: ReviewIssue[];
  highlights?: string[];
  verdict?: string;
}

function resolve(p: string, cwd: string): string {
  return path.isAbsolute(p) ? p : path.resolve(cwd, p);
}

/**
 * 差异化能力 ①：中文代码审查。
 * 这是 Claude Code 默认不具备的"中文语境深度审查"——不是简单 lint，而是
 * 结合中文工程表达习惯，对逻辑正确性、边界、安全、可读性、命名做结构化点评。
 * 风险 low：只读源码 + 模型生成，无任何文件系统副作用。
 */
const REVIEW_SYSTEM = `你是一名资深的代码审查专家，专门服务中文开发者团队。
请严格按照以下 JSON 格式输出代码审查报告（不要输出 Markdown 或其他格式）：

{
  "overall": "一句话概括代码质量与主要风险等级：良好/一般/需返工",
  "riskLevel": "green|yellow|red",
  "issues": [
    {
      "severity": "high|medium|low",
      "file": "文件路径",
      "line": 行号或null,
      "summary": "问题描述（一句话）",
      "detail": "为什么是问题、可能的后果",
      "suggestion": "推荐的改法（可附代码片段）"
    }
  ],
  "highlights": ["设计中做得好的地方，可选"],
  "verdict": "未发现明显问题/发现 N 个需要关注的问题"
}

规则：
- severity 含义：high=Bug/安全漏洞/数据丢失风险；medium=边界/异常处理缺失/性能；low=可读性/命名/风格。
- 只基于提供的源代码判断，不要臆造不存在的代码。
- 问题必须具体、可定位、可修复；避免空泛建议。
- 若代码质量良好，issues 数组可为空。`;

async function collectCode(target: string): Promise<{ meta: string; code: string }> {
  const s = await stat(target);
  if (s.isFile()) {
    const content = await readFile(target, 'utf8');
    return { meta: `文件: ${target}`, code: content.slice(0, 14000) };
  }
  // 目录：递归收集源码文件（限制数量与总字符，控制 token 成本）
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

/**
 * 将模型返回的 JSON 审查报告解析并渲染为可读 Markdown。
 * 若 JSON 解析失败，优雅降级为原始文本。
 */
function renderReviewJSON(raw: string, target: string): string {
  // 尝试提取 JSON（模型可能在 JSON 前后加 markdown 代码块标记）
  let jsonStr = raw.trim();
  const codeBlockMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlockMatch) jsonStr = codeBlockMatch[1].trim();

  let parsed: ReviewReport;
  try {
    parsed = JSON.parse(jsonStr) as ReviewReport;
  } catch {
    // JSON 解析失败 → 降级返回原始输出
    return `[JSON 解析失败，返回原始输出]\n${raw}`;
  }

  // 基本结构验证
  if (typeof parsed !== 'object' || parsed === null) {
    return `[无效的审查报告格式]\n${raw}`;
  }

  const lines: string[] = [];

  // 总体评价
  if (parsed.overall) {
    const riskIcon = parsed.riskLevel === 'red' ? '🔴' : parsed.riskLevel === 'yellow' ? '🟡' : '🟢';
    lines.push(`## 总体评价 ${riskIcon}`);
    lines.push(parsed.overall);
    lines.push('');
  }

  // 问题清单
  if (Array.isArray(parsed.issues) && parsed.issues.length > 0) {
    lines.push('## 问题清单');
    lines.push('');
    lines.push('| 严重性 | 位置 | 问题描述 | 改进建议 |');
    lines.push('|--------|------|---------|---------|');
    for (const issue of parsed.issues) {
      const sev = issue.severity === 'high' ? '🔴 高危' :
                   issue.severity === 'medium' ? '🟡 中危' : '🟢 建议';
      const loc = issue.file ? `${issue.file}${issue.line ? `:${issue.line}` : ''}` : '-';
      lines.push(`| ${sev} | ${loc} | ${issue.summary || '-'} | ${issue.suggestion || '-'} |`);
    }
    lines.push('');

    // 详细分析（仅高危和中危）
    const detailed = parsed.issues.filter((i) => i.severity === 'high' || i.severity === 'medium');
    if (detailed.length > 0) {
      lines.push('## 详细分析');
      lines.push('');
      for (const issue of detailed) {
        lines.push(`### ${issue.severity === 'high' ? '🔴' : '🟡'} ${issue.summary || '问题'}`);
        if (issue.detail) lines.push(issue.detail);
        if (issue.suggestion) {
          lines.push('');
          lines.push(`**建议**: ${issue.suggestion}`);
        }
        lines.push('');
      }
    }
  }

  // 亮点
  if (Array.isArray(parsed.highlights) && parsed.highlights.length > 0) {
    lines.push('## 亮点');
    lines.push('');
    for (const h of parsed.highlights) {
      lines.push(`- ✅ ${h}`);
    }
    lines.push('');
  }

  // 结论
  if (parsed.verdict) {
    lines.push(`## 结论`);
    lines.push(parsed.verdict);
  }

  return lines.length > 0 ? lines.join('\n') : `(审查报告为空)\n${raw}`;
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
        const user = `${meta}\n\n源代码:\n\`\`\`\n${code}\n\`\`\`\n\n审查重点: ${focus}\n\n请严格基于上方源代码（不要臆造不存在的代码）输出 JSON 格式的代码审查报告。`;
        const msgs: ChatMessage[] = [
          { role: 'system', content: REVIEW_SYSTEM },
          { role: 'user', content: user },
        ];
        // P1-3: 启用 JSON mode 保证结构化输出；V4 复合工具开启思考（high）最大化分析深度
        const rawReport = await client.complete(msgs, 0.3, {
          modelOverride: client.reasoningModel,
          jsonMode: true,
          reasoning: { effort: 'high' },
          signal: ctx.signal,
          timeoutMs: 180_000,
        });

        // 解析并渲染为可读 Markdown
        const rendered = renderReviewJSON(rawReport, target);
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
