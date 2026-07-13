/**
 * 轻量嵌入器：把文本变成向量（对标我们聊过的 Embedding 原理）。
 *
 * ⚠️ 重要事实修正（2026-07-11 端到端验证发现）：
 *   DeepSeek **只有 Chat 接口，根本没有 embeddings 端点**（官方文档明确确认：
 *   "DeepSeek's OpenAI-compatible surface is Chat Completions only. There is no
 *   embeddings endpoint."）。因此本项目不依赖任何远程 embedding API。
 *
 * 改用 **本地 BGE 中文模型**（通过 @huggingface/transformers 在进程内跑 ONNX
 * 推理）：离线、免 key、中文语义强，正好契合项目「无 key 优雅降级」的设计哲学。
 *
 * 设计原则：所有失败都优雅降级——
 *   - mode='off' / 模型未下载 / 网络不可达 / 原生依赖缺失 → embed() 返回 null，
 *     调用方据此退化为「仅常驻事实 + 关键词召回」。
 *   - 模型首次使用时懒下载到本地缓存（~110MB，BGE-base-zh），之后完全离线可用。
 *
 * 这正好对应我们讨论的「轻量 RAG 预取」：只在启动时嵌入一次 query，
 * 记忆条目在写入时嵌入一次并缓存，避免每次检索都重算。
 */

const LOCAL_MODEL = 'Xenova/bge-base-zh-v1.5';

export type EmbedMode = 'local' | 'off';

export class Embedder {
  private mode: EmbedMode;
  private extractorPromise: Promise<unknown> | null = null;

  constructor(opts?: { mode?: EmbedMode }) {
    const fromEnv = process.env.EMBEDDING_MODE as EmbedMode | undefined;
    this.mode = opts?.mode ?? fromEnv ?? 'local';
  }

  /** 懒加载 transformers.js 的特征抽取管线（只加载一次）。 */
  private getExtractor(): Promise<unknown> {
    if (!this.extractorPromise) {
      this.extractorPromise = (async () => {
        // 用变量说明符做动态 import：即便依赖未安装也能通过 tsc 类型检查，
        // 运行时若已 npm install 则正常加载。
        const spec = '@huggingface/transformers';
        const mod = (await import(spec)) as {
          pipeline: (task: string, model: string) => Promise<unknown>;
          env: { allowLocalModels: boolean; cacheDir?: string };
        };
        // 仅从 HuggingFace Hub 下载（本地无模型文件），允许离线后复用缓存
        mod.env.allowLocalModels = false;
        return await mod.pipeline('feature-extraction', LOCAL_MODEL);
      })();
    }
    return this.extractorPromise;
  }

  /** 文本 → 向量（长度 768）；失败 / 离线 / 关闭 → 返回 null。 */
  async embed(text: string): Promise<number[] | null> {
    if (this.mode === 'off') return null;
    try {
      const extractor = (await this.getExtractor()) as (
        input: string,
        opts: object,
      ) => Promise<{ data: Float32Array }>;
      const out = await extractor(text, { pooling: 'mean', normalize: true });
      const vec = Array.from(out.data) as number[];
      return vec.length > 0 ? vec : null;
    } catch {
      // 模型未下载 / 网络不可达 / 原生依赖缺失 → 降级关键词召回
      return null;
    }
  }
}
