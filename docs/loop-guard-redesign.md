# 循环检测与中断机制重设计 + Harness 能力最大化

## 第一部分：当前循环检测的误判根因

### 1.1 问题复盘

用户反馈：哈希工程项目中，模型合理行为被持续误判为"陷入循环"并中断。

### 1.2 根因定位

当前 4 路守卫的缺陷：

| 守卫 | 判断逻辑 | 误判原因 |
|------|---------|---------|
| `stallStreak` | `roundKey !== lastRoundKey` — 比较从工具调用提取的目标指纹 | 哈希工程中模型反复读同一个工具类文件（每次读不同方法），`roundKey` 不变但工作内容不同 |
| `repeatCount` | `iterSig === lastIterSig` — 比较工具调用的字节签名 | 连续两轮 `read_file(hash.ts), grep('SHA'), edit_file(实现)` 被判定为"字节完全相同"——只要参数有一丁点差异就被放过，但「读同一个参考文件 + 写不同文件」确实可能产生相同模式 |
| `failStreak` | 连续全部失败 | 需要编辑的文件因为竞态被锁定（合理场景），每轮都"失败"但不是模型的问题 |
| `detectCycle` | 连续 N 轮形成周期模式 | 哈希工程中 `读→写→验证→读→写→验证` 是正常节奏，不是死循环 |

**共同缺陷**：所有守卫都是**模式匹配器**，不理解语义。它们比较工具名+参数字符串，但不知道"读 hash.ts 第 3 次是因为需要参考另一个方法的实现"。

### 1.3 模拟哈希工程场景

```
轮 1: read_file(hash.ts:MD5部分) → 理解MD5 → edit_file(md5.ts) → 写MD5实现
轮 2: read_file(hash.ts:SHA1部分) → 理解SHA1 → edit_file(sha1.ts) → 写SHA1实现
轮 3: read_file(hash.ts:MD5部分) → 回头参考MD5的init模式 → edit_file(sha256.ts) → 写SHA256

extractTarget:
  轮1: "read_file:hash.ts|edit_file:md5.ts"
  轮2: "read_file:hash.ts|edit_file:sha1.ts"  ← roundKey ≠ 轮1
  轮3: "read_file:hash.ts|edit_file:sha256.ts" ← roundKey ≠ 轮2
  
→ stallStreak=0 ✅ 没误判

但如果:
轮 4: read_file(hash.ts:SHA256部分) → grep('SHA256_init', src/) → read_file(test.md)
  重复了轮3类似的操作组...

extractTarget:
  轮3: "read_file:hash.ts|edit_file:sha256.ts|grep:SHA256_init:src/"
  轮4: "read_file:hash.ts|grep:SHA256_init:src/|read_file:test.md"
  → roundKey ≠ 但read_file:hash.ts重复出现

→ 如果模型在后续轮次中持续以hash.ts为主要参考文件（这在工程实践中完全正常），
  roundKey虽然每次都略有不同（因为编辑了不同文件），但read_file:hash.ts反复出现。

更致命的是: 当模型想验证时:
轮 N:   read_file(sha256.ts) → grep('hash', test/) → run_command('npx jest sha256.test.ts')
轮 N+1: read_file(sha256.ts) → grep('hash', test/) → run_command('npx jest sha256.test.ts')
  → iterSig 完全相同! repeatCount++! 连续3轮 → 被终止!

但模型的意图是: 修改sha256.ts → 重新跑测试看是否通过。这是正常的TDD循环!
```

---

## 第二部分：新循环检测设计

### 2.1 核心原则

**放弃模式匹配，改为世界状态增量追踪。**

不比较工具调用"是否重复"，而是追踪：
- 文件系统是否在变化（新文件、内容变更）
- 模型的知识边界是否在扩展（读了新文件）
- 操作集是否有多样性（不只是读/写同一组文件）

### 2.2 新守卫体系（3 路 + 1）

#### 守卫 1: WorldDrift — 世界状态漂移检测

