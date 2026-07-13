// 评测框架类型定义（对应新路线阶段05：用垂直项目验证能力，量化"能力在变好"）
export type Tier = 'code' | 'llm' | 'human';
export type PermissionMode = 'explore' | 'ask' | 'execute';

export interface ToolCallRecord {
  name: string;
  args: unknown;
}

export interface CaseContext {
  cwd: string; // 隔离 sandbox 目录
  toolCalls: ToolCallRecord[];
  finalText: string; // 最后一轮 Agent 文本
  permissionDenied: string[]; // 被权限闸门拒绝的工具名
  transcript: string; // 完整交互记录
}

export interface GoldenCase {
  id: string;
  title: string;
  category: '工具选择' | '中文理解' | '多轮记忆' | '安全权限' | '差异化特性' | '综合任务';
  tier: Tier;
  turns: string[]; // 多轮指令
  permission?: PermissionMode; // 默认 execute
  confirm?: boolean; // ask 模式下是否自动确认，默认 true
  maxIterations?: number;
  setup?: (cwd: string) => Promise<void>; // 准备 sandbox 文件
  check?: (ctx: CaseContext) => { pass: boolean; detail: string }; // code 档断言
  rubric?: string; // llm 档评分标准
  weight: number; // 权重（默认 1）
}

export interface CaseResult {
  id: string;
  title: string;
  category: string;
  tier: Tier;
  pass: boolean;
  score: number | null; // llm 档 1-5
  detail: string;
  transcript: string;
}
