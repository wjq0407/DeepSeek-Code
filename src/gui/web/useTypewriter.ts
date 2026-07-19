/**
 * useTypewriter —— 统一「逐字输出」渲染 Hook（网页端）。
 *
 * 设计目标：
 *   - 把所有「流式文本」（助手最终答案气泡、思考盒里的推理/工具结果条目）
 *     以可控速率逐字揭示到页面，而不是等后端把整段累积后一次性塞给 react-markdown。
 *   - 后端无论以「逐 token」还是「大块突发」送达，前端都呈现一致的逐字体验。
 *   - 历史消息 / 已完成文本 / 系统级 reduced-motion 偏好 → 立即完整显示，不做动画
 *     （否则每次切换任务 / 刷新都会重新把历史「打一遍字」，体验灾难）。
 *
 * 与模型实际输出速度同步：
 *   - 缺口（target - shown）为 0 时忙等，等更多文本到达。
 *   - 文本一旦到达即尽可能立即揭示，渲染节奏跟随模型真实生成速度，
 *     而非套用固定速率（避免「模型快于下限时反而拖后腿」的反效果）。
 *   - maxCps 仅作防御上限：防止单条巨块消息一次性闪现导致卡顿；
 *     正常逐 token 流下缺口极小，「已到达即揭示」≈ 与模型速度 1:1。
 */
import { useEffect, useRef, useState } from 'react';

/** 是否开启「减少动态效果」（系统级无障碍偏好）。 */
export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState<boolean>(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return false;
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  });
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onChange = (e: MediaQueryListEvent) => setReduced(e.matches);
    mq.addEventListener?.('change', onChange);
    return () => mq.removeEventListener?.('change', onChange);
  }, []);
  return reduced;
}

interface TypewriterOpts {
  /**
   * 每帧揭示上限（字/秒），纯属防御：防止单条巨块消息一次性闪现导致卡顿。
   * 正常逐 token 流下，缺口（已到达但未揭示的字数）远小于此值，
   * 因此「已到达即立即揭示」≈ 与模型实际输出速度 1:1 同步。
   */
  maxCps?: number;
}

/**
 * 返回「当前应显示的子串」。
 * @param text 目标全文（流式场景会随 update 事件持续增长）
 * @param live 是否仍在流式接收。false（已完成 / 历史）→ 立即完整显示
 */
export function useTypewriter(text: string, live: boolean, opts?: TypewriterOpts): string {
  const reduced = usePrefersReducedMotion();
  const maxCps = opts?.maxCps ?? 6000;

  const [shown, setShown] = useState<number>(() => text.length);
  const shownRef = useRef<number>(text.length);
  const targetRef = useRef<string>(text);
  targetRef.current = text;

  const snap = () => {
    shownRef.current = targetRef.current.length;
    setShown(shownRef.current);
  };

  useEffect(() => {
    // 非 live / 减少动态 → 直接完整显示，不启动动画循环
    if (reduced || !live) {
      snap();
      return;
    }
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = (now - last) / 1000;
      last = now;
      const target = targetRef.current.length;
      const gap = target - shownRef.current;
      if (gap <= 0) {
        raf = requestAnimationFrame(tick);
        return;
      }
      // 与模型速度同步：已到达的字尽可能立即揭示。
      // maxCps 仅作防御上限：正常逐 token 流下缺口（已到达未揭示）远小于此，
      // 因此每帧把「已到达的字」全部揭示 ≈ 模型生成速度 1:1；
      // 仅当某条消息一次带来超大块（罕见）时才按每帧上限平滑追平，避免瞬间闪现卡顿。
      const cap = Math.ceil(maxCps * dt);
      const step = Math.min(cap, gap);
      shownRef.current = Math.min(target, shownRef.current + step);
      setShown(shownRef.current);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // snap 是稳定引用（下方 effect 处理 live=false 时的兜底）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reduced, live, maxCps]);

  // live 由 true→false（流式结束）瞬间：确保完整显示，停止动画
  useEffect(() => {
    if (!live) snap();
  }, [live]);

  // 非流式/历史消息：始终返回完整文本，避免 text 增长后 shown 未同步导致截断
  if (!live) return text;
  const n = Math.min(shown, text.length);
  return text.slice(0, n);
}
