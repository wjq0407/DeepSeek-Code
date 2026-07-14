// 思考指示器：模仿 Claude Code 原生思考动画——蓝色「思考中」+ 旋转 spinner + 实时任务时长。
// 用户最终认可方案：平滑旋转 spinner（非逐字跳动），中文计时（xx秒 / xx分xx秒 / xx时xx分xx秒）。
// 注：本项目 ink 版本无 useInterval，故用 React useEffect + setInterval 自驱动。

import React, { useEffect, useRef, useState } from 'react';
import { Box, Text } from 'ink';

// 标准 CLI braille spinner（10 帧，连续旋转，最贴近 Claude Code 的平滑加载感）
const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const SPIN_MS = 120; // spinner 旋转速度（越小越快）
const TICK_MS = 100; // 计时刷新率

// 实时时长 → 中文单位递进：xx秒 / xx分xx秒 / xx时xx分xx秒
export function formatDuration(sec: number): string {
  if (sec < 60) return sec.toFixed(1) + '秒';
  if (sec < 3600) return `${Math.floor(sec / 60)}分${Math.floor(sec % 60)}秒`;
  return `${Math.floor(sec / 3600)}时${Math.floor((sec % 3600) / 60)}分${Math.floor(sec % 60)}秒`;
}

// 组件内部复用同一定义（避免重复）
const fmt = formatDuration;

export function ThinkingIndicator() {
  const startRef = useRef(Date.now()); // 挂载即计时（每次任务重置）
  const [elapsed, setElapsed] = useState(0);
  const [frame, setFrame] = useState(0);
  const [visible, setVisible] = useState(false);

  // 防抖：350ms 后才显示，避免快响应（<350ms）时动画「闪一下」
  useEffect(() => {
    const t = setTimeout(() => setVisible(true), 350);
    return () => clearTimeout(t);
  }, []);

  // 计时器：每 100ms 刷新
  useEffect(() => {
    const id = setInterval(() => setElapsed((Date.now() - startRef.current) / 1000), TICK_MS);
    return () => clearInterval(id);
  }, []);

  // spinner 旋转：每 SPIN_MS 推进一帧（连续循环，平滑）
  useEffect(() => {
    const id = setInterval(() => setFrame((f) => (f + 1) % SPINNER.length), SPIN_MS);
    return () => clearInterval(id);
  }, []);

  if (!visible) return null;

  // 单行：蓝色加粗「思考中 {spinner} {时长}」+ 中断提示
  return (
    <Box>
      <Text color="#4aa3e0" bold>
        思考中 {SPINNER[frame]} {fmt(elapsed)}
      </Text>
      <Text color="#9aa0a6">  （按 Ctrl+C 中断）</Text>
    </Box>
  );
}
