# PRO 模型缓存命中率分析与优化方案

## 一、现有缓存机制全景

### 1.1 DeepSeek 上下文缓存（Context Caching）原理

DeepSeek API 提供**服务端前缀缓存**（Prefix Caching），自动对请求的 prompt 前缀复用 KV cache：

```
请求 A: [system prompt A] [user msg a1]
请求 B: [system prompt A] [user msg b1]
         ^^^^^^^^^^^^^^^^^ 前缀命中！系统提示词的 KV cache 被复用
```

缓存命中条件（DeepSeek 官方规则）：
- **前缀完全匹配**（从第 0 个 token 开始截断比较），任何一个 token 不同 → 未命中
- **模型名相同**（`deepseek-v4-pro` ≠ `deepseek-v4-flash`，分属不同 cache pool）
- **`thinking` 模式相同**（`enabled` ≠ `disabled`，V4 思考模式改变 KV 处理路径）
- **服务端 TTL**：约 5–15 分钟无复用则过期（未公开确切值）

计费：命中缓存的输入 token 按标准价的 **1/10** 计费（`deepseek-v4-pro`: ¥0.313/M vs ¥3.13/M）。

### 1.2 代码层缓存感知

| 位置 | 作用 |
|------|------|
| `deepseek.ts:71-76` | `extractCacheTokens()` 从 API response 的 `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens` 提取缓存数据 |
| `deepseek.ts:156-162` | `usageByModel` Map 按模型名分桶累加 `cacheHitTokens` / `cacheMissTokens` |
| `deepseek.ts:83-84` | 成本估算用 `CACHE_HIT_RATIO=0.1` 为命中 token 打折 |
| `deepseek.ts:437` | `extra_body.thinking` 决定 thinking 模式（影响缓存 key） |
| `deepseek.ts:347` | 主循环 streamChat 固定 `thinking: {type:'disabled'}` |
| `chat.ts:231` | `/cost` 命令展示缓存命中率：`缓存命中 Xtok(Y%)` |

**结论**：项目已完整感知 API 返回的缓存数据，但**未主动管理缓存**——完全依赖 API 服务端的自动前缀匹配。

---

## 二、PRO 调用链路追踪（缓存视角）

### 2.1 当前调用图谱

```
用户请求 → Flash 主循环（streamChat）
  │
  ├── 写文件 → runCodeVerify（Pro, complete）
  │           msg: VERIFY_SYSTEM[~800t] + PREAMBLE[~60t] + 代码[~2000t]
  │
  ├── 准备输出 → runTaskFidelity（Pro, complete）
  │              msg: TASK_FIDELITY_SYSTEM[~900t] + PREAMBLE[~50t] + 操作记录
  │
  ├── Elevate 闸 → verify_answer（Pro, complete）
  │               msg: VERIFY_ANSWER_SYSTEM[~1000t] + PREAMBLE[~60t] + 答复文本
  │
  ├── 用户 /review → review_code（Pro, complete）
  │                  msg: REVIEW_SYSTEM[~1200t] + PREAMBLE[~60t] + 代码
  │
  ├── 用户 /audit → audit_dependencies（Pro, complete）
  │                 msg: AUDIT_SYSTEM[~1300t] + PREAMBLE[~60t] + 依赖清单
  │
  └── 用户术语 → terminology（Pro, complete）
                 msg: TERMINOLOGY_SYSTEM[~1400t] + PREAMBLE[~60t] + 文本
```

### 2.2 缓存命中分析矩阵

