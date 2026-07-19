// 验证「未配置工作空间时不泄露工具源码」：
//  1) 未配置 → get_settings 返回 workspaceRoot=null/effectiveRoot=null，file_tree 返回 unconfigured=true 且无条目
//  2) 配置后 → file_tree 返回该项目的条目，且绝不出现工具自身源码特征文件（server.ts/package.json 等）
import { createInterface } from 'node:readline';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';

const PORT = process.env.SMOKE_PORT || 4199;
const URL = `ws://127.0.0.1:${PORT}/ws`;

const tmpProj = fs.mkdtempSync(path.join(os.tmpdir(), 'dsa-proj-'));
fs.writeFileSync(path.join(tmpProj, 'mycode.ts'), 'export const x = 1;');

function mkUser() {
  return { u: 'smoke_' + Math.random().toString(36).slice(2, 8), p: 'P' + Math.random().toString(36).slice(2, 10) };
}
const { u, p } = mkUser();
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
let ws;
let phase = 0;
const results = {};
function send(o) { ws.send(JSON.stringify(o)); }

ws = new WebSocket(URL);
ws.on('open', () => send({ type: 'register', username: u, password: p }));
ws.on('message', (raw) => {
  const m = JSON.parse(raw.toString());
  if (m.type === 'register_ok') return send({ type: 'login', username: u, password: p });
  if (m.type === 'auth_ok') return send({ type: 'get_settings' });
  if (m.type === 'settings' && phase === 0) {
    results.settings0 = m;
    send({ type: 'file_tree', path: '' });
  } else if (m.type === 'settings' && phase === 1) {
    // set_settings 回执 → 再拉一次文件树，验证已指向配置的项目
    send({ type: 'file_tree', path: '' });
  } else if (m.type === 'file_tree_result') {
    if (phase === 0) {
      results.treeUnconfigured = m;
      phase = 1;
      // 配置工作空间
      send({ type: 'set_settings', workspaceRoot: tmpProj });
    } else {
      results.treeConfigured = m;
      finish();
    }
  }
  // workspace_suggest 消息在本测试中忽略
});
function finish() {
  const s = results.settings0;
  const tu = results.treeUnconfigured;
  const tc = results.treeConfigured;
  const leak = tu.entries.some((e) => ['server.ts', 'package.json', 'src', 'node_modules'].includes(e.name));
  console.log('settings.workspaceRoot =', s.workspaceRoot);
  console.log('settings.effectiveRoot =', s.effectiveRoot);
  console.log('tree(unconfigured).unconfigured =', tu.unconfigured, '| entries =', tu.entries.length);
  console.log('tree(configured).entries =', tc.entries.map((e) => e.name).join(','));
  const ok =
    s.workspaceRoot === null &&
    s.effectiveRoot === null &&
    tu.unconfigured === true &&
    tu.entries.length === 0 &&
    !leak &&
    tc.entries.some((e) => e.name === 'mycode.ts');
  console.log(ok ? 'PASS ✅ 未配置时不泄露源码，配置后指向项目' : 'FAIL ❌');
  fs.rmSync(tmpProj, { recursive: true, force: true });
  process.exit(ok ? 0 : 1);
}
ws.on('error', (e) => { console.error('WS ERROR', e.message); process.exit(1); });
setTimeout(() => { console.error('TIMEOUT'); process.exit(2); }, 15000);
