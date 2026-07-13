# DeepSeek Code Agent 记忆系统技术报告

> 主题：一套**轻量级 RAG（检索增强生成）记忆系统**的架构设计
> 版本：v0.6（记忆层增强，2026-07-11）
> 范围：`src/memory/` 模块 + `src/cli/main.ts` 注入点
> 一句话本质：**把用户说过的偏好沉淀成条目，启动时按"当前语境"召回最相关的几条，拼进系统提示词，让模型"记得"你。**

---

## 0. 设计哲学：为什么是"轻量"RAG

在动手之前先确立一个关键判断——**这套系统服务的对象是"记忆"，不是"代码检索"**。

这个区分决定了整套架构。参照 Claude Code 的分层：

| 场景 | 检索方式 | 原因 |
|------|----------|------|
| **代码**（找函数/定位实现） | Agentic Search（grep / glob / read） | 代码要**精确定位**，语义近似会带偏；且代码结构清晰，工具能直达 |
| **记忆**（用户偏好/习惯） | 轻量 RAG（向量语义召回） | 偏好是**模糊语义**，"我讨厌 class 组件"和"用函数式写法"要能对上号 |

因此本系统刻意做了三条边界约束（贯穿所有模块）：

1. **记忆只服务非代码语义，绝不进入 grep/search 工具链**——避免污染代码检索。
2. **子 Agent（delegate）不加载记忆**——保持上下文隔离。
3. **全链路优雅降级**——无 embedding 模型 / 离线 / 无 key，任何一环失败都退化为关键词召回，绝不报错。

"轻量"体现在：**不需要向量数据库、不需要远程 embedding API、不每轮检索**。整个索引就是一个 `memories.json` 文件，召回只在**启动时预取一次**。这套架构足够一个单机 CLI Agent 用，且完全离线。

### 整体数据流

```
                        ┌─────────── 写入侧（会话结束） ───────────┐
  一次完整对话 ──▶ extractor 萃取偏好 ──▶ isDuplicate 去重 ──▶ 落盘
                     (LLM 单次调用)         (阈值判定)      ├─ fact → MEMORY.md
                                                          └─ semantic → memories.json（写入即嵌入缓存向量）

                        ┌─────────── 读取侧（下次启动） ───────────┐
  上次会话最后一条 query ──▶ embed(query) ──▶ 余弦 top-K 召回 ──▶ 合并两层 ──▶ 拼进 system prompt ──▶ 送入 LLM
                          (本地 BGE 768维)   (无向量→关键词降级)  (项目级优先)   (composeSystemPrompt)
```

下面按你问的五个层面逐一拆解。

---

## 1. 怎么切分的（Chunk）

**结论先行：这套系统没有传统 RAG 的"字符/token 滑窗切块"，而是"语义级原子切分"——一条记忆 = 一个 chunk。**

传统 RAG 面对的是长文档（PDF、网页），必须用固定窗口 + overlap 把它切成小块。但记忆系统的输入不是长文档，而是**一次对话**，切分的目标是"从对话里抽出彼此独立、可复用的偏好条目"。所以切分工作交给了 **LLM 萃取器**（`extractor.ts`），而不是字符串切割函数。

### 1.1 切分前的预处理

`buildTranscript()` 先把对话降噪、截断：

```ts
// extractor.ts:58
function buildTranscript(history): string {
  const msgs = history.getMessages()
    .filter(m => m.role === 'user' || m.role === 'assistant'); // 丢掉 system/tool 噪声
  const text = msgs.map(m => `[${m.role==='user'?'用户':'助手'}] ${m.content}`).join('\n');
  return text.length > MAX_TRANSCRIPT_CHARS ? text.slice(-MAX_TRANSCRIPT_CHARS) : text; // 尾部截断
}
```

关键参数（`extractor.ts:24-28`）：

| 参数 | 值 | 作用 |
|------|-----|------|
| `MIN_TRANSCRIPT_CHARS` | 200 | 对话太短直接跳过，不浪费 token |
| `MAX_TRANSCRIPT_CHARS` | 6000 | 只取尾部（近期重点），1M 上下文其实够，但抽取不需要全量 |
| `MAX_ITEMS` | 10 | 单次会话最多沉淀 10 条，防记忆库膨胀 |