| 工具 | SYSTEM token 数 | PREAMBLE token 数 | 调用频率/任务 | 推理模式 | 与其它工具的共享前缀？ |
|------|----------------|-------------------|-------------|---------|---------------------|
| verify_answer | ~1000 | ~60 | 1 次/任务 | ~~medium~~ ❌ | 无 |
| code-verify | ~1000 | ~60 | 1–10 次/任务 | ~~medium~~ ❌ | 无 |
| verify-task | ~1200 | ~50 | 1 次/任务 | ~~medium~~ ❌ | 无 |
| review_code | ~1500 | ~60 | 按需 | ~~high~~ ❌ | 无 |
| audit | ~1500 | ~60 | 按需 | ~~high~~ ❌ | 无 |
| terminology | ~1700 | ~60 | 按需 | ~~medium~~ ❌ | 无 |

**核心问题**：6 个工具使用 6 个**完全不同的 system prompt**。DeepSeek 的缓存是基于前缀逐 token 比较的——第 1 个 token 就分叉，**跨工具缓存命中率为 0%**。

---

## 三、❌ 发现的关键 BUG：PRO 推理能力丢失

### 3.1 问题

Phase 1/2 重构中，所有复合工具从直接在 `client.complete()` 传 `reasoning: {effort:'...'}` 改为走 `fetchStructured()`。但 `fetchStructured()` **首次调用未传 `reasoning` 参数**：

```typescript
// structured-parse.ts:158 — 首次调用
let rawText = await client.complete(messages, 0.1, {
  jsonSchema: jsonSchemaDef,
  signal: opts.signal,
  // ❌ 缺少 reasoning: { effort: 'medium' } 或 'high'
});
```

`complete()` 在无 `reasoning` 时走 `extra_body.thinking: {type:'disabled'}` → **PRO 模型关闭思考**，退化为普通补全模式。

| | 修复前（实际运行） | 预期 |
|---|---------|------|
| thinking 模式 | `disabled` | `enabled` |
| reasoning_content | 无 | 有（$3.13/M input, $6.26/M output） |
| 分析质量 | 低（纯快速补全） | 高（深度推理） |
| 缓存 pool | 与 Flash 相同 `disabled` pool | PRO 专属 `enabled` pool |

**影响**：PRO 调用现在运行在 `thinking: enabled` 的**相反模式**下。这不仅导致质量下降，也意味着：
- 如果 PRO 和 Flash 曾因为 `thinking: disabled` 碰巧共享过某些缓存，**修复后会分离到不同 cache pool**
- 修复后 PRO 将拥有独立的 `thinking: enabled` cache pool，不会与任何 Flash 调用混淆

### 3.2 修复方案

`fetchStructured` 加 `reasoning` 参数，各工具传入对应的 effort 档位：

```typescript
// structured-parse.ts SelfHealOptions 新增
export interface SelfHealOptions {
  maxRetries?: number;
  useReasoningOnRetry?: boolean;
  /** PRO 推理模式（首次调用的 effort；复合工具应始终传入） */
  reasoningEffort?: 'medium' | 'high';
  signal?: AbortSignal;
}
```

各工具调用处统一补上 reasoning：

| 工具 | effort |
|------|--------|
| verify_answer | `medium` |
| code-verify | `medium` |
| verify-task | `medium` |
| review_code | `high` |
| audit_dependencies | `high` |
| terminology | `medium` |

---

## 四、缓存未命中根因分析

### 根因 #1：系统提示词全隔离（影响最大）

```
verify_answer SYSTEM: "你是一名 AI 输出质量审核员..."
code-verify   SYSTEM: "你是一名代码正确性验证专家..."
verify-task   SYSTEM: "你是一名严谨的「任务交付审核员」..."
review_code   SYSTEM: "你是一名资深的代码审查专家..."
audit         SYSTEM: "你是一名中文软件供应链安全审计专家..."
terminology   SYSTEM: "你是中英技术术语对照专家..."
```

每个 SYSTEM prompt 从**第 1 个 token** 就分叉。

- `verify_answer` 的缓存对 `code-verify` **完全无用**
- `code-verify` 的缓存对 `verify-task` **完全无用**
- 每次调用全新 PRO 工具 = **前缀缓存完全未命中**

→ **跨工具缓存命中率 = 0%**

