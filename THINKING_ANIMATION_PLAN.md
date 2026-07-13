# 思考指示器实现方案 · 最终落地版（v-final，✅ 已实现 2026-07-12）

> **目标**：取代 `app.tsx:901` 那行 low 的 `⏳ 思考中…`，做一个**模仿 Claude Code 原生思考动画**的「思考中」状态指示——蓝色加粗「思考中」+ **旋转 spinner（braille）** + **右侧实时任务持续时间**（中文单位 `xx秒` / `xx分xx秒` / `xx时xx分xx秒` 依此递进）。

## 1. 设计要点

| 维度 | 取值 |
|------|------|
| 形态 | 单行：蓝色加粗 `思考中 {spinner} {时长}`（spinner 用 10 帧 braille 字符连续旋转） |
| 配色（深色 TUI 实际） | 项目亮蓝 `#4aa3e0`（`<Text color="#4aa3e0" bold>`）；想更深品牌蓝可改 `#2f6fb0` |
| 触发 | `busy` 为真时（`app.tsx:554` 置 true，`636` finally 才 false，贯穿「思考+工具执行+流式输出」整段） |
| 动效 | 标准 CLI braille spinner（⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏），每 120ms 推进一帧，连续旋转、平滑（非逐字跳动） |
| 计时 | 从回车那一刻开始（`startRef=useRef(Date.now())` 挂载即计时），右侧每 100ms 刷新 |
| 防抖 | 350ms 后才显示，避免快响应（<350ms）时动画「闪一下」 |
| 依赖 | **零新依赖**；因本项目 ink 版本无 `useInterval`，用 React `useEffect + setInterval` 自驱动 |

## 2. 实现架构

```
App (busy:boolean)
  └─ {busy && <ThinkingIndicator/>}        // 替换 app.tsx:901
        ├─ startRef = useRef(Date.now())   // 挂载即计时，每次任务重置
        ├─ useEffect 350ms 防抖 → visible=true            // 避免快响应闪一下
        ├─ useEffect setInterval(100) → setElapsed(...)   // 计时器
        ├─ useEffect setInterval(120) → setFrame((f+1)%10) // spinner 旋转
        └─ <Box>
              <Text color="#4aa3e0" bold>
                思考中 {SPINNER[frame]} {fmt(elapsed)}
              </Text>
           </Box>
```

数据来源：`SPINNER` / `fmt()` 内联在 `thinkingIndicator.tsx`。

## 3. 文件改动清单（✅ 已完成）

1. **`src/cli/thinkingIndicator.tsx`（新文件）**：`ThinkingIndicator` 组件（旋转 spinner + 计时 + 防抖）。
2. **`src/cli/app.tsx`**：
   - 第 1 行 imports 增加 `import { ThinkingIndicator } from './thinkingIndicator.ts';`
   - 第 901 行 `{busy && <Text dimColor>⏳ 思考中…</Text>}` → `{busy && <ThinkingIndicator />}`
   - 删除旧的 `thinkingTimer` / `started` 逻辑（声明于 557-560，使用于 590/591/602/610/613/635），统一由活体指示器接管。

## 4. 验证

- `npx tsc --noEmit` → **EXIT=0 通过**（已验证）。
- 运行 `npm start` 进入 Agent，输入任意需求回车：
  - 约 0.35s 后聊天区底部出现蓝色加粗 `思考中 ⠋ 3.2秒`，spinner 旋转、中文秒数实时跳动；
  - 任务结束即消失，下次任务重新从 0 计；极快响应（<350ms）不闪。

## 5. 核心代码（`thinkingIndicator.tsx`）

```tsx
import React, { useEffect, useRef, useState } from 'react';
import { Box, Text } from 'ink';

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const SPIN_MS = 120;
const TICK_MS = 100;

function fmt(sec: number): string {
  if (sec < 60) return sec.toFixed(1) + '秒';
  if (sec < 3600) return `${Math.floor(sec / 60)}分${Math.floor(sec % 60)}秒`;
  return `${Math.floor(sec / 3600)}时${Math.floor((sec % 3600) / 60)}分${Math.floor(sec % 60)}秒`;
}

export function ThinkingIndicator() {
  const startRef = useRef(Date.now());
  const [elapsed, setElapsed] = useState(0);
  const [frame, setFrame] = useState(0);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setVisible(true), 350);
    return () => clearTimeout(t);
  }, []);
  useEffect(() => {
    const id = setInterval(() => setElapsed((Date.now() - startRef.current) / 1000), TICK_MS);
    return () => clearInterval(id);
  }, []);
  useEffect(() => {
    const id = setInterval(() => setFrame((f) => (f + 1) % SPINNER.length), SPIN_MS);
    return () => clearInterval(id);
  }, []);

  if (!visible) return null;
  return (
    <Box>
      <Text color="#4aa3e0" bold>思考中 {SPINNER[frame]} {fmt(elapsed)}</Text>
    </Box>
  );
}
```

## 6. 可调旋钮

| 旋钮 | 位置 | 建议值 |
|------|------|--------|
| spinner 帧速 | `SPIN_MS` | 120 顺滑 / 100 更快 / 80 更急 |
| spinner 帧数 | `SPINNER.length` | 10（braille）/ 4（ASCII `\|/-\`） |
| 防抖时长 | `setTimeout(...,350)` | 300–500ms |
| 计时刷新率 | `TICK_MS` | 100 顺滑 / 200 更省 |
| 配色 | `color="#4aa3e0"` | `#4aa3e0` / `#2f6fb0` |

## 7. 已知限制

- braille 字符 `⠋` 等需终端字体支持（所有现代终端均支持）；若担心某终端缺字，把 `SPINNER` 换成 ASCII 版 `['|','/','-','\\\\']` 即可。
- 单行渲染，不额外占高度，聊天区布局不受影响（相比逐字跳动/海浪多行方案更省空间）。

## 8. 已实现扩展：任务结束回显耗时（选项 C）

- **落地**：`app.tsx` 新增 `taskStartRef`（任务开始时间）+ `done` 事件中 `pushMessage('system', '⏱ 本次任务耗时 ' + formatDuration(dur))`，与成本行同处一处。
- `formatDuration` 从 `thinkingIndicator.tsx` 导出复用（同一套中文计时逻辑，避免重复）。
- **实测**：`tsc --noEmit` 通过；`formatDuration` 用例 `3.2s→3.2秒 / 67s→1分7秒 / 3725s→1时2分5秒` 全部正确；完整 app 启动仅因「后台无 TTY」停于 raw mode（本地终端无碍）。
