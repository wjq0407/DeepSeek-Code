import type { ToolDef } from './index.ts';
import type { SkillManager } from '../skills/loader.ts';

/**
 * use_skill 工具：模型按名称加载一个已注册技能的完整使用指引。
 *
 * 设计：系统提示词里常驻「可用技能清单」(name+description)，模型判断任务匹配后，
 * 调用本工具取回该技能的正文与打包资源路径（渐进式披露），再按指引执行。
 * skillManager 由宿主（main.ts）注入，避免 skills 模块反向依赖 tools。
 */
export function createUseSkillTool(manager: SkillManager): ToolDef {
  return {
    name: 'use_skill',
    description:
      '【技能加载】按名称加载一个已注册技能的完整使用指引（含其打包的脚本/参考/资产路径）。' +
      '技能分两种作用域：项目级（<cwd>/.workbuddy/skills/，仅当前项目）与全局（~/.workbuddy/skills/，所有项目共用）。' +
      '当任务与系统提示词中「可用技能」列表里的某条描述匹配时，应先调用本工具获取该技能的详细步骤，再按指引执行。' +
      '参数 name 必须是清单中的技能名之一（不区分作用域，同名时项目级优先）。',
    risk: 'low',
    parameters: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: '要加载的技能名称（见系统提示词中的「可用技能」清单，含 [项目]/[全局] 标注）',
        },
      },
      required: ['name'],
    },
    async execute(args): Promise<{ ok: boolean; output: string }> {
      const name = String(args.name ?? '').trim();
      const avail = () =>
        manager
          .listMeta()
          .map((m) => `${m.name}[${m.scope === 'project' ? '项目' : '全局'}]`)
          .join('、') || '(无可用技能)';
      if (!name) {
        return { ok: false, output: `未提供 name 参数。当前可用技能：${avail()}` };
      }
      const text = manager.renderBody(name);
      if (!text) {
        return {
          ok: false,
          output:
            `未找到技能「${name}」。\n当前可用技能：${avail()}\n` +
            `全局过滤状态：${manager.filterDescription()}\n` +
            `若该技能是全局技能且被白名单排除，可运行 /skills allow ${name} 放行，或 /skills list 查看全局目录全部技能。`,
        };
      }
      return { ok: true, output: text };
    },
  };
}
