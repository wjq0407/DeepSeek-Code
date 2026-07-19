import path from 'node:path';
import { readFile } from 'node:fs/promises';
import type { ToolDef } from './index.ts';
import { DeepSeekClient, ChatMessage, type JsonSchemaDef } from '../llm/deepseek.ts';
import { msgOf } from '../utils/logger.ts';
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

/** package.json 中我们关心的字段 */
interface PackageJson {
  name?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

/**
 * 差异化能力 ②：依赖（软件供应链）安全审计。
 */
const AUDIT_SYSTEM = `你是一名中文软件供应链安全审计专家，擅长基于已知漏洞知识库（如 npm 生态的 CVE、
恶意包、弃用风险依赖）对依赖清单做审计。

规则：
- 严格基于公开已知的漏洞与风险事实判断，不要编造不存在的 CVE。
- 若某依赖无已知高危问题，明确写"未发现已知高危漏洞"。
- 无十足把握时标注"需进一步核实"，不要下绝对结论。

示例 1（审计通过）：
{"summary":"已审查 42 个依赖，未发现已知高危 CVE 漏洞。有 1 个依赖版本较旧，建议升级。","issues":[{"dependency":"lodash","version":"4.17.19","riskLevel":"medium","knownIssue":"版本滞后于最新安全修复（latest=4.17.21），修复了 CVE-2020-28500（原型污染）","fixSuggestion":"npm install lodash@4.17.21"}],"overallAdvice":["lodash 升级到 4.17.21 消除原型污染风险","其余依赖均处于安全版本范围"],"verdict":"发现 1 个需关注的中危风险项"}

示例 2（发现高危 CVE）：
{"summary":"发现 1 个高危 CVE 漏洞（CVE-2024-xxx）和 2 个弃用依赖，建议立即处理。","issues":[{"dependency":"express","version":"4.17.0","riskLevel":"high","knownIssue":"CVE-2024-xxxx：路径遍历漏洞，攻击者可通过特殊构造的请求读取任意文件","fixSuggestion":"npm install express@4.21.0"},{"dependency":"request","version":"2.88.2","riskLevel":"medium","knownIssue":"request 包已于 2020 年官方弃用（deprecated），不再接收安全更新，建议迁移到 got/undici","fixSuggestion":"迁移到 got 或 node-fetch"}],"overallAdvice":["立即升级 express 到 4.21.0 消除 CVE-2024-xxxx","迁移 request 到 got，该包已无安全更新"],"verdict":"发现 2 个需关注的风险项，其中 1 个高危"}提示：不确定时标注「需进一步核实」。示例 3：
{"summary":"审查了 15 个依赖，大部分为稳定版本。axios 版本需关注，但无充分证据确认为高危。","issues":[{"dependency":"axios","version":"1.6.0","riskLevel":"low","knownIssue":"1.6.0 版本对 SSRF 防护存在争议，最新版 1.7.x 已增强校验，风险较低","fixSuggestion":"建议升级到 axios@1.7 以获取最新安全增强（需进一步核实具体 CVE 编号）"}],"overallAdvice":["axios 升级到 1.7.x"],"verdict":"发现 1 个低危项，需进一步核实"}`;

const AUDIT_PREAMBLE = `请对以下 npm 依赖清单执行中文软件供应链安全审计。
审计维度：已知 CVE 漏洞 / 恶意包 / 弃用风险 / 版本过时 / 许可证风险。
riskLevel: high=已知高危漏洞, medium=弃用/版本过时, low=最佳实践偏离。
仅基于公开已知漏洞事实判断，不编造 CVE；无把握时标注"需进一步核实"。`;

/** zod 校验 schema */
const auditReportSchema = z.object({
  summary: z.string().optional().default(''),
  issues: z.array(z.object({
    dependency: z.string().optional().default(''),
    version: z.string().optional().default(''),
    riskLevel: z.enum(['high', 'medium', 'low']),
    knownIssue: z.string().optional().default(''),
    fixSuggestion: z.string().optional().default(''),
  })).optional().default([]),
  overallAdvice: z.array(z.string()).optional().default([]),
  verdict: z.string().optional().default(''),
});

/** json_schema 定义 */
export const AUDIT_JSON_SCHEMA: JsonSchemaDef = {
  name: 'audit_dependencies_report',
  strict: true,
  schema: {
    type: 'object',
    properties: {
      summary: { type: 'string' },
      issues: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            dependency: { type: 'string' },
            version: { type: 'string' },
            riskLevel: { type: 'string', enum: ['high', 'medium', 'low'] },
            knownIssue: { type: 'string' },
            fixSuggestion: { type: 'string' },
          },
          required: ['dependency', 'version', 'riskLevel', 'knownIssue', 'fixSuggestion'],
          additionalProperties: false,
        },
      },
      overallAdvice: { type: 'array', items: { type: 'string' } },
      verdict: { type: 'string' },
    },
    required: ['summary', 'issues', 'overallAdvice', 'verdict'],
    additionalProperties: false,
  },
};

