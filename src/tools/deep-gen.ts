import path from 'node:path';
import { readFile, stat } from 'node:fs/promises';
import type { ToolDef } from './index.ts';
import { DeepSeekClient, ChatMessage } from '../llm/deepseek.ts';

/**
 * deep_gen — 双模型深度生成（Pro 驱动的复杂任务处理）。
 *
 * 定位：双模型架构的最高层——Pro 不仅是"审查者"，也可以是"生成者"。
 * 当 Flash 判断任务复杂度超出快思考能力范围时，将生成工作委托给 Pro。
 *
 * 与现有工具的关系：
 *   verify_code   → Pro 检查 Flash 写的代码对不对
 *   verify_answer → Pro 检查 Flash 的答复准不准
 *   review_code   → Pro 做全维度深度审查
 *   deep_gen      → Pro 直接生成代码/方案/分析（Flash 负责编排和应用）
 *
 * 适用场景（Flash 应调用 deep_gen 而非自己生成）：
 *   - 跨多文件的架构重构方案设计
 *   - 复杂算法实现（并发/分布式/加密/状态机）
 *   - 安全敏感的代码生成（认证/授权/数据校验）
 *   - 对现有代码库的深度分析报告
 *   - 用户明确要求"深度分析""专家级"的任务
 *
 * 不适用场景（Flash 自己处理更快更便宜）：
 *   - 简单 CRUD、单函数修改、模板代码
 *   - 读文件内容、搜索代码、解释概念
 *   - 少于 20 行的代码改动
 *
 * 成本：约 verify_code 的 2 倍、review_code 的 1.3 倍（reasoning=high + 更大输出）。
 * 每次调用约 ¥0.005-0.02（取决于输入/输出长度）。
 */

const DEEP_GEN_SYSTEM = `你是一名资深软件工程师，专门处理需要深度推理的复杂编程任务。
你的输出将由另一个 AI（编排者）接收并应用到代码库中。

请根据 task_type 输出对应格式：

【code】—— 直接可运行的代码：
\`\`\`<语言>
// 完整、可直接写入文件的代码
// 包含必要的 imports、类型定义、错误处理
// 关键逻辑附简短注释说明设计意图
\`\`\`

【plan】—— 分步骤执行计划：
1. 目标概述（1-2 句话）
2. 步骤清单（每步含：做什么、涉及文件、预期结果）
3. 风险点与注意事项

【analysis】—— 深度分析报告：
- 现状分析
- 问题诊断
- 方案对比（至少 2 个方案，含优缺点）
- 推荐方案及理由

【refactor】—— 重构方案：
- 当前问题
- 目标架构
- 分步迁移路径
- 每个文件的变更摘要

通用规则：
- 使用中文输出（代码注释也优先中文）。
- 代码必须可直接使用，不要留 TODO 或占位符。
- 考虑边界条件、错误处理、性能。
- 如果你不确定某个细节，明确标注假设并给出备选方案。
- 不要输出冗长的解释——代码/方案本身应该自解释。`;

const DEEP_GEN_PREAMBLE = `请根据以下任务描述和上下文，生成高质量的输出。
task_type 决定了输出格式，请严格遵循。
代码必须完整可用；方案必须具体可执行。`;

function resolve(p: string, cwd: string): string {
  const abs = path.isAbsolute(p) ? p : path.resolve(cwd, p);
  const rel = path.relative(cwd, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`路径遍历拒绝：${p} 不在工作目录内（cwd=${cwd}）`);
  }
  return abs;
}

/**
 * 收集上下文文件内容，有预算上限。
 * 成本优化：单文件最多 5000 字符，总上下文不超过 12000 字符。
 */
async function collectContext(
  contextPaths: string[] | undefined,
  cwd: string,
): Promise<string> {
  if (!contextPaths || contextPaths.length === 0) return '';

  const MAX_PER_FILE = 5000;
  const MAX_TOTAL = 12000;
  let total = 0;
  const parts: string[] = [];

  for (const p of contextPaths.slice(0, 5)) {
    if (total >= MAX_TOTAL) break;
    try {
      const abs = resolve(p, cwd);
      const s = await stat(abs);
      if (!s.isFile()) continue;
      const content = await readFile(abs, 'utf8');
      const truncated = content.slice(0, MAX_PER_FILE);
      const label = path.relative(cwd, abs);
      parts.push(`\n// === 上下文文件: ${label} ===\n${truncated}`);
      total += truncated.length;
    } catch {
      // 跳过不可读文件
    }
  }

  return parts.join('\n');
}