### 根因 #2：调用频率极低（次因）

| 工具 | 单任务平均调用 |
|------|-------------|
| verify_answer | 1 次（Elevate 闸） |
| verify-task | 1 次（Elevate 闸） |
| code-verify | 1–10 次（每次写文件） |
| review/audit/term | 0–2 次（用户指令驱动） |

- `verify_answer` 和 `verify-task` 每次任务各调用 1 次 → **同工具内部也无缓存复用**（调用之间间隔长、TTL 过期）
- `code-verify` 是唯一在同任务内多次调用的 PRO 工具 → **唯一定期命中缓存的场景**
- `review`/`audit`/`terminology` 完全由用户触发 → 偶尔使用，缓存几乎永远过期

### 根因 #3：服务端 TTL 过期

DeepSeek 的前缀缓存约 5–15 分钟自动过期。一个典型任务的 PRO 调用时间线：

```
0:00 → verify_answer（首次）
0:05 → code-verify #1  
0:07 → code-verify #2  ← 可能命中 #1
0:10 → code-verify #3  ← 可能命中 #1/#2
0:12 → verify-task      ← verify_answer 的缓存可能已过期（>10min 无复用）
0:15 → Elevate verify   ← 全新缓存
```

→ `code-verify` 内部有复用，其余工具因间隔过长全部过期。

### 根因 #4：few-shot 样例让前缀更长但不改善命中率

Phase 1/2 为每个工具加了 2–3 个 few-shot 样例（每个 ~150–300 token）。这些样例让 SYSTEM prompt 从 ~600 token 膨胀到 ~1300 token：

- 好处：**一旦命中，省下的 token 更多**（1300 token 打 1/10 价 vs 600 token 打 1/10 价）
- 坏处：**不影响命中率本身**（命中率由「是否有相同前缀的最近请求」决定，不受前缀长度影响）

### 根因 #5：`reasoning_effort` 不一致（修复后可能产生的影响）

修复后，`medium` 和 `high` 两种 effort 档位并存。**目前不确定** `reasoning_effort` 是否对应独立的 cache pool。如果 DeepSeek 将其视为不同的推理路径（类似 `thinking: enabled/disabled`），则 `medium` 和 `high` 的缓存也会隔离。

---

## 五、优化方案

### Phase 1：立即修复（高优先级，本周）

#### P1-1：修复 PRO 推理模式丢失（以上 3.2 节）

**改动**：`structured-parse.ts` 的 `SelfHealOptions` 加 `reasoningEffort` 字段；6 个工具调用处补传对应 effort。

**预期效果**：恢复 PRO 模型的分析质量（非缓存相关）；修复前缓存数据无效（thinking 模式错误），修复后可开始收集有效的 PRO 缓存数据。

#### P1-2：统一 `reasoning_effort` 档位

将所有 PRO 复合工具的 `reasoning_effort` 统一为 `medium`，仅 `review_code` 和 `audit_dependencies` 保留 `high`（它们确实需要更深度分析）。

| 档位 | 工具 | 解释 |
|------|------|------|
| `high` | review, audit | 深度代码审查/安全审计，推理链复杂 |
| `medium` | verify_answer, code-verify, verify-task, terminology | 质量门/轻量检查/术语对照，不需要最高强度 |

**预期效果**：减少 effort 档位数量 → 减少潜在的 cache pool 分裂。

### Phase 2：结构优化（中优先级，下周）

#### P2-1：注入共享 PRO 前缀（核心优化）

6 个工具的 SYSTEM prompt 在「角色定义」上**完全无交集**，但可以注入一个**统一的元前缀**作为第 1 条 system 消息（或 system prompt 的共同开头）：

```typescript
const PRO_COMMON_PREFIX = `你是 DeepSeek Agent 的推理分析模块，使用 deepseek-v4-pro 模型进行深度分析。
你的输出必须是严格的 JSON 对象（由 API json_schema 约束格式）。
分析要求：基于提供的事实/代码/操作记录，给出具体、可验证的结论；不得臆造不存在的内容。`;
```

