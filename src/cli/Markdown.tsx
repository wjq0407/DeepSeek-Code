import { Box, Text } from 'ink';
import { useMemo, type ReactNode } from 'react';
import type { MsgRole } from './app.tsx';

/**
 * ink 版 Markdown 渲染器（替代 utils/markdown.ts 的 chalk/ANSI 版）。
 *
 * 把 Agent 输出的 Markdown 标记渲染为真正的 ink 样式节点，而不是把星号原样吐出：
 *   - **加粗**      → <Text bold>
 *   - *斜体*        → <Text italic>
 *   - `行内代码`    → <Text color="cyan">
 *   - # 标题        → 加粗 + 配色
 *   - - 列表项      → • 前缀
 *   - ```代码块```  → 边框 + 灰显，内部不做行内渲染（避免与示例中的反引号冲突）
 *
 * 仅用于 assistant 消息；tool / user 等机器/原始内容不应被 markdown 化。
 */

/** 行内解析：把加粗/斜体/行内代码/删除线转换为 ink 节点数组（纯函数、可递归嵌套） */
function renderInline(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  // 顺序：加粗 **x** → 斜体 *x* → 行内代码 `x` → 删除线 ~~x~~
  const re = /(\*\*([\s\S]+?)\*\*|\*([\s\S]+?)\*|`([^`]+)`|~~([\s\S]+?)~~)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) nodes.push(text.slice(last, m.index));
    if (m[2] !== undefined) {
      nodes.push(<Text key={i++} bold>{renderInline(m[2])}</Text>);
    } else if (m[3] !== undefined) {
      nodes.push(<Text key={i++} italic>{renderInline(m[3])}</Text>);
    } else if (m[4] !== undefined) {
      nodes.push(<Text key={i++} color="cyan">{m[4]}</Text>);
    } else if (m[5] !== undefined) {
      nodes.push(<Text key={i++} strikethrough>{renderInline(m[5])}</Text>);
    }
    last = re.lastIndex;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

interface BuildOpts {
  isProgress: boolean;
  prefix: string;
  roleColor?: string;
}

/** 把整段文本按块解析为 ink 节点数组（纯函数，结果由组件 useMemo 缓存） */
function buildBlocks(text: string, opts: BuildOpts): ReactNode[] {
  const { isProgress, prefix, roleColor } = opts;
  const lines = text.split('\n');
  const blocks: ReactNode[] = [];
  let inCode = false;
  let codeLang = '';
  let codeBuf: string[] = [];
  let firstText = true;
  let key = 0;

  const flushCode = () => {
    if (!codeBuf.length) return;
    blocks.push(
      <Box key={key++} flexDirection="column">
        <Text color="cyan" dimColor>{codeLang ? `┌─ ${codeLang}` : '┌─ code'}</Text>
        {codeBuf.map((l, idx) => (
          <Text key={idx} color="gray">{'│ ' + l}</Text>
        ))}
        <Text color="cyan" dimColor>{'└──────────'}</Text>
      </Box>
    );
    codeBuf = [];
  };

  for (const line of lines) {
    const trimmed = line.trimStart();

    // 代码块分隔符（进入/退出）
    if (trimmed.startsWith('```')) {
      if (!inCode) {
        inCode = true;
        codeLang = trimmed.slice(3).trim();
      } else {
        inCode = false;
        flushCode();
      }
      continue;
    }
    // 代码块内部：原样灰显，不做行内渲染
    if (inCode) {
      codeBuf.push(line);
      continue;
    }

    // 标题 # ~ ######
    const h = trimmed.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      const lvl = h[1].length;
      const color = lvl <= 1 ? 'cyan' : lvl === 2 ? undefined : 'gray';
      blocks.push(
        <Text key={key++} bold color={color} dimColor={isProgress}>
          {firstText && prefix ? <Text color={roleColor}>{prefix}</Text> : null}
          {renderInline(h[2])}
        </Text>
      );
      firstText = false;
      continue;
    }

    // 无序列表 - / *
    const ul = trimmed.match(/^[-*]\s+(.*)$/);
    if (ul) {
      blocks.push(
        <Text key={key++} dimColor={isProgress}>
          {firstText && prefix ? <Text color={roleColor}>{prefix}</Text> : null}
          {'• '}
          {renderInline(ul[1])}
        </Text>
      );
      firstText = false;
      continue;
    }

    // 有序列表 1. 2.
    const ol = trimmed.match(/^(\d+)\.\s+(.*)$/);
    if (ol) {
      blocks.push(
        <Text key={key++} dimColor={isProgress}>
          {firstText && prefix ? <Text color={roleColor}>{prefix}</Text> : null}
          {ol[1] + '. '}
          {renderInline(ol[2])}
        </Text>
      );
      firstText = false;
      continue;
    }

    // 普通行
    blocks.push(
      <Text key={key++} wrap="wrap" dimColor={isProgress}>
        {firstText && prefix ? <Text color={roleColor}>{prefix}</Text> : null}
        {renderInline(line)}
      </Text>
    );
    firstText = false;
  }

  if (inCode) flushCode(); // 流未闭合的代码块也按代码块渲染，避免丢内容
  return blocks;
}

export function MarkdownMessage(props: {
  text: string;
  role: MsgRole;
  phase?: 'progress' | 'final';
}) {
  const { text, role, phase } = props;
  const isProgress = role === 'assistant' && phase === 'progress';
  const prefix =
    role === 'user' ? '你> '
    : role === 'tool' || role === 'system' || role === 'error' ? ''
    : isProgress ? '⋯ ' : 'Agent> ';
  const roleColor =
    role === 'user' ? '#7ec8e3'
    : role === 'error' ? '#ff6b6b'
    : role === 'tool' ? '#d98cff'
    : role === 'system' ? '#9aa0a6'
    : '#e8e8e8'; // assistant 前缀色（正文为默认白，与原实现一致）

  // text 不变则不重算，避免长会话每次重渲染都重新解析
  const blocks = useMemo(
    () => buildBlocks(text, { isProgress, prefix, roleColor }),
    [text, isProgress, prefix, roleColor]
  );

  return <Box flexDirection="column">{blocks}</Box>;
}
