import React from 'react';
import { render } from 'ink-testing-library';
import { ThinkingIndicator } from '../src/cli/thinkingIndicator.tsx';

const app = render(<ThinkingIndicator />);

const frames: { t: number; f: string }[] = [];
const snap = (t: number) => frames.push({ t, f: app.lastFrame() ?? '' });

setTimeout(() => snap(200), 200);   // 350ms 防抖之前，应隐藏
setTimeout(() => snap(900), 900);   // 防抖后，应显示 spinner + 计时
setTimeout(() => snap(1600), 1600); // 计时应增长、spinner 应换帧

setTimeout(() => {
  console.log('=== ThinkingIndicator 冒烟测试 ===');
  for (const s of frames) {
    console.log(`t=${s.t}ms => ${JSON.stringify(s.f)}`);
  }
  console.log('\n--- 断言 ---');

  const pre = frames[0].f;
  const mid = frames[1].f;
  const late = frames[2].f;

  const debouncePass = pre === '';
  console.log('① 350ms 防抖前隐藏 (pre===""):', debouncePass ? 'PASS' : `FAIL ("${pre}")`);

  // spinner braille 字符（SPINNER 常量）
  const BRAILLE = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏';
  const spinnerOf = (s: string) => [...s].find((c) => BRAILLE.includes(c)) ?? '';
  const sp1 = spinnerOf(mid);
  const sp2 = spinnerOf(late);
  console.log('② spinner 字符 mid:', JSON.stringify(sp1), ' late:', JSON.stringify(sp2),
    ' 不同帧:', sp1 !== sp2 ? 'PASS(转动)' : 'FAIL(未变)');

  const tMid = (mid.match(/[\d.]+秒/) || [])[0];
  const tLate = (late.match(/[\d.]+秒/) || [])[0];
  const grew = !!tMid && !!tLate && parseFloat(tLate) > parseFloat(tMid);
  console.log('③ 中文计时 mid:', tMid, ' late:', tLate,
    ' 递增:', grew ? 'PASS' : 'FAIL');

  const allPass = debouncePass && sp1 !== sp2 && grew;
  console.log('\n结果:', allPass ? '✅ 全部通过' : '❌ 有失败项');

  app.unmount();
  process.exit(allPass ? 0 : 1);
}, 1850);
