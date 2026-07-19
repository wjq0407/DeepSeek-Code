# 防智能体循环机制：当前实现 vs Claude Code — 对比分析与改进方案

## 一、Claude Code 的防循环哲学

Claude Code 的核心原则（来自 `learn-claude-code` 项目）：
> **Agent 负责决策，Harness 负责任务边界。** 所有防循环机制都是 Harness 层保护，而非模型自身逻辑。

CC 实际有 **16+ 种 reason/transition 类型**（远超教学版的 5 种），每一条都是 Harness 在「该停的时候停、该救的时候救」。

---

## 二、机制对表：当前项目 vs Claude Code

| # | 机制 | 当前项目 | Claude Code | 差距 |
|---|------|---------|-------------|------|
| 1 | 硬轮次上限 | `maxIter` (默认 ∞，可自定义) | `maxTurns` | ⬜ 等价 |
| 2 | 工具连续失败守卫 | `failStreak` ≥3 + 3 级渐进诊断 | error recovery 重试上限 | ⬜ 我们更精细（渐进诊断 + perTool） |
| 3 | 空转守卫 | `stallStreak` (roundKey 指纹) | ❌ 无 | 🟢 **我们领先** |
| 4 | 字节重复守卫 | `repeatCount` (工具调用完全相同) | ❌ 无 | 🟢 **我们领先** |
| 5 | 周期循环检测 | `detectCycle` (period ≥3) | ❌ 无 | 🟢 **我们领先** |
| 6 | 中继重新规划 | `replanAttempted` | ❌ 无 | 🟢 **我们领先** |
| 7 | 输出截断防御 | ❌ 无 | `max_tokens` escalation + continuation + **diminishing returns** 检测 | 🔴 **缺失** |
| 8 | Todo 进度追踪 | ❌ 无 | `rounds_since_todo` nag（连续 3 轮不更新 todo → 提醒） | 🔴 **缺失** |
| 9 | 上下文压缩后身份恢复 | ❌ 无 | `identity re-injection`（compact 后重注身份） | 🔴 **缺失** |
| 10 | 输出递减检测 | ❌ 无 | 连续 3 次 continuation <500 token → 停止 | 🔴 **缺失** |
| 11 | 显式终止标记 | ⬜ `reactPhase='final'`（推断式） | MiniCode: `<final>` 标记（声明式） | 🟡 **可增强** |
| 12 | 空闲超时 | ❌ 无（单 Agent 无需） | 60s idle → shutdown | ⬜ 单 Agent 场景不适用 |

---

## 三、关键差距深度分析

### 差距 1：输出截断防御 + 递减检测（Claude Code 的 `diminishing returns`）

**CC 怎么做**：
```
第 1 次截断 → max_tokens 从 8K 升级到 64K + "continue" 提示
第 2 次截断 → 再次 continue
第 3 次截断 → 检测：3 次增量均 < 500 token → 判定 diminishing returns → 停止
```

**我们的问题**：
- 当前 `streamChat` 没有 `max_tokens` 限制（流式一次跑到底）
- 模型理论上可以无限生成文本，但没有检测"是否在产出有用内容"
- 一个典型的陷阱：模型反复输出越来越长的解释性文字，但实际进度为零

**为什么重要**：
不是所有循环都以工具调用的形式出现。模型可能在不调用工具的情况下反复输出相似的文本——我们的 `repeatCount`、`stallStreak`、`detectCycle` 全部分析的是**工具调用模式**，对纯文本输出循环完全盲视。

### 差距 2：Todo 进度追踪（Claude Code 的 todo nag）

**CC 怎么做**：
- 模型在前几轮会自己维护一个 Todo 列表
- 系统检测到连续 ≥3 轮未更新 Todo → 在 tool_result 中注入 `<reminder>Update your todos.</reminder>`
- TodoManager 强制"同时只能有一个 in_progress 任务"

**我们的问题**：
- 模型没有 Todo 维护习惯（system prompt 里没有要求）
- 计划合规检验（P1.2）只是被动提醒"你还在按计划吗"，不是主动追踪进度
- 缺乏"任务完成度"的量化指标——不知道模型到底完成了计划的百分之几

**为什么重要**：
这是 Claude Code 最巧妙的防漂移设计。它不是等模型陷入循环才介入，而是通过积极的进度追踪**预防**循环——模型被训练成主动维护 Todo，系统作为二级监督者。

### 差距 3：上下文压缩后身份恢复

**CC 怎么做**：
```python
if len(messages) <= 3:
    messages.insert(0, {"role": "user",
        "content": f"<identity>You are '{name}', role: {role}, "
                   f"team: {team_name}. Continue your work.</identity>"})
```

**我们的问题**：
- `compact()` 压缩后系统 prompt 可能被推到很后面
- 模型在长任务中途可能"忘记自己是编程 Agent"
- 没有机制确保身份一致性的持续存续

