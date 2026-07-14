import { Box, Text } from 'ink';
import { useMemo } from 'react';
import type { HistoryItem } from './load-history.ts';

/** 维度配色：呼应 Visualizer 调色板（蓝/橙/紫/绿） */
const C = {
  project: '#2f6fb0',
  model: '#c9772f',
  source: '#7a5cc8',
  time: '#3b9d57',
  kpi: '#2f6fb0',
};
const MAX_BAR = 22;

function fmtDate(ms: number): string {
  if (!ms) return '—';
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

interface Agg {
  label: string;
  value: number;
}

/** 横向条形图（终端字符实现）：深色填充块 + 白字数值，呼应「深色框 + 白字」偏好 */
function BarChart({ title, color, data }: { title: string; color: string; data: Agg[] }) {
  const max = data.reduce((m, d) => Math.max(m, d.value), 0) || 1;
  return (
    <Box flexDirection="column" marginY={0}>
      <Text bold color={color}>{`▸ ${title}`}</Text>
      {data.length === 0 ? (
        <Text dimColor>  （空）</Text>
      ) : (
        data.map((d, i) => {
          const len = d.value > 0 ? Math.max(1, Math.round((d.value / max) * MAX_BAR)) : 0;
          return (
            <Box key={i}>
              <Text color="#9aa0a6">{d.label.padEnd(20).slice(0, 20)} </Text>
              <Text backgroundColor={color} color="white">
                {len > 0 ? '█'.repeat(len) : '·'}
              </Text>
              <Text color="#9aa0a6"> {d.value}</Text>
            </Box>
          );
        })
      )}
    </Box>
  );
}

/** 单个 KPI 卡片（圆角边框） */
function Kpi({ label, value, sub }: { label: string; value: string | number; sub?: string }) {
  return (
    <Box borderStyle="round" borderColor={C.kpi} paddingX={2} flexDirection="column">
      <Text bold color={C.kpi}>{value}</Text>
      <Text color="#9aa0a6">{label}</Text>
      {sub ? <Text dimColor>{sub}</Text> : null}
    </Box>
  );
}

/** 纯函数：按关键字筛选并按时序倒序排列历史记录 */
export function filterAndSortItems(items: HistoryItem[], filter: string): HistoryItem[] {
  const f = filter.trim().toLowerCase();
  const base = f
    ? items.filter(
        (it) =>
          it.title.toLowerCase().includes(f) ||
          it.cwd.toLowerCase().includes(f) ||
          (it.model ?? '').toLowerCase().includes(f) ||
          (it.sourceMode ?? '').toLowerCase().includes(f),
      )
    : items;
  return [...base].sort((a, b) => b.createdAt - a.createdAt);
}

export function HistoryPanel(props: {
  items: HistoryItem[];
  loading: boolean;
  error: string | null;
  filter: string;
  selectedIdx: number;
  /** 当前正在进行的主会话 trace id（= .dsa/traces/<id>.jsonl 文件名）；命中即标记为「● 当前」 */
  currentSessionId?: string;
}) {
  const { items, loading, error, filter, selectedIdx, currentSessionId } = props;

  const filtered = useMemo(() => filterAndSortItems(items, filter), [items, filter]);

  const stats = useMemo(() => {
    const models = new Set(items.map((i) => i.model ?? '未知')).size;
    const msgs = items.reduce((s, i) => s + (i.messageCount ?? 0), 0);
    let span = '—';
    if (items.length > 1) {
      const ts = items.map((i) => i.createdAt).filter(Boolean);
      const days = Math.round((Math.max(...ts) - Math.min(...ts)) / 86_400_000);
      span = days > 0 ? `${days} 天` : '<1 天';
    }
    return { total: items.length, models, msgs, span };
  }, [items]);

  const charts = useMemo(() => {
    const byKey = (key: (i: HistoryItem) => string) => {
      const m = new Map<string, number>();
      for (const it of filtered) m.set(key(it), (m.get(key(it)) ?? 0) + 1);
      return [...m.entries()]
        .map(([label, value]) => ({ label, value }))
        .sort((a, b) => b.value - a.value);
    };
    const statusLabel = (s: string) => (s === 'completed' ? '已完成' : '进行中');
    const byModel = byKey((i) => i.model ?? '未知').slice(0, 8);
    const byPermission = byKey((i) => i.permissionMode ?? '未知').slice(0, 8);
    const byStatus = byKey((i) => statusLabel(i.status)).slice(0, 8);

    // 时间线：最近 14 天
    const now = Date.now();
    const dayMap = new Map<string, number>();
    for (let k = 13; k >= 0; k--) {
      const d = new Date(now - k * 86_400_000);
      const key = fmtDate(d.getTime()).slice(5); // MM-DD
      dayMap.set(key, 0);
    }
    for (const it of filtered) {
      if (!it.createdAt) continue;
      const key = fmtDate(it.createdAt).slice(5);
      if (dayMap.has(key)) dayMap.set(key, (dayMap.get(key) ?? 0) + 1);
    }
    const byTime = [...dayMap.entries()].map(([label, value]) => ({ label, value }));

    return { byModel, byPermission, byStatus, byTime };
  }, [filtered]);

  if (loading) {
    return (
      <Box flexDirection="column" paddingX={1} flexGrow={1}>
        <Text bold color={C.kpi}>历史对话可视化</Text>
        <Text dimColor>读取会话历史中…</Text>
      </Box>
    );
  }

  if (error) {
    return (
      <Box flexDirection="column" paddingX={1} flexGrow={1}>
        <Text bold color={C.kpi}>历史对话可视化</Text>
        <Text color="#ff6b6b">{error}</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" paddingX={1} flexGrow={1}>
      <Text bold color={C.kpi}>{`历史对话可视化 · 共 ${stats.total} 条`}</Text>
      <Text dimColor>
        {filter ? `筛选「${filter}」命中 ${filtered.length} 条` : 'h 切换 · 输入关键字实时筛选 · ↑↓ 浏览 · Enter 加载选中会话并返回 · Esc/← 返回'}
      </Text>
      {!!currentSessionId ? (
        <Text color="#00b8d4">{`● 当前会话高亮（id: ${currentSessionId.slice(0, 22)}${currentSessionId.length > 22 ? '…' : ''}）`}</Text>
      ) : null}

      <Box flexDirection="row" gap={1} marginY={1}>
        <Kpi label="总会话" value={stats.total} />
        <Kpi label="消息总数" value={stats.msgs} />
        <Kpi label="模型数" value={stats.models} />
        <Kpi label="时间跨度" value={stats.span} />
      </Box>

      <BarChart title="按模型" color={C.model} data={charts.byModel} />
      <BarChart title="按权限模式" color={C.source} data={charts.byPermission} />
      <BarChart title="按状态" color={C.project} data={charts.byStatus} />
      <BarChart title="按时间（近 14 天）" color={C.time} data={charts.byTime} />

      <Box flexDirection="column" marginTop={1}>
        <Text bold color="#9aa0a6">{`会话列表（${filtered.length}）`}</Text>
        {filtered.length === 0 ? (
          <Text dimColor>  （无匹配）</Text>
        ) : (
          filtered.slice(0, 60).map((it, i) => {
            const sel = i === selectedIdx;
            const isCurrent = !!currentSessionId && it.id === currentSessionId;
            const badge = isCurrent ? '●当前' : it.status === 'completed' ? '✓' : it.status === 'working' ? '⚙' : '·';
            const badgeColor = isCurrent ? '#00b8d4' : C.kpi;
            return (
              <Text key={it.id} inverse={sel} wrap="wrap">
                <Text color={sel ? undefined : badgeColor} bold={isCurrent}>{` ${badge} `}</Text>
                <Text bold={isCurrent}>{it.title.slice(0, 52)}</Text>
                <Text dimColor>{`  [${it.model ?? '—'}·${it.messageCount}条·${fmtDate(it.createdAt)}]`}</Text>
              </Text>
            );
          })
        )}
      </Box>
    </Box>
  );
}
