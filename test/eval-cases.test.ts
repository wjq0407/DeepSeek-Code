import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CASES } from '../eval/cases.ts';

const VALID_TIERS = new Set(['code', 'llm', 'human']);

test('评测集: 共 23 个黄金 case', () => {
  assert.equal(CASES.length, 23, `期望 23 个 case，实际 ${CASES.length}`);
});

test('评测集: 每个 case 结构合法', () => {
  const ids = new Set<string>();
  for (const c of CASES) {
    assert.ok(c.id, 'case 缺少 id');
    assert.ok(!ids.has(c.id), `case id 重复: ${c.id}`);
    ids.add(c.id);
    assert.ok(c.title, `case ${c.id} 缺少 title`);
    assert.ok(c.category, `case ${c.id} 缺少 category`);
    assert.ok(VALID_TIERS.has(c.tier), `case ${c.id} 档位非法: ${c.tier}`);
    assert.ok(Array.isArray(c.turns) && c.turns.length > 0, `case ${c.id} turns 非法`);
    // code 档必须有确定性断言
    if (c.tier === 'code') {
      assert.equal(typeof c.check, 'function', `code 档 case ${c.id} 缺少 check()`);
    }
  }
});

test('评测集: c21-c23 盲区已纳入', () => {
  const idSet = new Set(CASES.map((c) => c.id));
  for (const id of ['c21', 'c22', 'c23']) {
    assert.ok(idSet.has(id), `缺失盲区 case: ${id}`);
  }
});
