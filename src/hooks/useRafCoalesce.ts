import { useCallback, useEffect, useRef } from 'react';

/**
 * requestAnimationFrame 合帧（审查 P2-1）。
 *
 * pointermove 触发频率远高于屏幕刷新率（一帧内可来十几次），若每次都
 * setState 会导致同一帧重绘全部 SVG 节点。用本 hook 把高频回调合并为
 * 「每帧最多一次」，并始终以最后一次的值为准。
 *
 * const schedule = useRafCoalesce((p: {x:number;y:number}) => applyMove(p.x, p.y));
 * onPointerMove = (e) => schedule({ x: e.clientX, y: e.clientY });
 */
export function useRafCoalesce<T>(fn: (value: T) => void) {
  const rafId = useRef<number | null>(null);
  const latest = useRef<T | null>(null);
  const fnRef = useRef(fn);
  fnRef.current = fn;

  const flush = useCallback(() => {
    rafId.current = null;
    if (latest.current !== null) {
      const v = latest.current;
      latest.current = null;
      fnRef.current(v);
    }
  }, []);

  const schedule = useCallback(
    (value: T) => {
      latest.current = value;
      if (rafId.current !== null) return; // 本帧已排期，等帧回调时取最新值
      rafId.current = requestAnimationFrame(flush);
    },
    [flush],
  );

  useEffect(
    () => () => {
      if (rafId.current !== null) cancelAnimationFrame(rafId.current);
    },
    [],
  );

  return schedule;
}
