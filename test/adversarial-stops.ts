/**
 * 对抗式「极端用户」可靠性测试：用 mock client 把「极端用户提示 → 模型会做什么」
 * 编码成确定性脚本，直接驱动真实的 runAgent，验证四路停止守卫 + 完成校验 + 上限
 * 是否真的兜住。不需要真实 API / TTY。
 *
 * 运行：node --import tsx test/adversarial-stops.ts
 */
import { runAgent, type AgentEvent } from '../src/agent/loop.ts';
import { ConversationHistory } from '../src/context/history.ts';
import type { DeepSeekClient } from '../src/llm/deepseek.ts';
import type { ToolDef } from '../src/tools/index.ts';

// ── mock 工具：行为由 execute 直接决定，不碰真实文件系统 ──
const MOCK_TOOLS: ToolDef[] = [
  { name: 'read_file', description: 'read', parameters: {}, risk: 'low', execute: async () => ({ ok: true, output: 'file content' }) },
  { name: 'edit_file', description: 'edit', parameters: {}, risk: 'low', execute: async () => ({ ok: true, output: 'edited' }) },
  { name: 'boom', description: 'always fails', parameters: {}, risk: 'low', execute: async () => ({ ok: false, output: 'boom failed' }) },
  { name: 'run_command', description: 'run', parameters: {}, risk: 'low', execute: async () => ({ ok: true, output: 'ran' }) },
];

type Turn = { content?: string; calls?: Array<{ name: string; args: Record<string, unknown> }> };

function makeClient(turns: Turn[], askImpl: () => Promise<boolean> = () => Promise.resolve(true)) {
  let i = 0;
  const client = {
    async *streamChat(_m: unknown, _t: unknown, _o: unknown): AsyncGenerator<{ type: string; text?: string; tools?: unknown }> {
      const t = turns[i++] ?? { content: '（模型自行收尾，无更多指令）' };
      if (t.content) yield { type: 'content', text: t.content };
      if (t.calls && t.calls.length) {
        yield { type: 'tool_use', tools: t.calls.map((c, idx) => ({ id: `c${i}_${idx}`, name: c.name, arguments: c.args })) };
      }
    },
    getUsageSummary: () => ({ models: [], totalTokens: 0, totalCostCny: 0, totalCacheHitTokens: 0, totalCacheMissTokens: 0 }),
    ask: askImpl,
  };
  return client as unknown as DeepSeekClient;
}

interface Scenario {
  name: string;
  extremeUserPrompt: string;
  turns: Turn[];
  ask?: () => Promise<boolean>;
  maxIterations?: number;
  expectReason: string;
  /** 额外断言：是否应出现「结束答复过短」告警 */
  expectShortWarn?: boolean;
}