然后每个工具的 messages 变为：

```typescript
const msgs: ChatMessage[] = [
  { role: 'system', content: PRO_COMMON_PREFIX },
  { role: 'system', content: TOOL_SPECIFIC_SYSTEM },
  { role: 'user', content: anchoredPreamble },
  { role: 'user', content: userData },
];
```

这样 PRO_COMMON_PREFIX（~80 token）成为**所有 6 个 PRO 工具的共享前缀**。一次 `review_code` 的缓存可以部分命中 `verify_answer` 的请求前缀。

**缓存效果**：

| | 修复前 | 修复后 |
|---|--------|--------|
| 跨工具缓存命中 | 0% | ~80 token 命中（共享前缀） |
| 同工具缓存命中 | 不变 | +80 token 额外缓存（前缀多了 80t） |
| 额外开销 | 无 | 每请求 +80 input token（¥0.00025） |

**收益**：虽然只有 80 token 共享前缀，但它建立了跨工具的缓存桥梁——一旦任何一个 PRO 工具被调用，后续**任何** PRO 工具都能在前 80 token 上命中缓存。

#### P2-2：延长缓存寿命——热工具预占

`code-verify` 是唯一在同任务内多次调用的 PRO 工具。可以利用这一点实现缓存预热：

```typescript
// 在 assembleAppProps 时，后台跑一次廉价 PRO 调用（空内容 + code-verify 的 SYSTEM）
// 目标：提前向 DeepSeek 服务端注册 code-verify 的前缀缓存
// 后续每次 code-verify 调用都能命中
```

实际上，**不需要额外 API 调用**——第一个 code-verify 调用自动建立缓存，后续调用自动命中。关键是要确保调用间隔在 5 分钟内。

#### P2-3：formatAnchor 末尾锚定指令也可做共享前缀

所有工具的 `formatAnchor` 生成文本都以 `"输出策略：只输出一行 JSON 对象，字段 "` 开头。若将这段前缀抽取为**所有 PRO 工具的固定 preamble 前缀**，也能建立跨工具缓存共享：

```typescript
const PRO_PREAMBLE_PREFIX = '输出策略：只输出一行 JSON 对象，字段 ';
const anchoredPreamble = `${toolPreamble} ${PRO_PREAMBLE_PREFIX}${schemaDesc}。`;
```

### Phase 3：架构级优化（远期，有需要时再开）

#### P3-1：PRO 调用批量化

当多个 PRO 操作需要在一个任务中执行时（如 Elevate 闸同时跑 `verify-task` + `verify_answer`），将它们安排为**同一时间窗口**内连续调用，确保缓存不过期。

#### P3-2：监测缓存命中率

在 `/cost` 命令中增加**按模型分桶的缓存命中率展示**：

```
Pro 模型: 45% 缓存命中（命中 3200t / 总 7100t）
Flash 模型: 68% 缓存命中（命中 12000t / 总 17600t）
```

当前已有 `usageByModel` 按模型分桶累加，只需在 `getUsageSummary` 中增加命中率计算即可。

#### P3-3：本地 System Prompt 指纹缓存

在客户端维护一个「最近发送的 System Prompt 指纹 → 时间戳」映射，用于**预估**某次调用是否有缓存命中。

---

## 六、优化效果预估

### 6.1 典型任务的 PRO 调用缓存命中对比

以「用户要求创建 3 个 API 接口 + 代码审查」为典型场景：

