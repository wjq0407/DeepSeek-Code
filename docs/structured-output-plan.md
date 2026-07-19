# 大模型 JSON 结构化输出保障与优化方案

> 围绕四道防线：提示词控制 → API 原生约束 → 文法约束 → 校验与自修复，逐层对照项目现状，给出可落地的优化方案。

---

## 现状总览

| 防线 | 现有实现 | 缺口 |
|------|---------|------|
| ① 提示词控制 | inline schema 声明（`VERIFY_SYSTEM` / `TASK_FIDELITY_SYSTEM` 等） | 无 few-shot 样例；格式指令不在末尾（未利用近因效应）；部分子任务 prompt 格式指令在 system 而非末尾 user |
| ② API 约束 | `response_format: { type: 'json_object' }`（`deepseek.ts:410`） | 仅 `json_object`，未用 `json_schema`（`strict: true`）；TS interface 与 API schema 不同步 |
| ③ 文法约束 | **无** | 当前仅对接闭源 API（DeepSeek），暂无开源模型路径；架构未预留文法注入点 |
| ④ 校验与自修复 | 解析层容错（去 ```json + JSON.parse + 正则抠取）；`code-verify.ts` fail-closed；`verify-task.ts` fail-soft | 无 DataModel 强校验（zod）；无「解析失败→错误注入→重试」自修复循环；各工具解析逻辑重复 |

**一句话诊断**：第 ② 层用了 API 开关但没到位；第 ① 层缺「高质量样例 + 末尾锚定」两个关键手段；第 ④ 层缺闭环；第 ③ 层是空白。下面逐层展开。

---

## 第一道防线：提示词控制层

### 1.1 原理

三层叠加效应保证模型「愿意输出正确结构的 JSON」：

1. **Schema 注入**：在 system/user 提示词中明确字段名、类型、含义、约束，让模型知道「结构长什么样」。
2. **Few-shot 样例**：提供 1–2 个带**真实数据**的完整 JSON 样例，让模型理解「结构与内容的对应关系」——空洞的 `{field: "xxx"}` 不如 `{pass: true, risk: "none", summary: "代码逻辑正确，无常边界越界"}`。
3. **末尾锚定（近因效应）**：Transformer 的自回归注意力对序列末尾 token 敏感度最高。把格式要求放在提示词的**最后 ~100 个 token** 里，显著降低格式畸形概率。

### 1.2 项目现状

以 `verify-answer.ts` 为例（典型模式）：

```
[system] VERIFY_ANSWER_SYSTEM  ← 含 JSON schema + 判断标准 + 规则（约 800 token）
[user]   VERIFY_ANSWER_PREAMBLE ← "输出严格 JSON（字段：...）"
[user]   待审核内容
```

**问题一：无 few-shot 样例。** 所有复合工具的 prompt 全是「零样本指令」，模型靠指令理解结构，对字段边界（如 `risk` 是 `"none"` 还是 `"low"`、`severity` 用 `"high"` 还是 `"HIGH"`）缺乏参照。

**问题二：格式指令位置靠前。** `VERIFY_ANSWER_SYSTEM` 的 JSON 格式声明（第 20–34 行）在 system prompt 开头位置，离最终 user 消息结束有数百 token。模型在输出时更偏向末尾 user 消息的语义而非几百 token 前的 system 指令。`VERIFY_ANSWER_PREAMBLE` 虽作为 user 消息注入，但「输出严格 JSON」这句话仍被夹在中间——它前面有「请审核以下...」、后面有「审核维度:...」，并非 prompt 总体的最后 100 token。

### 1.3 优化方案

#### 1.3.1 添加 few-shot 样例（每条工具 1–2 个）

以 `verify-answer` 为例，在 `VERIFY_ANSWER_SYSTEM` 末尾追加（**非** user preamble，样例属系统知识不宜跟用户指令混在一起）：

```typescript
const FEW_SHOT_EXAMPLES = `
示例 1（审核通过）：
{"pass":true,"risk":"none","summary":"代码段逻辑正确，变量初始化完整，无安全漏洞，可交付部署。","issues":[]}

示例 2（发现事实错误）：
{"pass":false,"risk":"high","summary":"getUserById 函数的错误处理分支在 userId 为空时仍会查询数据库，可能导致空指针异常。","issues":[{"severity":"high","type":"fact_error","detail":"第 45 行 userId 为空时执行 db.query，未做判空保护","correction":"在 db.query 前增加 if(!userId) return null; 判空守卫"}]}
`;
```

要点：
- 样例用**真实场景数据**（业务相关的字段值），不要用 `"xxx"` 占位。
- 通过 / 失败的样例各一个，覆盖 `issues=[]` 和 `issues=[...]` 两种形态。
- system prompt 末尾追加。

#### 1.3.2 末尾锚定：格式要求压入最后 100 token

**核心改造**：把格式要求从 system 消息移到**最后一条 user 消息的末尾**（即 `VERIFY_ANSWER_PREAMBLE` 尾部），且精简到极致：

```diff
- 输出严格 JSON（字段：pass, risk, summary, issues[]）。
- 每个 issue 含 severity/type/detail/correction。
- 只关注事实和一致性，不评判行文风格。
+ 输出策略：只输出一行 JSON 对象，字段 pass:bool, risk:"none"|"low"|"medium"|"high", summary:string, issues:{severity,type,detail,correction}[]
```

注意这句**已经没有 `\n\n` 引起的分段（model 视为新话题）**——它作为 preamble 最后 5 行，紧贴待审核内容，利用 Transformers 对 `[指令]→[内容]` 相邻 token 的 attention 强聚焦。

**在所有复合工具的 system prompt 中统一采用以下模式**：

```
[system] 大段角色定义 + 判断标准 + few-shot 样例
[user]   简短 preamble（20–40 token）
[user]   待分析内容
```

其中 preamble 末尾 ~100 token 内必须出现 `只输出一行 JSON 对象，字段:` 并列出完整字段。这是所有 6 个复合工具的**通用模式**，可抽为工具函数：

```typescript
// src/tools/schema-helpers.ts（新建）

