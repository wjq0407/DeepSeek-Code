import { Box, Text, render, useInput, useApp } from 'ink';
import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import type { ReactNode } from 'react';
import { WHALE_ART, WHALE_EYES } from './whaleArt.ts';
import { ThinkingIndicator } from './thinkingIndicator.tsx';
import { TraceLogger } from '../context/trace.ts';
import { SessionManager, type Session } from '../agent/session.ts';
import { MarkdownMessage } from './Markdown.tsx';
import { saveCredentials } from './auth.ts';
import { KeyCapture } from './login.tsx';
import { styleLabel } from '../agent/output-style.ts';
import type { AppProps, UiMessage } from '../app/types.ts';
import { useAgentController } from '../app/useAgentController.ts';
import { runExtraction } from '../app/chat.ts';

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

export function App(props: AppProps) {
  // 与渲染无关的「聊天逻辑」全部交给控制器（CLI 与网页后端共用 chat.ts 核心）
  const c = useAgentController(props, {
    onExit: () => process.exit(0),
  });

  const termRows = (process.stdout as { rows?: number }).rows ?? 24;
  const [input, setInput] = useState('');
  const [cursor, setCursor] = useState(0);
  const [history, setHistory] = useState<string[]>([]);
  const [historyIdx, setHistoryIdx] = useState(-1);
  const [view, setView] = useState<'chat' | 'panel'>('chat');
  const [panelSel, setPanelSel] = useState(0);
  const [continueTarget, setContinueTarget] = useState<string | null>(null);
  const { exit } = useApp();

  // ══ 会话面板数据源 ══
  const mgr = props.sessionManager;
  const mainS = mgr.sessions.get(mgr.activeId);
  const groups = mgr.groups();
  const ordered: Session[] = mainS
    ? [mainS, ...groups.needsInput, ...groups.working, ...groups.completed]
    : [...groups.needsInput, ...groups.working, ...groups.completed];
  const selIdx = Math.min(panelSel, Math.max(0, ordered.length - 1));
  const selected = ordered[selIdx];

  // P5: 首屏提示已恢复的历史会话数
  useEffect(() => {
    const n = props.restoredSessions ?? 0;
    if (n > 0) c.push('system', `已恢复 ${n} 个历史会话（按 ← 打开会话面板查看）`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.restoredSessions, c.push]);

  // P1：订阅 SessionManager，会话状态变化时触发重渲染
  const [, forceRender] = useState(0);
  useEffect(() => props.sessionManager.subscribe(() => forceRender((n) => n + 1)), []);

  // P1-① 在消息中插入第一条系统消息（如果还没有人发过任何消息）

  const spawnFromPanel = useCallback(
    (text: string) => {
      const id = mgr.spawn(text, {
        client: props.client,
        tools: props.tools,
        cwd: process.cwd(),
        trace: new TraceLogger({ workspaceDir: process.cwd() }),
        permission: c.mode,
      });
      c.push('system', `已派发后台会话: ${text.slice(0, 24) || '(空任务)'}`);
      setInput('');
      setCursor(0);
      setPanelSel(0);
      return id;
    },
    [mgr, props.client, props.tools, c.mode, c.push],
  );

  // ══ 终端输入处理（useInput）—— 仅做按键→动作映射，聊天逻辑走控制器 ══
  useInput(
    (ch, key) => {
      // T8: in-app 权限确认模式（agent 挂起等待 y/n）
      if (c.confirm) {
        if (ch === 'y' || ch === 'Y') {
          c.resolveConfirm(true);
          return;
        }
        if (ch === 'n' || ch === 'N') {
          c.resolveConfirm(false);
          return;
        }
        return;
      }
      // P1-⑥ awaitUser 文本确认模式：agent 挂起等待用户输入，回车回传回复
      if (c.askTextPrompt) {
        if (key.return && !key.shift) {
          c.resolveAskText(input.trim());
          setInput('');
          setCursor(0);
          return;
        }
        if (ch && !key.ctrl && !key.meta && !key.backspace && !key.delete && !key.leftArrow && !key.rightArrow && !key.upArrow && !key.downArrow && !key.home && !key.end) {
          setInput((s) => s.slice(0, cursor) + ch + s.slice(cursor));
          setCursor((cu) => cu + ch.length);
        } else if (key.backspace || key.delete) {
          if (cursor > 0) {
            setInput((s) => s.slice(0, cursor - 1) + s.slice(cursor));
            setCursor((cu) => cu - 1);
          }
        } else if (key.leftArrow) {
          setCursor((cu) => Math.max(0, cu - 1));
        } else if (key.rightArrow) {
          setCursor((cu) => Math.min(input.length, cu + 1));
        } else if (key.home) {
          setCursor(0);
        } else if (key.end) {
          setCursor(input.length);
        }
        return;
      }
      // ══ 会话面板视图：导航 + 派发/回复/删除/分支 ══
      if (view === 'panel') {
        if (key.leftArrow || key.rightArrow) {
          setView('chat');
          setInput('');
          setCursor(0);
          return;
        }
        if (key.escape) {
          if (continueTarget) {
            setContinueTarget(null);
            c.push('system', '已取消分支续写');
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
          if (selected) {
            const fk = mgr.fork(selected.id);
            if (fk) {
              setContinueTarget(fk.id);
              const g2 = mgr.groups();
              const main2 = mgr.sessions.get(mgr.activeId);
              const ordered2 = main2
                ? [main2, ...g2.needsInput, ...g2.working, ...g2.completed]
                : [...g2.needsInput, ...g2.working, ...g2.completed];
              const idx = ordered2.findIndex((s) => s.id === fk.id);
              setPanelSel(idx >= 0 ? idx : 0);
              c.push('system', `已派生分支「${fk.title}」，输入分支续写指令后回车继续此分支（Esc 取消）`);
            }
          }
          return;
        }
        if (key.return) {
          if (continueTarget && selected && selected.id === continueTarget && input.trim()) {
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
        if (ch && !key.ctrl && !key.meta && !key.return) {
          setInput((s) => s.slice(0, cursor) + ch + s.slice(cursor));
          setCursor((cu) => cu + ch.length);
          return;
        }
        if (key.backspace || key.delete) {
          if (cursor > 0) {
            setInput((s) => s.slice(0, cursor - 1) + s.slice(cursor));
            setCursor((cu) => cu - 1);
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
        return;
      }
      if (c.busyRef.current) return;
      // Enter = 提交（不写换行）；Shift+Enter 多行留待后续增强
      if (key.return && !key.shift) {
        const raw = input;
        setHistory((h) => [...h, raw]);
        c.submit(input);
        setInput('');
        setCursor(0);
        setHistoryIdx(-1);
        return;
      }
      // 普通可打印字符：在光标处插入
      if (ch && !key.ctrl && !key.meta) {
        setInput((s) => s.slice(0, cursor) + ch + s.slice(cursor));
        setCursor((cu) => cu + ch.length);
        return;
      }
      if (key.backspace || key.delete) {
        if (cursor > 0) {
          setInput((s) => s.slice(0, cursor - 1) + s.slice(cursor));
          setCursor((cu) => cu - 1);
        }
        return;
      }
      if (key.leftArrow) {
        if (input.length === 0 && !c.busyRef.current && !c.confirm) {
          setView('panel');
          setPanelSel(0);
          return;
        }
        setCursor((cu) => Math.max(0, cu - 1));
        return;
      }
      if (key.rightArrow) {
        setCursor((cu) => Math.min(input.length, cu + 1));
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
    { isActive: (!c.busyRef.current || c.confirm !== null || c.askTextPrompt !== null) && !c.showKeyModal },
  );

  // 专用 Ctrl+C 中断处理器
  useInput(
    (input, key) => {
      if (c.showKeyModal) return;
      if (key.ctrl && input === '\u0003') {
        if (c.busyRef.current) {
          c.abort();
          c.push('system', '⏹ 已发送中断信号，正在停止当前请求...');
        } else {
          c.push('system', '💡 输入 /exit 可退出程序（Ctrl+C 不绑定退出）');
        }
      }
    },
    { isActive: true },
  );

  const modelShort = props.cfg.model.split('-').pop() ?? props.cfg.model;

  // 更换 API Key 遮罩：开启时不渲染主界面，由 KeyCapture 独占输入
  if (c.showKeyModal) {
    return (
      <Box flexDirection="column" height="100%" justifyContent="center" alignItems="center">
        <Box borderStyle="round" borderColor="#2f6fb0" paddingX={2} paddingY={1} flexDirection="column" width={68}>
          <Text color="#2f6fb0" bold>更换 API Key</Text>
          <Text> </Text>
          <KeyCapture
            label="输入新的 DeepSeek API Key（保存后下次启动生效）："
            onSubmit={async (apiKey) => {
              await saveCredentials({
                apiKey,
                baseURL: props.cfg.baseURL,
                model: props.cfg.model,
                reasonerModel: props.cfg.reasonerModel,
              });
              c.setShowKeyModal(false);
              c.push('system', '已保存新 API Key ✅ 下次启动自动使用（当前会话仍用旧 Key）');
            }}
            onCancel={() => {
              c.setShowKeyModal(false);
              c.push('system', '已取消更换');
            }}
          />
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" height="100%">
      <Banner
        version={props.version}
        primaryModel={modelShort}
        reasonerModel={props.cfg.reasonerModel?.split('-').pop()}
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
          {c.messages.map((m) => {
            if (m.role === 'assistant') {
              return <MarkdownMessage key={m.id} text={m.text} role={m.role} phase={m.phase} />;
            }
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
          {c.busy && <ThinkingIndicator />}
        </Box>
      )}
      {c.confirm && (
        <Box paddingX={1}>
          <Text color="#f0b569">🔐 {c.confirm.prompt} (y/n)</Text>
        </Box>
      )}
      {c.askTextPrompt && (
        <Box paddingX={1}>
          <Text color="#7ec699">💬 Agent 问你: {c.askTextPrompt}（输入回复后回车）</Text>
        </Box>
      )}
      <InputBar
        input={input}
        cursor={cursor}
        mode={c.mode}
        model={modelShort}
        costCny={c.costCny}
        leftHint={
          view === 'panel'
            ? continueTarget
              ? '↳ 分支续写模式 · 回车继续此分支 · Esc 取消'
              : '← → 返回 · ↑↓ 选择 · f 派生分支 · space 回复 · ctrl+x 删除'
            : undefined
        }
        rightHint={
          view === 'panel'
            ? continueTarget
              ? '↳ 分支续写中'
              : `● 会话面板 · ${ordered.length} 个`
            : `风格:${styleLabel(c.outputStyle)} · /style 切换`
        }
      />
    </Box>
  );
}

/** 引导入口：由 main.ts 调用，接管整个终端渲染 */
export async function startApp(props: AppProps): Promise<void> {
  // 禁用 ink 默认的 Ctrl+C 退出；退出程序统一走 /exit 命令。
  const { waitUntilExit } = render(<App {...props} />, { exitOnCtrlC: false });
  await waitUntilExit();
  // 自然退出路径自动抽取记忆（/exit 已先跑过则 runExtraction 内部跳过，确保只跑一次）
  await runExtraction(props);
}
