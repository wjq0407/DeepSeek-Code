/**
 * 通用 JSON 结构化解析器（第 ④ 道防线核心基础设施）。
 *
 * 职责：
 * 1. parseJSON<T> —— 从模型返回文本中提取 JSON 并通过 zod 校验
 * 2. regexExtractJSON<T> —— 从非 JSON 文本中正则抠取含关键字段的 JSON 对象
 * 3. fetchStructured<T> —— 带自修复闭环的结构化输出（解析失败 → 错误注入 → 重试）
 *
 * 设计约束：
 * - 不与具体工具耦合；任何需要「模型返回 → 结构化对象」的工具都可以复用。
 * - 类型驱动：工具只需提供 zod schema，解析器自动做类型转换 + 校验。
 */

import { z } from 'zod';
import type { DeepSeekClient, ChatMessage, JsonSchemaDef } from '../llm/deepseek.ts';

/** 结构化解析结果 */
export interface ParseResult<T> {
  /** 是否成功解析并通过 DataModel 校验 */
  ok: boolean;
  /** 解析后的数据（ok=false 时无意义） */
  data?: T;
  /** 原始模型返回文本（用于自修复反馈） */
  rawText: string;
  /** 解析/校验失败的详细信息（ok=false 时填充） */
  errors?: string[];
}

/** 自修复选项 */
export interface SelfHealOptions {
  /** 最大重试次数（默认 2，总计 maxRetries+1 次调用） */
  maxRetries?: number;
  /** 是否在重试时启用 reasoning 模式提高修复质量 */
  useReasoningOnRetry?: boolean;
  /** PRO 推理模式（首次调用的 effort；复合工具应始终传入以启用深度推理） */
  reasoningEffort?: 'medium' | 'high';
  /** AbortSignal */
  signal?: AbortSignal;
}

/**
 * 通用 JSON 结构化解析。
 *
 * 步骤：
 * 1. 去掉 markdown 代码围栏（```json ... ```）
 * 2. JSON.parse
 * 3. zod schema 校验 + 类型转换（coercion）
 * 4. 返回 ParseResult
 */
export function parseJSON<T>(
  rawText: string,
  schema: z.ZodType<T>,
): ParseResult<T> {
  let jsonStr = rawText.trim();

  // 去掉 markdown 代码围栏
  const fenceMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) jsonStr = fenceMatch[1].trim();

  // JSON.parse
  let rawObj: unknown;
  try {
    rawObj = JSON.parse(jsonStr);
  } catch (e) {
    return {
      ok: false,
      rawText,
      errors: [`JSON 语法错误: ${(e as Error).message}`],
    };
  }

  // zod 校验 + 类型转换
  const result = schema.safeParse(rawObj);
  if (!result.success) {
    return {
      ok: false,
      rawText,
      errors: result.error.issues.map(
        (i) => `字段 ${i.path.length ? i.path.join('.') : '(root)'}: ${i.message}`,
      ),
    };
  }

  return { ok: true, data: result.data, rawText };
}

/**
 * 正则兜底提取——从非 JSON 文本中抓取含关键字段的 {...}。
 *
 * 适用于 assessComplexity 等「模型可能夹带说明文字」的场景——只要文本中
 * 存在一个含指定字段的合法 JSON 对象，就能抠出来解析。
 *
 * @param rawText   模型返回文本（可能含额外说明文字）
 * @param keyField  关键字段名（如 'complex'），用于定位 JSON 块
 * @param schema    zod schema
 */
export function regexExtractJSON<T>(
  rawText: string,
  keyField: string,
  schema: z.ZodType<T>,
): ParseResult<T> {
  const regex = new RegExp(
    `\\{[\\s\\S]*?"${keyField}"\\s*:\\s*(?:true|false|"[^"]*"|-?\\d+)[\\s\\S]*?\\}`,
  );
  const match = rawText.match(regex);
  if (!match) {
    return {
      ok: false,
      rawText,
      errors: [`未找到含字段 "${keyField}" 的 JSON 对象`],
    };
  }
  return parseJSON(match[0], schema);
}

