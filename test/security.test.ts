import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isDestructive } from '../src/tools/index.ts';
import { maskKey } from '../src/cli/auth.ts';

test('isDestructive: 破坏性命令被识别', () => {
  assert.equal(isDestructive('rm -rf /'), true);
  assert.equal(isDestructive('rm -rf ~/'), true);
  assert.equal(isDestructive('taskkill /f /im node.exe'), true);
  assert.equal(isDestructive('git push --force'), true);
  assert.equal(isDestructive('mkfs.ext4 /dev/sda1'), true);
});

test('isDestructive: 仅删本地目录 / 普通 push 不误判', () => {
  assert.equal(isDestructive('rm -rf node_modules'), false);
  assert.equal(isDestructive('git push origin main'), false);
});

test('isDestructive: 常规命令不误判', () => {
  assert.equal(isDestructive('npm install react'), false);
  assert.equal(isDestructive('ls -la'), false);
  assert.equal(isDestructive('git status'), false);
  assert.equal(isDestructive('echo hello world'), false);
});

test('maskKey: 末尾 4 位脱敏', () => {
  assert.equal(maskKey('sk-1234567890abcd'), '****abcd');
  assert.equal(maskKey('short'), '****hort');
});

test('maskKey: 空串不崩溃', () => {
  assert.equal(maskKey(''), '****');
});
