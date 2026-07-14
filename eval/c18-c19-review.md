# c18 / c19 人工复核报告（端到端开发 + 真实重构）

> 来源：真实 API 评测 `eval/results.json` → `transcript` 字段。
> 重要前提：这两个 case 是 **human 档**，评测脚本里 human 档一律 `pass = true`（见 `eval/run-eval.ts:147-149`），即那个 ✅ 只代表「跑完没崩溃」，**不代表质量达标**。质量结论以本复核为准。
> 配套原文：`c18-transcript-trimmed.md` / `c19-transcript-trimmed.md`（已剥离超大工具结果）。

---

## c18 — 端到端功能开发

**指令**：写一个 `fib.ts` 模块，导出 `fib(n)` 返回第 n 个斐波那契数（递归或迭代均可），并包含简单自测（打印前 10 项）。

**轨迹（真实）**：
1. `project_discover` 先看项目结构 → 发现是空 sandbox
2. `run_command node --version` 查环境
3. 连续 `create_file` 建 `package.json` / `tsconfig.json` / `fib.ts`（**迭代版**，带 JSDoc、负数 `throw`、前 10 项自测）
4. 尝试运行自测，连试三种方式均失败：
   - `npx ts-node fib.ts` → 失败
   - `node --experimental-strip-types fib.ts` → 失败
   - `npx tsc && node dist/fib.js` → 失败
5. trace 在第三次失败后结束，未见成功自测输出，也未见向用户说明环境限制。

**质量点评**：
- ✅ **核心交付合格**：`fib.ts` 算法正确（迭代）、有边界处理（负数抛错）、有 JSDoc、有自测打印——作为「功能开发」的代码本体是好的。
- ✅ **规划合理**：先看结构、查环境、再动手，不是上来就盲写。
- ⚠️ **验证环节脆弱**：写了正确代码却跑不通自测，且三次失败后直接结束、没有「环境不友好 → 给出本地运行说明 / 请求协助」的兜底。对「端到端」而言，「自测能跑」这一步没闭环。
- 推测失败根因（非确定，因结果被截断）：sandbox 内 `npm install` 装 `ts-node` 可能未成功，或 `tsconfig` 的 `module: commonjs` + 入口配置导致 `tsc` 产物运行失败。无论哪种，agent 缺少「诊断 → 修正配置 → 再验证」的闭环。

---

## c19 — 真实代码重构

**指令**：读取 `src/context/history.ts`，把 `compact`（压缩历史）逻辑重构得更清晰易读，保持行为不变，并说明改动。

**轨迹（真实）**：
1. `read_file` 读全文件（314 行）
2. `edit_file` #1：重构 `compact()` 主方法 → **成功**
3. `edit_file` #2：重构 `truncateCompact()`（确定性 snip 降级）→ **成功**
4. `edit_file` #3：重构「构建待摘要对话文本」片段 → **失败**（old_string 不匹配）
5. `read_file` 重试（offset 168/198/190 多次）→ 仍 `edit_file` 失败 ×2
6. `edit_file` #4：尝试重构 `summarizeCompact()` → **失败**（old_string 不匹配）
7. 最终转向 `run_command node -e` **正则替换**源码来绕过 edit 精确匹配问题

**质量点评**：
- ✅ **核心重构落地**：最该清晰的 `compact()` 与 `truncateCompact()` 两处成功改写，证明 agent 能识别并改进主逻辑的「清晰易读」。
- ⚠️ **edit 精确匹配脆弱**：多次 `old_string` 不匹配（疑似 `read_file` 返回文本与文件字节有细微差异，或 agent 记忆的片段不全），导致 3 次 edit 失败。
- 🔴 **降级策略危险**：在 edit 卡住时，agent 没有回到「重新精确 read → 精确定位 → 再 edit」的稳妥闭环，而是用 `run_command node -e` **正则改写源码**。这绕过了 edit_file 的语义保护，且正则替换极易引入行为偏差，与用户「保持行为不变」的硬性要求直接冲突。
- 注：sandbox 跑完即 `rm`，最终文件状态无法 100% 确认；但从轨迹看，最后一步是风险操作，而非干净的重构收尾。

---

## 横向复盘（两个 case 暴露的共性短板）

这两个 human 档恰好击中同一类边界——**「理想路径走完后，遇到现实摩擦时的鲁棒性」**：

1. **环境/工具摩擦下缺兜底**：c18 跑不通自测就放弃；c19 用粗暴正则替换兜底。
2. **edit 失败缺乏稳健重试闭环**：c19 三次 old_string 不匹配后滑向危险操作，而非「重新读 → 精确定位」。

这对面试反而是**高价值素材**——能讲清楚「我的 agent 在哪两个边界会翻车，以及我打算怎么修」比只讲成功更有说服力。

**可改进方向（建议，可写进项目 TODO）**：
- `edit_file` 失败后，强制「重新 read 目标区间 → 用更小的锚点片段再 edit」，禁止直接降级到 `run_command` 改源码（或把 run_command 改源码列为高权限需确认）。
- 运行自测失败 N 次后，输出「环境诊断 + 本地运行指引」而非静默结束。
- 给 `compact` 类重构加「重构前后单测/快照比对」，用测试锁住「行为不变」。

---

## 一句话结论
**两个 case 的「核心交付都对」（代码写对了、主重构落地了），但在「摩擦下的鲁棒性」上暴露了真实短板——这正是把项目讲成「有自知之明的工程作品」而不是「demo」的关键切入点。**

## 闭环状态（2026-07-14 已修复）
顺着本报告建议，已在 `src/tools/index.ts` 落地护栏，直接消除这两个短板：

- **`edit_file` 鲁棒匹配**：改用 `fuzzyMatchBlock`（精确 → 换行符 `\r\n` 归一 → 逐行空白归一 三级匹配）替代 `buf.indexOf`，匹配失败给出「请先用 read_file 重新读取最新内容」的明确诊断，不再让 agent 盲目重试或滑向危险操作。
- **`run_command` 源码改写护栏**：新增 `isSourceMutating` 检测，在 `run_command` 执行前拦截「通过命令改写源码」的操作（`node -e` 含文件写、`sed -i`、重定向/tee 写 `.ts/.py` 等、`git checkout --`），返回「安全拦截」并提示改用 `edit_file`。
- **引导文案**：两个工具的 `description` 互指——`edit_file` 标明「修改源码的唯一正确工具」，`run_command` 标明「禁止用本工具改写源码」。

验证：typecheck 零错误；单测 38/38 通过（含 `run_command` 实例级拦截/放行断言）；c19 重跑 PASS，且 transcript 显示 `findstr`/`dir`/`type` 等只读查找命令**未被误伤**——证明护栏精准（只拦改写、不拦查看）。

