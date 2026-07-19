# DeepSeek Code Agent

一个直连 DeepSeek 官方 API 的中文编程 Agent。它把 DeepSeek 当作一等公民来设计 Harness，在中文工程语境下提供代码阅读、编辑、运行、审查、依赖审计、Git 集成等能力，并同时提供 **命令行（CLI）** 与 **网页（Web GUI）** 两种使用方式。

适合谁：想在本地用 DeepSeek 模型做编程辅助、代码审查、依赖审计，且希望交互与产出都是中文的开发者。

## 功能概览

- **直连官方 API**：无中转、无代理，密钥只保存在本地。
- **双模型策略**：主循环用 `deepseek-v4-flash` 做工具调度（快、省），复杂分析用 `deepseek-v4-pro` 做深度推理。
- **全中文交互**：对话、提交信息、代码审查、依赖审计均为中文。
- **CLI + Web 双界面**：终端里跑，或开网页用（三栏式、账户登录、多任务）。
- **会话持久化**：对话以 JSONL 记录，可 `/resume` 恢复；Web 端按任务线程隔离。
- **权限三模式**：`explore`（只读）/ `ask`（需确认）/ `execute`（自动执行），文件写操作默认展示 diff 再确认。
- **Plan Mode**：先输出执行步骤，确认后再动手。
- **成本可视**：`/cost` 查看累计 token 与费用估算。
- **技能系统**：项目级 + 全局技能，模型按需调用；全局技能可设白名单。
- **记忆层**：本地轻量向量检索（RAG-lite），跨会话记住项目事实。
- **账户体系（Web）**：密码登录，每账号独立数据目录与 API Key。

## 安装

要求 **Node.js ≥ 22**。

```bash
git clone https://github.com/wjq0407/DeepSeek-Code.git
cd deepseek-code-agent
npm install
```

> 依赖安装后占用本地 `node_modules/`，已被 `.gitignore` 排除，不会进入仓库。

## 配置 API Key

两种方式，任选其一：

**方式 A：CLI（`.env`）**

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

> `.env` 已被 `.gitignore` 排除，不会误提交。DeepSeek V4 旧别名 `deepseek-chat` / `deepseek-reasoner` 已弃用，请使用上述 V4 模型名。

**方式 B：Web GUI（设置里填）**

启动网页版后，先注册 / 登录账户，再在「设置 → API Key」中填写你的 DeepSeek API Key；展开「高级设置」可配置主模型（默认 `deepseek-v4-flash`）与推理模型（默认 `deepseek-v4-pro`）。每个账户的 Key 独立保存。

## 使用

### 命令行（CLI）

```bash
npm start
# 等价于 npx tsx src/cli/main.ts
```

### 网页（Web GUI）

```bash
npm run web
```

首次会先构建前端再启动服务，打开 **http://localhost:4173**。

- **账户**：首次用任意用户名 + 密码注册（密码用 scrypt 哈希存本机 `~/.dsa/accounts.json`，不存明文）；登录后签发 30 天有效 token，刷新可免登录。
- **多任务**：每个账户可新建 / 切换 / 删除多个任务线程，互不干扰。
- **换端口**：设置环境变量 `DSA_WEB_PORT`（如 `DSA_WEB_PORT=4199 npm run web`）。
- **数据隔离**：每个账户的数据落在 `~/.dsa/users/<用户名>/`（任务 / 历史 / 记忆 / 日志），互不可见。

### 交互命令（CLI）

| 命令 | 作用 |
|------|------|
| `/help` | 显示帮助 |
| `/mode explore\|ask\|execute` | 切换权限模式 |
| `/plan` | 进入规划模式（先输出步骤，确认后再执行）|
| `/resume` | 从最近会话恢复上下文 |
| `/cost` | 查看累计 token 用量与费用估算 |
| `/clear` | 清空对话上下文 |
| `/skills` | 查看可用技能与管理全局技能白名单 |
| `/history [关键字]` | 历史对话可视化面板（KPI + 图表 + 可筛选会话列表）|
| `/style human\|professional\|raw` | 切换最终答复风格（人话 / 专业 / 原始），持久化到 `.dsa/output-style.json` |
| `/polish` | 按当前风格润色上一条 Agent 回复 |
| `/exit` | 退出 |

> 想了解每个命令的具体行为，见 [docs/commands.md](./docs/commands.md)。

### 历史对话可视化（`/history`）

在终端里直接看你的对话历史，无需离开 TUI：

