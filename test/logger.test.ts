import { test } from 'node:test';
import assert from 'node:assert/strict';
import { msgOf, asExecError } from '../src/utils/logger.ts';

test('msgOf: Error 取 message', () => {
  assert.equal(msgOf(new Error('boom')), 'boom');
});

test('msgOf: 非 Error 收窄为字符串', () => {
  assert.equal(msgOf('plain string'), 'plain string');
  assert.equal(msgOf(42), '42');
  assert.equal(msgOf(null), 'null');
});

test('asExecError: 对象被收窄为统一结构', () => {
  const r = asExecError({ code: 'EEXIT', stdout: 'out', stderr: 'err' });
  assert.equal(r.code, 'EEXIT');
  assert.equal(r.stdout, 'out');
  assert.equal(r.stderr, 'err');
});

test('asExecError: 字符串回退到 stderr', () => {
  const r = asExecError('fatal');
  assert.equal(r.code, '?');
  assert.equal(r.stdout, '');
  assert.equal(r.stderr, 'fatal');
});
