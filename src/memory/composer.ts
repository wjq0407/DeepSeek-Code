import type { MemoryEntry } from './types.ts';

/**
 * 把记忆组装进系统提示词。
 *
 * 对应我们聊的「拼接上下文」环节：记忆是注入给 LLM 的「常驻背景」，
 * 与工具调用的检索结果分开。两段事实分别标注作用域（用户全局 / 项目），
 * 并保留护栏——模型仍以当前问题为主，不被陈旧记忆带偏。
 *
 * 若两类记忆都为空，原样返回 base（不注入空段落）。
 */
export function composeSystemPrompt(
  base: string,
  userFacts: string,
  projectFacts: string,
  retrieved: MemoryEntry[],
): string {
  const blocks: string[] = [base];

  if (userFacts) {
    blocks.push(
      '\n# 用户全局记忆（常驻事实，来自 ~/.dsa/memory/MEMORY.md）\n' +
        '以下是跨所有项目的用户偏好与习惯，回答时优先遵循：\n' +
        userFacts,
    );
  }

  if (projectFacts) {
    blocks.push(
      '\n# 项目记忆（常驻事实，来自 .dsa/memory/MEMORY.md）\n' +
        '以下是本项目约定与用户偏好，回答时优先遵循：\n' +
        projectFacts,
    );
  }

  if (retrieved.length > 0) {
    const items = retrieved.map((e) => `- ${e.content}`).join('\n');
    blocks.push(
      '\n# 相关历史记忆（语义召回，仅供参考）\n' +
        '以下是从历史记忆中检索到的相关条目，若与当前问题相关可借鉴，不相关则忽略：\n' +
        items,
    );
  }

  return blocks.join('\n');
}
