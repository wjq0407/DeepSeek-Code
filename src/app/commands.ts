/**
 * 斜杠命令的「纯逻辑」实现（与渲染层无关）。
 *
 * 把原本散落在 app.tsx 的 handleMemory / handleSkills / applyMemoryIntent 抽到此处，
 * 由 CLI（ink）与 网页后端（Node）共用——它们都只通过 `push(role, text)` 回调把结果
 * 回写给各自的 UI 层，自身不碰任何渲染。
 */
import type { MemoryManager, Scope } from '../memory/manager.ts';
import type { SkillManager } from '../skills/loader.ts';
import type { MemoryIntent } from '../memory/intent.ts';
import type { MsgRole } from './types.ts';

/**
 * /memory 命令：管理跨会话记忆（双轨：用户级全局 + 项目级）。
 * 子命令：add <文本> / fact <文本> / list / forget <id前缀> / help
 * 任意子命令后可加 `--global` 作用于用户级全局记忆（默认项目级）。
 */
export async function handleMemory(
  raw: string,
  manager: MemoryManager,
  push: (role: MsgRole, text: string) => void,
): Promise<void> {
  const parts = raw.trim().split(/\s+/);
  const sub = parts[1] ?? 'help';
  const isGlobal = parts.includes('--global');
  const scope: Scope = isGlobal ? 'user' : 'project';
  const arg = parts.filter((p) => p !== '--global').slice(2).join(' ').trim();

  if (sub === 'help' || sub === '') {
    push(
      'system',
      [
        '记忆命令（默认项目级，加 --global 作用于用户全局）：',
        '  /memory add <文本> [--global]    新增一条语义记忆（启动时语义召回）',
        '  /memory fact <文本> [--global]   新增一条常驻事实（每次会话注入系统提示词）',
        '  /memory list                     列出所有记忆（标注 项目/全局）',
        '  /memory forget <id> [--global]   删除一条语义记忆（id 取 list 中前 8 位；--global 删全局层）',
        '  /memory help                     显示本帮助',
        '',
        '自然语言快捷写入（无需命令）：',
        '  直接说「记住我偏好用 pnpm」「记住我在准备前端实习」即可自动入库；',
        '  含「全局/所有项目」等词写入用户全局层，否则写当前项目层。',
        '  复合句「记住 X，然后 Y」会先存记忆、再把 Y 照常交给 Agent 执行，无需重复输入。',
      ].join('\n'),
    );
    return;
  }
  if (sub === 'add') {
    if (!arg) {
      push('system', '用法: /memory add <文本> [--global]');
      return;
    }
    const e = await manager.addEntry(arg, undefined, scope);
    const tag = isGlobal ? '（全局）' : '（项目）';
    push('system', `已新增语义记忆${tag} [#${e.id.slice(0, 8)}]: ${arg}`);
    return;
  }
  if (sub === 'fact') {
    if (!arg) {
      push('system', '用法: /memory fact <文本> [--global]');
      return;
    }
    manager.addFact(arg, scope);
    const tag = isGlobal ? '（全局）' : '（项目）';
    push('system', `已新增常驻事实${tag}: ${arg}`);
    return;
  }
  if (sub === 'list') {
    const { user, project } = manager.loadFacts();
    const factBlock =
      `=== 常驻事实 ===\n` +
      `[项目 .dsa/memory]\n${project || '（空）'}\n` +
      `[全局 ~/.dsa/memory]\n${user || '（空）'}`;
    const entries = manager.list();
    const memBlock = `=== 语义记忆（${entries.length}）===\n${
      entries.length === 0
        ? '（空）'
        : entries
            .map(
              (x) =>
                `  [${x.scope === 'user' ? '全局' : '项目'} #${x.entry.id.slice(0, 8)}] ${x.entry.content}`,
            )
            .join('\n')
    }`;
    push('system', `${factBlock}\n${memBlock}`);
    return;
  }
  if (sub === 'forget') {
    if (!arg) {
      push('system', '用法: /memory forget <id> [--global]');
      return;
    }
    const ok = manager.forget(arg, scope);
    const tag = isGlobal ? '（全局）' : '（项目）';
    push('system', ok ? `已删除记忆${tag} [#${arg.slice(0, 8)}]` : `未找到匹配的记忆 [#${arg.slice(0, 8)}]`);
    return;
  }
  push('system', '未知子命令，输入 /memory help 查看用法');
}

/**
 * /skills 命令：查看与动态管理技能白名单。
 * 子命令：list / allow <名称> / disallow <名称> / clear / all / help
 * 仅作用于全局技能（项目级始终可用，不受白名单影响）。
 */
