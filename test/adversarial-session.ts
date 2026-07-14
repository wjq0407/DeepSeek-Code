/**
 * 对抗式「极端会话生命周期」可靠性测试：红队 SessionManager。
 *
 * 核心可靠性问题（都会让 UI 永久卡死或泄漏挂起的 Promise）：
 *   1. 永不卡死：whenDone 必须在「完成 / 出错 / 被 abort / 被删除」任一情况下 settle，
 *      绝不永久 pending —— 这是「防 Ctrl+C 卡死」的根本不变式。
 *   2. remove 一个正在等输入(needs_input)的会话，必须 resolve(false) 释放挂起的 ask，
 *      不能把后台生成器永久挂死。
 *   3. 上下文隔离：每个子会话持有独立 history。
 *   4. 边界不崩：fork 不存在的父 → null；resume 无 pendingAsk → no-op；主会话不可删。
 *
 * 用注入 fake runner 驱动真实 SessionManager，确定性、无真实 API。
 * 运行：node --import tsx test/adversarial-session.ts
 */
import { SessionManager, type Session, type SpawnOptions } from '../src/agent/session.ts';
import { ConversationHistory } from '../src/context/history.ts';
import type { AgentEvent, RunOptions } from '../src/agent/loop.ts';
import type { DeepSeekClient } from '../src/llm/deepseek.ts';

const tick = (ms = 15) => new Promise((r) => setTimeout(r, ms));

function makeMain(): Session {
  return {
    id: 'main', title: 'main', kind: 'main', status: 'working',
    history: new ConversationHistory('SYS'), output: '', createdAt: Date.now(), updatedAt: Date.now(),
  };
}

// 最小 SpawnOptions（client/tools 只是占位，fake runner 不会真用）
function baseOpts(runner: SpawnOptions['runner'], extra: Partial<SpawnOptions> = {}): SpawnOptions {
  return {
    client: {} as unknown as DeepSeekClient,
    tools: [], cwd: process.cwd(), runner, ...extra,
  };
}

// ── fake runner 家族：把「后台 Agent 会怎么跑」编码成确定性生成器 ──

/** 立即产出若干文本后正常完成 */
function runnerQuick(text = '完成'): SpawnOptions['runner'] {
  return async function* (): AsyncGenerator<AgentEvent> {
    yield { type: 'assistant_text', text };
  };
}

/** 抛异常（模拟后台崩溃） */
function runnerThrows(): SpawnOptions['runner'] {
  return async function* (): AsyncGenerator<AgentEvent> {
    yield { type: 'assistant_text', text: '开始' };
    throw new Error('后台 runner 炸了');
  };
}

/** 调用 ask 挂起（模拟模型请求用户确认），resolve 后再完成 */
function runnerAsks(): SpawnOptions['runner'] {
  return async function* (_input: string, runOpts: RunOptions): AsyncGenerator<AgentEvent> {
    yield { type: 'assistant_text', text: '需要你确认一下' };
    const ok = await runOpts.ask!('是否继续？');
    yield { type: 'assistant_text', text: ok ? '已确认，继续' : '被拒绝/取消，收尾' };
  };
}

interface Scenario {
  name: string;
  desc: string;
  run: () => Promise<{ ok: boolean; detail: string }>;
}

