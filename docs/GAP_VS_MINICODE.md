# deepseek-code-agent vs MiniCode：差距与必须工程化清单

> 评估时间：2026-07-12（基于两仓库当前真实源码，非旧记忆）
> 一句话结论：**你已全面反超教学版 MiniCode，真正要补的是几个生产级工程化钉子，不是"落后"。**

---

## 0. 先纠正一个判断：你不是落后，是反超

MiniCode 是「Claude Code 设计的最小可读标本」，定位教学。你的 deepseek-code-agent 是实战产品。
逐项核对后，**以下能力你要么有、要么比它强**：

| 能力 | MiniCode | 你的项目 | 结论 |
|---|---|---|---|
| Agent Loop 不变式 | ✓ | ✓ | 持平 |
| 权限系统 | Ask/Allow/Deny(+反馈) | explore/ask/execute 三模式 + 破坏性命令强制确认 + 静态检测 | **你更强** |
| 上下文压缩 | snip + collapse（教学双策略） | LLM 摘要压缩 + **确定性 snip 降级**（head+tail 保留，token 预算 400K）+ 每轮末自动压缩 | **你更实用**（中文场景 + 已补 snip） |
| MCP | stdio + http 客户端 | stdio + **StreamableHTTP**（官方 SDK）+ 单 server 错误隔离 + 工具前缀防冲突 | **你更强、更工程化** |
| 模型层 | Anthropic Adapter / Mock | 双模型 V4（flash 主循环 + pro 复合工具）+ 成本估算 + 缓存命中价 | **你更强** |
| 记忆层 | 分层规则（user/project/session） | 全套 RAG 轻量（embedder/composer/extractor/retriever/store） | **你更强** |
| 差异化能力 | 无 | 中文代码审查 / 依赖审计 / 术语 / 项目发现 / git commit | **你独有** |
| 计划 / 反思 | 无 | Plan Mode + Reflection 自我纠正 | **你独有** |
| 多会话 | Session + fork | SessionManager(main/child) + 非阻塞后台 runner + 持久化 + fork/continue | 你已反超（含 fork 分支续写） |

---

## 1. 真正的差距（MiniCode 有 / 你曾弱或没有）→ **均已补齐 ✅**

这些曾是 MiniCode 做了、而你没做或做得不完整的点，也是它反过来教你的地方。**截至 2026-07-12 四项全部落地**：

1. **写前 diff 审批（file-review）** —— ✅ 已补（P0-②）。三个文件工具加 `preview()`，权限闸门合并 diff 审批。
2. **会话 fork 分叉** —— ✅ 已补（P1-③）。`fork()` 克隆历史 + `continueSession()` 续写分支 + 面板 `f/Enter/Esc` 交互。
3. **模型主动中途追问（awaitUser）** —— ✅ 已补（P1-⑥）。`awaitUser` 工具 + `askText` 自由文本回调 + TUI 文本确认条。
4. **确定性 snip 降级压缩** —— ✅ 已补（P2-⑦）。`truncateCompact` 两级 snip（head+tail 保留 → 硬丢兜底），无 LLM 时也稳定。

---

## 2. 必须改 / 必须工程化的清单（按优先级）

### P0 — 生产硬伤（不改 = 长任务会出问题）

**① 循环中途自动压缩（真实缺陷，不是优化）**
- 现状：`loop.ts` 里 `compact()` 只在 `if (!gotToolUse)`（模型决定结束）分支调用。
- 后果：连续工具调用轮次（最多 `maxIterations=12`）期间上下文永远不压缩。长任务（大重构、多文件改动）连续跑会一直涨到 400K 预算，下一轮直接喂满甚至超窗，且长上下文衰减让模型变傻。
- 改法：把 `compact()` 调用从「结束分支」移到**每轮迭代末尾**（循环体内、工具执行完之后），带预算检查（history.compact 内部已有阈值判断，每轮调用零成本）。一行位置改动，但价值极高。
- ✅ **状态（2026-07-12）：已修复。** `loop.ts` 在每轮工具执行循环末尾（`for (const tc of pendingToolCalls)` 之后）新增 `if (gotToolUse) await opts.history.compact();`，并写入 trace 事件 `context_compact`（已加入 `TraceEventType`）。长任务连续工具轮次期间上下文按 token 预算自动压缩，不再一路涨满。