export async function handleSkills(
  raw: string,
  manager: SkillManager,
  push: (role: MsgRole, text: string) => void,
): Promise<void> {
  const parts = raw.trim().split(/\s+/);
  const sub = parts[1] ?? 'list';
  const arg = parts.slice(2).join(' ').trim();
  const splitNames = (s: string) => s.split(/[,;\s]+/).map((x) => x.trim()).filter(Boolean);

  if (sub === 'help' || sub === '') {
    push(
      'system',
      [
        '技能命令（仅管理全局技能；项目级始终可用）：',
        '  /skills list                  列出当前可用技能（标注 项目/全局）与过滤状态',
        '  /skills allow <名称>          放行指定全局技能（可逗号/空格分隔多个）',
        '  /skills disallow <名称>       从白名单移除指定全局技能',
        '  /skills clear                 排除全部全局技能（仅项目级可用）',
        '  /skills all                   允许全部全局技能（清空白名单）',
        '  /skills help                  显示本帮助',
        '',
        '说明：白名单写入 ~/.workbuddy/skills.allow.json 持久化。若启动时由构造函数或',
        '环境变量 DSA_GLOBAL_SKILLS_ALLOW 设置了更高优先级来源，本会话改动需重启生效。',
      ].join('\n'),
    );
    return;
  }
  if (sub === 'list') {
    const metas = manager.listMeta();
    const body =
      metas.length === 0
        ? '（无可用技能）'
        : metas
            .map((m) => `  [${m.scope === 'project' ? '项目' : '全局'}] ${m.name} — ${m.description}`)
            .join('\n');
    push('system', `=== 当前可用技能（${metas.length}）===\n${body}\n\n${manager.filterDescription()}`);
    return;
  }

  const writeAndApply = async (next: string[] | null, verb: string): Promise<void> => {
    await manager.writeConfigAllow(next);
    const info = manager.getFilterInfo();
    if (info.source === 'constructor' || info.source === 'env') {
      push(
        'system',
        `已写入配置${next === null ? '（全部放行）' : `（${next.join('、') || '空=排除全部'}）`}，` +
          `但当前会话由 ${info.source} 层控制，本会话未重扫，重启后生效。`,
      );
      return;
    }
    await manager.applyGlobalAllow(next);
    push('system', `${verb}（已写入 ~/.workbuddy/skills.allow.json，本会话即时生效）`);
  };

  if (sub === 'allow') {
    if (!arg) {
      push('system', '用法: /skills allow <名称> [名称2 ...]');
      return;
    }
    const names = splitNames(arg);
    const cur = (await manager.readConfigAllow()) ?? [];
    const added = names.filter((n) => !cur.includes(n));
    const next = [...new Set([...cur, ...names])];
    await writeAndApply(next, `已放行：${added.join('、') || '(已在白名单)'}`);
    return;
  }
  if (sub === 'disallow') {
    if (!arg) {
      push('system', '用法: /skills disallow <名称> [名称2 ...]');
      return;
    }
    const names = splitNames(arg);
    const cur = (await manager.readConfigAllow()) ?? [];
    const next = cur.filter((n) => !names.includes(n));
    await writeAndApply(next, `已移除：${names.join('、')}`);
    return;
  }
  if (sub === 'clear') {
    await writeAndApply([], '已排除全部全局技能（仅项目级可用）');
    return;
  }
  if (sub === 'all') {
    await writeAndApply(null, '已允许全部全局技能（白名单清空）');
    return;
  }
  push('system', '未知子命令，输入 /skills help 查看用法');
}

/**
 * 自然语言记忆写入：把 detectMemoryIntent 命中的 intent 落库并给出反馈。
 * 写入前先查重（两层 + 常驻事实），已存在则提示而不重复写。
 * 注意：本函数只负责「存 + 反馈」，是否继续跑 agent 由调用方（runChatTurn）决定——
 * 纯记忆指令存完即止；复合句「记住X，然后Y」会在本函数返回后继续用 Y 驱动 agent。
 */
export async function applyMemoryIntent(
  intent: MemoryIntent,
  manager: MemoryManager,
  push: (role: MsgRole, text: string) => void,
): Promise<void> {
  const { content, scope, kind } = intent;
  const scopeTag = scope === 'user' ? '全局' : '项目';
  const dup = await manager.isDuplicate(content).catch(() => false);
  if (dup) {
    push('system', `🧠 已有类似记忆，跳过写入：${content}`);
    return;
  }
  if (kind === 'fact') {
    manager.addFact(content, scope);
    push('system', `🧠 已记住（${scopeTag}·常驻事实）：${content}\n（撤销：/memory list 查看，暂不支持删事实行）`);
  } else {
    const e = await manager.addEntry(content, undefined, scope);
    push('system', `🧠 已记住（${scopeTag}·语义记忆）：${content}\n（撤销：/memory forget ${e.id.slice(0, 8)}${scope === 'user' ? ' --global' : ''}）`);
  }
}
