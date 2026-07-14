# DeepSeek Code Agent

一个直连 DeepSeek 官方 API 的中文编程 Agent CLI。它把 DeepSeek 作为一等公民来设计 Harness，在中文工程语境下提供代码阅读、编辑、运行、审查、依赖审计等能力，并附带 Git 集成、会话恢复、成本估算等开发体验。

[![version](https://img.shields.io/badge/version-v0.5.0-blue)](./package.json)
[![typescript](https://img.shields.io/badge/TypeScript-strict-3178c6)](./tsconfig.json)

## 特性

- **直连官方 API**：无中转站、无代理，密钥保存在本地 `.env`
- **全中文交互**：对话、提交信息、代码审查、依赖审计全部中文
- **15 个内置工具**：文件读写改删、命令执行、代码搜索、Git、中文代码审查、依赖审计、中英术语对照、项目结构发现、子 Agent 委派
- **双模型策略**：主循环用 `deepseek-v4-flash` 做工具调度（快、省），复杂分析用 `deepseek-v4-pro` 做深度推理
- **会话持久化**：对话以 JSONL trace 记录，可 `/resume` 恢复
- **权限三模式**：`explore`（只读）/ `ask`（需确认）/ `execute`（自动执行）
- **Plan Mode**：先输出执行步骤，确认后再动手
- **成本可视**：`/cost` 查看累计 token 与费用估算

## 安装

```bash
git clone <repo>
cd deepseek-code-agent
npm install
```

要求 **Node.js ≥ 22**。

## 配置

在项目根目录创建 `.env`：

```bash
DEEPSEEK_API_KEY=sk-你的密钥
DEEPSEEK_BASE_URL=https://api.deepseek.com
MODEL_ID=deepseek-v4-flash
REASONER_MODEL_ID=deepseek-v4-pro
```

| 变量 | 说明 |
|------|------|
| `DEEPSEEK_API_KEY` | 在 [platform.deepseek.com](https://platform.deepseek.com) 获取 |
| `DEEPSEEK_BASE_URL` | API 地址，默认 `https://api.deepseek.com` |
| `MODEL_ID` | 主循环模型（非思考模式，负责工具调度）|
| `REASONER_MODEL_ID` | 复合工具（审查 / 审计 / 术语 / 项目发现 / 提交信息）使用的推理模型；不配置时回退到主模型 |

> DeepSeek V4 旧别名 `deepseek-chat` / `deepseek-reasoner` 已弃用，请使用上述 V4 模型名。

## 使用

### 启动

```bash
npm start
# 或直接使用 tsx
npx tsx src/cli/main.ts
```

### 交互命令

| 命令 | 作用 |
|------|------|
| `/help` | 显示帮助 |
| `/mode explore\|ask\|execute` | 切换权限模式 |
| `/plan` | 进入规划模式（先输出步骤，确认后再执行）|
| `/resume` | 从最近会话恢复上下文 |
| `/cost` | 查看累计 token 用量与费用估算 |
| `/clear` | 清空对话上下文 |
| `/exit` | 退出 |

### 工具一览

**基础文件操作**
- `read_file` — 读取文件内容（支持 `offset` / `limit`）
- `create_file` — 新建文件
- `edit_file` — 字符串替换修改文件（修改前展示 diff 供确认）
- `delete_file` — 删除文件（需确认）
- `run_command` — 执行 shell 命令，返回 stdout / stderr / 退出码
- `search_code` — 在代码库中正则搜索
- `awaitUser` — 执行中途向用户提问，等待回复后继续当前任务

**Git**
- `git_status` — 查看工作区状态
- `git_diff` — 查看改动
- `git_commit_msg` — 根据 diff 生成中文提交信息

**中文分析与发现**
- `review_code` — 中文代码审查报告（风险等级 + 逐条建议）
- `audit_dependencies` — 中文依赖安全审计（漏洞 / 恶意包 / 升级建议）
- `terminology` — 中英术语对照（读英文文档时映射中文译名）
- `project_discover` — 扫描项目结构，生成中文项目地图
  - `delegate` — 派发子 Agent 执行独立子任务（上下文隔离），结果回灌主对话

> 想深入了解权限三模式的运作机制，以及每个工具的风险级别与完整说明？→ [详细了解各种指令的具体功能](./docs/commands.md)

## 项目结构

```
src/
  cli/        交互层：REPL、Markdown 渲染、配置读取、成本显示
  agent/      Agent 运行时：主循环、Plan Mode、Reflection、子 Agent 委派
  llm/        DeepSeek API 封装：流式、双模型路由、tool_calls
  tools/      15 个工具实现 + 安全 / 护栏逻辑
  context/    多轮历史、上下文压缩、JSONL trace
  memory/     记忆层（本地向量检索，RAG-lite）
  mcp/        MCP 客户端（stdio + Streamable HTTP）
```

## 开发

```bash
npm run typecheck   # TypeScript strict 类型检查
npm test            # 运行单元测试（node:test，零依赖）
npm run eval:check  # 静态校验评测集结构（无需 API key）
```

- 类型检查开启 `strict`，无显式 `any`
- 评测套件见 `eval/`，含黄金用例；真实跑分需配置 DeepSeek API key 后执行 `npx tsx eval/run-eval.ts`

## License

本项目基于 [MIT 许可证](./LICENSE) 开源。允许自由使用、修改与分发，唯须保留版权声明与许可声明。
