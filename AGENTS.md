# AGENTS.md — DeepSeek CLI 编程 Agent 操作手册 & 项目 Spec

> 本文件既是给 Agent 自身的"操作手册"，也是本项目的 **Spec（阶段04 要求：先写 Spec 再 vibe coding）**。
> 路线引用：05-最后别做万能助手，用一个垂直项目验证能力。本项目就是这个垂直项目。

## 1. 项目定位（垂直，不做万能助手）
直接接入 **DeepSeek 原生 API** 的命令行编程 Agent。面向中文开发者，在终端完成
「读代码 → 理解结构 → 改/建代码 → 跑命令验证」的闭环。不追求聊天百科，只做编程垂直场景。

## 2. 目标用户 & 高频任务
- **目标用户**：无法/不愿使用 Claude 海外账户的开发者；中文母语；习惯终端工作流。
- **高频任务**：
  1. 理解陌生代码库（读文件、搜索符号、看目录结构）
  2. 实现新功能 / 修复 bug（编辑、新建文件）
  3. 重构（多文件协同修改）
  4. 跑命令验证（构建、测试、lint、git 状态）
  5. 多轮对话保持上下文记忆

## 3. Agent 工具列表（基础 6 个编程动作 + 2 个差异化复合工具）
> 路线精神：工具越多越容易把问题分散到数据源和 UI，而不是 Agent 设计本身。基础动作保持最小集，差异化能力以"复合工具（依赖模型二次推理）"形式叠加，不污染主循环。

| 工具 | 参数 | 返回值 | 风险级 |
|------|------|--------|--------|
| `read_file` | `path`, `offset?`, `limit?` | 文件文本内容 | 低 |
| `create_file` | `path`, `content` | 成功 / 失败原因 | 中（新建） |
| `edit_file` | `path`, `old_string`, `new_string` | 成功 / 失败原因 | 中（覆写） |
| `delete_file` | `path` | 成功 / 失败原因 | 高（需确认） |
| `run_command` | `command`, `cwd?` | `stdout`/`stderr`/`exit_code` | 高（危险命令需确认） |
| `search_code` | `pattern`, `path?`, `glob?` | 匹配行与位置 | 低 |
| `review_code` | `path`, `focus?` | 中文代码审查报告（逻辑/边界/安全/命名） | 低（差异化·复合工具） |
| `audit_dependencies` | `path?` | 中文依赖安全审计（漏洞/恶意包/升级建议） | 低（差异化·复合工具） |

## 4. 拒答边界
- **绝不执行**：`rm -rf /`、格式化磁盘、修改系统关键文件、读取并回显 `.env` 等密钥文件内容。
- **绝不替代人类做不可逆决策**：`git push --force`、`DROP DATABASE`、批量删除需用户显式确认。

## 5. 确认点（权限层，对应 Harness 五子系统之 Permission）
- 删除文件 / 覆写重要文件 / 危险命令 → 默认 **Ask** 模式，需用户输入 `yes`。
- 读 / 搜索 / 普通构建命令 → 默认 **Execute** 模式，自动放行。
- 支持三档切换：Explore（只读安全）/ Ask（需确认）/ Execute（自动放行）。

## 6. 失败回复 & 质量判断（对应 Verification）
- 工具失败：返回结构化错误，Agent 进入 **Reflection**（自我纠正），不静默跳过。
- 质量判断：用 `eval/golden-cases.md` 的 20 个黄金 case 评测，三档验证
  （代码可测 / LLM 裁判 / 人工复核）。完整 trace 记录模型、工具、参数、耗时、token、失败原因。

## 7. 差异化特性（vs Claude Code，路线要求：探索独特能力形成竞争优势）
- **中文工程语境**：system prompt 全程中文，生成的代码注释、Git 提交信息符合中文工程规范。
- **DeepSeek 原生 tool use**：利用 `deepseek-v4-flash`（非思考模式）的 function calling，让模型精准自主选型
  （读 vs 搜 vs 改 vs 跑），而非正则解析文本。
- **Claude Code 不具备的独特能力（已落地 → 工具）**：
  1. ✅ `review_code`：中文代码审查报告（逻辑/边界/安全/命名/可读性 + 风险等级）
  2. ✅ `audit_dependencies`：依赖安全中文审计（已知漏洞/恶意包/升级建议）
  3. 🔜 Git 提交信息中文生成（符合 Conventional Commits 中文变体）
  4. 🔜 中英术语对照（读英文文档时给出中文术语映射）

## 8. 架构边界（对应阶段02 五层 / 阶段03 三层）
- **应用交互层**（`src/cli`）：REPL、流式输出渲染、配置读取。
- **Agent 运行时层**（`src/agent`）：agent loop、事件流、工具调度、权限决策、上下文压缩。
- **模型 API 层**（`src/llm`）：DeepSeek 原生调用、流式解析、tool_calls 规范化。
- **工具层**（`src/tools`）：基础 6 个编程动作的纯函数 + 2 个差异化复合工具（review_code / audit_dependencies，依赖 llm 层做中文审查与审计）。
- **上下文层**（`src/context`）：多轮历史管理、压缩策略、工作目录状态。
