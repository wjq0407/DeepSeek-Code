import path from 'node:path';
import { stat } from 'node:fs/promises';
import type { ToolDef } from './index.ts';
import { DeepSeekClient } from '../llm/deepseek.ts';
import { runCodeVerify } from './code-verify.ts';

/**
 * verify_code — 轻量级代码正确性验证（双模型质量门）。
 *
 * 定位：review_code 的「快速版」。review_code 做全维度深度审查（reasoning=high），
 * verify_code 做聚焦式正确性检查（reasoning=medium），成本约 review_code 的 60%。
 *
 * 与 review_code 的区别：
 * | 维度     | review_code                 | verify_code              |
 * |----------|----------------------------|--------------------------|
 * | 范围     | 全维度（逻辑/安全/命名/性能） | 聚焦正确性+安全性        |
 * | 深度     | reasoning=high              | reasoning=medium         |
 * | 格式     | 结构化 Markdown 审查报告     | 简洁 pass/fail + issues  |
 * | 延迟     | 10-15s                      | 5-8s                     |
 * | 适用     | 显式审查请求、发布前         | 写完即查（高频自动触发） |
 *
 * 注：本工具的「验证逻辑」已抽到 code-verify.ts（runCodeVerify），
 * 文件写后自动校验（create_file/edit_file）也复用同一份逻辑，避免重复与循环依赖。
 * 这里只负责把参数透传 + 当入口。
 */

function resolve(p: string, cwd: string): string {
  const abs = path.isAbsolute(p) ? p : path.resolve(cwd, p);
  const rel = path.relative(cwd, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`路径遍历拒绝：${p} 不在工作目录内（cwd=${cwd}）`);
  }
  return abs;
}

export function createVerifyCodeTool(client: DeepSeekClient): ToolDef {
  return {
    name: 'verify_code',
    description:
      '【双模型质量门】对刚写完的代码做快速正确性验证（比 review_code 更轻量）。聚焦逻辑正确性和安全隐患，不审查命名/风格/注释。适合写完代码后自动触发——验证通过则继续，不通过则修正。',
    risk: 'low',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '要验证的文件路径' },
        goal: {
          type: 'string',
          description: '这段代码要达成的目标（一句话），帮助验证器判断是否正确实现。如「实现一个线程安全的 LRU 缓存」',
        },
        focus: {
          type: 'string',
          description: '验证重点，可选。如「并发安全」「输入校验」「错误处理」，默认综合验证',
        },
      },
      required: ['path'],
    },
    async execute(args, ctx) {
      const target = resolve(String(args.path), ctx.cwd);
      try {
        const s = await stat(target);
        if (!s.isFile()) {
          return { ok: false, output: `路径无效或不是文件: ${target}` };
        }
        const out = await runCodeVerify(client, target, {
          goal: args.goal ? String(args.goal) : undefined,
          focus: args.focus ? String(args.focus) : undefined,
          signal: ctx.signal,
        });
        if (!out.ran) {
          return { ok: true, output: `# 快速验证 (verify_code)\n文件: ${target}\n\n（无需验证：空文件或不可读）` };
        }
        return { ok: true, output: out.rendered };
      } catch (e: unknown) {
        return { ok: false, output: `验证失败: ${e instanceof Error ? e.message : String(e)}` };
      }
    },
  };
}
