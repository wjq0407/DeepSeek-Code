# 市面 AI 产品「长期记忆」设计调研

> 调研目的：为 deepseek-code-agent 的 GUI 化产品（对标 Craft Agents 的通用 Agent）设计长期记忆层提供参考。
> 调研时间：2026-07-16
> 调研对象：消费级通用助手、编程 Agent、专用记忆层基础设施、国内编程助手。

---

## 一、速览对比表

| 产品 / 流派 | 记忆形态 | 写入方式 | 隔离维度（scope） | 检索方式 | 最大特色 |
|---|---|---|---|---|---|
| **ChatGPT Memory** | Saved Memories + Chat History 后台综合 | 显式 + 自动 | 用户级（单用户） | 模型综合（summary） | **Dreaming** 后台自动修订陈旧记忆 |
| **Claude Code** | 六层 CLAUDE.md + Auto Memory | 显式规则 + 自动萃取 | 系统 / 项目 / 团队 / 用户 / 本地 / 自动 | 每会话加载 MEMORY.md 前 N 行 | Auto Memory 自动沉淀项目洞察 |
| **Cursor** | 四层 Rules + 社区 Memory Bank | 显式（.md 文件） | Team / Project / User / AGENTS.md | glob 过滤 + 按需读 | 版本可控、随代码库走 |
| **Mem0** | conversation/session/user/org 分层 | 自动提取 + 显式 | user_id / agent_id / run_id / org_id | 语义+BM25+实体+时间 多信号融合 | ADD-only 保留时间线、多信号检索 |
| **Letta / MemGPT** | 核心记忆 + 归档记忆 + 回忆 | 自我编辑 | 用户 / 会话 | 检索召回（recall） | 记忆块自我编辑的学术起源 |
| **国内编程助手**（灵码/CodeGeeX/Comate/Trae） | 项目规则 .md + 全局规则 | 显式 | 项目 / 全局 | 每会话自动读 | 文件系统 Markdown，零依赖 |

---

## 二、主流产品拆解

### 1. ChatGPT Memory（消费级通用助手，2024.4 首发）
- **两层机制**
  - *Saved Memories*：用户显式要求记住（"记住我是素食者"），或模型在开启时自动把有用细节存为记忆。类似 Custom Instructions，但由模型自动更新。删除聊天不会删除已存记忆。
  - *Chat History Reference*：模型后台从过去聊天中汲取相关信息（不强依赖显式要求），让未来对话更个性化。注意：不保存每一个细节。
- **Dreaming（2025.4 引入，2026 V3 大幅增效）**
  - 后台进程，跨多次对话自动综合记忆，解决**陈旧性（staleness）**问题。
  - 例：用户说"我 7 月要去新加坡" → 旅程结束后自动修订为"你 2026 年 7 月去过新加坡"，回家后按居住地/时区推荐。
  - V3 将免费版所需算力降低约 5 倍，记忆容量提升。
- **评估三目标**（OpenAI 公开标准）
  1. Carry forward context（一次告知，后续复用）
  2. Follow preferences & constraints（偏好/约束一致生效）
  3. Stay current over time（随时间保持最新，不出现过期事实）
- **用户可控**：可查看"你记得我什么"、删单条、清空、关闭；临时聊天不引用记忆；记忆与聊天历史**分离存储**。
- **设计取向**：记忆保存**高层级偏好与细节**，不依赖它存精确模板或长段逐字文本。
- 来源：openai.com/index/chatgpt-memory-dreaming、help.openai.com/zh-cn/articles/8590148

### 2. Claude Code（编程 Agent，最贴近本项目）
- **六层记忆体系**（scope 从粗到细）
  1. Managed policy — 系统级 `CLAUDE.md`（组织全员，IT/DevOps 管）
  2. Project memory — `./CLAUDE.md` 或 `./.claude/CLAUDE.md`（团队，git 管）
  3. Team — `.claude/rules/*.md`（团队，git 管）
  4. User — `~/.claude/CLAUDE.md`（个人，跨项目）
  5. Local — `./CLAUDE.local.md`（个人，本项目，不入库）
  6. **Auto memory** — `~/.claude/projects/<project>/memory/`（个人，本项目）
