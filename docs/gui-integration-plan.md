# GUI 集成规划（deepseek-code-agent → 网页版 / 通用产品）

> 目标用户定位：**普通人**（非命令行用户）。
> 当前形态：`ink` 终端 TUI 的 Claude Code 风格 CLI 编程 Agent（内核已完整：Agent Loop / History / Tools / Skills / Memory / SessionManager）。
> 本文记录「给现有内核套一层 GUI 产品外壳」的分阶段路线，以及**已落地的最小可跑网页骨架**（Step 0.1 + 0.2）。

---

## 1. 一句话结论

**内核零改动即可复用。** `main.ts` 已经把所有服务（client / memory / skills / session / tools）组装好，通过 `startApp(props)` 整体注入 UI 层。UI 层只负责「渲染 + 事件」。所以 GUI 化 = 「抽 `useAgentController` 共用逻辑 + 把 ink 换成 DOM 组件 / 浏览器客户端」两件事。

关键约束：**浏览器没有 `fs` / `process`**，内核（记忆落盘、会话持久化、工具执行）必须跑在 Node。因此网页版采用「**Node 后端持有内核 + WebSocket 桥接 + 浏览器瘦客户端**」架构，而非把内核直接塞进浏览器。

---

## 2. 架构图：现有内核 vs 待建产品层

```
┌───────────────────────── 内核（Node，零改动） ─────────────────────────┐
│  DeepSeekClient · ConversationHistory · Tools(13+) · MCP · Skills ·       │
│  MemoryManager · SessionManager · TraceLogger · runAgent(Agent Loop)     │
└───────────────────────────────────┬─────────────────────────────────────┘
                                     │ AppProps（唯一契约）
            ┌────────────────────────┴────────────────────────┐
            ▼ 终端 UI（ink）                ▼ 网页 UI（浏览器）
   src/cli/app.tsx                  src/gui/web/App.tsx (DOM)
   useAgentController ──┐           浏览器瘦客户端（仅渲染+WS）
   （React hook）       │
            └──────────┬─────────── 共用「框架无关编排核心」 ──────────┐
                       ▼                                            ▼
              src/app/chat.ts（handleSlashCommand / runChatTurn /       
              applyRunAgentEvent）← 业务逻辑单次事实来源               
                       │                                           
              ┌────────┴─────────┐                                  
              ▼                  ▼                                  
   useAgentController    AgentHost (Node EventEmitter)             
   （CLI 实现）          （网页后端实现，跑在 server.ts）          
                       │                                           
                       ▼                                           
              src/gui/server.ts（http 静态服务 + WebSocket 桥接）   
```

两个 UI 都只实现同一个 `ChatContext` 接口，业务逻辑在 `chat.ts`，**零重复**。

---

## 3. 文件级接入点清单

### A. 新增（产品层）
| 文件 | 作用 |
|---|---|
| `src/app/types.ts` | 共享契约：`AppProps` / `UiMessage` / `MsgRole`（仅类型，零运行时依赖，浏览器可安全 `import type`） |
| `src/app/commands.ts` | 原 app.tsx 的 `handleMemory` / `handleSkills` / `applyMemoryIntent`（与渲染无关，CLI/后端共用） |
| `src/app/chat.ts` | **框架无关编排核心**：`ChatContext` 接口 + `handleSlashCommand` + `runChatTurn` + `applyRunAgentEvent` |
| `src/app/useAgentController.ts` | CLI 端 `ChatContext` 实现（React hook），`app.tsx` 消费 |
| `src/gui/agent-host.ts` | 网页后端 `ChatContext` 实现（Node EventEmitter，广播事件给 WS 客户端） |
| `src/gui/server.ts` | Node HTTP 静态服务 + WebSocket 桥接（持有内核，转发消息/确认/中断） |
| `src/gui/web/{index.html,main.tsx,App.tsx,styles.css}` | 浏览器 DOM 聊天界面（react-markdown 渲染，连 WS） |
| `src/cli/assemble.ts` | 抽出「组装 AppProps」逻辑，CLI 与后端共用 |
| `vite.config.ts` | 前端构建配置（入口 `src/gui/web`，产物 `dist/gui`） |
| `docs/gui-integration-plan.md` | 本文档 |

### B. 重构（逻辑不变，从 app.tsx 抽走）
- `AppProps` / `UiMessage` / `MsgRole` 定义 → `src/app/types.ts`
- `handleMemory` / `handleSkills` / `applyMemoryIntent` → `src/app/commands.ts`
- `submit` + `handleCommand` + `runAgent` 事件循环 → `src/app/chat.ts`（框架无关）
- `app.tsx` 改为：保留 ink 渲染 + `useInput` 终端输入，聊天逻辑全委托 `useAgentController`
- `main.ts` 改为：保留登录门禁，组装逻辑委托 `assemble.ts`