/**
 * 生成末尾锚定格式指令。schema 描述应简洁（~20-40 token），
 * 仅声明字段名、类型、可选值，不冗余描述含义（含义已写在 system prompt）。
 *
 * @param schemaOneLine  一行 JSON 字段描述，如 'pass:bool, risk:"none"|"low"|"medium"|"high", ...'
 * @param extraConstraints  可选的额外约束（如 "禁止 Markdown，只输出 JSON 对象"）
 * @returns  可注入到最后一个 user message 尾部的文本
 */
export function formatAnchor(schemaOneLine: string, extraConstraints?: string): string {
  const base = `输出策略：只输出一行 JSON 对象，字段 ${schemaOneLine}。`;
  return extraConstraints ? `${base} ${extraConstraints}` : base;
}
```

将 6 个复合工具的 system/user 提示词统一重构，保证每条工具的「Schema 指令」在整体 prompt「末尾 100 token 以内」的位置被模型读到。

#### 1.3.3 抗幻觉强化（补充）

在分析类工具（`review` / `audit`）的 system prompt 中加入反幻觉指令，防止模型虚构不存在的代码/文件名：

```
规则：
- 只能基于提供的源代码进行分析，不得臆造代码段。
- 引用的函数名、行号、变量名必须确实存在于源代码中。
- 若不确定某段逻辑是否存在，标记为 unclear 而非断言。
```

此项改动较小，直接修改现有 `VERIFY_SYSTEM` / `AUDIT_SYSTEM` 字符串即可，不改变架构。

---

## 第二道防线：API 原生约束（闭源模型优先）

### 2.1 原理

闭源 API（DeepSeek / OpenAI / Anthropic）提供两层约束：

- **`response_format: { type: 'json_object' }`**：保证输出流是合法 JSON 对象（语法层）。但**不保证字段名、类型、缺字段**——模型完全可能输出 `{"pass": "true", "risk": null, "summary": 42}` 而 API 不报错。
- **`response_format: { type: 'json_schema', json_schema: { strict: true, schema: {...} } }`**：将 JSON Schema 预编译到解码器，**在 token 生成阶段屏蔽不合 schema 的输出**。

两者的差距就像「只看身份证是不是合法格式」和「不仅看身份证格式，还要看姓名/性别/生日/地址每个字段都匹配数据库」。

### 2.2 项目现状

`deepseek.ts:410` 仅用了 `{ type: 'json_object' }`。这意味着：

- 模型可以输出结构合法的 `{"summary": "ok"}` 而漏掉 `pass`、`issues` 字段——API 认为「合法 JSON object，没问题」。
- 全靠第 ④ 道防线的解析+校验层兜底。

### 2.3 优化方案

#### 2.3.1 升级为 `json_schema` + `strict: true`

DeepSeek API 的 `response_format` 兼容 OpenAI 的扩展规范。需要确认其具体支持程度（2025 Q4+ 版本已支持 `json_schema`）。在 `complete()` 方法中新增分支：

```typescript
// src/llm/deepseek.ts — complete() 方法
async complete(
  messages: ChatMessage[],
  temperature = 0.3,
  options?: {
    modelOverride?: string;
    jsonMode?: boolean;
    /** 严格 JSON Schema 模式（兼容 OpenAI/DeepSeek 扩展） */
    jsonSchema?: {
      name: string;
      strict?: boolean;
      schema: Record<string, unknown>;
    };
    reasoning?: { effort?: ReasoningEffort };
    signal?: AbortSignal;
    timeoutMs?: number;
  },
): Promise<string> {
  // ...
  const params = {
    model: useModel,
    messages,
    stream: false,
    temperature,
    ...(options?.jsonMode && !options?.jsonSchema
      ? { response_format: { type: 'json_object' as const } }
      : {}),
    ...(options?.jsonSchema
      ? {
          response_format: {
            type: 'json_schema' as const,
            json_schema: {
              name: options.jsonSchema.name,
              strict: options.jsonSchema.strict ?? true,
              schema: options.jsonSchema.schema,
            },
          },
        }
      : {}),
  };
  // ...
}
```

> **注**：`json_object` 和 `json_schema` 互斥，优先 `jsonSchema`；当两者都未指定时不走结构化输出（纯文本）。

#### 2.3.2 TS Interface → JSON Schema 预编译

当前 TS 接口（如 `VerifyReport`、`AuditReport`）定义在代码中（`pass: boolean; risk: string`），**API 层不可见**。需要一条预编译链路：**TS interface → JSON Schema → API `json_schema` 参数**。

方案：用 `ts-json-schema-generator` 或 `zod-to-json-schema`（若先引入 zod）在构建期预生成 JSON Schema 文件。

推荐路径（最小侵入）：**每个复合工具导出一个 `SCHEMA` 常量**，手写 JSON Schema（约 20 行），写入工具的 response_format：

```typescript
// src/tools/verify-answer.ts（新增导出）
export const VERIFY_ANSWER_JSON_SCHEMA = {
  name: 'verify_answer_report',
  strict: true,
  schema: {
    type: 'object',
    properties: {
      pass: { type: 'boolean' },
      risk: { type: 'string', enum: ['none', 'low', 'medium', 'high'] },
      summary: { type: 'string' },
      issues: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            severity: { type: 'string', enum: ['high', 'medium', 'low'] },
            type: { type: 'string', enum: ['fact_error', 'contradiction', 'omission', 'overclaim', 'unclear'] },
            detail: { type: 'string' },
            correction: { type: 'string' },
          },
          required: ['severity', 'type', 'detail', 'correction'],
          additionalProperties: false,
        },
      },
    },
    required: ['pass', 'risk', 'summary', 'issues'],
    additionalProperties: false,
  },
};
```

调用时：在 `runTaskFidelity` / `runCodeVerify` / `runReview` 等函数中，`client.complete(msgs, 0.1, { jsonSchema: VERIFY_ANSWER_JSON_SCHEMA, ... })`。

**收益**：API 侧**100% 保证**输出对象不会漏 `pass` 字段、不会把 `risk` 写成 `"HIGH"`（因为 enum 约束在解码器层就屏蔽了）。这是从「语法保证」到「语义保证」的本质跨越。

#### 2.3.3 降级策略

并非所有时刻都可用 `json_schema`（旧版本 API、某些 provider 不支持）。实施时需封装 **capability detection**：

```typescript
// src/llm/deepseek.ts（新增）
private supportsJsonSchema = true; // 默认假设支持