- **Auto Memory 是亮点**：Claude 在**无需用户要求**的情况下，自动保存项目模式、调试洞察、架构笔记、用户偏好。
  - `MEMORY.md` 前 200 行**每会话自动加载**；详细笔记按主题分文件，按需读取。
  - 用户可用 `/memory` 命令查看/管理已存内容。
- **设计取向**：规则文件（显式、版本可控）+ Auto Memory（自动、低摩擦）双轨；记忆过大反而被忽略（500 行 CLAUDE.md 会漏关键规则），强调"该记的记、该忘的忘"。
- 来源：developertoolkit.ai（Context Management / Memory Patterns 对比表）

### 3. Cursor（编程编辑器）
- **四层 Rules**
  - Team Rules（Dashboard，团队管理员管）
  - Project Rules `.cursor/rules/*.md`（团队，git，可 glob 过滤只作用于相关文件）
  - User Rules（设置里，个人跨项目）
  - `AGENTS.md`（项目根，团队 git）
- **社区 Memory Bank**（增强方案）：在 `.cursor/memory/` 放结构化 Markdown——`projectbrief / techContext / systemPatterns / productContext / activeContext / progress`，配合 plan/act 双模式，完成后手动"update memory bank"。
- **设计取向**：**纯文件系统、零依赖、可移植**；文件随仓库克隆即来；记忆分"稳定型"（技术栈）与"高频更新型"（当前任务/进度）。
- 来源：lullabot.com、developertoolkit.ai、blog.csdn.net（增强型记忆库）

### 4. Mem0（专用记忆层基础设施，可作参照架构）
- **分层存储（lifetime）**
  - Conversation memory：单轮内（工具调用/思维链），轮结束即丢
  - Session memory：分钟~小时，多步任务，完成即清
  - User memory：周~永久，个人偏好/账户/合规
  - Organizational memory：全局共享知识（FAQ/目录/政策）
- **两阶段流水线**
  - *Extraction（写）*：新消息 → 上下文查重 → LLM 提取事实 → 去重+嵌入 → 实体链接。默认存"萃取后的事实"而非逐字 transcript（`infer=False` 可存原文）。
  - *Retrieval（读）*：search 前多信号融合——语义相似度 + BM25 关键词 + 实体匹配 + 时间信号，按 scope 过滤。
- **五种 scope 维度**：`user_id` / `agent_id` / `run_id` / `org_id` + 可组合（如 user+org 混合个人与团队上下文）。scope 配错两类失败：过宽串味、过窄像"记不住"。
- **ADD-only 提取**：不覆盖/删除旧事实，保留时间线（"从 Austin 搬到 Seattle" 新增而不改写旧记录）；需要修正时用显式 update/delete。
- **记忆类型**：semantic（事实）/ episodic（事件，衰减快）/ procedural（流程习惯，最被低估但最值钱）/ working（工作记忆）。
- 来源：docs.mem0.ai/core-concepts、mem0.ai/blog/ai-memory-management-for-llms-and-agents

### 5. Letta / MemGPT（学术起源，"自我编辑记忆"）
- 将记忆分为**核心记忆（core）+ 归档记忆（archival）+ 回忆（recall）**；记忆块可被智能体**自我编辑**。
- 是"长期记忆作为可写存储"这一范式的理论源头，Mem0/ChatGPT Auto 等实践都受其启发。

### 6. 国内编程助手（通义灵码 / CodeGeeX / 百度 Comate / Trae）
- 普遍采用 **Level 1 项目规则文件 + Level 2 全局规则** 的显式记忆：
  - 通义灵码 `LINGMA.md`、CodeGeeX `.codegeex/rules/`、Comate `COMATE.md`、Trae `.trae/rules/project_rules.md`、以及跨工具通用的 `AGENTS.md`。
