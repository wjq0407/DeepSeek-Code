import ts from 'typescript';
import { stat, readFile } from 'node:fs/promises';
import path from 'node:path';

const CODE_EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);

export interface SemanticCheck {
  ok: boolean;
  error?: string;
}

/**
 * 写后语义自检（P0）：工具已成功返回（res.ok === true），但校验「文件是否真的正确落地」。
 *
 * 覆盖 Reflection 的盲区——机械语义层：
 *   - 写错路径：writeFile 看似成功，但磁盘上该路径找不到文件
 *   - 写空文件：内容未真正落盘（size === 0）
 *   - 语法错误：TS/JS 文件存在但无法解析
 *
 * 设计原则：
 *   - 不调用 LLM、不跑 tsc 全量——仅本地 fs + 单文件 transpileModule（语法级，毫秒级）
 *   - 返回 ok:false 时，复用 loop.ts 已有的 P1 渐进 Reflection 机制（!res.ok → 递进诊断）
 *   - 非代码文件（json/md/css/txt 等）只做「存在 + 非空」校验，不判语法
 */
export async function verifyWrittenFile(fp: string, intendedEmpty: boolean): Promise<SemanticCheck> {
  // ① 路径真正落盘？
  let st;
  try {
    st = await stat(fp);
  } catch {
    return { ok: false, error: `文件未落到预期路径（写入看似成功，但磁盘上找不到）: ${fp}` };
  }

  // ② 非空？（intendedEmpty 表示本次本就只写空内容，跳过）
  if (!intendedEmpty && st.size === 0) {
    return { ok: false, error: `写入后文件为空（内容未真正落盘）: ${fp}` };
  }
  if (intendedEmpty) return { ok: true };

  // ③ 仅对代码文件做语法级校验
  const ext = path.extname(fp).toLowerCase();
  if (!CODE_EXT.has(ext)) return { ok: true };

  let code: string;
  try {
    code = await readFile(fp, 'utf8');
  } catch {
    return { ok: true }; // 读不到也不阻塞（stat 已过）
  }
  if (code.trim().length === 0) return { ok: true }; // 纯空白不判语法错

  const isJsx = ext === '.tsx' || ext === '.jsx';
  const compilerOptions: ts.CompilerOptions = {
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ES2020,
    allowJs: true,
  };
  // 注意：TS 5.6 下 transpileModule 不接受 jsx: None（校验会报错），
  // 非 JSX 文件直接省略 jsx 字段即可；仅 .tsx/.jsx 显式开启 ReactJSX。
  if (isJsx) compilerOptions.jsx = ts.JsxEmit.ReactJSX;
  const result = ts.transpileModule(code, {
    compilerOptions,
    reportDiagnostics: true,
  });
  const diags = (result.diagnostics || []).filter(
    (d) => d.category === ts.DiagnosticCategory.Error
  );
  if (diags.length > 0) {
    const first = ts.flattenDiagnosticMessageText(diags[0].messageText, '\n');
    const at = diags[0].start != null ? `（第 ${diags[0].start} 字符附近）` : '';
    return { ok: false, error: `文件存在语法错误${at}: ${first}` };
  }
  return { ok: true };
}
