/**
 * 故事地图（L1）：大纲卡片 + 带类型连线的画布工作区（V6，设计文档 V1.1）。
 *
 * - 节点 = 章节（含规划节点），坐标归一化落库，重启不丢
 * - 连线五类：顺序 / 因果（实线）、分支 / 汇合（虚线）、伏笔回收（青色点线）
 * - 交互：拖拽节点 / 平移画布 / 滚轮缩放 / 从节点右侧圆点拖出连线 /
 *   双击进正文 / 单击连线编辑
 * - 首次进入（所有节点未排布）自动铺主线；「自动布局」整体重建并重铺
 * - 画布是视图不是数据源：所有改动落库后广播 nf:story-updated
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import * as api from '../api';
import { useAppStore } from '../store/appStore';
import { useEditorStore } from '../store/editorStore';
import type { StoryArc, StoryEdge, StoryGraph, StoryNode } from '../types/models';
import { fmt } from '../utils/text';
import { Modal, PromptModal } from './Modal';
import {
  IconFitView,
  IconLink,
  IconPlus,
  IconSparkle,
  IconTrash,
} from './icons';

/** 世界坐标系（画布逻辑尺寸）：归一化坐标 × 世界尺寸 = 世界像素 */
const WORLD_W = 1600;
const WORLD_H = 1000;
const NODE_W = 150;
const NODE_H = 56;
/** 自动布局每行节点数 */
const LAYOUT_COLS = 10;

const NODE_TYPE_NAME: Record<number, string> = {
  1: '事件',
  2: '转折',
  3: '支线',
  4: '结局',
};
const EDGE_TYPE_NAME = ['顺序', '因果', '分支', '汇合', '伏笔回收'];
const ARC_KIND_NAME = ['主线', '支线', '暗线'];
const FORESHADOW_STATUS_NAME = ['活跃', '已回收', '失效'];

/** 弧线缺省调色板（story_arcs.color 为空时按 id 轮转） */
const ARC_PALETTE = ['#5b8def', '#e2b93b', '#b56ad9', '#4fc47f', '#e2734f', '#3bc7d6'];
const arcColor = (arc: StoryArc) => arc.color || ARC_PALETTE[arc.id % ARC_PALETTE.length];

type View = { x: number; y: number; k: number };

/** 未排布节点的缺省位置：按全局章节序蛇形网格 */
function defaultPos(order: number): { x: number; y: number } {
  const row = Math.floor(order / LAYOUT_COLS);
  let col = order % LAYOUT_COLS;
  if (row % 2 === 1) col = LAYOUT_COLS - 1 - col;
  return {
    x: 60 + col * ((WORLD_W - 120 - NODE_W) / (LAYOUT_COLS - 1)),
    y: 70 + row * 110,
  };
}

/** 矩形边框上朝向另一中心的锚点（连线贴边而不穿卡片） */
function anchor(from: DOMRectLike, to: DOMRectLike): { x: number; y: number } {
  const dx = to.cx - from.cx;
  const dy = to.cy - from.cy;
  if (dx === 0 && dy === 0) return { x: from.cx, y: from.cy };
  const hw = NODE_W / 2;
  const hh = NODE_H / 2;
  const sx = dx !== 0 ? hw / Math.abs(dx) : Infinity;
  const sy = dy !== 0 ? hh / Math.abs(dy) : Infinity;
  const t = Math.min(sx, sy);
  return { x: from.cx + dx * t, y: from.cy + dy * t };
}
type DOMRectLike = { cx: number; cy: number };

