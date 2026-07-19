/**
 * 本地账号库（网页版「账户密码登录」用）。
 *
 * 设计目标（对应需求「账户密码登录，API Key 在设置里配置」）：
 * - 账号存本机 ~/.dsa/accounts.json，密码用 scrypt 加盐哈希（无明文）。
 * - 登录成功后签发会话 token（随机 32 字节 hex），持久化在 accounts.json 的
 *   sessions 表里，重启服务后仍有效（30 天有效期）。
 * - 这是「单机骨架」的账户方案：无数据库、无外部服务，够本地/小团队跑；
 *   若要真正多用户部署，把本文件换成数据库 + 服务端会话即可，协议不变。
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { scryptSync, randomBytes, timingSafeEqual } from 'node:crypto';

const ACCOUNTS_PATH = path.resolve(homedir(), '.dsa', 'accounts.json');
const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 天

interface AccountRecord {
  salt: string;
  hash: string;
  createdAt: number;
}
interface SessionRecord {
  username: string;
  createdAt: number;
}
interface Store {
  users: Record<string, AccountRecord>;
  sessions: Record<string, SessionRecord>;
}

function emptyStore(): Store {
  return { users: {}, sessions: {} };
}

async function readStore(): Promise<Store> {
  try {
    const txt = await readFile(ACCOUNTS_PATH, 'utf8');
    const s = JSON.parse(txt) as Partial<Store>;
    return { users: s.users ?? {}, sessions: s.sessions ?? {} };
  } catch {
    return emptyStore();
  }
}

async function writeStore(s: Store): Promise<void> {
  await mkdir(path.dirname(ACCOUNTS_PATH), { recursive: true });
  await writeFile(ACCOUNTS_PATH, JSON.stringify(s, null, 2), { mode: 0o600 });
}

// ── 密码哈希（scrypt，同步即可：登录/注册低频，不阻塞关键路径）──
export function hashPassword(password: string): { salt: string; hash: string } {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, 64).toString('hex');
  return { salt, hash };
}

export function verifyPassword(password: string, salt: string, hash: string): boolean {
  const h = scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, 'hex');
  return h.length === expected.length && timingSafeEqual(h, expected);
}

// ── 输入校验 ──
export function validateUsername(u: string): string | null {
  if (u.length < 3 || u.length > 32) return '用户名长度需 3-32 个字符';
  if (!/^[a-zA-Z0-9_]+$/.test(u)) return '用户名只能包含字母、数字和下划线';
  return null;
}
export function validatePassword(p: string): string | null {
  if (p.length < 6) return '密码至少 6 位';
  return null;
}

// ── 注册 / 校验 ──
export interface RegisterResult {
  ok: boolean;
  error?: string;
}
export async function register(username: string, password: string): Promise<RegisterResult> {
  const uErr = validateUsername(username);
  if (uErr) return { ok: false, error: uErr };
  const pErr = validatePassword(password);
  if (pErr) return { ok: false, error: pErr };
  const store = await readStore();
  if (store.users[username]) return { ok: false, error: '该用户名已被注册' };
  const { salt, hash } = hashPassword(password);
  store.users[username] = { salt, hash, createdAt: Date.now() };
  await writeStore(store);
  return { ok: true };
}

export async function verify(username: string, password: string): Promise<boolean> {
  const store = await readStore();
  const rec = store.users[username];
  // 防时序侧信道：用户名不存在时也执行一次 scrypt，使响应时间与存在用户的校验一致，
  // 避免攻击者通过响应耗时差异枚举有效用户名。
  const h = rec
    ? scryptSync(password, rec.salt, 64)
    : scryptSync(password, randomBytes(16).toString('hex'), 64);
  if (!rec) return false;
  const expected = Buffer.from(rec.hash, 'hex');
  return h.length === expected.length && timingSafeEqual(h, expected);
}

// ── 会话 token ──
export async function issueToken(username: string): Promise<string> {
  const token = randomBytes(32).toString('hex');
  const store = await readStore();
  store.sessions[token] = { username, createdAt: Date.now() };
  await writeStore(store);
  return token;
}

export async function verifyToken(token: string): Promise<string | null> {
  const store = await readStore();
  const s = store.sessions[token];
  if (!s) return null;
  if (Date.now() - s.createdAt > TOKEN_TTL_MS) {
    delete store.sessions[token];
    await writeStore(store).catch(() => {});
    return null;
  }
  return s.username;
}

export async function revokeToken(token: string): Promise<void> {
  const store = await readStore();
  if (store.sessions[token]) {
    delete store.sessions[token];
    await writeStore(store).catch(() => {});
  }
}