替代 `stallStreak` + `repeatCount`。

**追踪 5 轮滑动窗口内的增量**：
```typescript
interface DriftTracker {
  windowSize: 5;
  rounds: Array<{
    filesRead: Set<string>;
    filesWritten: Set<string>;
    commands: string[];
  }>;
  
  // 判断"有新进展"的条件（满足任一即重置）：
  isProgressing(): boolean {
    const recent = this.rounds.slice(-2); // 最近2轮
    // 1. 写了新文件（之前5轮没写过的）
    const priorWritten = new Set(this.rounds.slice(0,-1).flatMap(r => [...r.filesWritten]));
    const newWrites = recent.flatMap(r => [...r.filesWritten]).filter(f => !priorWritten.has(f));
    if (newWrites.length > 0) return true;
    
    // 2. 读了新文件（扩展了知识边界）
    const priorRead = new Set(this.rounds.slice(0,-1).flatMap(r => [...r.filesRead]));
    const newReads = recent.flatMap(r => [...r.filesRead]).filter(f => !priorRead.has(f));
    if (newReads.length > 0) return true;
    
    // 3. 写了已有文件但内容确实变了（文件哈希不同）
    //    由外部在 edit_file 成功后传入 fileHash
    const contentChanged = recent.some(r => 
      r.filesWritten.some(f => this.fileHashes.get(f) !== this.prevHashes.get(f))
    );
    if (contentChanged) return true;
    
    return false;
  }
}
```

**触发阈值**：

| 连续无进展轮数 | 行为 |
|-------------|------|
| 3 轮 | 注入温和提醒："已连续3轮未扩展新的文件或产生新的文件变更，建议确认当前方向。" |
| 5 轮 | 注入强度提示："已5轮无新进展。强烈建议暂停当前路径并重新评估策略。" |
| 8 轮 | 强制终止 |

**为什么这个设计优于现状**：

- 哈希工程中反复读 hash.ts 不是问题——只要模型同时也在读/写其他新文件
- 验证循环 `edit → test → edit → test` 中，edit 产生文件变更 → 每次都是新进展
- 读同一文件作为参考源不被标记，只有"不读新文件 + 不写文件"才触发

#### 守卫 2: ToolFailWall — 工具失败壁垒

替代 `failStreak`。

**区分致命失败和可恢复失败**：

```typescript
enum FailureClass {
  RECOVERABLE,  // 文件不存在、权限不足 → 可能换路径/换策略
  FATAL,        // API 密钥错误、磁盘满 → 不可能通过重试修复
  TOOL_UNAVAIL, // 工具本身不存在 → 这是 bug，应立即报告
}
```

**新逻辑**：
- 可恢复失败：允许 5 次重试（不连续计数），但不强制要求立即成功
- 致命失败：1 次即终止
- 工具不存在：0 次容忍，立即终止

#### 守卫 3: SemanticLoop — 语义循环检测

替代 `detectCycle`。

**不再检测工具调用序列，而是检测"操作场景"的语义重复**：

不看 `A→B→C→A→B→C` 的工具调用周期，而是检测：
- 模型是否在同一个"语义空间"里反复操作（同一组文件、同一类操作）
- 但**不产生新的输出**（没有新的文件被创建或修改）

```typescript
// 窗口内所有操作的文件集合
const fileSet = driftTracker.recentFileSet();
// 窗口内是否产生了新文件
const hasNewOutput = driftTracker.hasNewOutputInWindow();

// 只有当操作集合在缩小且无新产出时才触发
if (fileSet.size <= 3 && !hasNewOutput && driftWindow >= 5) {
  // 语义死循环：一直在3个文件上操作但没有新产出
}
```

#### 守卫 +1: ContextAwareness — 上下文感知降敏

新增**任务类型标记**，不同类型采用不同阈值：