- **数据来源**：本项目的聊天记录 `<cwd>/.dsa/traces/*.jsonl`（每个文件一个会话）+ 子 Agent 存档 `<cwd>/.dsa/sessions/*.json`。
- **面板内容**：顶部 KPI（会话数 / 消息数 / 模型数 / 时间跨度）；四张条形图（按模型、权限模式、状态、近 14 天）；可筛选会话列表。
- **交互**：输入关键字实时筛选；`Enter` 载入选中会话为后续上下文；`Esc` / `←` 返回；聊天视图下按 `h` 也可进入。

### 输出风格（`/style`）

- **human（默认）**：用通俗类比解释，讲清「做了什么 / 为什么 / 怎么验证」。
- **professional**：规范术语、结论先行、保留技术细节。
- **raw**：保留模型默认输出。

`/polish`：按当前风格把上一条回复改写得更通顺（只改表达，不改事实与代码）。

## 工具一览

内置 20+ 工具，按类别列出常用项（复合工具会自动调用内部子步骤，无需手动触发）：

**文件与目录**

- `read_file` — 读取文件（支持 `offset` / `limit`）
- `create_file` — 新建文件
- `write_file` — 写入 / 覆盖文件
- `edit_file` — 字符串替换修改（写前展示 diff 确认）
- `delete_file` — 删除文件（需确认）
- `ensure_dir` — 创建目录
- `list_dir` — 列出目录内容

**命令与搜索**

- `run_command` — 执行 shell 命令，返回 stdout / stderr / 退出码
- `search_code` — 正则搜索代码内容
- `search_files` — 按文件名 / 通配符搜索

**任务管理**

- `todo_write` — 维护任务清单，跟踪多步任务进度

**Git**

- `git_status` — 查看工作区状态
- `git_diff` — 查看改动
- `git_commit_msg` — 根据 diff 生成中文提交信息

**中文分析与校验**

- `review_code` — 中文代码审查（风险等级 + 逐条建议）
- `audit_dependencies` — 中文依赖安全审计（漏洞 / 恶意包 / 升级建议）
- `terminology` — 中英术语对照
- `project_discover` — 扫描项目结构，生成中文项目地图
- `verify_code` — 代码验证
- `verify_answer` — 回答验证
- `deep_gen` — 深度生成

**委派与技能**

- `delegate` — 派发子 Agent 执行独立子任务（上下文隔离），结果回灌主对话
- `use_skill` — 按名称加载技能完整指引

## 技能系统

- **作用域**：项目级技能放 `<cwd>/.workbuddy/skills/`（随项目提交，始终可用）；全局技能放 `~/.workbuddy/skills/`（跨项目共用）。同名时项目级覆盖全局级。
- **全局白名单**：避免无关全局技能灌入上下文。优先级：环境变量 `DSA_GLOBAL_SKILLS_ALLOW` > 配置文件 `~/.workbuddy/skills.allow.json`（`{ "allow": [...] }`，显式 `[]` = 排除全部全局）；设 `DSA_INCLUDE_GLOBAL_SKILLS=0` 可关闭全局扫描。
- **管理**：运行时用 `/skills` 查看与调整（`/skills list | allow <名> | disallow <名> | clear | all`）。

## 项目结构

```
src/
  cli/        CLI 交互层（REPL、Markdown、配置、成本、auth）
  gui/        网页后端（HTTP 静态服务 + WebSocket 桥接、账户、多任务）
  gui/web/    网页前端（React + Vite）
  app/        CLI / Web 共用内核装配与类型
  agent/      Agent 运行时（主循环、Plan Mode、Reflection、子 Agent）
  llm/        DeepSeek API 封装（流式、双模型路由、tool_calls）
  tools/      工具实现 + 安全 / 护栏
  context/    多轮历史、上下文压缩、JSONL trace
  memory/     记忆层（本地向量检索）
  skills/     技能加载器
  mcp/        MCP 客户端（stdio + Streamable HTTP）
```

## 开发

```bash
npm run typecheck   # TypeScript strict 类型检查
npm test            # 单元测试（node:test，零依赖）
npm run eval:check  # 评测集结构静态校验（无需 API key）
npm run dev         # 以 watch 模式启动 CLI（开发用）
```

- 类型检查开启 `strict`，无显式 `any`。
- 评测套件见 `eval/`；真实跑分需配置 API key 后执行 `npx tsx eval/run-eval.ts`。

## 安全说明

- 密钥只保存在本地 `.env`（CLI）或账户设置（Web），均不入库。
- 通过 `run_command` / MCP 启动子进程时，疑似密钥的环境变量会被自动剥离，防止泄露。
- 文件工具限制在项目目录内，路径遍历会被拒绝。
- Web 账户密码用 scrypt 加盐哈希存储，无明文；会话 token 30 天有效。

## License

基于 [MIT 许可证](./LICENSE) 开源。允许自由使用、修改与分发，唯须保留版权声明与许可声明。