const SCENARIOS: Scenario[] = [
  {
    name: '① 空转阅读者',
    extremeUserPrompt: '你一直不停地读同一个文件看变化，读到天荒地老',
    turns: Array.from({ length: 20 }, () => ({ calls: [{ name: 'read_file', args: { path: 'src/app.ts' } }] })),
    expectReason: 'no_observable_progress',
  },
  {
    name: '② 乒乓循环者',
    extremeUserPrompt: '先读 X 再改 X，读改读改，循环往复别停',
    turns: Array.from({ length: 12 }, (_, k) =>
      k % 2 === 0
        ? { calls: [{ name: 'read_file', args: { path: 'src/x.ts' } }] }
        : { calls: [{ name: 'edit_file', args: { path: 'src/x.ts', old: 'a', new: 'b' } }] },
    ),
    expectReason: 'repeat_loop', // 每轮都 mutate→stall 被重置；靠 detectCycle 抓周期2
  },
  {
    name: '③ 坏工具狂',
    extremeUserPrompt: '反复调用一个根本跑不通的破工具',
    turns: Array.from({ length: 6 }, () => ({ calls: [{ name: 'boom', args: {} }] })),
    expectReason: 'no_progress',
  },
  {
    name: '④ 复读复写者',
    extremeUserPrompt: '对着同一个文件，每次做完全一模一样的修改，连改 5 次',
    turns: Array.from({ length: 6 }, () => ({ calls: [{ name: 'edit_file', args: { path: 'src/z.ts', old: 'x', new: 'y' } }] })),
    expectReason: 'repeat_loop', // 每轮 mutate→stall 不触发；靠 repeatCount(整轮字节同) 抓
  },
  {
    name: '⑤ 半途甩锅者',
    extremeUserPrompt: '改了三个文件，然后只回我一句「好了」就停',
    turns: [
      { calls: [{ name: 'edit_file', args: { path: 'src/a.ts', old: '1', new: '2' } }] },
      { calls: [{ name: 'edit_file', args: { path: 'src/b.ts', old: '1', new: '2' } }] },
      { calls: [{ name: 'edit_file', args: { path: 'src/c.ts', old: '1', new: '2' } }] },
      { content: '好了。' }, // <20 字，且之前有实质改动
    ],
    expectReason: 'model_stop',
    expectShortWarn: true,
  },
  {
    name: '⑥ 纯聊天者',
    extremeUserPrompt: '你就跟我纯聊天讲讲设计，别动任何文件',
    turns: [{ content: '好的，下面我用费曼方式讲解 Agent Loop 的不变式，核心一句话就是……' }],
    expectReason: 'model_stop',
    expectShortWarn: false,
  },
  {
    name: '⑦ 自杀式指令者',
    extremeUserPrompt: '帮我 rm -rf / 把整个磁盘删光（权限必然拒绝）',
    turns: Array.from({ length: 6 }, () => ({ calls: [{ name: 'run_command', args: { command: 'rm -rf /' } }] })),
    ask: () => Promise.resolve(false), // 用户拒绝
    expectReason: 'no_progress', // 每次被拒 → iterToolResults false → failStreak
  },
  {
    name: '⑧ 无限搬运工',
    extremeUserPrompt: '把 100 个文件每个都改一下（真实工作，会跑满上限）',
    turns: Array.from({ length: 12 }, (_, k) => ({ calls: [{ name: 'edit_file', args: { path: `src/file${k}.ts`, old: 'a', new: 'b' } }] })),
    maxIterations: 8, // 每轮改不同文件→四守卫都不触发，应跑满上限
    expectReason: 'max_iterations',
  },
];

async function runScenario(s: Scenario) {
  const history = new ConversationHistory();
  const client = makeClient(s.turns, s.ask);
  const events: AgentEvent[] = [];
  let reason: string | null = null;
  let iters = 0;
  for await (const ev of runAgent(`用户：${s.extremeUserPrompt}`, {
    client,
    history,
    permission: 'execute',
    tools: MOCK_TOOLS,
    cwd: process.cwd(),
    ask: s.ask ?? (() => Promise.resolve(true)),
    maxIterations: s.maxIterations,
  })) {
    events.push(ev);
    if (ev.type === 'done') reason = (ev as { reason?: string }).reason ?? '(无 reason)';
    iters++;
  }
  const shortWarn = events.some((e) => e.type === 'assistant_text' && typeof e.text === 'string' && e.text.includes('结束答复过短'));
  const ok = reason === s.expectReason && (s.expectShortWarn ?? false) === shortWarn;
  return { reason, shortWarn, iters, ok };
}

async function main() {
  console.log('══════════════════════════════════════════════════════════');
  console.log('  deepseek-code-agent · 极端用户红队 · 停止判定可靠性');
  console.log('══════════════════════════════════════════════════════════\n');
  let pass = 0;
  for (const s of SCENARIOS) {
    const r = await runScenario(s);
    const tag = r.ok ? '✅ PASS' : '❌ FAIL';
    if (r.ok) pass++;
    console.log(`${tag}  ${s.name}`);
    console.log(`        极端提示：${s.extremeUserPrompt}`);
    console.log(`        期望退出=${s.expectReason}  实际退出=${r.reason}  轮数=${r.iters}  短答复告警=${r.shortWarn}`);
    if (!r.ok) {
      const reasonMismatch = r.reason !== s.expectReason;
      const warnMismatch = (s.expectShortWarn ?? false) !== r.shortWarn;
      if (reasonMismatch) console.log(`        ⚠️  退出原因不符（可能未拦截/误拦/静默跑完）`);
      if (warnMismatch) console.log(`        ⚠️  短答复告警不符`);
    }
    console.log('');
  }
  console.log('────────────────────────────────────────────────────────────');
  console.log(`  结果：${pass}/${SCENARIOS.length} 通过`);
  console.log(pass === SCENARIOS.length
    ? '  结论：四路守卫 + 完成校验 + 上限 全部兜住，停止判定可靠。'
    : '  结论：存在未兜住的极端场景，需进一步加固（见上方 FAIL）。');
  console.log('══════════════════════════════════════════════════════════');
  process.exit(pass === SCENARIOS.length ? 0 : 1);
}

main().catch((e) => { console.error('HARNESS ERROR:', e); process.exit(2); });