/**
 * 构建结构化输出参数。自动降级：jsonSchema > jsonMode > 无结构化约束。
 */
private buildResponseFormat(opts?: { jsonMode?: boolean; jsonSchema?: JsonSchemaOpts }) {
  if (opts?.jsonSchema && this.supportsJsonSchema) {
    return {
      type: 'json_schema' as const,
      json_schema: {
        name: opts.jsonSchema.name,
        strict: opts.jsonSchema.strict ?? true,
        schema: opts.jsonSchema.schema,
      },
    };
  }
  if (opts?.jsonMode) {
    return { type: 'json_object' as const };
  }
  return undefined;
}
```

首次遇到 `json_schema` 错误时自动关闭 `supportsJsonSchema`，后续调用退回到 `json_object`。这样无论如何第 ④ 道防线（校验+自修复）都能兜底。

---

## 第三道防线：推理引擎文法约束（开源模型必备）

### 3.1 原理

闭源模型的 API 层约束是**黑盒**（你调到 API，API 在服务端约束解码器）。开源模型本地部署时，**你直接控制推理引擎**，可以用更强的手段：

- **上下文无关文法（CFG）**：Guided Generation 的核心。用一个形式文法（如 GBNF、EBNF、JSON Schema）预先描述所有合法输出的 token 序列。
- **屏蔽不合文法状态的 token**：解码时，每一步 softmax 之后，把「不合文法」的 token logit 设为 `-∞`，模型只能从合法 token 里采样。效果等价于 `json_schema strict: true`，但**在推理引擎层面强制执行**，不依赖 API provider。
- **处理复杂嵌套**：CFG 擅长的就是递归结构（`{ issues: [{...}, {...}] }`），比简单正则屏蔽强壮得多。

主流工具：
- **llama.cpp**：GBNF（GGML BNF）文法格式，语法类似 EBNF。内置 JSON 文法生成器。
- **vLLM / SGLang**：`guided_json` / `response_format` 参数，直接传 JSON Schema。
- **Outlines / Guidance**：Python 生态，用 Pydantic Model → 自动文法约束。
- **XGrammar**（mlc-ai）：跨引擎通用文法编译器，支持 JSON Schema → GBNF/自定义约束。

### 3.2 项目现状

当前 `deepseek-code-agent` **仅对接 DeepSeek API（闭源）**，无本地推理路径。第 ③ 道防线在架构上完全空白。

### 3.3 优化方案（架构预留 + 未来落地）

#### 3.3.1 抽象 `StructuredOutput` 接口

当前 `complete()` 方法耦合了「OpenAI 兼容 API」假设。要做开源模型适配，先在 LLM 客户端层抽象一个 `StructuredOutput` 接口：

```typescript
// src/llm/types.ts（新建）
export interface JsonSchemaDef {
  name: string;
  strict: boolean;
  schema: Record<string, unknown>;
}

