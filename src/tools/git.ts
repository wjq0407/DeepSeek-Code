import { spawn } from 'node:child_process';
import type { ToolDef } from './index.ts';
import { msgOf } from '../utils/logger.ts';
import { DeepSeekClient, ChatMessage } from '../llm/deepseek.ts';

/**
 * 安全执行 git 命令：使用 spawn 替代 shell 拼接，避免命令注入。
 */
async function gitExec(args: string[], cwd: string): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    const child = spawn('git', args, { cwd, timeout: 15000 });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d: Buffer) => { stdout += d.toString('utf8'); });
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString('utf8'); });
    child.on('close', (code) => {
      if (code === 0) {
        resolve({ ok: true, output: stdout || stderr || '(无输出)' });
      } else {
        resolve({ ok: false, output: stderr || stdout || `exit ${code}` });
      }
    });
    child.on('error', (e) => {
      resolve({ ok: false, output: `git 启动失败: ${e.message}` });
    });
  });
}

/**
 * Git 工具集：一等公民级 Git 操作。
 *
 * P2-2 增强：从"用 run_command 手写 git ..."升级为专用工具，
 * 参数带 Zod 校验，输出结构化。其中 git_commit_msg 是差异化能力——
 * 自动生成中文 Conventional Commits 风格提交信息。
 */

// ─── git_status：查看工作区状态 ───

export function createGitStatusTool(): ToolDef {
  return {
    name: 'git_status',
    description:
      '查看 Git 工作区状态（已修改/已暂存/未跟踪文件列表）。用于了解当前代码变更概况。',
    risk: 'low',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
    async execute(_args, ctx) {
      const res = await gitExec(['status', '--short'], ctx.cwd);
      if (!res.ok) return res;

      // 补充 branch 信息
      const branch = await gitExec(['branch', '--show-current'], ctx.cwd);
      const stats = await gitExec(['diff', '--stat'], ctx.cwd);

      return {
        ok: true,
        output: `[Git 状态] 分支: ${branch.output.trim()}\n\n${res.output}\n\n变更统计:\n${stats.output}`,
      };
    },
  };
}

// ─── git_diff：查看具体文件差异 ───

export function createGitDiffTool(): ToolDef {
  return {
    name: 'git_diff',
    description:
      '查看指定文件或目录的 Git 差异（未暂存的修改内容）。不传路径则显示全部差异。',
    risk: 'low',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: '要查看差异的文件或目录路径（相对工作目录），可选，默认全部',
        },
        staged: {
          type: 'boolean',
          description: '是否查看已暂存的差异（--staged），默认 false',
        },
      },
      required: [],
    },
    async execute(args, ctx) {
      const target = args.path ? String(args.path) : '.';
      const staged = args.staged === true;
      const gitArgs = ['diff'];
      if (staged) gitArgs.push('--cached');
      gitArgs.push('--', target);

      const res = await gitExec(gitArgs, ctx.cwd);
      // 截断过长 diff
      const output = res.output.length > 6000 ? res.output.slice(0, 6000) + '\n...(截断)' : res.output;
      return { ...res, output: output || '(无差异)' };
    },
  };
}

// ─── git_commit_msg：中文提交信息生成（差异化复合工具） ───

const COMMIT_MSG_SYSTEM = `你是一个中文 Git 提交信息生成助手。
根据提供的 Git 差异内容，生成一条符合 Conventional Commits 中文变体规范的提交信息。

要求：
1. 格式：<type>(<scope>): <中文标题>
   - type: feat / fix / docs / style / refactor / perf / test / build / ci / chore
   - scope: 可选，影响范围（如 auth、cli、tools）
   - 标题：简体中文，不超过 50 字，用祈使句语气
2. 如有必要，在标题后空一行加中文正文说明改动原因和影响
3. 不要编造差异中没有的信息
4. 输出纯文本（不要 markdown 包裹）`;

/** 固定提交信息指令：每次调用完全相同，与系统提示词共同构成 pro 的可缓存前缀 */
const COMMIT_MSG_PREAMBLE = `请根据以下 Git 差异生成一条符合 Conventional Commits 中文变体规范的提交信息。
格式：type(scope): 中文标题（≤50字，祈使句语气）。必要时空一行加中文正文说明改动原因与影响。
不编造差异中没有的信息；输出纯文本，不要 markdown 包裹。`;

export function createGitCommitMsgTool(client: DeepSeekClient): ToolDef {
  return {
    name: 'git_commit_msg',
    description:
      '【差异化能力】基于当前 Git 差异自动生成中文提交信息（Conventional Commits 规范）。生成后需用户确认再实际执行 git commit。',
    risk: 'low',
    parameters: {
      type: 'object',
      properties: {
        type_hint: {
          type: 'string',
          description: '可选的 commit type 建议（如 feat/fix/refactor），不传则自动判断',
        },
      },
      required: [],
    },
    async execute(args, ctx) {
      // 获取差异内容
      const diff = await gitExec(['diff', '--cached', '--diff-filter=ACMR'], ctx.cwd);
      const unstaged = await gitExec(['diff', '--diff-filter=ACMR'], ctx.cwd);

      if (!diff.ok && !unstaged.ok) {
        return { ok: false, output: '无法获取 Git 差异信息' };
      }

      const hasChanges = (diff.output && diff.output.trim().length > 0) ||
                         (unstaged.output && unstaged.output.trim().length > 0);

      if (!hasChanges) {
        return { ok: false, output: '没有可提交的变更（请先 git add 暂存文件）' };
      }

      // 组合差异内容给模型
      let diffContent = '';
      if (diff.output?.trim()) {
        diffContent += '=== 已暂存的变更 ===\n' + diff.output.slice(0, 8000) + '\n\n';
      }
      if (unstaged.output?.trim()) {
        diffContent += '=== 未暂存的变更 ===\n' + unstaged.output.slice(0, 8000) + '\n\n';
      }

      const typeHint = args.type_hint ? `\n建议的 commit type: ${args.type_hint}` : '';

      const msgs: ChatMessage[] = [
        { role: 'system', content: COMMIT_MSG_SYSTEM },
        { role: 'user', content: COMMIT_MSG_PREAMBLE },
        { role: 'user', content: `${typeHint}\n${diffContent}` },
      ];
      try {
        const commitMsg = await client.complete(msgs, 0.2, {
          modelOverride: client.reasoningModel,
          reasoning: { effort: 'medium' },
          signal: ctx.signal,
          timeoutMs: 180_000,
        });

        // 清理可能的 markdown 包裹
        const cleaned = commitMsg.replace(/^```(?:text)?\s*|\s*```$/g, '').trim();

        return {
          ok: true,
          output: `[生成的中文提交信息]\n${cleaned}\n\n提示：此消息仅供预览，如需执行提交请使用 run_command 执行 "git commit -m '...'"`,
        };
      } catch (e: unknown) {
        return { ok: false, output: `生成提交信息失败: ${msgOf(e)}` };
      }
    },
  };
}
