import { Box, Text, render, useInput } from 'ink';
import { useState, useCallback, useRef, useEffect } from 'react';
import type { ReactNode } from 'react';
import { WHALE_ART, WHALE_EYES } from './whaleArt.ts';
import { ThinkingIndicator, formatDuration } from './thinkingIndicator.tsx';
import type { DeepSeekClient } from '../llm/deepseek.ts';
import type { ConversationHistory } from '../context/history.ts';
import { TraceLogger } from '../context/trace.ts';
import type { ToolDef } from '../tools/index.ts';
import { runAgent, PermissionMode } from '../agent/loop.ts';
import { SessionManager, type Session } from '../agent/session.ts';
import { msgOf } from '../utils/logger.ts';
import { MarkdownMessage } from './Markdown.tsx';
import type { MemoryManager, Scope } from '../memory/manager.ts';
import { extractUserMemories } from '../memory/extractor.ts';
import { detectMemoryIntent } from '../memory/intent.ts';

/** Phase 3：会话结束自动抽取记忆的守卫，确保两个退出路径（/exit 与 waitUntilExit）只跑一次。 */
let extractionRan = false;

export interface AppProps {
  client: DeepSeekClient;
  history: ConversationHistory;
  tools: ToolDef[];
  cfg: { apiKey: string; baseURL: string; model: string; reasonerModel?: string };
  traceLogger: TraceLogger;
  initialResume?: unknown;
  recentTraces: string[];
  sessionManager: SessionManager;
  /** P5: 启动时从磁盘恢复的历史会话数量（>0 时首屏提示） */
  restoredSessions?: number;
  /** 记忆层：跨会话用户记忆 + 轻量 RAG 预取 */
  memoryStore: MemoryManager;
  /** 应用版本号（来自 package.json，避免与 package.json 多处不一致） */
  version: string;
}

export type MsgRole = 'user' | 'assistant' | 'tool' | 'system' | 'error';
export interface UiMessage {
  id: number;
  role: MsgRole;
  text: string;
  /** P2-⑨ 任务级标记：progress=过程叙述（暗显），final=最终答复（正常） */
  phase?: 'progress' | 'final';
}

/** T3: Abyssal Pixel 风格 Banner（ink Box 组件版，替代原 banner.ts 的纯 ASCII 字符画） */
function Banner(props: { version: string; primaryModel: string; reasonerModel?: string; cwd: string }) {
  const cwdShow =
    props.cwd.length > 40 ? '…/' + props.cwd.split(/[\\/]/).slice(-2).join('/') : props.cwd;
  return (
    <Box borderStyle="single" borderColor="#2f6fb0" paddingX={1} flexDirection="row">
      <Box flexDirection="column" flexGrow={1} flexBasis={0} paddingRight={2}>
        <Text color="#2f6fb0" bold>{`DeepSeek Agent ${props.version}`}</Text>
        <Text color="#7ec8e3">欢迎回来！</Text>
        <WhaleMascot compact />
        {props.reasonerModel ? (
          <Text>
            <Text color="#7ec699">{props.primaryModel}</Text>
            <Text dimColor> （快）· </Text>
            <Text color="#f0b569">{props.reasonerModel}</Text>
            <Text dimColor> （思考）</Text>
          </Text>
        ) : (
          <Text color="#7ec699">{props.primaryModel}</Text>
        )}
        <Text dimColor>{cwdShow}</Text>
      </Box>
      <Box flexDirection="column" flexGrow={1} flexBasis={0}>
        <Text color="#2f6fb0" bold>提示</Text>
        <Text>
          <Text color="#7ec699">/mode</Text>
          <Text dimColor> 执行   -&gt; 自动批准工具</Text>
        </Text>
        <Text>
          <Text color="#7ec699">/plan</Text>
          <Text dimColor>      -&gt; 预览后再运行</Text>
        </Text>
        <Text dimColor>输入：&quot;review src/&quot;</Text>
        <Text> </Text>
        <Text color="#2f6fb0" bold>新功能</Text>
        <Text>
          <Text color="#7ec699">Abyssal Pixel</Text>
          <Text dimColor>: 鲸鱼吉祥物界面</Text>
        </Text>
        <Text>
          <Text color="#7ec699">Stream</Text>
          <Text dimColor>: 实时工具输出</Text>
        </Text>
        <Text>
          <Text color="#7ec699">Safety</Text>
          <Text dimColor>: 已自动拦截 taskkill</Text>
        </Text>
        <Text>
          <Text color="#7ec8e3">/cost</Text>
          <Text dimColor> / </Text>
          <Text color="#7ec8e3">/help</Text>
          <Text dimColor> / </Text>
          <Text color="#7ec8e3">?</Text>
        </Text>
      </Box>
    </Box>
  );
}