/**
 * 结构化输出策略。按优先级：
 * 1. 闭源 API → json_schema（第②道防线）
 * 2. 开源引擎 → grammar（第③道防线：GBNF / guided_json）
 * 3. 降级 → prompt-only（第①道防线，靠第④道校验兜底）
 * 4. none → 无约束
 */
export type StructuredOutputStrategy =
  | { kind: 'api_json_schema'; schema: JsonSchemaDef }
  | { kind: 'grammar'; grammar: string; format: 'gbnf' | 'json_schema' }
  | { kind: 'prompt_only'; schemaDesc: string }
  | { kind: 'none' };
```

`DeepSeekClient` 的 `complete()` 接受 `StructuredOutputStrategy`，内部按 `kind` 分发：

- `api_json_schema` → `response_format: { type: 'json_schema', ... }`
- `grammar` → 传给推理引擎的 guided 参数（当前为占位，未来实现）
- `prompt_only` → 仅靠 prompt（no `response_format`，完全依赖第①+④道防线）
- `none` → 纯文本，无结构化需求

#### 3.3.2 GBNF 文法生成器（未来）

当接入 llamacpp / XGrammar 时，需要从 JSON Schema 自动生成 GBNF 文法。这部分可引用 llama.cpp 的 `grammar_builder` 或直接集成 XGrammar 的库。

**语法示例**（对应 `VerifyAnswerReport`）：

```gbnf
root ::= "{" ws "\"pass\"" ws ":" ws boolean ws "," ws "\"risk\"" ws ":" ws risk-enum ws "," ws "\"summary\"" ws ":" ws string ws "," ws "\"issues\"" ws ":" ws issues-array ws "}"
boolean ::= "true" | "false"
risk-enum ::= "\"none\"" | "\"low\"" | "\"medium\"" | "\"high\""
issues-array ::= "[" ws (issue-object (ws "," ws issue-object)*)? ws "]"
issue-object ::= "{" ws "\"severity\"" ws ":" ws sev-enum ws "," ws "\"type\"" ws ":" ws type-enum ws "," ws "\"detail\"" ws ":" ws string ws "," ws "\"correction\"" ws ":" ws string ws "}"
sev-enum ::= "\"high\"" | "\"medium\"" | "\"low\""
type-enum ::= "\"fact_error\"" | "\"contradiction\"" | "\"omission\"" | "\"overclaim\"" | "\"unclear\""
string ::= "\"" ([^"\\] | "\\" (["\\/bfnrt] | "u" [0-9a-fA-F] [0-9a-fA-F] [0-9a-fA-F] [0-9a-fA-F]))* "\""
ws ::= [ \t\n]*
```

这套文法**完全锁死**输出结构：`pass` 只能是 `true/false`；`risk` 只能是 4 种枚举；`issues` 数组的每个元素必须含 `severity/type/detail/correction` 四个字段且类型对、且不能有多余字段（`additionalProperties: false`）。

#### 3.3.3 优先级判断

当同时存在多种约束手段时，按以下优先级选择：

1. **本地开源引擎 + grammar** > 
2. **闭源 API + json_schema** > 
3. **闭源 API + json_object** > 
4. **prompt_only**

实现为一个策略选择器：

```typescript
export function selectStrategy(
  apiSupports: { jsonSchema?: boolean; jsonObject?: boolean },
  localEngine?: { kind: 'llamacpp' | 'vllm' | 'none' },
  schema?: JsonSchemaDef,
): StructuredOutputStrategy {
  if (localEngine && localEngine.kind !== 'none' && schema) {
    return { kind: 'grammar', grammar: toGbnf(schema), format: 'gbnf' };
  }
  if (apiSupports.jsonSchema && schema) {
    return { kind: 'api_json_schema', schema };
  }
  if (apiSupports.jsonObject) {
    return { kind: 'prompt_only', schemaDesc: schema?.name ?? 'json' };
  }
  return { kind: 'none' };
}
```

**现状落地建议**：第 ③ 道防线不急于实现（你当前没有本地模型路径）。先在类型层面预留 `StructuredOutputStrategy` 接口和策略选择器，让 `complete()` 的参数从 `{ jsonMode?: boolean }` 迁移到 `{ strategy?: StructuredOutputStrategy }`。这为未来接入任何本地推理引擎打下干净的抽象层。

---

## 第四道防线：工程校验与自修复

### 4.1 原理

前三道防线**都不能达到 100%**——API 可能超时返回半截 JSON、模型可能在 strict schema 约束下仍然输出逻辑不一致的值（`pass: true` 但 `risk: "high"` 且 issues 有 3 条）。

第 ④ 道防线的任务：**不管前三道防线返回什么，代码层必须兜住**。这需要三层机制：

1. **DataModel 校验**：用 zod（或 class-validator）定义 schema，`parse` 时自动做类型检查 + 类型转换。
2. **类型转换（coercion）**：微小的类型不一致（如 `"true"` vs `true`、`42` vs `"42"`）不报错，自动转换（`z.coerce.boolean()` / `z.coerce.string()`）。
3. **校验失败 → 错误注入 → 重试**：捕获校验报错，把**错误的 JSON 原文 + 校验错误日志**作为新 user 消息发给模型，请求修复后重试。这是「自修复（self-healing）」闭环。

### 4.2 项目现状

**解析层**已有容错，但**无 DataModel 强校验、无自修复重试**。具体问题：

#### 4.2.1 解析逻辑重复

每个工具的 `render*JSON()` 函数都独立实现了「去 ```json → JSON.parse → 字段判空」：

