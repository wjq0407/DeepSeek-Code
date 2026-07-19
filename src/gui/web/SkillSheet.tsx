import { useEffect, useRef, useState } from 'react';
import { Blocks } from 'lucide-react';
import './SkillSheet.css';

/** 后端推来的单条技能元数据（与 src/skills/types.ts::SkillMeta 对齐） */
export interface SkillMetaItem {
  name: string;
  description: string;
  scope: 'project' | 'global';
}

/** 技能过滤状态（与后端 getFilterInfo 对齐，仅前端需要的字段） */
export interface SkillFilter {
  includeGlobal: boolean;
  allow: string[] | null;
  source: 'constructor' | 'env' | 'config' | 'all' | 'off';
  description: string;
}

export interface SkillSheetProps {
  open: boolean;
  metas: SkillMetaItem[];
  filter: SkillFilter | null;
  onClose: () => void;
  /** 点选某个技能后回调：把技能名交给父组件去填到输入框 */
  onPick: (skill: SkillMetaItem) => void;
}

/**
 * 底部上拉菜单（Bottom Sheet）：展示可用技能列表，点选后自动把技能名
 * 填入输入框。点击遮罩或关闭按钮可关闭。
 * 动画：translateY + opacity + 遮罩 fade；用 CSS class 切换实现。
 */
export function SkillSheet({ open, metas, filter, onClose, onPick }: SkillSheetProps) {
  // 关闭动画需先把 DOM 节点保留到 transition 结束（约 220ms）
  const [mounted, setMounted] = useState(open);
  const [keyword, setKeyword] = useState('');
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (open) {
      setMounted(true);
      // 等挂载后再 focus，让初始 transform 动画就位
      const t = setTimeout(() => inputRef.current?.focus(), 50);
      return () => clearTimeout(t);
    }
    const t = setTimeout(() => setMounted(false), 240);
    return () => clearTimeout(t);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!mounted) return null;

  const filtered = keyword.trim()
    ? metas.filter(
        (m) =>
          m.name.toLowerCase().includes(keyword.toLowerCase()) ||
          m.description.toLowerCase().includes(keyword.toLowerCase()),
      )
    : metas;

  const empty = metas.length === 0;

  return (
    <div
      className={`skill-sheet-root ${open ? 'is-open' : 'is-closing'}`}
      role="dialog"
      aria-modal="true"
      aria-label="选择技能"
    >
      {/* 遮罩：点击关闭 */}
      <div className="skill-sheet-backdrop" onClick={onClose} aria-hidden />

      <div className="skill-sheet" onClick={(e) => e.stopPropagation()}>
        {/* 拖拽手柄 + 关闭按钮 */}
        <div className="skill-sheet-handle-row">
          <div className="skill-sheet-handle" aria-hidden />
          <button
            type="button"
            className="skill-sheet-close"
            onClick={onClose}
            title="关闭"
            aria-label="关闭"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <div className="skill-sheet-header">
          <div className="skill-sheet-title">
            <span className="skill-sheet-title-glyph" aria-hidden><Blocks size={16} /></span>
            <span>选择技能</span>
          </div>
          <div className="skill-sheet-sub">
            点选一个技能 → 把技能名填入输入框 → 描述任务发送，AI 会按该技能执行。
          </div>
        </div>

        {/* 搜索 */}
        <div className="skill-sheet-search">
          <input
            ref={inputRef}
            className="skill-sheet-search-input"
            type="text"
            placeholder="搜索技能名 / 描述…"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
          />
        </div>

        {/* 过滤状态（仅当存在全局白名单过滤时提示） */}
        {filter && filter.includeGlobal && filter.allow !== null && (
          <div className="skill-sheet-filter-tip">
            全局白名单：{filter.allow.length > 0 ? filter.allow.join('、') : '（全部排除）'}
            {filter.source !== 'all' && <span className="skill-sheet-filter-source">· 来源 {filter.source}</span>}
          </div>
        )}

        {/* 技能列表 */}
        <div className="skill-sheet-list" role="listbox" aria-label="可用技能">
          {empty ? (
            <div className="skill-sheet-empty">
              <div className="skill-sheet-empty-emoji" aria-hidden>📭</div>
              <div className="skill-sheet-empty-title">暂无可用技能</div>
              <div className="skill-sheet-empty-hint">
                把技能目录放到 <code>~/.workbuddy/skills/</code>（全局）<br />
                或 <code>&lt;cwd&gt;/.workbuddy/skills/</code>（项目级），重启后会自动加载。
              </div>
            </div>
          ) : filtered.length === 0 ? (
            <div className="skill-sheet-empty">
              <div className="skill-sheet-empty-title">无匹配技能</div>
              <div className="skill-sheet-empty-hint">换个关键字试试</div>
            </div>
          ) : (
            filtered.map((m) => (
              <button
                type="button"
                key={`${m.scope}::${m.name}`}
                className="skill-sheet-item"
                onClick={() => onPick(m)}
                role="option"
                aria-selected={false}
                title="点击填入输入框"
              >
                <div className="skill-sheet-item-top">
                  <span className={`skill-sheet-item-scope scope-${m.scope}`}>
                    {m.scope === 'project' ? '项目' : '全局'}
                  </span>
                  <span className="skill-sheet-item-name">{m.name}</span>
                </div>
                <div className="skill-sheet-item-desc">{m.description}</div>
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
