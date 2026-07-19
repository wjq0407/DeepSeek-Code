/**
 * ChatArea — 对话消息区
 *
 * 只负责"显示对话"：渲染历史消息（用户/助手/系统/工具/错误）、空态提示。
 * 所有消息数据由父组件（App.tsx）持有，组件本身不维护状态。
 *
 * 思考盒：每轮对话中，agent 的「观察」（推理文字 + 工具调用 + 工具结果）不再作为
 * 散落的气泡，而是累积进一张「思考过程」卡片（ThinkingCard），渲染在该轮最终答案
 * 气泡的上方；答案气泡仅在 agent 给出最终答复时出现。思考中指示器放在思考盒，
 * 「输出中…」放在答案气泡。
 *
 * 通过 forwardRef 把内部 div ref 暴露给父组件，以便父组件在消息追加时自动滚到底。
 */
import { forwardRef, type Ref, memo, useState, useRef, useEffect, type ReactNode } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import { ChevronRight, ChevronDown, MessageSquare } from 'lucide-react';
import type { UiMessage } from '../../app/types.ts';
import type { ThinkingTurn, ThinkingEntry } from './App.tsx';
import { useTypewriter } from './useTypewriter.ts';
import './ChatArea.css';

export interface ChatAreaProps {
  messages: UiMessage[];
  /** 当前是否在等 agent 回复；为 true 时底部思考盒显示"思考中…" */
  busy: boolean;
  /** 是否正处于「输出最终答案」阶段（答案气泡显示"输出中…"） */
  outputting: boolean;
  /** 各轮对话的思考过程（观察条目），与最终答案气泡分开 */
  thinkings: ThinkingTurn[];
  /** 折叠/展开某轮思考卡的回调（由父组件维护状态） */
  onToggleThinking: (turnId: number) => void;
  /** 当前登录用户名，用于用户消息显示头像 / 名字；为空时回退为「我」 */
  username?: string | null;
}

/**
 * 解析用户消息里的「[用户附件]」块：服务端把附件路径拼进 user 消息正文一并
 * 交给模型，但气泡里不该显示那串原始路径文本。这里把正文与附件拆开，
 * 让气泡只显示用户的话 + 附件名 chip，模型侧仍拿到完整指令（不改协议/内核）。
 * 返回 { text: 用户正文（已去除附件块）, attachments: [{name, path}] }。
 */
interface ParsedAttachment {
  name: string;
  path: string;
}
function parseUserAttachments(raw: string): { text: string; attachments: ParsedAttachment[] } {
  const marker = '[用户附件]';
  const idx = raw.indexOf(marker);
  if (idx === -1) return { text: raw, attachments: [] };
  const text = raw.slice(0, idx).trim();
  const rest = raw.slice(idx + marker.length);
  const attachments: ParsedAttachment[] = [];
  for (const line of rest.split('\n')) {
    const m = line.match(/^\s*-\s*([^：:\n]+)[：:]\s*([^\n]+?)\s*$/);
    if (m) attachments.push({ name: m[1].trim(), path: m[2].trim() });
  }
  return { text, attachments };
}

/** 小图标：完成对勾 */
function CheckIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3.5 8.5l3 3 6-7" />
    </svg>
  );
}
/** 小图标：工具（扳手） */
function ToolIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M10.5 2.5a3 3 0 0 0-4 4L3 10a2 2 0 0 0 3 3l3.5-3.5a3 3 0 0 0 4-4l-2.5 2.5-1.5-1.5z" />
    </svg>
  );
}
/** 小图标：停止（方块）— 用于「生成中断」徽章 */
function StopIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 16 16" aria-hidden fill="currentColor">
      <rect x="4" y="4" width="8" height="8" rx="1.5" />
    </svg>
  );
}

