import { readFile, readdir, access } from 'node:fs/promises';
import path from 'node:path';
import type { ToolDef } from './index.ts';
import { msgOf } from '../utils/logger.ts';
import { DeepSeekClient, ChatMessage, type JsonSchemaDef } from '../llm/deepseek.ts';
import { z } from 'zod';
import { fetchStructured, formatAnchor, PRO_COMMON_PREFIX } from './structured-parse.ts';

/**
 * 差异化发现类复合工具集（P3 增强）。
 *
 * 这两个工具是 Claude Code 默认不具备、且最能体现「中文 + DeepSeek 能力释放」的方向：
 * 1. terminology（中英术语对照）——读英文技术文档/API/报错时自动映射中文通行译名
 * 2. project_discover（项目结构自动发现）——扫描目录树 + 识别技术栈 + 中文项目地图解读
 */

// ─── 公共：解析文件路径 ───
function resolvePath(p: string | undefined, cwd: string): string {
  if (!p) return cwd;
  const abs = path.isAbsolute(p) ? p : path.resolve(cwd, p);
  const rel = path.relative(cwd, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`路径遍历拒绝：${p} 不在工作目录内（cwd=${cwd}）`);
  }
  return abs;
}

// ─── terminology：中英术语对照（差异化复合工具） ───

const TERMINOLOGY_SYSTEM = `你是中英技术术语对照专家，专门服务中文开发者。
给定一段英文技术文档（或代码注释 / API 文档 / 报错信息 / README），请：
1. 提取关键专业术语，给出「英文术语 → 中文通行译法（业界通用译名）」
2. 对文档核心内容用中文做 2-4 句摘要
3. 若文中存在易混淆术语，给出辨析

要求：
- 术语译法使用业界通行中文译名，不要生造；严格基于原文，不臆造术语。
- ambiguous 仅在确有易混淆之处时填写，无则填空数组 []。

示例 1（React 文档片段）：
{"summary":"React 的 useEffect Hook 用于在函数组件中执行副作用操作，接受一个回调函数和可选的依赖数组。空依赖数组表示仅在组件挂载时执行一次，省略依赖数组则在每次渲染后都执行。","terms":[{"en":"useEffect","zh":"副作用 Hook","note":"React 函数组件中处理副作用的钩子，等价于类组件的 componentDidMount/componentDidUpdate/componentWillUnmount 的组合"},{"en":"dependency array","zh":"依赖数组","note":"决定 effect 重新执行时机的数组，React 通过浅比较判断依赖是否变化"},{"en":"cleanup function","zh":"清理函数","note":"effect 返回的函数，在组件卸载或 effect 重新执行前调用，用于取消订阅/清除定时器等"}],"ambiguous":[]}

示例 2（Node.js 错误信息）：
{"summary":"Node.js 进程因未捕获的 Promise 拒绝而崩溃。在 Node.js 15+ 中，未处理的 Promise 拒绝会导致进程以非零退出码终止。建议在所有 Promise 链末尾添加 .catch() 处理程序。","terms":[{"en":"unhandled promise rejection","zh":"未处理的 Promise 拒绝","note":"Promise 被拒绝但没有对应的 .catch() 或 try/catch 处理"},{"en":"non-zero exit code","zh":"非零退出码","note":"操作系统惯例：退出码 0 表示成功，非 0 表示异常终止"}],"ambiguous":[]}

示例 3（Docker 报错）：
{"summary":"Docker 容器因端口冲突启动失败。宿主机端口 3000 已被另一个进程占用，导致容器无法绑定该端口。建议更换映射端口或停止占用端口的进程。","terms":[{"en":"bind","zh":"绑定","note":"在计算机网络中指将套接字与特定地址和端口关联"},{"en":"port mapping","zh":"端口映射","note":"Docker 中将容器内部端口映射到宿主机端口的机制"}],"ambiguous":[{"term":"host","clarification":"上下文可能指 Docker 宿主机（运行 Docker 的物理/虚拟机器）或网络主机（IP 可达的设备），此处指宿主机"}]}`;

const TERMINOLOGY_PREAMBLE = `请对以下英文内容进行中英技术术语对照与中文摘要。
提取关键术语给出中文通行译法；用 2-4 句中文摘要核心内容；若有易混淆术语给出辨析。`;

/** zod 校验 schema */
const terminologySchema = z.object({
  summary: z.string().optional().default(''),
  terms: z.array(z.object({
    en: z.string().optional().default(''),
    zh: z.string().optional().default(''),
    note: z.string().optional().default(''),
  })).optional().default([]),
  ambiguous: z.array(z.object({
    term: z.string().optional().default(''),
    clarification: z.string().optional().default(''),
  })).optional().default([]),
});

