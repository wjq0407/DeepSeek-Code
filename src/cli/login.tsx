import { Box, Text, useInput, render } from 'ink';
import { useState } from 'react';
import type { Credentials } from './auth.ts';

/**
 * 受控的 API Key 输入捕获组件（可复用于启动登录与 App 内更换 Key）。
 * - 掩码显示（•），Ctrl+R 切换明文/掩码
 * - 回车提交（空值报错），Esc 取消（有 onCancel 时）
 * 不依赖额外输入库，直接用 ink 的 useInput 手写，保持依赖精简。
 */
export function KeyCapture({
  label,
  onSubmit,
  onCancel,
}: {
  label: string;
  onSubmit: (apiKey: string) => void;
  onCancel?: () => void;
}) {
  const [value, setValue] = useState('');
  const [show, setShow] = useState(false);
  const [error, setError] = useState('');

  useInput((ch, key) => {
    if (key.ctrl && (ch === 'r' || ch === 'R')) {
      setShow((s) => !s);
      return;
    }
    if (key.escape) {
      onCancel?.();
      return;
    }
    if (key.return) {
      const v = value.trim();
      if (!v) {
        setError('API Key 不能为空');
        return;
      }
      onSubmit(v);
      return;
    }
    if (ch && !key.ctrl && !key.meta) {
      setValue((s) => s + ch);
    } else if (key.backspace || key.delete) {
      setValue((s) => s.slice(0, -1));
    }
  });

  const display = show ? value : value ? '•'.repeat(value.length) : '';

  return (
    <Box flexDirection="column">
      <Text>{label}</Text>
      <Box borderStyle="single" borderColor="#7ec8e3" paddingX={1} marginTop={1}>
        <Text color={value ? '#ffffff' : '#888888'}>{display || '在此输入…'}</Text>
      </Box>
      <Text dimColor>回车确认 · Ctrl+R 显示/隐藏 · Esc 取消</Text>
      {error ? <Text color="#ff5555">{error}</Text> : null}
    </Box>
  );
}

/** 启动门禁用的独立登录卡片（居中展示） */
export function LoginScreen({
  firstRun,
  onSubmit,
  onCancel,
}: {
  firstRun: boolean;
  onSubmit: (apiKey: string) => void;
  onCancel?: () => void;
}) {
  return (
    <Box flexDirection="column" height="100%" justifyContent="center" alignItems="center">
      <Box borderStyle="round" borderColor="#2f6fb0" paddingX={2} paddingY={1} flexDirection="column" width={68}>
        <Text color="#2f6fb0" bold>
          {`DeepSeek Agent · ${firstRun ? '首次登录' : '更换 API Key'}`}
        </Text>
        <Text> </Text>
        <KeyCapture
          label={firstRun ? '首次使用，请输入你的 DeepSeek API Key：' : '输入新的 DeepSeek API Key 以替换：'}
          onSubmit={onSubmit}
          onCancel={onCancel}
        />
      </Box>
    </Box>
  );
}

/**
 * 渲染登录界面并等待用户提交，返回输入的凭证；用户取消（Esc）时返回 null。
 * 单独渲染一个 ink 实例，提交/取消后卸载，再由 main.ts 启动主 TUI。
 */
export function runLogin(firstRun: boolean): Promise<Credentials | null> {
  return new Promise((resolve) => {
    const inst = render(
      <LoginScreen
        firstRun={firstRun}
        onSubmit={(apiKey) => {
          inst.unmount();
          resolve({ apiKey });
        }}
        onCancel={() => {
          inst.unmount();
          resolve(null);
        }}
      />,
    );
  });
}