/**
 * 安全：AI 生成内容的安全渲染约束（输出内容 XSS / 追踪防护）
 *
 * 本项目用纯 Markdown 渲染器（react-markdown）而非 dangerouslySetInnerHTML / v-html，
 * 且未启用 rehype-raw，因此 AI 输出里的 <script> 等原始 HTML 会被当作文本，不会被执行
 * （天然规避 XSS）。下面是在「纯渲染器」基础上的防御性收口：
 *  1) safeUrlTransform：链接/图片只允许 http(s)/mailto/tel/站内相对路径/data:image，
 *     屏蔽 javascript:/vbscript:/file: 等伪协议，杜绝「点击即执行」类 XSS。
 *  2) a 组件：新标签页打开 + rel=noopener noreferrer nofollow，避免反向访问/钓鱼。
 *  3) img 组件：仅允许 https / data:image，阻断 http 明文图片（防盗链追踪 + 混合内容），
 *     并加 referrerPolicy=no-referrer + loading=lazy，外部图片无法拿到用户 Referrer/IP 溯源。
 *  4) pre 组件（代码块）：内容由 react-markdown 转义为文本节点；复制按钮只读取纯文本
 *     (innerText)，绝不复制 innerHTML，用户复制代码不会被注入。
 */

/** 去除控制字符，避免伪协议绕过（如 "java\nscript:" 形式） */
function stripControlChars(v: string): string {
  return v.replace(/[\u0000-\u001F\u007F]/g, '').trim();
}

/** 通用 URL 白名单（链接 + 图片共用）；危险协议返回 '' */
function safeUrlTransform(value: string): string {
  if (typeof value !== 'string') return '';
  const v = stripControlChars(value);
  if (v === '') return '';
  // 站内相对链接（锚点 / 路径 / 查询）直接放行
  if (/^[#/?]/.test(v)) return v;
  try {
    const u = new URL(v, window.location.origin);
    if (
      u.protocol === 'https:' ||
      u.protocol === 'http:' ||
      u.protocol === 'mailto:' ||
      u.protocol === 'tel:' ||
      (u.protocol === 'data:' && u.pathname.startsWith('image/'))
    ) {
      return u.href;
    }
  } catch {
    /* 解析失败视为不安全 */
  }
  return '';
}

/** 仅 https / data:image 可作为图片源（阻断 http 明文追踪） */
function safeImageSrc(value: string): string {
  const t = safeUrlTransform(value);
  if (t && (t.startsWith('https:') || t.startsWith('data:image'))) return t;
  return '';
}

/** 代码块：渲染转义后的文本，并提供「安全复制」（只复制纯文本，绝不复制 innerHTML） */
function CodePre({ children }: { children?: ReactNode }) {
  const preRef = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);
  const onCopy = () => {
    const text = (preRef.current?.innerText ?? '').replace(/\n$/, '');
    if (!text) return;
    if (!navigator.clipboard) return; // 非安全上下文（http）下剪贴板 API 不可用，静默跳过
    navigator.clipboard.writeText(text).then(
      () => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1200);
      },
      () => {
        /* 写入失败（权限/异常）时静默失败 */
      },
    );
  };
  return (
    <div className="code-block">
      <button type="button" className="code-copy" onClick={onCopy} aria-label="复制代码">
        {copied ? '已复制' : '复制'}
      </button>
      <pre ref={preRef}>{children}</pre>
    </div>
  );
}

/** react-markdown 组件覆盖：链接 / 图片 / 代码块的安全收口 */
const mdComponents: Components = {
  a: ({ node, href, children, ...rest }) => {
    void node;
    const safe = safeUrlTransform(href ?? '');
    if (!safe) return <span className="md-link-blocked">{children}</span>;
    return (
      <a href={safe} target="_blank" rel="noopener noreferrer nofollow" {...rest}>
        {children}
      </a>
    );
  },
  img: ({ node, src, alt, ...rest }) => {
    void node;
    const safe = safeImageSrc(src ?? '');
    if (!safe) {
      return (
        <span className="md-img-blocked" title="外部图片链接已屏蔽（可能为追踪或失效链接）">
          图片已屏蔽
        </span>
      );
    }
    return (
      <img src={safe} alt={alt ?? ''} referrerPolicy="no-referrer" loading="lazy" decoding="async" {...rest} />
    );
  },
  pre: ({ node, children }) => {
    void node;
    return <CodePre>{children}</CodePre>;
  },
};

