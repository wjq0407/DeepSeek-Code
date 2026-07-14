import { readFile, writeFile, mkdir, rm, access, readdir } from 'node:fs/promises';
import { exec, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

const execAsync = promisify(exec);

import type { DeepSeekClient } from '../llm/deepseek.ts';
import { msgOf, asExecError } from '../utils/logger.ts';
import { createReviewTool } from './review.ts';
import { createAuditTool } from './audit.ts';
import { createGitStatusTool, createGitDiffTool, createGitCommitMsgTool } from './git.ts';
import { createTerminologyTool, createProjectDiscoverTool } from './discovery.ts';

export type Risk = 'low' | 'mid' | 'high';

export interface ToolContext {
  cwd: string;
  /** 可选的流式输出回调。工具执行期间可调用此函数实时推送输出片段 */
  onProgress?: (text: string) => void;
  /** 可选的中断信号。当外层 Agent 被用户取消时，工具应尽力终止当前操作 */
  signal?: AbortSignal;
}

export interface ToolResult {
  ok: boolean;
  output: string;
}

export interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema，给 DeepSeek 模型
  risk: Risk;
  execute: (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>;
  /**
   * P0-② 写前 diff 审批：返回「将要发生什么变更」的可读预览（不落盘）。
   * 仅文件写类工具实现。Agent 在执行前会展示此预览并要求用户确认。
   */
  preview?: (args: Record<string, unknown>, ctx: ToolContext) => Promise<string> | string;
}

// 破坏性命令静态检测（安全底线：即使 execute 模式也升级为 high 并确认）
const DESTRUCTIVE_PATTERNS = [
  /rm\s+-rf\s+\//,
  /rm\s+-rf\s+~\//,
  /mkfs/,
  /dd\s+if=/,
  /git\s+push\s+--force/,
  /git\s+push\s+-f\s/,
  /drop\s+table/i,
  /drop\s+database/i,
  /shutdown/,
  /reboot/,
  />\s*\/dev\/sd/,
  /taskkill\s+\/f\s+\/im/, // 强杀全进程（可能误杀 Agent 自身）
];

export function isDestructive(command: string): boolean {
  return DESTRUCTIVE_PATTERNS.some((re) => re.test(command));
}

/**
 * 在文件内容中定位 old_string 的起始字符索引，比 buf.indexOf 更鲁棒。
 * 依次尝试：1) 精确匹配；2) 统一换行符(\r\n→\n)后匹配；
 * 3) 逐行忽略首尾空白匹配（覆盖缩进/行尾空白差异）。
 * 返回 -1 表示均失败。edit_file 用它替代 indexOf，减少因细微空白差异导致的失败。
 */
export function fuzzyMatchBlock(buf: string, oldS: string): number {
  const exact = buf.indexOf(oldS);
  if (exact !== -1) return exact;

  const normOld = oldS.replace(/\r\n/g, '\n');
  const e2 = buf.indexOf(normOld);
  if (e2 !== -1) return e2;

  const oldLines = normOld.split('\n');
  const bufLines = buf.split('\n');
  // 全空白块无意义，跳过逐行匹配避免误命中
  if (oldLines.every((l) => l.trim() === '')) return -1;

  if (oldLines.length === 1) {
    const target = oldLines[0];
    for (let i = 0; i < bufLines.length; i++) {
      if (bufLines[i] === target || bufLines[i].trim() === target.trim()) {
        let idx = 0;
        for (let k = 0; k < i; k++) idx += bufLines[k].length + 1;
        return idx;
      }
    }
    return -1;
  }
  for (let i = 0; i + oldLines.length <= bufLines.length; i++) {
    let ok = true;
    for (let j = 0; j < oldLines.length; j++) {
      if (bufLines[i + j].trim() !== oldLines[j].trim()) {
        ok = false;
        break;
      }
    }
    if (ok) {
      let idx = 0;
      for (let k = 0; k < i; k++) idx += bufLines[k].length + 1;
      return idx;
    }
  }
  return -1;
}

/**
 * 安全护栏：检测命令是否通过 run_command 改写项目源码文件。
 * 修改源码应使用 edit_file 工具，禁止用终端命令（如 node -e 正则替换、sed -i、
 * 重定向/tee 写源码、git checkout -- 丢弃改动）绕过，避免无 diff 审批的破坏性改动。
 */
export function isSourceMutating(command: string): boolean {
  const SRC = 'ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|json|md|css|html|vue';
  // node -e/--eval/--input-type 内联脚本且含文件写操作（如 readFileSync(...).replace / writeFileSync）
  if (
    /\bnode(?:\.exe)?\s+(?:-[ep]|--eval|--input-type)/.test(command) &&
    /writeFileSync|writeFile\(|appendFileSync|createWriteStream|copyFileSync|fs\.writeFile|readFileSync\([^)]*\)\s*\.replace/.test(command)
  ) {
    return true;
  }
  // sed -i / perl -i 原地改写
  if (/\bsed\b[^|]*\s-i\b/.test(command)) return true;
  if (/\bperl\b[^|]*\s-i\b/.test(command)) return true;
  // 重定向 / tee 写入源码文件
  if (new RegExp(`(?:>>?|>)\\s*['"]?[\\w./\\\\-]+\\.(?:${SRC})`).test(command)) return true;
  if (new RegExp(`\\btee\\b.+\\.(?:${SRC})`).test(command)) return true;
  // git checkout -- 丢弃工作区源码改动
  if (/\bgits*\s+checkout\s+--\s+/.test(command)) return true;
  return false;
}

function resolve(p: string, cwd: string): string {
  return path.isAbsolute(p) ? p : path.resolve(cwd, p);
}

/** 预览文本行数截断，避免超长 diff 撑爆 TUI 确认条 */
function clipPreview(s: string, maxLines = 24): string {
  const lines = s.split('\n');
  if (lines.length <= maxLines) return s;
  return lines.slice(0, maxLines).join('\n') + `\n… (共 ${lines.length} 行，已截断显示)`;
}

async function walkAndSearch(
  dir: string,
  re: RegExp,
  glob: string,
  results: string[],
  counter: { n: number },
): Promise<void> {
  if (counter.n > 200) return;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    if (counter.n > 200) break;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (ent.name === 'node_modules' || ent.name === '.git' || ent.name === 'dist' || ent.name === 'build') continue;
      await walkAndSearch(full, re, glob, results, counter);
    } else {
      if (glob !== '*') {
        // 支持形如 "*.ts" 的后缀匹配（只取 * 之后的部分，避免 "hosts" 误匹配 "*.ts"），
        // 也支持无通配的精确文件名匹配（如 "Makefile"）。
        const suffix = glob.startsWith('*') ? glob.slice(1) : null;
        const matched = suffix !== null ? ent.name.endsWith(suffix) : ent.name === glob;
        if (!matched) continue;
      }
      try {
        const content = await readFile(full, 'utf8');
        const lines = content.split('\n');
        for (let i = 0; i < lines.length && counter.n < 200; i++) {
          if (re.test(lines[i])) {
            results.push(`${full}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
            counter.n++;
          }
        }
      } catch {
        /* 跳过二进制/不可读文件 */
      }
    }
  }
}

export const BASE_TOOLS: ToolDef[] = [
  {
    name: 'read_file',
    description: '读取文件内容以理解代码。支持按行偏移和行数限制。',
    risk: 'low',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件相对工作目录或绝对路径' },
        offset: { type: 'integer', description: '起始行（从1计），可选' },
        limit: { type: 'integer', description: '读取行数，可选，默认400' },
      },
      required: ['path'],
    },
    async execute(args, ctx) {
      const fp = resolve(String(args.path), ctx.cwd);
      try {
        const buf = await readFile(fp, 'utf8');
        const lines = buf.split('\n');
        const off = args.offset ? Number(args.offset) : 1;
        const lim = args.limit ? Number(args.limit) : 400;
        const slice = lines.slice(off - 1, off - 1 + lim);
        return {
          ok: true,
          output: `文件: ${fp}\n总行数: ${lines.length}\n显示行 ${off}-${off + slice.length - 1}:\n\n${slice.join('\n')}`,
        };
      } catch (e: unknown) {
        return { ok: false, output: `读取失败: ${msgOf(e)}` };
      }
    },
  },
  {
    name: 'create_file',
    description: '创建新文件并写入内容。若文件已存在则失败，请用 edit_file 修改。',
    risk: 'mid',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件路径' },
        content: { type: 'string', description: '文件完整内容' },
      },
      required: ['path', 'content'],
    },
    async preview(args, ctx) {
      const fp = resolve(String(args.path), ctx.cwd);
      const content = String(args.content ?? '');
      const lines = content.split('\n');
      const head = clipPreview(content, 40);
      const ellipsis = lines.length > 40 ? `\n… (共 ${lines.length} 行，仅预览前 40 行)` : '';
      return `📄 将新建文件: ${fp}\n\n${head}${ellipsis}`;
    },
    async execute(args, ctx) {
      const fp = resolve(String(args.path), ctx.cwd);
      const content = String(args.content ?? '');
      try {
        await access(fp);
        return { ok: false, output: `文件已存在，若需修改请用 edit_file: ${fp}` };
      } catch {
        await mkdir(path.dirname(fp), { recursive: true });
        await writeFile(fp, content, 'utf8');
        return { ok: true, output: `已创建文件: ${fp} (${content.length} 字符)` };
      }
    },
  },
  {
    name: 'edit_file',
    description: '用字符串替换修改文件。old_string 必须在文件中唯一存在。这是修改现有源码的唯一正确工具——不要用 run_command（如 node -e 正则替换、sed -i）改写文件。',
    risk: 'mid',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件路径' },
        old_string: { type: 'string', description: '要被替换的原文本（需唯一）' },
        new_string: { type: 'string', description: '替换后的新文本' },
      },
      required: ['path', 'old_string', 'new_string'],
    },
    async preview(args, ctx) {
      const fp = resolve(String(args.path), ctx.cwd);
      const oldS = String(args.old_string);
      const newS = String(args.new_string);
      try {
        const buf = await readFile(fp, 'utf8');
        const idx = buf.indexOf(oldS);
        if (idx === -1) return `⚠️ 无法预览：未找到 old_string（执行时将报错）\n路径: ${fp}`;
        if (buf.indexOf(oldS, idx + 1) !== -1) return `⚠️ 无法预览：old_string 出现多次（执行时将报错）\n路径: ${fp}`;
        const lines = buf.split('\n');
        const startLine = buf.slice(0, idx).split('\n').length; // 1-based
        const oldLines = oldS.split('\n').length;
        const ctxN = 3;
        const from = Math.max(0, startLine - 1 - ctxN);
        const to = Math.min(lines.length, startLine - 1 + oldLines + ctxN);
        let out = `📝 将修改: ${fp}（第 ${startLine} 行附近）\n`;
        for (let i = from; i < to; i++) {
          const ln = i + 1;
          if (i >= startLine - 1 && i < startLine - 1 + oldLines) {
            out += `- ${ln} | ${lines[i]}\n`;
          } else {
            out += `  ${ln} | ${lines[i]}\n`;
          }
        }
        out += `        ↓ 替换为 ↓\n`;
        out += '+ ' + clipPreview(newS, 24).split('\n').join('\n+ ');
        return out;
      } catch {
        return `⚠️ 无法预览：文件不存在（执行时将报错）\n路径: ${fp}`;
      }
    },
    async execute(args, ctx) {
      const fp = resolve(String(args.path), ctx.cwd);
      const oldS = String(args.old_string);
      const newS = String(args.new_string);
      try {
        const buf = await readFile(fp, 'utf8');
        const idx = fuzzyMatchBlock(buf, oldS);
        if (idx === -1)
          return {
            ok: false,
            output:
              '未找到 old_string（已尝试精确匹配与逐行空白归一化匹配）。' +
              '\n请先用 read_file 重新读取该文件的最新内容，确认 old_string 与文件实际字节一致' +
              '（尤其缩进、换行、行尾），再调用 edit_file。',
          };
        if (fuzzyMatchBlock(buf.slice(idx + 1), oldS) !== -1)
          return { ok: false, output: 'old_string 在文件中出现多次，请提供更多上下文使其唯一' };
        const updated = buf.slice(0, idx) + newS + buf.slice(idx + oldS.length);
        await writeFile(fp, updated, 'utf8');
        return { ok: true, output: `已修改: ${fp}` };
      } catch (e: unknown) {
        return { ok: false, output: `修改失败: ${msgOf(e)}` };
      }
    },
  },
  {
    name: 'delete_file',
    description: '删除文件或空目录。危险操作，需用户确认。',
    risk: 'high',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: '待删除路径' } },
      required: ['path'],
    },
    async preview(args, ctx) {
      const fp = resolve(String(args.path), ctx.cwd);
      return `🗑️ 将删除: ${fp}\n⚠️ 此操作不可恢复，确认删除？`;
    },
    async execute(args, ctx) {
      const fp = resolve(String(args.path), ctx.cwd);
      try {
        await rm(fp, { recursive: false, force: false });
        return { ok: true, output: `已删除: ${fp}` };
      } catch (e: unknown) {
        return { ok: false, output: `删除失败: ${msgOf(e)}` };
      }
    },
  },
  {
    name: 'run_command',
    description: '在终端执行 shell 命令并返回 stdout/stderr/退出码。危险命令需确认。注意：禁止用本工具改写源码文件（如 node -e 替换、sed -i、重定向写 .ts/.py 等），修改代码请用 edit_file。',
    risk: 'high',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '要执行的命令' },
        cwd: { type: 'string', description: '工作目录，可选，默认项目根' },
      },
      required: ['command'],
    },
      async execute(args, ctx) {
      const cmd = String(args.command);
      const cwd = args.cwd ? resolve(String(args.cwd), ctx.cwd) : ctx.cwd;
      const { onProgress, signal } = ctx;

      // 安全检查：防止 taskkill 误杀 Agent 自身进程
      if (/taskkill\s+\/f\s+\/im\s+node\.exe/i.test(cmd)) {
        const selfPid = process.pid;
        const msg = `⚠️ 安全拦截: taskkill /f /im node.exe 会杀掉所有 Node 进程（含 Agent 自身 PID=${selfPid}）。建议改为 taskkill /f /pid <目标PID> 或 npx kill-port <port>`;
        onProgress?.(msg);
        return { ok: false, output: msg };
      }

      // 安全护栏：禁止用终端命令改写源码文件（应改用 edit_file）
      if (isSourceMutating(cmd)) {
        const msg =
          '⚠️ 安全拦截：检测到该命令会改写源码文件。修改代码请使用 edit_file 工具' +
          '（具备写前 diff 审批与精确/鲁棒匹配），不要用 run_command 绕过。';
        onProgress?.(msg);
        return { ok: false, output: msg };
      }

      // Windows 中文系统: 子进程 stdout 默认 GBK 编码（管道重定向不随 chcp 变化）
      // 故在 Buffer 层面解码：优先 UTF-8，若含替换符则回退 GBK
      const decode = (buf: Buffer): string => {
        if (process.platform !== 'win32') return buf.toString('utf8');
        const asUtf8 = buf.toString('utf8');
        if (asUtf8.includes('�')) {
          try {
            return new TextDecoder('gbk').decode(buf);
          } catch {
            return asUtf8;
          }
        }
        return asUtf8;
      };

      return new Promise<ToolResult>((resolve) => {
        // 外层已取消：直接返回，不启动子进程
        if (signal?.aborted) {
          resolve({ ok: false, output: '命令已取消（用户中断）' });
          return;
        }

        const startTime = Date.now();
        // 用 spawn 替代 exec，支持流式输出
        const child = spawn(cmd, [], {
          cwd,
          shell: true,
          timeout: 120000,
          // POSIX：detached 让子进程成为独立进程组 leader，便于用 -pid 递归杀掉
          // npm run dev 启动的 vite 等孙子进程，避免它们变孤儿继续占端口。Windows 走 taskkill /t。
          detached: process.platform !== 'win32',
          env: { ...process.env },
        });

        let stdout = '';
        let stderr = '';
        const MAX_OUTPUT = 8000;
        let timedOut = false;
        let aborted = false;
        // 守护标记：避免 close/兜底超时双触发导致 resolve 二次调用
        let settled = false;
        const settle = (result: ToolResult) => {
          if (settled) return;
          settled = true;
          clearTimeout(killTimer);
          clearTimeout(guardTimer);
          signal?.removeEventListener('abort', abortHandler);
          resolve(result);
        };

        // 递归杀进程树：避免 run_command 杀掉 shell 后，npm run dev 启动的 vite 等
        // 孙子进程变孤儿继续占端口 / 写已关闭的 pipe。
        const killTree = (force = false): void => {
          aborted = true;
          const pid = child.pid;
          if (!pid) return; // 进程已退出或 pid 不可用
          const sig: NodeJS.Signals = force ? 'SIGKILL' : 'SIGTERM';
          try {
            if (process.platform === 'win32') {
              // /T 递归杀整棵进程树（shell + npm + node + vite worker），
              // 任何孙进程还持有 pipe 写端都会导致 child.close 永久不触发。
              spawn(
                'taskkill',
                ['/pid', String(pid), '/t', '/f'],
                { stdio: 'ignore', detached: true, shell: false },
              ).unref();
            } else {
              // 负 pid = 整个进程组（含孙进程）
              process.kill(-pid, sig);
            }
          } catch {
            /* 已退出 */
          }
        };

        // 用户主动中断：接到 signal 后先 SIGTERM，5s 后升级 SIGKILL
        const abortHandler = () => {
          killTree(false);
          setTimeout(() => killTree(true), 5000);
        };
        signal?.addEventListener('abort', abortHandler);

        // 超时兜底：Node 的 timeout 选项在流式子进程下不保证回收进程树，
        // 故显式发 SIGTERM，仍不退出再升级 SIGKILL，避免后台进程（如 npm run dev）残留。
        const killTimer = setTimeout(() => {
          timedOut = true;
          killTree(false);
          setTimeout(() => killTree(true), 5000);
        }, 120000);

        // ═══ 核心修复：兜底 Promise 强制 resolve ═══
        // 即使 child.close 因孙进程持 pipe 而永不触发，超过最大总时长后必须 resolve，
        // 否则上游 await 永久挂起，agent 表现为「3 分钟后卡死」。
        // 时长 = 180s 业务超时 + 5s SIGKILL 升级 + 5s 孙进程清理 + 5s 缓冲 = 195s
        // 与 streamChat 180s 总超时对齐，避免 run_command 跑完时 streamChat 总超时已被吃掉
        const guardMs = 180_000 + 5_000 + 5_000 + 5_000;
        const guardTimer = setTimeout(() => {
          if (settled) return;
          // 主动 destroy 流，确保 Promise 不会因为 pipe 未关而继续等待
          child.stdout?.destroy();
          child.stderr?.destroy();
          const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
          const note = timedOut
            ? '（命令超时被杀，且孙进程未在窗口内退出）'
            : '（命令进程清理超时，已强制结束）';
          settle({
            ok: false,
            output: `命令: ${cmd}\n退出码: null | 耗时: ${elapsed}s (兜底超时)\n--- stdout ---\n${stdout.slice(0, MAX_OUTPUT)}\n--- stderr ---\n${stderr.slice(0, MAX_OUTPUT)}\n⚠️ ${note}`,
          });
        }, guardMs);

        child.stdout?.on('data', (chunk: Buffer) => {
          const line = decode(chunk);
          stdout += line;
          if (stdout.length > MAX_OUTPUT) stdout = stdout.slice(0, MAX_OUTPUT);
          onProgress?.(line); // 流式推送到 CLI
        });

        child.stderr?.on('data', (chunk: Buffer) => {
          const line = decode(chunk);
          stderr += line;
          if (stderr.length > MAX_OUTPUT) stderr = stderr.slice(0, MAX_OUTPUT);
          onProgress?.(line); // stderr 也实时推送
        });

        child.on('close', (code) => {
          const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
          const timeoutNote = timedOut ? '\n⚠️ 命令超时（120s）已被终止。' : '';
          const abortNote = aborted ? '\n⚠️ 用户已中断此命令。' : '';
          const out = `命令: ${cmd}\n退出码: ${code ?? 'null'} | 耗时: ${elapsed}s\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}${timeoutNote}${abortNote}`;
          settle({
            ok: code === 0 && !timedOut && !aborted,
            output: out.slice(0, MAX_OUTPUT),
          });
        });

        child.on('error', (e) => {
          settle({ ok: false, output: `命令启动失败: ${e.message}\n命令: ${cmd}` });
        });
      });
    },
  },
  {
    name: 'search_code',
    description: '在代码库中按正则搜索文本，返回匹配的文件与行号。',
    risk: 'low',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: '正则表达式' },
        path: { type: 'string', description: '搜索根目录，可选' },
        glob: { type: 'string', description: '文件匹配模式，如 *.ts，可选，默认全部' },
      },
      required: ['pattern'],
    },
    async execute(args, ctx) {
      const pattern = String(args.pattern);
      const root = args.path ? resolve(String(args.path), ctx.cwd) : ctx.cwd;
      const glob = args.glob ? String(args.glob) : '*';
      try {
        const re = new RegExp(pattern, 'i');
        const results: string[] = [];
        const counter = { n: 0 };
        await walkAndSearch(root, re, glob, results, counter);
        if (results.length === 0) return { ok: true, output: `未找到匹配 "${pattern}"` };
        return { ok: true, output: `匹配 ${counter.n} 处:\n${results.join('\n')}` };
      } catch (e: unknown) {
        return { ok: false, output: `搜索失败: ${msgOf(e)}` };
      }
    },
  },
  {
    // P1-⑥ 模型主动 awaitUser：中途向用户提问，等待其回复后再继续当前任务。
    // 真实拦截在 loop.ts（拿到回复作为工具结果回灌，不真正执行 execute）。
    name: 'awaitUser',
    description:
      '中途向用户提问并等待其回复后再继续当前任务。当你需要用户澄清需求、确认方向、' +
      '或提供模型无法自行获取的个人信息（如密钥、偏好、环境细节）时使用。参数 question 是你想问用户的问题。',
    risk: 'low',
    parameters: {
      type: 'object',
      properties: {
        question: { type: 'string', description: '要问用户的问题' },
      },
      required: ['question'],
    },
    async execute() {
      // 实际拦截在 loop.ts 中处理（awaitUser 不会真的执行到这里，而是挂起等待用户输入）
      return { ok: true, output: '' };
    },
  },
];

/**
 * 工具总装：基础 6 个编程动作 + 3 个 Git 工具 + 4 个差异化复合工具。
 * - 基础动作：read/create/edit/delete/run/search
 * - Git 工具：git_status/git_diff/git_commit_msg（P2-2 增强）
 * - 复合工具（依赖模型二次推理）：
 *   - review_code / audit_dependencies（中文代码审查 / 依赖安全审计，P0 基础）
 *   - terminology（中英术语对照，P3 差异化）
 *   - project_discover（项目结构自动发现，P3 差异化）
 */
export function createTools(client: DeepSeekClient): ToolDef[] {
  return [
    ...BASE_TOOLS,
    createGitStatusTool(),
    createGitDiffTool(),
    createGitCommitMsgTool(client),
    createReviewTool(client),
    createAuditTool(client),
    createTerminologyTool(client),
    createProjectDiscoverTool(client),
  ];
}
