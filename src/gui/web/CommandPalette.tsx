import { useEffect, useMemo, useRef, useState } from 'react';
import './CommandPalette.css';

export interface PaletteCommand {
  id: string;
  group: string;
  title: string;
  hint: string;
  run: () => void;
}

interface Props {
  commands: PaletteCommand[];
  onClose: () => void;
}

/**
 * ⌘K / Ctrl+K 命令面板：收纳既有 /mode /plan /style /cost 等命令与少量控制动作。
 * 复用父组件传入的 runCmd / onAbort / openWorkspaceSettings，不重写命令实现。
 * 键盘：↑↓ 导航、↵ 执行、esc 关闭；鼠标 hover 同步高亮。
 */
export default function CommandPalette({ commands, onClose }: Props) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return commands;
    return commands.filter(
      (c) =>
        c.title.toLowerCase().includes(q) ||
        c.hint.toLowerCase().includes(q) ||
        c.group.toLowerCase().includes(q) ||
        c.id.toLowerCase().includes(q),
    );
  }, [query, commands]);

  // 查询变化时把高亮重置到首项
  useEffect(() => {
    setActive(0);
  }, [query]);

  // 打开即聚焦输入框
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // 高亮项滚动进可视区
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${active}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [active, filtered]);

  const runAt = (idx: number) => {
    const cmd = filtered[idx];
    if (!cmd) return;
    cmd.run();
    onClose();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, filtered.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      runAt(active);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  };

  // 把命令按 group 分组展示（保持过滤后的顺序）
  let lastGroup = '';

  return (
    <div className="palette-backdrop" onMouseDown={onClose}>
      <div
        className="palette"
        role="dialog"
        aria-modal="true"
        aria-label="命令面板"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="palette-search">
          <span className="palette-search-glyph" aria-hidden>⌘</span>
          <input
            ref={inputRef}
            className="palette-input"
            placeholder="输入命令或动作…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            aria-controls="palette-list"
            aria-activedescendant={filtered.length ? `palette-opt-${active}` : undefined}
            autoComplete="off"
            spellCheck={false}
          />
          <kbd className="palette-kbd">esc</kbd>
        </div>

        <div className="palette-list" id="palette-list" role="listbox" ref={listRef}>
          {filtered.length === 0 && <div className="palette-empty">无匹配命令</div>}
          {filtered.map((c, i) => {
            const showGroup = c.group !== lastGroup;
            lastGroup = c.group;
            return (
              <div key={c.id}>
                {showGroup && <div className="palette-group">{c.group}</div>}
                <div
                  data-idx={i}
                  id={`palette-opt-${i}`}
                  role="option"
                  aria-selected={i === active}
                  className={`palette-item ${i === active ? 'active' : ''}`}
                  onMouseEnter={() => setActive(i)}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    runAt(i);
                  }}
                >
                  <span className="palette-item-title">{c.title}</span>
                  <span className="palette-item-hint">{c.hint}</span>
                </div>
              </div>
            );
          })}
        </div>

        <div className="palette-footer">
          <span><kbd>↑</kbd><kbd>↓</kbd> 导航</span>
          <span><kbd>↵</kbd> 执行</span>
          <span><kbd>esc</kbd> 关闭</span>
        </div>
      </div>
    </div>
  );
}
