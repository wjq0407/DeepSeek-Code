/**
 * AgentPrompt — 智能体向用户发起询问的浮层 UI
 *
 * 设计要点（2026-07-18）：
 * - 16:9 固定比例（默认 480×270px），不被内容撑开
 * - 浮在所有聊天内容之上（position: fixed；z-index 高于 chat module）
 * - 从下至上的非线性入场动画（cubic-bezier ease-out 0.32s）
 * - 内容超出容器时单行 ellipsis 截断，无滚动条、无 UI 变形
 * - 两种模式：confirm（y/n 二选一） / asktext（自由输入）
 * - 移动端自适应：宽度 90vw，高度按 16:9 算
 */
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Check, X, Send } from 'lucide-react';
import './AgentPrompt.css';

export interface AgentPromptProps {
  /** 询问内容（纯文本）。超出容器以 ellipsis 截断。 */
  prompt: string;
  /** 询问类型：二选一确认（y/n） 或 自由输入 */
  mode: 'confirm' | 'asktext';
  /** 智能体在向用户问什么（标题栏左侧 badge），如"权限询问" */
  label?: string;
  /** 关闭并提交结果（confirm=true，asktext=输入文本） */
  onSubmit: (value: boolean | string) => void;
}

const W = 480;
const H = 270; // 16:9

export function AgentPrompt(props: AgentPromptProps) {
  const { prompt, mode, label = '智能体询问', onSubmit } = props;
  /** 关闭动画期间保留在 DOM：true→false 持续到动画结束 */
  const [mounted, setMounted] = useState(true);
  /** 关闭动画标记 */
  const [closing, setClosing] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const [askVal, setAskVal] = useState('');

  // 自动聚焦输入框
  useEffect(() => {
    if (mode === 'asktext' && inputRef.current && mounted && !closing) {
      inputRef.current.focus();
    }
  }, [mode, mounted, closing]);

  // Esc 取消
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape' && mounted && !closing) {
        e.preventDefault();
        triggerClose(mode === 'confirm' ? false : '');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, mounted, closing]);

  /** 触发关闭：先播动画再卸载 */
  const triggerClose = (value: boolean | string) => {
    if (closing) return;
    setClosing(true);
    setTimeout(() => {
      setMounted(false);
      onSubmit(value);
    }, 280); // 配合动画时长
  };

  const onInputKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      triggerClose(askVal);
    }
  };

  if (!mounted) return null;

  return (
    <div
      className={`agent-prompt-root ${closing ? 'is-closing' : 'is-open'}`}
      role="dialog"
      aria-modal="true"
      aria-label={label}
    >
      <div className="agent-prompt-mask" onClick={() => triggerClose(mode === 'confirm' ? false : '')} />
      <div
        className="agent-prompt-card"
        style={{ width: `${W}px`, height: `${H}px` }}
      >
        <div className="agent-prompt-header">
          <span className="agent-prompt-label">{label}</span>
          <button
            type="button"
            className="agent-prompt-close"
            onClick={() => triggerClose(mode === 'confirm' ? false : '')}
            title="关闭（Esc）"
            aria-label="关闭"
          >
            <X size={14} />
          </button>
        </div>

        <div className="agent-prompt-body" title={prompt}>
          {prompt}
        </div>

        <div className="agent-prompt-footer">
          {mode === 'confirm' ? (
            <>
              <button
                type="button"
                className="agent-prompt-btn agent-prompt-btn-no"
                onClick={() => triggerClose(false)}
                title="否（n / Esc）"
              >
                <X size={14} />
                <span>否</span>
              </button>
              <button
                type="button"
                className="agent-prompt-btn agent-prompt-btn-yes"
                onClick={() => triggerClose(true)}
                title="是（y）"
              >
                <Check size={14} />
                <span>是</span>
              </button>
            </>
          ) : (
            <>
              <input
                ref={inputRef}
                className="agent-prompt-input"
                placeholder="输入回复后回车"
                value={askVal}
                onChange={(e) => setAskVal(e.target.value)}
                onKeyDown={onInputKey}
                maxLength={500}
              />
              <button
                type="button"
                className="agent-prompt-btn agent-prompt-btn-yes"
                onClick={() => triggerClose(askVal)}
                title="发送（Enter）"
                disabled={askVal.trim().length === 0}
              >
                <Send size={14} />
                <span>发送</span>
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