/** 蓝鲸 ASCII 吉祥物：品牌蓝鲸身 + 两格黑眼。compact=true 时去掉外层 padding，用于嵌入 Banner 内部 */
function WhaleMascot(props: { compact?: boolean }) {
  return (
    <Box flexDirection="column" paddingX={props.compact ? 0 : 1}>
      {WHALE_ART.map((line, r) => {
        const segs: ReactNode[] = [];
        let i = 0;
        let k = 0;
        while (i < line.length) {
          const ch = line[i];
          if (ch === ' ') {
            segs.push(<Text key={k++}> </Text>);
            i++;
            continue;
          }
          const isEye = WHALE_EYES.has(`(${i},${r})`);
          let j = i;
          while (j < line.length) {
            const c2 = line[j];
            if (c2 === ' ') break;
            if (WHALE_EYES.has(`(${j},${r})`) !== isEye) break;
            j++;
          }
          segs.push(
            <Text key={k++} color={isEye ? 'black' : '#2f6fb0'}>
              {'█'.repeat(j - i)}
            </Text>,
          );
          i = j;
        }
        return <Text key={r}>{segs}</Text>;
      })}
    </Box>
  );
}

/** T4/T5: 底部输入框（蓝虚线顶边 + 光标行 + 状态栏），钉在 App 最底部 */
function InputBar(props: {
  input: string;
  cursor: number;
  mode: string;
  model: string;
  costCny: number;
  leftHint?: ReactNode;
  rightHint?: ReactNode;
}) {
  const { input, cursor, mode, model, costCny, leftHint, rightHint } = props;
  const columns = (process.stdout as { columns?: number }).columns ?? 80;
  const width = columns ?? 80;
  const before = input.slice(0, cursor);
  const at = input[cursor] ?? ' ';
  const after = input.slice(cursor + 1);
  const dashedLine = '╍'.repeat(width);
  return (
    <Box flexDirection="column" width="100%">
      <Text color="#4aa3e0">{dashedLine}</Text>
      <Text>
        <Text color="cyan">▌ </Text>
        <Text>{before}</Text>
        <Text backgroundColor="#4aa3e0" color="#ffffff">{at}</Text>
        <Text>{after}</Text>
      </Text>
      <Text color="#4aa3e0">{dashedLine}</Text>
      <Box flexDirection="row" justifyContent="space-between" width="100%">
        <Text dimColor>{leftHint ?? '? for shortcuts · ← for sessions'}</Text>
        <Text dimColor>
          {rightHint ?? (
            <>
              {`● ${mode} mode · `}
              <Text color="#7ec699">{model}</Text>
              {` · ¥${costCny.toFixed(4)}`}
            </>
          )}
        </Text>
      </Box>
    </Box>
  );
}