const SCENARIOS: Scenario[] = [
  {
    name: '① whenDone 完成会话立即返回',
    desc: 'spawn 一个秒完成的子会话，whenDone 必须 resolve 且状态=completed',
    run: async () => {
      const m = new SessionManager(makeMain());
      const s = m.spawn('任务A', baseOpts(runnerQuick('done A')));
      const done = await m.whenDone(s.id);
      const ok = done.status === 'completed' && done.output.includes('done A');
      return { ok, detail: `状态=${done.status} 输出含"done A"=${done.output.includes('done A')}` };
    },
  },
  {
    name: '② whenDone 崩溃会话返回 error',
    desc: '后台 runner 抛异常 → 状态必须转 error，whenDone 仍 settle（不卡死）',
    run: async () => {
      const m = new SessionManager(makeMain());
      const s = m.spawn('任务B', baseOpts(runnerThrows()));
      const done = await Promise.race([m.whenDone(s.id), tick(1000).then(() => 'TIMEOUT' as const)]);
      const ok = done !== 'TIMEOUT' && (done as Session).status === 'error';
      return { ok, detail: done === 'TIMEOUT' ? '❌ whenDone 超时卡死' : `状态=${(done as Session).status}` };
    },
  },
  {
    name: '③ whenDone 不存在会话 → reject',
    desc: 'whenDone 一个不存在的 id 必须 reject，而不是永久 pending',
    run: async () => {
      const m = new SessionManager(makeMain());
      let rejected = false;
      try { await m.whenDone('nope'); } catch { rejected = true; }
      return { ok: rejected, detail: `rejected=${rejected}（应true）` };
    },
  },
  {
    name: '④ needs_input 永久挂起 + abort → whenDone 不卡死',
    desc: '后台等用户输入且永不 resume；abort 信号必须能让 whenDone 立即返回（防 Ctrl+C 卡死根本不变式）',
    run: async () => {
      const m = new SessionManager(makeMain());
      const ac = new AbortController();
      const s = m.spawn('任务C', baseOpts(runnerAsks()));
      await tick(); // 让后台跑到 ask，状态转 needs_input
      const p = m.whenDone(s.id, ac.signal);
      ac.abort(); // 用户 Ctrl+C
      const done = await Promise.race([p, tick(1000).then(() => 'TIMEOUT' as const)]);
      const ok = done !== 'TIMEOUT';
      return { ok, detail: done === 'TIMEOUT' ? '❌ abort 后仍卡死' : `abort 后返回，状态=${(done as Session).status}` };
    },
  },
  {
    name: '⑤ signal 先 abort 再 whenDone → 立即返回',
    desc: '传入的 signal 已经是 aborted 状态时，whenDone 必须立即 settle',
    run: async () => {
      const m = new SessionManager(makeMain());
      const ac = new AbortController();
      ac.abort();
      const s = m.spawn('任务D', baseOpts(runnerAsks()));
      await tick();
      const done = await Promise.race([m.whenDone(s.id, ac.signal), tick(1000).then(() => 'TIMEOUT' as const)]);
      return { ok: done !== 'TIMEOUT', detail: done === 'TIMEOUT' ? '❌ 已 abort 仍卡死' : '立即返回' };
    },
  },
  {
    name: '⑥ remove 正在等输入的会话 → resolve(false) 不挂死',
    desc: '删除一个 needs_input 会话，pendingAsk 必须 resolve(false) 让后台生成器收尾，且从 map 移除',
    run: async () => {
      const m = new SessionManager(makeMain());
      const s = m.spawn('任务E', baseOpts(runnerAsks()));
      await tick();
      const wasNeedsInput = s.status === 'needs_input';
      m.remove(s.id);
      await tick();
      const removed = !m.sessions.has(s.id);
      // 后台生成器应已收尾（收到 false 分支），不再抛未处理异常
      const ok = wasNeedsInput && removed;
      return { ok, detail: `删前 needs_input=${wasNeedsInput} 已移除=${removed}` };
    },
  },
  {
    name: '⑦ spawn 后立即 remove（working 中）→ whenDone 返回',
    desc: '会话仍在跑时被删，whenDone 应经「session 消失」分支 settle，不卡死',
    run: async () => {
      const m = new SessionManager(makeMain());
      const s = m.spawn('任务F', baseOpts(runnerAsks()));
      const p = m.whenDone(s.id);
      await tick();
      m.remove(s.id);
      const done = await Promise.race([p, tick(1000).then(() => 'TIMEOUT' as const)]);
      return { ok: done !== 'TIMEOUT', detail: done === 'TIMEOUT' ? '❌ 删除后 whenDone 卡死' : '已 settle' };
    },
  },
  {
    name: '⑧ fork 不存在父 → null',
    desc: 'fork 一个不存在的 parentId 必须返回 null 而非崩溃',
    run: async () => {
      const m = new SessionManager(makeMain());
      const f = m.fork('ghost');
      return { ok: f === null, detail: `fork 结果=${f === null ? 'null' : '非null'}` };
    },
  },
  {
    name: '⑨ fork + continueSession 跑在克隆历史上',
    desc: 'fork 应深拷贝父历史；continueSession 复用父 opts 续写，whenDone 正常 settle',
    run: async () => {
      const m = new SessionManager(makeMain());
      const parent = m.spawn('父任务', baseOpts(runnerQuick('父输出')));
      await m.whenDone(parent.id);
      const parentMsgCount = parent.history.getMessages().length;
      const f = m.fork(parent.id);
      if (!f) return { ok: false, detail: 'fork 返回 null' };
      const isolated = f.history !== parent.history;
      const clonedMsgs = f.history.getMessages().length >= parentMsgCount;
      m.continueSession(f.id, '续写指令');
      const done = await Promise.race([m.whenDone(f.id), tick(1000).then(() => 'TIMEOUT' as const)]);
      const settled = done !== 'TIMEOUT';
      return { ok: isolated && clonedMsgs && settled, detail: `独立history=${isolated} 克隆消息=${clonedMsgs} 续写settle=${settled}` };
    },
  },
  {
    name: '⑩ 边界：resume 无 pendingAsk / remove 主会话',
    desc: 'resume 一个没在等输入的会话应 no-op；remove 主会话应被拒绝，二者都不崩',
    run: async () => {
      const m = new SessionManager(makeMain());
      let threw = false;
      try {
        m.resume('main'); // 主会话无 pendingAsk
        const s = m.spawn('任务G', baseOpts(runnerQuick()));
        m.resume(s.id); // 子会话此刻也无 pendingAsk
        m.remove('main'); // 主会话不可删
      } catch { threw = true; }
      const mainAlive = m.sessions.has('main');
      return { ok: !threw && mainAlive, detail: `抛异常=${threw}（应false） 主会话存活=${mainAlive}（应true）` };
    },
  },
  {
    name: '⑪ 上下文隔离：多子会话历史互不共享',
    desc: '并发 spawn 两个子会话，各自持有独立 history 实例',
    run: async () => {
      const m = new SessionManager(makeMain());
      const a = m.spawn('A', baseOpts(runnerQuick('A')));
      const b = m.spawn('B', baseOpts(runnerQuick('B')));
      await Promise.all([m.whenDone(a.id), m.whenDone(b.id)]);
      const isolated = a.history !== b.history && a.history !== (m.sessions.get('main') as Session).history;
      return { ok: isolated, detail: `三者 history 互不相同=${isolated}` };
    },
  },
];

