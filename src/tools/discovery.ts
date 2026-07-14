import { readFile, readdir, access } from 'node:fs/promises';
import path from 'node:path';
import type { ToolDef } from './index.ts';
import { msgOf } from '../utils/logger.ts';
import { DeepSeekClient, ChatMessage } from '../llm/deepseek.ts';

/**
 * 差异化发现类复合工具集（P3 增强）。
 *
 * 这两个工具是 Claude Code 默认不具备、且最能体现「中文 + DeepSeek 能力释放」的方向：
 * 1. terminology（中英术语对照）——读英文技术文档/API/报错时自动映射中文通行译名
 * 2. project_discover（项目结构自动发现）——扫描目录树 + 识别技术栈 + 中文项目地图解读
 *
 * 两者均为「复合工具」：工具内部依赖 DeepSeekClient 做二次推理（非流式、带 jsonMode 保证可解析）。
 */

// ─── 公共：解析文件路径 ───
function resolvePath(p: string | undefined, cwd: string): string {
  if (!p) return cwd;
  return path.isAbsolute(p) ? p : path.resolve(cwd, p);
}

// ─── terminology：中英术语对照（差异化复合工具） ───

const TERMINOLOGY_SYSTEM = `你是中英技术术语对照专家，专门服务中文开发者。
给定一段英文技术文档（或代码注释 / API 文档 / 报错信息 / README），请：
1. 提取关键专业术语，给出「英文术语 → 中文通行译法（业界通用译名）」
2. 对文档核心内容用中文做 2-4 句摘要
3. 若文中存在易混淆术语，给出辨析

严格以 JSON 输出，不要任何多余文本：
{
  "summary": "中文核心摘要（2-4句）",
  "terms": [{"en": "英文术语", "zh": "中文通行译法", "note": "可选：补充辨析或搭配"}],
  "ambiguous": [{"term": "易混淆术语", "clarification": "辨析说明"}]
}
要求：
- 术语译法使用业界通行中文译名，不要生造；严格基于原文，不臆造术语。
- ambiguous 仅在确有易混淆之处时填写，无则填空数组 []。`;

interface TerminologyData {
  summary?: string;
  terms?: Array<{ en?: string; zh?: string; note?: string }>;
  ambiguous?: Array<{ term?: string; clarification?: string }>;
}

function renderTerminology(data: TerminologyData): string {
  let out = '';
  if (data?.summary) out += `## 中文摘要\n${data.summary}\n\n`;
  if (Array.isArray(data?.terms) && data.terms.length) {
    out += `## 术语对照\n| 英文 | 中文 | 辨析 |\n|---|---|---|\n`;
    for (const t of data.terms) {
      out += `| \`${String(t.en ?? '').replace(/\|/g, '\\|')}\` | ${String(t.zh ?? '').replace(/\|/g, '\\|')} | ${String(t.note ?? '').replace(/\|/g, '\\|')} |\n`;
    }
    out += '\n';
  }
  if (Array.isArray(data?.ambiguous) && data.ambiguous.length) {
    out += `## 易混淆辨析\n`;
    for (const a of data.ambiguous) out += `- **${a.term}**： ${a.clarification}\n`;
  }
  return out || '(模型未返回可用结构化内容)';
}

export function createTerminologyTool(client: DeepSeekClient): ToolDef {
  return {
    name: 'terminology',
    description:
      '【差异化能力】中英技术术语对照。读取英文技术文档/代码注释/API 文档/报错信息，自动提取关键术语并映射中文通行译名，输出术语对照表 + 中文摘要 + 易混淆辨析。当用户要求「翻译术语 / 中英对照 / 解释这段英文文档 / 这段报错是什么意思」时调用。',
    risk: 'low',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '英文文档文件路径（相对或绝对），与 text 二选一' },
        text: { type: 'string', description: '直接粘贴的英文文本（如报错信息、文档片段），与 path 二选一' },
      },
      required: [],
    },
    async execute(args, ctx) {
      let content = '';
      try {
        if (args.path) {
          const fp = resolvePath(String(args.path), ctx.cwd);
          content = await readFile(fp, 'utf8');
        } else if (args.text) {
          content = String(args.text);
        } else {
          return { ok: false, output: '请提供 path（文件路径）或 text（英文文本）之一' };
        }
        if (content.trim().length === 0) return { ok: true, output: '(无可对照的文本内容)' };
        content = content.slice(0, 12000); // 控制 token 预算

        const msgs: ChatMessage[] = [
          { role: 'system', content: TERMINOLOGY_SYSTEM },
          {
            role: 'user',
            content: `请对以下英文内容进行中英术语对照：\n\n${content}`,
          },
        ];

        const raw = await client.complete(msgs, 0.2, {
          modelOverride: client.reasoningModel,
          jsonMode: true,
          reasoning: { effort: 'medium' },
          signal: ctx.signal,
          timeoutMs: 180_000,
        });

        // 解析 + 降级
        try {
          const data = JSON.parse(raw) as TerminologyData;
          return {
            ok: true,
            output: `# 中英术语对照（terminology）\n\n${renderTerminology(data)}`,
          };
        } catch {
          return {
            ok: true,
            output: `# 中英术语对照（terminology）\n\n(结构化解析失败，展示原始结果)\n\n${raw}`,
          };
        }
      } catch (e: unknown) {
        return { ok: false, output: `术语对照失败: ${msgOf(e)}` };
      }
    },
  };
}

