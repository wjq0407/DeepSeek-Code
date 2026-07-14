/**
 * 对抗式「极端上下文」可靠性测试：红队上下文 clamp / 压缩子系统。
 *
 * 核心可靠性问题（都会真的让 DeepSeek API 报 400 或撑爆窗口）：
 *   1. clampToolOutput 是否真的「回灌裁剪、展示不裁」——超大工具结果回灌 history 时被裁，
 *      但 UI 事件仍拿到完整原文。
 *   2. compact 的所有路径（snip 降级 / 硬丢最旧 / 摘要 / 摘要失败降级 / 巨型单 round /
 *      getMessages 孤儿修复）跑完后，消息数组是否「永远 API 合法」：
 *      - 不出现悬空 tool_calls（assistant 声明了工具调用却没有对应 tool 结果）
 *      - 不出现孤儿 tool 结果（tool 消息找不到它的 assistant tool_call 母体）
 *   撕裂 tool_calls/tool 对 = 真实 400 陷阱，这是本 harness 主攻点。
 *
 * 运行：node --import tsx test/adversarial-context.ts
 */
import { runAgent, type AgentEvent } from '../src/agent/loop.ts';
import { ConversationHistory } from '../src/context/history.ts';
import type { ChatMessage, DeepSeekClient, ToolCall } from '../src/llm/deepseek.ts';
import type { ToolDef } from '../src/tools/index.ts';

// ── 结构合法性校验器：模拟 DeepSeek/OpenAI 对 tool_calls↔tool 配对的硬约束 ──
function validateStructure(msgs: ChatMessage[]): { ok: boolean; problems: string[] } {
  const problems: string[] = [];
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    // (A) 悬空 tool_calls：assistant 有 tool_calls，但其后（下一条 user/assistant 之前）
    //     缺少覆盖全部 id 的 tool 结果
    if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0) {
      const expected = new Set(m.tool_calls.map((tc) => tc.id));
      for (let j = i + 1; j < msgs.length; j++) {
        const n = msgs[j];
        if (n.role === 'tool' && n.tool_call_id) expected.delete(n.tool_call_id);
        if (n.role === 'user' || n.role === 'assistant') break;
      }
      if (expected.size > 0) problems.push(`悬空 tool_calls @${i}：缺 ${expected.size} 条结果`);
    }
    // (B) 孤儿 tool：tool 消息的 tool_call_id 必须能在「紧邻在前的 assistant tool_calls」里找到
    if (m.role === 'tool') {
      // 向前找最近的 assistant（中间只能是 tool 消息）
      let parent: ChatMessage | undefined;
      for (let j = i - 1; j >= 0; j--) {
        if (msgs[j].role === 'tool') continue;
        parent = msgs[j];
        break;
      }
      const ids = parent?.role === 'assistant' ? new Set((parent.tool_calls ?? []).map((tc) => tc.id)) : new Set<string>();
      if (!m.tool_call_id || !ids.has(m.tool_call_id)) problems.push(`孤儿 tool @${i}：id=${m.tool_call_id} 无母体`);
    }
  }
  return { ok: problems.length === 0, problems };
}

// 造一条「assistant 调 1 个工具 + 对应 tool 结果」的完整轮，content 长度可控（撑 token）
function toolRound(userText: string, asstText: string, toolOut: string, id: string): ChatMessage[] {
  const tc: ToolCall = { id, type: 'function', function: { name: 'read_file', arguments: '{"path":"x.ts"}' } };
  return [
    { role: 'user', content: userText },
    { role: 'assistant', content: asstText, tool_calls: [tc] },
    { role: 'tool', tool_call_id: id, name: 'read_file', content: toolOut },
  ];
}

function bigText(n: number): string {
  return 'x'.repeat(n);
}

// 直接往 history 灌入构造好的消息（绕过 addUser/addAssistant 便于精确构造极端结构）
function seed(history: ConversationHistory, rounds: ChatMessage[][]): void {
  history.loadMessages(rounds.flat());
}

interface Scenario {
  name: string;
  desc: string;
  run: () => Promise<{ ok: boolean; detail: string }>;
}

