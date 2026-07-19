import chalk from 'chalk';

/**
 * 分级日志（P4 工程质量加固）。
 * 级别由环境变量控制：LOG_LEVEL=debug|info|warn|error（默认 info）；
 * 或设置 DEBUG=1 等价于 debug。
 * info/warn/error 始终输出（带级别前缀与颜色），debug 仅在开启时输出，
 * 用于开发期追踪 Agent Loop 迭代、工具执行等内部细节，不干扰正常交互。
 */

type Level = 'debug' | 'info' | 'warn' | 'error';

const RANK: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };

const envLevel = (process.env.LOG_LEVEL ?? (process.env.DEBUG ? 'debug' : 'info'))
  .toLowerCase() as Level;
const CURRENT = RANK[envLevel] ?? RANK.info;

const COLOR: Record<Level, (s: string) => string> = {
  debug: chalk.gray,
  info: chalk.cyan,
  warn: chalk.yellow,
  error: chalk.red,
};

function emit(level: Level, msg: string): void {
  if (RANK[level] >= CURRENT) {
    const line = COLOR[level](`[${level.toUpperCase()}] ${msg}`);
    // warn/error 走 stderr，避免污染 TUI/stdout 管道输出（info/debug 仍走 stdout）
    if (level === 'warn' || level === 'error') console.error(line);
    else console.log(line);
  }
}

export const logger = {
  debug: (msg: string) => emit('debug', msg),
  info: (msg: string) => emit('info', msg),
  warn: (msg: string) => emit('warn', msg),
  error: (msg: string) => emit('error', msg),
};

/** 错误提取：unknown 收窄为可读消息（供 catch 块统一使用） */
export function msgOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** 将 exec 异常收窄为 { code, stdout, stderr } 结构（run_command 专用） */
export interface ExecError {
  code: string;
  stdout: string;
  stderr: string;
}
export function asExecError(e: unknown): ExecError {
  if (e && typeof e === 'object') {
    const o = e as Record<string, unknown>;
    return {
      code: typeof o.code === 'string' ? o.code : '?',
      stdout: typeof o.stdout === 'string' ? o.stdout : '',
      stderr: typeof o.stderr === 'string' ? o.stderr : (typeof o.message === 'string' ? o.message : ''),
    };
  }
  return { code: '?', stdout: '', stderr: String(e) };
}
