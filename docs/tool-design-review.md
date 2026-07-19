# 工具设计审查：deepseek-code-agent vs Claude Code

## 一、核心发现：edit_file 机制 — 我们更好

| 维度 | Claude Code | deepseek-code-agent | 谁优 |
|------|------------|-------------------|------|
| 修改范式 | `old_text/new_text` 精确替换 | `old_string/new_string` 精确替换 | ⬜ 相同 |
| 匹配算法 | `str.replace(old, new, 1)` 精确匹配 | `fuzzyMatchBlock` 三级匹配（精确→归一换行→逐行忽略空白） | 🟢 **我们更鲁棒** |
| 写前预览 | ❌ 无 | ✅ `preview()` 显示 before/after diff | 🟢 **我们有，CC 没有** |
| 写后验证 | ❌ 无（只检查文件是否存在） | ✅ `verifyWrittenFile` + `autoVerifyCode`(Pro 模型) | 🟢 **我们多一层质量闸** |
| 回滚支持 | ❌ 无 | ✅ `rollbackManager.snapshot()` | 🟢 **我们有** |
| 目录创建 | ✅ `mkdir(parents=True)` | ✅ `mkdir(dirname, {recursive:true})` | ⬜ 相同 |
| 唯一性约束 | ❌ 仅替换第一次出现 | ✅ 检测重复并报错 | 🟢 **我们更严格** |

**结论**：`edit_file` 不需要改。旧文案精度 + 容错匹配 + 预览 + 验证 + 回滚，五层保护已经超过 CC。

---

## 二、差异对比：完整工具矩阵

### 2.1 文件操作工具

| 工具 | CC 做法 | 我们的做法 | 差距 |
|------|---------|-----------|------|
| read_file | 全量读取，支持 offset/limit | ✅ 全量 + offset/limit | ⬜ 相同 |
| write_file/create_file | `write_file` 全量覆盖（可创建新文件也可覆写） | `create_file` 仅创建新文件（已有则报错） | 🔴 **语义分裂** |
| edit_file | old_string/new_string | ✅ 同上 + 五层增强 | 🟢 更好 |
| delete_file | ✅ bash rm | ✅ | ⬜ 相同 |
| glob | ✅ glob(pattern) 文件名匹配 | ❌ 无（依赖 search_code） | 🔴 缺失 |
| grep | ✅ grep(regex) 内容搜索 | ✅ search_code(regex, glob) 整合版 | 🟡 可拆分 |
| list_dir | ✅ 内置 | ❌ 未独立暴露为工具 | 🟡 CC 有更清晰的语义 |
| ensure_dir | ❌ 无（write_file 自动创建目录） | ❌ 无（create_file 兜底 mkdir） | ⬜ 双方都是隐式 |

### 2.2 智能体专用工具

| 工具 | CC 做法 | 我们的做法 | 差距 |
|------|---------|-----------|------|
| 代码审查 | ❌ 无专用工具（模型自己读+判断） | ✅ review_code(Pro 深度审查) | 🟢 差异化优势 |
| 安全审计 | ❌ 无 | ✅ audit_dependencies(Pro) | 🟢 差异化优势 |
| 术语对照 | ❌ 无 | ✅ terminology(Pro) | 🟢 差异化优势 |
| 项目发现 | ❌ 无（手动 glob+read） | ✅ project_discover | 🟢 差异化优势 |
| 提交信息 | ❌ 无（模型自己写） | ✅ git_commit_msg(Pro) | 🟢 差异化优势 |
| 代码验证 | ❌ 无 | ✅ verify_code(Pro 轻量检查) | 🟢 差异化优势 |
| 答案审核 | ❌ 无 | ✅ verify_answer(Pro 输出门) | 🟢 差异化优势 |
| 深度生成 | ❌ 无 | ✅ deep_gen(Pro 深度代码生成) | 🟢 差异化优势 |
| 子代理分派 | ✅ delegate/spawn_teammate | ✅ delegate | ⬜ 相同 |

### 2.3 辅助工具

| 工具 | CC 做法 | 我们的做法 | 差距 |
|------|---------|-----------|------|
| 任务管理 | ✅ todo_write + TaskCreate/Get/Update/List | ❌ 无（模型自由发挥） | 🔴 缺失 |
| 技能加载 | ✅ load_skill | ✅ use_skill | ⬜ 相同 |
| 上下文压缩 | ✅ compact | ✅ 自动 compact（loop 内部） | 🟡 CC 设为显式工具 |
| Cron 调度 | ✅ schedule_cron | ❌ 无 | ⬜ 非编码场景不适用 |
| 浏览器 | ✅ browser | ❌ 无（run_command 可替代） | ⬜ 非核心 |

### 2.4 执行工具

| 工具 | CC 做法 | 我们的做法 | 差距 |
|------|---------|-----------|------|
| bash/run_command | ✅ bash(cmd) | ✅ run_command(cmd, cwd, timeout) | 🟢 我们更精细（超时+目录） |
| Git 状态/差异 | ❌ 用 bash `git status/diff` | ✅ git_status, git_diff | 🟢 专用工具更鲁棒 |
| 工作树隔离 | ✅ create_worktree | ❌ 无 | ⬜ 本机单用户场景不适用 |

