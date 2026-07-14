# DeepSeek Code Agent

> **直连 DeepSeek 官方 API、对标并差异化 Claude Code 的中文原生编程 Agent。**
> 为无法使用 Claude 原生模型的开发者（如国内 / 非海外账户用户）提供一款**无中转站、最大化释放 DeepSeek 能力**的编程助手。

[![version](https://img.shields.io/badge/version-v0.5.0-blue)](./feature_list.json)
[![typescript](https://img.shields.io/badge/TypeScript-strict%200%20errors-3178c6)](./tsconfig.json)
[![eval](https://img.shields.io/badge/eval-23%20golden%20cases-brightgreen)](./eval/RESULTS.md)

---

## 目录

- [为什么做](#为什么做)
- [与 Claude Code 的差异](#与-claude-code-的差异)
- [核心设计哲学](#核心设计哲学)
- [系统架构](#系统架构)
- [能力矩阵](#能力矩阵)
- [关键工程决策（面试重点）](#关键工程决策面试重点)
- [工程质量](#工程质量)
- [快速开始](#快速开始)
- [项目状态与路线图](#项目状态与路线图)
- [学习来源](#学习来源)

---

## 为什么做

Claude Code 依赖 Anthropic 官方 API，对国内 / 非海外账户用户不可达。社区常见解法是「DeepSeek + 中转站伪装成 Claude」，但中转方案存在**兼容性盲区**（tool calling 行为、流式协议、错误语义不一致），且无法充分利用 DeepSeek 自身特性。

本项目的出发点很直接：

> **不绕路，不伪装。直连 `api.deepseek.com`，把 DeepSeek 当成一等公民来设计 Harness，做出一款在中文工程语境下对标、并差异化 Claude Code 的编程 Agent。**

设计目标优先级：

1. **直连**：DeepSeek 官方 API，无中转、无代理、密钥本地 `.env`。
2. **适配**：针对 DeepSeek 模型特性（双模型、长上下文、JSON mode）做原生适配。
3. **差异化**：集成 Claude Code 的优点，但不盲从；提供 Claude Code 默认不具备的中文原生化能力。
4. **能力最大化**：尽可能释放出 DeepSeek 的全部能力，而非只做「能跑」的玩具。

---

## 与 Claude Code 的差异

| 维度 | Claude Code | DeepSeek Code Agent | 说明 |
|------|-------------|---------------------|------|
| **模型来源** | Anthropic 官方（需海外账户）| DeepSeek 官方直连（国内可用）| 无中转、无兼容性盲区 |
| **默认语言** | 英文优先 | **中文工程语境原生** | system prompt、提交信息、审查报告、审计全中文 |
| **双模型路由** | 单一模型 | **chat 主循环 + reasoner 复合工具** | 调用快模型做工具调度，推理模型做深度分析 |
| **中文代码审查** | 需自行 prompt | **`review_code` 一等公民工具** | R1 推理 + JSON mode，结构化风险等级 |
| **依赖安全审计** | 需自行 prompt | **`audit_dependencies` 工具** | 中文软件供应链审计 |
| **中文提交信息** | 需自行 prompt | **`git_commit_msg` 工具** | 自动生成中文 Conventional Commits |
| **中英术语对照** | 无 | **`terminology` 工具** | 读英文文档自动映射中文通行译名 |
| **项目结构发现** | 无 | **`project_discover` 工具** | 一键生成中文项目地图 |
| **子 Agent 委派** | 有（sub-agent）| **`delegate` 工具** | 上下文隔离的子 Agent，结果截断回灌 |
| **会话恢复** | 有 | **`/resume` 命令** | 从 JSONL trace 重放完整对话 |
| **成本可视** | 有 | **`/cost` 命令** | 按模型分桶的 token 累加 + ¥ 估算 |
| **MCP 生态** | 成熟完整 | **stdio + Streamable HTTP 客户端已实现（`src/mcp/`）** | 插件化集成（动态工具注入）为后续 |

> **定位声明**：不追求「全面优于」Claude Code。目标是**在 DeepSeek 生态内、中文语境下、能力不打折**，并补齐几个 Claude Code 默认不具备的差异化能力。

---

## 核心设计哲学

### 1. 第一定律
> **Agency 来自模型训练；Agent 产品 = Model + Harness。工程师构建的是 Harness（承载环境），不是智能本身。**

因此本项目的全部工作集中在 **Harness 工程**：循环、工具、权限、上下文、生命周期——而非试图「教会模型什么」。

### 2. Agent Loop 不变式
```python
while stop_reason == "tool_use":
    response = LLM(messages, tools)
    execute tools, append results
# 循环永远不变，变化的是循环外的 harness 机制
```

### 3. Harness 五子系统
| 子系统 | 本项目落地 |
|--------|-----------|
| **Instructions** | 全中文 system prompt（含长对话管理指令）|
| **State** | 多轮上下文 + 摘要压缩 + 进度追踪 |
| **Verification** | 23 黄金 case 三档评测 + 真实 API 联调 |
| **Scope** | 一次一任务（WIP=1）+ Plan Mode 先规划 |
| **Lifecycle** | 初始化 → 执行 → JSONL trace 持久化 → `/resume` 恢复 |

### 4. 双模型策略（V4，2026-07）
DeepSeek V4 提供两类模型，本项目各取所长：

| 模型 | 角色 | 特点 | 接入点 |
|------|------|------|--------|
| `deepseek-v4-flash`（非思考） | Agent Loop 主循环 | 响应快、tool calling 精准、成本低 | `streamChat()` / `streamChatWithUsage()` |
| `deepseek-v4-pro`（思考） | 复合工具二次推理 | 1M 上下文、思考模式、分析质量高 | `complete()`（review / audit / terminology / discover / git_commit_msg）|

**路由规则**：主循环永远用 `deepseek-v4-flash` 且**显式关闭思考**（`extra_body.thinking={type:'disabled'}`），等价于旧 `deepseek-chat` 行为，并规避「思考+工具调用需回传 reasoning_content」的 400 陷阱；复杂分析型复合工具自动路由到 `deepseek-v4-pro` 并开启思考（`reasoning_effort`），追求分析深度。未配置 `REASONER_MODEL_ID` 时安全回退主模型。

> ⚠️ 旧别名 `deepseek-chat` / `deepseek-reasoner` 已于 **2026-07-24 15:59 UTC** 弃用，请改用上述 V4 模型。

---

## 系统架构

刻意避免「所有逻辑塞一个文件」，按可靠性分工拆成 **四层（应用 / 运行时 / 模型 / 工具）+ 上下文层**：

```
┌──────────────────────────────────────────────────────────┐
│ 应用交互层  src/cli                                        │
│  REPL 读取用户输入 · Markdown 流式渲染 · .env 配置 · 成本显示 │
│  职责：把输入变请求，把 Agent 过程/结果可视化               │
│  不该：直接调模型、直接执行工具                            │
└───────────────┬──────────────────────────────────────────┘
                │ 调用
┌───────────────▼──────────────────────────────────────────┐
│ Agent 运行时层  src/agent  （核心：Agent 怎么做事）         │
│  agent loop · 事件流 · 工具调度 · 权限决策 · 上下文压缩      │
│  · Plan Mode · Reflection 自我纠正 · 子 Agent 委派          │
└───────┬──────────────────────────┬───────────────────────┘
        │ 调模型                    │ 调工具
┌───────▼────────┐          ┌───────▼──────────────────────┐
│ 模型 API 层     │          │ 工具层  src/tools              │
│ src/llm         │          │ 15 个工具 + Zod schema 校验    │
│ DeepSeek 原生    │          │ 基础 7(含 awaitUser) + Git 3 + 差异化 4 + 委派 1 │
│ 流式 + tool_calls│          │ + 复合工具二次推理             │
└────────────────┘          └───────────────────────────────┘

        ↕ 共享 ↕
┌──────────────────────────────────────────────────────────┐
│ 上下文层  src/context                                       │
│ 多轮历史 · Token 预算压缩 · JSONL trace · 会话恢复          │
└──────────────────────────────────────────────────────────┘
```

**层间调试指南**：

| 现象 | 先查哪层 |
|------|----------|
| 工具调用失败 | 工具层 + 权限边界 |
| 流式输出中断 | 模型 API 层 + 应用交互层 |
| 模型跑偏 / 重复 | Agent 运行时层（上下文 + 指令）|
| 多轮记忆丢失 | 上下文层 |
| REPL 卡死 | 应用交互层 |

---

## 能力矩阵

### 工具清单（15 个）

**基础编程动作（7）**
- `read_file` / `create_file` / `edit_file` / `delete_file` / `run_command` / `search_code` / `awaitUser`（中途向用户提问，等待回复后继续当前任务）

**Git 一等公民（3）**
- `git_status` / `git_diff` / `git_commit_msg`（中文 Conventional Commits 自动生成）

**差异化复合工具（4，依赖 reasoner 二次推理 + JSON mode）**
- `review_code` — 中文代码审查，结构化风险等级（🔴高危/🟡中危/🟢建议）
- `audit_dependencies` — 中文软件供应链安全审计（已知漏洞 / 恶意包 / 升级建议）
- `terminology` — 中英术语对照（读英文文档自动映射中文译名）
- `project_discover` — 项目结构自动发现（扫目录 + 识技术栈 + 中文项目地图）

**子 Agent 委派（1）**
- `delegate` — 上下文隔离的子 Agent 执行独立子任务，结果截断回灌主对话

### 差异化能力详解（Claude Code 默认不具备）

| 能力 | 差异化价值 | 技术实现 |
|------|-----------|---------|
| **中文代码审查** | 逻辑 / 边界 / 安全 / 命名逐条中文讲解 | R1 + JSON mode → 结构化 → Markdown 渲染 |
| **依赖安全审计** | 中文软件供应链风险汇总 | R1 + JSON mode → 结构化审计 |
| **中文提交信息** | 自动生成中文 Conventional Commits | reasoner 分析 diff → 规范提交信息 |
| **中英术语对照** | 英文文档 / 报错一键中文映射 | reasoner + JSON mode → 术语表 + 易混淆辨析 |
| **项目结构发现** | 一键中文项目地图 | 目录扫描 + 技术栈识别 + reasoner 解读 |
| **子 Agent 委派** | 隔离上下文防主窗口污染 | delegate → 子 Agent → 结果截断回灌 |

---

## 关键工程决策（面试重点）

这些是本项目中最能体现**工程判断力**的决策点，每一个都来自真实踩坑与验证：

### ① 主模型 temperature 压到 0.1
工具选择的确定性比「创意」重要。temperature 偏高会让 review_code / audit 等差异化工具触发变得 **flaky**（时灵时不灵）。压低到 0.1 后，工具选择稳定可复现。

### ② 复合工具的子提示必须注入真实上下文
`review_code` 的二次推理提示词里**必须包含源码原文**，否则 reasoner 模型会**幻觉编造**不存在的问题。这是复合工具设计的核心约束。

### ③ 双模型路由而非单模型全包
主循环用 chat（快、准、省），深度分析用 reasoner（深、慢、贵）。混用会让主循环变慢变贵、让分析变浅。路由策略是「能力最大化」的关键。

### ④ JSON mode 必须配渲染层
复合工具启用 `response_format: { type: 'json_object' }` 后，返回的是 JSON，CLI 场景**不能直接展示 JSON**。必须用 `renderXxx()` 把结构化数据转成可读 Markdown（含解析失败的优雅降级）。

### ⑤ 摘要压缩的 fallback 降级
长上下文采用 **Token 预算制（48K）+ 模型摘要压缩**替代硬截断。但 LLM 不可用时（如子任务失败）必须有降级：fallback 为旧版「保留最近 N 轮 + 丢弃旧消息」，保证不崩。

### ⑥ 会话恢复的空 `tool_calls` 陷阱
DeepSeek / OpenAI 协议要求：`assistant.tool_calls` **要么不存在，要么是非空数组**。纯文本轮次若带 `tool_calls: []` 发给 API 会直接 **400**。replay 重建消息时必须过滤空数组。

### ⑦ 递归 REPL 的同步陷阱
CLI 用递归 `rl.question` 处理命令时，**所有命令分支必须同步（无 await）**。原 `/resume` 在 answer 回调里 `await replay()` 导致后续输入被吞、对话中断。正确做法：启动时预加载上次会话、命令分支同步消费。

### ⑧ `noExplicitAny` 不是有效编译选项
TS 没有 `noExplicitAny` 这个选项（只有 `noImplicitAny`，`strict` 已包含）。要消除显式 `any`，只能**手动消除**——本项目消除了全部 36 处显式 `any`（SDK 调用改 `as unknown as` 精确断言、catch 改 `unknown` + 收窄），在 `strict` 下做到零错误。

---

## 工程质量

| 维度 | 状态 |
|------|------|
| **TypeScript** | `strict: true`，零编译错误（`tsc --noEmit`）|
| **评测** | 23 黄金 case，三档验证（code 断言 / LLM 裁判 / 人工复核）；最新一次全量跑分 **23/23 全通过（100%，LLM 裁判档平均 5.00/5）**，完整报告见 eval/RESULTS.md |
| **真实联调** | P1–P5 每个增强均经真实 API 联调验证（非仅编译通过）|
| **观测** | JSONL trace 持久化到 `.dsa/traces/`，CLI 启动显示最近 trace 摘要 |
| **日志** | 分级日志（debug/info/warn/error），`msgOf` / `asExecError` 错误收窄 |
| **权限** | 三档模式（explore / ask / execute）+ 破坏性命令强制确认 |
| **容错** | Reflection 自我纠正（工具失败自动重试，最多 3 次）|

---

## 快速开始

### 环境要求
- Node.js ≥ 22
- DeepSeek API Key（[platform.deepseek.com](https://platform.deepseek.com)）

### 安装与配置
```bash
cd deepseek-code-agent
npm install

# 在项目根目录创建 .env
cat > .env <<'EOF'
DEEPSEEK_API_KEY=sk-你的密钥
DEEPSEEK_BASE_URL=https://api.deepseek.com
MODEL_ID=deepseek-v4-flash
REASONER_MODEL_ID=deepseek-v4-pro
EOF
```

### 启动
```bash
npm start
# 或开发模式（热重载）
npm run dev
# 或直接使用 tsx
npx tsx src/cli/main.ts
```

### 交互命令
| 命令 | 作用 |
|------|------|
| `/help` | 显示帮助 |
| `/mode explore|ask|execute` | 切换权限模式 |
| `/plan` | 进入规划模式（先输出步骤，确认后再执行）|
| `/resume` | 从最近会话恢复上下文 |
| `/cost` | 查看累计 token 用量与费用估算 |
| `/clear` | 清空对话上下文 |
| `/exit` | 退出 |

### 示例对话
```
你> 读取 src/llm/deepseek.ts 并审查这段代码的质量
Agent> [调用工具] review_code
      → R1 推理生成中文结构化审查报告（风险等级 + 逐条建议）

你> 让子 agent 去读 package.json 告诉我项目的 name 和 version
Agent> [调用工具] delegate
      → 子 Agent 隔离执行 → 结果截断回灌主对话

你> /cost
      💰 累计 deepseek-v4-flash: 6,602tok(¥0.0071) | deepseek-v4-pro: 1,204tok(¥0.0048)
```

---

## 项目状态与路线图

### 当前版本：v0.5.0
全部功能已落地（`feature_list.json` 共 32 项特性，全部 done），23 黄金 case 评测集（三档验证，最新全量跑分 **23/23 全通过**），TS strict 零错误、零显式 `any`、零 TODO/FIXME。

```
P1 DeepSeek 原生能力释放      ✅ 双模型路由 / 长上下文 / JSON mode
P2 Claude Code 优点集成       ✅ JSONL trace / Git 一等公民 / Plan Mode / Reflection / 写前 diff 审批
P3 差异化能力深化             ✅ terminology / project_discover / 记忆层(RAG-lite)
P4 工程质量加固               ✅ 子 Agent 委派 / 分级日志 / TS strict / 循环卡死隐患修复
P5 体验升级                   ✅ Markdown 渲染 / 会话恢复 / 成本估算 / 全屏 TUI
```

### 可选后续方向
- **MCP 插件架构**（将 MCP 服务发现的能力以动态插件形式注入工具层，形成生态扩展）——基础 MCP 客户端协议（stdio + Streamable HTTP）已完成（`src/mcp/`），剩余为上层插件化集成与工具动态发现。

---

## 学习来源

本项目是「Agent 开发四站渐进式学习路线」的**收官实战项目**（对应学习文档第四张图片「用垂直项目验证你全学会了」模块），综合运用了：

1. **hello-agents** — Agent 概念地图（Tool / Memory / RAG / Workflow / Multi-Agent / Evaluation）
2. **learn-claude-code** — Agent Loop 核心（从单一循环到全机制）
3. **learn-harness-engineering** — 工程控制系统（五子系统）
4. **craft-agents-oss** — 全链路产品分层（Monorepo / 双后端 / MCP / Skill 插件）

> **核心理念贯穿始终**：Agency 来自模型训练，工程师构建的是 Harness。本项目全部价值都在 Harness 层的工程判断上。

---

<p align="center">
  <sub>DeepSeek Code Agent · 直连官方 API · 对标并差异化 Claude Code · 中文原生编程 Agent</sub>
</p>