/**
 * 节流化 Markdown 渲染（性能优化 #4）。
 *
 * 流式期间打字机每帧都在改变 `text`（逐字揭示），若每次都跑 react-markdown
 * 解析，长文会卡死。这里把「解析」节流到 ~80ms 一次：窗口内的多次文本变更
 * 只触发一次真正的解析（攒批再解析），视觉上与逐字流式无差异，但解析次数降数倍，
 * 与 App.tsx 的流式合批窗口对齐。memo 保证未变化的文本直接复用已解析节点。
 * 使用 remark-breaks：默认 Markdown 会把单换行折叠成段落内空格，导致流式/最终答案
 * 里的多行文本（如工具结果、自然语言换行）显示异常；该插件保留单换行为 <br>。
 */
const MarkdownView = memo(function MarkdownView({ text }: { text: string }) {
  const [node, setNode] = useState<ReactNode>(() => (
    <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]} urlTransform={safeUrlTransform} components={mdComponents}>{text}</ReactMarkdown>
  ));
  const latest = useRef(text);
  latest.current = text;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (timer.current) return; // 已在节流窗口内，等尾沿统一解析
    timer.current = setTimeout(() => {
      timer.current = null;
      setNode(<ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]} urlTransform={safeUrlTransform} components={mdComponents}>{latest.current}</ReactMarkdown>);
    }, 80);
  }, [text]);
  return <>{node}</>;
});

/** 单条观察（推理 / 工具 / 工具结果） */
const ThinkingStep = memo(function ThinkingStep({ entry }: { entry: ThinkingEntry }) {
  // 流式条目（status==='streaming'）逐字揭示；已完成/历史条目立即完整显示
  const live = entry.status === 'streaming';
  const shown = useTypewriter(entry.text, live);
  if (entry.kind === 'tool') {
    return (
      <div className="think-step tool">
        <div className="think-step-head">
          <ToolIcon />
          <span className="think-tool-name">{entry.title}</span>
        </div>
        {entry.text.trim() && <pre className="think-text">{shown.trim()}</pre>}
      </div>
    );
  }
  if (entry.kind === 'tool_result') {
    return (
      <div className="think-step result">
        <div className="think-step-label">↳ 工具结果</div>
        <pre className="think-text muted">{shown.trim()}</pre>
      </div>
    );
  }
  return (
    <div className="think-step reason">
      <pre className="think-text">{shown.trim()}</pre>
    </div>
  );
});

/** 一轮对话的「思考过程」卡片：可折叠，展开显示全部观察条目 */
const ThinkingCard = memo(function ThinkingCard({ turn, onToggle }: { turn: ThinkingTurn; onToggle: (id: number) => void }) {
  const isActive = turn.status === 'thinking' || turn.status === 'outputting';
  const isInterrupted = turn.status === 'interrupted';
  const stepCount = turn.entries.length;
  return (
    <div className={`thinking-card ${turn.collapsed ? 'collapsed' : ''} ${isActive ? 'active' : ''} ${isInterrupted ? 'interrupted' : ''}`}>
      <button className="thinking-head" onClick={() => onToggle(turn.turnId)} aria-expanded={!turn.collapsed}>
        <span className="thinking-ico" aria-hidden>
          {isActive ? <span className="spinner" /> : isInterrupted ? <StopIcon /> : <CheckIcon />}
        </span>
        <span className="thinking-title">{isActive ? '思考中…' : isInterrupted ? '生成中断' : `思考过程 · ${stepCount} 步`}</span>
        <span className="thinking-count">{stepCount}</span>
        <span className="thinking-caret" aria-hidden>{turn.collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}</span>
      </button>
      {!turn.collapsed && stepCount > 0 && (
        <div className="thinking-body">
          {turn.entries.map((e) => (
            <ThinkingStep key={e.id} entry={e} />
          ))}
        </div>
      )}
    </div>
  );
});

/**
 * 助手「最终答案」气泡：统一接入 useTypewriter 做逐字揭示。
 * - live = 正在输出最终答案（outputting）且为最后一条 → 逐字；流式结束（outputting=false）→ 立即完整。
 * - 历史消息（不在 live）直接完整渲染，不重播打字。
 */