export function createDeepGenTool(client: DeepSeekClient): ToolDef {
  return {
    name: 'deep_gen',
    description:
      '【双模型深度生成】将复杂任务交由推理模型（Pro）深度处理并直接生成代码/方案/分析。' +
      '适用于：多文件架构设计、复杂算法实现、安全敏感代码、深度分析报告。' +
      '不适用于：简单增删改、单函数修改、少于 20 行的代码——这些你用 Flash 自己处理更快更省钱。' +
      '调用前提：你判断此任务确实需要深度推理才能高质量完成。每次调用成本约 ¥0.005-0.02。',
    risk: 'low',
    parameters: {
      type: 'object',
      properties: {
        task: {
          type: 'string',
          description:
            '任务描述。说清楚要生成什么、有什么约束、期望什么结果。越具体越好。如「为 src/auth/ 目录设计一个 JWT 刷新令牌机制，要求：无状态、支持黑名单、Token 过期 15 分钟」',
        },
        task_type: {
          type: 'string',
          description: '任务类型：code(生成代码) | plan(执行计划) | analysis(分析报告) | refactor(重构方案)',
          enum: ['code', 'plan', 'analysis', 'refactor'],
        },
        language: {
          type: 'string',
          description: '目标编程语言（仅 task_type=code 时需要），如 typescript/python/go/rust',
        },
        context_files: {
          type: 'array',
          items: { type: 'string' },
          description:
            '相关上下文文件路径列表（可选，最多 5 个）。提供这些文件内容帮助 Pro 理解现有代码结构和约束。如 ["src/auth/jwt.ts", "src/types/auth.ts"]',
        },
        constraints: {
          type: 'string',
          description:
            '额外约束条件（可选）。如「必须兼容 Node.js 18」「不要引入新依赖」「遵循项目现有的错误处理模式」',
        },
      },
      required: ['task', 'task_type'],
    },
    async execute(args, ctx) {
      const task = String(args.task ?? '');
      const taskType = String(args.task_type ?? 'code');
      const lang = args.language ? String(args.language) : '';

      if (task.trim().length === 0) {
        return { ok: false, output: '任务描述不能为空' };
      }

      // 成本优化：收集上下文（有预算上限）
      const contextFiles = Array.isArray(args.context_files)
        ? args.context_files.map(String)
        : undefined;
      const context = await collectContext(contextFiles, ctx.cwd);

      // 组装消息
      const langHint = lang ? `\n目标语言: ${lang}` : '';
      const constraintsHint = args.constraints ? `\n约束条件: ${String(args.constraints)}` : '';
      const contextBlock = context ? `\n\n现有代码上下文:\n${context}` : '';

      const user = `任务类型: ${taskType}${langHint}${constraintsHint}\n\n任务描述:\n${task}${contextBlock}`;

      const msgs: ChatMessage[] = [
        { role: 'system', content: DEEP_GEN_SYSTEM },
        { role: 'user', content: DEEP_GEN_PREAMBLE },
        { role: 'user', content: user },
      ];

      // 成本优化：根据任务类型调整 reasoning 强度
      // code/refactor 需要最强推理；plan/analysis 可降低一档
      const effort: 'high' | 'medium' =
        taskType === 'code' || taskType === 'refactor' ? 'high' : 'medium';

      const result = await client.complete(msgs, 0.3, {
        modelOverride: client.reasoningModel,
        reasoning: { effort },
        signal: ctx.signal,
        timeoutMs: 300_000, // 深度生成可给更长超时（5 分钟）
      });

      const typeLabel =
        taskType === 'code' ? '代码生成' :
        taskType === 'plan' ? '执行计划' :
        taskType === 'analysis' ? '分析报告' : '重构方案';

      return {
        ok: true,
        output: `# deep_gen: ${typeLabel}\n模型: ${client.reasoningModel} | reasoning: ${effort} | 任务: ${task.slice(0, 100)}...\n\n${result}`,
      };
    },
  };
}
