import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

/**
 * 凭证模块：负责 API Key 的解析、持久化与读取。
 *
 * 设计目标（对应需求「首次登录填 Key，后续免登录，可随时替换」）：
 * - 持久化到用户级 `~/.dsa/credentials.json`（仅当前用户可读写，权限 0o600）。
 * - 解析优先级：进程环境变量 > 项目 .env（cwd → 项目根） > 用户级凭证文件。
 *   项目级 .env 仍可覆盖（便于临时切换账号 / 代理），但默认走持久化凭证。
 * - 返回 null 表示没有可用凭证，调用方应走登录界面。
 */

export interface Credentials {
  apiKey: string;
  baseURL?: string;
  model?: string;
  reasonerModel?: string;
}

/** 用户级凭证存储路径（与记忆层 ~/.dsa 同目录） */
export const CREDS_PATH = path.resolve(homedir(), '.dsa', 'credentials.json');

/** 解析 .env 文本为键值对（与旧 loadEnv 同规则：KEY=VALUE，忽略引号与空白） */
function parseEnv(txt: string): Record<string, string> {
  const kv: Record<string, string> = {};
  for (const line of txt.split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) kv[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return kv;
}

/** 从键值对中提取凭证；缺 apiKey 时返回 null */
function credsFromEnv(kv: Record<string, string | undefined>): Credentials | null {
  if (!kv.DEEPSEEK_API_KEY) return null;
  return {
    apiKey: kv.DEEPSEEK_API_KEY,
    baseURL: kv.DEEPSEEK_BASE_URL || undefined,
    model: kv.MODEL_ID || undefined,
    reasonerModel: kv.REASONER_MODEL_ID || undefined,
  };
}

/** 读取持久化凭证：优先 credentials.json，回退 legacy 的 home/.dsa/.env */
export async function loadStoredCredentials(): Promise<Credentials | null> {
  try {
    const txt = await readFile(CREDS_PATH, 'utf8');
    const c = JSON.parse(txt) as Partial<Credentials>;
    if (c.apiKey) {
      return {
        apiKey: c.apiKey,
        baseURL: c.baseURL || undefined,
        model: c.model || undefined,
        reasonerModel: c.reasonerModel || undefined,
      };
    }
  } catch {
    // credentials.json 不存在/损坏：尝试 legacy 路径
    try {
      const txt = await readFile(path.resolve(homedir(), '.dsa', '.env'), 'utf8');
      const c = credsFromEnv(parseEnv(txt));
      if (c) return c;
    } catch {
      /* 两者皆无 */
    }
  }
  return null;
}

/** 写入持久化凭证（目录递归创建，文件权限 0o600 仅本人可读） */
export async function saveCredentials(c: Credentials): Promise<void> {
  await mkdir(path.dirname(CREDS_PATH), { recursive: true });
  const data = JSON.stringify(
    {
      apiKey: c.apiKey,
      baseURL: c.baseURL ?? '',
      model: c.model ?? '',
      reasonerModel: c.reasonerModel ?? '',
    },
    null,
    2,
  );
  await writeFile(CREDS_PATH, data, { mode: 0o600 });
}

/**
 * 解析最终凭证：env > 项目 .env > 用户凭证。
 * 返回 null 表示需要走登录流程。
 */
export async function resolveCredentials(projectRoot: string, cwd: string): Promise<Credentials | null> {
  // 1. 进程环境变量（最高优先，便于 CI / 临时覆盖）
  if (process.env.DEEPSEEK_API_KEY) return credsFromEnv(process.env);
  // 2. 项目级 .env：cwd → 项目根（项目可强制覆盖用户级凭证）
  for (const base of [cwd, projectRoot]) {
    try {
      const txt = await readFile(path.resolve(base, '.env'), 'utf8');
      const c = credsFromEnv(parseEnv(txt));
      if (c) return c;
    } catch {
      /* 该目录无 .env */
    }
  }
  // 3. 用户级持久化凭证
  return loadStoredCredentials();
}

/** 把 Key 末尾 4 位脱敏，用于日志展示（如 ****a1b2） */
export function maskKey(apiKey: string): string {
  const tail = apiKey.slice(-4);
  return `****${tail}`;
}

/**
 * 每账号数据/凭据目录（网页版「账户密码登录」用）。
 * 每个账号拥有独立的 ~/.dsa/users/<username>/ 沙箱：其中包含 credentials.json
 * （API Key 设置）以及内核落盘的 .dsa/{sessions,traces,memory}。
 */
export function userDataDir(username: string): string {
  return path.resolve(homedir(), '.dsa', 'users', username);
}
export function userCredsPath(username: string): string {
  return path.resolve(userDataDir(username), 'credentials.json');
}
export async function loadUserCredentials(username: string): Promise<Credentials | null> {
  try {
    const txt = await readFile(userCredsPath(username), 'utf8');
    const c = JSON.parse(txt) as Partial<Credentials>;
    if (c.apiKey) {
      return {
        apiKey: c.apiKey,
        baseURL: c.baseURL || undefined,
        model: c.model || undefined,
        reasonerModel: c.reasonerModel || undefined,
      };
    }
  } catch {
    /* 该用户尚未配置 API Key */
  }
  return null;
}
export async function saveUserCredentials(username: string, c: Credentials): Promise<void> {
  await mkdir(path.dirname(userCredsPath(username)), { recursive: true });
  const data = JSON.stringify(
    {
      apiKey: c.apiKey,
      baseURL: c.baseURL ?? '',
      model: c.model ?? '',
      reasonerModel: c.reasonerModel ?? '',
    },
    null,
    2,
  );
  await writeFile(userCredsPath(username), data, { mode: 0o600 });
}