### 1.2 LLM 语义切分

真正的"切分"是一次 LLM 调用：给定萃取系统提示词（`EXTRACT_SYS`），让模型把对话切成**结构化的独立偏好条目**，并给每条打上类型标签：

```ts
// extractor.ts:99
const kind = rec.kind === 'fact' ? 'fact' : 'semantic';
```

两种 chunk 类型（这是本系统最核心的设计）：

- **`fact`（硬事实）**——永远成立、每次都该注入的稳定习惯（如"前端用 React + TS""讲解用费曼法"）。落 `MEMORY.md`，**每次会话全量注入**。
- **`semantic`（软偏好）**——靠相似度召回的情境性偏好（如"正在准备前端实习"）。落 `memories.json`，**按需召回**。

> **与教科书 RAG 的差异（诚实说明）**：教科书 RAG 的 chunk 是"文本片段"，切分靠规则（长度/分隔符）。本系统的 chunk 是"一条语义完整的偏好"，切分靠 LLM 理解。好处是每个 chunk 天然自包含、无需 overlap；代价是切分依赖 LLM（无 key 时这一步 no-op，不产出新记忆）。

### 1.3 常驻事实的切分

`MEMORY.md` 里的 fact 是**按行切分**的——一行一条（`- xxx`）。去重时也逐行比较，而不是把整个文件当一坨（见第 4 节）。

---

## 2. 怎么索引的（Index）

**结论：双轨 + 双层。写入即嵌入，向量缓存进 JSON；无向量库、无远程 API。**

### 2.1 双轨存储

每个作用域目录下两个文件（`store.ts:20-21`）：

| 文件 | 内容 | 是否建向量索引 | 注入方式 |
|------|------|:---:|------|
| `MEMORY.md` | 常驻硬事实（人类可读） | ❌ | 每次全量注入 |
| `memories.json` | `MemoryEntry[]`（软偏好） | ✅ 写入时嵌入缓存 | 语义召回 top-K |

`MemoryEntry` 数据模型（`types.ts`）：

```ts
interface MemoryEntry {
  id: string;          // uuid
  content: string;     // 记忆文本
  tags?: string[];     // 分类标签
  createdAt: number;   // 时间戳
  embedding?: number[]; // 写入时缓存的向量；无模型/嵌入失败时缺失
}
```

### 2.2 索引即嵌入（写入时算一次）

关键设计：**向量在写入时算好并缓存**，避免每次检索重算——这正是"轻量 RAG 预取"的核心。

```ts
// store.ts:77
async addEntry(content, tags?) {
  const embedding = await this.embedder.embed(content); // 写入时嵌入
  const entry = { id: randomUUID(), content, tags, createdAt: Date.now(),
                  embedding: embedding ?? undefined };  // 缓存进条目
  all.push(entry); this.writeIndex(all);               // 落盘 memories.json
}
```

### 2.3 嵌入器：本地 BGE 模型（关键决策）

> **踩坑记录（2026-07-11 端到端验证）**：DeepSeek **只有 Chat 接口，根本没有 embeddings 端点**。官方确认："OpenAI-compatible surface is Chat Completions only."
> 所以本项目**不依赖任何远程 embedding API**，改用**本地 BGE 中文模型**（`Xenova/bge-base-zh-v1.5`，768 维），通过 `@huggingface/transformers` 在进程内跑 ONNX 推理：离线、免 key、中文语义强。

```ts
// embedder.ts:54
async embed(text): Promise<number[] | null> {
  if (this.mode === 'off') return null;
  try {
    const extractor = await this.getExtractor();          // 懒加载管线，只初始化一次
    const out = await extractor(text, { pooling: 'mean', normalize: true });
    return Array.from(out.data);                           // 768 维、已归一化
  } catch {
    return null; // 模型未下载/离线/原生依赖缺失 → 降级关键词召回
  }
}
```

