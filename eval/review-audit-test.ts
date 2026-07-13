import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DeepSeekClient } from '../src/llm/deepseek.ts';
import { ConversationHistory } from '../src/context/history.ts';
import { runAgent } from '../src/agent/loop.ts';
import { SYSTEM_PROMPT } from '../src/agent/system-prompt.ts';

function loadEnv(): { apiKey: string; baseURL: string; model: string; reasonerModel?: string } {
  const candidates = [
    resolve(process.cwd(), '.env'),
    'D:/作业/AI Agent/学习文档/.env',
  ];
  for (const c of candidates) {
    try {
      const txt = readFileSync(c, 'utf8');
      const kv: Record<string, string> = {};
      for (const line of txt.split('\n')) {
        const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
        if (m) kv[m[1]] = m[2].replace(/^["']|["']$/g, '');
      }
      if (kv.DEEPSEEK_API_KEY)
        return {
          apiKey: kv.DEEPSEEK_API_KEY,
          baseURL: kv.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
          model: kv.MODEL_ID || 'deepseek-v4-flash',
          reasonerModel: kv.REASONER_MODEL_ID || undefined,
        };
    } catch {
      /* 下一个候选 */
    }
  }
  throw new Error('未找到 DEEPSEEK_API_KEY');
}

async function runCase(label: string, instruction: string, cwd: string): Promise<void> {
  console.log(`\n\n########## ${label} ##########`);
  const client = new DeepSeekClient(loadEnv());
  const history = new ConversationHistory(SYSTEM_PROMPT);
  for await (const ev of runAgent(instruction, {
    client,
    history,
    permission: 'execute',
    cwd,
    ask: async () => true,
    maxIterations: 8,
  })) {
    if (ev.type === 'assistant_text' && ev.text) {
      process.stdout.write(ev.text);
    } else if (ev.type === 'tool_call') {
      console.log(`\n  [调用工具] ${ev.toolName}`, JSON.stringify(ev.args ?? ''));
    } else if (ev.type === 'tool_result') {
      console.log(`  [工具结果·前400字] ${String(ev.result).slice(0, 400)}`);
    } else if (ev.type === 'error') {
      console.log(`\n  [错误] ${ev.error}`);
    }
  }
  console.log('\n########## 结束 ##########');
}

async function main(): Promise<void> {
  const cwd = 'D:/作业/AI Agent/deepseek-code-agent';
  // 差异化能力①：中文代码审查
  await runCase(
    '测试1 · review_code（中文代码审查）',
    '请对 src/tools/index.ts 调用 review_code 工具做中文代码审查，并把审查报告完整展示给我。',
    cwd,
  );
  // 差异化能力②：依赖安全审计
  await runCase(
    '测试2 · audit_dependencies（依赖安全审计）',
    '请对当前项目调用 audit_dependencies 工具做依赖安全审计，并把报告展示给我。',
    cwd,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