const SCENARIOS: Scenario[] = [
  {
    name: '① 巨型工具结果 · 回灌裁剪/展示不裁',
    desc: '模型调一次 read_file，工具吐出 5MB；回灌 history 必须被裁到预算内，UI 事件必须拿到完整原文',
    run: async () => {
      const HUGE = bigText(5_000_000); // 5MB
      const tools: ToolDef[] = [
        { name: 'read_file', description: 'read', parameters: {}, risk: 'low', execute: async () => ({ ok: true, output: HUGE }) },
      ];
      let call = 0;
      const client = {
        async *streamChat() {
          if (call++ === 0) yield { type: 'tool_use', tools: [{ id: 'c1', name: 'read_file', arguments: { path: 'big.log' } }] };
          else yield { type: 'content', text: '读完了，文件非常大，已截断查看。' };
        },
        getUsageSummary: () => ({ models: [], totalTokens: 0, totalCostCny: 0, totalCacheHitTokens: 0, totalCacheMissTokens: 0 }),
      } as unknown as DeepSeekClient;
      const history = new ConversationHistory('SYS');
      const events: AgentEvent[] = [];
      for await (const ev of runAgent('读一下 big.log', { client, history, permission: 'execute', tools, cwd: process.cwd(), ask: () => Promise.resolve(true) })) {
        events.push(ev);
      }
      const toolMsg = history.getMessages().find((m) => m.role === 'tool');
      const backLen = toolMsg?.content?.length ?? 0;
      const uiEvent = events.find((e) => e.type === 'tool_result') as { result?: string } | undefined;
      const uiLen = uiEvent?.result?.length ?? 0;
      const backClamped = backLen < 20_000; // 回灌被裁到预算量级
      const uiFull = uiLen >= 5_000_000; // 展示拿到完整原文
      const struct = validateStructure(history.getMessages());
      const ok = backClamped && uiFull && struct.ok;
      return { ok, detail: `回灌=${backLen}B(应<2万) 展示=${uiLen}B(应≥5M) 结构=${struct.ok ? 'OK' : struct.problems.join(';')}` };
    },
  },
  {
    name: '② 无 client · snip 降级压缩',
    desc: '海量长历史、无摘要 client → 走确定性 snip，压完必须结构合法且 token 下降',
    run: async () => {
      const history = new ConversationHistory('SYS', { maxTokens: 4000, keepRecentRounds: 2 });
      const rounds = Array.from({ length: 12 }, (_, k) => toolRound(`第${k}问`, `第${k}答，附大量说明 ${bigText(3000)}`, `工具输出 ${bigText(3000)}`, `id${k}`));
      seed(history, rounds);
      const before = history.estimateTotalTokens();
      await history.compact();
      const after = history.estimateTotalTokens();
      const struct = validateStructure(history.getMessages());
      const ok = struct.ok && after < before;
      return { ok, detail: `token ${before}→${after}（应下降） 结构=${struct.ok ? 'OK' : struct.problems.join(';')}` };
    },
  },
  {
    name: '③ 无 client · snip 后仍爆 → 硬丢最旧',
    desc: '预算极小，snip 后仍超 → 硬丢最旧 rounds；关键：不能在 round 中间切断而产生孤儿 tool',
    run: async () => {
      const history = new ConversationHistory('SYS', { maxTokens: 1500, keepRecentRounds: 2 });
      const rounds = Array.from({ length: 10 }, (_, k) => toolRound(`第${k}问`, `第${k}答 ${bigText(2000)}`, `输出 ${bigText(2000)}`, `id${k}`));
      seed(history, rounds);
      await history.compact();
      const msgs = history.getMessages();
      const struct = validateStructure(msgs);
      // 最近 2 轮（id8/id9）应保留
      const kept = msgs.filter((m) => m.role === 'tool').map((m) => m.tool_call_id);
      const recentKept = kept.includes('id9') && kept.includes('id8');
      const ok = struct.ok && recentKept;
      return { ok, detail: `保留 tool=${kept.join(',')}（应含 id8,id9） 结构=${struct.ok ? 'OK' : struct.problems.join(';')}` };
    },
  },
  {
    name: '④ 巨型单 round 独占超预算',
    desc: '单轮 = 1 user + 1 assistant(tool_calls) + 巨型 tool 结果，独自超预算且在 keepRecent 内 → 无法拆分，必须整轮保留不产生孤儿',
    run: async () => {
      const history = new ConversationHistory('SYS', { maxTokens: 2000, keepRecentRounds: 5 });
      const rounds = [
        toolRound('小问1', '小答1', '小输出1', 'a1'),
        toolRound('巨问', '巨答', bigText(50_000), 'big'),
      ];
      seed(history, rounds);
      let threw = false;
      try { await history.compact(); } catch { threw = true; }
      const struct = validateStructure(history.getMessages());
      const ok = !threw && struct.ok;
      return { ok, detail: `抛异常=${threw}（应false） 结构=${struct.ok ? 'OK' : struct.problems.join(';')}` };
    },
  },
  {
    name: '⑤ 摘要路径（有 mock client）',
    desc: '超预算 + 可用摘要 client → 最近轮完整保留、插入摘要消息、结构合法',
    run: async () => {
      const client = {
        primaryModel: 'mock-flash',
        complete: async () => '这是压缩后的结构化摘要：完成了文件读取与多处修改。',
        getUsageSummary: () => ({ models: [], totalTokens: 0, totalCostCny: 0, totalCacheHitTokens: 0, totalCacheMissTokens: 0 }),
      } as unknown as DeepSeekClient;
      const history = new ConversationHistory('SYS', { maxTokens: 4000, keepRecentRounds: 2, client });
      const rounds = Array.from({ length: 10 }, (_, k) => toolRound(`第${k}问`, `第${k}答 ${bigText(3000)}`, `输出 ${bigText(3000)}`, `id${k}`));
      seed(history, rounds);
      await history.compact();
      const msgs = history.getMessages();
      const struct = validateStructure(msgs);
      const hasSummary = msgs.some((m) => (m.content ?? '').includes('上下文摘要'));
      const recentKept = msgs.some((m) => m.tool_call_id === 'id9') && msgs.some((m) => m.tool_call_id === 'id8');
      const ok = struct.ok && hasSummary && recentKept;
      return { ok, detail: `含摘要=${hasSummary} 保留最近=${recentKept} 结构=${struct.ok ? 'OK' : struct.problems.join(';')}` };
    },
  },
  {
    name: '⑥ 摘要抛错 → 降级 truncate',
    desc: '摘要 client 抛异常 → 必须回落确定性 snip，不崩、结构合法',
    run: async () => {
      const client = {
        primaryModel: 'mock-flash',
        complete: async () => { throw new Error('模拟摘要服务 500'); },
        getUsageSummary: () => ({ models: [], totalTokens: 0, totalCostCny: 0, totalCacheHitTokens: 0, totalCacheMissTokens: 0 }),
      } as unknown as DeepSeekClient;
      const history = new ConversationHistory('SYS', { maxTokens: 3000, keepRecentRounds: 2, client });
      const rounds = Array.from({ length: 8 }, (_, k) => toolRound(`第${k}问`, `第${k}答 ${bigText(3000)}`, `输出 ${bigText(3000)}`, `id${k}`));
      seed(history, rounds);
      let threw = false;
      try { await history.compact(); } catch { threw = true; }
      const struct = validateStructure(history.getMessages());
      const ok = !threw && struct.ok;
      return { ok, detail: `抛异常=${threw}（应false，已降级） 结构=${struct.ok ? 'OK' : struct.problems.join(';')}` };
    },
  },
  {
    name: '⑦ getMessages 孤儿 tool_calls 修复',
    desc: '人为构造压缩牺牲：assistant 有 tool_calls 但对应 tool 结果丢失 → getMessages 必须剥离 tool_calls 并标注，使其 API 合法',
    run: async () => {
      const history = new ConversationHistory('SYS');
      const tc: ToolCall = { id: 'lost', type: 'function', function: { name: 'read_file', arguments: '{}' } };
      // 直接灌入「有 tool_calls 但没有 tool 结果」的坏结构
      history.loadMessages([
        { role: 'user', content: '问' },
        { role: 'assistant', content: '我去读文件', tool_calls: [tc] },
        { role: 'user', content: '下一问' }, // tool 结果缺失，直接又来 user
        { role: 'assistant', content: '好的' },
      ]);
      const msgs = history.getMessages();
      const struct = validateStructure(msgs);
      const asst = msgs.find((m) => m.role === 'assistant' && (m.content ?? '').includes('工具调用结果缺失'));
      const stripped = msgs.find((m) => m.role === 'assistant' && m.tool_calls && m.tool_calls.some((t) => t.id === 'lost'));
      const ok = struct.ok && !!asst && !stripped;
      return { ok, detail: `已标注=${!!asst} 已剥离tool_calls=${!stripped} 结构=${struct.ok ? 'OK' : struct.problems.join(';')}` };
    },
  },
  {
    name: '⑧ 压缩不撕裂 tool_calls/tool 对（400 主陷阱）',
    desc: '压缩边界若落在 assistant↔tool 之间就会 400；反复压缩后必须始终无孤儿',
    run: async () => {
      const history = new ConversationHistory('SYS', { maxTokens: 2500, keepRecentRounds: 3 });
      const rounds = Array.from({ length: 15 }, (_, k) => toolRound(`第${k}问`, `第${k}答 ${bigText(1500)}`, `输出 ${bigText(1500)}`, `id${k}`));
      seed(history, rounds);
      // 连续压缩 3 次，模拟长任务反复触发
      await history.compact();
      await history.compact();
      await history.compact();
      const struct = validateStructure(history.getMessages());
      return { ok: struct.ok, detail: `三次压缩后 结构=${struct.ok ? 'OK' : struct.problems.join(';')}` };
    },
  },
];

async function main() {
  console.log('══════════════════════════════════════════════════════════');
  console.log('  deepseek-code-agent · 极端上下文红队 · clamp/压缩可靠性');
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
    ? '  结论：clamp 分离设计 + 压缩全路径结构合法，上下文子系统可靠。'
    : '  结论：存在会撑爆窗口 / 触发 400 的路径，需加固（见上方 FAIL）。');
  console.log('══════════════════════════════════════════════════════════');
  process.exit(pass === SCENARIOS.length ? 0 : 1);
}

main().catch((e) => { console.error('HARNESS ERROR:', e); process.exit(2); });