---

## 三、关键问题分析

### 问题 1：create_file 语义有缺陷

**当前行为**：
```typescript
// 文件已存在 → 报错
if (exists) return { ok: false, output: '文件已存在，请用 edit_file 修改' };
```

**问题**：模型创建文件后想重写（如代码生成后不满意、要全部替换），必须先 delete 再 create。这不必要地增加了操作步数。

**CC 的做法**：`write_file` 创建 OR 覆盖，不区分。

**建议**：改名为 `write_file`，行为改为"存在则覆盖，不存在则创建"。保留 `create_file` 作为别名向后兼容。

### 问题 2：search_code 职责过载

**当前行为**：`search_code` 同时做文件名 glob + 内容 grep，合二为一。

```typescript
parameters: {
  pattern: '正则表达式搜索模式',    // ← grep 功能
  path: '搜索目录',
  glob: '文件名 glob 过滤（如 *.ts）', // ← glob 功能
}
```

**问题**：两个不同语义的操作混在一个工具里，参数互相影响，模型容易用错。

**CC 的做法**：`glob(pattern)` 和 `grep(regex)` 是两个独立工具。

**建议**：拆分为 `search_files(glob)` 和 `search_code(pattern, glob?)` 两个工具，语义清晰。

### 问题 3：缺少 Todo 工具

**CC 的做法**：`todo_write` 让模型自己维护任务清单，系统检测 3 轮不更新就提醒。

**我们的问题**：模型在多步任务中容易丢失进度意识——没有工具让它结构化地追踪"我做了哪些、还剩哪些"。

**建议**：新增 `todo_write` 工具（复用 CC 的 schema），配合之前的计划合规检验形成主动进度管理。

### 问题 4：基础工具和复合工具混在同一池

**当前架构**：
```
createTools(client) → [
  read_file, create_file, edit_file, delete_file,  ← 基础文件操作
  run_command, search_code,                         ← 基础执行/搜索
  review_code, audit_dependencies,                  ← Pro 复合工具
  verify_code, verify_answer,                       ← Pro 质量门
  git_status, git_diff, git_commit_msg,             ← Git 工具
  terminology, project_discover,                    ← 发现类
  deep_gen, delegate,                               ← 高级
  use_skill,                                        ← 技能
]
```

所有 18 个工具平铺在一个数组里，模型需要从中选择。

**CC 的做法**：工具按功能域分类——文件操作 / 任务管理 / 团队协作 / 外部扩展，但也在同一个池子里。

**这不是问题**——DeepSeek V4 的 1M 上下文足够承载 18 个工具的定义。关键是每个工具的 `description` 要足够清晰到模型能正确选择。

### 问题 5：工具参数描述质量参差

**好的描述**（review_code）：
```
用中文对文件或目录做深度代码审查（逻辑/边界/安全/命名/可读性），由推理模型（Pro）执行。
```

**差的描述**（audit_dependencies）：
```
解析 package.json 与锁文件，用中文做软件供应链安全审计。
```

差在：没有说明"何时该用这个工具"。CC 的做法是每个 description 都很短但精炼，模型靠 system prompt 里的整体指导来判断何时用什么。

**建议**：确保每个复合工具的 description 包含"何时触发"的明确条件（CC 的 system prompt 里写、我们是描述里写，效果等同）。

---

## 四、改进行动方案

### P0（本周，1h）：文件工具语义修正

| # | 项 | 改动 |
|---|-----|------|
| 1 | `create_file` → `write_file` | 允许覆盖，存在则覆写而非报错 |
| 2 | 拆 `search_code` 为 `search_files`(glob) + `search_code`(grep) | 各 15 行 |

### P1（下周，2h）：结构性增强

| # | 项 | 改动 |
|---|-----|------|
| 3 | 新增 `todo_write` 工具 | 复用 CC schema，index.ts +25 行 |
| 4 | 新增 `list_dir` 为独立工具 | 从内部函数提升，+15 行 |
| 5 | 复合工具 description 加触发条件 | review/audit/verify/terminology 各 +1 行 |

### 不改的（已经比 CC 好）

- `edit_file` — 已有五层保护（fuzzyMatch + preview + verify + rollback + uniqueness）
- `verify_code / verify_answer / deep_gen` — CC 没有等效工具，是我们的差异化壁垒
- `run_command` — 比 CC 的 bash 多了 cwd + timeout + 安全过滤
- Git 专用工具 — CC 靠 bash git 命令，我们封装了类型安全的 git_status/git_diff

---

## 五、完整改后工具矩阵

```
基础文件:
  read_file, write_file(原create_file), edit_file, delete_file
  search_files(glob), search_code(grep)

基础执行:
  run_command, list_dir

Git:
  git_status, git_diff, git_commit_msg

Pro 复合工具（差异化壁垒）:
  review_code, audit_dependencies, verify_code, verify_answer
  terminology, project_discover, deep_gen

高级:
  delegate, use_skill

进度管理:
  todo_write
```