```typescript
// 由 assessComplexity 返回的 effort + 附加的 taskCategory
const TASK_PROFILES = {
  'hash_engineering':   { driftTolerance: 8, failTolerance: 5 },
  'code_refactor':      { driftTolerance: 6, failTolerance: 4 },
  'test_writing':       { driftTolerance: 5, failTolerance: 7 },
  'bug_fix':            { driftTolerance: 4, failTolerance: 5 },
  'simple_query':       { driftTolerance: 2, failTolerance: 1 },
  'default':            { driftTolerance: 5, failTolerance: 3 },
};
```

**自动检测**：`assessComplexity` 扩展返回 `taskCategory`，模型从用户请求中推断任务类型。哈希工程、重构、写测试等场景自动提高容忍度。

### 2.3 实现策略：替换而非修补

**一次替换所有 4 个旧守卫**，避免新旧混合的边界 bug。

```typescript
// 删除:
// failStreak, stallStreak, repeatCount, lastIterSig, lastRoundKey
// detectCycle, cycleRescueKey, cycleRescueCount, roundKeyHistory
// STALL_LIMIT, REPEAT_LIMIT

// 替换为:
const drift = createDriftTracker(5); // 5轮窗口
const failureClass = createFailureClassifier();

// 每轮结束时:
drift.recordRound({ filesRead, filesWritten, fileHashes });
if (!drift.isProgressing()) {
  drift.emitWarning(); // 内部处理3/5/8轮阈值
}
```

**预期效果**：
- 哈希工程误判率：从 ~60%（推测）降到 ~5%
- 真循环检测延迟：从 3 轮增加到 5 轮（稍微推迟但准确率大幅提升）
- 代码量：从 ~120 行守卫代码精简到 ~60 行 drift tracker

---

## 第三部分：Harness 最大化 DeepSeek 能力

### 3.1 当前浪费的能力清单

| DeepSeek V4 能力 | 当前使用 | 浪费程度 |
|-----------------|---------|---------|
| 1M 上下文窗口 | aggressive compact（~80% 阈值就压） | 🔴 严重 |
| 思考模式（thinking） | Flash 完全关闭，Pro 修复后才恢复 | 🟡 部分 |
| 并行工具调用 | 所有工具串行执行 | 🔴 严重 |
| 结构化输出 | 仅 Pro 用 json_schema | 🟡 部分 |
| 动态 temperature | Flash 固定 0.1 | 🟡 部分 |
| System prompt 注意力 | 3000 token 单一 prompt | 🟡 部分 |

### 3.2 改进方案

#### 改进 1: 上下文窗口充分利��

**问题**：当前 compact() 在 ~80% token 预算时就压缩，1M 窗口实际只用到了 ~10 万 token。

**改进**：
```typescript
// 从保守策略改为"宽松续命"策略
const COMPACT_THRESHOLD = 0.7;     // 改为 70% 才开始检查
const COMPACT_TARGET = 0.5;        // 压缩到 50% 而非激进的 30%
const MAX_UNCOMPACTED = 100_000;   // 10 万 token 内完全不压缩
```

**效果**：模型能看到更多上下文，对大规模项目的理解更连贯。1M 窗口是 DeepSeek V4 的核心卖点，不用等于白付了窗口费。

#### 改进 2: 选择性思考恢复

**问题**：Flash 完全关闭思考，丢弃了推理质量。

**改进**：区分场景——不是所有轮次都需要工具调用。
```typescript
// 第1轮（理解用户意图）: thinking = enabled, tools = []
// 后续轮（执行工具）: thinking = disabled, tools = TOOLS  ← 当前行为
// 反思轮（质量检验）: thinking = enabled, tools = []
```

第一轮用 Flash + 思考模式快速理解用户需求（不需要工具），理解了再切回工具模式执行。每轮工具执行后可以有一轮轻量反思。

**风险控制**：思考轮不计入 maxIterations，限时 30s。

#### 改进 3: 并行工具执行

**问题**：模型一次返回 3 个 tool_calls（如读 3 个不同文件），当前串行执行。

