# 双模型架构改进方案

> 基于 ReAct / Plan & Act / Reflection 三维度 + 缓存策略评估，梳理待改进项并给出优先级。

---

## 改进清单总览

| # | 所属维度 | 问题 | 优先级 | 预期工作量 |
|---|---------|------|--------|----------|
| 1 | Reflection | Pro 质量门仅对「改变世界」的任务触发 | P0 | 1h |
| 2 | Reflection | Flash 无「输出前自我审查」环节 | P1 | 3h |
| 3 | Plan & Act | 无计划合规检验（执行中可能偏离计划） | P1 | 3h |
| 4 | ReAct | Flash 关思考 → 失去 CoT 可观测性 | P2 | 2h |
| 5 | Plan & Act | 无中继重新规划机制 | P2 | 4h |
| 6 | Reflection | 反思只在失败时生效，成功路径无验证 | P2 | 2h |
| 7 | Plan & Act | 复杂度判定为二元，无规模估算 | P3 | 2h |
| 8 | 缓存 | 无共享 PRO 前缀（跨工具缓存命中率为 0%） | P2 | 1h |
| 9 | 缓存 | 无按模型分桶的缓存命中率监控 | P3 | 1h |
| 10 | Reflection | 自修复重试 effort 固定 medium，未对齐首次调用 | P3 | 0.5h |

---

## 详细方案

### #1（P0）Pro 质量门全覆盖

**问题**：当前 Elevate 闸的触发条件是 `everMutated`（会话中曾改变世界状态）。纯读操作（分析/搜索/阅读）的执行质量完全没有 Pro 检验。

**方案**：将触发条件改为**分级**：

| 任务类型 | 触发条件 | 触发行为 |
|---------|---------|---------|
| 写操作（mutating） | `everMutated` | 当前行为不变：`verify-task` + `verify-answer` |
| 多轮读操作（>3 轮工具调用） | `totalToolRounds >= 3` | 仅 `verify-answer`（轻量事实核查，跳过任务级审计） |
| 单轮简单查询 | 无 | 不触发（保持零成本） |

**改动**：`loop.ts` Elevate 段（约 15 行）加 `else if` 分支。

---

### #2（P1）Flash 输出前自我审查

**问题**：Flash 写完答复后不自我检查，直接送 Pro 审查。如果 Flash 自己先审一遍、修正明显错误，Pro 只需要做深度核查，整体质量更高。

**方案**：在 Elevate 段之前插入「自检轮」：

```
Flash 生成草稿答复
       ↓
注入自检指令："请逐条检查你的答复：① 是否遗漏了用户的任何要求？② 是否引用了不存在的文件/函数？③ 是否有前后矛盾？"
       ↓
Flash 自我修正（1 轮额外迭代）
       ↓
修改后 → Pro 质量门审查
```

**设计约束**：
- 自检轮不计入用户可见的迭代轮次（用单独的 `selfCheckRound` 计数）
- 若 Flash 认为无需修正（`no issues found`），直接跳过修正轮
- 额外成本：+1 次 Flash 调用（<$0.001）

**改动**：`loop.ts` 在 `!gotToolUse` 分支前加自检注入。

---

### #3（P1）计划合规检验

**问题**：Agent 按计划执行后，没有机制检测它是否真的跟了计划。可能发生「计划说做 A→B→C，实际做了 A→D→E」。

**方案**：在每轮结束后，用一个轻量提示比对：

```typescript
// 注入到每轮开始时的 system 消息
const planStepCheck = planContent
  ? `\n【执行计划提醒】当前计划步骤:\n${planContent.slice(0, 300)}\n` +
    `请在本轮操作后简要说明：完成了计划的哪一步？下一步是什么？`
  : '';
```

不需要额外的模型调用——只是在已有的 system prompt 里加一段计划提醒。Flash 会在下一轮思考时自动对齐。

---

### #4（P2）ReAct CoT 可观测性

**问题**：Flash 的 `thinking: disabled` 让模型没有内部思考链，思考盒里的 `reason` 是「说出来的话」而非「想的过程」。对于调试/分析，缺少了模型的真实推理。

**方案**：不是开思考（会触发 400 陷阱），而是**加 CoT 指令**：

```
在 system prompt 中追加：
"在调用工具之前，请用简短的中文说明你当前的推理——为什么选择这个工具、期望得到什么结果。格式：一个自然段，不要编号。"
```

这不是真正的 CoT（不改变 KV cache），但能让思考盒的 `reason` 条目质量更高、更像推理而非操作描述。

---

### #5（P2）中继重新规划

**问题**：执行到一半发现计划不够（漏掉了步骤、算错依赖），没有机制修正计划。

**方案**：在连续 N 步 `failStreak + stallStreak` 超阈值时，不直接终止，而是触��「中继重新规划」：

```
连续失败 >= 2 且 stallStreak >= 2
       ↓
不终止！注入 replan 指令：
"当前计划似乎遇到了困难。请基于已完成的工作，重新规划剩余步骤。已完成的部分不需要重做。"
       ↓
Flash 输出新计划 → 继续执行
```

