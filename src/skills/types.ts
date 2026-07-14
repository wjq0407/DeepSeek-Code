/**
 * Skill 子系统类型定义。
 *
 * 一个 skill 是一个目录，含 SKILL.md（YAML frontmatter: name/description + markdown 正文）
 * 与可选的 scripts/ references/ assets/ 打包资源。系统提示词常驻「可用技能清单」(name+description)，
 * 模型按需调用 use_skill 工具加载某个 skill 的完整正文（渐进式披露，避免无用 skill 占用上下文）。
 */

/** 技能作用域：project = 项目级（<cwd>/.workbuddy/skills/）；global = 用户全局（~/.workbuddy/skills/）。 */
export type SkillScope = 'project' | 'global';

/** 注入系统提示词的精简元数据（始终可见）。 */
export interface SkillMeta {
  name: string;
  description: string;
  /** 作用域：决定技能来自项目目录还是用户全局目录 */
  scope: SkillScope;
}

/** 完整加载后的 skill（含正文与打包资源位置）。 */
export interface Skill {
  name: string;
  description: string;
  /** 技能目录的绝对路径 */
  dir: string;
  /** 作用域：project 随项目提交，global 跨项目复用 */
  scope: SkillScope;
  /** SKILL.md 中 frontmatter 之后的全部 markdown 正文 */
  body: string;
  /** 打包资源子目录是否存在 */
  hasScripts: boolean;
  hasReferences: boolean;
  hasAssets: boolean;
}
