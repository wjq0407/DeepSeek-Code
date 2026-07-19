/**
 * useAgentController —— CLI（ink）端对 ChatContext 的实现。
 *
 * 把原 app.tsx 里「与渲染无关」的全部状态与逻辑（消息、busy、模式、runAgent 循环、
 * 权限确认、awaitUser…）抽成这个 React hook。ink 版的 app.tsx 只保留「终端专属」的东西
 * （光标、面板视图、useInput 按键映射、Banner），并通过本 hook 的返回值驱动渲染。
 *
 * 网页端不复用这个 hook（它跑在浏览器，没有 fs/process），而是用 Node 端的 AgentHost
 * 实现同一份 ChatContext —— 业务逻辑在 chat.ts，两边零重复。
 */
import { useCallback, useRef, useState } from 'react';
import type { MutableRefObject } from 'react';
import type { PermissionMode } from '../agent/loop.ts';
import type { OutputStyle } from '../agent/output-style.ts';
import { loadStyle } from '../agent/output-style.ts';
import { runChatTurn, type ChatContext } from './chat.ts';
import type { AppProps, MsgRole, UiMessage } from './types.ts';

export interface UseAgentControllerOptions {
  /** /exit 退出行为（CLI 传 process.exit，网页后端用不到） */
  onExit?: () => void;
}

export interface AgentController {
  messages: UiMessage[];
  busy: boolean;
  busyRef: MutableRefObject<boolean>;
  mode: PermissionMode;
  planMode: boolean;
  outputStyle: OutputStyle;
  costCny: number;
  confirm: { prompt: string } | null;
  askTextPrompt: string | null;
  showKeyModal: boolean;
  setShowKeyModal: (v: boolean) => void;
  submit: (text: string) => void;
  resolveConfirm: (yes: boolean) => void;
  resolveAskText: (text: string) => void;
  abort: () => void;
  setMode: (m: PermissionMode) => void;
  setPlanMode: (b: boolean) => void;
  setOutputStyle: (s: OutputStyle) => void;
  /** 供终端专属逻辑（KeyCapture 反馈、首屏提示）直接写消息 */
  push: (role: MsgRole, text: string) => number;
  /** 供历史面板加载上下文时整体替换消息 */
  setMessages: (ms: UiMessage[]) => void;
}