设计要点：
- **懒加载**：模型管线只在首次用到时初始化一次（`extractorPromise` 缓存 Promise）。
- **懒下载**：首次使用从 HuggingFace Hub 下载 ~110MB 到本地缓存，之后完全离线。
- **归一化**：`normalize: true`，向量已单位化，后续余弦相似度可直接点积。

### 2.4 双层作用域索引

`MemoryManager` 把两套 `MemoryStore` 聚合（`manager.ts:31`），对标 Claude Code 的"全局 CLAUDE.md + 项目 CLAUDE.md"：

| 作用域 | 目录 | 内容 |
|--------|------|------|
| **用户级** | `~/.dsa/memory` | 跨所有项目的偏好（如"讲解用费曼法"） |
| **项目级** | `<cwd>/.dsa/memory` | 仅当前项目的约定（如"这个项目用 tsx 跑"） |

---

## 3. 怎么召回的（Retrieve）

**结论：query 嵌入一次 → 余弦 top-K；无向量则自动关键词 Dice 降级；两层各召回再合并。**

### 3.1 召回时机：启动预取，而非每轮检索

这是"轻量"的另一个体现。召回**只在 CLI 启动时发生一次**，query 取自**上次会话的最后一条用户消息**：

```ts
// main.ts:61
const query = lastUserQuery(lastSessionMessages ?? []); // 上次会话最后一条 user 消息
const systemPrompt = await memory.compose(SYSTEM_PROMPT, query, 5); // 预取 top-5
```

为什么这样够用？因为记忆是"背景常识"，不是"当前任务的实时资料"。启动时按上次语境把相关偏好拉进来当背景，比每轮都检索更省、也够用。

### 3.2 打分：向量优先，关键词兜底

`retrieveScored()` 是召回核心（`retriever.ts:63`）。**逐条判断能否走向量**，任一侧无向量就对该条降级：

```ts
// retriever.ts:70
const scored = entries.map(e => {
  const useVector = Boolean(queryEmbedding && e.embedding);
  const score = useVector
    ? cosine(queryEmbedding, e.embedding)   // 有向量 → 余弦相似度
    : keywordScore(query, e.content);       // 无向量 → 关键词 Dice 降级
  return { entry: e, score, mode: useVector ? 'vector' : 'keyword' };
});
scored.sort((a,b) => b.score - a.score);    // 分数降序
return scored.slice(0, k).filter(s => s.score > 0); // top-K 且过滤 0 分
```

**余弦相似度**（`retriever.ts:18`）——衡量两个向量"方向"是否一致：0°→1（同义），90°→0（无关），180°→-1（相反）。

**关键词降级 Dice 系数**（`retriever.ts:44`）——这是无模型时的兜底：

```ts
// Dice = 2·共同词元数 / (|q| + |c|)，范围 [0,1] 且对称
function keywordScore(query, content): number {
  const q = segment(query), c = segment(content);
  const setC = new Set(c);
  let common = 0;
  for (const w of q) if (setC.has(w)) common++;
  return (2 * common) / (q.length + c.length);
}
```

> **踩坑记录**：`segment()` 分词曾把整串中文当成一个 token，导致降级召回相似度恒为 0。修复为 **CJK 按单字切、ASCII 按连续字母数字成词**：
> ```ts
> text.toLowerCase().match(/[一-龥]|[a-z0-9]+/gi)
> ```

### 3.3 两层合并召回

`MemoryManager.retrieve()` 并行召回两层，各取 top-K 后合并截断，**项目级优先**（`manager.ts:66`）：

```ts
const [u, p] = await Promise.all([
  this.user.retrieve(query, k),
  this.project.retrieve(query, k),
]);
return [...p, ...u].slice(0, k); // 项目级排前，再截断到 k 条
```

---

## 4. 怎么重排的（Rerank）

**诚实结论：本系统没有独立的 cross-encoder 重排模型。"重排"分散在三个轻量环节里，我称之为"轻量重排策略"。**

教科书 RAG 的重排是：召回一批候选（如 top-50）→ 用更重的 cross-encoder 精排 → 取 top-5。本系统作为单机记忆库，候选量本就很小（通常十几条），上重排模型性价比不高。所以"排序质量"靠以下三层保证：

### 4.1 召回内排序（primary sort）

