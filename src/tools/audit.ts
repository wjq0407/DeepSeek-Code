import path from 'node:path';
import { readFile } from 'node:fs/promises';
import type { ToolDef } from './index.ts';
import { DeepSeekClient, ChatMessage } from '../llm/deepseek.ts';
import { msgOf } from '../utils/logger.ts';

/** 依赖审计报告的 JSON 结构 */
interface AuditIssue {
  dependency?: string;
  version?: string;
  riskLevel?: string;
  knownIssue?: string;
  fixSuggestion?: string;
}
interface AuditReport {
  summary?: string;
  issues?: AuditIssue[];
  overallAdvice?: string[];
  verdict?: string;
}
/** package.json 中我们关心的字段 */
interface PackageJson {
  name?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

function resolve(p: string, cwd: string): string {
  return path.isAbsolute(p) ? p : path.resolve(cwd, p);
}

/**
 * 差异化能力 ②：依赖（软件供应链）安全审计。
 * Claude Code 默认不具备"主动解析依赖清单并基于漏洞知识库做中文审计"的能力。
 * 本工具解析 package.json / 锁文件，交给 DeepSeek 基于已知 CVE / 恶意包知识做中文审计。
 * 风险 low：只读清单 + 模型生成，无副作用。
 */
const AUDIT_SYSTEM = `你是一名中文软件供应链安全审计专家，擅长基于已知漏洞知识库（如 npm 生态的 CVE、
恶意包、弃用风险依赖）对依赖清单做审计。

请严格按照以下 JSON 格式输出审计报告（不要输出 Markdown 或其他格式）：

{
  "summary": "一句话风险摘要 + 高危/中危/低危数量",
  "issues": [
    {
      "dependency": "包名",
      "version": "声明版本",
      "riskLevel": "high|medium|low",
      "knownIssue": "已知问题描述（CVE编号、恶意行为、弃用等）",
      "fixSuggestion": "修复建议（如 npm install pkg@latest）"
    }
  ],
  "overallAdvice": ["升级/替换/移除优先级清单"],
  "verdict": "未发现已知高危漏洞 / 发现 N 个需关注的风险项"
}

规则：
- 严格基于公开已知的漏洞与风险事实判断，不要编造不存在的 CVE。
- 若某依赖无已知高危问题，明确写"未发现已知高危漏洞"。
- 无十足把握时标注"需进一步核实"，不要下绝对结论。`;

/**
 * 将模型返回的 JSON 审计报告解析并渲染为可读 Markdown。
 */
function renderAuditJSON(raw: string, projectName: string): string {
  let jsonStr = raw.trim();
  const codeBlockMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlockMatch) jsonStr = codeBlockMatch[1].trim();

  let parsed: AuditReport;
  try {
    parsed = JSON.parse(jsonStr) as AuditReport;
  } catch {
    return `[JSON 解析失败，返回原始输出]\n${raw}`;
  }

  if (typeof parsed !== 'object' || parsed === null) {
    return `[无效的审计报告格式]\n${raw}`;
  }

  const lines: string[] = [];

  if (parsed.summary) {
    lines.push(`## 风险摘要`);
    lines.push(parsed.summary);
    lines.push('');
  }

  if (Array.isArray(parsed.issues) && parsed.issues.length > 0) {
    lines.push('## 具体问题');
    lines.push('');
    lines.push('| 依赖 | 版本 | 风险等级 | 已知问题 | 修复建议 |');
    lines.push('|------|------|---------|---------|---------|');
    for (const issue of parsed.issues) {
      const risk = issue.riskLevel === 'high' ? '🔴 高危' :
                    issue.riskLevel === 'medium' ? '🟡 中危' : '🟢 低危';
      lines.push(`| ${issue.dependency || '-'} | ${issue.version || '-'} | ${risk} | ${issue.knownIssue || '-'} | ${issue.fixSuggestion || '-'} |`);
    }
    lines.push('');
  }

  if (Array.isArray(parsed.overallAdvice) && parsed.overallAdvice.length > 0) {
    lines.push('## 整体建议');
    lines.push('');
    for (const advice of parsed.overallAdvice) {
      lines.push(`- ${advice}`);
    }
    lines.push('');
  }

  if (parsed.verdict) {
    lines.push(`## 结论`);
    lines.push(parsed.verdict);
  }

  return lines.length > 0 ? lines.join('\n') : `(审计报告为空)\n${raw}`;
}

export function createAuditTool(client: DeepSeekClient): ToolDef {
  return {
    name: 'audit_dependencies',
    description:
      '【差异化能力】解析 package.json（及其依赖/锁文件），基于已知漏洞知识库做中文软件供应链安全审计，返回风险清单与升级建议。只读、无副作用。',
    risk: 'low',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: '包含 package.json 的目录路径，可选，默认当前工作目录',
        },
      },
      required: [],
    },
    async execute(args, ctx) {
      const dir = resolve(args.path ? String(args.path) : '.', ctx.cwd);
      const pkgPath = path.join(dir, 'package.json');
      let pkg: PackageJson;
      try {
        pkg = JSON.parse(await readFile(pkgPath, 'utf8')) as PackageJson;
      } catch {
        return { ok: false, output: `未找到或无法解析 package.json: ${pkgPath}` };
      }
      const deps: Record<string, string> = {
        ...(pkg.dependencies ?? {}),
        ...(pkg.devDependencies ?? {}),
      };
      if (Object.keys(deps).length === 0) {
        return { ok: true, output: `# 依赖安全审计\n项目: ${pkg.name ?? dir}\n\n（未声明任何依赖）` };
      }
      const list = Object.entries(deps).map(([n, v]) => `${n}@${v}`).join('\n');

      // 尝试读取锁文件，补充实际解析版本信息
      let lockInfo = '';
      for (const lf of ['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb']) {
        try {
          const c = await readFile(path.join(dir, lf), 'utf8');
          lockInfo = `\n\n锁文件 ${lf} 片段（前 1500 字符）:\n${c.slice(0, 1500)}`;
          break;
        } catch {
          /* 忽略不存在的锁文件 */
        }
      }

      const user =
        `项目: ${pkg.name ?? dir}\n依赖清单（共 ${Object.keys(deps).length} 个）:\n${list}${lockInfo}\n\n请做中文软件供应链安全审计。`;
      const msgs: ChatMessage[] = [
        { role: 'system', content: AUDIT_SYSTEM },
        { role: 'user', content: user },
      ];
      try {
        // P1-3: 启用 JSON mode 保证结构化输出；V4 复合工具开启思考（high）最大化审计深度
        const rawReport = await client.complete(msgs, 0.2, {
          modelOverride: client.reasoningModel,
          jsonMode: true,
          reasoning: { effort: 'high' },
          signal: ctx.signal,
          timeoutMs: 180_000,
        });
        const rendered = renderAuditJSON(rawReport, pkg.name ?? dir);
        return {
          ok: true,
          output: `# 依赖安全审计（audit_dependencies）\n项目: ${pkg.name ?? dir} | 模型: ${client.reasoningModel}\n\n${rendered}`,
        };
      } catch (e: unknown) {
        return { ok: false, output: `审计失败: ${msgOf(e)}` };
      }
    },
  };
}
