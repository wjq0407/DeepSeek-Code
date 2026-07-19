// 验证「工作空间」改造：
//  1) 未配置 → get_settings 返回 workspaceRoot=null，且紧跟 workspace_suggest 候选（磁盘×命名组合）
//  2) 候选生成逻辑：在存在的盘上建一个 hint 名目录（如 D:/repo），应出现在候选里
//  3) set_settings 选该目录 → workspaceRoot 置位、workspace_suggest 清空（卡片收起）、file_tree 指向它
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';

const PORT = process.env.SMOKE_PORT || 4199;
const URL = `ws://127.0.0.1:${PORT}/ws`;

// 找一块存在的盘，建一个 hint 名目录以验证候选生成
const drives = ['D:\\', 'C:\\', 'E:\\', 'F:\\'];
const drive = drives.find((d) => fs.existsSync(d));
const hintDir = drive ? path.join(drive, 'repo') : path.join(os.tmpdir(), 'repo');
let madeHint = false;
try { fs.mkdirSync(hintDir, { recursive: true }); madeHint = true; } catch { /* 忽略 */ }
fs.writeFileSync(path.join(hintDir, 'app.ts'), 'export const n = 1;');

function mkUser() {
  return { u: 'ws_' + Math.random().toString(36).slice(2, 8), p: 'P' + Math.random().toString(36).slice(2, 10) };
}
const { u, p } = mkUser();
let ws;
const results = {};
let phase = 0;
function send(o) { ws.send(JSON.stringify(o)); }

ws = new WebSocket(URL);
ws.on('open', () => send({ type: 'register', username: u, password: p }));
ws.on('message', (raw) => {
  const m = JSON.parse(raw.toString());
  if (m.type === 'register_ok') return send({ type: 'login', username: u, password: p });
  if (m.type === 'auth_ok') return send({ type: 'get_settings' });
  if (m.type === 'settings' && phase === 0) { results.settings0 = m; return; }
  if (m.type === 'workspace_suggest' && phase === 0) {
    results.suggest0 = m;
    phase = 1;
    // 选我们建好的 hint 目录作为工作空间
    send({ type: 'set_settings', workspaceRoot: hintDir });
    return;
  }
  if (m.type === 'settings' && phase === 1) { results.settings1 = m; return; }
  if (m.type === 'workspace_suggest' && phase === 1) {
    results.suggest1 = m;
    send({ type: 'file_tree', path: '' });
    return;
  }
  if (m.type === 'file_tree_result' && phase === 1) {
    results.tree = m;
    finish();
  }
});
function finish() {
  const s0 = results.settings0, sg0 = results.suggest0, s1 = results.settings1, sg1 = results.suggest1, t = results.tree;
  console.log('settings0.workspaceRoot =', s0.workspaceRoot);
  console.log('suggest0.candidates (count) =', sg0.candidates.length);
  console.log('suggest0 includes hintDir =', sg0.candidates.includes(hintDir));
  console.log('settings1.workspaceRoot =', s1.workspaceRoot);
  console.log('suggest1.candidates (should be empty) =', JSON.stringify(sg1.candidates));
  console.log('tree.entries =', t.entries.map((e) => e.name).join(','));
  const ok =
    s0.workspaceRoot === null &&
    Array.isArray(sg0.candidates) &&
    (!madeHint || sg0.candidates.includes(hintDir)) &&
    s1.workspaceRoot === hintDir &&
    Array.isArray(sg1.candidates) && sg1.candidates.length === 0 &&
    t.entries.some((e) => e.name === 'app.ts');
  console.log(ok ? 'PASS ✅ 工作空间：候选生成 + 设置生效 + 卡片收起' : 'FAIL ❌');
  if (madeHint) fs.rmSync(hintDir, { recursive: true, force: true });
  process.exit(ok ? 0 : 1);
}
ws.on('error', (e) => { console.error('WS ERROR', e.message); process.exit(1); });
setTimeout(() => { console.error('TIMEOUT'); process.exit(2); }, 20000);
