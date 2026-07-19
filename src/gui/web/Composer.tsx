/**
 * Composer — 输入框 + 工具栏 chip（模式/思考/研究/风格/润色/清空/用量/更多）+ 发送按钮
 *
 * 整体封装为一个组件：自身维护 showMore 弹层开关，输入和发送仍由父组件控制。
 */
import { useState, useRef, useEffect, type KeyboardEvent, type ChangeEvent, type DragEvent } from 'react';
import ReactDOM from 'react-dom';
import { Bot, Brain, Search, Palette, Sparkles, Trash2, DollarSign, Menu, Blocks, Database, Folder, HelpCircle, StopCircle, RefreshCw } from 'lucide-react';
import './Composer.css';

export interface ComposerProps {
  // ── 输入与发送 ──
  input: string;
  setInput: (v: string) => void;
  onSend: () => void;

  // ── 连接状态（决定 chip 的 active 态与按钮可用性）──
  busy: boolean;
  mode: string;
  planMode: boolean;
  outputStyle: string;

  // ── 命令执行：把所有交互收敛到 runCmd，父组件按文本送入 agent ──
  runCmd: (cmd: string) => void;

  // ── 控制类动作（不能走 runCmd 的）──
  onAbort: () => void;
  /** 打开「工作空间」设置浮层（Project tab） */
  openWorkspaceSettings: () => void;
  /** 打开「技能」底部上拉菜单 */
  openSkillSheet: () => void;

  // ── 上传文档：前端把文件读成 base64 后交给父组件走 WS ──
  onUpload: (name: string, mime: string, data: string) => void;

  /** 待发送附件（上传后暂存，随下一条消息一并提交）；可逐个移除 */
  attachments: Array<{ name: string; path: string }>;
  onRemoveAttachment: (index: number) => void;

  // ── 技能注入：父组件让 Composer 自动把指定技能名追加到输入框 ──
  skillInsert: string | null;
  onSkillInserted: () => void;

  // ── 润色：不经过 agent loop，直接调 LLM 格式化输入框文本 ──
  onPolish: () => void;
  polishLoading: boolean;

  // ── 迭代轮次 ──
  currentIteration: number;
  maxIterations: number;
  onSetLimit: (n: number) => void;

  // ── 浏览器观察回灌指示 ──
  browserWatch: boolean;
}

/** 风格可选项（上拉菜单内展示；key 与后端 OutputStyle 严格一致） */
const STYLE_OPTIONS: Array<{ key: 'human' | 'professional' | 'raw'; label: string; desc: string }> = [
  { key: 'human', label: '人话', desc: '面向普通用户的大白话，直接说人话' },
  { key: 'professional', label: '专业', desc: '专业领域的规范术语与严谨表述' },
  { key: 'raw', label: '原始', desc: '不注入任何风格指令' },
];
const STYLE_LABEL: Record<string, string> = {
  human: '人话',
  professional: '专业',
  raw: '原始',
};

