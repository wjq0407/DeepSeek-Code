import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SkillManager } from '../src/skills/loader.ts';

test('SkillManager: 解析折叠描述 + 列出元数据 + 加载正文与资源', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'dsa-skill-'));
  try {
    // 技能 1：折叠块描述 + 含 scripts 资源
    const skillDir = path.join(root, '.workbuddy', 'skills', 'demo-skill');
    await mkdir(path.join(skillDir, 'scripts'), { recursive: true });
    const md = [
      '---',
      'name: demo-skill',
      'description: >-',
      '  一个用于演示的技能，描述可以很长，',
      '  跨多行折叠书写。',
      'agent_created: true',
      '---',
      '',
      '# Demo Skill',
      '',
      '这是正文，模型加载后会读到这里。',
    ].join('\n');
    await writeFile(path.join(skillDir, 'SKILL.md'), md, 'utf8');

    // 技能 2：双引号单行描述，无资源
    const skillDir2 = path.join(root, '.workbuddy', 'skills', 'quoted');
    await mkdir(skillDir2, { recursive: true });
    await writeFile(
      path.join(skillDir2, 'SKILL.md'),
      ['---', 'name: quoted', 'description: "双引号单行描述，用于回归测试。"', '---', '', 'body of quoted'].join('\n'),
      'utf8',
    );

    const mgr = new SkillManager(root, { includeGlobal: false });
    await mgr.init();

    const metas = mgr.listMeta();
    assert.equal(metas.length, 2);

    const demo = metas.find((m) => m.name === 'demo-skill')!;
    assert.ok(demo.description.includes('跨多行折叠书写'), '折叠描述应被正确拼接');
    assert.equal(demo.scope, 'project', '项目目录下的技能应为 project 作用域');
    const quoted = metas.find((m) => m.name === 'quoted')!;
    assert.equal(quoted.description, '双引号单行描述，用于回归测试。');

    const catalog = mgr.renderCatalog();
    assert.ok(catalog.includes('demo-skill'));
    assert.ok(catalog.includes('quoted'));
    assert.ok(catalog.includes('[项目]'), '目录应标注项目作用域');

    const body = mgr.renderBody('demo-skill');
    assert.ok(body && body.includes('这是正文'), '正文应包含 markdown 指令');
    assert.ok(body!.includes('scripts/'), '应列出打包资源路径');

    assert.equal(mgr.renderBody('不存在'), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('SkillManager: 缺 description 的 SKILL.md 被跳过', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'dsa-skill-'));
  try {
    const skillDir = path.join(root, '.workbuddy', 'skills', 'broken');
    await mkdir(skillDir, { recursive: true });
    await writeFile(path.join(skillDir, 'SKILL.md'), ['---', 'name: broken', '---', '', 'no description here'].join('\n'), 'utf8');
    const mgr = new SkillManager(root, { includeGlobal: false });
    await mgr.init();
    assert.equal(mgr.listMeta().length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('SkillManager: 项目级技能覆盖同名全局级，且作用域正确打标', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'dsa-skill-'));
  const globalRoot = await mkdtemp(path.join(tmpdir(), 'dsa-global-'));
  try {
    // 全局技能：shared（位于全局目录）
    const gDir = path.join(globalRoot, '.workbuddy', 'skills', 'shared');
    await mkdir(gDir, { recursive: true });
    await writeFile(
      path.join(gDir, 'SKILL.md'),
      ['---', 'name: shared', 'description: "全局版 shared 技能。"', '---', '', 'global body'].join('\n'),
      'utf8',
    );

    // 项目技能：shared（同名，位于项目目录，应覆盖全局）
    const pDir = path.join(root, '.workbuddy', 'skills', 'shared');
    await mkdir(pDir, { recursive: true });
    await writeFile(
      path.join(pDir, 'SKILL.md'),
      ['---', 'name: shared', 'description: "项目版 shared 技能。"', '---', '', 'project body'].join('\n'),
      'utf8',
    );
    // 项目私有技能：local-only（仅项目级）
    const pDir2 = path.join(root, '.workbuddy', 'skills', 'local-only');
    await mkdir(pDir2, { recursive: true });
    await writeFile(
      path.join(pDir2, 'SKILL.md'),
      ['---', 'name: local-only', 'description: "仅项目级可用。"', '---', '', 'local body'].join('\n'),
      'utf8',
    );

    const mgr = new SkillManager(root, { globalDir: path.join(globalRoot, '.workbuddy', 'skills') });
    await mgr.init();

    const metas = mgr.listMeta();
    assert.equal(metas.length, 2, '应为 shared + local-only 两个技能');

    const shared = metas.find((m) => m.name === 'shared')!;
    assert.equal(shared.scope, 'project', '同名时项目级应覆盖全局级');
    assert.ok(shared.description.includes('项目版'), '应使用项目版正文');

    const local = metas.find((m) => m.name === 'local-only')!;
    assert.equal(local.scope, 'project');

    const catalog = mgr.renderCatalog();
    assert.ok(catalog.includes('[项目]'), '目录应标注项目作用域');
    assert.ok(catalog.includes('[全局]'), '目录应标注全局作用域（global 中未被覆盖的）');

    // 正文应取项目版
    const body = mgr.renderBody('shared')!;
    assert.ok(body.includes('project body'), 'renderBody 应返回项目级正文');
    assert.ok(body.includes('项目级'), '正文应标注作用域');
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(globalRoot, { recursive: true, force: true });
  }
});