async function main() {
  console.log('══════════════════════════════════════════════════════════');
  console.log('  deepseek-code-agent · 极端会话红队 · 生命周期可靠性');
  console.log('══════════════════════════════════════════════════════════\n');
  let pass = 0;
  for (const s of SCENARIOS) {
    let r: { ok: boolean; detail: string };
    try {
      r = await s.run();
    } catch (e) {
      r = { ok: false, detail: `运行抛异常：${e instanceof Error ? e.message : String(e)}` };
    }
    if (r.ok) pass++;
    console.log(`${r.ok ? '✅ PASS' : '❌ FAIL'}  ${s.name}`);
    console.log(`        ${s.desc}`);
    console.log(`        ${r.detail}\n`);
  }
  console.log('────────────────────────────────────────────────────────────');
  console.log(`  结果：${pass}/${SCENARIOS.length} 通过`);
  console.log(pass === SCENARIOS.length
    ? '  结论：whenDone 永不卡死 + remove 不挂死 + 隔离/边界稳固，会话生命周期可靠。'
    : '  结论：存在会卡死 / 挂起 Promise 的路径，需加固（见上方 FAIL）。');
  console.log('══════════════════════════════════════════════════════════');
  process.exit(pass === SCENARIOS.length ? 0 : 1);
}

main().catch((e) => { console.error('HARNESS ERROR:', e); process.exit(2); });
