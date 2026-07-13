import os from 'node:os';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Embedder } from './src/memory/embedder.ts';
import { MemoryManager } from './src/memory/manager.ts';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean): void {
  if (cond) {
    pass++;
    console.log('PASS', name);
  } else {
    fail++;
    console.log('FAIL', name);
  }
}

const tmpBase = mkdtempSync(join(os.tmpdir(), 'dsa-mm-'));
const tmpCwd = join(tmpBase, 'project');
const tmpHome = join(tmpBase, 'home');
// 重定向 HOME，使用户级记忆落入临时目录（避免污染真实 ~/.dsa）
process.env.HOME = tmpHome;

const embedder = new Embedder(); // 无 key → 嵌入返回 null，自动降级关键词检索
const mm = new MemoryManager(tmpCwd, embedder);

// 1) 常驻事实分层落盘
mm.addFact('全局：用户偏好中文注释', 'user');
mm.addFact('项目：用 pnpm 构建', 'project');
const facts = mm.loadFacts();
check('用户级事实含全局偏好', facts.user.includes('全局：用户偏好中文注释'));
check('项目级事实含 pnpm', facts.project.includes('项目：用 pnpm 构建'));
check('用户级不含项目事实', !facts.user.includes('pnpm'));
check('项目级不含用户事实', !facts.project.includes('中文注释'));

const userMd = join(tmpHome, '.dsa', 'memory', 'MEMORY.md');
const projMd = join(tmpCwd, '.dsa', 'memory', 'MEMORY.md');
check('用户级 MEMORY.md 落在临时 HOME', existsSync(userMd) && readFileSync(userMd, 'utf8').includes('中文注释'));
check('项目级 MEMORY.md 落在 cwd', existsSync(projMd) && readFileSync(projMd, 'utf8').includes('pnpm'));

// 2) 语义记忆 + list 标注 scope
const e1 = await mm.addEntry('用户习惯用 Tab 缩进', ['编码风格'], 'user');
const e2 = await mm.addEntry('本项目用 Vite', ['构建'], 'project');
const all = mm.list();
check('list 含 2 条', all.length === 2);
check('list 标注 user', all.some((x) => x.scope === 'user'));
check('list 标注 project', all.some((x) => x.scope === 'project'));

// 3) 跨层 isDuplicate：项目层写相同内容，用户层应判重
const dup = await mm.isDuplicate('用户习惯用 Tab 缩进');
check('跨层 isDuplicate 命中用户级', dup === true);
const notDup = await mm.isDuplicate('完全不同的新偏好 xyz');
check('isDuplicate 对无关内容返回 false', notDup === false);

// 4) compose 分段注入
const prompt = await mm.compose('SYSTEM_BASE', '用户缩进偏好', 5);
check('compose 含用户全局记忆段', prompt.includes('用户全局记忆'));
check('compose 含项目记忆段', prompt.includes('项目记忆'));
check('compose 以 BASE 开头', prompt.startsWith('SYSTEM_BASE'));

// 5) forget 指定 scope
const forgot = mm.forget(e1.id.slice(0, 8), 'user');
check('forget 用户级成功', forgot === true);
check('用户级语义记忆已删', !mm.list().some((x) => x.scope === 'user'));

console.log(`\n${pass} PASS / ${fail} FAIL`);
rmSync(tmpBase, { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);
