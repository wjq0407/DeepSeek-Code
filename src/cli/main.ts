import { resolve } from 'node:path';
import { startApp } from './app.tsx';
import { assembleAppProps } from './assemble.ts';
import { resolveCredentials, saveCredentials, loadStoredCredentials, maskKey, type Credentials } from './auth.ts';
import { runLogin } from './login.tsx';

async function main(): Promise<void> {
  // 项目根目录：全局命令可能在任意目录启动，但配置/凭证应锚定在项目根
  const projectRoot = resolve(import.meta.dirname ?? '.', '../../');
  const cwd = process.cwd();

  // ── 凭证解析 + 登录门禁 ──
  const forceSetKey = process.argv.includes('--set-key') || process.argv.includes('-k');
  let creds = await resolveCredentials(projectRoot, cwd);
  const firstRun = !creds;

  if (forceSetKey || !creds) {
    const entered = await runLogin(firstRun);
    if (!entered) {
      if (firstRun) {
        console.error('已取消登录，无法启动（需要 API Key）。');
        process.exit(1);
      }
      creds = await loadStoredCredentials();
      if (!creds) {
        console.error('已取消，且无可用凭证。');
        process.exit(1);
      }
    } else {
      creds = entered;
      await saveCredentials(creds);
      console.log('[auth] 已保存 API Key 到 ~/.dsa/credentials.json');
    }
  } else {
    console.log(`[auth] 使用已保存的 API Key（${maskKey(creds.apiKey)}）`);
  }

  // 内核装配（与网页后端共用同一份 assembleAppProps）
  const props = await assembleAppProps(creds as Credentials);
  await startApp(props);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