export function useAgentController(props: AppProps, opts?: UseAgentControllerOptions): AgentController {
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [busy, setBusyState] = useState(false);
  const busyRef = useRef(false);
  const [mode, setMode] = useState<PermissionMode>(props.cfg.reasonerModel ? 'ask' : 'execute');
  const [planMode, setPlanMode] = useState(false);
  const [outputStyle, setOutputStyle] = useState<OutputStyle>(() => loadStyle(process.cwd()));
  const [costCny, setCostCny] = useState(0);
  const [confirm, setConfirm] = useState<{ prompt: string } | null>(null);
  const [askTextPrompt, setAskTextPrompt] = useState<string | null>(null);
  const [showKeyModal, setShowKeyModal] = useState(false);

  const msgId = useRef(0);
  const streamingId = useRef<number | null>(null);
  const toolMsgId = useRef<number | null>(null);
  const activeAbort = useRef<AbortController | null>(null);
  const confirmRef = useRef<{ prompt: string; resolve: (b: boolean) => void } | null>(null);
  const askTextRef = useRef<{ prompt: string; resolve: (t: string) => void } | null>(null);

  // 让 getState 始终读到最新 state（避免 runChatTurn 闭包过期）
  const stateRef = useRef({ mode, planMode, outputStyle });
  stateRef.current = { mode, planMode, outputStyle };
  const messagesRef = useRef<UiMessage[]>(messages);
  messagesRef.current = messages;

  const push = useCallback((role: MsgRole, text: string): number => {
    const id = msgId.current++;
    setMessages((m) => [...m, { id, role, text }]);
    return id;
  }, []);

  const appendTo = useCallback((id: number, chunk: string) => {
    setMessages((m) => m.map((x) => (x.id === id ? { ...x, text: x.text + chunk } : x)));
  }, []);

  const appendStreaming = useCallback(
    (chunk: string, _reactPhase?: 'thought' | 'action' | 'observation' | 'final' | 'progress') => {
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

  const endStreaming = useCallback((phase?: 'progress' | 'final', interrupted?: boolean) => {
    const id = streamingId.current;
    if (id !== null && (phase || interrupted)) {
      setMessages((m) =>
        m.map((x) => (x.id === id ? { ...x, ...(phase ? { phase } : {}), ...(interrupted ? { interrupted: true } : {}) } : x)),
      );
    }
    streamingId.current = null;
  }, []);

  // 网页路径的思考盒晋升由 agent-host（Node）处理；CLI/TUI 此处无对应概念，置空操作。
  const prometeThinkingToFinal = useCallback((): void => {}, []);

  const beginTool = useCallback(
    (toolName: string) => {
      endStreaming();
      const id = msgId.current++;
      toolMsgId.current = id;
      setMessages((m) => [...m, { id, role: 'tool', text: `🔧 执行工具 ${toolName}` }]);
    },
    [endStreaming],
  );

  const appendTool = useCallback(
    (out: string) => {
      if (toolMsgId.current !== null) appendTo(toolMsgId.current, `  › ${out}`);
      else push('tool', `  › ${out}`);
    },
    [appendTo, push],
  );

  const endTool = useCallback(() => {
    toolMsgId.current = null;
  }, []);

  /**
   * 把本轮错误附加到思考盒——不创建新气泡、不清除已记录的思考。
   * 推为 tool 角色（前端会归入思考盒作为观察条目）而不是 error 角色（独立气泡会覆盖上下文）。
   */
  const appendError = useCallback(
    (msg: string) => {
      const text = msg.length > 480 ? msg.slice(0, 480) + '…' : msg;
      if (toolMsgId.current !== null) {
        appendTo(toolMsgId.current, `\n⚠ [错误] ${text}`);
        toolMsgId.current = null;
      } else {
        push('tool', `⚠ [错误] ${text}`);
      }
    },
    [appendTo, push],
  );

  const setBusy = useCallback((b: boolean) => {
    busyRef.current = b;
    setBusyState(b);
  }, []);

  const requestConfirm = useCallback(
    (prompt: string) =>
      new Promise<boolean>((resolve) => {
        confirmRef.current = { prompt, resolve };
        setConfirm({ prompt });
      }),
    [],
  );
  const resolveConfirm = useCallback((yes: boolean) => {
    const r = confirmRef.current?.resolve;
    confirmRef.current = null;
    setConfirm(null);
    r?.(yes);
  }, []);

  const requestAskText = useCallback(
    (prompt: string) =>
      new Promise<string>((resolve) => {
        askTextRef.current = { prompt, resolve };
        setAskTextPrompt(prompt);
      }),
    [],
  );
  const resolveAskText = useCallback((text: string) => {
    const r = askTextRef.current?.resolve;
    askTextRef.current = null;
    setAskTextPrompt(null);
    r?.(text);
  }, []);

  const abort = useCallback(() => {
    activeAbort.current?.abort();
  }, []);
  const setActiveAbort = useCallback((ac: AbortController | null) => {
    activeAbort.current = ac;
  }, []);

  // 组装稳定的 ChatContext（构造一次，所有方法均为稳定引用）
  const ctxRef = useRef<ChatContext | null>(null);
  if (!ctxRef.current) {
    ctxRef.current = {
      props,
      cwd: process.cwd(),
      push,
      appendTo,
      appendStreaming,
      endStreaming,
      prometeThinkingToFinal,
      beginTool,
      appendTool,
      endTool,
      appendError,
      setBusy,
      setCost: setCostCny,
      getState: () => stateRef.current,
      maxIterations: 0, // CLI 默认无上限
      setMaxIterations: (n: number) => { /* CLI 无 GUI 设置入口，stub */ },
      getIterations: () => 0, // CLI 无迭代跟踪，stub
      setBrowserWatch: (_b: boolean) => { /* CLI 无浏览器，stub */ },
      getBrowserWatch: () => false, // CLI 无浏览器观察，stub
      setMode,
      setPlanMode,
      setOutputStyle,
      setActiveAbort,
      abort,
      requestConfirm,
      requestAskText,
      getMessages: () => messagesRef.current,
      setMessages,
      requestKeyChange: () => setShowKeyModal(true),
      onExit: opts?.onExit,
    };
  }

  const submit = useCallback((text: string) => {
    void runChatTurn(text, ctxRef.current!);
  }, []);

  return {
    messages,
    busy,
    busyRef,
    mode,
    planMode,
    outputStyle,
    costCny,
    confirm,
    askTextPrompt,
    showKeyModal,
    setShowKeyModal,
    submit,
    resolveConfirm,
    resolveAskText,
    abort,
    setMode,
    setPlanMode,
    setOutputStyle,
    push,
    setMessages,
  };
}
