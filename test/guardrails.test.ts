import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fuzzyMatchBlock, isSourceMutating, createTools } from '../src/tools/index.ts';

// ---------- fuzzyMatchBlock（edit_file 鲁棒匹配）----------

test('fuzzyMatchBlock: 精确匹配返回正确索引', () => {
  const buf = 'line1\n  const x = 1;\nline3';
  assert.equal(fuzzyMatchBlock(buf, '  const x = 1;'), 6);
});

test('fuzzyMatchBlock: \\r\\n 归一后能匹配', () => {
  const buf = 'a\nb\nc';
  assert.equal(fuzzyMatchBlock(buf, 'a\r\nb\r\nc'), 0);
});

test('fuzzyMatchBlock: 缩进差异逐行空白归一匹配', () => {
  const buf = ['function f() {', '  const a = 1;', '  const b = 2;', '}'].join('\n');
  const old = ['function f() {', '    const a = 1;', '    const b = 2;', '}'].join('\n');
  const idx = fuzzyMatchBlock(buf, old);
  assert.ok(idx !== -1, '应匹配到缩进不同的块');
  const matched = buf.slice(idx, idx + old.length);
  assert.equal(matched.replace(/^\s+|\s+$/gm, ''), old.replace(/^\s+|\s+$/gm, ''));
});

test('fuzzyMatchBlock: 完全不匹配返回 -1', () => {
  assert.equal(fuzzyMatchBlock('abc', 'xyz'), -1);
});

test('fuzzyMatchBlock: 唯一性检测——存在第二处', () => {
  const buf = 'dup\nmid\ndup';
  const old = 'dup';
  const first = fuzzyMatchBlock(buf, old);
  assert.equal(first, 0);
  assert.ok(fuzzyMatchBlock(buf.slice(first + 1), old) !== -1, '应检测到第二处');
});

// ---------- isSourceMutating（run_command 源码改写护栏）----------

test('isSourceMutating: node -e 改写源码命中', () => {
  const cmd = `node -e "const fs=require('fs'); let c=fs.readFileSync('a.ts').replace(/x/g,'y'); fs.writeFileSync('a.ts',c)"`;
  assert.equal(isSourceMutating(cmd), true);
});

test('isSourceMutating: sed -i 命中', () => {
  assert.equal(isSourceMutating("sed -i 's/x/y/' src/a.ts"), true);
});

test('isSourceMutating: 重定向写源码命中', () => {
  assert.equal(isSourceMutating('echo "x" > src/a.ts'), true);
});

test('isSourceMutating: git checkout -- 命中', () => {
  assert.equal(isSourceMutating('git checkout -- src/a.ts'), true);
});

test('isSourceMutating: 正常运行命令不误伤', () => {
  assert.equal(isSourceMutating('node fib.js'), false);
  assert.equal(isSourceMutating('npm install typescript'), false);
  assert.equal(isSourceMutating('npx tsc'), false);
  assert.equal(isSourceMutating('node --version'), false);
  assert.equal(isSourceMutating('node --experimental-strip-types fib.ts'), false);
});

test('isSourceMutating: 无写文件特征的 node -e 不误伤', () => {
  assert.equal(isSourceMutating("node -e \"console.log('a'.replace('a','b'))\""), false);
});

// ---------- run_command 工具实例拦截（端到端级）----------

test('run_command: 拦截改写源码的 node -e 命令', async () => {
  const tools = createTools({} as never);
  const rc = tools.find((t) => t.name === 'run_command');
  assert.ok(rc, 'run_command 应存在');
  const res = await rc!.execute(
    { command: "node -e \"const fs=require('fs');fs.writeFileSync('a.ts','x')\"" },
    { cwd: process.cwd(), onProgress: () => {} },
  );
  assert.equal(res.ok, false);
  assert.match(res.output, /拦截|安全/);
});

test('run_command: 正常运行命令不被拦截', async () => {
  const tools = createTools({} as never);
  const rc = tools.find((t) => t.name === 'run_command');
  const res = await rc!.execute(
    { command: 'node --version' },
    { cwd: process.cwd(), onProgress: () => {} },
  );
  // 不应触发源码改写拦截（实际执行成败取决于环境，但绝不返回「安全拦截」）
  assert.doesNotMatch(res.output, /检测到该命令会改写源码/);
});