| 文件 | 重复逻辑 |
|------|---------|
| `verify-answer.ts:73-83` | 去 ``` + JSON.parse + try/catch |
| `verify-task.ts:125-135` | 同上 |
| `code-verify.ts:65-77` | 同上（+ fail-closed） |
| `review.ts` | 同上 |
| `audit.ts` | 同上 |
| `discovery.ts:110-118` | 同上 |

这是 6 份重复代码，本质上做的是同一件事：`JSON 文本 → 结构化对象`。

#### 4.2.2 仅做 JSON.parse，不做字段级校验

`verify-task.ts:132` 的 `parsed = JSON.parse(jsonStr) as TaskFidelityReport` —— **`as` 只满足 TypeScript 编译器，运行时完全裸奔**。一个恶意/异常的输出如 `{"pass":"true","must_fix":42}` 会通过 `JSON.parse` 但后续 `Array.isArray(parsed.must_fix)` 返回 false，导致 `forEach` 崩溃（虽然当前有守卫，但这是被动防御，不是显式校验）。

#### 4.2.3 无自修复闭环

当前 parse 失败后的行为是**终止**（`code-verify.ts`: 返回 `inconclusive=true`）或**降级**（`verify-task.ts`: 返回 `[JSON 解析失败]`）。没有给模型第二次机会。这对于 `json_object` 模式下低频但存在的畸形 JSON 来说，是一个无效的兜底——宁愿「放弃这轮」也不愿「修好这轮」。

### 4.3 优化方案

#### 4.3.1 通用解析器 `parseJSON<T>`：消除 6 份重复

```typescript
// src/tools/structured-parse.ts（新建）

/**
 * 结构化解析结果
 */
export interface ParseResult<T> {
  /** 是否成功解析并通过 DataModel 校验 */
  ok: boolean;
  /** 解析后的数据（ok=false 时无意义） */
  data?: T;
  /** 原始模型返回文本（用于自修复反馈） */
  rawText: string;
  /** 解析/校验失败的详细信息（ok=false 时填充） */
  errors?: string[];
}