/** P2/P3: 会话面板（对标 Claude Code 的 Sessions 视图），按 需要输入/工作中/已完成 三分组渲染 */
function SessionPanel(props: {
  mainS: Session | undefined;
  needsInput: Session[];
  working: Session[];
  completed: Session[];
  selectedId: string;
}) {
  const { mainS, needsInput, working, completed, selectedId } = props;
  const renderLine = (s: Session) => {
    const sel = s.id === selectedId;
    const badge =
      s.kind === 'main' ? '★' : s.status === 'needs_input' ? '⏸' : s.status === 'working' ? '⚙' : s.status === 'completed' ? '✓' : '✗';
    const titleShow = s.kind === 'main' ? `${s.title}（当前会话）` : s.title;
    const preview = s.output.trim() ? '  ' + s.output.trim().replace(/\s+/g, ' ').slice(-50) : '';
    return (
      <Text key={s.id} inverse={sel}>
        <Text color={sel ? undefined : s.kind === 'main' ? '#7ec8e3' : '#7ec699'}>{` ${badge} `}</Text>
        <Text>{titleShow}</Text>
        <Text dimColor>{`  [${s.status}]${preview}`}</Text>
      </Text>
    );
  };
  const sections: Array<[string, Session[]]> = [
    ['需要输入', [...(mainS ? [mainS] : []), ...needsInput]],
    ['工作中', working],
    ['已完成', completed],
  ];
  return (
    <Box flexDirection="column" paddingX={1} flexGrow={1}>
      <Text bold color="#2f6fb0">会话面板</Text>
      <Text dimColor>↑↓ 选择 · f: 派生分支 · Enter: 返回聊天/派发任务(分支模式则续写) · space: 回复等待项 · ctrl+x: 删除 · Esc: 取消分支</Text>
      {sections.map(([title, list]) => (
        <Box key={title} flexDirection="column">
          <Text color="#9aa0a6">{`▸ ${title} (${list.length})`}</Text>
          {list.length === 0 ? <Text dimColor>  （空）</Text> : list.map((s) => renderLine(s))}
        </Box>
      ))}
    </Box>
  );
}

/**
 * /memory 命令：管理跨会话记忆（双轨：用户级全局 + 项目级）。
 * 子命令：add <文本> / fact <文本> / list / forget <id前缀> / help
 * 任意子命令后可加 `--global` 作用于用户级全局记忆（默认项目级）。
 */