- 文件系统 Markdown，每会话自动读取；项目规则随代码库版本可控，全局规则编码"沟通风格/编码哲学"（不写具体技术栈）。
- 来源：cnblogs.com/wang_yb、towardsdatascience.com

---

## 三、共性设计模式提炼

把以上产品抽象，长期记忆设计有 7 个反复出现的决策点：

1. **分层（Layered）**：短期（会话上下文/工作记忆）与长期（用户/项目/组织）分离，决定"什么该快速遗忘、什么该留数月"。
2. **作用域隔离（Scoping）**：user / project / agent / session / org 多维度，核心目标是**防止不同用户/会话/智能体之间串味**。
3. **提取-检索两阶段（Extraction-Retrieval）**：写时萃取去重+嵌入，读时按需检索再注入 prompt——而不是每次回放完整 transcript。
4. **显式 vs 自动**：规则文件（显式、可控、版本化）与 Auto Memory（自动、低摩擦、易陈旧）双轨并存。
5. **陈旧性治理（Staleness）**：ChatGPT 用 Dreaming 后台修订；Mem0 用时间元数据+ADD-only 保留时间线；都承认"记忆会过期"是头号问题。
6. **存储形态**：文件系统 Markdown（可审阅、可移植、零依赖）vs 向量库（语义检索强）——多数产品**混合**：事实存文件/向量，原文不囤。
7. **用户可控**：可查看、删单条、清空、关闭——信任来自透明。

---

## 四、对 deepseek-code-agent 的对标建议

### 现状（来自项目记忆）
- 已实现 `MemoryManager` **双层聚合**：用户级 `~/.dsa/memory` + 项目级 `<cwd>/.dsa/memory`。
- Web 版每会话独立 `dataDir`（`~/.dsa/users/<账号>/threads/<id>/`），短期记忆（上下文/对话历史/项目级记忆）已按会话隔离；用户级记忆跨会话共享（长期偏好，设计意图）。
- Phase 3 会话结束自动萃取用户偏好；Phase 4 双层聚合已落地。
- 检索：cosine top-K + 关键词降级（CJK 单字切 + Dice）。

### 建议（按优先级）
1. **巩固"三层"对齐行业共识**
   - 会话工作记忆（已有，dataDir 隔离） / 项目级记忆（`<cwd>/.dsa/memory`） / 用户级记忆（`~/.dsa/memory`）——与 Claude Code 的 local/project/auto 三层 + 用户级高度同构，无需大改。
2. **补"陈旧性治理"（当前最薄弱的一环）**
   - 现状是"只增不修、累积事实"，时间长了会出现互斥/过期记忆（如换了技术栈旧的还留着）。
   - 借鉴 ChatGPT Dreaming：加一个后台/会话结束的"综合修订"步骤，对同实体记忆做合并/时间修订；或给每条记忆打时间元数据，检索时加时间信号。
3. **检索多信号增强**
   - 当前 cosine+关键词已够用；若记忆量增长，可加**实体链接**（项目/工具/人）+ 时间信号，对齐 Mem0 的融合排序。
4. **双通道写入**
   - 已有 Phase 3 自动萃取；建议加**显式通道**：用户说"记住 X"时直接写用户级记忆（对齐 ChatGPT Saved Memories + Claude "Remember: ..."）。
5. **用户可控 UI（产品化必做）**
   - 参考 ChatGPT "你记得我什么 / Manage memories"：在 Web 设置里加「记忆管理」页，列出已存记忆、支持查看/删除单条/清空，提升信任。当前 `/memory` 命令仅 CLI。
6. **scope 粒度预留**
   - 当前 user/project 两级；若未来 delegate 子 Agent 需要独立记忆，提前预留 `agent_id` scope（对齐 Mem0），避免后期重构。

### 一句话结论
行业共识已经收敛：**分层 + 多 scope 隔离 + 提取/检索两阶段 + 自动与显式双轨 + 陈旧性治理 + 用户可控**。deepseek-code-agent 的分层与隔离基础已具备，下一步重点应放在**陈旧性治理**和**记忆管理 UI** 上，这是从"能用"到"可信"的关键差距。
