/**
 * 网页前端（DOM，运行在浏览器）。
 *
 * 三栏式布局：
 *   - 左侧栏：任务区（新建 / 切换 / 搜索 / 删除 / 状态）
 *   - 中间主区域：对话消息流 + 输入框
 *   - 右侧栏：文件资源 / 代码预览（只读浏览 agent 工作目录）
 *
 * 响应式：桌面端三栏并列，左右栏可折叠；小屏幕底部 tab 切换为单栏视图。
 *
 * 它只是 AgentHost（Node 后端）的「瘦客户端」：通过 WebSocket 收发消息，本地只做
 * 渲染与输入。所有内核逻辑都在后端。
 */
import { useEffect, useRef, useState, useCallback, useMemo, type ChangeEvent } from 'react';
import remarkGfm from 'remark-gfm';
import { Plus, Settings, LogOut, ChevronRight, ChevronLeft, MessageSquare, Share2, Bookmark, Ellipsis, Upload, Download } from 'lucide-react';
import type { UiMessage, MsgRole } from '../../app/types.ts';
import { ChatArea } from './ChatArea.tsx';
import { Composer } from './Composer.tsx';
import CommandPalette, { PaletteCommand } from './CommandPalette.tsx';
import { SkillSheet, type SkillMetaItem, type SkillFilter } from './SkillSheet.tsx';
import { AgentPrompt } from './AgentPrompt.tsx';
import { initBrowserTelemetry } from './telemetry.ts';
import type { BrowserTelemetryEvent } from '../telemetry-types.ts';

interface ConnState {
  busy: boolean;
  mode: string;
  planMode: boolean;
  outputStyle: string;
  model: string;
  currentIteration: number;
  maxIterations: number;
  browserWatch: boolean;
}

/** 任务状态：进行中 / 已暂停 / 已完成 */
type TaskStatus = 'active' | 'paused' | 'done';

interface TaskItem {
  id: string;
  title: string;
  active: boolean;
  status: TaskStatus;
  /** 任务目标 / 一句话描述 */
  goal: string;
  updatedAt: number;
}

interface Artifact {
  id: number;
  kind: 'tool' | 'code' | 'file' | 'text';
  title: string;
  content: string;
}

interface MemoryEntry {
  id: string;
  content: string;
  tags?: string[];
  createdAt: number;
  updatedAt?: number;
}

interface MemoryScopeData {
  facts: string[];
  entries: MemoryEntry[];
}

interface MemoryListData {
  user: MemoryScopeData;
  project: MemoryScopeData;
}

interface TrashItem {
  trashId: string;
  kind: 'entry' | 'fact';
  deletedAt: number;
  entry?: MemoryEntry;
  fact?: string;
}

interface TrashListData {
  user: TrashItem[];
  project: TrashItem[];
}

/** 记忆导出包（与后端 MemoryExportBundle 对应）：事实原文 + 语义记忆条目。 */
interface MemoryExportBundle {
  kind: string;
  version: number;
  scope: 'user' | 'project';
  exportedAt: string;
  facts: string;
  entries: Array<{ content: string; tags?: string[] }>;
}

type ReviseActionKind = 'delete' | 'merge_remove' | 'merge_keep';

interface ReviseActionData {
  kind: ReviseActionKind;
  scope: 'user' | 'project';
  id: string;
  content: string;
  target?: string;
  reason: string;
}

interface ReviseProposalData {
  actions: ReviseActionData[];
  summary: string;
  skipped: boolean;
  reason?: string;
}

type MobilePanel = 'left' | 'main' | 'right';

type ServerMsg =
  | { type: 'auth_ok'; token: string; username: string }
  | { type: 'auth_error'; message: string }
  | { type: 'message'; id: number; role: MsgRole; text: string; thinkingId?: number }
  | { type: 'update'; id: number; text: string }
  | { type: 'reset'; messages: UiMessage[] }
  | { type: 'state'; busy: boolean; mode: string; planMode: boolean; outputStyle: string; model?: string; currentIteration?: number; maxIterations?: number; browserWatch?: boolean }
  | { type: 'thinking_start'; turnId: number }
  | { type: 'thinking_entry'; id: number; kind: 'reason' | 'tool' | 'tool_result'; title?: string; text: string }
  | { type: 'thinking_update'; id: number; append: string }
  | { type: 'thinking_status'; status: 'thinking' | 'outputting' | 'done' | 'interrupted' }
  | { type: 'thinking_end'; turnId: number }
  | { type: 'gen_interrupted'; id: number }
  | { type: 'confirm'; prompt: string }
  | { type: 'asktext'; prompt: string }
  | { type: 'need_key'; reason: 'missing' | 'invalid' | 'change'; error?: string }
  | { type: 'key_ok' }
  | { type: 'key_error'; error: string }
  | { type: 'task_list'; tasks: TaskItem[] }
  | { type: 'task_error'; message: string }
  | { type: 'polish_result'; text: string }
  | {
      type: 'skills_list';
      metas: SkillMetaItem[];
      filter: SkillFilter | null;
    }
  | { type: 'artifact'; id: number; kind: Artifact['kind']; title: string; content: string }
  | { type: 'artifact_update'; id: number; append?: string; content?: string }
  | { type: 'exit' }
  | { type: 'memory_list'; data: MemoryListData }
  | { type: 'memory_error'; message: string }
  | { type: 'trash_list'; data: TrashListData }
  | { type: 'revise_proposal'; proposal: ReviseProposalData }
  | { type: 'revise_result'; deleted: number; merged: number; summary: string; skipped: boolean; reason: string }
  | { type: 'upload_ok'; name: string; path: string }
  | { type: 'memory_promoted'; taskId: string; title: string; facts: number; entries: number }
  | { type: 'memory_export'; scope: 'user' | 'project'; bundle: MemoryExportBundle }
  | { type: 'memory_imported'; scope: 'user' | 'project'; factsAdded: number; entriesAdded: number; skipped: number }
  | { type: 'file_tree_result'; path: string; entries: { name: string; type: 'dir' | 'file'; size: number }[]; unconfigured?: boolean }
  | { type: 'file_read_result'; path: string; content: string; truncated: boolean; size: number }
  | { type: 'file_error'; message: string }
  | { type: 'settings'; workspaceRoot: string | null; effectiveRoot: string | null }
  | { type: 'dir_list'; path: string; parent: string | null; entries: { name: string; type: 'dir' | 'drive' }[]; isDrives?: boolean; error?: string }
  | { type: 'telemetry'; events: BrowserTelemetryEvent[] };

/** 思考盒里的一条「观察」条目（推理 / 工具调用 / 工具结果） */
export interface ThinkingEntry {
  id: number;
  kind: 'reason' | 'tool' | 'tool_result';
  title?: string;
  text: string;
  status: 'streaming' | 'done';
}
/** 一轮对话的思考过程（含若干观察条目 + 状态） */
export interface ThinkingTurn {
  turnId: number;
  status: 'thinking' | 'outputting' | 'done' | 'interrupted';
  collapsed: boolean;
  entries: ThinkingEntry[];
}

/** API 设置浮层状态 */
interface KeyDialog {
  open: boolean;
  reason: 'missing' | 'invalid' | 'change';
  error?: string;
  saving: boolean;
}

const ROLE_COLOR: Record<MsgRole, string> = {
  user: '#2f6fb0',
  assistant: '#1a1a1a',
  tool: '#7a3fb0',
  system: '#6b7280',
  error: '#c0392b',
};

const TOKEN_KEY = 'dsa_token';