function truncate(s: string, n: number) {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

export function StoryMap() {
  const setViewMode = useAppStore((s) => s.setViewMode);
  const mapFocusChapterId = useAppStore((s) => s.mapFocusChapterId);
  const clearMapFocus = useAppStore((s) => s.clearMapFocus);
  const selectChapter = useAppStore((s) => s.selectChapter);
  const refreshTree = useAppStore((s) => s.refreshTree);
  const showToast = useAppStore((s) => s.showToast);
  const loadChapter = useEditorStore((s) => s.loadChapter);

  const [graph, setGraph] = useState<StoryGraph | null>(null);
  const [positions, setPositions] = useState<Map<number, { x: number; y: number }>>(new Map());
  const [view, setView] = useState<View>({ x: 0, y: 0, k: 1 });
  const [selectedNode, setSelectedNode] = useState<number | null>(null);
  /** 建连线弹窗 */
  const [pendingEdge, setPendingEdge] = useState<{ from: number; to: number } | null>(null);
  /** 编辑连线弹窗 */
  const [editingEdge, setEditingEdge] = useState<StoryEdge | null>(null);
  /** 新建规划节点弹窗 */
  const [showNewNode, setShowNewNode] = useState(false);
  /** 剧情线管理弹窗 */
  const [showArcs, setShowArcs] = useState(false);
  /** 弧线重命名 */
  const [renameArc, setRenameArc] = useState<StoryArc | null>(null);
  /** 连线拖拽中的临时终点（世界坐标） */
  const [connecting, setConnecting] = useState<{ from: number; x: number; y: number } | null>(null);

  const svgRef = useRef<SVGSVGElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef(view);
  viewRef.current = view;
  const positionsRef = useRef(positions);
  positionsRef.current = positions;
  /** 指针交互状态：pan / node / connect */
  const dragRef = useRef<
    | { kind: 'pan'; sx: number; sy: number; ox: number; oy: number }
    | { kind: 'node'; id: number; dx: number; dy: number; moved: boolean }
    | { kind: 'connect'; from: number }
    | null
  >(null);
  /** 连线临时起点 ref（move 中高频读取） */
  const connectRef = useRef<{ from: number } | null>(null);

  // ---------- 数据加载 ----------

  const loadGraph = useCallback(async (): Promise<StoryGraph | null> => {
    try {
      const g = await api.listStoryGraph();
      setGraph(g);
      const pos = new Map<number, { x: number; y: number }>();
      for (const n of g.nodes) {
        pos.set(
          n.id,
          n.mapX !== null && n.mapY !== null
            ? { x: n.mapX * WORLD_W, y: n.mapY * WORLD_H }
            : defaultPos(n.globalOrder),
        );
      }
      setPositions(pos);
      return g;
    } catch (e) {
      showToast(String(e), 'error');
      return null;
    }
  }, [showToast]);

  const notifyStoryChanged = () => window.dispatchEvent(new Event('nf:story-updated'));

  // 首次挂载：全未排布则自动铺主线（首次进入的半自动布局）
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const g = await loadGraph();
      if (cancelled || !g) return;
      if (g.nodes.length > 0 && g.nodes.every((n) => n.mapX === null)) {
        try {
          await api.autoLayoutStoryMap();
          const g2 = await loadGraph();
          if (g2 && g2.nodes.length > 0) fitView(g2);
        } catch {
          /* 自动布局失败不阻塞浏览 */
        }
      } else if (g.nodes.length > 0) {
        fitView(g);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // InfoPanel / 总览的改动同步回地图
  useEffect(() => {
    const h = () => void loadGraph();
    window.addEventListener('nf:story-updated', h);
    return () => window.removeEventListener('nf:story-updated', h);
  }, [loadGraph]);

  // ---------- 视图控制 ----------

  const fitView = useCallback((g?: StoryGraph | null) => {
    const svg = svgRef.current;
    if (!svg) return;
    const gr = g ?? graph;
    if (!gr || gr.nodes.length === 0) return;
    const pos = positionsRef.current;
    const xs: number[] = [];
    const ys: number[] = [];
    for (const n of gr.nodes) {
      const p = pos.get(n.id);
      if (p) {
        xs.push(p.x);
        ys.push(p.y);
      }
    }
    if (xs.length === 0) return;
    const minX = Math.min(...xs) - 60;
    const maxX = Math.max(...xs) + NODE_W + 60;
    const minY = Math.min(...ys) - 60;
    const maxY = Math.max(...ys) + NODE_H + 60;
    const cw = svg.clientWidth;
    const ch = svg.clientHeight;
    const k = Math.min(cw / (maxX - minX), ch / (maxY - minY), 1.4);
    setView({
      k,
      x: (cw - (maxX - minX) * k) / 2 - minX * k,
      y: (ch - (maxY - minY) * k) / 2 - minY * k,
    });
  }, [graph]);

  const centerOn = useCallback((chapterId: number) => {
    const svg = svgRef.current;
    const p = positionsRef.current.get(chapterId);
    if (!svg || !p) return;
    const k = viewRef.current.k;
    setView({
      k,
      x: svg.clientWidth / 2 - (p.x + NODE_W / 2) * k,
      y: svg.clientHeight / 2 - (p.y + NODE_H / 2) * k,
    });
  }, []);

  // 外部跳转定位（章节发展图 / 总览 → 地图）
  useEffect(() => {
    if (mapFocusChapterId === null) return;
    setSelectedNode(mapFocusChapterId);
    centerOn(mapFocusChapterId);
    clearMapFocus();
  }, [mapFocusChapterId, centerOn, clearMapFocus]);

  // 滚轮缩放（以光标为中心）；React 合成事件是 passive，需原生监听
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = svg.getBoundingClientRect();
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;
      setView((v) => {
        const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
        const k = Math.min(3, Math.max(0.2, v.k * factor));
        const ratio = k / v.k;
        return { k, x: cx - (cx - v.x) * ratio, y: cy - (cy - v.y) * ratio };
      });
    };
    svg.addEventListener('wheel', onWheel, { passive: false });
    return () => svg.removeEventListener('wheel', onWheel);
  }, []);

  // Delete：将选中节点移出地图（连线删除在连线编辑弹窗里做，避免误删）
  useEffect(() => {
    const h = async (e: KeyboardEvent) => {
      if (e.key !== 'Delete' || e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement) return;
      if (selectedNode === null) return;
      const node = graph?.nodes.find((n) => n.id === selectedNode);
      e.preventDefault();
      const ok = window.confirm(
        `将「${node?.title ?? '该节点'}」移出故事地图？\n\n仅清除位置与连线，章节本身保留在目录树中。`,
      );
      if (!ok) return;
      try {
        await api.removeStoryNode(selectedNode);
        setSelectedNode(null);
        await loadGraph();
        notifyStoryChanged();
      } catch (err) {
        showToast(String(err), 'error');
      }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  });

  /** 打开某节点对应的正文（双击卡片） */
  const openChapter = async (id: number) => {
    selectChapter(id);
    await loadChapter(id);
    setViewMode('editor');
  };

  // ---------- 指针交互 ----------

  const toWorld = (clientX: number, clientY: number) => {
    const svg = svgRef.current!;
    const rect = svg.getBoundingClientRect();
    const v = viewRef.current;
    return {
      x: (clientX - rect.left - v.x) / v.k,
      y: (clientY - rect.top - v.y) / v.k,
    };
  };

  const onBackgroundDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    setSelectedNode(null);
    dragRef.current = {
      kind: 'pan',
      sx: e.clientX,
      sy: e.clientY,
      ox: viewRef.current.x,
      oy: viewRef.current.y,
    };
    svgRef.current?.setPointerCapture(e.pointerId);
  };

  const onNodeDown = (e: React.PointerEvent, node: StoryNode) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    setSelectedNode(node.id);
    const w = toWorld(e.clientX, e.clientY);
    const p = positionsRef.current.get(node.id)!;
    dragRef.current = { kind: 'node', id: node.id, dx: w.x - p.x, dy: w.y - p.y, moved: false };
    svgRef.current?.setPointerCapture(e.pointerId);
  };

  /** 从节点右侧圆点拖出连线 */
  const onHandleDown = (e: React.PointerEvent, node: StoryNode) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    dragRef.current = { kind: 'connect', from: node.id };
    connectRef.current = { from: node.id };
    const w = toWorld(e.clientX, e.clientY);
    setConnecting({ from: node.id, x: w.x, y: w.y });
    svgRef.current?.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    if (d.kind === 'pan') {
      setView((v) => ({ ...v, x: d.ox + (e.clientX - d.sx), y: d.oy + (e.clientY - d.sy) }));
    } else if (d.kind === 'node') {
      const w = toWorld(e.clientX, e.clientY);
      d.moved = true;
      setPositions((prev) => {
        const next = new Map(prev);
        next.set(d.id, {
          x: Math.max(0, Math.min(WORLD_W - NODE_W, w.x - d.dx)),
          y: Math.max(0, Math.min(WORLD_H - NODE_H, w.y - d.dy)),
        });
        return next;
      });
    } else if (d.kind === 'connect') {
      const w = toWorld(e.clientX, e.clientY);
      setConnecting((c) => (c ? { ...c, x: w.x, y: w.y } : c));
    }
  };

  const onPointerUp = async (e: React.PointerEvent) => {
    const d = dragRef.current;
    dragRef.current = null;
    if (!d) return;
    if (d.kind === 'node') {
      if (!d.moved) return;
      const p = positionsRef.current.get(d.id);
      if (!p) return;
      try {
        await api.moveStoryNode(d.id, p.x / WORLD_W, p.y / WORLD_H);
        notifyStoryChanged();
      } catch (err) {
        showToast(String(err), 'error');
      }
    } else if (d.kind === 'connect') {
      connectRef.current = null;
      const w = toWorld(e.clientX, e.clientY);
      // 命中测试：落在哪个节点卡片上
      let target: number | null = null;
      for (const [id, p] of positionsRef.current) {
        if (
          id !== d.from &&
          w.x >= p.x &&
          w.x <= p.x + NODE_W &&
          w.y >= p.y &&
          w.y <= p.y + NODE_H
        ) {
          target = id;
          break;
        }
      }
      setConnecting(null);
      if (target !== null) setPendingEdge({ from: d.from, to: target });
    }
  };

  // ---------- 操作 ----------

  const doAutoLayout = async () => {
    const ok = window.confirm(
      '自动布局将按全书章节顺序重新铺排所有节点，并重建顺序连线。\n\n手动拖拽过的位置会被覆盖（因果 / 分支 / 汇合 / 伏笔连线不受影响）。继续？',
    );
    if (!ok) return;
    try {
      await api.autoLayoutStoryMap();
      await loadGraph();
      fitView();
      notifyStoryChanged();
      showToast('已自动布局');
    } catch (e) {
      showToast(String(e), 'error');
    }
  };

  if (!graph) {
    return (
      <div className="story-map">
        <div className="story-map-empty">故事地图加载中…</div>
      </div>
    );
  }

  const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));
  const selected = selectedNode !== null ? nodeById.get(selectedNode) : undefined;

  return (
    <div className="story-map" ref={containerRef}>
      <div className="story-map-toolbar">
        <button className="btn btn-mini" onClick={() => void doAutoLayout()}>
          <IconSparkle /> 自动布局
        </button>
        <button className="btn btn-mini" onClick={() => setShowNewNode(true)}>
          <IconPlus /> 规划节点
        </button>
        <button className="btn btn-mini" onClick={() => setShowArcs(true)}>
          <IconLink /> 剧情线（{graph.arcs.length}）
        </button>
        <div className="story-map-legend">
          <span className="lg lg-seq">顺序</span>
          <span className="lg lg-cause">因果</span>
          <span className="lg lg-branch">分支 / 汇合</span>
          <span className="lg lg-foreshadow">伏笔回收</span>
        </div>
        <div className="story-map-toolbar-right">
          <button className="btn btn-mini" title="适应视图" onClick={() => fitView()}>
            <IconFitView />
          </button>
          <span className="story-map-zoom">{Math.round(view.k * 100)}%</span>
        </div>
      </div>

      <svg
        ref={svgRef}
        className="story-map-canvas"
        onPointerDown={onBackgroundDown}
        onPointerMove={onPointerMove}
        onPointerUp={(e) => void onPointerUp(e)}
        onDoubleClick={(e) => e.target === e.currentTarget && fitView()}
      >
        <defs>
          <pattern id="sm-grid" width="28" height="28" patternUnits="userSpaceOnUse">
            <circle cx="1.2" cy="1.2" r="1.2" fill="var(--border)" />
          </pattern>
          <marker id="sm-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0 0L10 5L0 10z" fill="var(--text-faint)" />
          </marker>
          <marker id="sm-arrow-cause" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0 0L10 5L0 10z" fill="var(--accent)" />
          </marker>
          <marker id="sm-arrow-foreshadow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0 0L10 5L0 10z" fill="var(--sm-foreshadow)" />
          </marker>
        </defs>
        <rect width="100%" height="100%" fill="url(#sm-grid)" />

        <g transform={`translate(${view.x},${view.y}) scale(${view.k})`}>
          {/* 连线层 */}
          {graph.edges.map((e) => {
            const a = positions.get(e.fromNode);
            const b = positions.get(e.toNode);
            if (!a || !b) return null;
            const ra = { cx: a.x + NODE_W / 2, cy: a.y + NODE_H / 2 };
            const rb = { cx: b.x + NODE_W / 2, cy: b.y + NODE_H / 2 };
            const p1 = anchor(ra, rb);
            const p2 = anchor(rb, ra);
            const mx = (p1.x + p2.x) / 2;
            const my = (p1.y + p2.y) / 2;
            const showLabel = e.edgeType === 4 || (e.label && editingEdge?.id === e.id);
            return (
              <g key={e.id} className={`sm-edge et-${e.edgeType}`} data-status={e.status}>
                <line
                  x1={p1.x}
                  y1={p1.y}
                  x2={p2.x}
                  y2={p2.y}
                  className="sm-edge-line"
                  markerEnd={
                    e.edgeType === 1
                      ? 'url(#sm-arrow-cause)'
                      : e.edgeType === 4
                        ? 'url(#sm-arrow-foreshadow)'
                        : 'url(#sm-arrow)'
                  }
                />
                {/* 加宽透明线便于命中 */}
                <line
                  x1={p1.x}
                  y1={p1.y}
                  x2={p2.x}
                  y2={p2.y}
                  className="sm-edge-hit"
                  onPointerDown={(ev) => {
                    ev.stopPropagation();
                    setEditingEdge(e);
                  }}
                />
                {e.status === 1 && e.edgeType === 4 && (
                  <circle cx={mx} cy={my} r="7" className="sm-edge-done-dot" />
                )}
                {showLabel && (
                  <text x={mx} y={my - 8} className="sm-edge-label" textAnchor="middle">
                    {truncate(e.label || EDGE_TYPE_NAME[e.edgeType], 12)}
                  </text>
                )}
              </g>
            );
          })}

          {/* 拖拽中的临时连线 */}
          {connecting && (
            <line
              x1={
                (positions.get(connecting.from)?.x ?? 0) + NODE_W
              }
              y1={
                (positions.get(connecting.from)?.y ?? 0) + NODE_H / 2
              }
              x2={connecting.x}
              y2={connecting.y}
              className="sm-edge-temp"
            />
          )}

          {/* 节点层 */}
          {graph.nodes.map((n) => {
            const p = positions.get(n.id)!;
            const arc = n.arcId !== null ? graph.arcs.find((a) => a.id === n.arcId) : undefined;
            return (
              <g
                key={n.id}
                className={`sm-node${n.nodeType !== 0 ? ' planning' : ''}${selectedNode === n.id ? ' selected' : ''}`}
                transform={`translate(${p.x},${p.y})`}
                onPointerDown={(e) => onNodeDown(e, n)}
                onDoubleClick={(e) => {
                  e.stopPropagation();
                  void openChapter(n.id);
                }}
              >
                <rect
                  className="sm-node-rect"
                  width={NODE_W}
                  height={NODE_H}
                  rx="9"
                  style={arc ? { stroke: arcColor(arc) } : undefined}
                />
                <circle
                  className="sm-node-dot"
                  cx="12"
                  cy={NODE_H / 2}
                  r="3.5"
                  data-status={n.status}
                />
                <text className="sm-node-title" x="24" y="24">
                  {truncate(n.title, 9)}
                </text>
                <text className="sm-node-meta" x="24" y="42">
                  {n.nodeType !== 0 ? `${NODE_TYPE_NAME[n.nodeType]} · ` : ''}
                  {n.wordCount > 0 ? `${fmt(n.wordCount)}字` : nodeById.get(n.id)?.volumeTitle ?? ''}
                </text>
                <text className="sm-node-order" x={NODE_W - 8} y="16" textAnchor="end">
                  {n.globalOrder + 1}
                </text>
                {/* 连线起点圆点 */}
                <circle
                  className="sm-node-handle"
                  cx={NODE_W + 4}
                  cy={NODE_H / 2}
                  r="6"
                  onPointerDown={(e) => onHandleDown(e, n)}
                />
              </g>
            );
          })}
        </g>
      </svg>

      {/* 选中节点详情抽屉 */}
      {selected && (
        <div className="story-map-drawer">
          <div className="drawer-head">
            <span className="drawer-title" title={selected.title}>
              {selected.nodeType !== 0 && (
                <em className="drawer-type">{NODE_TYPE_NAME[selected.nodeType]}</em>
              )}
              {selected.title}
            </span>
            <button className="icon-btn" onClick={() => setSelectedNode(null)}>✕</button>
          </div>
          <div className="drawer-rows">
            <div className="drawer-row">
              <span>卷</span>
              <b>{selected.volumeTitle}</b>
            </div>
            <div className="drawer-row">
              <span>状态</span>
              <b>{selected.status === 1 ? '完稿' : '草稿'}</b>
            </div>
            <div className="drawer-row">
              <span>字数</span>
              <b>{fmt(selected.wordCount)}</b>
            </div>
            <div className="drawer-row">
              <span>所属剧情线</span>
              <select
                className="select"
                value={selected.arcId ?? ''}
                onChange={async (e) => {
                  const v = e.target.value;
                  try {
                    await api.setNodeArc(selected.id, v === '' ? null : Number(v));
                    await loadGraph();
                    notifyStoryChanged();
                  } catch (err) {
                    showToast(String(err), 'error');
                  }
                }}
              >
                <option value="">未分类</option>
                {graph.arcs.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.title}
                  </option>
                ))}
              </select>
            </div>
          </div>
          {selected.summary && <p className="drawer-summary">{selected.summary}</p>}
          <div className="drawer-actions">
            <button className="btn btn-primary btn-mini" onClick={() => void openChapter(selected.id)}>
              编辑正文
            </button>
            <button
              className="btn btn-mini danger"
              onClick={async () => {
                const ok = window.confirm(
                  `将「${selected.title}」移出故事地图？\n\n仅清除位置与连线，章节本身保留在目录树中。`,
                );
                if (!ok) return;
                try {
                  await api.removeStoryNode(selected.id);
                  setSelectedNode(null);
                  await loadGraph();
                  notifyStoryChanged();
                } catch (err) {
                  showToast(String(err), 'error');
                }
              }}
            >
              <IconTrash /> 移出地图
            </button>
          </div>
        </div>
      )}

      {/* 建连线：选类型（伏笔需填内容） */}
      {pendingEdge && (
        <EdgeCreateModal
          from={nodeById.get(pendingEdge.from)!}
          to={nodeById.get(pendingEdge.to)!}
          arcs={graph.arcs}
          onClose={() => setPendingEdge(null)}
          onCreated={async () => {
            setPendingEdge(null);
            await loadGraph();
            notifyStoryChanged();
          }}
        />
      )}

      {/* 编辑连线 */}
      {editingEdge && (
        <EdgeEditModal
          edge={editingEdge}
          arcs={graph.arcs}
          nodeById={nodeById}
          onClose={() => setEditingEdge(null)}
          onChanged={async () => {
            setEditingEdge(null);
            await loadGraph();
            notifyStoryChanged();
          }}
        />
      )}

      {/* 新建规划节点 */}
      {showNewNode && (
        <NewPlanningNodeModal
          onClose={() => setShowNewNode(false)}
          onCreated={async () => {
            setShowNewNode(false);
            await refreshTree();
            await loadGraph();
            notifyStoryChanged();
          }}
        />
      )}

      {/* 剧情线管理 */}
      {showArcs && (
        <Modal title="剧情线管理" onClose={() => setShowArcs(false)} width={480}>
          <ArcManagePanel
            arcs={graph.arcs}
            onChanged={async () => {
              await loadGraph();
              notifyStoryChanged();
            }}
            onRename={(a) => setRenameArc(a)}
          />
        </Modal>
      )}
      {renameArc && (
        <PromptModal
          title="重命名剧情线"
          initial={renameArc.title}
          onCancel={() => setRenameArc(null)}
          onConfirm={async (v) => {
            const title = v.trim();
            setRenameArc(null);
            if (!title || !graph) return;
            try {
              await api.updateStoryArc(renameArc.id, {
                title,
                kind: renameArc.kind,
                color: renameArc.color,
                summary: renameArc.summary,
              });
              await loadGraph();
              notifyStoryChanged();
            } catch (e) {
              showToast(String(e), 'error');
            }
          }}
        />
      )}
    </div>
  );
}