function renderAudit(r: { summary?: string; issues?: Array<{ dependency?: string; version?: string; riskLevel?: string; knownIssue?: string; fixSuggestion?: string }>; overallAdvice?: string[]; verdict?: string }, projectName: string): string {
  const lines: string[] = [];

  if (r.summary) {
    lines.push(`## 风险摘要`);
    lines.push(r.summary);
    lines.push('');
  }

  const issues = r.issues ?? [];
  if (issues.length > 0) {
    lines.push('## 具体问题');
    lines.push('');
    lines.push('| 依赖 | 版本 | 风险等级 | 已知问题 | 修复建议 |');
    lines.push('|------|------|---------|---------|---------|');
    for (const issue of issues) {
      const risk =
        issue.riskLevel === 'high' ? '高危' :
        issue.riskLevel === 'medium' ? '中危' : '低危';
      lines.push(`| ${issue.dependency || '-'} | ${issue.version || '-'} | ${risk} | ${issue.knownIssue || '-'} | ${issue.fixSuggestion || '-'} |`);
    }
    lines.push('');
  }

  const advice = r.overallAdvice ?? [];
  if (advice.length > 0) {
    lines.push('## 整体建议');
    lines.push('');
    for (const a of advice) lines.push(`- ${a}`);
    lines.push('');
  }

  if (r.verdict) {
    lines.push(`## 结论`);
    lines.push(r.verdict);
  }

  return lines.length > 0 ? lines.join('\n') : '(审计报告为空)';
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

      let lockInfo = '';
      for (const lf of ['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb']) {
        try {
          const c = await readFile(path.join(dir, lf), 'utf8');
          lockInfo = `\n\n锁文件 ${lf} 片段（前 1500 字符）:\n${c.slice(0, 1500)}`;
          break;
        } catch {
          /* ignore */
        }
      }

      const user = `依赖清单（共 ${Object.keys(deps).length} 个）:\n${list}${lockInfo}\n\n项目: ${pkg.name ?? dir}`;

      const anchoredPreamble = `${AUDIT_PREAMBLE} ${formatAnchor(
        'summary:string, issues:{dependency,version,riskLevel:"high"|"medium"|"low",knownIssue,fixSuggestion}[], overallAdvice:string[], verdict:string',
        '禁止输出 Markdown 或其他格式，只输出纯 JSON 对象。',
      )}`;

      const msgs: ChatMessage[] = [
        { role: 'system', content: PRO_COMMON_PREFIX },
        { role: 'system', content: AUDIT_SYSTEM },
        { role: 'user', content: anchoredPreamble },
        { role: 'user', content: user },
      ];
      try {
        const result = await fetchStructured(client, msgs, auditReportSchema, AUDIT_JSON_SCHEMA, {
          maxRetries: 2,
          reasoningEffort: 'high',
          signal: ctx.signal,
        });

        if (!result.ok) {
          return {
            ok: true,
            output: `# 依赖安全审计（audit_dependencies）\n项目: ${pkg.name ?? dir} | 模型: ${client.reasoningModel}\n\n[JSON 解析失败，返回原始输出]\n${result.rawText}`,
          };
        }

        const rendered = renderAudit(result.data!, pkg.name ?? dir);
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