function formatTime(ts: number): string {
  const d = new Date(ts);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function formatSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** 新建任务的模板预设：选定后用 title + 初始 goal 直接创建，省去手动填写目标 */
const TASK_TEMPLATES = [
  { key: 'blank', label: '空白任务', title: '新任务', goal: '' },
  { key: 'review', label: '代码审查', title: '代码审查', goal: '' },
  { key: 'research', label: '资料调研', title: '资料调研', goal: '' },
  { key: 'write', label: '文档写作', title: '文档写作', goal: '' },
  { key: 'debug', label: '问题调试', title: '问题调试', goal: '' },
];

export function App() {
  const [view, setView] = useState<'login' | 'app'>('login');
  const [connected, setConnected] = useState(false);
  const [token, setToken] = useState<string | null>(() => sessionStorage.getItem(TOKEN_KEY));
  const [username, setUsername] = useState<string | null>(null);

  // 登录/注册
  const [authMode, setAuthMode] = useState<'login' | 'register'>('login');
  const [loginUser, setLoginUser] = useState('');
  const [loginPass, setLoginPass] = useState('');
  const [authErr, setAuthErr] = useState<string | null>(null);
  /** 登录成功后等待服务端启动内核 + 推送任务列表的阶段 */
  const [loadingBoot, setLoadingBoot] = useState(false);

  // 主题：默认读 localStorage（index.html 的防闪烁脚本已提前设好 data-theme）
  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    const saved = typeof localStorage !== 'undefined' ? localStorage.getItem('dsa_theme') : null;
    return saved === 'dark' ? 'dark' : 'light';
  });
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    try { localStorage.setItem('dsa_theme', theme); } catch { /* 忽略隐私模式下的写入失败 */ }
  }, [theme]);

  // 三栏状态
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [taskSearch, setTaskSearch] = useState('');
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);

  // 文件资源浏览器（只读）
  const [fileTree, setFileTree] = useState<{ name: string; type: 'dir' | 'file'; size: number }[]>([]);
  const [filePath, setFilePath] = useState<string>('');
  const [previewFile, setPreviewFile] = useState<string | null>(null);
  const [previewContent, setPreviewContent] = useState<string>('');
  const [previewTruncated, setPreviewTruncated] = useState(false);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  // 工作空间设置（agent 编辑 & 右侧文件面板指向的代码项目）
  const [workspaceRoot, setWorkspaceRoot] = useState<string | null>(null);

  // 技能上拉菜单
  const [skillSheetOpen, setSkillSheetOpen] = useState(false);
  const [skillMetas, setSkillMetas] = useState<SkillMetaItem[]>([]);
  const [skillFilter, setSkillFilter] = useState<SkillFilter | null>(null);
  const [skillInsert, setSkillInsert] = useState<string | null>(null); // 把指定技能名注入 Composer
  const [effectiveRoot, setEffectiveRoot] = useState<string | null>(null);
  // 文件面板是否因「未配置工作空间」而无内容（防泄露工具源码）
  const [fileUnconfigured, setFileUnconfigured] = useState(false);
  // 目录选择器的浏览状态
  const [showDirPicker, setShowDirPicker] = useState(false);
  const [dirBrowsePath, setDirBrowsePath] = useState<string>('');
  const [dirBrowseParent, setDirBrowseParent] = useState<string | null>(null);
  const [dirBrowseEntries, setDirBrowseEntries] = useState<{ name: string; type: 'dir' | 'drive' }[]>([]);
  const [dirBrowseError, setDirBrowseError] = useState<string | null>(null);
  const [dirIsDrives, setDirIsDrives] = useState(false);

  const loadFileTree = (relPath: string) => {
    setPreviewFile(null);
    setPreviewContent('');
    setFileError(null);
    setFilePath(relPath);
    wsSend(JSON.stringify({ type: 'file_tree', path: relPath }));
  };
  const openFile = (relPath: string) => {
    setPreviewFile(relPath);
    setPreviewContent('');
    setFileError(null);
    setPreviewLoading(true);
    wsSend(JSON.stringify({ type: 'file_read', path: relPath }));
  };
  // ── 工作空间设置 ──
  const requestDirBrowse = (path: string) => {
    setDirBrowseError(null);
    wsSend(JSON.stringify({ type: 'dir_browse', path }));
  };
  const openDirPicker = () => {
    setShowDirPicker(true);
    requestDirBrowse(workspaceRoot ?? '');
  };
  const selectWorkspaceDir = (path: string) => {
    wsSend(JSON.stringify({ type: 'set_settings', workspaceRoot: path }));
    setShowDirPicker(false);
    loadFileTree(''); // 立即刷新右侧文件面板到新工作空间
  };
  const [leftOpen, setLeftOpen] = useState(true);
  const [rightOpen, setRightOpen] = useState(true);
  const [mobilePanel, setMobilePanel] = useState<MobilePanel>('main');
  const isMobile = useMobileDetect();

  // 聊天
  const [messages, setMessages] = useState<UiMessage[]>([]);
  /** 前端消息+思考过程缓存：按任务 ID 存最近一次快照（消息数组 + 思考盒条目）。
   *  切换任务时直接取缓存 → 秒开无加载延迟，且思考过程不丢。 */
  const messagesCacheRef = useRef<Map<string, { messages: UiMessage[]; thinkings: ThinkingTurn[] }>>(new Map());
  /** 当前激活任务 ID（从任务列表推导，用于缓存 key） */
  const activeTaskIdRef = useRef<string | null>(null);
  /** 思考盒：每轮对话的智能体思考过程（观察条目累积），与最终答案气泡分开 */
  const [thinkings, setThinkings] = useState<ThinkingTurn[]>([]);
  /** 是否正处于「输出最终答案」阶段（答案气泡显示「输出中…」） */
  const [outputting, setOutputting] = useState(false);
  /** 润色输入框文本时按钮显示加载态 */
  const [polishLoading, setPolishLoading] = useState(false);
  const [input, setInput] = useState('');
  /** 待发送附件：上传后暂存，随下一条消息一并提交给 agent */
  const [pendingAttachments, setPendingAttachments] = useState<Array<{ name: string; path: string }>>([]);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [state, setState] = useState<ConnState>({ busy: false, mode: 'execute', planMode: false, outputStyle: 'human', model: '', currentIteration: 0, maxIterations: 0, browserWatch: false });
  /** 智能体询问：浮层显示（confirm = y/n；asktext = 自由输入）。同一时刻只可能存在一个。 */
  const [agentPrompt, setAgentPrompt] = useState<{ prompt: string; mode: 'confirm' | 'asktext' } | null>(null);
  const [keyDialog, setKeyDialog] = useState<KeyDialog>({ open: false, reason: 'missing', saving: false });
  /** 任务删除确认弹框（替代原生 window.confirm，沿用项目统一 modal 风格） */
  const [deleteDialog, setDeleteDialog] = useState<{ open: boolean; id: string; title: string; isActive: boolean }>({ open: false, id: '', title: '', isActive: false });
  const [keyInput, setKeyInput] = useState('');
  const [baseURLInput, setBaseURLInput] = useState('');
  const [modelInput, setModelInput] = useState('');
  const [reasonerModelInput, setReasonerModelInput] = useState('');
  const [showAdvanced, setShowAdvanced] = useState(false);

  // 设置浮层内的标签页（API / 记忆）
  const [settingsTab, setSettingsTab] = useState<'api' | 'memory' | 'project'>('api');
  const [memories, setMemories] = useState<MemoryListData | null>(null);
  const [memLoad, setMemLoad] = useState(false);
  const [memErr, setMemErr] = useState<string | null>(null);
  // 记忆体检（陈旧性治理）状态
  const [revising, setRevising] = useState(false);
  const [applying, setApplying] = useState(false);
  const [reviseMsg, setReviseMsg] = useState<string | null>(null);
  const [reviseProposal, setReviseProposal] = useState<ReviseProposalData | null>(null);
  // 回收站（软删除 / 恢复）状态
  const [trash, setTrash] = useState<TrashListData | null>(null);
  const [showTrash, setShowTrash] = useState(false);

  const wsRef = useRef<WebSocket | null>(null);
  /**
   * 安全发送：仅在连接处于 OPEN 时写入，避免 WS 处于 CONNECTING/CLOSING/CLOSED
   * 时调用 send() 抛出 "WebSocket is already in CLOSING or CLOSED state"。
   * 返回是否真正发出，调用方可据此决定是否提示/重试。
   */
  const wsSend = (data: string): boolean => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(data);
      return true;
    }
    return false;
  };
  /** 设置迭代轮次上限：通过 WS 发给服务端 */
  const onSetLimit = (n: number) => {
    wsSend(JSON.stringify({ type: 'set_limit', limit: n }));
  };
  /** 折叠/展开某轮「思考过程」卡片（useCallback 稳定引用，供记忆化行组件跳过重渲染） */
  const toggleThinking = useCallback((turnId: number): void => {
    setThinkings((t) => t.map((x) => (x.turnId === turnId ? { ...x, collapsed: !x.collapsed } : x)));
  }, []);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  // 用户是否「贴着底部」：贴底时新内容自动跟随滚动；用户上滑看历史时不打扰。
  const pinnedRef = useRef<boolean>(true);
  const followRef = useRef<boolean>(true); // 流式自动跟随开关：用户手动滚动即关，回到底部再开
  const dragIdRef = useRef<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [pendingImportScope, setPendingImportScope] = useState<'user' | 'project' | null>(null);

  // ── 流式更新合批（性能优化 #1/#2）──────────────────────────────────────────
  // 后端每收到一个 chunk 就发一条 `update`/`thinking_update`；若逐个 setMessages，
  // 整棵对话树每个 chunk 都重渲染（长对话一次答案数百次），页面直接卡死。
  // 这里把同一窗口内的全部增量攒进 ref，再用一个 ~80ms 的尾沿节流统一提交一次
  // setState，把「每 chunk 一次重渲染」降到「每 ~80ms 一次」，且一次提交合并所有增量。
  // 视觉上与逐字流式无差异（打字机在更内层平滑揭示），但渲染次数降数倍。
  const FLUSH_MS = 80;
  const pendingMsgText = useRef<Map<number, string>>(new Map()); // msgId -> 完整 text（覆盖式）
  const pendingThinkAppend = useRef<Map<number, string>>(new Map()); // entryId -> 累计增量（追加式）
  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flushPending = useCallback(() => {
    flushTimer.current = null;
    if (pendingMsgText.current.size > 0) {
      const batch = pendingMsgText.current;
      pendingMsgText.current = new Map();
      setMessages((m) => m.map((x) => {
        const t = batch.get(x.id);
        return t !== undefined ? { ...x, text: t } : x;
      }));
    }
    if (pendingThinkAppend.current.size > 0) {
      const batch = pendingThinkAppend.current;
      pendingThinkAppend.current = new Map();
      setThinkings((t) => {
        const last = t[t.length - 1];
        if (!last) return t;
        let changed = false;
        const entries = last.entries.map((e) => {
          const a = batch.get(e.id);
          if (a) {
            changed = true;
            return { ...e, text: e.text + a };
          }
          return e;
        });
        return changed ? t.slice(0, -1).concat({ ...last, entries }) : t;
      });
    }
  }, []);

  const scheduleFlush = useCallback(() => {
    // 尾沿节流：首个增量排程定时器，窗口内后续增量不再重排，
    // 统一在 FLUSH_MS 后提交——即「攒一批再更新一次」。
    if (flushTimer.current) return;
    flushTimer.current = setTimeout(flushPending, FLUSH_MS);
  }, [flushPending]);

  const clearPending = useCallback(() => {
    if (flushTimer.current) {
      clearTimeout(flushTimer.current);
      flushTimer.current = null;
    }
    pendingMsgText.current.clear();
    pendingThinkAppend.current.clear();
  }, []);

  useEffect(() => {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    wsRef.current = ws;
    // 浏览器端遥测：复用当前 WS 把运行时错误/控制台/网络失败回报给本地服务器，
    // 由服务器回灌进 AI 调试循环。initBrowserTelemetry 内部自带 once 守卫。
    initBrowserTelemetry((events) =>
      wsSend(JSON.stringify({ type: 'telemetry', events })),
    );
    ws.onopen = () => {
      setConnected(true);
      const t = sessionStorage.getItem(TOKEN_KEY);
      if (t) ws.send(JSON.stringify({ type: 'resume', token: t }));
    };
    ws.onclose = () => {
      setConnected(false);
    };
    ws.onmessage = (e) => {
      let msg: ServerMsg;
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }
      switch (msg.type) {
        case 'auth_ok':
          sessionStorage.setItem(TOKEN_KEY, msg.token);
          setToken(msg.token);
          setUsername(msg.username);
          setView('app');
          setAuthErr(null);
          setLoadingBoot(true);  // 等待内核启动 + 任务列表
          ws.send(JSON.stringify({ type: 'get_settings' }));
          loadFileTree('');
          break;
        case 'auth_error':
          setAuthErr(msg.message);
          setView('login');
          setLoadingBoot(false);
          break;
        case 'message':
          setMessages((m) => [...m, { id: msg.id, role: msg.role, text: msg.text, thinkingId: msg.thinkingId }]);
          break;
        case 'thinking_start':
          setOutputting(false);
          // 默认折叠：思考过程收进独立盒子，用户可点击展开查看（不在消息气泡中显示）
          setThinkings((t) => [...t, { turnId: msg.turnId, status: 'thinking', collapsed: true, entries: [] }]);
          break;
        case 'thinking_entry':
          setThinkings((t) => {
            const last = t[t.length - 1];
            if (!last) return t;
            return t.slice(0, -1).concat({
              ...last,
              entries: [...last.entries, { id: msg.id, kind: msg.kind, title: msg.title, text: msg.text, status: 'streaming' }],
            });
          });
          break;
        case 'thinking_update':
          // 合批：增量攒进 pendingThinkAppend（同窗口内多条增量叠加），由 scheduleFlush 统一提交
          pendingThinkAppend.current.set(msg.id, (pendingThinkAppend.current.get(msg.id) ?? '') + msg.append);
          scheduleFlush();
          break;
        case 'thinking_status':
          setOutputting(msg.status === 'outputting');
          setThinkings((t) => {
            const last = t[t.length - 1];
            if (!last) return t;
            return t.slice(0, -1).concat({ ...last, status: msg.status });
          });
          break;
        case 'thinking_end':
          setOutputting(false);
          setThinkings((t) => {
            const idx = t.findIndex((x) => x.turnId === msg.turnId);
            if (idx === -1) return t;
            const next = t.slice();
            next[idx] = { ...next[idx], status: 'done' };
            // 思考盒保留在界面上：本轮结束后不自动折叠，用户可手动展开/收起
            const tid = activeTaskIdRef.current;
            if (tid) {
              const snap = messagesCacheRef.current.get(tid);
              const curMsgs = snap ? snap.messages : [];
              messagesCacheRef.current.set(tid, { messages: curMsgs, thinkings: next });
            }
            return next;
          });
          break;
        case 'gen_interrupted':
          // 用户中断：把对应答案气泡标记为「生成中断」（保留半截内容，仅加徽章）
          setMessages((m) => m.map((x) => (x.id === msg.id ? { ...x, interrupted: true } : x)));
          {
            const tid = activeTaskIdRef.current;
            if (tid) {
              const snap = messagesCacheRef.current.get(tid);
              const curMsgs = snap ? snap.messages : [];
              const next = curMsgs.map((x) => (x.id === msg.id ? { ...x, interrupted: true } : x));
              messagesCacheRef.current.set(tid, { messages: next, thinkings: snap?.thinkings ?? [] });
            }
          }
          break;
        // 'thinking_clear' 已废弃：思考盒保留在界面上（不清除），无需移除该轮。
        case 'upload_ok':
          // 后端已保存文件，前端把附件暂存为「待发送」
          if (msg.name && msg.path) {
            setPendingAttachments((prev) => [...prev, { name: String(msg.name), path: String(msg.path) }]);
          }
          break;
        case 'update':
          // 合批：完整 text 攒进 pendingMsgText（覆盖式），由 scheduleFlush 统一提交（见上方性能优化）
          pendingMsgText.current.set(msg.id, msg.text);
          scheduleFlush();
          break;
        case 'reset':
          clearPending();
          setMessages(msg.messages.filter(Boolean));
          setThinkings([]);
          setOutputting(false);
          // 同步缓存：服务端 reset = 当前任务的最新消息快照（含已完成的思考过程）
          {
            const ms = msg.messages.filter(Boolean) as UiMessage[];
            const tid = activeTaskIdRef.current;
            if (tid) messagesCacheRef.current.set(tid, { messages: ms, thinkings: [] });
          }
          break;
        case 'state':
          setState({ busy: msg.busy, mode: msg.mode, planMode: msg.planMode, outputStyle: msg.outputStyle, model: msg.model ?? '', currentIteration: msg.currentIteration ?? 0, maxIterations: msg.maxIterations ?? 0, browserWatch: msg.browserWatch ?? false });
          break;
        case 'confirm':
          setAgentPrompt({ prompt: msg.prompt, mode: 'confirm' });
          break;
        case 'asktext':
          setAgentPrompt({ prompt: msg.prompt, mode: 'asktext' });
          break;
        case 'need_key':
          // 不再阻塞弹窗，只在对话区给出软提醒
          setMessages((m) => [
            ...m,
            {
              id: Date.now(),
              role: 'system',
              text:
                msg.reason === 'invalid'
                  ? `API Key 校验失败：${msg.error ?? '无效'}。请打开顶栏 ⚙ API 重新配置。`
                  : '你还没有配置 DeepSeek API Key。点击顶栏 ⚙ API 进行配置后，即可开始对话。',
            },
          ]);
          break;
        case 'key_ok':
          setKeyDialog({ open: false, reason: 'missing', saving: false });
          setKeyInput('');
          setMessages((m) => [...m, { id: Date.now(), role: 'system', text: 'API Key 已保存，可以开始对话了。' }]);
          break;
        case 'key_error':
          // 保存失败时才打开浮层让用户看到错误并重新输入
          setKeyDialog((d) => ({ ...d, open: true, error: msg.error, saving: false }));
          break;
        case 'polish_result':
          setPolishLoading(false);
          if (msg.text) setInput(msg.text);
          break;
        case 'task_list':
          setTasks(msg.tasks);
          setLoadingBoot(false);
          // 同步当前激活任务 ID 供缓存 key 使用
          {
            const active = (msg.tasks as TaskItem[]).find((t) => t.active);
            if (active) activeTaskIdRef.current = active.id;
          }
          break;
        case 'skills_list':
          setSkillMetas(Array.isArray(msg.metas) ? msg.metas : []);
          setSkillFilter(msg.filter ?? null);
          break;
        case 'task_error':
          setMessages((m) => [...m, { id: Date.now(), role: 'error', text: `任务错误：${msg.message}` }]);
          break;
        case 'artifact':
          setArtifacts((prev) => [...prev, { id: msg.id, kind: msg.kind, title: msg.title, content: msg.content }]);
          if (!rightOpen && !isMobile) setRightOpen(true);
          break;
        case 'artifact_update': {
          setArtifacts((prev) =>
            prev.map((a) => {
              if (a.id !== msg.id) return a;
              if (msg.content !== undefined) return { ...a, content: msg.content };
              if (msg.append) return { ...a, content: a.content + msg.append };
              return a;
            }),
          );
          break;
        }
        case 'file_tree_result':
          setFileTree(msg.entries);
          setFilePath(msg.path);
          setFileUnconfigured(!!msg.unconfigured);
          break;
        case 'file_read_result':
          setPreviewFile(msg.path);
          setPreviewContent(msg.content);
          setPreviewTruncated(msg.truncated);
          setPreviewLoading(false);
          setFileError(null);
          break;
        case 'file_error':
          setFileError(msg.message);
          setPreviewLoading(false);
          break;
        case 'settings':
          setWorkspaceRoot(msg.workspaceRoot);
          setEffectiveRoot(msg.effectiveRoot);
          setFileUnconfigured(msg.workspaceRoot === null);
          break;
        case 'dir_list':
          setDirBrowsePath(msg.path);
          setDirBrowseParent(msg.parent);
          setDirBrowseEntries(msg.entries);
          setDirBrowseError(msg.error ?? null);
          setDirIsDrives(Boolean(msg.isDrives));
          break;
        case 'telemetry': {
          const evs = (msg.events ?? []) as BrowserTelemetryEvent[];
          if (evs.length) {
            const errs = evs.filter(
              (e) => e.kind === 'error' || e.kind === 'unhandledrejection' || (e.kind === 'console' && e.level === 'error'),
            ).length;
            const warns = evs.filter((e) => (e.kind === 'console' && e.level === 'warn') || e.kind === 'network').length;
            const head = `🌐 浏览器端上报 ${evs.length} 条记录（错误 ${errs} / 警告·网络 ${warns}）`;
            const lines = evs
              .slice(0, 8)
              .map((e) => `· [${e.kind}${e.level ? ':' + e.level : ''}] ${String(e.message ?? '').slice(0, 160)}`)
              .join('\n');
            setMessages((m) => [
              ...m,
              { id: Date.now() * 1000 + Math.floor(Math.random() * 1000), role: 'system', text: `${head}\n${lines}` },
            ]);
          }
          break;
        }
        case 'exit':
          setConnected(false);
          setMessages((m) => [...m, { id: Date.now(), role: 'system', text: '当前对话已结束。' }]);
          break;
        case 'memory_list':
          setMemories(msg.data);
          setMemLoad(false);
          setMemErr(null);
          break;
        case 'memory_error':
          setMemErr(msg.message);
          setMemLoad(false);
          break;
        case 'trash_list':
          setTrash(msg.data);
          break;
        case 'revise_proposal':
          setRevising(false);
          setReviseProposal(msg.proposal);
          break;
        case 'revise_result':
          setRevising(false);
          setApplying(false);
          setReviseProposal(null);
          setReviseMsg(
            msg.skipped
              ? msg.reason || '本次无需整理'
              : (msg.summary || `记忆体检完成：删除 ${msg.deleted} 条、合并 ${msg.merged} 组。`) +
                  (msg.deleted > 0 || msg.merged > 0 ? '（删除项已进回收站，可在下方恢复）' : ''),
          );
          break;
        case 'memory_promoted': {
          const n = msg.facts + msg.entries;
          setMessages((m) => [
            ...m,
            {
              id: Date.now(),
              role: 'system',
              text:
                n > 0
                  ? `✅ 已从任务「${msg.title}」沉淀 ${msg.facts} 条事实、${msg.entries} 条记忆到你的长期记忆（跨任务共享，可在 🧠 记忆 中查看）。`
                  : `任务「${msg.title}」暂无可沉淀的新记忆（已存在的会跳过，避免重复）。`,
            },
          ]);
          break;
        }
        case 'memory_export': {
          const blob = new Blob([JSON.stringify(msg.bundle, null, 2)], { type: 'application/json' });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          const stamp = new Date().toISOString().slice(0, 10);
          a.href = url;
          a.download = `dsa-memory-${msg.scope}-${stamp}.json`;
          document.body.appendChild(a);
          a.click();
          a.remove();
          URL.revokeObjectURL(url);
          break;
        }
        case 'memory_imported': {
          const n = msg.factsAdded + msg.entriesAdded;
          setMessages((m) => [
            ...m,
            {
              id: Date.now(),
              role: 'system',
              text:
                n > 0
                  ? `✅ 已导入 ${msg.factsAdded} 条事实、${msg.entriesAdded} 条记忆到${msg.scope === 'user' ? '用户级' : '任务级'}（跳过 ${msg.skipped} 条重复）。`
                  : `导入完成：没有新增内容（${msg.skipped} 条与现有记忆重复，已跳过）。`,
            },
          ]);
          break;
        }
      }
    };
    return () => ws.close();
  }, []);

  // 监听滚动：用户主动滚动（wheel/touch/pointer）立即停跟随+置离底；scroll 仅刷新
  // 贴底标志（不重启 follow，避免内容扩张把用户拉回底部）。follow 只在新一轮流式
  // 启动时根据当时是否贴底重置——这样用户一旦主动滚开，整个流式期间都不会被强拉。
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const BOTTOM_THRESHOLD = 20; // 距底 <20px 才算贴底（更严格，避免扩张自动判定贴底）
    const onUserIntent = () => {
      followRef.current = false;
      pinnedRef.current = false; // 立即置离底，RAF 立刻停滚
    };
    const onScroll = () => {
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < BOTTOM_THRESHOLD;
      pinnedRef.current = atBottom;
      // 注意：不在这里把 followRef 拨回 true——否则内容扩张把用户「推」回底部时
      // 会立刻重启自动滚动，让用户无法保持向上查看历史。
    };
    el.addEventListener('wheel', onUserIntent, { passive: true });
    el.addEventListener('touchmove', onUserIntent, { passive: true });
    el.addEventListener('pointerdown', onUserIntent, { passive: true });
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      el.removeEventListener('wheel', onUserIntent);
      el.removeEventListener('touchmove', onUserIntent);
      el.removeEventListener('pointerdown', onUserIntent);
      el.removeEventListener('scroll', onScroll);
    };
  }, []);

  // 消息新增 → 若贴底则滚到底（新用户/助手消息、系统提示等离散事件）。
  useEffect(() => {
    const el = scrollRef.current;
    if (el && pinnedRef.current && followRef.current) el.scrollTop = el.scrollHeight;
  }, [messages]);

  // 流式期间（思考/输出中）用 rAF 持续贴底：逐字揭示靠打字机内部 setState 增长 DOM 高度，
  // 不改 messages，故上面的 [messages] effect 不会触发 → 必须逐帧跟随，否则新内容长到视口下方看不见。
  // 仅在用户贴底时跟随；上滑阅读历史时静默。非流式立即停循环，零常驻开销。
  useEffect(() => {
    if (!state.busy && !outputting) return;
    // 新一轮流式开始：仅当用户已在底部时才自动跟随（不在看历史时强拉）
    followRef.current = pinnedRef.current;
    let raf = 0;
    const tick = () => {
      const el = scrollRef.current;
      // 用户已主动接管（followRef=false）或脱离底部 → 立即停止，交还滚动控制权
      if (el && followRef.current && pinnedRef.current) el.scrollTop = el.scrollHeight;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [state.busy, outputting]);

  useEffect(() => {
    if (view === 'app') {
      // 登录成功后请求一次任务列表
      wsSend(JSON.stringify({ type: 'list_tasks' }));
    }
  }, [view]);

  const send = useCallback((text: string) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'input', text }));
  }, []);

  const onSend = () => {
    const t = input.trim();
    // 有正文、或仅带附件都可发送
    if (!t && pendingAttachments.length === 0) return;
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(
        JSON.stringify({
          type: 'input',
          text: t,
          attachments: pendingAttachments.length ? pendingAttachments : undefined,
        }),
      );
    }
    setInput('');
    setPendingAttachments([]);
    if (isMobile) setMobilePanel('main');
  };

  const onAgentPromptSubmit = (value: boolean | string) => {
    if (!agentPrompt) return;
    if (agentPrompt.mode === 'confirm') {
      wsSend(JSON.stringify({ type: 'confirm', yes: Boolean(value) }));
    } else {
      wsSend(JSON.stringify({ type: 'asktext', text: String(value) }));
    }
    setAgentPrompt(null);
  };

  // 仅开发自测：监听 window.__testAgentPrompt = { prompt, mode } 用于触发浮层预览
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      const d = e.data;
      if (d && d.__dsaTestPrompt) {
        setAgentPrompt({ prompt: String(d.prompt), mode: d.mode === 'asktext' ? 'asktext' : 'confirm' });
      }
    };
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  }, []);

  const onAbort = () => wsSend(JSON.stringify({ type: 'abort' }));

  const runCmd = (cmd: string) => send(cmd);

  /** 上传文档：把前端读好的 base64 文件交给后端保存并通知 agent */
  const onUpload = (name: string, mime: string, data: string) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'upload', name, mime, data }));
    }
  };

  const openSettings = () => {
    setSettingsTab('api');
    setKeyDialog({ open: true, reason: 'change', saving: false });
  };

  const openWorkspaceSettings = () => {
    setSettingsTab('project');
    setKeyDialog({ open: true, reason: 'change', saving: false });
  };

  /** 打开技能底部上拉菜单：同时向后端拉一份最新清单（带过滤状态） */
  const openSkillSheet = () => {
    setSkillSheetOpen(true);
    wsSend(JSON.stringify({ type: 'get_skills' }));
  };
  const closeSkillSheet = () => setSkillSheetOpen(false);
  /** 用户在 SkillSheet 里点选了某个技能：把技能名注入输入框。 */
  const pickSkill = (m: SkillMetaItem) => {
    // 用「@技能名 <光标>」的格式填入，让用户继续描述任务。
    // AI 会从系统提示词的「可用技能」清单中匹配并自动调用 use_skill 工具。
    setSkillInsert(`@${m.name} `);
    setSkillSheetOpen(false);
  };
  const clearSkillInsert = () => setSkillInsert(null);

  // ⌘K 命令面板：收纳既有命令，复用 runCmd / onAbort / openWorkspaceSettings
  const paletteCommands = useMemo<PaletteCommand[]>(
    () => [
      { id: 'mode-ask', group: '模式', title: '任务助理', hint: '/mode ask · 对话与提问', run: () => runCmd('/mode ask') },
      { id: 'mode-explore', group: '模式', title: '研究模式', hint: '/mode explore · 只读探索', run: () => runCmd('/mode explore') },
      { id: 'plan', group: '模式', title: '规划模式（开/关）', hint: '/plan · 先规划再执行', run: () => runCmd('/plan') },
      { id: 'style-human', group: '输出风格', title: '人话', hint: '/style human · 大白话', run: () => runCmd('/style human') },
      { id: 'style-pro', group: '输出风格', title: '专业', hint: '/style professional · 规范术语', run: () => runCmd('/style professional') },
      { id: 'style-raw', group: '输出风格', title: '原始', hint: '/style raw · 不加修饰', run: () => runCmd('/style raw') },
      { id: 'polish', group: '动作', title: '润色', hint: '/polish · 优化最近一次回答', run: () => runCmd('/polish') },
      { id: 'clear', group: '动作', title: '清空对话', hint: '/clear · 清掉当前消息', run: () => runCmd('/clear') },
      { id: 'compact', group: '动作', title: '压缩上下文', hint: '/compact [n] · 摘要旧对话，保留最近 n 轮', run: () => runCmd('/compact') },
      { id: 'watch', group: '动作', title: '浏览器观察回灌', hint: '/watch · 开/关：让 AI 据浏览器报错自动续跑', run: () => runCmd('/watch') },
      { id: 'cost', group: '动作', title: '查看用量', hint: '/cost · token 与费用', run: () => runCmd('/cost') },
      { id: 'skills', group: '动作', title: '列出技能', hint: '/skills list', run: () => runCmd('/skills list') },
      { id: 'memory', group: '动作', title: '查看记忆', hint: '/memory list', run: () => runCmd('/memory list') },
      { id: 'help', group: '动作', title: '帮助', hint: '/help', run: () => runCmd('/help') },
      { id: 'abort', group: '控制', title: '停止生成', hint: '中断当前回答', run: () => onAbort() },
      { id: 'workspace', group: '控制', title: '工作空间设置', hint: '配置项目目录', run: () => openWorkspaceSettings() },
    ],
    [runCmd, onAbort, openWorkspaceSettings],
  );

  // 全局快捷键：⌘K / Ctrl+K 切换命令面板
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const openMemoryTab = () => {
    setSettingsTab('memory');
    setMemErr(null);
    setReviseMsg(null);
    setReviseProposal(null);
    setMemLoad(true);
    setShowTrash(false);
    setKeyDialog({ open: true, reason: 'change', saving: false });
    wsSend(JSON.stringify({ type: 'list_memories' }));
    wsSend(JSON.stringify({ type: 'list_trash' }));
  };

  const closeSettings = () => {
    setKeyDialog({ open: false, reason: 'change', saving: false });
    setSettingsTab('api');
  };

  const requestMemories = () => {
    setMemLoad(true);
    setMemErr(null);
    wsSend(JSON.stringify({ type: 'list_memories' }));
    wsSend(JSON.stringify({ type: 'list_trash' }));
  };

  const delMemory = (scope: 'user' | 'project', id: string) => {
    wsSend(JSON.stringify({ type: 'delete_memory', scope, id }));
  };

  const clearMemories = (scope: 'user' | 'project') => {
    if (!window.confirm('确定清空该作用域的全部语义记忆？删除的记忆会进入回收站，30 天内可恢复。')) return;
    wsSend(JSON.stringify({ type: 'clear_memories', scope }));
  };

  const delFact = (scope: 'user' | 'project', content: string) => {
    wsSend(JSON.stringify({ type: 'delete_fact', scope, content }));
  };

  const restoreMemory = (scope: 'user' | 'project', trashId: string) => {
    wsSend(JSON.stringify({ type: 'restore_memory', scope, trashId }));
  };

  const purgeTrash = (scope?: 'user' | 'project') => {
    const label = scope ? '该作用域的' : '全部';
    if (!window.confirm(`确定永久清空${label}回收站？此操作不可恢复。`)) return;
    wsSend(JSON.stringify({ type: 'purge_trash', ...(scope ? { scope } : {}) }));
  };

  // 「整理记忆」现在分两步：先预览方案（不执行），确认后再应用（删除项进回收站）。
  const previewRevise = () => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    setRevising(true);
    setReviseMsg(null);
    setReviseProposal(null);
    ws.send(JSON.stringify({ type: 'revise_preview' }));
  };

  const applyRevisePlan = () => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    setApplying(true);
    ws.send(JSON.stringify({ type: 'revise_apply' }));
  };

  const cancelRevise = () => {
    setReviseProposal(null);
  };

  const saveKey = () => {
    const apiKey = keyInput.trim();
    if (!apiKey) {
      setKeyDialog((d) => ({ ...d, error: 'API Key 不能为空' }));
      return;
    }
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      setKeyDialog((d) => ({ ...d, error: '连接已断开，请刷新页面后重试' }));
      return;
    }
    setKeyDialog((d) => ({ ...d, saving: true, error: undefined }));
    ws.send(
      JSON.stringify({
        type: 'setkey',
        apiKey,
        baseURL: baseURLInput.trim() || undefined,
        model: modelInput.trim() || undefined,
        reasonerModel: reasonerModelInput.trim() || undefined,
      }),
    );
  };

  const onAuthSubmit = () => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      setAuthErr('连接未就绪，请稍候重试');
      return;
    }
    const u = loginUser.trim();
    const p = loginPass;
    if (!u || !p) {
      setAuthErr('请输入用户名和密码');
      return;
    }
    setAuthErr(null);
    ws.send(JSON.stringify({ type: authMode, username: u, password: p }));
  };

  const onLogout = () => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN && token) {
      ws.send(JSON.stringify({ type: 'logout', token }));
    }
    sessionStorage.removeItem(TOKEN_KEY);
    setToken(null);
    setUsername(null);
    setView('login');
    clearPending();
    setMessages([]);
    setTasks([]);
    setArtifacts([]);
    setLoginUser('');
    setLoginPass('');
  };

  const createTask = () => {
    wsSend(JSON.stringify({ type: 'new_task' }));
    clearPending();
    setMessages([]); // 立即清空对话区，避免残留上一个任务的记录（服务端随后也会发 reset）
    setArtifacts([]);
    if (isMobile) setMobilePanel('main');
  };

  /** 从模板新建任务：把预设的 title + goal 直接发给后端 */
  const createFromTemplate = (key: string) => {
    const tpl = TASK_TEMPLATES.find((t) => t.key === key) ?? TASK_TEMPLATES[0];
    wsSend(JSON.stringify({ type: 'new_task', title: tpl.title, goal: tpl.goal }));
    clearPending();
    setMessages([]);
    setArtifacts([]);
    if (isMobile) setMobilePanel('main');
  };

  /** 复制任务：后端复制 title/goal/status，但新任务从独立空白上下文开始 */
  const duplicateTask = (id: string) => {
    wsSend(JSON.stringify({ type: 'duplicate_task', id }));
    clearPending();
    setMessages([]);
    setArtifacts([]);
    if (isMobile) setMobilePanel('main');
  };

  /** 拖拽排序：记录被拖动的源 id */
  const onDragStartTask = (id: string) => {
    dragIdRef.current = id;
  };

  /** 拖拽落点：把源任务移动到目标位置，按完整顺序回传后端重写权重 */
  const onDropTask = (targetId: string) => {
    const from = dragIdRef.current;
    dragIdRef.current = null;
    if (!from || from === targetId) return;
    const order = tasks.map((t) => t.id);
    const fi = order.indexOf(from);
    const ti = order.indexOf(targetId);
    if (fi < 0 || ti < 0) return;
    order.splice(fi, 1);
    order.splice(ti, 0, from);
    wsSend(JSON.stringify({ type: 'reorder_tasks', ids: order }));
  };

  const onPolish = () => {
    const txt = input.trim();
    if (!txt || state.busy) return;
    setPolishLoading(true);
    wsSend(JSON.stringify({ type: 'polish_input', text: txt }));
  };

  const switchTask = (id: string) => {
    // 前端消息+思考过程缓存：命中则秒切（无白屏/加载延迟），否则清空等后端推送
    const cached = messagesCacheRef.current.get(id);
    if (cached && cached.messages.length > 0) {
      setMessages(cached.messages);
      setThinkings(cached.thinkings);
      setOutputting(false);
    } else {
      setMessages([]);
      setThinkings([]);
    }
    clearPending(); // 切走旧任务的窗口内增量，避免串到新任务
    activeTaskIdRef.current = id;
    setArtifacts([]);
    if (isMobile) setMobilePanel('main');
    wsSend(JSON.stringify({ type: 'switch_task', id }));
  };

  const deleteTask = (id: string) => {
    const t = tasks.find((x) => x.id === id);
    if (!t) return;
    setDeleteDialog({ open: true, id, title: t.title || t.id, isActive: !!t.active });
  };

  /** 弹框确认后执行真正的删除 */
  const confirmDeleteTask = () => {
    const id = deleteDialog.id;
    setDeleteDialog((d) => ({ ...d, open: false }));
    messagesCacheRef.current.delete(id);
    if (activeTaskIdRef.current === id) activeTaskIdRef.current = null;
    wsSend(JSON.stringify({ type: 'delete_task', id }));
  };

  /** 切换任务状态（进行中/已暂停/已完成循环） */
  const cycleTaskStatus = (id: string, cur: TaskStatus) => {
    const next: TaskStatus = cur === 'active' ? 'paused' : cur === 'paused' ? 'done' : 'active';
    wsSend(JSON.stringify({ type: 'update_task', id, status: next }));
  };

  /** 任务记忆沉淀：把该任务的记忆提升到用户级长期记忆（跨任务共享） */
  const promoteTask = (id: string) => {
    wsSend(JSON.stringify({ type: 'promote_task_memory', taskId: id }));
  };

  /** 导出某作用域记忆为 JSON 文件（后端返回 bundle，前端触发下载） */
  const exportMemory = (scope: 'user' | 'project') => {
    wsSend(JSON.stringify({ type: 'export_memory', scope }));
  };

  /** 导入记忆：打开文件选择，读取后发给后端合并写入目标作用域 */
  const importMemory = (scope: 'user' | 'project') => {
    setPendingImportScope(scope);
    fileInputRef.current?.click();
  };

  const onImportFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    const scope = pendingImportScope;
    setPendingImportScope(null);
    if (!file || !scope) return;
    try {
      const text = await file.text();
      const bundle = JSON.parse(text);
      wsSend(JSON.stringify({ type: 'import_memory', scope, bundle }));
    } catch (err) {
      setMemErr('导入文件解析失败：' + (err instanceof Error ? err.message : '格式错误'));
    }
  };

  const filteredTasks = useMemo(() => {
    const q = taskSearch.trim().toLowerCase();
    if (!q) return tasks;
    return tasks.filter(
      (s) => s.title.toLowerCase().includes(q) || (s.goal ?? '').toLowerCase().includes(q),
    );
  }, [tasks, taskSearch]);

  /** 当前激活任务名（用于 chat-module 标题展示） */
  const activeTitle = useMemo(() => tasks.find((s) => s.active)?.title ?? '新对话', [tasks]);

  const KEY_TITLE: Record<KeyDialog['reason'], string> = {
    missing: '配置 DeepSeek API Key',
    invalid: 'API Key 无效，请重新配置',
    change: '更换 DeepSeek API Key',
  };

  // ── 登录 / 注册页 ──
  if (view === 'login') {
    return (
      <div className="login-wrap">
        <div className="login-card">
          <div className="brand login-brand">
            <img src="/logo.png" className="logo" alt="DeepSeek Agent" />
            <span className="title">DeepSeek Agent</span>
          </div>
          <div className="tabs">
            <button
              className={`tab ${authMode === 'login' ? 'active' : ''}`}
              onClick={() => {
                setAuthMode('login');
                setAuthErr(null);
              }}
            >
              登录
            </button>
            <button
              className={`tab ${authMode === 'register' ? 'active' : ''}`}
              onClick={() => {
                setAuthMode('register');
                setAuthErr(null);
              }}
            >
              注册
            </button>
          </div>
          {authErr && <div className="modal-error">{authErr}</div>}
          <form
            className="login-form"
            onSubmit={(e) => {
              e.preventDefault();
              onAuthSubmit();
            }}
          >
            <label className="field">
              <span>用户名</span>
              <input
                value={loginUser}
                autoFocus
                placeholder="3-32 位字母/数字/下划线"
                onChange={(e) => setLoginUser(e.target.value)}
              />
            </label>
            <label className="field">
              <span>密码</span>
              <input
                type="password"
                value={loginPass}
                placeholder="至少 6 位"
                onChange={(e) => setLoginPass(e.target.value)}
              />
            </label>
            <button type="submit" className="primary login-btn">
              {authMode === 'login' ? '登录' : '注册并登录'}
            </button>
          </form>
          <p className="login-hint">
            账号仅保存在本机，用于区分你的任务与设置。登录后可在「设置」里配置 DeepSeek API Key，不强制立即填写。
          </p>
        </div>
      </div>
    );
  }

  // ── 三栏式聊天页 ──
  const leftClass = `sidebar left ${leftOpen ? 'open' : 'closed'} ${isMobile && mobilePanel !== 'left' ? 'hidden-mobile' : ''} ${isMobile && mobilePanel === 'left' ? 'mobile-open' : ''}`;
  const rightClass = `sidebar right ${rightOpen ? 'open' : 'closed'} ${isMobile && mobilePanel !== 'right' ? 'hidden-mobile' : ''} ${isMobile && mobilePanel === 'right' ? 'mobile-open' : ''}`;
  const mainClass = `main ${isMobile && mobilePanel !== 'main' ? 'hidden-mobile' : ''}`;

  return (
    <div className="layout">
      {/* 顶行 product-bar：横跨任务区 / 主区 / 工作空间三个区域之上（行高极简） */}
      <header className="product-bar">
        <div className="product-bar-left">
          <div className="brand">
            <img src="/logo.png" className="logo" alt="DeepSeek Agent" />
            <span className="title">DeepSeek Agent</span>
            <span className={`dot ${connected ? 'on' : 'off'}`} title={connected ? '已连接' : '未连接'} />
          </div>
        </div>
        <div className="product-bar-right">
          <button className="tool-btn" onClick={openSettings} title="设置（API Key / 工作空间 / 记忆）">
            <span className="tb-glyph" aria-hidden>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
              </svg>
            </span>
            <span>设置</span>
          </button>
        </div>
      </header>

      <div className="layout-row">
      {/* 左侧栏：任务区 */}
      <aside className={leftClass}>
        <div className="sidebar-header">
          <span className="sidebar-title">任务区</span>
          <div className="sidebar-header-actions">
            {/* 模板新建下拉（与原行为一致） */}
            <select
              className="task-template"
              value=""
              onChange={(e) => {
                if (e.target.value) createFromTemplate(e.target.value);
                e.target.value = '';
              }}
              title="从模板新建任务"
            >
              <option value="">模板…</option>
              {TASK_TEMPLATES.filter((t) => t.key !== 'blank').map((t) => (
                <option key={t.key} value={t.key}>
                  {t.label}
                </option>
              ))}
            </select>
            <button className="icon-btn" onClick={() => createFromTemplate('blank')} title="新建空白任务">
              ＋
            </button>
            {/* 「任务区右上方」的折叠按钮：把这一栏整条收起来 */}
            <button
              className="icon-btn panel-collapse"
              onClick={() => setLeftOpen(false)}
              title="收起任务区"
              aria-label="收起任务区"
            >
              <ChevronLeft size={14} />
            </button>
          </div>
        </div>
        <div className="sidebar-search">
          <input
            value={taskSearch}
            onChange={(e) => setTaskSearch(e.target.value)}
            placeholder="搜索任务或目标…"
          />
        </div>
        <div className="task-list">
          {filteredTasks.length === 0 && (
            <div className="empty-sidebar">{taskSearch ? '无匹配任务' : '暂无任务，点击 ＋ 新建'}</div>
          )}
          {filteredTasks.map((t) => (
            <TaskCard
              key={t.id}
              task={t}
              busy={state.busy}
              onSwitch={switchTask}
              onDelete={deleteTask}
              onCycleStatus={cycleTaskStatus}
              onDuplicate={duplicateTask}
              onPromote={promoteTask}
              onDragStart={onDragStartTask}
              onDrop={onDropTask}
            />
          ))}
        </div>
        {/* 任务区底部：用户头像 + 用户名 + 登出（主题切换也合并到这里，腾出顶栏） */}
        <div className="user-block">
          <span className="user-block-avatar" aria-hidden>
            {(username ?? '?').slice(0, 1).toUpperCase()}
          </span>
          <div className="user-block-info">
            <span className="user-block-name" title={username ?? ''}>
              {username ? `@${username}` : '未登录'}
            </span>
          </div>
          <button
            className="user-block-icon"
            onClick={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
            title={theme === 'dark' ? '切换到浅色模式' : '切换到深色模式'}
            aria-label="切换主题"
          >
            <span className="tb-glyph" aria-hidden>
              {theme === 'dark' ? (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="4" />
                  <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
                </svg>
              ) : (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
                </svg>
              )}
            </span>
          </button>
          <button className="user-block-logout" onClick={onLogout} title="退出登录" aria-label="退出登录">
            登出
          </button>
        </div>
      </aside>

      {/* 中间主区域：对话（外层用 .main 作为灰底，最内层 .chat-module 白底卡片） */}
      <main className={mainClass}>
        {/* 主区左上方：任务区关闭后，这里提供一个「展开任务区」入口（贴在主区最左缘） */}
        {!leftOpen && (
          <button
            className="edge-toggle edge-left"
            onClick={() => setLeftOpen(true)}
            title="展开任务区"
            aria-label="展开任务区"
          >
            <span aria-hidden><ChevronRight size={14} /></span>
          </button>
        )}
        {/* 主区右上方：工作空间关闭后，这里提供一个「展开文件面板」入口（贴在主区最右缘） */}
        {!rightOpen && (
          <button
            className="edge-toggle edge-right"
            onClick={() => setRightOpen(true)}
            title="展开文件面板"
            aria-label="展开文件面板"
          >
            <span aria-hidden><ChevronLeft size={14} /></span>
          </button>
        )}

        {/* 整体聊天模块：标题 + 快捷功能栏 + 对话框 + 输入框，四件套包成一张白卡 */}
        <div className="chat-module">
          <div className="chat-module-header">
            <div className="chat-module-title" title={activeTitle}>
              <span className="chat-module-title-glyph" aria-hidden><MessageSquare size={14} /></span>
              <span className="chat-module-title-text">{activeTitle}</span>
            </div>
            {/* 快捷功能栏：目前为占位（功能未上线），等设计稿 / 后续接入再激活 */}
            <div className="chat-module-actions" role="toolbar" aria-label="快捷功能（占位）">
              <button
                type="button"
                className="quick-action"
                disabled
                title="快捷功能占位 · 暂未启用"
                aria-label="快捷功能占位"
              >
                <span aria-hidden><Share2 size={14} /></span>
                <span>分享</span>
              </button>
              <button
                type="button"
                className="quick-action"
                disabled
                title="快捷功能占位 · 暂未启用"
                aria-label="快捷功能占位"
              >
                <span aria-hidden><Bookmark size={14} /></span>
                <span>标记</span>
              </button>
              <button
                type="button"
                className="quick-action"
                disabled
                title="快捷功能占位 · 暂未启用"
                aria-label="快捷功能占位"
              >
                <span aria-hidden><Ellipsis size={14} /></span>
                <span>更多</span>
              </button>
            </div>
          </div>

          {loadingBoot && (
            <div className="boot-loading">
              <span className="boot-spinner" aria-hidden />
              <span className="boot-text">正在加载历史对话…</span>
            </div>
          )}
          <div className="chat-module-body">
            <ChatArea ref={scrollRef} messages={messages} busy={state.busy} outputting={outputting} thinkings={thinkings} onToggleThinking={toggleThinking} username={username} />

            {agentPrompt && (
              <AgentPrompt
                prompt={agentPrompt.prompt}
                mode={agentPrompt.mode}
                label={agentPrompt.mode === 'confirm' ? '权限确认' : '智能体询问'}
                onSubmit={onAgentPromptSubmit}
              />
            )}

            <Composer
              input={input}
              setInput={setInput}
              onSend={onSend}
              busy={state.busy}
              mode={state.mode}
              planMode={state.planMode}
              outputStyle={state.outputStyle}
              runCmd={runCmd}
              onAbort={onAbort}
              openWorkspaceSettings={openWorkspaceSettings}
              openSkillSheet={openSkillSheet}
              onUpload={onUpload}
              attachments={pendingAttachments}
              onRemoveAttachment={(i: number) =>
                setPendingAttachments((prev) => prev.filter((_, idx) => idx !== i))
              }
              skillInsert={skillInsert}
              onSkillInserted={clearSkillInsert}
              onPolish={onPolish}
              polishLoading={polishLoading}
              currentIteration={state.currentIteration}
              maxIterations={state.maxIterations}
              onSetLimit={onSetLimit}
              browserWatch={state.browserWatch}
            />
          </div>
        </div>
      </main>

      {/* 技能底部上拉菜单（独立于三栏，浮在屏幕底部） */}
      <SkillSheet
        open={skillSheetOpen}
        metas={skillMetas}
        filter={skillFilter}
        onClose={closeSkillSheet}
        onPick={pickSkill}
      />

      {/* 右侧栏：文件资源 / 代码预览（只读） */}
      <aside className={rightClass}>
        <div className="sidebar-header workspace-header">
          {/* 「工作空间左上方」的折叠按钮：放在标题左侧，紧贴主区边界 */}
          <button
            className="icon-btn panel-collapse"
            onClick={() => setRightOpen(false)}
            title="收起文件面板"
            aria-label="收起文件面板"
          >
            <ChevronRight size={14} />
          </button>
          <span className="sidebar-title" title={workspaceRoot ?? effectiveRoot ?? undefined}>
            文件资源{workspaceRoot ? ` · ${workspaceRoot.split(/[\\/]/).pop()}` : ''}
          </span>
          <div className="sidebar-header-actions">
            <button className="icon-btn" onClick={() => loadFileTree('')} title="回到工作空间根目录">
              🏠
            </button>
          </div>
        </div>
        <div className="file-breadcrumb">
          <span className="file-crumb root" onClick={() => loadFileTree('')} title={workspaceRoot ?? effectiveRoot ?? undefined}>
            {workspaceRoot ? workspaceRoot.split(/[\\/]/).pop() : '工作空间根'}
          </span>
          {filePath
            .split('/')
            .filter(Boolean)
            .map((seg, i, arr) => {
              const rel = arr.slice(0, i + 1).join('/');
              return (
                <span key={rel} className="file-crumb" onClick={() => loadFileTree(rel)}>
                  <span className="file-crumb-sep">/</span>
                  {seg}
                </span>
              );
            })}
        </div>
        {previewFile ? (
          <div className="file-preview">
            <div className="file-preview-head">
              <span className="file-preview-name" title={previewFile}>
                {previewFile.split('/').pop()}
              </span>
              <button className="link-btn" onClick={() => { setPreviewFile(null); setPreviewContent(''); }}>
                ← 列表
              </button>
            </div>
            {previewLoading && (
              <div className="file-skeleton" aria-busy="true" aria-label="读取中">
                <span /><span /><span /><span /><span />
              </div>
            )}
            {fileError && <div className="file-error">⚠ {fileError}</div>}
            {!previewLoading && !fileError && (
              <pre className="code-view">
                {previewContent.split('\n').map((line, i) => (
                  <div key={i} className="code-line">
                    <span className="code-ln">{i + 1}</span>
                    <span className="code-text">{line || ' '}</span>
                  </div>
                ))}
              </pre>
            )}
            {previewTruncated && <div className="file-note">（文件较大，仅预览前 200KB）</div>}
          </div>
        ) : (
          <div className="file-list">
            {fileUnconfigured || workspaceRoot === null ? (
              <div className="empty-sidebar project-prompt">
                <div className="project-prompt-emoji">📁</div>
                <div className="project-prompt-title">尚未指定工作空间</div>
                <div className="project-prompt-desc">
                  文件面板与 agent 工作区都需要一个「你正在用 DeepSeek 编程的项目（工作空间）」。<br />
                  未设置时不会显示任何内容（也不会暴露工具自身源码）；对话中 agent 也会主动询问你选择。
                </div>
                <button className="primary" onClick={() => { setSettingsTab('project'); setKeyDialog({ open: true, reason: 'change', saving: false }); }}>
                  去设置工作空间
                </button>
              </div>
            ) : (
              fileTree.length === 0 && <div className="empty-sidebar">空目录</div>
            )}
            {fileTree.map((e) => (
              <div
                key={e.name}
                className={`file-item ${e.type}`}
                onClick={() =>
                  e.type === 'dir'
                    ? loadFileTree(filePath ? `${filePath}/${e.name}` : e.name)
                    : openFile(filePath ? `${filePath}/${e.name}` : e.name)
                }
              >
                <span className="file-icon">{e.type === 'dir' ? '📁' : '📄'}</span>
                <span className="file-name">{e.name}</span>
                {e.type === 'file' && <span className="file-size">{formatSize(e.size)}</span>}
              </div>
            ))}
          </div>
        )}
      </aside>
      </div>{/* /.layout-row */}

      {/* 移动端底部 tab */}
      {isMobile && (
        <nav className="mobile-tabs">
          <button className={mobilePanel === 'left' ? 'active' : ''} onClick={() => setMobilePanel('left')}>
            任务
          </button>
          <button className={mobilePanel === 'main' ? 'active' : ''} onClick={() => setMobilePanel('main')}>
            对话
          </button>
          <button className={mobilePanel === 'right' ? 'active' : ''} onClick={() => setMobilePanel('right')}>
            文件
          </button>
        </nav>
      )}

      {/* 设置浮层（API Key / 记忆 双标签） */}
      {keyDialog.open && (
        <div className="modal-backdrop">
          <div className="modal">
            <div className="modal-tabs">
              <button
                className={`modal-tab ${settingsTab === 'api' ? 'active' : ''}`}
                onClick={() => setSettingsTab('api')}
              >
                API Key
              </button>
              <button
                className={`modal-tab ${settingsTab === 'memory' ? 'active' : ''}`}
                onClick={() => {
                  setSettingsTab('memory');
                  requestMemories();
                }}
              >
                🧠 记忆
              </button>
              <button
                className={`modal-tab ${settingsTab === 'project' ? 'active' : ''}`}
                onClick={() => setSettingsTab('project')}
              >
                📂 工作空间
              </button>
              <button className="modal-close" onClick={closeSettings} title="关闭">
                ×
              </button>
            </div>

            {settingsTab === 'api' ? (
              <>
                <h3>{KEY_TITLE[keyDialog.reason]}</h3>
                <p className="modal-hint">
                  本产品采用「自带密钥」（BYOK）方式：填入你自己的 DeepSeek API Key 即可使用，Key 仅保存在本机你的账号目录下，
                  不会上传到任何第三方。没有 Key？前往{' '}
                  <a href="https://platform.deepseek.com/api_keys" target="_blank" rel="noopener noreferrer">
                    DeepSeek 开放平台
                  </a>{' '}
                  免费申请。
                </p>
                {keyDialog.error && <div className="modal-error">⚠ {keyDialog.error}</div>}
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    saveKey();
                  }}
                >
                  <label className="field">
                    <span>API Key</span>
                    <input
                      type="password"
                      autoFocus
                      value={keyInput}
                      placeholder="sk-..."
                      onChange={(e) => setKeyInput(e.target.value)}
                    />
                  </label>

                  <button type="button" className="link-btn" onClick={() => setShowAdvanced((v) => !v)}>
                    {showAdvanced ? '收起高级设置 ▲' : '高级设置（自定义 baseURL / 主模型 / 推理模型）▼'}
                  </button>
                  {showAdvanced && (
                    <>
                      <label className="field">
                        <span>Base URL（可选）</span>
                        <input
                          value={baseURLInput}
                          placeholder="https://api.deepseek.com"
                          onChange={(e) => setBaseURLInput(e.target.value)}
                        />
                      </label>
                      <label className="field">
                        <span>主模型（可选，默认 v4-flash）</span>
                        <input
                          value={modelInput}
                          placeholder="deepseek-v4-flash"
                          onChange={(e) => setModelInput(e.target.value)}
                        />
                      </label>
                      <label className="field">
                        <span>推理模型（可选，默认 v4-pro）</span>
                        <input
                          value={reasonerModelInput}
                          placeholder="deepseek-v4-pro"
                          onChange={(e) => setReasonerModelInput(e.target.value)}
                        />
                      </label>
                    </>
                  )}

                  <div className="modal-actions">
                    {keyDialog.reason === 'change' && (
                      <button type="button" className="ghost" onClick={closeSettings}>
                        取消
                      </button>
                    )}
                    <button type="submit" className="primary" disabled={keyDialog.saving}>
                      {keyDialog.saving ? '校验中…' : '保存并启用'}
                    </button>
                  </div>
                </form>
              </>
            ) : settingsTab === 'project' ? (
              <>
                <h3>工作空间</h3>
                <p className="modal-hint">
                  这里设置「你正在用 DeepSeek 编程的项目」所在的文件夹（工作空间）。设置后，右侧文件面板会浏览该工作空间，
                  agent 也会在该目录里读写代码（每任务的对话/记忆仍各自隔离，不受影响）。留空时，对话中 agent 会主动询问你选择。
                </p>
                <label className="field">
                  <span>当前工作空间</span>
                  <input
                    type="text"
                    readOnly
                    value={workspaceRoot ?? ''}
                    placeholder={effectiveRoot ? `（未设置，当前为：${effectiveRoot}）` : '（未设置）'}
                  />
                </label>
                <div className="modal-actions">
                  <button className="primary" onClick={openDirPicker}>
                    📂 选择文件夹…
                  </button>
                  {workspaceRoot && (
                    <button
                      className="ghost"
                      onClick={() => {
                        wsSend(JSON.stringify({ type: 'set_settings', workspaceRoot: null }));
                        loadFileTree('');
                      }}
                    >
                      清除
                    </button>
                  )}
                </div>
              </>
            ) : (
              <MemoryPanel
                data={memories}
                loading={memLoad}
                error={memErr}
                revising={revising}
                applying={applying}
                reviseMsg={reviseMsg}
                proposal={reviseProposal}
                trash={trash}
                showTrash={showTrash}
                onToggleTrash={() => setShowTrash((v) => !v)}
                onRestore={restoreMemory}
                onPurgeTrash={purgeTrash}
                onPreview={previewRevise}
                onApply={applyRevisePlan}
                onCancelProposal={cancelRevise}
                onDeleteEntry={delMemory}
                onClear={clearMemories}
                onDeleteFact={delFact}
                onRefresh={requestMemories}
                onExport={exportMemory}
                onImport={importMemory}
              />
            )}
          </div>
        </div>
      )}

      {/* 任务删除确认弹框（替代原生 window.confirm） */}
      {deleteDialog.open && (
        <div
          className="modal-backdrop"
          onClick={(e) => {
            if (e.target === e.currentTarget) setDeleteDialog((d) => ({ ...d, open: false }));
          }}
        >
          <div className="modal confirm-modal" role="alertdialog" aria-modal="true" aria-labelledby="del-title">
            <div className="modal-tabs">
              <span className="modal-tab active">删除任务</span>
              <button className="modal-close" onClick={() => setDeleteDialog((d) => ({ ...d, open: false }))} title="关闭">
                ×
              </button>
            </div>
            <h3 id="del-title" className="confirm-title">
              确定要删除任务「{deleteDialog.title}」吗？
            </h3>
            <p className="modal-hint">
              此操作不可恢复，任务的对话、记忆与历史将被一并清除。
              {deleteDialog.isActive && (
                <span className="confirm-warn"> 这是当前正在使用的任务，删除后会自动切换到下一个任务。</span>
              )}
            </p>
            <div className="modal-actions">
              <button className="ghost" onClick={() => setDeleteDialog((d) => ({ ...d, open: false }))}>
                取消
              </button>
              <button className="danger" onClick={confirmDeleteTask} autoFocus>
                确认删除
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 目录选择器：在本机任意位置导航，选定「工作空间」 */}
      {showDirPicker && (
        <div className="modal-backdrop">
          <div className="modal dir-picker">
            <div className="modal-tabs">
              <span className="modal-tab active">选择工作空间文件夹</span>
              <button className="modal-close" onClick={() => setShowDirPicker(false)} title="关闭">
                ×
              </button>
            </div>
            <p className="modal-hint">在下方导航到你正在编程的工作空间根目录，然后点「选择此目录」。</p>
            <div className="dir-bar">
              <div className="dir-current" title={dirBrowsePath}>
                当前位置：<code>{dirIsDrives ? '此电脑（所有磁盘）' : (dirBrowsePath || '（加载中…）')}</code>
              </div>
              <button
                type="button"
                className="dir-pc"
                onClick={() => requestDirBrowse('::DRIVES::')}
                title="查看本机所有磁盘"
              >
                <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden>
                  <rect x="2" y="2.5" width="12" height="11" rx="2" fill="none" stroke="currentColor" strokeWidth="1.3" />
                  <circle cx="8" cy="8" r="2.1" fill="none" stroke="currentColor" strokeWidth="1.3" />
                  <circle cx="8" cy="8" r="0.7" fill="currentColor" />
                </svg>
                此电脑
              </button>
            </div>
            {dirBrowseParent && (
              <button className="dir-up" onClick={() => requestDirBrowse(dirBrowseParent)}>
                <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden>
                  <path d="M8 3.5v9M4.5 7L8 3.5 11.5 7" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                上一级
              </button>
            )}
            {dirBrowseError && <div className="modal-error">⚠ {dirBrowseError}</div>}
            <div className="dir-list">
              {dirBrowseEntries.length === 0 && !dirBrowseError && (
                <div className="dir-empty">（无子目录）</div>
              )}
              {dirBrowseEntries.map((e) => (
                <div
                  key={e.name}
                  className="dir-item"
                  onClick={() => requestDirBrowse(dirIsDrives ? e.name : `${dirBrowsePath}/${e.name}`)}
                >
                  {e.type === 'drive' ? (
                    <svg className="dir-ico" width="16" height="16" viewBox="0 0 16 16" aria-hidden>
                      <rect x="2" y="2.5" width="12" height="11" rx="2" fill="none" stroke="currentColor" strokeWidth="1.3" />
                      <circle cx="8" cy="8" r="2.1" fill="none" stroke="currentColor" strokeWidth="1.3" />
                      <circle cx="8" cy="8" r="0.7" fill="currentColor" />
                    </svg>
                  ) : (
                    <svg className="dir-ico" width="16" height="16" viewBox="0 0 16 16" aria-hidden>
                      <path d="M1.5 4h5l1.6 1.6h6.4v7.4H1.5z" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
                    </svg>
                  )}
                  <span className="dir-name">{e.name}</span>
                </div>
              ))}
            </div>
            <div className="modal-actions">
              <button className="ghost" onClick={() => setShowDirPicker(false)}>
                取消
              </button>
              <button
                className="primary"
                onClick={() => selectWorkspaceDir(dirBrowsePath)}
                disabled={dirIsDrives}
                title={dirIsDrives ? '请先进入某个磁盘再选择文件夹' : undefined}
              >
                选择此目录
              </button>
            </div>
          </div>
        </div>
      )}
      {/* 记忆导入用的隐藏文件选择器 */}
      <input
        type="file"
        accept="application/json,.json"
        ref={fileInputRef}
        style={{ display: 'none' }}
        onChange={onImportFile}
      />
      {paletteOpen && (
        <CommandPalette commands={paletteCommands} onClose={() => setPaletteOpen(false)} />
      )}
    </div>
  );
}