// ---------- 子组件 ----------

const EDGE_CHOICES = [0, 1, 2, 3, 4];

function EdgeCreateModal({
  from,
  to,
  arcs,
  onClose,
  onCreated,
}: {
  from: StoryNode;
  to: StoryNode;
  arcs: StoryArc[];
  onClose: () => void;
  onCreated: () => void | Promise<void>;
}) {
  const showToast = useAppStore((s) => s.showToast);
  const [edgeType, setEdgeType] = useState(1);
  const [label, setLabel] = useState('');
  const [arcId, setArcId] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  const create = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await api.createStoryEdge({
        fromNode: from.id,
        toNode: to.id,
        edgeType,
        arcId,
        label: label.trim(),
      });
      await onCreated();
    } catch (e) {
      showToast(String(e), 'error');
      setBusy(false);
    }
  };

  return (
    <Modal
      title="建立连线"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>取消</button>
          <button className="btn btn-primary" disabled={busy} onClick={() => void create()}>
            创建
          </button>
        </>
      }
    >
      <p className="modal-hint">
        《{truncate(from.title, 10)}》 → 《{truncate(to.title, 10)}》
      </p>
      <div className="edge-type-picker">
        {EDGE_CHOICES.map((t) => (
          <button
            key={t}
            className={`btn btn-mini edge-choice et-${t}${edgeType === t ? ' active' : ''}`}
            onClick={() => setEdgeType(t)}
          >
            {EDGE_TYPE_NAME[t]}
          </button>
        ))}
      </div>
      <span className="field-label">说明{edgeType === 4 ? '（伏笔内容，必填）' : '（可选）'}</span>
      <input
        className="input"
        value={label}
        autoFocus={edgeType === 4}
        onChange={(e) => setLabel(e.target.value)}
        placeholder={edgeType === 4 ? '例如：第 3 章捡到的玉佩' : '例如：这场败仗直接导致…'}
        onKeyDown={(e) => e.key === 'Enter' && void create()}
      />
      <span className="field-label">所属剧情线（可选）</span>
      <select
        className="select"
        value={arcId ?? ''}
        onChange={(e) => setArcId(e.target.value === '' ? null : Number(e.target.value))}
      >
        <option value="">不归属</option>
        {arcs.map((a) => (
          <option key={a.id} value={a.id}>{a.title}</option>
        ))}
      </select>
    </Modal>
  );
}

