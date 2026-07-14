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
- **技能系统（项目级 + 全局）**：系统提示词列出可用技能（标注 `[项目]` / `[全局]` 作用域），模型按需调用 `use_skill` 加载完整指引（含打包脚本路径），复用可复用工作流。项目级技能放 `<cwd>/.workbuddy/skills/`，全局技能放 `~/.workbuddy/skills/`（所有项目共用）；同名时项目级覆盖全局级。设 `DSA_INCLUDE_GLOBAL_SKILLS=0` 可关闭全局扫描；设 `DSA_GLOBAL_SKILLS_ALLOW=name1,name2` 或编辑 `~/.workbuddy/skills.allow.json` 可指定**全局技能白名单**（仅放行列表内全局技能，避免把学术/设计类等无关全局技能灌入编程 Agent 上下文）。

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
| `/skills` | 查看可用技能与管理全局技能白名单（见下）|
| `/history [关键字]` | 历史对话可视化面板（KPI + 按模型/权限模式/状态/时间的条形图 + 可筛选会话列表）；聊天视图下按 `h` 亦可切换 |
| `/style human\|professional\|raw` | 切换最终答复的说话风格（人话 / 专业语言 / 原始），偏好持久化到 `.dsa/output-style.json` |
| `/polish` | 按当前风格，把上一条 Agent 回复改写成更通顺的版本（不改动事实与代码，只润色表达）|
| `/exit` | 退出 |

### 历史对话可视化（`/history`）

在终端里直接查看你的对话历史，无需离开 TUI、无需浏览器：

- **数据来源**：deepseek-code-agent 自己的聊天记录，即 TraceLogger 持久化的 `<cwd>/.dsa/traces/*.jsonl`（每个文件是一个独立会话），并合并子 Agent 会话存档 `<cwd>/.dsa/sessions/*.json`。**不读取** WorkBuddy 全局会话库（那是 IDE 跨所有项目的汇总，与本项目无关）。
- **读取方式**：纯文件系统解析，零新增依赖、零原生模块。
- **面板内容**：
  - 顶部 KPI：总会话数、消息总数、使用模型数、时间跨度。
  - 四张终端条形图：按模型、按权限模式、按状态（已完成/进行中）、按近 14 天时间线。
  - 会话列表：按创建时间倒序，标注状态、模型、消息条数、日期。
- **当前会话高亮**：列表里正在进行的本次会话会以青色「● 当前」徽章标出，顶部也显示其 trace id，方便确认「当前聊天 = 哪条记录」（每条记录独立，对应一个 `.dsa/traces/<id>.jsonl` 文件）。
- **交互**：进入后输入任意关键字即实时筛选（图表与列表同步过滤）；`↑`/`↓` 浏览列表；`Enter` 加载当前选中的会话为后续对话上下文，并回到主聊天（主聊天顶部会显示该会话标题，标题即该会话的第一条消息）；`Esc` 或 `←` 直接返回聊天。也可在聊天视图下按 `h` 直接进入。


### 输出风格（`/style`）

控制 Agent 最终那一段话"怎么说"，避免干巴巴的技术堆砌或原始 dump：

- **human（人话，默认）**：用面向普通用户的通俗类比解释技术概念，必须讲清"做了什么 / 为什么 / 怎么验证"，段落连贯、可读性强。
- **professional（专业语言）**：使用对应领域的规范术语与严谨表述，结论先行、保留必要的技术细节与代码片段，适合有基础的工程师阅读。
- **raw（原始）**：不注入任何风格指令，保留模型默认输出。

用法：`/style human` / `/style professional` / `/style raw`；不带参数时显示当前风格。偏好持久化到 `<cwd>/.dsa/output-style.json`，重启后保留。底部状态栏也会显示当前风格。

`/polish`：按当前风格，把**上一条** Agent 回复改写成更通顺的版本（只改表达，不改事实与代码）。适合模型已经答完、但措辞想再打磨时使用；raw 风格下无需润色。

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

**技能**
- `use_skill` — 按名称加载某技能的完整指引（不区分作用域，同名时项目级优先）；系统提示词会列出当前可用技能及其 `[项目]`/`[全局]` 作用域与适用场景。若技能不存在，会回显当前全局过滤状态，并提示用 `/skills allow <name>` 放行被白名单排除的全局技能。

**技能作用域与全局白名单**
- 项目级技能放 `<cwd>/.workbuddy/skills/`（随项目提交，始终可用，不受白名单影响）；全局技能放 `~/.workbuddy/skills/`（跨项目共用）。同名时项目级覆盖全局级。
- 全局技能默认经白名单过滤，避免把无关全局技能灌入编程 Agent 上下文。白名单来源优先级：构造函数 `globalAllow` > 环境变量 `DSA_GLOBAL_SKILLS_ALLOW` > 配置文件 `~/.workbuddy/skills.allow.json`（`{ "allow": [...] }`；显式 `[]` = 排除全部全局，无该文件 = 全部放行）。设 `DSA_INCLUDE_GLOBAL_SKILLS=0` 可完全关闭全局扫描。

**内置项目级技能**（位于 `<cwd>/.workbuddy/skills/`，随仓库提交）
- `local-web-preview` — 本地静态服务后台启动 + 轮询就绪 + 浏览器预览，规避「前台阻塞 / `cd /d` 语法 / `file://` 降级」三坑。已对照 Anthropic 官方 skill 规范优化写法。
- `webapp-testing` — 用 Playwright 测试本地 web 应用（管理 server 生命周期、截图、查 DOM、读 console）。改编自 Anthropic 官方开源技能（Apache 2.0）。运行时需 `pip install playwright` 且已安装浏览器。
- 运行时用 `/skills` 命令查看与调整白名单，立即在本会话生效（由配置文件层控制时）并持久化：`/skills list` 列出可用技能与过滤状态；`/skills allow <名称>` 放行；`/skills disallow <名称>` 移除；`/skills clear` 排除全部全局；`/skills all` 允许全部全局。

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