/**
 * 自修复重试的 fix prompt 模板。
 * 将原始输出和校验错误反馈给模型，要求修正后重新输出。
 */
function buildFixPrompt(rawText: string, errors: string[]): string {
  return `你上一次输出解析失败。以下为原始输出和校验错误：

原始输出：
${rawText.slice(0, 2000)}

校验错误：
${errors.map((e) => `\`${e}\``).join('\n')}

请修正上述问题，重新输出完整 JSON 对象。仅输出 JSON，不要包含解释。`;
}

/**
 * P2.8 共享 PRO 前缀：所有 PRO 工具的 system 消息前注入此文本。
 *
 * ~50 token，不含特定工具指令，建立跨工具缓存桥梁。
 * 一次 review_code 调用的缓存可被 verify_answer 在前 50 token 处命中。
 */
export const PRO_COMMON_PREFIX = `你是 DeepSeek Agent 的深度分析模块（使用 v4-pro 模型，启用推理）。
输出必须是严格的 JSON 对象。分析基于提供的事实，结论具体可验证。`;

/**
 * 第 ① 道防线工具：生成末尾锚定格式指令。
 *
 * 利用 Transformer 近因效应——把格式要求放在整体 prompt 的末尾 ~100 token，
 * 显著降低 JSON 格式畸形的概率。
 *
 * @param schemaOneLine  一行 JSON 字段描述，如 'pass:bool, risk:"none"|"low"|"medium"|"high"'
 * @param extraConstraints  可选额外约束（如 "禁止 Markdown，只输出 JSON 对象"）
 * @returns  可注入到最后一个 user message 尾部的文本（约 30–60 token）
 */
export function formatAnchor(
  schemaOneLine: string,
  extraConstraints?: string,
): string {
  const base = `输出策略：只输出一行 JSON 对象，字段 ${schemaOneLine}。`;
  return extraConstraints ? `${base} ${extraConstraints}` : base;
}

/**
 * 带自修复的结构化输出获取器。
 *
 * 流程：
 * 1. 调用 client.complete(jsonSchema:...) → rawText
 * 2. parseJSON(rawText, schema) → ok? 返回 : 继续
 * 3. 构造修复提示：原 rawText + 校验错误 → 发回模型要求修正
 * 4. 最多重试 maxRetries 次（默认 2 次，总计最多 3 次调用）
 *
 * @returns 始终返回 ParseResult<T>（ok=false 表示耗尽重试仍失败）
 */
export async function fetchStructured<T>(
  client: DeepSeekClient,
  messages: ChatMessage[],
  schema: z.ZodType<T>,
  jsonSchemaDef?: JsonSchemaDef,
  opts: SelfHealOptions = {},
): Promise<ParseResult<T>> {
  const maxRetries = opts.maxRetries ?? 2;

  // 首次调用
  let rawText = await client.complete(messages, 0.1, {
    jsonSchema: jsonSchemaDef,
    reasoning: opts.reasoningEffort ? { effort: opts.reasoningEffort } : undefined,
    signal: opts.signal,
  });

  let result = parseJSON(rawText, schema);
  if (result.ok) return result;

  // 自修复循环：将上次错误输出 + 校验反馈 注入请求，再试一次
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const retryMessages: ChatMessage[] = [
      ...messages,
      { role: 'assistant', content: rawText },
      { role: 'user', content: buildFixPrompt(rawText, result.errors ?? []) },
    ];

    rawText = await client.complete(
      retryMessages,
      0.1,
      {
        jsonSchema: jsonSchemaDef,
        reasoning: opts.useReasoningOnRetry ? { effort: opts.reasoningEffort ?? 'medium' } : undefined,
        signal: opts.signal,
      },
    );

    result = parseJSON(rawText, schema);
    if (result.ok) return result;
  }

  return result;
}