const AssistantRow = memo(function AssistantRow({
  message,
  outputting,
  busy,
  thinking,
  onToggleThinking,
}: {
  message: UiMessage;
  outputting: boolean;
  busy: boolean;
  thinking?: ThinkingTurn;
  onToggleThinking: (id: number) => void;
}) {
  // live 用全局 outputting 标志：final-answer 流式阶段恒为 true，且同一时刻只有
  // 一个答案在流式；已完成的旧答案 text 稳定 → RAF 空转、流结束后 snap 完整。
  // 不依赖「是否最后一条」，避免流式途中插入 system 提示导致气泡失去末位而提前 snap。
  const live = outputting;
  const shown = useTypewriter(message.text, live);
  const showOutputting = outputting && message.text.trim() === '';
  const showThinkingFallback = busy && !outputting && message.text.trim() === '';
  return (
    <div className="row assistant">
      <img className="avatar assistant" src="/agent-avatar.png" alt="" aria-hidden />
      <div className="msg-col">
        <div className="msg-name">DeepSeek 助手</div>
        {thinking && <ThinkingCard turn={thinking} onToggle={onToggleThinking} />}
        <div className={`bubble ${showOutputting ? 'outputting' : ''} ${message.phase === 'progress' ? 'dim' : ''} ${message.interrupted ? 'interrupted' : ''}`}>
          {message.interrupted && (
            <span className="gen-interrupted-badge">
              <StopIcon />
              生成中断
            </span>
          )}
          {showOutputting ? (
            <>
              <span className="thinking-badge" aria-label="输出中">
                <span className="spinner" />
              </span>
              <span className="thinking-inline">输出中…</span>
            </>
          ) : showThinkingFallback ? (
            <>
              <span className="thinking-badge" aria-label="思考中">
                <span className="spinner" />
              </span>
              <span className="thinking-inline">思考中…</span>
            </>
          ) : (
            <>
              <MarkdownView text={shown} />
            </>
          )}
        </div>
      </div>
    </div>
  );
});

/** 用户消息行（记忆化：未变化的消息直接跳过重渲染，长对话流式时不放大开销） */
const UserRow = memo(function UserRow({ message, userName, userInitial }: { message: UiMessage; userName: string; userInitial: string }) {
  const { text, attachments } = parseUserAttachments(message.text);
  return (
    <div className="row user">
      <div className="msg-col user">
        <div className="msg-name">{userName}</div>
        <div className="bubble user">
          {text && <div className="bubble-text">{text}</div>}
          {attachments.length > 0 && (
            <div className="bubble-attachments">
              {attachments.map((a, i) => (
                <span className="bubble-attachment" key={i} title={a.path}>
                  <svg className="bubble-attachment-icon" width="12" height="12" viewBox="0 0 16 16" aria-hidden>
                    <path
                      d="M10.5 2.5l3 3a1.5 1.5 0 0 1 0 2.1l-5.5 5.5a2 2 0 0 1-2.8-2.8l5.5-5.5a.8.8 0 0 0-1.1-1.1l-5.5 5.5a3.5 3.5 0 0 0 5 5l5.5-5.5a5 5 0 0 0-7-7l-3 3"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.4"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                  <span className="bubble-attachment-name">{a.name}</span>
                </span>
              ))}
            </div>
          )}
        </div>
      </div>
      <div className="avatar user" aria-hidden>{userInitial}</div>
    </div>
  );
});

/** 系统 / 工具 / 错误提示条（记忆化） */
const NoteRow = memo(function NoteRow({ message }: { message: UiMessage }) {
  const noteClass = message.role === 'error' ? 'err' : message.role === 'tool' ? 'tool' : 'sys';
  // 多行 system 消息（如 /cost 用量读数）用等宽 + 保留换行
  const monoCls = message.text.includes('\n') ? ' mono' : '';
  return (
    <div className="row note-row">
      <div className={`note ${noteClass}${monoCls}`}>{message.text}</div>
    </div>
  );
});