**限制**：最多触发 1 次 replan（防止无限重规划循环）。

---

### #6（P2）成功路径轻量验证

**问题**：Reflection 的渐进式诊断只在工具失败时触发。工具成功但结果错误（如「创建了文件但内容是错的」）完全依赖后续的 code-verify 或用户发现。

**方案**：对于关键操作（写文件、跑命令），在成功返回后追加一个**轻量自检**：

```typescript
if (res.ok && isMutating(tc.name)) {
  // 成功但需要验证：注入一个简短的提示
  const verifyHint =
    `[系统提示] ${tc.name} 已执行成功。请在给出下一轮推理时，` +
    `用一句话验证结果：产出是否符合预期？是否需要补操作？`;
  opts.history.addUser(verifyHint);
}
```

这是在已有 code-verify 机制之上的补充——code-verify 检查代码质量，这个自检检查「结果是否符合意图」。

---

### #7（P3）复杂度分级估算

**问题**：`assessComplexity` 只有 `complex: true/false` 二元输出，没有规模信息。

**方案**：扩展输出加 `effort` 字段：

```json
{"complex": true, "effort": "small"|"medium"|"large", "reason": "..."}
```

根据 effort 动态调整迭代上限：

| effort | 自动迭代上限 |
|--------|------------|
| `small` | 5 |
| `medium` | 10 |
| `large` | 20 |
| 无（默认） | ∞ |

---

### #8（P2）共享 PRO 前缀

**问题**：6 个 PRO 工具各有独立的 system prompt，跨工具缓存命中率为 0%。

**方案**：在 `structured-parse.ts` 中导出共享前缀常量：

```typescript
export const PRO_COMMON_PREFIX = `你是 DeepSeek Agent 的深度分析模块（PRO 模型）。
分析要求：基于事实，给出具体可验证的结论；不得臆造不存在的内容。
输出格式：严格的 JSON 对象（由 API json_schema 约束）。
`;
```

所有工具在构造 `messages` 时，system 消息前插入此前缀（约 50 token）。它的作用不是给指令，而是建立缓存桥梁——一次 review 调用后的缓存，可以被 verify-answer 调用在前 50 token 处命中。

**影响**：每请求额外 50 input token（¥0.00016），但跨工具调用可节省 ~1000 token 的缓存未命中成本（¥0.003）。

---

### #9（P3）按模型分桶的缓存命中率监控

**问题**：`/cost` 命令展示总缓存命中率，不区分 Flash 和 Pro，无法判断哪个模型缓存效果差。

**方案**：在 `getUsageSummary` 中增加按模型分桶的命中率：

```
Pro 模型: 45% 缓存命中（命中 3200t / 总 7100t）
Flash 模型: 68% 缓存命中（命中 12000t / 总 17600t）
```

数据已存在（`usageByModel` 已按模型分桶累加 `cacheHitTokens` / `cacheMissTokens`），只需在渲染时加一行。

---

### #10（P3）自修复重试 effort 对齐

**问题**：`fetchStructured` 的首次调用使用 `reasoningEffort`（如 `high`），但自修复重试时（`useReasoningOnRetry`）固定用 `medium`。

**方案**：重试时复用首次调用的 effort：

```typescript
// structured-parse.ts 重试段
reasoning: opts.useReasoningOnRetry
  ? { effort: opts.reasoningEffort ?? 'medium' }
  : undefined,
```

---

## 实施路线图

### Wave 1 — P0（本周，1h）

| # | 项 |
|---|----|
| 1 | Pro 质量门分级触发（写操作全检 → 读操作轻检 → 简单查詢跳过） |

### Wave 2 — P1（下周，6h）

| # | 项 |
|---|----|
| 2 | Flash 输出前自我审查（自检轮） |
| 3 | 计划合规检验（system prompt 注入计划提醒） |

### Wave 3 — P2（两周内，10h）

| # | 项 |
|---|----|
| 4 | ReAct CoT 指令增强 |
| 5 | 中继重新规划（失败+空转→replan） |
| 6 | 成功路径轻量验证 |
| 8 | 共享 PRO 前缀 |

### Wave 4 — P3（远期，5h）

| # | 项 |
|---|----|
| 7 | 复杂度分级估算（effort: small/medium/large） |
| 9 | 按模型分桶的缓存命中率监控 |
| 10 | 自修复重试 effort 对齐 |

---

## 预期收益

| 维度 | 改前评分 | 改后预期 | 关键改进 |
|------|---------|---------|---------|
| ReAct | 7.5 | 8.5 | CoT 指令 → reason 条目更像推理 |
| Plan & Act | 7.0 | 8.5 | 合规检验 + 中继 replan + 复杂度分级 |
| Reflection | 8.0 | 9.0 | 全覆盖 Pro 门 + 自检轮 + 成功验证 |
| 缓存命中率 | ~5% | ~25-35% | 共享前缀 + 监控 |
