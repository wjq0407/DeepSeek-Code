import chalk from 'chalk';

/**
 * 终端 Markdown 流式渲染器（P5 体验升级）。
 *
 * 行为：在保留流式实时感的前提下，对 Agent 输出做轻量终端渲染：
 * - 代码块（```lang）用语言标签 + 暗色竖线区分，内部内容用灰显避免喧宾夺主
 * - 标题 #/##/### 加粗 + 配色
 * - 无序列表 -/* 转为 •
 * - 行内 **加粗** 与 `行内代码` 着色
 *
 * 关键特性（逐字流式）：
 * - 完整行（遇 \n）立即落定输出；
 * - 尚未换行的「半成品行」通过 `\r\x1b[K` 回车清行 + 重绘，实现逐字冒出效果，
 *   等价于 Claude Code 的实时打字机渲染。
 * - 可选 prefix（如 "Agent> "）仅出现在每段首个完整行，且 in-place 重绘时会保留。
 * - 当半成品行可见宽度超过终端列数（发生折行）时，in-place 重绘会残留，
 *   此时退化为「换行重打」，避免屏幕脏数据。
 */

/** 剥离 ANSI 转义后计算可见宽度（CJK 占 2 宽，与终端一致） */
function displayWidth(s: string): number {
  const strip = s
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '') // SGR / 光标 / 擦除等 \x1b[...<letter>
    .replace(/\x1b\][^\x1b\\]*\x1b\\/g, ''); // OSC \x1b]...\x1b\
  let w = 0;
  for (const ch of strip) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp < 0x20) continue; // 控制字符不计宽
    const wide =
      (cp >= 0x1100 && (cp <= 0x115f ||
        (cp >= 0x2e80 && cp <= 0xa4cf) ||
        (cp >= 0xac00 && cp <= 0xd7a3) ||
        (cp >= 0xf900 && cp <= 0xfaff) ||
        (cp >= 0xff00 && cp <= 0xffe6) ||
        (cp >= 0x3000 && cp <= 0x303f) ||
        (cp >= 0x3040 && cp <= 0x309f) ||
        (cp >= 0x30a0 && cp <= 0x30ff)));
    w += wide ? 2 : 1;
  }
  return w;
}

export interface MarkdownStreamOptions {
  /** 首行前缀（如 "Agent> "），仅出现在每段首个完整行；留空则无前缀 */
  prefix?: string;
}

export class MarkdownStream {
  private inCode = false;
  private codeLang = '';
  private buf = '';
  /** 当前已渲染到屏幕的「半成品行」ANSI 字符串（用于 in-place 重绘） */
  private renderedPartial = '';
  /** 当前段是否已有完整行落定（决定后续行是否带 prefix） */
  private firstLineDone = false;
  private prefix: string;

  constructor(opts?: MarkdownStreamOptions) {
    const p = opts?.prefix?.trim();
    this.prefix = p ? chalk.cyan(p + ' ') : '';
  }

  /** 处理流式文本块，返回应立即输出到终端的渲染字符串（可能为空） */
  write(chunk: string): string {
    this.buf += chunk;
    let out = '';

    // 1) 提交所有完整行（遇 \n）
    let idx = this.buf.indexOf('\n');
    while (idx >= 0) {
      const line = this.buf.slice(0, idx);
      this.buf = this.buf.slice(idx + 1);
      const p = this.firstLineDone ? '' : this.prefix;
      out += p + this.renderLine(line) + '\n';
      this.firstLineDone = true;
      this.renderedPartial = '';
      idx = this.buf.indexOf('\n');
    }

    // 2) 实时渲染剩余半成品行（in-place 重写 → 逐字冒出）
    if (this.buf.length > 0) {
      const p = this.firstLineDone ? '' : this.prefix;
      const r = p + this.renderLine(this.buf);
      if (r !== this.renderedPartial) {
        const prevW = displayWidth(this.renderedPartial);
        const cols = process.stdout.columns || 120;
        if (this.renderedPartial && prevW >= cols) {
          // 已折行：退化为换行重打，避免 in-place 残留
          out += '\n' + r;
        } else {
          out += '\r\x1b[K' + r; // 回车到行首 + 清行 + 重绘
        }
        this.renderedPartial = r;
      }
    }
    return out;
  }

  /** 流结束后刷新剩余缓冲（最后一行可能没有结尾换行） */
  flush(): string {
    if (this.buf.length === 0) {
      this.renderedPartial = '';
      this.firstLineDone = false; // 下一段重新带前缀
      return '';
    }
    const p = this.firstLineDone ? '' : this.prefix;
    const r = p + this.renderLine(this.buf);
    let out = '';
    if (this.renderedPartial) out += '\r\x1b[K';
    out += r;
    this.buf = '';
    this.renderedPartial = '';
    this.firstLineDone = false; // 下一段重新带前缀
    return out;
  }

  private renderLine(line: string): string {
    const trimmed = line.trimStart();

    // 代码块分隔符（进入/退出）
    if (trimmed.startsWith('```')) {
      if (!this.inCode) {
        this.inCode = true;
        this.codeLang = trimmed.slice(3).trim();
        const tag = this.codeLang ? `┌─ ${this.codeLang}` : '┌─ code';
        return chalk.cyan.dim(tag);
      }
      this.inCode = false;
      this.codeLang = '';
      return chalk.cyan.dim('└──────────');
    }

    // 代码块内部：灰显 + 竖线，不做行内渲染（避免与代码示例中的反引号冲突）
    if (this.inCode) {
      return chalk.dim('│ ') + chalk.gray(line);
    }

    // 标题
    const h = trimmed.match(/^(#{1,3})\s+(.*)$/);
    if (h) {
      const level = h[1].length;
      const txt = renderInline(h[2]);
      if (level === 1) return chalk.bold.cyan(txt);
      if (level === 2) return chalk.bold(txt);
      return chalk.bold.gray(txt);
    }

    // 无序列表
    const ul = trimmed.match(/^[-*]\s+(.*)$/);
    if (ul) return chalk.cyan('• ') + renderInline(ul[1]);

    // 有序列表
    const ol = trimmed.match(/^\d+\.\s+(.*)$/);
    if (ol) return '  ' + renderInline(ol[1]);

    // 普通行
    return renderInline(line);
  }
}

/** 行内 Markdown 渲染：行内代码、加粗（函数式替换避免 $ 转义问题） */
export function renderInline(text: string): string {
  let out = text.replace(/`([^`]+)`/g, (_m, c: string) => chalk.cyan(c));
  out = out.replace(/\*\*([^*]+)\*\*/g, (_m, c: string) => chalk.bold(c));
  return out;
}
