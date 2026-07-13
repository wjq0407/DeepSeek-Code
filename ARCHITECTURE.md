# ARCHITECTURE.md — 三层架构与五层边界映射

> 路线引用：02-先找五层边界 / 03-Agent 库不是一文件，要分层 / 04-技术栈分层的定位。
> 本项目刻意避免"所有逻辑塞一个文件"，按可靠性分工拆成四层（应用/运行时/模型/工具）+ 上下文层。

## 分层总览

```
┌──────────────────────────────────────────────────────────┐
│ 应用交互层  src/cli                                        │
│  REPL 读取用户输入 · 流式渲染模型输出 · 读 .env 配置        │
│  职责：把用户输入变成请求，把 Agent 过程/结果展示出来        │
│  不该：直接调模型、直接执行工具                            │
└───────────────┬──────────────────────────────────────────┘
                │ 调用
┌───────────────▼──────────────────────────────────────────┐
│ Agent 运行时层  src/agent  （核心：Agent 怎么做事）         │
│  agent loop · 事件流 · 工具调度 · 权限决策 · 上下文压缩      │
│  对应 learn-claude-code：Loop Pattern / Tool Dispatch /     │
│  Permission Governance / Context Compaction / Error Recovery│
└───────┬──────────────────────────┬───────────────────────┘
        │ 调模型                    │ 调工具
┌───────▼────────┐          ┌───────▼──────────────────────┐
│ 模型 API 层     │          │ 工具层  src/tools              │
│ src/llm         │          │ 6 个编程动作 + Zod schema 校验  │
│ DeepSeek 原生    │          │ 对应 learn-claude-code 工具层   │
│ 流式 + tool_calls│          │ （MCP/Skill 可后续插件化扩展）  │
└────────────────┘          └───────────────────────────────┘

        ↕ 共享 ↕
┌──────────────────────────────────────────────────────────┐
│ 上下文层  src/context                                       │
│ 多轮历史 · 压缩策略 · 工作目录状态                          │
│ 对应 learn-claude-code：Persistent Memory / Four-Layer Compaction│
└──────────────────────────────────────────────────────────┘
```

## 层间关键机制位置（Debug 时先查哪层）
| 问题现象 | 先查哪层 |
|----------|----------|
| 工具调用失败 | 工具层 + 权限边界 |
| 流式输出中断 | 模型 API 层 + 应用交互层 |
| 模型跑偏/重复 | Agent 运行时层（上下文 + 指令） |
| 多轮记忆丢失 | 上下文层 |
| REPL 卡死 | 应用交互层 |

## 技术栈定位（对应阶段04：每个技术在哪层、防什么失败）
| 技术 | 层 | 防什么失败 |
|------|----|-----------|
| `openai`(兼容 DeepSeek) | 模型 API 层 | 统一请求/流式/错误 + **双模型路由(chat/reasoner)** |
| `zod` | 工具层 | 参数缺字段、模型给错 schema |
| `chalk` | 应用交互层 | 输出可读性、状态区分 |
| `node --experimental-strip-types` | 工程 | 免构建直接跑 TS |
| `.env` | 应用交互层 | 密钥不入代码 + **推理模型配置** |
| JSONL trace 日志 | 上下文层/观测 | 出错后定位哪步坏（P2 实现） |

## 双模型策略（P1-1 增强）

DeepSeek V4 提供两种模型，各有擅长：

| 模型 | 用途 | 特点 | 接入位置 |
|------|------|------|---------|
| `deepseek-v4-flash`（非思考） | Agent Loop 主循环 | 响应快、tool calling 精准、成本低 | `streamChat()` / `streamChatWithUsage()` |
| `deepseek-v4-pro`（思考） | 复合工具二次推理 | 1M 上下文、思考模式、分析质量高 | `complete()` (review_code / audit_dependencies / terminology / project_discover / git_commit_msg) |

**路由规则**: 主循环永远用 `deepseek-v4-flash` 且显式关闭思考（`extra_body.thinking={type:'disabled'}`），等价于旧 `deepseek-chat`；复合工具自动路由到 `deepseek-v4-pro` 并开启思考（`reasoning_effort`）。未配置 reasonerModel 时回退到主模型。

> ⚠️ 旧别名 `deepseek-chat` / `deepseek-reasoner` 已于 2026-07-24 15:59 UTC 弃用。

## 设计原则（来自已学四站）
- **循环不变式**：`while stop_reason=="tool_use": 调模型→追加→执行工具→回灌`。循环固定，变化的是工具/知识/权限。
- **Harness 五子系统**：Instructions(system prompt) / State(progress) / Verification(评测) / Scope(一次一任务) / Lifecycle(初始化→执行→清理)。
- **子 Agent 隔离**（后续）：复杂任务可拆子 Agent，隔离上下文防污染。