function ChatAreaInner({ messages, busy, outputting, thinkings, onToggleThinking, username }: ChatAreaProps, ref: Ref<HTMLDivElement>) {
  const userName = username || '我';
  /** 用户头像缩写：取前 2 个 grapheme cluster（中文 2 字 / 英文 2 字） */
  const userInitial = (() => {
    if (!userName || userName === '我') return '我';
    const chars = Array.from(userName);
    return (chars[0] ?? '') + (chars[1] ?? '');
  })();

  // 已被答案气泡匹配的思考轮次 id（避免活跃轮同时以「独立卡」和「气泡上方卡」重复渲染）
  const matchedTurnIds = new Set(
    messages.filter((m) => m.role === 'assistant' && typeof m.thinkingId === 'number').map((m) => m.thinkingId as number),
  );
  // 活跃且尚未匹配到答案气泡的思考轮次（思考/输出中阶段，答案气泡尚未创建）
  const activeUnmatched = thinkings.length > 0 ? thinkings[thinkings.length - 1] : undefined;
  const showActiveCard = busy && activeUnmatched && activeUnmatched.status !== 'done' && !matchedTurnIds.has(activeUnmatched.turnId);

  // 分段渲染（性能优化 #3）：历史很长时只渲染最近一段（tail），避免一次性把成百上千
  // 条消息的 DOM 全塞进页面（长对话生成时不卡顿）。其余历史折叠为一个可点击提示，
  // 用户主动上滑阅读时再按需展开——避免强制渲染全部历史拖慢流式。
  const TAIL_LIMIT = 60;
  const [expanded, setExpanded] = useState(false);
  const firstIdRef = useRef<number | undefined>(messages[0]?.id);
  useEffect(() => {
    // 任务整体切换（首条消息 id 变化）→ 收起历史，回到 tail 视图
    if (messages[0]?.id !== firstIdRef.current) {
      firstIdRef.current = messages[0]?.id;
      setExpanded(false);
    }
  }, [messages]);
  const showAll = expanded || messages.length <= TAIL_LIMIT;
  const visibleMessages = showAll ? messages : messages.slice(-TAIL_LIMIT);
  const hiddenCount = messages.length - visibleMessages.length;

  return (
    <div className="messages" ref={ref}>
      <div className="messages-inner">
        {messages.length === 0 && (
          <div className="empty">
            <div className="empty-glyph" aria-hidden><MessageSquare size={28} /></div>
            直接输入你的问题或任务，我来帮你完成。<br />
            比如：「用中文讲讲闭包」或「帮我看看这段代码有什么问题」。<br />
            <span className="empty-hint">按 <kbd>⌘</kbd><kbd>K</kbd> 打开命令面板，快速切换模式 / 风格 / 查看用量</span>
          </div>
        )}
        {!showAll && hiddenCount > 0 && (
          <button type="button" className="history-gap" onClick={() => setExpanded(true)}>
            上方还有 {hiddenCount} 条历史记录，点击展开
          </button>
        )}
        {visibleMessages.filter(Boolean).map((m) => {
          if (m.role === 'assistant') {
            const thinking = typeof m.thinkingId === 'number' ? thinkings.find((t) => t.turnId === m.thinkingId) : undefined;
            return (
              <AssistantRow
                key={m.id}
                message={m}
                outputting={outputting}
                busy={busy}
                thinking={thinking}
                onToggleThinking={onToggleThinking}
              />
            );
          }
          if (m.role === 'user') {
            return <UserRow key={m.id} message={m} userName={userName} userInitial={userInitial} />;
          }
          // system / tool / error：居中轻量提示条
          return <NoteRow key={m.id} message={m} />;
        })}
        {/* 活跃思考轮次尚未匹配到答案气泡时，作为独立卡片渲染在底部（答案气泡出现后自动转为气泡上方卡）。
            包在 .row.assistant 里 → 左侧带智能体头像 + 名字，与最终答案气泡视觉上连贯。 */}
        {showActiveCard && activeUnmatched && (
          <div className="row assistant">
            <img className="avatar assistant" src="/agent-avatar.png" alt="" aria-hidden />
            <div className="msg-col">
              <div className="msg-name">DeepSeek 助手</div>
              <ThinkingCard turn={activeUnmatched} onToggle={onToggleThinking} />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export const ChatArea = forwardRef<HTMLDivElement, ChatAreaProps>(ChatAreaInner);
ChatArea.displayName = 'ChatArea';