/** json_schema 定义 */
const TERMINOLOGY_JSON_SCHEMA: JsonSchemaDef = {
  name: 'terminology_report',
  strict: true,
  schema: {
    type: 'object',
    properties: {
      summary: { type: 'string' },
      terms: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            en: { type: 'string' },
            zh: { type: 'string' },
            note: { type: 'string' },
          },
          required: ['en', 'zh', 'note'],
          additionalProperties: false,
        },
      },
      ambiguous: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            term: { type: 'string' },
            clarification: { type: 'string' },
          },
          required: ['term', 'clarification'],
          additionalProperties: false,
        },
      },
    },
    required: ['summary', 'terms', 'ambiguous'],
    additionalProperties: false,
  },
};

function renderTerminology(r: { summary?: string; terms?: Array<{ en?: string; zh?: string; note?: string }>; ambiguous?: Array<{ term?: string; clarification?: string }> }): string {
  let out = '';
  if (r.summary) out += `## 中文摘要\n${r.summary}\n\n`;

  const terms = r.terms ?? [];
  if (terms.length) {
    out += `## 术语对照\n| 英文 | 中文 | 辨析 |\n|---|---|---|\n`;
    for (const t of terms) {
      out += `| \`${String(t.en ?? '').replace(/\|/g, '\\|')}\` | ${String(t.zh ?? '').replace(/\|/g, '\\|')} | ${String(t.note ?? '').replace(/\|/g, '\\|')} |\n`;
    }
    out += '\n';
  }

  const ambiguous = r.ambiguous ?? [];
  if (ambiguous.length) {
    out += `## 易混淆辨析\n`;
    for (const a of ambiguous) out += `- **${a.term}**： ${a.clarification}\n`;
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
        content = content.slice(0, 12000);

        const anchoredPreamble = `${TERMINOLOGY_PREAMBLE} ${formatAnchor(
          'summary:string, terms:{en,zh,note}[], ambiguous:{term,clarification}[]',
          '不输出任何多余文本，只输出纯 JSON 对象。',
        )}`;

        const msgs: ChatMessage[] = [
          { role: 'system', content: PRO_COMMON_PREFIX },
          { role: 'system', content: TERMINOLOGY_SYSTEM },
          { role: 'user', content: anchoredPreamble },
          { role: 'user', content: content },
        ];

        const result = await fetchStructured(client, msgs, terminologySchema, TERMINOLOGY_JSON_SCHEMA, {
          maxRetries: 2,
          reasoningEffort: 'medium',
          signal: ctx.signal,
        });

        if (!result.ok) {
          return {
            ok: true,
            output: `# 中英术语对照（terminology）\n\n(结构化解析失败，展示原始结果)\n\n${result.rawText}`,
          };
        }

        return {
          ok: true,
          output: `# 中英术语对照（terminology）\n\n${renderTerminology(result.data!)}`,
        };
      } catch (e: unknown) {
        return { ok: false, output: `术语对照失败: ${msgOf(e)}` };
      }
    },
  };
}

// ─── project_discover：项目结构自动发现（差异化复合工具） ───
// 注：project_discover 返回 Markdown 文本，不走 JSON 结构化输出路径，保持原样。

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
  entries.sort((a, b) => {
    if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  for (const ent of entries) {
    if (ent.name.startsWith('.')) continue;
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

const PROJECT_DISCOVER_PREAMBLE = `请对以下目录结构与技术栈信号生成中文项目地图解读。
分析维度：项目类型概括 / 各目录用途标注 / 入口文件定位 / 构建与测试入口 / 结构改进提醒。
使用简体中文 Markdown 标题与列表，条理清晰；不要臆造不存在的文件；不要以客套语开头。`;

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

        let pkgInfo = '';
        try {
          const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
          pkgInfo =
            `项目名称: ${pkg.name ?? '-'}\n` +
            `入口: ${pkg.main ?? pkg.module ?? '-'}\n` +
            `脚本: ${Object.keys(pkg.scripts ?? {}).join(', ') || '-'}\n` +
            `依赖: ${(Object.keys(pkg.dependencies ?? {})).length} 生产 + ${(Object.keys(pkg.devDependencies ?? {})).length} 开发`;
        } catch {
          /* 非 Node 项目 */
        }

        const msgs: ChatMessage[] = [
          { role: 'system', content: PROJECT_MAP_SYSTEM },
          { role: 'user', content: PROJECT_DISCOVER_PREAMBLE },
          {
            role: 'user',
            content:
              `目录结构:\n${tree}\n\n` +
              `技术栈信号: ${stack.join('、') || '未知'}\n` +
              `${pkgInfo ? '\n' + pkgInfo + '\n' : ''}`,
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