**改进**：
```typescript
// 检测工具调用的独立性
function canParallelize(calls: ToolCall[]): boolean {
  return calls.every(c => !MUTATING_TOOLS.has(c.name));
}
// 纯读操作（read_file, grep, list_dir）全部并行执行
// 写操作保持串行（文件操作有依赖关系）
```

**效果**：3 个 `read_file` 同时执行 vs 串行 3 次 API+磁盘 I/O，延迟从 9s 降到 3s。

#### 改进 4: 系统指令分层

**问题**：3000 token 的 system prompt，模型对末尾指令的注意力衰减。

**改进**：分三段注入，关键指令放在开头和结尾：
```
[SYSTEM - 高优先级，前 200 token]
  核心角色 + 安全边界 + 语言要求

[history messages...]

[SYSTEM - 中优先级，最后一条 user message 追加，后 500 token]
  当前轮次的任务上下文 + 计划步骤提醒 + 风格要求
```

利用 Transformer 的 **首尾注意力集中效应**，确保最重要的指令不丢失。

#### 改进 5: 推理链可见化

**问题**：Flash 思考关闭后，没有了内部的推理链（CoT），模型决策过程不透明。

**改进**：在 system prompt 的第一优先级位置要求：
```
【输出规范】每次调用工具前，用 [REASON] ... [/REASON] 包裹一句推理依据。
例如：[REASON] 需要读取 hash.ts 确认 SHA1 的初始化模式，以便在 sha1.ts 中复现 [/REASON]
随后调用 read_file(hash.ts, SHA1部分)
```

这不是真正的 CoT（仍是补全文本），但把它结构化后：
- Harness 可以解析 `[REASON]` 内容做循环检测
- 用户可以看到模型每次为什么选择这个工具
- 循环检测可以基于 reason 的语义变化而非工具调用模式

---

## 第四部分：实施路线

### Wave 1: 循环检测重写（P0，本周）

| 项 | 内容 | 工作量 |
|----|------|--------|
| 1.1 | 实现 `DriftTracker`（5 轮窗口 + 文件集 + 新文件检测） | 2h |
| 1.2 | 实现 `FailureClassifier`（可恢复/致命/不存在三级） | 1h |
| 1.3 | 删除旧 4 守卫 + 替换为 DriftTracker | 1h |
| 1.4 | `assessComplexity` 扩展 `taskCategory` + 阈值分档 | 1h |

### Wave 2: Harness 能力激活（P1，下周）

| 项 | 内容 | 工作量 |
|----|------|--------|
| 2.1 | compact 阈值从 80%→70%，不压缩区间从 0→100K token | 0.5h |
| 2.2 | 纯读工具并行化（Promise.all） | 1h |
| 2.3 | 首轮开启 Flash 思考（理解需求用，30s 限时） | 1h |
| 2.4 | `[REASON]` 结构化推理提示 | 0.5h |

### Wave 3: 系统指令优化（P2，两周内）

| 项 | 内容 | 工作量 |
|----|------|--------|
| 3.1 | System prompt 分层注入（首尾注意力） | 2h |
| 3.2 | 基于 `[REASON]` 的语义循环检测增强 | 2h |

---

## 第五部分：Harness 能力最大化后的预期提升

| 维度 | 当前 | 优化后 | 提升 |
|------|------|--------|------|
| 循环误判率 | ~60%（哈希工程） | ~5% | **-92%** |
| 并行读操作延迟 | 3×(1s+网络) = 5-7s | 1×(1s+网络) = 1-2s | **-65%** |
| 有效上下文窗口 | ~10 万 token | ~50 万 token | **5x** |
| 首轮理解质量 | 工具调用依赖型（1-2 轮） | 思考驱动型（0 轮工具） | **更快定位** |
| Flash 推理质量 | 纯补全（0.1 temp） | 首轮思考 + [REASON] 结构 | **决策更透明** |
| 代码改动检测精度 | 字符串比较 | 文件哈希对比 | **内容变更不遗漏** |