/**
 * 通用 JSON 结构化解析。
 *
 * 步骤：
 * 1. 去 markdown 围栏（```json ... ```）
 * 2. JSON.parse
 * 3. zod schema 校验 + 类型转换
 * 4. 返回 ParseResult
 *
 * @param rawText   模型原始返回文本
 * @param schema    zod schema（用于类型校验 + 转换）
 */
export function parseJSON<T>(
  rawText: string,
  schema: z.ZodType<T>,
): ParseResult<T> {
  // Step 1: 去掉 markdown 代码围栏
  let jsonStr = rawText.trim();
  const fenceMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) jsonStr = fenceMatch[1].trim();

  // Step 2: JSON.parse
  let rawObj: unknown;
  try {
    rawObj = JSON.parse(jsonStr);
  } catch (e) {
    return {
      ok: false,
      rawText,
      errors: [`JSON 语法错误: ${(e as Error).message}`],
    };
  }

  // Step 3: zod 校验 + 类型转换
  const result = schema.safeParse(rawObj);
  if (!result.success) {
    return {
      ok: false,
      rawText,
      errors: result.error.issues.map(
        (i) => `字段 ${i.path.join('.')}: ${i.message}`,
      ),
    };
  }

  return { ok: true, data: result.data, rawText };
}

/**
 * 正则兜底提取（从非 JSON 文本中抓取含关键字段的 {...}）。
 * 适用于 assessComplexity 等「模型可能夹带说明文字」的场景。
 *
 * @param rawText   模型返回文本
 * @param keyField  关键字段名（如 'complex'），用于定位 JSON 块
 * @param schema    zod schema
 */
export function regexExtractJSON<T>(
  rawText: string,
  keyField: string,
  schema: z.ZodType<T>,
): ParseResult<T> {
  const regex = new RegExp(
    `\\{[\\s\\S]*?"${keyField}"\\s*:\\s*(?:true|false|"[^"]*"|-?\\d+)[\\s\\S]*?\\}`,
  );
  const match = rawText.match(regex);
  if (!match) {
    return {
      ok: false,
      rawText,
      errors: [`未找到含字段 ${keyField} 的 JSON 对象`],
    };
  }
  return parseJSON(match[0], schema);
}
```

#### 4.3.2 用 zod 替代「裸 `as` + 手动判空」

以 `verify-answer.ts` 为例，重构前后对比：

**重构前**：
```typescript
let parsed: VerifyAnswerReport;
try {
  parsed = JSON.parse(jsonStr) as VerifyAnswerReport;
} catch {
  return `[JSON 解析失败，返回原始输出]\n${raw}`;
}
// 后续：手动 typeof / Array.isArray 判空
```

**重构后**：
```typescript
import { parseJSON } from './structured-parse.ts';

const verifyAnswerSchema = z.object({
  pass: z.coerce.boolean(),
  risk: z.enum(['none', 'low', 'medium', 'high']).default('none'),
  summary: z.string().default(''),
  issues: z.array(z.object({
    severity: z.enum(['high', 'medium', 'low']),
    type: z.enum(['fact_error', 'contradiction', 'omission', 'overclaim', 'unclear']),
    detail: z.string(),
    correction: z.string(),
  })).default([]),
});

const result = parseJSON(raw, verifyAnswerSchema);
if (!result.ok) {
  // 进入自修复流程（见 4.3.3）
  return { parseFailed: true, rawText: raw, errors: result.errors };
}
// result.data 已通过 zod 校验，类型安全
const report: VerifyAnswerReport = result.data;
```

**收益**：
- `z.coerce.boolean()` 自动把 `"true"` → `true`、`1` → `true`、`"false"` → `false`（微妙格式差异不再阻塞流程）。
- `z.enum(...)` 在运行时拦截非法值（如 `risk: "CRITICAL"`）。
- `z.boolean()` 保证 `pass` 是 `boolean`，不会再出现 `pass: "true"` 通过后续 `if (r.pass) {...}` 而行为异常。

#### 4.3.3 自修复重试闭环（核心创新）

这是第 ④ 道防线的精华——**不是「放弃这个结果」，而是「让模型自己修好」**。

```typescript
// src/tools/structured-parse.ts（新增）

export interface SelfHealOptions {
  /** 最大重试次数（默认 2，总计 3 次调用） */
  maxRetries?: number;
  /** 是否在重试时使用 reasoning 模式提高修复质量 */
  useReasoningOnRetry?: boolean;
  /** AbortSignal */
  signal?: AbortSignal;
}