/** 任务卡片：任务区每一项。展示标题 / 状态徽章（可点击切换）/ 隔离标识 / 复制 / 删除。可拖拽排序。
 * 「进行中」状态由模型是否正在工作（busy，仅对当前活跃任务生效）决定，而非任务存储的状态字段。 */
function TaskCard(props: {
  task: TaskItem;
  busy: boolean;
  onSwitch: (id: string) => void;
  onDelete: (id: string) => void;
  onCycleStatus: (id: string, cur: TaskStatus) => void;
  onDuplicate: (id: string) => void;
  onPromote: (id: string) => void;
  onDragStart: (id: string) => void;
  onDrop: (id: string) => void;
}) {
  const { task, busy, onSwitch, onDelete, onCycleStatus, onDuplicate, onPromote, onDragStart, onDrop } = props;
  const [hover, setHover] = useState(false);
  const statusLabel: Record<TaskStatus, string> = { active: '就绪', paused: '已暂停', done: '已完成' };
  // 「进行中」：当前任务是活跃任务、状态为 active、且模型正在工作（busy）时才显示
  const working = busy && task.active && task.status === 'active';
  const statusText = working ? '进行中' : statusLabel[task.status];
  const statusClass = working ? 'st-active working' : `st-${task.status}`;
  return (
    <div
      className={`task-item ${task.active ? 'active' : ''} ${hover ? 'dragover' : ''}`}
      draggable
      onClick={() => onSwitch(task.id)}
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = 'move';
        onDragStart(task.id);
        setHover(false);
      }}
      onDragOver={(e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        if (!hover) setHover(true);
      }}
      onDragLeave={() => setHover(false)}
      onDrop={(e) => {
        e.preventDefault();
        setHover(false);
        onDrop(task.id);
      }}
    >
      <div className="task-top">
        <span className="task-title" title={task.title}>
          {task.title}
        </span>
        <button
          className={`task-status ${statusClass}`}
          title={working ? '模型正在工作…' : '点击切换：就绪 / 已暂停 / 已完成'}
          onClick={(e) => {
            e.stopPropagation();
            onCycleStatus(task.id, task.status);
          }}
        >
          {statusText}
        </button>
      </div>
      <div className="task-meta">
        <span>{formatTime(task.updatedAt)}</span>
        <span className="task-meta-actions">
          <span className="task-iso" title="独立上下文：该任务的对话、记忆与历史彼此隔离，互不干扰">
            🔒 独立
          </span>
          <button
            className="task-copy"
            title="复制任务（独立上下文）"
            onClick={(e) => {
              e.stopPropagation();
              onDuplicate(task.id);
            }}
          >
            📋
          </button>
          <button
            className="task-promote"
            title="把本任务记忆沉淀到长期记忆（跨任务共享）"
            onClick={(e) => {
              e.stopPropagation();
              onPromote(task.id);
            }}
          >
            ↑沉淀
          </button>
          <button
            className="task-delete"
            onClick={(e) => {
              e.stopPropagation();
              onDelete(task.id);
            }}
            title={task.active ? '删除（当前任务，删除后将自动切到下一个）' : '删除'}
          >
            🗑
          </button>
        </span>
      </div>
    </div>
  );
}

