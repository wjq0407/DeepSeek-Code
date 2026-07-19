/**
 * 任务区重构 WS 端到端冒烟（隔离 HOME，无需 API Key）。
 * 校验：注册 → task_list(含 status/goal) → new_task → update_task(改状态/目标) → delete_task。
 */
import { WebSocket } from 'ws';
import { randomUUID } from 'node:crypto';

const URL = process.env.DSA_WS_URL || 'ws://127.0.0.1:4199/ws';
const ws = new WebSocket(URL);
const pending = new Map<string, (msg: any) => void>();
let seq = 0;

function send(type: string, extra: Record<string, unknown> = {}): Promise<any> {
  const id = `${type}-${(seq++).toString(36)}`;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    ws.send(JSON.stringify({ type, ...extra }));
    setTimeout(() => resolve(null), 4000);
  });
}

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra = '') {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name} ${extra}`);
  }
}

ws.on('open', async () => {
  // 注册
  const user = `smoke_${randomUUID().slice(0, 6)}`;
  const pass1 = 'secret123';
  ws.send(JSON.stringify({ type: 'register', username: user, password: pass1 }));
  await new Promise((r) => setTimeout(r, 1500));

  // 1) task_list：默认任务存在，status=active, goal=''
  const list1: any = await send('list_tasks');
  const tasks1 = list1?.tasks ?? [];
  check('注册后有 task_list', Array.isArray(tasks1));
  const def = tasks1.find((t: any) => t.active);
  check('默认任务 status=active', def?.status === 'active', JSON.stringify(def));
  check('默认任务 goal 为空串', def?.goal === '', JSON.stringify(def));

  // 2) new_task
  await send('new_task');
  const list2: any = await send('list_tasks');
  const tasks2 = list2?.tasks ?? [];
  check('new_task 后任务数+1', tasks2.length === tasks1.length + 1, `before=${tasks1.length} after=${tasks2.length}`);
  const created = tasks2.find((t: any) => t.title === '新任务' && t.status === 'active');
  check('新任务 status=active/goal空', !!created && created.goal === '', JSON.stringify(created));

  // 3) update_task 改状态为 done
  await send('update_task', { id: created.id, status: 'done' });
  const list3: any = await send('list_tasks');
  const upd = list3.tasks.find((t: any) => t.id === created.id);
  check('update_task 状态变 done', upd?.status === 'done', JSON.stringify(upd));

  // 4) update_task 改目标
  await send('update_task', { id: created.id, goal: '为报表系统接入导出功能' });
  const list4: any = await send('list_tasks');
  const upd2 = list4.tasks.find((t: any) => t.id === created.id);
  check('update_task 目标更新', upd2?.goal === '为报表系统接入导出功能', JSON.stringify(upd2));

  // 5) delete_task：先切换到默认任务，使 created 变为非活跃，再删除
  const defId = tasks1.find((t: any) => t.active)?.id;
  if (defId && defId !== created.id) {
    await send('switch_task', { id: defId });
    await send('delete_task', { id: created.id });
    const list5: any = await send('list_tasks');
    check('delete_task 已移除', !list5.tasks.find((t: any) => t.id === created.id));
  } else {
    check('delete_task 跳过(无第二个任务可切换)', true);
  }

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  ws.close();
  process.exit(fail === 0 ? 0 : 1);
});

ws.on('message', (raw: Buffer) => {
  let msg: any;
  try {
    msg = JSON.parse(raw.toString());
  } catch {
    return;
  }
  if (process.env.SMOKE_DEBUG) console.log('  [msg]', msg.type, JSON.stringify(msg).slice(0, 160));
  // 把 task_list / auth 等响应按最近一次等待匹配
  for (const [key, resolve] of pending) {
    if (key.startsWith(msg.type) || (msg.type === 'task_list' && key.startsWith('list_tasks')) || (msg.type === 'auth_error' && key.startsWith('register'))) {
      pending.delete(key);
      resolve(msg);
      break;
    }
  }
});

ws.on('error', (e) => {
  console.error('WS 错误', e.message);
  process.exit(2);
});