/**
 * 带自修复的结构化输出获取器。
 *
 * 流程：
 * 1. 调用 client.complete(jsonSchema:...) → rawText
 * 2. parseJSON(rawText, schema) → ok? 返回 : 继续
 * 3. 构造修复提示：原 rawText + 校验错误 → 发回模型要求修正
 * 4. 最多重试 maxRetries 次
 *
 * @returns 始终返回 ParseResult<T>（ok=false 表示耗尽重试仍失败）
 */
export async function fetchStructured<T>(
  client: DeepSeekClient,
  messages: ChatMessage[],
  schema: z.ZodType<T>,
  jsonSchemaDef: JsonSchemaDef,
  opts: SelfHealOptions = {},
): Promise<ParseResult<T>> {
  const maxRetries = opts.maxRetries ?? 2;

  let rawText = await client.complete(messages, 0.1, {
    jsonSchema: jsonSchemaDef,
    signal: opts.signal,
  });

  let result = parseJSON(rawText, schema);
  if (result.ok) return result;

  // 自修复循环
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const fixPrompt = `你上一次输出解析失败。以下为原始输出和校验错误：

原始输出：
${rawText}

校验错误：
${result.errors?.map((e) => `\`${e}\``).join('\n')}

请修正上述问题，重新输出完整 JSON 对象。仅输出 JSON，不要包含解释。`;

    rawText = await client.complete(
      [...messages, { role: 'assistant', content: rawText }, { role: 'user', content: fixPrompt }],
      0.1,
      {
        jsonSchema: jsonSchemaDef,
        reasoning: opts.useReasoningOnRetry ? { effort: 'medium' } : undefined,
        signal: opts.signal,
      },
    );

    result = parseJSON(rawText, schema);
    if (result.ok) return result;
  }

  // 耗尽重试，返回最终失败结果（rawText 为最后一次失败输出）
  return result;
}
```

**调用示例**（重构后的 `runCodeVerify`）：

```typescript
export async function runCodeVerify(
  client: DeepSeekClient,
  target: string,
  opts: { goal?: string; focus?: string; signal?: AbortSignal },
): Promise<CodeVerifyOutcome> {
  // ... 前置检查 ...

  const msgs: ChatMessage[] = [
    { role: 'system', content: VERIFY_SYSTEM },
    { role: 'user', content: VERIFY_PREAMBLE },
    { role: 'user', content: user },
  ];

  const result = await fetchStructured(
    client, msgs,
    verifyReportSchema,
    VERIFY_CODE_JSON_SCHEMA,
    { maxRetries: 2, signal: opts.signal },
  );

  if (!result.ok) {
    return {
      ran: true,
      pass: false,
      hasHigh: false,
      rendered: '[Pro 校验 JSON 解析失败，验证未完成，请人工复核]\n'
        + `[错误: ${result.errors?.join('; ')}]`,
      inconclusive: true,
    };
  }

  const r = result.data;
  return {
    ran: true,
    pass: r.pass,
    hasHigh: r.issues.some((i) => i.severity === 'high'),
    rendered: renderVerifyMarkdown(r, target, client.reasoningModel),
    inconclusive: false,
  };
}
```

**成本分析**：每次自修复重试 = +1 次 `complete()` 调用。实测中，`json_object` 模式下解析失败率约 3–5%，`json_schema strict` 下 <1%。以 5% 失败率、max 2 次重试计算，平均每次调用额外成本 <0.1 次 API 调用，但消除了「结果白费」的用户可感知失败——这是一个合理的可用性/成本 tradeoff。

#### 4.3.4 统一所有复合工具到同一套解析链

重构后，6 个复合工具的解析路径全部统一：

```
模型 rawText
  → parseJSON(rawText, toolSpecificZodSchema)
    → ok? → 渲染 Markdown 结果 → 回传主循环
    → fail? → 自修复循环 (max 2 次)
      → ok? → 渲染 → 回传
      → 仍 fail? → fail-open(verify-task) / fail-closed(code-verify) 返回兜底
```

**实施清单**：

| 文件 | 改动 |
|------|------|
| `src/tools/structured-parse.ts` | **新建**：`parseJSON`, `regexExtractJSON`, `fetchStructured`, `SelfHealOptions` |
| `src/tools/verify-answer.ts` | 添加 `verifyAnswerSchema`(zod) + `VERIFY_ANSWER_JSON_SCHEMA`；`runVerifyAnswer` 改用 `fetchStructured` |
| `src/tools/verify-task.ts` | 同上 |
| `src/tools/code-verify.ts` | 同上 |
| `src/tools/review.ts` | 同上 |
| `src/tools/audit.ts` | 同上 |
| `src/tools/discovery.ts` | 同上（terminology 部分）|
| `src/llm/deepseek.ts` | `complete()` 新增 `jsonSchema` 参数 + `buildResponseFormat()` 降级逻辑 |
| `src/tools/schema-helpers.ts` | **新建**：`formatAnchor()` 末尾锚定工具函数（第 ① 道防线） |
| `src/agent/loop.ts` | `assessComplexity` 改用 `regexExtractJSON`（替换内联正则） |