/** 记忆管理面板：查看 / 删除单条 / 清空 / 整理（陈旧性治理），按用户级与任务级分栏 */
function MemoryPanel(props: {
  data: MemoryListData | null;
  loading: boolean;
  error: string | null;
  revising: boolean;
  applying: boolean;
  reviseMsg: string | null;
  proposal: ReviseProposalData | null;
  trash: TrashListData | null;
  showTrash: boolean;
  onToggleTrash: () => void;
  onRestore: (scope: 'user' | 'project', trashId: string) => void;
  onPurgeTrash: (scope?: 'user' | 'project') => void;
  onPreview: () => void;
  onApply: () => void;
  onCancelProposal: () => void;
  onDeleteEntry: (scope: 'user' | 'project', id: string) => void;
  onClear: (scope: 'user' | 'project') => void;
  onDeleteFact: (scope: 'user' | 'project', content: string) => void;
  onRefresh: () => void;
  onExport: (scope: 'user' | 'project') => void;
  onImport: (scope: 'user' | 'project') => void;
}) {
  const {
    data,
    loading,
    error,
    revising,
    applying,
    reviseMsg,
    proposal,
    trash,
    showTrash,
    onToggleTrash,
    onRestore,
    onPurgeTrash,
    onPreview,
    onApply,
    onCancelProposal,
    onDeleteEntry,
    onClear,
    onDeleteFact,
    onRefresh,
    onExport,
    onImport,
  } = props;
  const scopes: Array<{ key: 'user' | 'project'; label: string; hint: string }> = [
    { key: 'user', label: '用户级（全局共享）', hint: '跨所有任务生效，记录你的长期偏好' },
    { key: 'project', label: '任务级（当前任务）', hint: '仅当前任务有效，记录本次任务的约定与进展' },
  ];
  const trashTotal = (trash?.user.length ?? 0) + (trash?.project.length ?? 0);

  // 预览清单的搜索 / 作用域筛选（仅影响展示，不改变「应用」的完整方案）
  const [planQuery, setPlanQuery] = useState('');
  const [planScope, setPlanScope] = useState<'all' | 'user' | 'project'>('all');
  // 每次收到新提案时重置筛选条件
  useEffect(() => {
    setPlanQuery('');
    setPlanScope('all');
  }, [proposal]);
  const visibleActions = useMemo(() => {
    if (!proposal) return [];
    const q = planQuery.trim().toLowerCase();
    return proposal.actions.filter((a) => {
      if (planScope !== 'all' && a.scope !== planScope) return false;
      if (!q) return true;
      return (
        a.content.toLowerCase().includes(q) ||
        (a.target ?? '').toLowerCase().includes(q) ||
        (a.reason ?? '').toLowerCase().includes(q)
      );
    });
  }, [proposal, planQuery, planScope]);

  // 「已保存记忆」搜索（按常驻事实 / 语义记忆内容与标签过滤，跨用户级+项目级）
  const [memQuery, setMemQuery] = useState('');
  const memFiltered = useMemo(() => {
    const q = memQuery.trim().toLowerCase();
    const pick = (d: { facts: string[]; entries: MemoryEntry[] }) => ({
      facts: q ? d.facts.filter((f) => f.toLowerCase().includes(q)) : d.facts,
      entries: q
        ? d.entries.filter(
            (e) =>
              e.content.toLowerCase().includes(q) ||
              (e.tags ?? []).some((t) => t.toLowerCase().includes(q)),
          )
        : d.entries,
    });
    const user = pick(data?.user ?? { facts: [], entries: [] });
    const project = pick(data?.project ?? { facts: [], entries: [] });
    const shown = user.facts.length + user.entries.length + project.facts.length + project.entries.length;
    const total =
      (data?.user.facts.length ?? 0) +
      (data?.user.entries.length ?? 0) +
      (data?.project.facts.length ?? 0) +
      (data?.project.entries.length ?? 0);
    return { user, project, shown, total };
  }, [data, memQuery]);

  // 「回收站」搜索（按删除项的事实 / 记忆内容过滤，跨用户级+项目级）
  const [trashQuery, setTrashQuery] = useState('');
  const trashFiltered = useMemo(() => {
    const q = trashQuery.trim().toLowerCase();
    const pick = (items: TrashItem[]) =>
      q
        ? items.filter((it) =>
            (it.kind === 'fact' ? it.fact ?? '' : it.entry?.content ?? '').toLowerCase().includes(q),
          )
        : items;
    const user = pick(trash?.user ?? []);
    const project = pick(trash?.project ?? []);
    return { user, project, shown: user.length + project.length };
  }, [trash, trashQuery]);

  return (
    <div className="memory-panel">
      <div className="memory-head">
        <h3>记忆管理</h3>
        <div className="memory-head-actions">
          <button className="link-btn" onClick={onRefresh} disabled={loading}>
            ↻ 刷新
          </button>
          <button className="revise-btn" onClick={onPreview} disabled={revising || applying}>
            {revising ? '体检中…' : '🧹 整理记忆'}
          </button>
        </div>
      </div>
      <p className="modal-hint">
        这里列出 Agent 自动沉淀（以及你用「记住 X」显式写入）的记忆。你可以查看、删除单条、清空某一作用域，
        或点「整理记忆」让模型先给出体检建议（可预览、可撤销）再决定是否应用。
      </p>

      {/* 体检预览清单：先展示模型建议的删除/合并动作，确认后再落地（删除项进回收站，可撤销） */}
      {proposal && proposal.skipped && (
        <div className="memory-revise-msg">🧹 {proposal.reason}</div>
      )}
      {proposal && !proposal.skipped && (
        <div className="memory-revise-plan">
          <div className="revise-plan-head">
            <strong>🧹 整理建议（预览）</strong>
            {proposal.summary && <span className="revise-plan-notes">{proposal.summary}</span>}
          </div>
          {proposal.actions.length > 0 && (
            <div className="revise-plan-filter">
              <input
                className="revise-plan-search"
                type="text"
                placeholder="搜索内容 / 理由…"
                value={planQuery}
                onChange={(e) => setPlanQuery(e.target.value)}
              />
              {planQuery && (
                <button
                  className="revise-plan-clear"
                  title="清除搜索"
                  onClick={() => setPlanQuery('')}
                >
                  ×
                </button>
              )}
              <div className="revise-plan-scope-tabs">
                {(
                  [
                    { key: 'all', label: '全部' },
                    { key: 'user', label: '用户级' },
                    { key: 'project', label: '项目级' },
                  ] as const
                ).map((s) => (
                  <button
                    key={s.key}
                    className={`revise-scope-tab${planScope === s.key ? ' active' : ''}`}
                    onClick={() => setPlanScope(s.key)}
                  >
                    {s.label}
                  </button>
                ))}
              </div>
            </div>
          )}
          {(planQuery || planScope !== 'all') && (
            <div className="revise-plan-count">
              显示 {visibleActions.length} / 共 {proposal.actions.length} 条
            </div>
          )}
          {visibleActions.length === 0 ? (
            <div className="revise-plan-empty">没有匹配的整理项</div>
          ) : (
            <ul className="revise-plan-list">
              {visibleActions.map((a, i) => (
                <li className="revise-plan-item" key={`${a.scope}-${a.id}-${i}`}>
                  <span className={`revise-tag tag-${a.kind}`}>
                    {a.kind === 'delete' ? '删除' : a.kind === 'merge_remove' ? '合并' : '更新'}
                  </span>
                  <span className="revise-scope">{a.scope === 'user' ? '用户级' : '项目级'}</span>
                  <span className="revise-content">
                    {a.content}
                    {a.kind === 'merge_keep' && a.target && (
                      <span className="revise-target"> → {a.target}</span>
                    )}
                  </span>
                  <span className="revise-reason">{a.reason}</span>
                </li>
              ))}
            </ul>
          )}
          <div className="revise-plan-actions">
            <button className="ghost" onClick={onCancelProposal} disabled={applying}>
              取消
            </button>
            <button className="primary" onClick={onApply} disabled={applying}>
              {applying ? '应用中…' : `应用修改 (${proposal.actions.length})`}
            </button>
          </div>
          <p className="modal-hint trash-hint">
            应用后，被删除的记忆会先进入回收站，30 天内可随时恢复。
          </p>
        </div>
      )}

      {reviseMsg && <div className="memory-revise-msg">🧹 {reviseMsg}</div>}
      {error && <div className="modal-error">⚠ {error}</div>}
      {loading && <div className="memory-loading">加载中…</div>}
      {!loading && !error && (
        <>
          {memFiltered.total > 0 && (
            <div className="revise-plan-filter memory-filter">
              <input
                className="revise-plan-search"
                type="text"
                placeholder="搜索已保存记忆…"
                value={memQuery}
                onChange={(e) => setMemQuery(e.target.value)}
              />
              {memQuery && (
                <button className="revise-plan-clear" title="清除搜索" onClick={() => setMemQuery('')}>
                  ×
                </button>
              )}
              {memQuery.trim() && (
                <span className="revise-plan-count">
                  显示 {memFiltered.shown} / 共 {memFiltered.total} 条
                </span>
              )}
            </div>
          )}
          <div className="memory-scopes">
            {scopes.map((sc) => {
              const d = data?.[sc.key] ?? { facts: [], entries: [] };
              const fd = memFiltered[sc.key];
              const filtering = memQuery.trim().length > 0;
              return (
                <div className="memory-scope" key={sc.key}>
                  <div className="memory-scope-head">
                    <div>
                      <strong>{sc.label}</strong>
                      <div className="memory-scope-hint">{sc.hint}</div>
                    </div>
                    <div className="memory-scope-actions">
                      <button
                        className="link-btn"
                        onClick={() => onExport(sc.key)}
                        title="导出该作用域记忆为 JSON 备份"
                      >
                        <Download size={14} /> 导出
                      </button>
                      <button
                        className="link-btn"
                        onClick={() => onImport(sc.key)}
                        title="从 JSON 文件导入记忆（自动去重）"
                      >
                        <Upload size={14} /> 导入
                      </button>
                      <button
                        className="link-btn danger"
                        disabled={d.entries.length === 0}
                        onClick={() => onClear(sc.key)}
                      >
                        清空语义记忆
                      </button>
                    </div>
                  </div>

                  <div className="memory-sub">常驻事实</div>
                  {fd.facts.length === 0 ? (
                    <div className="memory-empty">{filtering ? '无匹配' : '无'}</div>
                  ) : (
                    fd.facts.map((f, i) => (
                      <div className="memory-row" key={`f-${sc.key}-${i}`}>
                        <span className="memory-text">{f}</span>
                        <button
                          className="memory-del"
                          title="删除该事实"
                          onClick={() => onDeleteFact(sc.key, f)}
                        >
                          ×
                        </button>
                      </div>
                    ))
                  )}

                  <div className="memory-sub">语义记忆</div>
                  {fd.entries.length === 0 ? (
                    <div className="memory-empty">{filtering ? '无匹配' : '无'}</div>
                  ) : (
                    fd.entries.map((e) => (
                      <div className="memory-row" key={`e-${sc.key}-${e.id}`}>
                        <span className="memory-text">
                          {e.content}
                          {e.tags && e.tags.length > 0 && (
                            <span className="memory-tags"> #{e.tags.join(' #')}</span>
                          )}
                          <span className="memory-date">{formatTime(e.createdAt)}</span>
                        </span>
                        <button
                          className="memory-del"
                          title="删除该记忆"
                          onClick={() => onDeleteEntry(sc.key, e.id)}
                        >
                          ×
                        </button>
                      </div>
                    ))
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}

      {!loading && !error && (
        <div className="memory-trash">
          <button className="trash-toggle" onClick={onToggleTrash}>
            <span>{showTrash ? '▾' : '▸'} 🗑 回收站</span>
            <span className="trash-count">{trashTotal > 0 ? trashTotal : ''}</span>
          </button>
          {showTrash && (
            <div className="trash-body">
              <p className="modal-hint trash-hint">
                删除的记忆会先进入回收站，30 天内可随时恢复，超期自动清理。
              </p>
              {trashTotal === 0 ? (
                <div className="memory-empty">回收站是空的</div>
              ) : (
                <>
                  <div className="revise-plan-filter memory-filter">
                    <input
                      className="revise-plan-search"
                      type="text"
                      placeholder="搜索回收站…"
                      value={trashQuery}
                      onChange={(e) => setTrashQuery(e.target.value)}
                    />
                    {trashQuery && (
                      <button
                        className="revise-plan-clear"
                        title="清除搜索"
                        onClick={() => setTrashQuery('')}
                      >
                        ×
                      </button>
                    )}
                    {trashQuery.trim() && (
                      <span className="revise-plan-count">
                        显示 {trashFiltered.shown} / 共 {trashTotal} 条
                      </span>
                    )}
                  </div>
                  {trashQuery.trim() && trashFiltered.shown === 0 && (
                    <div className="revise-plan-empty">没有匹配的回收项</div>
                  )}
                  {scopes.map((sc) => {
                    const items = trashFiltered[sc.key];
                    if (items.length === 0) return null;
                    return (
                      <div className="trash-scope" key={`trash-${sc.key}`}>
                        <div className="trash-scope-head">
                          <span className="memory-sub">{sc.label}</span>
                          <button className="link-btn danger" onClick={() => onPurgeTrash(sc.key)}>
                            清空本区
                          </button>
                        </div>
                        {items.map((it) => (
                          <div className="memory-row trash-row" key={`t-${sc.key}-${it.trashId}`}>
                            <span className="memory-text">
                              <span className="trash-kind">{it.kind === 'fact' ? '事实' : '记忆'}</span>
                              {it.kind === 'fact' ? it.fact : it.entry?.content}
                              <span className="memory-date">删除于 {formatTime(it.deletedAt)}</span>
                            </span>
                            <button
                              className="link-btn restore-btn"
                              title="恢复该条"
                              onClick={() => onRestore(sc.key, it.trashId)}
                            >
                              恢复
                            </button>
                          </div>
                        ))}
                      </div>
                    );
                  })}
                  <div className="trash-foot">
                    <button className="link-btn danger" onClick={() => onPurgeTrash()}>
                      清空全部回收站
                    </button>
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** 简单的移动端检测 hook（按窗口宽度） */
function useMobileDetect(breakpoint = 768): boolean {
  const [isMobile, setIsMobile] = useState(() => typeof window !== 'undefined' && window.innerWidth < breakpoint);
  useEffect(() => {
    const onResize = () => setIsMobile(window.innerWidth < breakpoint);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [breakpoint]);
  return isMobile;
}