async function handleMemory(
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
 * 自然语言记忆写入：把 detectMemoryIntent 命中的 intent 落库并给出反馈。
 * 写入前先查重（两层 + 常驻事实），已存在则提示而不重复写。
 * 注意：本函数只负责「存 + 反馈」，是否继续跑 agent 由调用方（submit）决定——
 * 纯记忆指令存完即止；复合句「记住X，然后Y」会在本函数返回后继续用 Y 驱动 agent。
 */
async function applyMemoryIntent(
  intent: { content: string; scope: Scope; kind: 'fact' | 'semantic' },
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

export function App(_props: AppProps) {
  const termRows = (process.stdout as { rows?: number }).rows ?? 24;

  const [input, setInput] = useState('');
  const [cursor, setCursor] = useState(0);
  const [history, setHistory] = useState<string[]>([]);
  const [historyIdx, setHistoryIdx] = useState(-1);
  const [busy, setBusy] = useState(false);
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [mode, setMode] = useState<PermissionMode>(_props.cfg.reasonerModel ? 'ask' : 'execute');
  const [planMode, setPlanMode] = useState(false);
  const [costCny, setCostCny] = useState(0);
  const [confirm, setConfirm] = useState<{ prompt: string } | null>(null);
  const [view, setView] = useState<'chat' | 'panel'>('chat');
  const [panelSel, setPanelSel] = useState(0);
  const busyRef = useRef(false); // 始终反映最新 busy，避免 useInput 闭包过期
  const taskStartRef = useRef(0); // 任务开始时间（毫秒），用于结束后回显耗时
  const confirmRef = useRef<{ prompt: string; resolve: (b: boolean) => void } | null>(null);
  // P1-③ fork 分支续写目标（非 null 时面板 Enter 继续该分支而非派发新任务）
  const [continueTarget, setContinueTarget] = useState<string | null>(null);
  // P1-⑥ awaitUser 文本确认：agent 挂起等待用户自由文本回复
  const [askTextPrompt, setAskTextPrompt] = useState<string | null>(null);
  const askTextRef = useRef<{ prompt: string; resolve: (text: string) => void } | null>(null);

  // P1：订阅 SessionManager，会话状态变化时触发重渲染（面板 UI 后续阶段使用）
  const [, forceRender] = useState(0);
  useEffect(() => _props.sessionManager.subscribe(() => forceRender((n) => n + 1)), []);

  // ══ 会话面板数据源（P2/P3）：把会话管理器状态映射成有序列表 + 当前选中项 ══
  const mgr = _props.sessionManager;
  const mainS = mgr.sessions.get(mgr.activeId);
  const groups = mgr.groups();
  const ordered: Session[] = mainS
    ? [mainS, ...groups.needsInput, ...groups.working, ...groups.completed]
    : [...groups.needsInput, ...groups.working, ...groups.completed];
  const selIdx = Math.min(panelSel, Math.max(0, ordered.length - 1));
  const selected = ordered[selIdx];

  const msgId = useRef(0);
  const streamingId = useRef<number | null>(null); // 当前正在累积的 assistant 消息
  const toolMsgId = useRef<number | null>(null); // 当前工具消息（承接 onToolProgress）

  const pushMessage = useCallback((role: MsgRole, text: string) => {
    setMessages((m) => [...m, { id: msgId.current++, role, text }]);
  }, []);

  // P5: 首屏提示已恢复的历史会话数（按 ← 可在面板查看）
  const restoredSessions = _props.restoredSessions ?? 0;
  useEffect(() => {
    if (restoredSessions > 0) {
      pushMessage('system', `已恢复 ${restoredSessions} 个历史会话（按 ← 打开会话面板查看）`);
    }
  }, [restoredSessions, pushMessage]);

  const appendTo = useCallback((id: number, chunk: string) => {
    setMessages((m) => m.map((x) => (x.id === id ? { ...x, text: x.text + chunk } : x)));
  }, []);

  /** 流式 assistant 文本：首段创建消息，后续片段追加 */
  const appendStreaming = useCallback(
    (chunk: string) => {
      if (streamingId.current === null) {
        const id = msgId.current++;
        streamingId.current = id;
        setMessages((m) => [...m, { id, role: 'assistant', text: chunk }]);
      } else {
        appendTo(streamingId.current, chunk);
      }
    },
    [appendTo],
  );

  const SHORTCUTS = [
    '命令：',
    '  /mode explore|ask|execute   切换权限模式',
    '  /plan                       开/关规划模式（只输出计划不执行）',
    '  /cost                       显示累计用量与费用',
    '  /clear                      清空对话上下文',
    '  ←                           打开会话面板（多 Agent 调度）',
  '  /resume                     恢复上次会话',
  '  /memory add|fact|list|forget   管理跨会话记忆',
  '  （也可直接说「记住我偏好 XXX」自动写入；复合句「记住X，然后Y」会边存边执行Y）',
  '  /help 或 ?                  显示本面板',
  '  /exit 或 /quit              退出',
].join('\n');

  /** T9: 斜杠命令处理；返回 true 表示已处理（不跑 agent） */
  const handleCommand = useCallback(
    async (text: string): Promise<boolean> => {
      if (text === '/exit' || text === '/quit') {
        // P5: 退出前落盘，确保历史会话持久化
        await _props.sessionManager.flush().catch(() => {});
        // Phase 3: 会话结束自动从对话抽取用户偏好，沉淀进记忆库
        if (!extractionRan && _props.cfg.apiKey) {
          extractionRan = true;
          const n = await extractUserMemories(_props.client, _props.history, _props.memoryStore).catch(() => 0);
          if (n > 0) pushMessage('system', `会话结束，已自动沉淀 ${n} 条用户偏好到记忆库`);
        }
        process.exit(0);
      }
      if (text === '/help' || text === '?' || text === '？') {
        pushMessage('system', SHORTCUTS);
        return true;
      }
      if (text === '/clear') {
        _props.history.clear();
        setMessages([]);
        pushMessage('system', '已清空对话上下文');
        return true;
      }
      if (text === '/resume') {
        const rm = _props.initialResume as Array<unknown> | null;
        if (rm && rm.length) {
          _props.history.loadMessages(rm as never);
          _props.client.resetUsage();
          setMessages([]);
          pushMessage('system', `已恢复 ${rm.length} 条历史消息`);
        } else {
          pushMessage('system', '没有可恢复的会话');
        }
        return true;
      }
      if (text === '/memory' || text.startsWith('/memory ')) {
        await handleMemory(text, _props.memoryStore, pushMessage);
        return true;
      }
      if (text === '/cost') {
        const usage = _props.client.getUsageSummary();
        if (usage.totalTokens === 0) {
          pushMessage('system', '暂无用量记录');
        } else {
          const lines = usage.models
            .map(
              (m) =>
                `  ${m.model}: 输入 ${m.promptTokens} / 输出 ${m.completionTokens} = ${m.totalTokens}tok | ¥${m.costCny.toFixed(4)}`,
            )
            .join('\n');
          let total = `  合计: ${usage.totalTokens}tok | ¥${usage.totalCostCny.toFixed(4)}`;
          if (usage.totalCacheHitTokens > 0) {
            const base = usage.totalCacheHitTokens + usage.totalCacheMissTokens;
            const rate = Math.round((usage.totalCacheHitTokens / base) * 100);
            total += ` | 🎯 缓存命中 ${usage.totalCacheHitTokens}tok(${rate}%)`;
          }
          pushMessage('system', `=== 累计用量与费用 ===\n${lines}\n${total}`);
        }
        return true;
      }
      if (text.startsWith('/mode')) {
        const m = text.split(' ')[1];
        if (m === 'explore' || m === 'ask' || m === 'execute') {
          setMode(m);
          pushMessage('system', `权限模式已切换为: ${m}`);
        } else {
          pushMessage('system', '用法: /mode explore|ask|execute');
        }
        return true;
      }
      if (text === '/plan') {
        setPlanMode((p) => !p);
        pushMessage('system', `规划模式已${planMode ? '关闭（正常执行）' : '开启（Agent 将先输出计划）'}`);
        return true;
      }
      return false;
    },
    [pushMessage, _props, planMode],
  );

  /** P3：从面板派发一个后台子会话（输入非空时由 Enter 触发） */
  const spawnFromPanel = useCallback(
    (text: string) => {
      const id = mgr.spawn(text, {
        client: _props.client,
        tools: _props.tools,
        cwd: process.cwd(),
        trace: new TraceLogger({ workspaceDir: process.cwd() }),
        permission: mode,
      });
      pushMessage('system', `已派发后台会话: ${text.slice(0, 24) || '(空任务)'}`);
      setInput('');
      setCursor(0);
      setPanelSel(0);
      return id;
    },
    [mgr, _props, mode, pushMessage],
  );

  const submit = useCallback(
    async (raw: string) => {
      const text = raw.trim();
      // 清空输入行（Enter=提交，不换行下移；输入框钉底，回车后清空等待下一轮）
      setInput('');
      setCursor(0);
      setHistoryIdx(-1);
      streamingId.current = null;
      toolMsgId.current = null;
      if (!text) return;
      setHistory((h) => [...h, raw]);
      pushMessage('user', text);
      // 真正交给 agent 运行的文本（默认整句；复合记忆句会剥离记忆指令后只留任务）
      let runText = text;
      // T9: 命令优先于 agent
      if (text.startsWith('/')) {
        const handled = await handleCommand(text);
        if (handled) return;
      } else {
        // 自然语言记忆触发：说「记住我偏好 XXX」即自动写库；
        // 存库+反馈后，若原句还带真实任务，则把任务照常交给 agent（不重复输入）。
        const intent = detectMemoryIntent(text);
        if (intent) {
          await applyMemoryIntent(intent, _props.memoryStore, pushMessage);
          if (intent.rest && intent.rest.trim()) {
            runText = intent.rest.trim(); // 记忆指令已剥离，仅用任务部分驱动 agent
          } else {
            return; // 纯记忆指令，存完即止，不再跑 agent
          }
        }
      }
      setBusy(true);
      busyRef.current = true;
      taskStartRef.current = Date.now(); // 记录任务起点，用于结束回显耗时

      try {
        for await (const ev of runAgent(runText, {
          client: _props.client,
          history: _props.history,
          permission: mode,
          cwd: process.cwd(),
          tools: _props.tools,
          ask: (prompt: string) =>
            new Promise<boolean>((resolve) => {
              // T8: in-app 权限确认 —— agent 在此挂起，等待用户 y/n
              confirmRef.current = { prompt, resolve };
              setConfirm({ prompt });
            }),
          // P1-⑥ 模型主动 awaitUser：agent 挂起等待用户自由文本回复
          askText: (prompt: string) =>
            new Promise<string>((resolve) => {
              askTextRef.current = { prompt, resolve };
              setAskTextPrompt(prompt);
            }),
          trace: _props.traceLogger,
          planMode,
          onToolProgress: (toolName: string, out: string) => {
            // 实时工具输出追加到当前工具消息
            if (toolMsgId.current !== null) appendTo(toolMsgId.current, `  › ${out}`);
            else pushMessage('tool', `  › ${out}`);
          },
        })) {
          if (ev.type === 'assistant_text' && ev.text) {
            appendStreaming(ev.text);
          } else if (ev.type === 'assistant_phase') {
            // P2-⑨: 本轮流式文本收尾，按 progress/final 标记该消息并收束当前流
            const finishedId = streamingId.current;
            const phase = ev.phase;
            if (finishedId !== null && phase) {
              setMessages((m) => m.map((x) => (x.id === finishedId ? { ...x, phase } : x)));
            }
            streamingId.current = null;
          } else if (ev.type === 'tool_call') {
            streamingId.current = null;
            const id = msgId.current++;
            toolMsgId.current = id;
            setMessages((m) => [...m, { id, role: 'tool', text: `🔧 执行工具 ${ev.toolName}` }]);
          } else if (ev.type === 'tool_result') {
            pushMessage('tool', `[工具结果] ${String(ev.result).slice(0, 800)}`);
          } else if (ev.type === 'error') {
            pushMessage('error', ev.error ?? '未知错误');
          } else if (ev.type === 'done') {
            streamingId.current = null;
            toolMsgId.current = null;
            const usage = _props.client.getUsageSummary();
            setCostCny(usage.totalCostCny);
            if (usage.totalTokens > 0) {
              const parts = usage.models
                .map((m) => `${m.model}: ${m.totalTokens}tok(¥${m.costCny.toFixed(4)})`)
                .join(' | ');
              let line = `💰 累计 ${parts} | 合计 ¥${usage.totalCostCny.toFixed(4)}`;
              if (usage.totalCacheHitTokens > 0) {
                const base = usage.totalCacheHitTokens + usage.totalCacheMissTokens;
                const rate = Math.round((usage.totalCacheHitTokens / base) * 100);
                line += ` | 🎯 缓存命中 ${usage.totalCacheHitTokens}tok(${rate}%)`;
              }
              pushMessage('system', line);
            }
            // C：任务结束回显耗时，与成本行同处 done 事件
            const dur = (Date.now() - taskStartRef.current) / 1000;
            pushMessage('system', `⏱ 本次任务耗时 ${formatDuration(dur)}`);
          }
        }
      } catch (e: unknown) {
        pushMessage('error', msgOf(e));
      } finally {
        setBusy(false);
        busyRef.current = false;
      }
    },
    [pushMessage, appendStreaming, appendTo, mode, planMode, _props],
  );

  useInput(
    (ch, key) => {
      // ink 默认 exitOnCtrlC=true 已处理 Ctrl+C 退出
      // T8: in-app 权限确认模式（agent 挂起等待 y/n）
      if (confirmRef.current) {
        if (ch === 'y' || ch === 'Y') {
          const r = confirmRef.current.resolve;
          confirmRef.current = null;
          setConfirm(null);
          r(true);
          return;
        }
        if (ch === 'n' || ch === 'N') {
          const r = confirmRef.current.resolve;
          confirmRef.current = null;
          setConfirm(null);
          r(false);
          return;
        }
        return; // 确认模式下忽略其他键
      }
      // P1-⑥ awaitUser 文本确认模式：agent 挂起等待用户输入，回车回传回复（复用主输入栏）
      if (askTextRef.current) {
        if (key.return && !key.shift) {
          const r = askTextRef.current.resolve;
          const text = input.trim();
          askTextRef.current = null;
          setAskTextPrompt(null);
          setInput('');
          setCursor(0);
          r(text);
          return;
        }
        // 其余键：像普通聊天一样编辑输入行（仅回车被拦截为「发送回复」）
        if (ch && !key.ctrl && !key.meta && !key.backspace && !key.delete && !key.leftArrow && !key.rightArrow && !key.upArrow && !key.downArrow && !key.home && !key.end) {
          setInput((s) => s.slice(0, cursor) + ch + s.slice(cursor));
          setCursor((c) => c + ch.length);
        } else if (key.backspace || key.delete) {
          if (cursor > 0) {
            setInput((s) => s.slice(0, cursor - 1) + s.slice(cursor));
            setCursor((c) => c - 1);
          }
        } else if (key.leftArrow) {
          setCursor((c) => Math.max(0, c - 1));
        } else if (key.rightArrow) {
          setCursor((c) => Math.min(input.length, c + 1));
        } else if (key.home) {
          setCursor(0);
        } else if (key.end) {
          setCursor(input.length);
        }
        return; // 文本确认模式下忽略其他控制键
      }
      // ══ 会话面板视图：导航 + 派发/回复/删除/分支（P1-③）══
      if (view === 'panel') {
        if (key.leftArrow || key.rightArrow) {
          setView('chat');
          setInput('');
          setCursor(0);
          return;
        }
        if (key.escape) {
          // Esc：取消 fork 分支续写模式
          if (continueTarget) {
            setContinueTarget(null);
            pushMessage('system', '已取消分支续写');
          }
          return;
        }
        if (key.upArrow) {
          setPanelSel((s) => Math.max(0, s - 1));
          return;
        }
        if (key.downArrow) {
          setPanelSel((s) => Math.min(ordered.length - 1, s + 1));
          return;
        }
        if (ch === 'f' || ch === 'F') {
          // P1-③ Fork 分叉：克隆选中会话历史到新分支，进入续写模式
          if (selected) {
            const fk = mgr.fork(selected.id);
            if (fk) {
              setContinueTarget(fk.id);
              // 重新计算有序列表以定位新分支选中项
              const g2 = mgr.groups();
              const main2 = mgr.sessions.get(mgr.activeId);
              const ordered2 = main2
                ? [main2, ...g2.needsInput, ...g2.working, ...g2.completed]
                : [...g2.needsInput, ...g2.working, ...g2.completed];
              const idx = ordered2.findIndex((s) => s.id === fk.id);
              setPanelSel(idx >= 0 ? idx : 0);
              pushMessage('system', `已派生分支「${fk.title}」，输入分支续写指令后回车继续此分支（Esc 取消）`);
            }
          }
          return;
        }
        if (key.return) {
          if (continueTarget && selected && selected.id === continueTarget && input.trim()) {
            // 继续 fork 分支：以输入作为续写指令驱动克隆出的历史
            mgr.continueSession(continueTarget, input.trim());
            setContinueTarget(null);
            setInput('');
            setCursor(0);
            setPanelSel(0);
          } else if (input.trim()) {
            void spawnFromPanel(input);
          } else {
            setView('chat');
          }
          return;
        }
        if (ch === ' ') {
          if (selected && selected.status === 'needs_input') mgr.resume(selected.id);
          return;
        }
        if (key.ctrl && (ch === 'x' || ch === 'X')) {
          if (selected && selected.kind === 'child') mgr.remove(selected.id);
          return;
        }
        // 面板内的文本输入 = 新会话任务描述
        if (ch && !key.ctrl && !key.meta && !key.return) {
          setInput((s) => s.slice(0, cursor) + ch + s.slice(cursor));
          setCursor((c) => c + ch.length);
          return;
        }
        if (key.backspace || key.delete) {
          if (cursor > 0) {
            setInput((s) => s.slice(0, cursor - 1) + s.slice(cursor));
            setCursor((c) => c - 1);
          }
          return;
        }
        if (key.home) {
          setCursor(0);
          return;
        }
        if (key.end) {
          setCursor(input.length);
          return;
        }
        return; // 忽略其他键
      }
      if (busyRef.current) return;
      // Enter = 提交（不写换行）；Shift+Enter 多行留待后续增强
      if (key.return && !key.shift) {
        void submit(input);
        return;
      }
      // 普通可打印字符：在光标处插入
      if (ch && !key.ctrl && !key.meta) {
        setInput((s) => s.slice(0, cursor) + ch + s.slice(cursor));
        setCursor((c) => c + ch.length);
        return;
      }
      if (key.backspace || key.delete) {
        if (cursor > 0) {
          setInput((s) => s.slice(0, cursor - 1) + s.slice(cursor));
          setCursor((c) => c - 1);
        }
        return;
      }
      if (key.leftArrow) {
        // 空输入时 ← 切换到会话面板；有内容时仍是光标左移
        if (input.length === 0 && !busyRef.current && !confirmRef.current) {
          setView('panel');
          setPanelSel(0);
          return;
        }
        setCursor((c) => Math.max(0, c - 1));
        return;
      }
      if (key.rightArrow) {
        setCursor((c) => Math.min(input.length, c + 1));
        return;
      }
      if (key.home) {
        setCursor(0);
        return;
      }
      if (key.end) {
        setCursor(input.length);
        return;
      }
      if (key.upArrow) {
        if (history.length === 0) return;
        const ni = historyIdx < 0 ? history.length - 1 : Math.max(0, historyIdx - 1);
        setHistoryIdx(ni);
        setInput(history[ni] ?? '');
        setCursor(history[ni]?.length ?? 0);
        return;
      }
      if (key.downArrow) {
        if (history.length === 0 || historyIdx < 0) return;
        const ni = historyIdx + 1;
        if (ni >= history.length) {
          setHistoryIdx(-1);
          setInput('');
          setCursor(0);
        } else {
          setHistoryIdx(ni);
          setInput(history[ni] ?? '');
          setCursor(history[ni]?.length ?? 0);
        }
        return;
      }
    },
    { isActive: !busyRef.current || confirm !== null || askTextPrompt !== null },
  );

  // 滚动区：仅显示最后能放下的一屏消息（避免超出终端高度）
  const reservedRows = 8;
  const maxRows = Math.max(5, termRows - reservedRows);
  const visible = messages.slice(-maxRows);

  const modelShort = _props.cfg.model.split('-').pop() ?? _props.cfg.model;

  return (
    <Box flexDirection="column" height="100%">
      <Banner
        version={_props.version}
        primaryModel={modelShort}
        reasonerModel={_props.cfg.reasonerModel?.split('-').pop()}
        cwd={process.cwd()}
      />
      {view === 'panel' ? (
        <SessionPanel
          mainS={mainS}
          needsInput={groups.needsInput}
          working={groups.working}
          completed={groups.completed}
          selectedId={selected?.id ?? ''}
        />
      ) : (
        <Box flexGrow={1} flexDirection="column" paddingX={1}>
          {visible.map((m) => {
            // assistant 消息走 Markdown 渲染（**加粗**/*斜体*/代码块等真正生效）
            if (m.role === 'assistant') {
              return <MarkdownMessage key={m.id} text={m.text} role={m.role} phase={m.phase} />;
            }
            // P2-⑨: 仅 assistant 的过程叙述会暗显，非 assistant 消息保持原样
            return (
            <Text key={m.id} wrap="wrap">
              <Text
                color={
                  m.role === 'user'
                    ? '#7ec8e3'
                    : m.role === 'error'
                      ? '#ff6b6b'
                      : m.role === 'tool'
                        ? '#d98cff'
                        : m.role === 'system'
                          ? '#9aa0a6'
                          : '#e8e8e8'
                }
              >
                {m.role === 'user' ? '你> ' : m.role === 'tool' ? '' : m.role === 'system' ? '' : 'Agent> '}
              </Text>
              <Text>{m.text}</Text>
            </Text>
            );
          })}
          {busy && <ThinkingIndicator />}
        </Box>
      )}
      {confirm && (
        <Box paddingX={1}>
          <Text color="#f0b569">🔐 {confirm.prompt} (y/n)</Text>
        </Box>
      )}
      {askTextPrompt && (
        <Box paddingX={1}>
          <Text color="#7ec699">💬 Agent 问你: {askTextPrompt}（输入回复后回车）</Text>
        </Box>
      )}
      <InputBar
        input={input}
        cursor={cursor}
        mode={mode}
        model={modelShort}
        costCny={costCny}
        leftHint={
          view === 'panel'
            ? continueTarget
              ? '↳ 分支续写模式 · 回车继续此分支 · Esc 取消'
              : '← → 返回 · ↑↓ 选择 · f 派生分支 · space 回复 · ctrl+x 删除'
            : undefined
        }
        rightHint={view === 'panel' ? (continueTarget ? '↳ 分支续写中' : `● 会话面板 · ${ordered.length} 个`) : undefined}
      />
    </Box>
  );
}

/** 引导入口：由 main.ts 调用，接管整个终端渲染 */
export async function startApp(props: AppProps): Promise<void> {
  const { waitUntilExit } = render(<App {...props} />);
  await waitUntilExit();
  // Phase 3: 自然退出（Ctrl+C / ink exitOnCtrlC）路径自动抽取记忆；
  // /exit 命令已先跑过则 extractionRan 已置位，此处跳过，确保只跑一次。
  if (!extractionRan && props.cfg.apiKey) {
    extractionRan = true;
    await extractUserMemories(props.client, props.history, props.memoryStore).catch(() => 0);
  }
}