test('SkillManager: includeGlobal=false 仅扫描项目级', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'dsa-skill-'));
  const globalRoot = await mkdtemp(path.join(tmpdir(), 'dsa-global-'));
  try {
    // 全局技能
    const gDir = path.join(globalRoot, '.workbuddy', 'skills', 'gskill');
    await mkdir(gDir, { recursive: true });
    await writeFile(
      path.join(gDir, 'SKILL.md'),
      ['---', 'name: gskill', 'description: "全局技能。"', '---', '', 'global body'].join('\n'),
      'utf8',
    );
    // 项目技能
    const pDir = path.join(root, '.workbuddy', 'skills', 'pskill');
    await mkdir(pDir, { recursive: true });
    await writeFile(
      path.join(pDir, 'SKILL.md'),
      ['---', 'name: pskill', 'description: "项目技能。"', '---', '', 'project body'].join('\n'),
      'utf8',
    );

    const mgr = new SkillManager(root, {
      includeGlobal: false,
      globalDir: path.join(globalRoot, '.workbuddy', 'skills'),
    });
    await mgr.init();

    const metas = mgr.listMeta();
    assert.equal(metas.length, 1, '关闭全局后只应有 1 个技能');
    assert.equal(metas[0].name, 'pskill');
    assert.equal(metas[0].scope, 'project');
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(globalRoot, { recursive: true, force: true });
  }
});

test('SkillManager: 全局白名单只放行指定全局技能，项目级不受限', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'dsa-skill-'));
  const globalRoot = await mkdtemp(path.join(tmpdir(), 'dsa-global-'));
  try {
    // 全局技能 two：在白名单内，应被放行
    const gAllow = path.join(globalRoot, '.workbuddy', 'skills', 'two');
    await mkdir(gAllow, { recursive: true });
    await writeFile(
      path.join(gAllow, 'SKILL.md'),
      ['---', 'name: two', 'description: "白名单内的全局技能。"', '---', '', 'two body'].join('\n'),
      'utf8',
    );
    // 全局技能 three：不在白名单内，应被过滤
    const gDeny = path.join(globalRoot, '.workbuddy', 'skills', 'three');
    await mkdir(gDeny, { recursive: true });
    await writeFile(
      path.join(gDeny, 'SKILL.md'),
      ['---', 'name: three', 'description: "应被白名单排除的全局技能。"', '---', '', 'three body'].join('\n'),
      'utf8',
    );
    // 项目技能 pskill：不受白名单影响，应始终出现
    const pDir = path.join(root, '.workbuddy', 'skills', 'pskill');
    await mkdir(pDir, { recursive: true });
    await writeFile(
      path.join(pDir, 'SKILL.md'),
      ['---', 'name: pskill', 'description: "项目技能。"', '---', '', 'project body'].join('\n'),
      'utf8',
    );

    const mgr = new SkillManager(root, {
      globalAllow: ['two'],
      globalDir: path.join(globalRoot, '.workbuddy', 'skills'),
    });
    await mgr.init();

    const metas = mgr.listMeta();
    const names = metas.map((m) => m.name);
    assert.deepEqual(names.sort(), ['pskill', 'two'], '应只有 pskill(项目) 与 two(白名单全局)');
    assert.ok(!names.includes('three'), 'three 应被白名单排除');

    const two = metas.find((m) => m.name === 'two')!;
    assert.equal(two.scope, 'global');
    assert.ok(mgr.renderBody('two')!.includes('two body'));
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(globalRoot, { recursive: true, force: true });
  }
});