// ─── project_discover：项目结构自动发现（差异化复合工具） ───

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.workbuddy',
  '.next', '.vscode', 'coverage', '.idea', 'out', 'target',
]);

async function scanTree(dir: string, depth: number, maxDepth: number, lines: string[]): Promise<void> {
  if (depth > maxDepth) return;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  // 目录在前、名称排序
  entries.sort((a, b) => {
    if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  for (const ent of entries) {
    if (ent.name.startsWith('.')) continue; // 跳过隐藏文件/目录（.git 等已在上层处理）
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (SKIP_DIRS.has(ent.name)) {
        lines.push(`${'  '.repeat(depth)}${ent.name}/ (已跳过)`);
        continue;
      }
      lines.push(`${'  '.repeat(depth)}${ent.name}/`);
      await scanTree(full, depth + 1, maxDepth, lines);
    } else {
      lines.push(`${'  '.repeat(depth)}${ent.name}`);
    }
  }
}

async function detectStack(cwd: string): Promise<string[]> {
  const checks: Array<[string, string]> = [
    ['package.json', 'Node.js / npm'],
    ['pnpm-lock.yaml', 'pnpm'],
    ['yarn.lock', 'yarn'],
    ['tsconfig.json', 'TypeScript'],
    ['requirements.txt', 'Python'],
    ['pyproject.toml', 'Python (现代工程)'],
    ['go.mod', 'Go'],
    ['Cargo.toml', 'Rust'],
    ['pom.xml', 'Java / Maven'],
    ['build.gradle', 'Java / Gradle'],
    ['composer.json', 'PHP'],
    ['Gemfile', 'Ruby'],
    ['index.html', '前端静态站点'],
  ];
  const signals: string[] = [];
  for (const [f, label] of checks) {
    try {
      await access(path.join(cwd, f));
      signals.push(label);
    } catch {
      /* 不存在 */
    }
  }
  return signals;
}

const PROJECT_MAP_SYSTEM = `你是软件项目结构分析专家，专门服务中文开发者。
基于给定的目录树、技术栈信号和 package.json 摘要，生成一份「中文项目地图解读」：
1. 先用一句话概括这是什么类型的项目。
2. 用中文标注主要目录/文件的用途（如 src/ 源代码、tests/ 测试、docs/ 文档、scripts/ 脚本）。
3. 指出可能的入口文件、构建配置、测试入口位置。
4. 若结构存在明显问题（如缺测试目录、缺 README、配置文件散乱、存在大体积构建产物未忽略），给出改进提醒。

要求：使用简体中文，条理清晰，使用 Markdown 标题与列表，不要臆造不存在的文件。直接输出解读正文，不要以「好的」「以下是」「根据您提供的」等客套语开头。`;

export function createProjectDiscoverTool(client: DeepSeekClient): ToolDef {
  return {
    name: 'project_discover',
    description:
      '【差异化能力】项目结构自动发现。扫描目录树、识别技术栈（package.json/requirements.txt/go.mod 等），并用中文生成「项目地图解读」（各目录用途、入口文件、构建配置、测试位置 + 结构改进提醒）。当用户要求「分析这个项目 / 项目结构是什么 / 这个项目怎么组织 / 帮我理解代码库」时调用。',
    risk: 'low',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '待分析目录（相对或绝对），默认当前工作目录' },
        max_depth: { type: 'integer', description: '目录树最大扫描深度，默认 3' },
      },
      required: [],
    },
    async execute(args, ctx) {
      const root = resolvePath(args.path ? String(args.path) : undefined, ctx.cwd);
      const maxDepth = args.max_depth ? Math.min(Number(args.max_depth), 6) : 3;
      try {
        const lines: string[] = [path.basename(root) + '/'];
        await scanTree(root, 0, maxDepth, lines);
        const tree = lines.join('\n');
        const stack = await detectStack(root);

        // 读取 package.json 摘要（若存在）
        let pkgInfo = '';
        try {
          const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
          pkgInfo =
            `项目名称: ${pkg.name ?? '-'}\n` +
            `入口: ${pkg.main ?? pkg.module ?? '-'}\n` +
            `脚本: ${Object.keys(pkg.scripts ?? {}).join(', ') || '-'}\n` +
            `依赖: ${(Object.keys(pkg.dependencies ?? {})).length} 生产 + ${(Object.keys(pkg.devDependencies ?? {})).length} 开发`;
        } catch {
          /* 非 Node 项目，忽略 */
        }

        const msgs: ChatMessage[] = [
          { role: 'system', content: PROJECT_MAP_SYSTEM },
          {
            role: 'user',
            content:
              `目录结构:\n${tree}\n\n` +
              `技术栈信号: ${stack.join('、') || '未知'}\n` +
              `${pkgInfo ? '\n' + pkgInfo + '\n' : ''}\n` +
              `请生成中文项目地图解读。`,
          },
        ];

        const interpretation = await client.complete(msgs, 0.3, {
          modelOverride: client.reasoningModel,
          reasoning: { effort: 'medium' },
          signal: ctx.signal,
          timeoutMs: 180_000,
        });

        return {
          ok: true,
          output:
            `# 项目结构自动发现（project_discover）\n\n` +
            `## 识别技术栈\n${stack.join('、') || '未知'}\n\n` +
            `## 目录树（深度 ${maxDepth}）\n\`\`\`\n${tree}\n\`\`\`\n\n` +
            `## 中文项目地图解读\n${interpretation}`,
        };
      } catch (e: unknown) {
        return { ok: false, output: `项目结构分析失败: ${msgOf(e)}` };
      }
    },
  };
}
