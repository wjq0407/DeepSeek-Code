// 输出风格：控制 Agent 最终答复的「说话方式」。
// 三种风格：
//   human        —— 面向普通用户的人话（生活化类比、讲清做了什么/为什么/怎么验证）
//   professional —— 专业领域的专业语言（术语准确、严谨、适合工程师阅读）
//   raw          —— 不注入任何风格指令（保留模型默认输出）
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export type OutputStyle = 'human' | 'professional' | 'raw';

const VALID: OutputStyle[] = ['human', 'professional', 'raw'];
const DEFAULT_STYLE: OutputStyle = 'human';

/** 风格中文标签（用于状态栏/提示） */
export function styleLabel(style: OutputStyle): string {
  return style === 'human' ? '人话' : style === 'professional' ? '专业语言' : '原始';
}

/** 注入到对话的指令文本；raw 返回 null（不注入）。 */
export function styleInstruction(style: OutputStyle): string | null {
  if (style === 'human') {
    return [
      '【输出风格：面向用户的人话】你的最终答复请用普通用户能听懂的大白话：',
      '- 用生活化的类比解释技术概念，避免堆砌专业术语（必要的术语需当场用一句人话解释）；',
      '- 必须讲清三件事：你做了什么、为什么这么做、怎么验证的；',
      '- 段落连贯、可读性强，像在跟同事面对面解释；不要只罗列零散要点、不要只甩代码块和命令。',
    ].join('\n');
  }
  if (style === 'professional') {
    return [
      '【输出风格：专业领域的专业语言】你的最终答复请使用对应专业领域的规范术语与严谨表述：',
      '- 术语准确、口径一致，直接切入要点，适合有一定基础的工程师阅读；',
      '- 可保留必要的技术细节、函数签名、命令与代码片段；',
      '- 结构清晰（必要时用编号/小节），结论先行。',
    ].join('\n');
  }
  return null;
}

function styleFile(cwd: string): string {
  return join(cwd, '.dsa', 'output-style.json');
}

/** 读取持久化的输出风格；文件缺失/非法时回退默认 human。 */
export function loadStyle(cwd: string): OutputStyle {
  try {
    const raw = readFileSync(styleFile(cwd), 'utf8');
    const parsed = JSON.parse(raw) as { style?: unknown };
    if (typeof parsed.style === 'string' && (VALID as string[]).includes(parsed.style)) {
      return parsed.style as OutputStyle;
    }
  } catch {
    // 文件不存在或解析失败 → 忽略
  }
  return DEFAULT_STYLE;
}

/** 持久化输出风格到 <cwd>/.dsa/output-style.json（目录自动创建）。 */
export function saveStyle(cwd: string, style: OutputStyle): void {
  const fp = styleFile(cwd);
  try {
    mkdirSync(dirname(fp), { recursive: true });
    writeFileSync(fp, JSON.stringify({ style }), 'utf8');
  } catch {
    // 写入失败不阻断会话（仅丢失偏好持久化）
  }
}

/** 校验用户输入的风格字符串是否合法。 */
export function parseStyle(input: string): OutputStyle | null {
  const v = input.trim().toLowerCase();
  return (VALID as string[]).includes(v) ? (v as OutputStyle) : null;
}
