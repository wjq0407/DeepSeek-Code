import { readFileSync } from 'node:fs';
import { DeepSeekClient } from '../src/llm/deepseek.ts';
import { ConversationHistory } from '../src/context/history.ts';
import { runAgent } from '../src/agent/loop.ts';
import { SYSTEM_PROMPT } from '../src/agent/system-prompt.ts';

function loadEnv(): { apiKey: string; baseURL: string; model: string; reasonerModel?: string } {
  const txt = readFileSync('D:/作业/AI Agent/学习文档/.env', 'utf8');
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

async function main(): Promise<void> {
  const cfg = loadEnv();
  const client = new DeepSeekClient(cfg);
  const history = new ConversationHistory(SYSTEM_PROMPT);
  const cwd = 'D:/作业/AI Agent/deepseek-code-agent';

  console.log('[SMOKE TEST] 指令: 读取 package.json 并说明项目信息');
  process.stdout.write('\nAgent> ');

  for await (const ev of runAgent(
    '请读取当前目录下的 package.json 文件，告诉我这个项目叫什么名字、用了哪些依赖。',
    {
      client,
      history,
      permission: 'ask',
      cwd,
      ask: async (p) => {
        console.log(chalk.yellow(p));
        return true; // 测试自动确认
      },
    },
  )) {
    if (ev.type === 'assistant_text' && ev.text) process.stdout.write(ev.text);
    else if (ev.type === 'tool_call') console.log(chalk.magenta(`\n  [调用工具] ${ev.toolName}`), ev.args ?? '');
    else if (ev.type === 'tool_result') console.log(chalk.gray(`  [工具结果] ${String(ev.result).slice(0, 400)}`));
    else if (ev.type === 'error') console.log(chalk.red(`\n[错误] ${ev.error}`));
    else if (ev.type === 'done') console.log('\n[DONE]');
  }

  console.log('\n[多轮测试] 追问: 那么 deepseek-v4-flash 模型通过哪个字段配置?');
  process.stdout.write('\nAgent> ');
  for await (const ev of runAgent('那我的模型名称是通过哪个配置字段指定的？只回答字段名。', {
    client,
    history,
    permission: 'ask',
    cwd,
    ask: async () => true,
  })) {
    if (ev.type === 'assistant_text' && ev.text) process.stdout.write(ev.text);
    else if (ev.type === 'done') console.log('\n[DONE]');
    else if (ev.type === 'error') console.log(chalk.red(`\n[错误] ${ev.error}`));
  }
}

import chalk from 'chalk';
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