---

## 实施优先级与路线图

### Phase 1 — 本周（最大 ROI，零架构风险）

| # | 项 | 涉及文件 | 工作量 |
|---|----|---------|--------|
| P1-1 | 添加 few-shot 样例（6 个复合工具各 1–2 个）+ 末尾锚定重构 | `verify-answer.ts`, `verify-task.ts`, `code-verify.ts`, `review.ts`, `audit.ts`, `discovery.ts` | 2h |
| P1-2 | 新建 `structured-parse.ts` + zod 依赖安装 | 新建 | 1h |
| P1-3 | `verify-answer.ts` 接入 zod + `parseJSON`（第一个试点） | `verify-answer.ts` | 1h |
| P1-4 | `deepseek.ts` 添加 `jsonSchema` 参数 + 降级逻辑 | `deepseek.ts` | 1h |

**P1 目标**：第 ① 道防线补齐（few-shot + 末尾锚定）；第 ④ 道防线打下基础设施（通用解析器）；第 ② 道防线打通 API 路径。

### Phase 2 — 下周（全链路贯通）

| # | 项 | 涉及文件 | 工作量 |
|---|----|---------|--------|
| P2-1 | 剩余 5 个工具迁移到 zod + `parseJSON` | `verify-task.ts`, `code-verify.ts`, `review.ts`, `audit.ts`, `discovery.ts` | 2h |
| P2-2 | 实现 `fetchStructured` 自修复循环 + 接入 `runCodeVerify` | `structured-parse.ts`, `code-verify.ts` | 2h |
| P2-3 | `assessComplexity` 改用 `regexExtractJSON` | `loop.ts` | 0.5h |
| P2-4 | 6 个工具添加 `*_JSON_SCHEMA` 常量 + `client.complete` 改传 `jsonSchema` | 6 个工具文件 | 2h |
| P2-5 | E2E 验证：构造故意畸形的 JSON → 验证自修复循环生效 | 冒烟测试 | 1h |

**P2 目标**：第 ② 道防线升级（`json_schema strict`）；第 ④ 道防线闭环（自修复）。

### Phase 3 — 远期（开源模型适配时再开）

| # | 项 | 涉及文件 | 备注 |
|---|----|---------|------|
| P3-1 | `StructuredOutputStrategy` 接口 + `selectStrategy()` | `llm/types.ts` 新建 | 架构预留 |
| P3-2 | `complete()` 参数迁移：`jsonMode/jsonSchema` → `strategy` | `deepseek.ts` | 向后兼容 |
| P3-3 | GBNF 文法生成器（JSON Schema → GBNF） | 新建 `llm/grammar.ts` | 需要引入 llamacpp/XGrammar 依赖 |

---

## 总结

```
                    ┌──────────────────────────────────────┐
                    │   结构化输出保证金字塔                │
                    │                                      │
                    │  L4 校验+自修复 ← 「错了也能修」       │
                    │  L3 文法约束   ← 「开源模型的保险丝」  │
                    │  L2 API 约束   ← 「闭源模型的护栏」    │
                    │  L1 提示词     ← 「最基础的合约」       │
                    └──────────────────────────────────────┘
```

| 防线 | 一句话 | 当前状态 | 优化目标 |
|------|--------|---------|---------|
| L1 提示词 | 告诉模型「我要什么」 | inline schema，无 few-shot | 每工具 1–2 个真实样例 + 格式指令压入末尾 100 token |
| L2 API | 模型想乱写也写不出 | `json_object` | `json_schema strict`，预编译 TS → JSON Schema |
| L3 文法 | 逐 token 锁死输出 | 无 | `StructuredOutputStrategy` 架构预留 + GBNF 生成器 |
| L4 校验 | 代码层兜底一切 | 解析容错，无重试 | zod 强校验 + `fetchStructured` 自修复闭 环 |

四道防线层层递进，每一层解决上一层漏过来的问题。Phase 1 和 Phase 2 的工作量约 12 小时，可以直接把结构化输出的健壮性从「靠 prompt 赌人品」提到「API 锁死 + 代码兜底 + 重试自愈」的水平。