export function Composer(props: ComposerProps) {
  const {
    input,
    setInput,
    onSend,
    busy,
    mode,
    planMode,
    outputStyle,
    runCmd,
    onAbort,
    openWorkspaceSettings,
    openSkillSheet,
    onUpload,
    attachments,
    onRemoveAttachment,
    skillInsert,
    onSkillInserted,
    onPolish,
    polishLoading,
    currentIteration,
    maxIterations,
    onSetLimit,
    browserWatch,
  } = props;

  // 「更多」弹层显隐：组件内部状态，父组件不需要关心
  const [showMore, setShowMore] = useState(false);
  const moreWrapRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // 「风格」上拉菜单显隐
  const [showStyle, setShowStyle] = useState(false);
  // 风格菜单的 fixed 定位（用于 portal 渲染到 body）
  const styleBtnRef = useRef<HTMLButtonElement>(null);
  // 迭代轮次编辑态
  const [editLimit, setEditLimit] = useState(false);
  const [limitInput, setLimitInput] = useState('');
  const limitInputRef = useRef<HTMLInputElement>(null);
  const styleMenuRef = useRef<HTMLDivElement>(null);
  const [styleMenuPos, setStyleMenuPos] = useState<{ top: number; left: number } | null>(null);

  // 上传文档：隐藏的文件选择器 + 上传中状态
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);

  // 把一批文件读成 base64 后逐个交给父组件（点选与拖拽共用）
  const processFiles = (files: File[]) => {
    if (!files.length) return;
    setUploading(true);
    let pending = files.length;
    const finishOne = () => {
      pending -= 1;
      if (pending === 0) setUploading(false);
    };
    for (const file of files) {
      const reader = new FileReader();
      reader.onload = () => {
        const result = String(reader.result ?? '');
        // dataURL 形如 data:<mime>;base64,<data>，取逗号后部分
        const base64 = result.includes(',') ? result.split(',')[1] : result;
        onUpload(file.name, file.type || 'application/octet-stream', base64);
        finishOne();
      };
      reader.onerror = finishOne;
      reader.readAsDataURL(file);
    }
  };

  const onPickFiles = (e: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = ''; // 允许重复选择同一文件
    processFiles(files);
  };

  // ── 拖拽上传 ──
  const dragDepth = useRef(0);
  const [dragActive, setDragActive] = useState(false);

  const isFileDrag = (e: DragEvent<HTMLElement>) =>
    !!e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files');

  const onDragEnter = (e: DragEvent<HTMLElement>) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    dragDepth.current += 1;
    setDragActive(true);
  };
  const onDragOver = (e: DragEvent<HTMLElement>) => {
    if (!isFileDrag(e)) return;
    e.preventDefault(); // 必须 preventDefault，否则浏览器会直接打开文件
  };
  const onDragLeave = (e: DragEvent<HTMLElement>) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    dragDepth.current -= 1;
    if (dragDepth.current <= 0) {
      dragDepth.current = 0;
      setDragActive(false);
    }
  };
  const onDrop = (e: DragEvent<HTMLElement>) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    dragDepth.current = 0;
    setDragActive(false);
    processFiles(Array.from(e.dataTransfer.files ?? []));
  };

  // 全局兜底：拖动文件到页面任意位置松手时，阻止浏览器默认「打开文件」行为
  useEffect(() => {
    const prevent = (e: globalThis.DragEvent) => {
      if (e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files')) {
        e.preventDefault();
      }
    };
    window.addEventListener('dragover', prevent);
    window.addEventListener('drop', prevent);
    return () => {
      window.removeEventListener('dragover', prevent);
      window.removeEventListener('drop', prevent);
    };
  }, []);

  useEffect(() => {
    if (!showStyle) {
      setStyleMenuPos(null);
      return;
    }
    const updatePos = () => {
      const rect = styleBtnRef.current?.getBoundingClientRect();
      if (rect) setStyleMenuPos({ top: rect.top, left: rect.left });
    };
    updatePos();
    // 点击按钮与菜单之外的区域才关闭（避免鼠标移动时误收起）
    const onDocPointerDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (styleBtnRef.current?.contains(t) || styleMenuRef.current?.contains(t)) return;
      setShowStyle(false);
    };
    window.addEventListener('resize', updatePos);
    window.addEventListener('scroll', updatePos, true);
    document.addEventListener('mousedown', onDocPointerDown);
    return () => {
      window.removeEventListener('resize', updatePos);
      window.removeEventListener('scroll', updatePos, true);
      document.removeEventListener('mousedown', onDocPointerDown);
    };
  }, [showStyle]);

  // 「更多」菜单：点击外部才关闭
  useEffect(() => {
    if (!showMore) return;
    const onDocPointerDown = (e: MouseEvent) => {
      if (moreWrapRef.current?.contains(e.target as Node)) return;
      setShowMore(false);
    };
    document.addEventListener('mousedown', onDocPointerDown);
    return () => document.removeEventListener('mousedown', onDocPointerDown);
  }, [showMore]);

  // 父组件让 Composer 注入技能名（来自 SkillSheet 点选）：
  // 把字符串追加到当前输入末尾（如 "@skillname "），保持光标在末尾，focus 回输入框。
  useEffect(() => {
    if (!skillInsert) return;
    const next = input ? `${input} ${skillInsert}` : skillInsert;
    setInput(next);
    onSkillInserted();
    // focus + 把光标放到末尾
    const ta = textareaRef.current;
    if (ta) {
      ta.focus();
      const end = next.length;
      // 等 React 把新 value 渲染到 DOM 再 setSelectionRange
      requestAnimationFrame(() => ta.setSelectionRange(end, end));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [skillInsert]);

  const canSend = (!busy) && (input.trim().length > 0 || attachments.length > 0);
  const styleLabel = STYLE_LABEL[outputStyle] || '人话';

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      onSend();
    }
  };

  const closeMore = () => setShowMore(false);

  return (
    <footer
      className="composer"
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <div className="composer-input">
        <textarea
          ref={textareaRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="今天帮你做些什么？@ 引用对话文件，/ 调用技能与指令"
          rows={3}
        />
      </div>

      {/* 待发送附件：上传后展示为可删除 chip，随下一条消息一并提交 */}
      {attachments.length > 0 && (
        <div className="composer-attachments">
          {attachments.map((a, i) => (
            <span className="attach-chip" key={`${a.path}-${i}`} title={a.path}>
              <span className="attach-chip-name">{a.name}</span>
              <button
                type="button"
                className="attach-chip-remove"
                onClick={() => onRemoveAttachment(i)}
                aria-label={`移除附件 ${a.name}`}
                title="移除"
              >
                <svg width="11" height="11" viewBox="0 0 16 16" aria-hidden>
                  <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                </svg>
              </button>
            </span>
          ))}
        </div>
      )}

      <div className="composer-toolbar">
        {/* 上传文档：加号按钮（与功能模块同一行，置于最左） */}
        <button
          type="button"
          className="attach-btn"
          onClick={() => fileRef.current?.click()}
          title="上传文档"
          aria-label="上传文档"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden>
            <path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
        </button>
        {uploading && <span className="attach-busy">上传中…</span>}
        <input
          ref={fileRef}
          type="file"
          multiple
          accept=".txt,.md,.markdown,.pdf,.doc,.docx,.csv,.tsv,.json,.yaml,.yml,.log,.html,.htm,.js,.jsx,.ts,.tsx,.py,.java,.go,.rs,.c,.cpp,.h,.css,.scss,.sql,.xml,.ipynb"
          className="attach-input"
          onChange={onPickFiles}
          hidden
        />

        {/* 横向可滚动区：仅承载普通 chip；风格/更多菜单与发送按钮放在其外，避免被 overflow 裁剪 */}
        <div className="toolbar-scroll">
        {/* ── 模式三选一（exclusive）：ask / explore 走 /mode；plan 走 /plan ── */}
        <button
          className={`chip ${mode === 'ask' ? 'is-active' : ''}`}
          onClick={() => runCmd('/mode ask')}
          title="任务助理：对话 / 提问模式（/mode ask）"
        >
          <span className="chip-glyph" aria-hidden><Bot size={13} /></span>
          <span>任务助理</span>
        </button>

        <button
          className={`chip ${planMode ? 'is-active chip-think' : ''}`}
          onClick={() => runCmd('/plan')}
          title={planMode ? '规划模式已开启（/plan）' : '规划模式已关闭（/plan）'}
        >
          <span className="chip-glyph" aria-hidden><Brain size={13} /></span>
          <span>思考</span>
        </button>

        <button
          className={`chip ${mode === 'explore' ? 'is-active' : ''}`}
          onClick={() => runCmd('/mode explore')}
          title="研究模式：只读探索（/mode explore）"
        >
          <span className="chip-glyph" aria-hidden><Search size={13} /></span>
          <span>研究</span>
        </button>

        {/* ── 风格：点击弹出上拉菜单，选「人话 / 专业 / 原始」直接套用 ── */}
        <div className="style-wrap">
          <button
            ref={styleBtnRef}
            className={`chip ${showStyle ? 'is-active' : ''}`}
            onClick={() => setShowStyle((v) => !v)}
            title={`输出风格（点击选择）— 当前：${styleLabel}`}
            aria-expanded={showStyle}
          >
            <span className="chip-glyph" aria-hidden><Palette size={13} /></span>
            <span>风格·{styleLabel}</span>
          </button>
          {showStyle && styleMenuPos && ReactDOM.createPortal(
            <div
              ref={styleMenuRef}
              className="style-menu"
              style={{ position: 'fixed', top: styleMenuPos.top, left: styleMenuPos.left }}
            >
              {STYLE_OPTIONS.map((opt) => (
                <button
                  key={opt.key}
                  className={`style-item ${outputStyle === opt.key ? 'is-active' : ''}`}
                  onClick={() => { runCmd(`/style ${opt.key}`); setShowStyle(false); }}
                >
                  <span className="style-name">{opt.label}</span>
                  <span className="style-desc">{opt.desc}</span>
                </button>
              ))}
            </div>,
            document.body
          )}
        </div>

        {/* ── 迭代轮次：显示当前进度，点击可设上限 ── */}
        {editLimit ? (
          <span className="chip chip-edit">
            <input
              ref={limitInputRef}
              type="number"
              min="0"
              className="chip-limit-input"
              value={limitInput}
              onChange={(e) => setLimitInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  const n = Number(limitInput);
                  if (Number.isFinite(n) && n >= 0) {
                    onSetLimit(n);
                    setEditLimit(false);
                  }
                } else if (e.key === 'Escape') {
                  setEditLimit(false);
                }
              }}
              onBlur={() => setEditLimit(false)}
              autoFocus
              placeholder="轮次"
            />
          </span>
        ) : (
          <button
            className={`chip ${maxIterations > 0 ? 'chip-limit' : ''}`}
            onClick={() => {
              if (busy) return;
              setLimitInput(maxIterations > 0 ? String(maxIterations) : '');
              setEditLimit(true);
              setTimeout(() => limitInputRef.current?.focus(), 0);
            }}
            disabled={busy}
            title={maxIterations > 0
              ? `迭代上限：${maxIterations} 轮（点击可修改或清除）`
              : '迭代无上限（点击可设定上限）'}
          >
            <span className="chip-glyph" aria-hidden><RefreshCw size={13} /></span>
            <span>{maxIterations > 0
              ? `${currentIteration}/${maxIterations}`
              : currentIteration > 0
                ? `${currentIteration}/∞`
                : '∞'}</span>
          </button>
        )}

        {/* ── 浏览器观察回灌 ── */}
        <button
          className={`chip ${browserWatch ? 'chip-watch is-active' : ''}`}
          onClick={() => props.runCmd('/watch')}
          disabled={busy}
          title={browserWatch
            ? '浏览器观察回灌已开启：每轮后等待浏览器报错并自动续跑调试循环（点击关闭）'
            : '浏览器观察回灌已关闭（点击开启：让 AI 自动根据浏览器报错续跑修复）'}
        >
          <span className="chip-glyph" aria-hidden>👁</span>
          <span>观察{browserWatch ? '中' : ''}</span>
        </button>

        {/* ── 单次命令：润色 / 清空 / 用量 ── */}
        <button
          className={`chip ${polishLoading ? 'chip-loading' : ''}`}
          onClick={onPolish}
          disabled={polishLoading || busy || input.trim().length === 0}
          title={input.trim().length === 0 ? '请先在输入框写内容，再点击润色' : '把输入框内容改写成专业、有逻辑、有步骤的表达'}
        >
          <span className="chip-glyph" aria-hidden><Sparkles size={13} /></span>
          <span>{polishLoading ? '润色中…' : '润色'}</span>
        </button>

        <button
          className="chip"
          onClick={() => runCmd('/clear')}
          title="清空当前对话上下文（/clear）"
        >
          <span className="chip-glyph" aria-hidden><Trash2 size={13} /></span>
          <span>清空</span>
        </button>

        <button
          className="chip"
          onClick={() => runCmd('/cost')}
          title="显示累计用量与费用（/cost）"
        >
          <span className="chip-glyph" aria-hidden><DollarSign size={13} /></span>
          <span>用量</span>
        </button>
        </div>{/* /.toolbar-scroll */}

        {/* ── 更多：低频命令集中放到下拉菜单 ── */}
        <div className="more-wrap" ref={moreWrapRef}>
          <button
            className={`chip ${showMore ? 'is-active' : ''}`}
            onClick={() => setShowMore((v) => !v)}
            title="更多"
            aria-expanded={showMore}
          >
            <span className="chip-glyph" aria-hidden><Menu size={13} /></span>
            <span>更多</span>
          </button>
          {showMore && (
            <div className="more-menu">
              <button className="more-item" onClick={() => { openSkillSheet(); closeMore(); }}>
                <span className="more-ico" aria-hidden><Blocks size={14} /></span>
                <span>技能（打开上拉菜单）</span>
              </button>
              <button className="more-item" onClick={() => { runCmd('/memory list'); closeMore(); }}>
                <span className="more-ico" aria-hidden><Database size={14} /></span>
                <span>记忆 /memory</span>
              </button>
              <button className="more-item" onClick={() => { openWorkspaceSettings(); closeMore(); }}>
                <span className="more-ico" aria-hidden><Folder size={14} /></span>
                <span>工作空间</span>
              </button>
              <button
                className="more-item"
                onClick={() => { runCmd('/help'); closeMore(); }}
                title="显示所有可用命令"
              >
                <span className="more-ico" aria-hidden><HelpCircle size={14} /></span>
                <span>帮助 /help</span>
              </button>
              {busy && (
                <button className="more-item danger" onClick={() => { onAbort(); closeMore(); }}>
                  <span className="more-ico" aria-hidden><StopCircle size={14} /></span>
                  <span>中断任务</span>
                </button>
              )}
            </div>
          )}
        </div>

        <span className="toolbar-spacer" />

        {/* ── 发送 ── */}
        {busy ? (
          <button
            className="send stop"
            onClick={onAbort}
            title="中断当前任务"
            aria-label="中断"
          >
            <svg width="18" height="18" viewBox="0 0 16 16" aria-hidden>
              <rect x="3" y="3" width="10" height="10" rx="1.5" fill="currentColor" />
            </svg>
          </button>
        ) : (
          <button
            className="send"
            onClick={onSend}
            disabled={!canSend}
            title="发送（Enter）"
          >
            <span aria-hidden>↑</span>
          </button>
        )}
      </div>

      {/* 拖拽上传高亮遮罩：仅在拖着文件悬停在输入框上方时出现 */}
      {dragActive && (
        <div className="composer-drop-overlay" aria-hidden>
          <div className="drop-hint">
            <svg width="30" height="30" viewBox="0 0 24 24" aria-hidden>
              <path d="M12 16V4m0 0l-5 5m5-5l5 5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M4 18v1a1 1 0 001 1h14a1 1 0 001-1v-1" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <span>拖放文件到此处上传</span>
          </div>
        </div>
      )}
    </footer>
  );
}