每层召回内部按分数降序（`retriever.ts:77`），并**过滤 0 分**（`score > 0`）——彻底不相关的条目直接不进候选，相当于一道硬门槛。

### 4.2 跨层优先级（merge priority）

合并两层时**项目级排在用户级之前**（`manager.ts:71` 的 `[...p, ...u]`）。这是一条隐式重排规则：**当前项目的约定优先级高于全局偏好**——符合直觉（项目内的具体约定比泛化习惯更该被听从）。

### 4.3 写入端去重（去冗余，等价于"负向重排"）

`isDuplicate()` 在**写入时**就把语义重复的条目挡在库外（`store.ts:124`），保证库里没有近义冗余，间接提升召回结果的信息密度：

```ts
async isDuplicate(content): Promise<boolean> {
  const top = (await this.queryScored(content, 1))[0];
  if (top && top.score >= (top.mode === 'vector' ? 0.82 : 0.6)) return true;
  // 常驻事实逐行比较（避免整坨 MEMORY.md 越攒越稀释相似度）
  for (const line of facts.split('\n')...) {
    if (keywordScore(content, line) >= 0.6) return true;
  }
  return false;
}
```

去重阈值：**向量模式 cosine ≥ 0.82**、**关键词模式重叠 ≥ 0.6** 视为重复。

> **踩坑记录**：事实去重最初把整个 `MEMORY.md` 当一坨文本去比，随着文件增大相似度被稀释、永远判不出重复。改为**逐行拆开单独比对**后修复。

### 4.4 未来可扩展点

若要上真正的重排，最小改动是在 `MemoryManager.retrieve()` 合并后加一个 rerank 步：召回放大到 top-K×3，再用一次轻量 LLM 打分或 cross-encoder 精排到 top-K。当前架构（返回 `ScoredMemory[]` 带分数和 mode）已为此预留了接口。

---

## 5. 怎么拼接生成穿入 LLM 的（Compose）

**结论：分段拼进 system prompt——base + 用户全局事实 + 项目事实 + 语义召回条目，每段带作用域标注和护栏语，启动时注入一次。**

### 5.1 拼接函数

`composeSystemPrompt()`（`composer.ts:12`）把四部分按固定顺序拼成最终系统提示词：

```ts
composeSystemPrompt(base, userFacts, projectFacts, retrieved): string {
  const blocks = [base];
  if (userFacts)    blocks.push('# 用户全局记忆（常驻事实...）\n...优先遵循：\n' + userFacts);
  if (projectFacts) blocks.push('# 项目记忆（常驻事实...）\n...优先遵循：\n' + projectFacts);
  if (retrieved.length) {
    const items = retrieved.map(e => `- ${e.content}`).join('\n');
    blocks.push('# 相关历史记忆（语义召回，仅供参考）\n...不相关则忽略：\n' + items);
  }
  return blocks.join('\n');
}
```

拼接结构（自上而下优先级递减）：

```
[SYSTEM_PROMPT 基座]
  ↓
# 用户全局记忆（常驻事实）      ← 每次全量，"优先遵循"
  ↓
# 项目记忆（常驻事实）          ← 每次全量，"优先遵循"
  ↓
# 相关历史记忆（语义召回）      ← top-K 动态，"仅供参考/不相关则忽略"
```

### 5.2 三条关键护栏

1. **事实 vs 召回分级措辞**：常驻事实用"**优先遵循**"（强指令），语义召回用"**仅供参考，不相关则忽略**"（弱建议）。防止陈旧的软记忆把模型带偏——这直接回应了我们讨论过的"RAG 要防幻觉、召回内容不是圣旨"。
2. **作用域可辨识**：用户全局事实和项目事实分成两段、各自标注来源目录，模型能分清"这是我跨项目的习惯"还是"这是本项目的规矩"。
3. **空段不注入**：三部分任一为空就不加对应段落（`if (userFacts)` 等守卫），避免给模型塞空标题制造噪声。

### 5.3 注入点：进入对话前一次性写好

```ts
// main.ts:62-64
const systemPrompt = await memory.compose(SYSTEM_PROMPT, query, 5);
const history = new ConversationHistory(systemPrompt, { client });
```