### 差距 4：显式终止标记 — 推断 vs 声明

**当前做法**（推断式）：
```
模型不调工具了 → gotToolUse=false → 判定为"final"
```

**Claude Code / MiniCode 做法**（声明式）：
```
模型自行输出 <final> 或 <progress>
```

**推断式的问题**：
- 模型可能不调工具但也不是真的完成（如：卡住了、不知道该调什么工具）
- 我们在 `!gotToolUse` 时直接进入 Elevate 闸，如果模型其实是 stuck 而非 done，Elevate 的 verify_answer 也会审错方向

---

## 四、改进方案

### P1（本周）：补充 2 个硬缺口

#### 改进 1：输出递减检测

在 Loop 层加一个**文本产物趋势检测器**——不是检测工具调用，而是检测文本产出的"质量趋势"。

```typescript
// 新增变量
let lastOutputLen = 0; // 上一轮文本输出长度
let diminishingCount = 0; // 连续递减轮数
const DIMINISHING_LIMIT = 3; // 连续 N 轮递减 → 终止

// 在 !gotToolUse 分支中（模型本轮无工具调用时）
if (!gotToolUse && !limited) {
  const outLen = accContent.trim().length;
  if (outLen < lastOutputLen && outLen < 100) {
    // 文本输出在缩减且已经很少 → 可能在重复/卡住
    diminishingCount++;
  } else {
    diminishingCount = 0;
  }
  lastOutputLen = outLen;

  if (diminishingCount >= DIMINISHING_LIMIT) {
    // 连续递减，可能陷入文本重复循环
    yield { type: 'done', reason: 'no_progress' };
    return;
  }
}
```

**成本**：零 API 调用，仅 15 行本地变量追踪。

#### 改进 2：Todo 进度追踪

在 system prompt 中要求模型维护 Todo 列表，并在 tool_result 中注入进度提醒。

**Step 1**：system-prompt.ts 加一行：
```
每次开始工作时，先用 1-2 行列出你的 Todo 清单（编号），每完成一项标记 [x]。
```

**Step 2**：loop.ts 加 nag 检测（解析 assistant 消息中的 `[x]` 标记数）：
```typescript
let lastTodoDone = 0;
let roundsWithoutTodo = 0;

// 每轮结束后解析 assistant 文本中的 [x] 数量
const completedInText = (assistantText.match(/\[x\]/g) || []).length;
if (completedInText === lastTodoDone) {
  roundsWithoutTodo++;
  if (roundsWithoutTodo >= 3) {
    // 注入 todo nag
    opts.history.addUser('[系统提醒] 你已经 3 轮没有更新进度了。请确认当前进度并更新 Todo。');
  }
} else {
  roundsWithoutTodo = 0;
  lastTodoDone = completedInText;
}
```

**成本**：零 API 调用，regex 匹配几乎无开销。

### P2（下周）：补充 2 个软缺口

#### 改进 3：上下文压缩后身份重注入

在 `compact()` 调用后、下一轮 streamChat 前，检查消息数量。若 ≤3 条，注入身份块：

```typescript
// 在 loop.ts 的 compact() 之后
if (messages.length <= 3) {
  messages.unshift({
    role: 'system',
    content: `[身份恢复] 你是 DeepSeek 编程助手，正在为用户执行任务。当前工作目录: ${opts.cwd}。请继续你的工作。`,
  });
}
```

#### 改进 4：显式终止标记

不改变现有推断逻辑，但增加一个**一致性校验**——当 `!gotToolUse` 且模型文本中包含"可以继续"/"还需要"/"接下来"等暗示未完的措辞时，不触发 final，而是注入 continue 提示：

```typescript
const unfinishedHints = /可以继续|还需要|接下来|下一(步|轮)|剩余/;
if (!gotToolUse && unfinishedHints.test(accContent)) {
  // 模型文本暗示未完成，不结束
  opts.history.addUser('[系统提示] 你的答复暗示任务还未完成。如果有剩余步骤，请继续调用工具执行。如果已完成，请明确说明。');
  continue;
}
```

---

## 五、优先级总结

| 优先级 | 改进 | 预期效果 | 工作量 |
|--------|------|---------|--------|
| **P1** | 输出递减检测 | 堵住纯文本循环盲区（当前 4 路守卫全部只看工具调用） | 1h |
| **P1** | Todo 进度追踪 | 从被动检测转为主动预防（CC 最巧妙的设计） | 2h |
| **P2** | Compact 后身份恢复 | 防止长任务中途迷失 | 0.5h |
| **P2** | 未完成措辞检测 | 防止模型"假装完成" | 0.5h |

**不改的**：我们现有的 4 路守卫（failStreak/stallStreak/repeatCount/detectCycle）+ replan + Elevate 质量闸已经在**工具调用模式检测**上超过 Claude Code。Claude Code 的优势在**文本输出质量趋势**和**主动进度追踪**——恰好是我们的盲区。