**② 写前 diff 审批（file-review）**
- 现状：`edit_file` / `create_file` / `delete_file` 执行即落盘，只有按 risk 的权限闸门（explore/ask/execute + 破坏性强制确认）。用户看不到"你打算怎么改"。
- 后果：生产 coding agent 的核心安全/可用特性缺失；用户无法在落盘前 review 改动。
- 改法：在 edit/create/delete 的 `execute` 真正写盘前，生成 diff 预览（create=整文件、edit=unified diff、delete=确认路径），经权限闸门在 ask 模式展示给用户确认才落盘。可复用一个轻量 `previewAndConfirm()` 包装。
- ✅ **状态（2026-07-12）：已修复。** `tools/index.ts` 的 `ToolDef` 新增可选 `preview()`（不落盘，只算 diff）；为 `create_file`/`edit_file`/`delete_file` 实现 preview（edit 带上下文的 unified-diff 风格、create 显示内容预览、delete 显示不可恢复警告）。`loop.ts` 权限闸门重构：文件写类工具（有 `preview`）在 **ask 与 execute** 模式下合并"写前 diff 审批"为单次询问（explore 模式直接拦截），diff 经 TUI 底部确认条渲染。运行时冒烟测试通过。

### P1 — 强烈建议（决定"能不能用得好"）

> ✅ **状态（2026-07-12 下午）：P1 全部完成并验证。** 改动见 `src/agent/session.ts`（`fork`/`continueSession`）、`src/agent/loop.ts`（early-exit + awaitUser 拦截 + `askText`）、`src/tools/index.ts`（`awaitUser` 工具）、`src/cli/app.tsx`（面板 f 派生 / Esc 取消 / Enter 续写 / awaitUser 文本确认条）、`src/context/trace.ts`（`early_exit` 事件）。`tsc` 通过，3 个运行时冒烟测试通过（early-exit 触发、awaitUser 回传、fork 克隆+续写增长）。

**③ 会话 fork 分叉**：✅ 已加 `SessionManager.fork(id)`（克隆 history+systemPrompt 为新子会话，状态 `completed` 等待续写）+ `continueSession(id, task)`（复用历史与运行参数非阻塞续写）。面板按 `f` 派生、`Enter` 续写、`Esc` 取消。

**④ 会话面板 UI 接入**：✅ 面板交互已完备——← 切换、↑↓ 选择（逆显高亮）、`Enter` 派发/续写、`space` 回复等待项、`ctrl+x` 删除、`f` 派生分支、`Esc` 取消派生；提示文案已同步更新。

**⑤ 无进展 early-exit**：✅ `loop.ts` 增加双检测——连续 3 轮工具全失败/被拒绝（`noProgressStreak`）、或连续 3 轮工具调用完全重复（`repeatCount`）即提前结束并给出清晰提示，写入 `early_exit` trace 事件。避免 Reflection 反复失败空转烧 token。

**⑥ 模型主动 awaitUser（中途追问）**：✅ `tools/index.ts` 新增 `awaitUser` 工具；`loop.ts` 在权限闸门前拦截，走 `askText` 回调获取自由文本回复并作为工具结果回灌；`app.tsx` 接入文本确认条（复用主输入栏，回车回传）。子会话无 `askText` 时降级为布尔确认。

### P2 — 稳健性 / 锦上添花（✅ 全部完成 2026-07-12）

**⑦ 确定性 snip 降级压缩**：✅ `history.ts` 的 `truncateCompact` 由「直接丢最旧整条」升级为两级确定性 snip：① 先对较旧半区逐条 `head(800)+tail(400)` 截断并打标记（`snipText`，阈值 400 token，最近 N 轮完整保留），若回落到预算内则保留全部消息结构；② 仍超预算才硬丢最旧。纯函数、零模型开销，作为无 client 及摘要失败的降级路径。冒烟：8000 字符旧消息被 snip 而非整条丢弃、结构保留、最近消息完整。

**⑧ 统一工具结果预算截断**：✅ `loop.ts` 新增 `clampToolOutput`（`TOOL_RESULT_BUDGET=12K`，超出做 `head(8K)+tail(3K)` 确定性截断 + 标记），在回灌 history 前对**所有**工具结果 output 统一裁剪（成功与失败/Reflection 路径均生效），防止单个超大结果（read 大文件 / grep 海量命中 / 命令刷屏）撑爆窗口。冒烟：50K 结果被截断到 <20K 且保留头尾。

**⑨ 任务级 progress / final 标记**：✅ `loop.ts` 新增 `assistant_phase` 事件，按「该轮是否还调用工具」确定性区分 `progress`（过程叙述）与 `final`（最终答复），无需模型显式输出标记；`app.tsx` 的 `UiMessage` 加 `phase`，progress 消息暗显 + `⋯` 前缀、final 正常渲染。冒烟：过程轮=progress、终答轮=final。

---

## 3. 建议实施顺序

1. **P0-① 循环中途压缩** → ✅ 已完成
2. **P0-② 写前 diff 审批** → ✅ 已完成
3. **P1-③④ 会话 fork + 面板 UI** → ✅ 已完成
4. **P1-⑤⑥ 无进展 early-exit + 主动 awaitUser** → ✅ 已完成
5. **P2 ⑦⑧⑨ 确定性 snip + 工具结果预算 + progress/final 标记** → ✅ 已完成

> 注：MCP、双模型、成本、记忆层、复合工具、Plan Mode、Reflection、权限三模式 —— 这些**不需要改**，已是你的领先项。