记忆**作为 system prompt 的一部分**在会话开始前就固定下来，随整个会话常驻上下文——它是"背景",不是每轮追加的检索结果。这与工具调用返回的即时检索结果在角色上完全分开。

---

## 6. 全链路降级与安全边界

这套系统的一大特点是**每一环都能失败而不崩**，逐级退化：

| 失败点 | 降级行为 |
|--------|----------|
| 无 embedding 模型 / 离线 / 原生依赖缺失 | `embed()` 返回 `null` → 召回退化为关键词 Dice |
| 无 API key / LLM 异常 | 会话结束抽取 no-op（返回 0），不新增记忆 |
| 对话过短（<200 字） | 跳过抽取，不浪费 token |
| `memories.json` 损坏 | `readIndex()` catch 返回 `[]`，不影响启动 |
| 两层都无记忆 | `compose()` 原样返回 base，不注入空段落 |

安全边界（贯穿全模块）：
- 记忆**绝不进入 grep/search 代码工具链**。
- **子 Agent 不加载记忆**（delegate 隔离）。
- 抽取只用主模型 flash + 关思考，单次调用，成本可控。

---

## 7. 与"教科书 RAG"的差异总览

| 维度 | 教科书 RAG | 本记忆系统 | 原因 |
|------|-----------|-----------|------|
| **切分** | 定长窗口 + overlap | LLM 语义萃取成原子条目 | 输入是对话不是长文档 |
| **索引** | 专用向量数据库 | 单个 JSON + 缓存向量 | 单机、轻量、够用 |
| **嵌入** | 远程 embedding API | 本地 BGE ONNX | DeepSeek 无 embedding 端点；离线免 key |
| **召回** | 每次 query 实时检索 | 启动预取一次 | 记忆是背景常识非实时资料 |
| **重排** | cross-encoder 精排 | 排序+优先级+去重三段轻量策略 | 候选量小，重排性价比低 |
| **拼接** | 检索结果塞进 user prompt | 分级注入 system prompt + 护栏 | 记忆是常驻背景不是任务资料 |

**一句话总结**：这不是一个"缩小版 RAG"，而是一个**为"单机 Agent 记忆"这个特定场景做了大量取舍的轻量 RAG**——砍掉向量库、砍掉远程 API、砍掉每轮检索和重排模型，换来完全离线、优雅降级、零额外服务依赖。每一处"没做"的地方，都是有意识的场景权衡，而不是偷懒。

---

## 附录：模块清单与关键参数

### 文件职责

| 文件 | 职责 | 对应层面 |
|------|------|----------|
| `types.ts` | `MemoryEntry` 数据模型 | — |
| `extractor.ts` | 会话结束 LLM 萃取偏好 | ① 切分 |
| `embedder.ts` | 本地 BGE 文本→向量 | ② 索引 |
| `store.ts` | 单作用域双轨落盘 + CRUD + 去重 | ② 索引 / ④ 重排 |
| `retriever.ts` | 余弦 + 关键词降级打分 | ③ 召回 |
| `manager.ts` | 双层作用域聚合 | ②③④ 汇总 |
| `composer.ts` | 拼进系统提示词 | ⑤ 拼接 |
| `cli/main.ts` | 启动注入点 | ⑤ 注入 |

### 关键参数速查

| 参数 | 值 | 位置 |
|------|-----|------|
| 嵌入模型 | `Xenova/bge-base-zh-v1.5`（768 维） | embedder.ts:21 |
| 召回 top-K | 5 | main.ts:62 |
| 去重阈值（向量） | cosine ≥ 0.82 | store.ts:126 |
| 去重阈值（关键词） | Dice ≥ 0.6 | store.ts:126 |
| 抽取最小对话长度 | 200 字符 | extractor.ts:24 |
| 抽取最大条数 | 10 条/会话 | extractor.ts:26 |
| transcript 截断 | 6000 字符（取尾部） | extractor.ts:28 |

---

*报告基于 v0.6 实际代码撰写，所有代码引用均标注文件与行号，可直接对照源码核验。*
