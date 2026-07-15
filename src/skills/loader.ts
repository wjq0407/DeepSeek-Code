import { readFile, readdir, stat, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { Skill, SkillMeta, SkillScope } from './types.ts';

/** 匹配 SKILL.md 开头的 --- frontmatter --- 块 */
const FRONTMATTER_RE = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?/;

/**
 * 极简 YAML frontmatter 解析（无外部依赖）。
 * 支持 name / description 两种取值形式：
 *  - 双引号包裹：`description: "..."`
 *  - 单引号包裹：`description: '...'`
 *  - 折叠块：`description: >-` 后跟缩进的多行文本（直到缩进结束）
 *  - 纯文本：`description: 一些说明`
 * 其余 key（如 agent_created）会被读取但忽略。
 */
function parseFrontmatter(raw: string): { meta: Record<string, string>; body: string } {
  const m = FRONTMATTER_RE.exec(raw);
  if (!m) return { meta: {}, body: raw.trim() };
  const fm = m[1];
  const body = raw.slice(m[0].length).trim();
  const meta: Record<string, string> = {};
  const lines = fm.split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const keyMatch = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (!keyMatch) {
      i++;
      continue;
    }
    const key = keyMatch[1];
    const val = keyMatch[2];
    // 折叠块指示符：>-  >  >+  |-  |  |+
    if (/^(>(-|\+)?|>|\|(-|\+)?|\|)\s*$/.test(val.trim())) {
      const blockLines: string[] = [];
      i++;
      while (i < lines.length) {
        const bl = lines[i];
        if (bl.trim() === '') {
          blockLines.push('');
          i++;
          continue;
        }
        // 遇到非缩进行即结束折叠块
        if (!bl.startsWith(' ') && !bl.startsWith('\t')) break;
        blockLines.push(bl.replace(/^\s+/, ''));
        i++;
      }
      meta[key] = blockLines.join('\n').trim();
      continue;
    }
    const dq = val.match(/^"(.*)"$/);
    const sq = val.match(/^'(.*)'$/);
    if (dq) meta[key] = dq[1].replace(/\\"/g, '"');
    else if (sq) meta[key] = sq[1].replace(/\\'/g, "'");
    else meta[key] = val.trim();
    i++;
  }
  return { meta, body };
}

async function isDir(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * SkillManager 选项。
 * includeGlobal：是否同时扫描用户全局技能目录（默认 true）。
 * 设 false 可避免把 WorkBuddy 等外部全局技能灌入本 Agent 上下文。
 * 也可用环境变量 DSA_INCLUDE_GLOBAL_SKILLS=0 在运行时关闭。
 * globalDir：覆盖全局技能目录（测试用；默认 os.homedir()/.workbuddy/skills）。
 */
export interface SkillManagerOptions {
  includeGlobal?: boolean;
  /** 全局技能白名单：仅放行列表内的全局技能；项目级不受限。 */
  globalAllow?: string[];
  globalDir?: string;
  /** 覆盖用户主目录（测试用；默认 os.homedir()）。影响 ~/.workbuddy/skills.allow.json 的读取位置。 */
  homeDir?: string;
}

/**
 * SkillManager：会话启动时扫描技能目录，构建注册表。
 *
 * 支持两套作用域（作用域会打标进系统提示词，模型可见区分）：
 *  - project：`<cwd>/.workbuddy/skills/`，随项目提交，仅当前项目可用。
 *  - global ：`~/.workbuddy/skills/`（用户主目录），跨所有项目复用。
 *
 * 同名冲突：项目级覆盖全局级（局部优先）。
 * 全局扫描开关：DSA_INCLUDE_GLOBAL_SKILLS=0 完全关闭。
 * 全局技能白名单：仅放行指定全局技能（排除学术/设计类等无关技能，避免污染编程 Agent 上下文）。
 *   优先级：构造函数 globalAllow > 环境变量 DSA_GLOBAL_SKILLS_ALLOW > 配置文件 ~/.workbuddy/skills.allow.json > 不过滤（全部放行）。
 *   测试时可通过 homeDir 选项覆盖配置文件的读取目录，避免依赖 os.homedir() 缓存。
 */

export class SkillManager {
  private skills = new Map<string, Skill>();
  private shadowed: string[] = []; // 被项目级覆盖掉的全局技能名（仅作记录）
  private scanDone: Promise<void>;
  private readonly projectDir: string;
  private readonly globalDir: string;
  private readonly homeDir: string;
  private readonly allowOption?: string[];
  private globalIncluded = false; // 全局扫描是否开启（扫描后确定）
  private resolvedAllow: Set<string> | null = null; // 配置层解析出的白名单（可能为 null=全部放行）

  constructor(cwd: string, options: SkillManagerOptions = {}) {
    this.projectDir = path.join(cwd, '.workbuddy', 'skills');
    this.globalDir = options.globalDir ?? path.join(os.homedir(), '.workbuddy', 'skills');
    this.homeDir = options.homeDir ?? os.homedir();
    this.allowOption = options.globalAllow;
    const includeGlobal =
      options.includeGlobal ?? process.env.DSA_INCLUDE_GLOBAL_SKILLS !== '0';
    this.scanDone = this.scanAll(includeGlobal);
  }

  /** 等待目录扫描完成（会话启动时应 await，确保注册表就绪后再注入系统提示词）。 */
  async init(): Promise<void> {
    await this.scanDone;
  }

  /**
   * 解析全局技能白名单（异步，因需读配置文件）。优先级：
   * 构造函数 globalAllow > 环境变量 DSA_GLOBAL_SKILLS_ALLOW > 配置文件 > null(不过滤)。
   */
  private async resolveAllow(): Promise<Set<string> | null> {
    if (this.allowOption && this.allowOption.length) {
      return new Set(this.allowOption);
    }
    const env = process.env.DSA_GLOBAL_SKILLS_ALLOW;
    if (env && env.trim()) {
      const set = new Set(
        env
          .split(/[,;\s]+/)
          .map((s) => s.trim())
          .filter(Boolean),
      );
      if (set.size) return set;
    }
    // 用户级配置文件：~/.workbuddy/skills.allow.json → { "allow": ["name", ...] }
    // 注意：显式空数组 [] 表示「排除全部全局技能」；仅当无 allow 字段/无文件时才回退为「全部放行」。
    try {
      const cfgPath = path.join(this.homeDir, '.workbuddy', 'skills.allow.json');
      const raw = await readFile(cfgPath, 'utf8');
      const json = JSON.parse(raw) as { allow?: unknown };
      if (Array.isArray(json.allow)) {
        return new Set(json.allow.map((x) => String(x).trim()).filter(Boolean));
      }
    } catch {
      // 无配置文件或格式错误 → 不过滤
    }
    return null;
  }

  /** 先扫全局（按白名单过滤）、再扫项目（保证项目级同名覆盖全局级）。 */
  private async scanAll(includeGlobal: boolean): Promise<void> {
    this.globalIncluded = includeGlobal;
    this.resolvedAllow = null;
    if (includeGlobal && (await isDir(this.globalDir))) {
      const allow = await this.resolveAllow();
      this.resolvedAllow = allow; // 可能为 null（全部放行）或 Set
      await this.scan(this.globalDir, 'global', allow);
    }
    await this.scan(this.projectDir, 'project', null);
  }

  /**
   * 扫描单个目录。
   * @param allow 白名单集合；非 null 时仅放行集合内技能（仅对 global 作用域生效，project 传 null）。
   */
  private async scan(dir: string, scope: SkillScope, allow: Set<string> | null): Promise<void> {
    if (!(await isDir(dir))) return;
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      const skillDir = path.join(dir, name);
      if (!(await isDir(skillDir))) continue;
      const skillFile = path.join(skillDir, 'SKILL.md');
      try {
        const raw = await readFile(skillFile, 'utf8');
        const { meta, body } = parseFrontmatter(raw);
        const skillName = (meta.name ?? '').trim() || name;
        if (!meta.description) continue; // 无 description 视为无效 skill，跳过
        // 全局技能白名单过滤：allow 非 null 时仅放行名单内技能
        if (scope === 'global' && allow && !allow.has(skillName)) continue;
        if (this.skills.has(skillName)) {
          const existing = this.skills.get(skillName)!;
          if (existing.scope === 'project') {
            // 项目级优先：运行时重扫全局时不再覆盖项目级同名技能
            continue;
          }
          this.shadowed.push(skillName); // 项目级覆盖了同名全局级（初始扫描全局先于项目）
        }
        const [hasScripts, hasReferences, hasAssets] = await Promise.all([
          isDir(path.join(skillDir, 'scripts')),
          isDir(path.join(skillDir, 'references')),
          isDir(path.join(skillDir, 'assets')),
        ]);
        this.skills.set(skillName, {
          name: skillName,
          description: meta.description.trim(),
          dir: skillDir,
          body,
          hasScripts,
          hasReferences,
          hasAssets,
          scope,
        });
      } catch {
        continue; // 单个 skill 解析失败不影响其他
      }
    }
  }

  /** 被项目级覆盖掉的全局技能名列表（调试/透明性用）。 */
  shadowedNames(): string[] {
    return [...this.shadowed];
  }

  /** 用户级白名单配置文件路径（~/.workbuddy/skills.allow.json）。 */
  private allowConfigPath(): string {
    return path.join(this.homeDir, '.workbuddy', 'skills.allow.json');
  }

  /**
   * 全局过滤状态（用于 use_skill 失败提示与 /skills 命令）。
   * source:
   *  - off      全局扫描关闭（DSA_INCLUDE_GLOBAL_SKILLS=0）
   *  - constructor / env 由更高优先级层控制（配置文件改动本会话不生效，需重启）
   *  - config   来自 ~/.workbuddy/skills.allow.json
   *  - all      无任何限制，全部全局技能均加载
   */
  getFilterInfo(): {
    includeGlobal: boolean;
    allow: string[] | null;
    source: 'constructor' | 'env' | 'config' | 'all' | 'off';
  } {
    if (!this.globalIncluded) return { includeGlobal: false, allow: null, source: 'off' };
    if (this.allowOption && this.allowOption.length)
      return { includeGlobal: true, allow: [...this.allowOption], source: 'constructor' };
    const env = process.env.DSA_GLOBAL_SKILLS_ALLOW;
    if (env && env.trim())
      return {
        includeGlobal: true,
        allow: env
          .split(/[,;\s]+/)
          .map((s) => s.trim())
          .filter(Boolean),
        source: 'env',
      };
    return {
      includeGlobal: true,
      allow: this.resolvedAllow ? [...this.resolvedAllow] : null,
      source: this.resolvedAllow ? 'config' : 'all',
    };
  }

  /** 把过滤状态翻译成一行人话（use_skill 失败时与 /skills 命令共用）。 */
  filterDescription(): string {
    const info = this.getFilterInfo();
    if (info.source === 'off') return '全局技能扫描：已关闭（DSA_INCLUDE_GLOBAL_SKILLS=0）';
    if (info.allow === null) return '全局技能白名单：未设置，全部全局技能均加载';
    if (info.allow.length === 0) return '全局技能白名单：空（排除全部全局技能，仅项目级可用）';
    return `全局技能白名单（来源：${info.source}）：仅放行 ${info.allow.join('、')}`;
  }

  /**
   * 读取用户级白名单配置文件；无文件/解析失败返回 null（表示全部放行）。
   */
  async readConfigAllow(): Promise<string[] | null> {
    try {
      const raw = await readFile(this.allowConfigPath(), 'utf8');
      const json = JSON.parse(raw) as { allow?: unknown };
      if (Array.isArray(json.allow))
        return json.allow.map((x) => String(x).trim()).filter(Boolean);
      return null;
    } catch {
      return null;
    }
  }

  /** 写入用户级白名单配置文件。allow=null 表示全部放行（写 allow:null）。 */
  async writeConfigAllow(allow: string[] | null): Promise<void> {
    const dir = path.dirname(this.allowConfigPath());
    await mkdir(dir, { recursive: true });
    await writeFile(this.allowConfigPath(), JSON.stringify({ allow }, null, 2) + '\n', 'utf8');
  }

  /**
   * 运行时动态调整全局白名单并立即重扫（使 /skills allow|disallow|clear|all 命令即时生效）。
   * 仅当全局扫描开启且当前由「配置层」控制时真正重扫；项目级技能不受影响。
   * 若由 constructor / env 层控制，则只更新内存标记、不重扫（命令侧会提示需重启）。
   */
  async applyGlobalAllow(allow: string[] | null): Promise<void> {
    if (!this.globalIncluded) return;
    const info = this.getFilterInfo();
    if (info.source === 'constructor' || info.source === 'env') {
      this.resolvedAllow = allow ? new Set(allow) : null;
      return; // 高优先级层控制，重扫无意义，仅更新标记
    }
    this.resolvedAllow = allow ? new Set(allow) : null;
    for (const [k, v] of [...this.skills]) {
      if (v.scope === 'global') this.skills.delete(k);
    }
    if (await isDir(this.globalDir)) {
      await this.scan(this.globalDir, 'global', this.resolvedAllow);
    }
  }

  /** 可用技能清单（注入系统提示词，始终可见，含作用域）。 */
  listMeta(): SkillMeta[] {
    return [...this.skills.values()].map((s) => ({
      name: s.name,
      description: s.description,
      scope: s.scope,
    }));
  }

  /** 渲染系统提示词中的「可用技能」章节；无技能返回空串。作用域以 [项目]/[全局] 标注。 */
  renderCatalog(): string {
    const metas = this.listMeta();
    if (metas.length === 0) return '';
    const lines = [
      '# 可用技能 (Skills)',
      '当任务与下列某条描述匹配时，调用 use_skill 工具加载其完整指引后再执行。',
      '作用域标注：[项目]=仅当前项目可用（<cwd>/.workbuddy/skills/）；[全局]=所有项目可用（~/.workbuddy/skills/）。',
      '',
    ];
    for (const m of metas) {
      const tag = m.scope === 'project' ? '[项目]' : '[全局]';
      lines.push(`- **${m.name}** ${tag}: ${m.description}`);
    }
    return lines.join('\n');
  }

  /** 取完整技能正文（含打包资源路径说明与作用域）；不存在返回 null。 */
  renderBody(name: string): string | null {
    const s = this.skills.get(name);
    if (!s) return null;
    const scopeLabel = s.scope === 'project' ? '项目级（<cwd>/.workbuddy/skills/）' : '全局（~/.workbuddy/skills/）';
    const parts: string[] = [`# 技能：${s.name}`, `> 作用域：${scopeLabel}`, '', s.body];
    const res: string[] = [];
    if (s.hasScripts) res.push(`- scripts/ ：${path.join(s.dir, 'scripts')}`);
    if (s.hasReferences) res.push(`- references/ ：${path.join(s.dir, 'references')}`);
    if (s.hasAssets) res.push(`- assets/ ：${path.join(s.dir, 'assets')}`);
    if (res.length) {
      parts.push('', '## 打包资源（按需执行，无需全文读入上下文）', ...res);
    }
    return parts.join('\n');
  }
}