function EdgeEditModal({
  edge,
  arcs,
  nodeById,
  onClose,
  onChanged,
}: {
  edge: StoryEdge;
  arcs: StoryArc[];
  nodeById: Map<number, StoryNode>;
  onClose: () => void;
  onChanged: () => void | Promise<void>;
}) {
  const showToast = useAppStore((s) => s.showToast);
  const [label, setLabel] = useState(edge.label);
  const [arcId, setArcId] = useState<number | null>(edge.arcId);
  const from = nodeById.get(edge.fromNode);
  const to = nodeById.get(edge.toNode);

  const save = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      await onChanged();
    } catch (e) {
      showToast(String(e), 'error');
    }
  };

  return (
    <Modal
      title={EDGE_TYPE_NAME[edge.edgeType]}
      onClose={onClose}
      footer={
        <>
          <button
            className="btn danger"
            onClick={() => void save(async () => {
              await api.deleteStoryEdge(edge.id);
            })}
          >
            删除连线
          </button>
          <button
            className="btn btn-primary"
            onClick={() =>
              void save(() => api.updateStoryEdge(edge.id, label.trim(), arcId))
            }
          >
            保存
          </button>
        </>
      }
    >
      <p className="modal-hint">
        《{truncate(from?.title ?? '?', 10)}》 → 《{truncate(to?.title ?? '?', 10)}》
      </p>
      <span className="field-label">说明{edge.edgeType === 4 ? '（伏笔内容）' : ''}</span>
      <input className="input" value={label} onChange={(e) => setLabel(e.target.value)} />
      <span className="field-label">所属剧情线</span>
      <select
        className="select"
        value={arcId ?? ''}
        onChange={(e) => setArcId(e.target.value === '' ? null : Number(e.target.value))}
      >
        <option value="">不归属</option>
        {arcs.map((a) => (
          <option key={a.id} value={a.id}>{a.title}</option>
        ))}
      </select>
      {edge.edgeType === 4 && (
        <>
          <span className="field-label">伏笔状态</span>
          <div className="edge-type-picker">
            {[0, 1, 2].map((s) => (
              <button
                key={s}
                className={`btn btn-mini${edge.status === s ? ' active' : ''}`}
                onClick={() => void save(() => api.setForeshadowStatus(edge.id, s))}
              >
                {FORESHADOW_STATUS_NAME[s]}
              </button>
            ))}
          </div>
        </>
      )}
    </Modal>
  );
}

function NewPlanningNodeModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: () => void | Promise<void>;
}) {
  const tree = useAppStore((s) => s.tree)!;
  const showToast = useAppStore((s) => s.showToast);
  const currentVolumeId = useEditorStore((s) => s.volumeId);
  const [title, setTitle] = useState('');
  const [nodeType, setNodeType] = useState(1);
  const [volumeId, setVolumeId] = useState<number>(
    currentVolumeId ?? tree.volumes[tree.volumes.length - 1]?.id ?? 0,
  );
  const [busy, setBusy] = useState(false);

  const create = async () => {
    if (busy || !volumeId) return;
    setBusy(true);
    try {
      await api.createPlanningNode(volumeId, title.trim(), nodeType);
      showToast('规划节点已创建（空章节，不参与导出）');
      await onCreated();
    } catch (e) {
      showToast(String(e), 'error');
      setBusy(false);
    }
  };

  return (
    <Modal
      title="新建规划节点"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>取消</button>
          <button className="btn btn-primary" disabled={busy || !volumeId} onClick={() => void create()}>
            创建
          </button>
        </>
      }
    >
      <span className="field-label">类型</span>
      <div className="edge-type-picker">
        {[1, 2, 3, 4].map((t) => (
          <button
            key={t}
            className={`btn btn-mini${nodeType === t ? ' active' : ''}`}
            onClick={() => setNodeType(t)}
          >
            {NODE_TYPE_NAME[t]}
          </button>
        ))}
      </div>
      <span className="field-label">标题</span>
      <input
        className="input"
        value={title}
        autoFocus
        placeholder="留空则自动编号"
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && void create()}
      />
      <span className="field-label">落入卷（默认当前卷末尾）</span>
      <select
        className="select"
        value={volumeId}
        onChange={(e) => setVolumeId(Number(e.target.value))}
      >
        {tree.volumes.map((v) => (
          <option key={v.id} value={v.id}>{v.title}</option>
        ))}
      </select>
    </Modal>
  );
}