### C. 保留不变（内核，0 改动）
`runAgent` · `SessionManager` · `tools/*` · `memory/*` · `skills/*` · `mcp/*` · `llm/*` · `context/*`

---

## 4. 分阶段落地路线

### 阶段 0（生死线）：GUI 外壳 —— **已落地 Step 0.1 + 0.2**
- **Step 0.1 Web 优先验证**：`react-dom` + `vite` 构建最小 DOM 聊天界面，浏览器即可对话。
- **Step 0.2 抽控制器**：`useAgentController` + `chat.ts` 共用逻辑；CLI 行为不变（`tsx src/cli/main.ts` 仍可回归）。
- 同时提供 Node 后端（`agent-host` + `server`）承载内核，规避浏览器无 `fs/process` 的限制。
- **已验证**：`npm run typecheck` 通过；`npm run web`（build + 启动）可起服务；浏览器连 WS 对话。

### 阶段 1（护城河）：Sources 自然语言自发现接入
Craft Agents 最与众不同的一点——用户说「连我的 Gmail」，agent 自己查文档、配 OAuth、存凭据。当前已有 MCP 接入 + skill 机制，但缺「让 agent 主动发现并配置外部服务」这层 Sources 抽象。这是最该抄的一步。

### 阶段 2（产品体验 + 安全硬要求）：会话状态 / 收件箱 + 凭据加密
- 在 `SessionManager` 上加状态机 `Todo → In Progress → Needs Review → Done` + 标记/归档，前端做收件箱视图。
- 凭据 AES-256-GCM 加密落盘（参考 Craft 的 credentials 模块）。普通人把 Gmail/微信凭据交给你，加密是硬要求。

### 阶段 3（进阶加分）：多 provider / Automations / Electron 瘦客户端
- 多 provider 解耦：当前 DeepSeek 双模型硬编码，建议抽象 provider 接口让普通人可换更稳的模型兜底。
- Automations：事件总线 + 规则引擎（标签变更 / cron 触发自动会话）。
- Electron 壳（可选）：把网页前端装进桌面窗口，得到真正的原生 GUI 产品（当前网页版已是功能等价的最小形态）。

---

## 5. 关键风险点（已实现中已规避）
1. **`useInput` 大 switch**：终端光标/编辑逻辑整段删除，DOM 下用受控输入框 + `onKeyDown`，仅映射 Enter 提交 / Ctrl+C 中断。
2. **终端尺寸 → 容器尺寸**：`process.stdout.columns/rows` 全部删除，DOM 用 flex + 容器滚动。
3. **ANSI 颜色 → CSS**：ink `color="#2f6fb0"` 换 CSS 变量（`styles.css` 的 `--blue`）。
4. **流式渲染频率**：`runAgent` 高频 append 在后端逐事件经 WS 推送；若觉卡顿可对 `tool_progress` 节流批处理（TODO）。
5. **内核不能在浏览器跑**：所有 `fs/process` 逻辑只在 Node 后端执行，浏览器只跑 DOM + WebSocket。
6. **`react-markdown` 仅前端引入**：`chat.ts` / `agent-host.ts` 绝不 import 任何渲染层（否则会把 ink 拉进 Node 后端）。

---

## 6. 如何运行网页版

```bash
# 1) 安装依赖（含 react-dom / react-markdown / ws / vite）
npm install

# 2) 构建前端 + 启动 Node 后端（默认 http://localhost:4173）
npm run web
# 或分开：npm run web:build  然后  npm run web:start

# 3) 浏览器打开 http://localhost:4173
```

前置：需先有 DeepSeek API Key。网页后端会复用终端版已保存的 `~/.dsa/credentials.json`；
也可用环境变量 `DEEPSEEK_API_KEY` 启动。未配置 Key 时服务启动会提示并退出。

网页版支持：聊天、流式工具输出、`/help` `/mode` `/plan` `/style` `/cost` `/clear` `/resume` `/memory` `/skills` 等斜杠命令、权限确认弹窗（`y/n`）、模型 `awaitUser` 自由文本回复、中断按钮。
暂未实现（对应终端版专属视图）：历史会话可视化面板（`/history`）、更换 Key 遮罩（`/set-key`，提示去终端版）、会话面板多 Agent 调度（fork/派发）。

---

## 7. 本次提交落地范围小结
- 抽出 `types.ts` / `commands.ts` / `chat.ts` / `useAgentController.ts`，CLI 与网页共用同一份业务逻辑。
- 新增 Node 后端 + 浏览器瘦客户端，浏览器真实连上现有内核跑 Agent。
- `app.tsx` 重构为「ink 渲染 + 终端输入」，逻辑委托控制器，CLI 行为不变。
- `main.ts` 复用 `assemble.ts`，登录门禁保留。