test('SkillManager: 显式空白名单 [] 排除全部全局技能，项目级不受影响', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'dsa-skill-'));
  const globalRoot = await mkdtemp(path.join(tmpdir(), 'dsa-global-'));
  try {
    const gDir = path.join(globalRoot, '.workbuddy', 'skills', 'gskill');
    await mkdir(gDir, { recursive: true });
    await writeFile(
      path.join(gDir, 'SKILL.md'),
      ['---', 'name: gskill', 'description: "应被空白名单排除。"', '---', '', 'global body'].join('\n'),
      'utf8',
    );
    const pDir = path.join(root, '.workbuddy', 'skills', 'pskill');
    await mkdir(pDir, { recursive: true });
    await writeFile(
      path.join(pDir, 'SKILL.md'),
      ['---', 'name: pskill', 'description: "项目技能。"', '---', '', 'project body'].join('\n'),
      'utf8',
    );

    const mgr = new SkillManager(root, {
      globalAllow: [], // 显式空数组 = 排除全部全局
      globalDir: path.join(globalRoot, '.workbuddy', 'skills'),
    });
    await mgr.init();

    const metas = mgr.listMeta();
    assert.equal(metas.length, 1, '空白名单下应只剩项目级技能');
    assert.equal(metas[0].name, 'pskill');
    assert.equal(metas[0].scope, 'project');
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(globalRoot, { recursive: true, force: true });
  }
});

test('SkillManager: applyGlobalAllow 运行时即时重扫全局技能', async () => {
  // 用临时 homeDir 隔离真实 ~/.workbuddy/skills.allow.json（避免环境里的空白名单污染本测试）
  const tmpHome = await mkdtemp(path.join(tmpdir(), 'dsa-home-'));
  const root = await mkdtemp(path.join(tmpdir(), 'dsa-skill-rt-'));
  const globalRoot = await mkdtemp(path.join(tmpdir(), 'dsa-global-'));
  try {
    const mk = async (name: string, desc: string) => {
      const d = path.join(globalRoot, name);
      await mkdir(d, { recursive: true });
      await writeFile(
        path.join(d, 'SKILL.md'),
        ['---', `name: ${name}`, `description: ${desc}`, '---', '', `${name} body`].join('\n'),
        'utf8',
      );
    };
    await mk('one', 'one skill');
    await mk('two', 'two skill');

    // root 作为 cwd（无项目技能），globalDir 指向临时全局目录；默认 includeGlobal=true
    // homeDir 指向临时目录，避免读取真实用户配置
    const mgr = new SkillManager(root, { globalDir: globalRoot, homeDir: tmpHome });
    await mgr.init();

    const gAll = mgr.listMeta().filter((m) => m.scope === 'global');
    assert.equal(gAll.length, 2, '初始全部全局技能加载');
    assert.equal(mgr.getFilterInfo().source, 'all', '无白名单时来源为 all（全部放行）');

    // 收窄到仅 one
    await mgr.applyGlobalAllow(['one']);
    const g1 = mgr.listMeta().filter((m) => m.scope === 'global');
    assert.equal(g1.length, 1, '重扫后仅保留 one');
    assert.equal(g1[0].name, 'one');
    assert.equal(mgr.getFilterInfo().source, 'config', '运行时重扫后来源标记为 config');

    // 排除全部
    await mgr.applyGlobalAllow([]);
    assert.equal(
      mgr.listMeta().filter((m) => m.scope === 'global').length,
      0,
      '空数组排除全部全局',
    );
    assert.ok(mgr.filterDescription().includes('排除全部'), 'filterDescription 反映排除全部');
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(globalRoot, { recursive: true, force: true });
    await rm(tmpHome, { recursive: true, force: true });
  }
});

test('SkillManager: getFilterInfo / filterDescription 反映全局关闭', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'dsa-skill-off-'));
  try {
    const mgr = new SkillManager(root, { includeGlobal: false });
    await mgr.init();
    assert.equal(mgr.getFilterInfo().source, 'off');
    assert.equal(mgr.getFilterInfo().includeGlobal, false);
    assert.ok(mgr.filterDescription().includes('已关闭'), 'filterDescription 反映全局关闭');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
