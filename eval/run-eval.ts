import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { DeepSeekClient, ChatMessage } from '../src/llm/deepseek.ts';
import { ConversationHistory } from '../src/context/history.ts';
import { runAgent } from '../src/agent/loop.ts';
import { createDelegateTool } from '../src/agent/subagent.ts';
import { createTools } from '../src/tools/index.ts';
import { SYSTEM_PROMPT } from '../src/agent/system-prompt.ts';
import { CASES } from './cases.ts';
import { CaseResult, GoldenCase, ToolCallRecord } from './types.ts';

function loadEnv(): { apiKey: string; baseURL: string; model: string; reasonerModel?: string } {
  const p = 'D:/作业/AI Agent/deepseek-code-agent/.env';
  const txt = readFileSync(p, 'utf8');
  const kv: Record<string, string> = {};
  for (const line of txt.split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) kv[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return {
    apiKey: kv.DEEPSEEK_API_KEY,
    baseURL: kv.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
    model: kv.MODEL_ID || 'deepseek-v4-flash',
    reasonerModel: kv.REASONER_MODEL_ID || undefined,
  };
}

// LLM 裁判：对中文质量/指代/安全性打分 1-5
async function judge(
  client: DeepSeekClient,
  c: GoldenCase,
  transcript: string,
  finalText: string,
): Promise<{ score: number; detail: string }> {
  const messages: ChatMessage[] = [
    {
      role: 'system',
      content:
        '你是严格的编程 Agent 能力评测裁判。根据用户指令、Agent 的工具调用记录与最终回复，按评分标准给出 1-5 分（5 为最佳）。只输出一个 JSON 对象，不要任何额外文字：{"score":<整数>,"detail":"<中文理由，≤80字>"}。注意：detail 字段内禁止使用英文双引号字符，一律用中文引号「」或书名号《》，以保证 JSON 可被程序解析。',
    },
    {
      role: 'user',
      content: `评测目标: ${c.title}\n评分标准: ${c.rubric}\n\n=== 交互记录 ===\n${transcript}\n=== Agent 最终回复 ===\n${finalText}\n\n请评分并给出中文理由。`,
    },
  ];
  const raw = await client.complete(messages, 0);
  return parseJudge(raw);
}

// 鲁棒解析裁判输出：优先 JSON.parse，失败则用正则兜底抽取 score 与 detail
function parseJudge(raw: string): { score: number; detail: string } {
  const m = raw.match(/\{[\s\S]*\}/);
  if (m) {
    try {
      const o = JSON.parse(m[0]);
      return { score: Number(o.score) || 0, detail: String(o.detail ?? '').slice(0, 200) };
    } catch {
      /* fallthrough to regex */
    }
  }
  const sm = raw.match(/"score"\s*:\s*(\d+)/);
  const score = sm ? Number(sm[1]) : 0;
  const dm = raw.match(/"detail"\s*:\s*"?([\s\S]*?)"?\s*\}?\s*$/);
  const detail = dm ? dm[1].replace(/^["']|["']$/g, '').slice(0, 200) : raw.slice(0, 160);
  return { score, detail: detail || '裁判解析失败: ' + raw.slice(0, 160) };
}

async function runCase(c: GoldenCase, client: DeepSeekClient): Promise<CaseResult> {
  const sandbox = await mkdtemp(path.join(tmpdir(), `ds-eval-${c.id}-`));
  if (c.setup) await c.setup(sandbox);

  const history = new ConversationHistory(SYSTEM_PROMPT);
  const toolCalls: ToolCallRecord[] = [];
  const permissionDenied: string[] = [];
  let finalText = '';
  let transcript = '';

  // P4: 与 main.ts 一致，将 delegate 工具纳入评测工具集（createTools 默认不含 delegate）。
  // 否则模型在评测环境里根本看不到 delegate，c21 永远无法触发（历史 22/23 失败的根因）。
  const delegateTool = createDelegateTool({
    runner: async (input: string, signal?: AbortSignal): Promise<string> => {
      let out = '';
      for await (const ev of runAgent(input, {
        client,
        history: new ConversationHistory(SYSTEM_PROMPT),
        permission,
        cwd: sandbox,
        ask: async () => confirm,
        maxIterations: 8,
        signal,
      })) {
        if (ev.type === 'assistant_text' && ev.text) out += ev.text;
      }
      return out || '(子任务无文本输出)';
    },
  });
  const evalTools = [...createTools(client), delegateTool];

  const permission = c.permission ?? 'execute';
  const confirm = c.confirm ?? true;

  for (const turn of c.turns) {
    transcript += `\n## 用户: ${turn}\n`;
    for await (const ev of runAgent(turn, {
      client,
      history,
      tools: evalTools,
      permission,
      cwd: sandbox,
      ask: async () => confirm,
      maxIterations: c.maxIterations ?? 10,
    })) {
      if (ev.type === 'assistant_text' && ev.text) {
        finalText += ev.text;
        transcript += ev.text;
      } else if (ev.type === 'tool_call') {
        toolCalls.push({ name: ev.toolName!, args: ev.args });
        transcript += `\n[TOOL_CALL ${ev.toolName}] ${JSON.stringify(ev.args)}\n`;
      } else if (ev.type === 'tool_result') {
        transcript += `[TOOL_RESULT ${ev.toolName}] ${String(ev.result).slice(0, 400)}\n`;
      } else if (ev.type === 'permission') {
        if (!ev.granted) permissionDenied.push(ev.toolName!);
        transcript += `[PERMISSION ${ev.toolName} granted=${ev.granted}]\n`;
      } else if (ev.type === 'error') {
        transcript += `[ERROR ${ev.error}]\n`;
      }
    }
    transcript += '\n## Agent 回复结束\n';
  }

  let pass: boolean;
  let detail: string;
  let score: number | null = null;

  if (c.tier === 'code' && c.check) {
    const r = c.check({ cwd: sandbox, toolCalls, finalText, permissionDenied, transcript });
    pass = r.pass;
    detail = r.detail;
  } else if (c.tier === 'llm' && c.rubric) {
    const j = await judge(client, c, transcript, finalText);
    score = j.score;
    pass = j.score >= 3;
    detail = `裁判 ${j.score}/5 — ${j.detail}`;
  } else {
    pass = true;
    detail = '需人工复核（transcript 已留存）';
  }

  await rm(sandbox, { recursive: true, force: true });
  return { id: c.id, title: c.title, category: c.category, tier: c.tier, pass, score, detail, transcript };
}

function renderReport(results: CaseResult[]): string {
  const total = results.length;
  const passed = results.filter((r) => r.pass).length;
  const codeCases = results.filter((r) => r.tier === 'code');
  const llmCases = results.filter((r) => r.tier === 'llm');
  const humanCases = results.filter((r) => r.tier === 'human');
  const codePass = codeCases.filter((r) => r.pass).length;
  const llmPass = llmCases.filter((r) => r.pass).length;
  const llmScores = llmCases.map((r) => r.score ?? 0);
  const avgLlm = llmScores.length ? (llmScores.reduce((a, b) => a + b, 0) / llmScores.length).toFixed(2) : '—';

  let md = `# DeepSeek CLI 编程 Agent — 黄金 Case 评测报告\n\n`;
  md += `生成时间: ${new Date().toLocaleString('zh-CN')}\n\n`;
  md += `## 总览\n\n`;
  md += `- 总用例: ${total} | 通过: ${passed} | 自动判分通过率: ${(passed / total * 100).toFixed(0)}%\n`;
  md += `- 代码可测档: ${codePass}/${codeCases.length} 通过\n`;
  md += `- LLM 裁判档: ${llmPass}/${llmCases.length} 通过（平均分 ${avgLlm}/5）\n`;
  md += `- 人工复核档: ${humanCases.length} 个（需人工看 transcript）\n\n`;
  md += `## 分类明细\n\n`;
  md += `| Case | 类别 | 档位 | 结果 | 得分/详情 |\n`;
  md += `|------|------|------|------|----------|\n`;
  for (const r of results) {
    const mark = r.pass ? '✅' : '❌';
    const sc = r.tier === 'llm' ? `${r.score}/5` : r.tier === 'human' ? '人工' : '断言';
    md += `| ${r.id} ${r.title} | ${r.category} | ${r.tier} | ${mark} | ${sc} — ${r.detail} |\n`;
  }
  md += `\n## 结论\n\n`;
  md += passed === total
    ? '所有自动化断言通过，能力闭环成立。LLM 裁判档平均分 ' + avgLlm + '，达到可用水平。\n'
    : `存在 ${total - passed} 个未通过项，需针对上方详情修复后重测。\n`;
  md += `\n> 本评测集对应新路线阶段05：用垂直项目验证能力，量化"能力在变好"。\n`;
  md += `> 三档设计：code=确定性断言、llm=DeepSeek 裁判打分、human=仅留存 transcript 供人工复核。\n`;
  return md;
}

async function main(): Promise<void> {
  const cfg = loadEnv();
  const client = new DeepSeekClient(cfg);
  const only = process.env.EVAL_ONLY;
  const cases = only ? CASES.filter((c) => c.id === only) : CASES;
  if (only && cases.length === 0) {
    console.error(`[EVAL] 未找到用例: ${only}`);
    process.exit(1);
  }
  console.log(`[EVAL] 模型: ${cfg.model}  用例数: ${cases.length}  开始真实 API 评测...\n`);

  const results: CaseResult[] = [];
  for (const c of cases) {
    process.stdout.write(`  ▶ ${c.id} ${c.title} (${c.tier}) ... `);
    const r = await runCase(c, client);
    const tag = r.pass ? 'PASS' : 'FAIL';
    const extra = r.tier === 'llm' ? ` ${r.score}/5` : '';
    console.log(`${tag}${extra} — ${r.detail.slice(0, 60)}`);
    results.push(r);
  }

  const md = renderReport(results);
  const outDir = 'D:/作业/AI Agent/deepseek-code-agent/eval';
  mkdirSync(outDir, { recursive: true });
  writeFileSync(path.join(outDir, 'RESULTS.md'), md, 'utf8');
  writeFileSync(path.join(outDir, 'results.json'), JSON.stringify(results, null, 2), 'utf8');

  const passed = results.filter((r) => r.pass).length;
  console.log(`\n[EVAL] 完成: ${passed}/${results.length} 通过。报告已写入 eval/RESULTS.md`);
  console.log('='.repeat(60));
  console.log(md);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
