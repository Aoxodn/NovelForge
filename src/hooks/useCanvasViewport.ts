import { useCallback, useEffect, useRef, useState } from 'react';

export interface CanvasView {
  x: number;
  y: number;
  k: number;
}

export interface Pt {
  x: number;
  y: number;
}

/**
 * 无限画布视口（审查 P2-2 分层）：统一 L1 全书卷图与 L2 卷内章节图的
 * 平移 / 缩放 / 世界坐标换算 / fitBounds，避免两个 2000~3000 行组件各自维护一套。
 *
 * 屏幕→世界：world = (client - view) / k；世界→屏幕：screen = world * k + view。
 *
 * @param svgRef 画布 SVG 引用
 * @param rebindKey 该值变化时重新绑定滚轮缩放（如下钻卷内导致 SVG 重挂载）
 */
export function useCanvasViewport(
  svgRef: React.RefObject<SVGSVGElement | null>,
  rebindKey: unknown = null,
) {
  const [view, setView] = useState<CanvasView>({ x: 0, y: 0, k: 1 });
  const viewRef = useRef(view);
  viewRef.current = view;

  /** 屏幕坐标 → 世界坐标 */
  const toWorld = useCallback((clientX: number, clientY: number): Pt => {
    const svg = svgRef.current;
    const v = viewRef.current;
    if (!svg) return { x: 0, y: 0 };
    const rect = svg.getBoundingClientRect();
    return {
      x: (clientX - rect.left - v.x) / v.k,
      y: (clientY - rect.top - v.y) / v.k,
    };
  }, [svgRef]);

  /** 世界坐标 → 屏幕坐标（相对 SVG 左上） */
  const toScreen = useCallback((wx: number, wy: number): Pt => {
    const v = viewRef.current;
    return { x: wx * v.k + v.x, y: wy * v.k + v.y };
  }, []);

  /** 平移到「起点视图 (ox,oy) + 位移」 */
  const panBy = useCallback((dxClient: number, dyClient: number, ox: number, oy: number) => {
    setView((v) => ({ ...v, x: ox + dxClient, y: oy + dyClient }));
  }, []);

  /** 以屏幕点 (cx,cy) 为中心缩放，factor>1 放大 */
  const zoomAt = useCallback((cx: number, cy: number, factor: number) => {
    setView((v) => {
      const k = Math.min(3, Math.max(0.2, v.k * factor));
      const ratio = k / v.k;
      return { k, x: cx - (cx - v.x) * ratio, y: cy - (cy - v.y) * ratio };
    });
  }, []);

  /** 让世界矩形 [minX,minY]-[maxX,maxY] 完整可见并居中；maxK 限制最大缩放 */
  const fitBounds = useCallback(
    (minX: number, minY: number, maxX: number, maxY: number, maxK = 1.4) => {
      const svg = svgRef.current;
      if (!svg) return;
      const cw = svg.clientWidth;
      const ch = svg.clientHeight;
      const w = Math.max(1, maxX - minX);
      const h = Math.max(1, maxY - minY);
      const k = Math.min(cw / w, ch / h, maxK);
      setView({
        k,
        x: (cw - w * k) / 2 - minX * k,
        y: (ch - h * k) / 2 - minY * k,
      });
    },
    [svgRef],
  );

  // 滚轮缩放（以光标为中心）；rebindKey 变化 / SVG 重挂载时重绑
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = svg.getBoundingClientRect();
      zoomAt(e.clientX - rect.left, e.clientY - rect.top, e.deltaY < 0 ? 1.12 : 1 / 1.12);
    };
    svg.addEventListener('wheel', onWheel, { passive: false });
    return () => svg.removeEventListener('wheel', onWheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [svgRef, zoomAt, rebindKey]);

  return {
    view,
    setView,
    viewRef,
    toWorld,
    toScreen,
    panBy,
    zoomAt,
    fitBounds,
  };
}