function ArcManagePanel({
  arcs,
  onChanged,
  onRename,
}: {
  arcs: StoryArc[];
  onChanged: () => void | Promise<void>;
  onRename: (a: StoryArc) => void;
}) {
  const showToast = useAppStore((s) => s.showToast);
  const [title, setTitle] = useState('');
  const [kind, setKind] = useState(0);

  const create = async () => {
    if (!title.trim()) return;
    try {
      await api.createStoryArc(title.trim(), kind);
      setTitle('');
      await onChanged();
    } catch (e) {
      showToast(String(e), 'error');
    }
  };

  return (
    <div className="arc-manage">
      <div className="arc-add">
        <input
          className="input"
          placeholder="新剧情线名称，如「暗线·教主之死」"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void create()}
        />
        <select className="select" value={kind} onChange={(e) => setKind(Number(e.target.value))}>
          {ARC_KIND_NAME.map((n, i) => (
            <option key={i} value={i}>{n}</option>
          ))}
        </select>
        <button className="btn btn-primary btn-mini" onClick={() => void create()}>
          <IconPlus /> 新建
        </button>
      </div>
      {arcs.length === 0 && (
        <p className="info-empty">还没有剧情线。建一条主线后，可在节点详情里把章节归入。</p>
      )}
      <ul className="arc-list">
        {arcs.map((a) => (
          <li key={a.id} className="arc-row">
            <span className="arc-swatch" style={{ background: arcColor(a) }} />
            <span className="arc-title" title={a.summary}>{a.title}</span>
            <select
              className="select select-mini"
              value={a.kind}
              onChange={(e) =>
                void (async () => {
                  try {
                    await api.updateStoryArc(a.id, {
                      title: a.title,
                      kind: Number(e.target.value),
                      color: a.color,
                      summary: a.summary,
                    });
                    await onChanged();
                  } catch (err) {
                    showToast(String(err), 'error');
                  }
                })()
              }
            >
              {ARC_KIND_NAME.map((n, i) => (
                <option key={i} value={i}>{n}</option>
              ))}
            </select>
            <button className="icon-btn" title="重命名" onClick={() => onRename(a)}>✎</button>
            <button
              className="icon-btn"
              title="删除（章节与连线保留，仅清归属）"
              onClick={async () => {
                const ok = window.confirm(
                  `删除剧情线「${a.title}」？\n\n章节与连线不受影响，仅清空归属。`,
                );
                if (!ok) return;
                try {
                  await api.deleteStoryArc(a.id);
                  await onChanged();
                } catch (err) {
                  showToast(String(err), 'error');
                }
              }}
            >
              <IconTrash />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