| 步骤 | PRO 调用 | 修复前 thinking 模式 | 修复前缓存 | 优化后 thinking 模式 | 优化后缓存 |
|------|---------|-------------------|----------|-------------------|----------|
| 1. 写文件 A | code-verify | disabled（bug） | ❌ 全新 | enabled | ❌ 全新（代码不同） |
| 2. 写文件 B | code-verify | disabled（bug） | ❌ 全新 | enabled | ✅ 命中 SYSTEM（前缀） |
| 3. 写文件 C | code-verify | disabled（bug） | ❌ 全新 | enabled | ✅ 命中 SYSTEM |
| 4. Elevate | verify-task | disabled（bug） | ❌ 全新 | enabled | ✅ 命中 80t 共享前缀 |
| 5. Elevate | verify_answer | disabled（bug） | ❌ 全新 | enabled | ✅ 命中 80t 共享前缀 |
| 6. 用户 /review | review_code | disabled（bug） | ❌ 全新 | enabled | ✅ 命中 80t 共享前缀 |

### 6.2 量化预期

| 指标 | 修复前（bug + 无优化） | Phase 1 修复后 | Phase 2 优化后 |
|------|----------------------|-------------|-------------|
| PRO thinking 模式 | ❌ disabled（质量低） | ✅ enabled（恢复推理） | ✅ enabled |
| 同工具内缓存命中率 | ~0%（thinking 错导致数据无效） | code-verify: ~40% | code-verify: ~50% |
| 跨工具缓存命中率 | 0% | 0% | ~10–15%（共享前缀） |
| 整体 PRO 命中率 | 0–5% | 10–15% | 25–35% |
| 每任务 PRO 调用节省 | ¥0 | ¥0.002–0.005 | ¥0.01–0.03 |
| PRO 分析质量 | 🔴 退化为普通补全 | 🟢 深度推理恢复 | 🟢 深度推理恢复 |

### 6.3 成本优化示例

假设一个典型任务有 6 次 PRO 调用（3×code-verify + verify-task + verify_answer + 1×review）：

**修复前**：6 次调用，无缓存命中，每次 ~3500 input token × ¥3.13/M = ¥0.066 total

**Phase 1 修复后**：6 次调用，`code-verify` 内部 2 次命中 ~40%，平均缓存命中 ~15%：
- hit: 3150 token × ¥0.313/M = ¥0.0010
- miss: 17850 token × ¥3.13/M = ¥0.0559
- **total: ¥0.0569**（较修复前节省 ¥0.009，14%）

**Phase 2 优化后**：6 次调用，共享前缀 + 同工具内命中，平均命中 ~30%：
- hit: 6300 token × ¥0.313/M = ¥0.0020
- miss: 14700 token × ¥3.13/M = ¥0.0460
- **total: ¥0.0480**（较修复前节省 ¥0.018，27%）

---

## 七、实施清单

### P1 立即（本次）

| # | 文件 | 改动 |
|---|------|------|
| 1 | `structured-parse.ts` | `SelfHealOptions` 加 `reasoningEffort` 字段；`fetchStructured` 首次调用传入 reasoning |
| 2 | `verify-answer.ts` | fetchStructured 调用加 `reasoningEffort: 'medium'` |
| 3 | `code-verify.ts` | fetchStructured 调用加 `reasoningEffort: 'medium'` |
| 4 | `verify-task.ts` | fetchStructured 调用加 `reasoningEffort: 'medium'` |
| 5 | `review.ts` | fetchStructured 调用加 `reasoningEffort: 'high'` |
| 6 | `audit.ts` | fetchStructured 调用加 `reasoningEffort: 'high'` |
| 7 | `discovery.ts` | fetchStructured 调用加 `reasoningEffort: 'medium'` |

### P2 下周

| # | 改动 |
|---|------|
| 8 | `structured-parse.ts` 加 `PRO_COMMON_PREFIX` 常量 |
| 9 | 全部 6 个 PRO 工具的 SYSTEM 消息前插入共享前缀 |
| 10 | `formatAnchor` 内部抽取共同前缀 |

### P3 远期

| # | 改动 |
|---|------|
| 11 | `/cost` 按模型显示缓存命中率 |
| 12 | PRO 调用批量化调度 |
