import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectMemoryIntent } from '../src/memory/intent.ts';

test('detectMemoryIntent: 正常记忆指令被识别', () => {
  const r = detectMemoryIntent('记一下 项目用 TypeScript 写');
  assert.ok(r !== null, '应识别为记忆指令');
  assert.ok(r!.content.includes('项目用 TypeScript 写'), `content 应含正文，实际: ${r?.content}`);
});

test('detectMemoryIntent: 仅语气句返回 null', () => {
  assert.equal(detectMemoryIntent('记住了吗'), null);
});

test('detectMemoryIntent: 无内容返回 null', () => {
  assert.equal(detectMemoryIntent('记一下'), null);
  assert.equal(detectMemoryIntent('记一下   '), null);
});

test('detectMemoryIntent: 过短正文返回 null', () => {
  assert.equal(detectMemoryIntent('记一下 好'), null);
});

test('detectMemoryIntent: 空输入返回 null', () => {
  assert.equal(detectMemoryIntent(''), null);
  assert.equal(detectMemoryIntent('   '), null);
});
