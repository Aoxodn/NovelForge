/**
 * 故事地图（L1，V7 设计文档 V1.1）：卷节点画布。
 *
 * - 节点 = 卷（故事阶段）：卷名 / 阶段序号 / 章数 / 字数 / 完成度 / 细纲摘要
 * - 单击节点 → 右侧抽屉编辑卷细纲（600ms 防抖保存 volumes.summary）
 * - 双击节点 → 下钻卷内视图（VolumeView）
 * - 连线五类：顺序 / 因果（实线）、分支 / 汇合（虚线）、伏笔回收（青色点线）；
 *   两端 = 卷；伏笔可锚定到具体章节（埋设章 / 回收章）
 * - 删除节点 = 删除卷（显式确认，含其下章节与版本，沿用删除卷流程）
 * - 空白处右键 → 新建卷；节点右键 → 编辑细纲 / 进入卷内 / 新建卷 / 删除卷
 * - **自由拖动**：节点松手即停在原地并落库（归一化坐标，重启不丢）；
 *   无坐标的新卷用蛇形网格兜底。「自动布局」= 一键按剧情线分层整理，
 *   整理后仍可继续自由拖动
 * - 滚轮缩放（以光标为中心）/ 空白拖拽平移
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useDurableDraft } from '../hooks/useDurableDraft';
import { useCanvasViewport } from '../hooks/useCanvasViewport';
import { useRafCoalesce } from '../hooks/useRafCoalesce';
import * as api from '../api';
import { useAppStore } from '../store/appStore';
import { useEditorStore } from '../store/editorStore';
import type {
  CharacterBinding,
  CharacterProfile,
  CharacterRelation,
  CharacterVolumePresence,
  StoryArc,
  StoryEdge,
  StoryGraph,
  StoryNode,
} from '../types/models';
import { fmt } from '../utils/text';
import { Modal, PromptModal } from './Modal';
import { ContextMenu } from './ContextMenu';
import { CharacterForm } from './CardsModal';
import { VolumeView } from './VolumeView';
import { CharacterPickModal, RelationCreateModal, RelationEditModal } from './CharacterGraphModals';
import {
  edgeGeometry,
  edgeOffsetPx,
  estimateTextWidth,
  labelFontSize,
  perpComponent,
  quadPoint,
  rectAnchor,
  circleEdgeEndpoints,
  routeEdges,
  REL_CATEGORY_STYLE,
  roleColor,
} from './canvas/routing';
import {
  IconFitView,
  IconLink,
  IconPlus,
  IconSparkle,
  IconTrash,
} from './icons';
import { ShortcutHelp, STORYMAP_SHORTCUTS } from './CanvasChrome';

/** 世界坐标系（画布逻辑尺寸）：落库归一化坐标 × 世界尺寸 = 世界像素 */
const WORLD_W = 1600;
const WORLD_H = 1000;
const NODE_W = 212;
/** v0.9.13 卷节点信息增强（核心人物行 + 事件标签），卡面加高 */
const NODE_H = 148;
/** 自动布局每行节点数（未点过自动布局时的蛇形网格兜底） */
const LAYOUT_COLS = 6;
/** 卷细纲防抖保存间隔 */
const SUMMARY_DEBOUNCE_MS = 600;

const EDGE_TYPE_NAME = ['顺序', '因果', '分支', '汇合', '伏笔回收', '平行叙事', '闪回/插叙'];
const ARC_KIND_NAME = ['主线', '支线', '暗线'];
const FORESHADOW_STATUS_NAME = ['活跃', '已回收', '失效'];
const NODE_TYPE_NAME: Record<number, string> = { 1: '支线卷', 2: '番外' };

/** 弧线缺省调色板（story_arcs.color 为空时按 id 轮转） */
const ARC_PALETTE = ['#5b8def', '#e2b93b', '#b56ad9', '#4fc47f', '#e2734f', '#3bc7d6'];
const arcColor = (arc: StoryArc) => arc.color || ARC_PALETTE[arc.id % ARC_PALETTE.length];

/** 未排布节点的缺省位置：按卷顺序蛇形网格（行距容纳加高后的卡面） */
function defaultPos(order: number): { x: number; y: number } {
  const row = Math.floor(order / LAYOUT_COLS);
  let col = order % LAYOUT_COLS;
  if (row % 2 === 1) col = LAYOUT_COLS - 1 - col;
  return {
    x: 60 + col * ((WORLD_W - 120 - NODE_W) / (LAYOUT_COLS - 1)),
    y: 70 + row * 210,
  };
}

/** 从卷细纲提取关键事件短语（前 2 个 2~8 字短语，无 NLP，纯截取） */
function eventTags(summary: string): string[] {
  return summary
    .split(/[。！？!?;；\n，,·—]+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 2 && s.length <= 8)
    .slice(0, 2);
}

function truncate(s: string, n: number) {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

export function StoryMap() {
  const setViewMode = useAppStore((s) => s.setViewMode);
  const focusCharacter = useAppStore((s) => s.focusCharacter);
  const mapFocusNodeId = useAppStore((s) => s.mapFocusNodeId);
  const clearMapFocus = useAppStore((s) => s.clearMapFocus);
  const refreshTree = useAppStore((s) => s.refreshTree);
  const showToast = useAppStore((s) => s.showToast);

  const [graph, setGraph] = useState<StoryGraph | null>(null);
  /** 下钻中的卷（L2 卷内视图） */
  const [drilledVolumeId, setDrilledVolumeId] = useState<number | null>(null);
  const [positions, setPositions] = useState<Map<number, { x: number; y: number }>>(new Map());
  const [selectedNode, setSelectedNode] = useState<number | null>(null);
  /** 建连线弹窗 */
  const [pendingEdge, setPendingEdge] = useState<{ from: number; to: number } | null>(null);
  /** 编辑连线弹窗 */
  const [editingEdge, setEditingEdge] = useState<StoryEdge | null>(null);
  /** 剧情线管理弹窗 */
  const [showArcs, setShowArcs] = useState(false);
  /** 弧线重命名 */
  const [renameArc, setRenameArc] = useState<StoryArc | null>(null);
  /** 新建卷弹窗 */
  const [showNewVolume, setShowNewVolume] = useState(false);
  /** 新建卷的目标画布位置（归一化 0..1）；null 表示用默认位置 */
  const [pendingVolumePos, setPendingVolumePos] = useState<{ x: number; y: number } | null>(null);
  /** 连线拖拽中的临时终点（世界坐标） */
  const [connecting, setConnecting] = useState<{ from: number; x: number; y: number } | null>(null);
  /** 双击进卷检测：上一次按下的卷节点与时间 */
  const lastClickRef = useRef<{ id: number; t: number } | null>(null);

  // ---------- 人物层（v0.9.13） ----------
  /** 人物 × 卷出场统计（轨迹带 / 核心人物行 / 跨卷人物节点的数据源） */
  const [presence, setPresence] = useState<CharacterVolumePresence[]>([]);
  /** 全部人物关系（L1 只画跨卷关系） */
  const [relations, setRelations] = useState<CharacterRelation[]>([]);
  /** 人物层显隐开关 */
  // 人物轨迹默认折叠为独立图层，选中 / 聚焦某人物时才自动展开（审查 UX-2，降噪）
  const [showCharacters, setShowCharacters] = useState(false);
  /** 人物视角：聚焦的人物 id（null = 全图） */
  const [focusChar, setFocusChar] = useState<number | null>(null);
  /** 已建卡人物（图谱节点来源之一：手动上图谱的人物可能无提及） */
  const [profiles, setProfiles] = useState<CharacterProfile[]>([]);
  /** 人物→卷 手动绑定（关联线） */
  const [bindings, setBindings] = useState<CharacterBinding[]>([]);
  /** L1 图谱坐标乐观值（拖动中；落库后由 profiles 回读） */
  const [charManual, setCharManual] = useState<Map<number, { x: number; y: number }>>(new Map());
  /** 人物节点拉线（建关系 / 绑定卷）临时线 */
  const [charConnecting, setCharConnecting] = useState<{ from: number; x: number; y: number } | null>(null);
  const [pendingRelation, setPendingRelation] = useState<{ from: number; to: number } | null>(null);
  const [editingRelation, setEditingRelation] = useState<CharacterRelation | null>(null);
  const [editingCharProfile, setEditingCharProfile] = useState<CharacterProfile | null>(null);
  /** 添加人物到图谱的目标位置（归一化） */
  const [charPick, setCharPick] = useState<{ x: number; y: number } | null>(null);
  /** 连线手动弧度（拖弯的乐观本地值，松手落库；key = edge id） */
  const [bends, setBends] = useState<Map<number, number>>(new Map());

  const svgRef = useRef<SVGSVGElement | null>(null);
  // 视口（平移/缩放/世界坐标/fitBounds）收敛到共享 hook（审查 P2-2）
  const { view, setView, viewRef, toWorld, fitBounds } =
    useCanvasViewport(svgRef, drilledVolumeId, graph !== null);
  const positionsRef = useRef(positions);
  positionsRef.current = positions;
  /** 指针交互状态：pan / node / connect */
  const dragRef = useRef<
    | { kind: 'pan'; sx: number; sy: number; ox: number; oy: number }
    | { kind: 'node'; id: number; dx: number; dy: number; moved: boolean }
    | { kind: 'connect'; from: number }
    | { kind: 'char'; id: number; dx: number; dy: number; moved: boolean }
    | { kind: 'char-connect'; from: number }
    | {
        kind: 'edge-bend';
        edge: StoryEdge;
        lane: number;
        p0: { x: number; y: number };
        p1: { x: number; y: number };
        startPerp: number;
        startBend: number;
        moved: boolean;
      }
    | null
  >(null);

  // ---------- 数据加载 ----------

  /** forceReset：节点集合不变也强制重置（自动布局后采用新落库坐标） */
  const loadGraph = useCallback(
    async (forceReset = false): Promise<StoryGraph | null> => {
      try {
        const g = await api.listStoryGraph();
        setGraph(g);
        // 位置 = 落库坐标（自由拖动持久化）；无坐标的新卷用蛇形网格兜底
        const pos = new Map<number, { x: number; y: number }>();
        for (const n of g.nodes) {
          pos.set(
            n.id,
            n.mapX !== null && n.mapY !== null
              ? { x: n.mapX * WORLD_W, y: n.mapY * WORLD_H }
              : defaultPos(n.sortOrder),
          );
        }
        const prev = positionsRef.current;
        const sameSet =
          prev.size === pos.size && [...pos.keys()].every((id) => prev.has(id));
        if (forceReset || !sameSet) {
          setPositions(new Map(pos));
          // 同步 ref：紧跟其后的 fitView 不必等 React 重渲染就能拿到新坐标
          positionsRef.current = pos;
        }
        return g;
      } catch (e) {
        showToast(String(e), 'error');
        return null;
      }
    },
    [showToast],
  );

  const notifyStoryChanged = () => window.dispatchEvent(new Event('nf:story-updated'));

  // 首次挂载：从未排布且无连线 → 自动铺主线（建立卷间顺序连线）
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const g = await loadGraph();
      if (cancelled || !g) return;
      if (
        g.nodes.length > 1 &&
        g.edges.length === 0 &&
        g.nodes.every((n) => n.mapX === null)
      ) {
        try {
          await api.autoLayoutStoryMap();
          await loadGraph();
          fitView();
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

  // InfoPanel / 总览 / 卷内视图的改动同步回地图
  useEffect(() => {
    const h = () => void loadGraph();
    window.addEventListener('nf:story-updated', h);
    return () => window.removeEventListener('nf:story-updated', h);
  }, [loadGraph]);

  // 连线弧度本地值跟随数据库（拖弯落库 / 撤销后回读）
  useEffect(() => {
    if (!graph) return;
    setBends((prev) => {
      const next = new Map<number, number>();
      for (const e of graph.edges) next.set(e.id, prev.get(e.id) ?? e.bend);
      return next;
    });
  }, [graph]);

  // 人物层：出场统计 + 人物关系（建卡 / 重建统计 / 关系编辑后刷新）
  useEffect(() => {
    const load = async () => {
      try {
        const [p, r, pr, b] = await Promise.all([
          api.listCharacterVolumePresence(),
          api.listCharacterRelations(),
          api.listCharacters(),
          api.listCharacterBindings(),
        ]);
        setPresence(p);
        setRelations(r);
        setProfiles(pr);
        setBindings(b);
      } catch {
        /* 人物层是增强信息，失败不阻塞地图 */
      }
    };
    void load();
    window.addEventListener('nf:cards-updated', load);
    return () => window.removeEventListener('nf:cards-updated', load);
  }, []);

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
    // 上/下留出人物轨迹带的分道空间，避免边缘人物被裁
    const minX = Math.min(...xs) - 40;
    const maxX = Math.max(...xs) + NODE_W + 40;
    const minY = Math.min(...ys) - 110;
    const maxY = Math.max(...ys) + NODE_H + 90;
    fitBounds(minX, minY, maxX, maxY, 1.4);
  }, [graph, fitBounds]);

  const centerOn = useCallback((volumeId: number) => {
    const svg = svgRef.current;
    const p = positionsRef.current.get(volumeId);
    if (!svg || !p) return;
    const k = viewRef.current.k;
    setView({
      k,
      x: svg.clientWidth / 2 - (p.x + NODE_W / 2) * k,
      y: svg.clientHeight / 2 - (p.y + NODE_H / 2) * k,
    });
  }, []);

  // 聚焦某人物时自动展开人物图层（默认折叠降噪，审查 UX-2）
  useEffect(() => {
    if (focusChar !== null) setShowCharacters(true);
  }, [focusChar]);

  // 外部跳转定位（章节发展图 / 总览 → 地图；目标是卷节点）
  useEffect(() => {
    if (mapFocusNodeId === null) return;
    setSelectedNode(mapFocusNodeId);
    centerOn(mapFocusNodeId);
    clearMapFocus();
  }, [mapFocusNodeId, centerOn, clearMapFocus]);

  // Delete：删除选中卷节点（= 删除卷，显式确认）
  const deleteVolumeNode = useCallback(async (node: StoryNode) => {
    const ok = window.confirm(
      `删除卷「${node.title}」？\n\n该卷的 ${node.chapterCount} 个章节、历史版本与关联连线将一并删除，且不可恢复（不走回收站）。`,
    );
    if (!ok) return;
    try {
      await api.deleteVolume(node.id);
      setSelectedNode(null);
      await refreshTree();
      await loadGraph();
      notifyStoryChanged();
      showToast(`已删除卷「${node.title}」`);
    } catch (e) {
      showToast(String(e), 'error');
    }
  }, [refreshTree, loadGraph, showToast]);

  useEffect(() => {
    const h = async (e: KeyboardEvent) => {
      if (e.key !== 'Delete' || e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement) return;
      if (selectedNode === null || !graph) return;
      const node = graph.nodes.find((n) => n.id === selectedNode);
      if (!node) return;
      e.preventDefault();
      await deleteVolumeNode(node);
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  });

  // ---------- 指针交互 ----------

  const onBackgroundDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    setSelectedNode(null);
    if (focusChar !== null) setFocusChar(null);
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
    // 双击进卷：350ms 内两次按下同一卷节点。不依赖原生 dblclick——
    // WebView2 下节点上的 dblclick 会被指针捕获重定向，React 合成事件收不到
    const now = Date.now();
    const last = lastClickRef.current;
    lastClickRef.current = { id: node.id, t: now };
    if (last && last.id === node.id && now - last.t < 350) {
      lastClickRef.current = null;
      dragRef.current = null;
      setDrilledVolumeId(node.id);
      return;
    }
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
    const w = toWorld(e.clientX, e.clientY);
    setConnecting({ from: node.id, x: w.x, y: w.y });
    svgRef.current?.setPointerCapture(e.pointerId);
  };

  /** 连线按下：拖动 = 调弧度（松手落库），原地点击 = 编辑弹窗 */
  const onEdgePointerDown = (e: React.PointerEvent, edge: StoryEdge, lane: number) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    const a = positionsRef.current.get(edge.fromNode);
    const b = positionsRef.current.get(edge.toNode);
    if (!a || !b) return;
    const p0 = rectAnchor({ x: a.x, y: a.y, w: NODE_W, h: NODE_H }, { x: b.x, y: b.y, w: NODE_W, h: NODE_H });
    const p1 = rectAnchor({ x: b.x, y: b.y, w: NODE_W, h: NODE_H }, { x: a.x, y: a.y, w: NODE_W, h: NODE_H });
    const w = toWorld(e.clientX, e.clientY);
    dragRef.current = {
      kind: 'edge-bend',
      edge,
      lane,
      p0,
      p1,
      startPerp: perpComponent(p0, p1, w),
      startBend: bends.get(edge.id) ?? 0,
      moved: false,
    };
    svgRef.current?.setPointerCapture(e.pointerId);
  };

  /** 人物节点按下：拖动移位（松手落库），原地松开 = 人物视角开关 */
  const onCharDown = (e: React.PointerEvent, node: { characterId: number; x: number; y: number }) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    const w = toWorld(e.clientX, e.clientY);
    dragRef.current = { kind: 'char', id: node.characterId, dx: w.x - node.x, dy: w.y - node.y, moved: false };
    svgRef.current?.setPointerCapture(e.pointerId);
  };

  /** 人物节点圆点拉线：拖到人物=建关系，拖到卷卡=绑定人物→卷 */
  const onCharHandleDown = (e: React.PointerEvent, id: number) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    dragRef.current = { kind: 'char-connect', from: id };
    const w = toWorld(e.clientX, e.clientY);
    setCharConnecting({ from: id, x: w.x, y: w.y });
    svgRef.current?.setPointerCapture(e.pointerId);
  };

  const applyMove = (clientX: number, clientY: number) => {
    const d = dragRef.current;
    if (!d) return;
    if (d.kind === 'pan') {
      setView((v) => ({ ...v, x: d.ox + (clientX - d.sx), y: d.oy + (clientY - d.sy) }));
    } else if (d.kind === 'node') {
      // 自由拖拽：无边界钳制，想到哪就到哪
      const w = toWorld(clientX, clientY);
      d.moved = true;
      setPositions((prev) => {
        const next = new Map(prev);
        next.set(d.id, { x: w.x - d.dx, y: w.y - d.dy });
        return next;
      });
    } else if (d.kind === 'connect') {
      const w = toWorld(clientX, clientY);
      setConnecting((c) => (c ? { ...c, x: w.x, y: w.y } : c));
    } else if (d.kind === 'edge-bend') {
      const w = toWorld(clientX, clientY);
      const delta = perpComponent(d.p0, d.p1, w) - d.startPerp;
      if (Math.abs(delta) > 4) d.moved = true;
      const bend = Math.max(-400, Math.min(400, d.startBend + delta));
      setBends((prev) => {
        const next = new Map(prev);
        next.set(d.edge.id, bend);
        return next;
      });
    } else if (d.kind === 'char') {
      const w = toWorld(clientX, clientY);
      d.moved = true;
      setCharManual((prev) => {
        const next = new Map(prev);
        next.set(d.id, { x: w.x - d.dx, y: w.y - d.dy });
        return next;
      });
    } else if (d.kind === 'char-connect') {
      const w = toWorld(clientX, clientY);
      setCharConnecting((c) => (c ? { ...c, x: w.x, y: w.y } : c));
    }
  };

  // pointermove 高频触发，用 rAF 合帧，每帧最多 setState 一次（审查 P2-1）
  const scheduleMove = useRafCoalesce((pt: { x: number; y: number }) =>
    applyMove(pt.x, pt.y),
  );
  const onPointerMove = (e: React.PointerEvent) => scheduleMove({ x: e.clientX, y: e.clientY });

  const onPointerUp = async (e: React.PointerEvent) => {
    // 释放指针捕获：否则 click/dblclick 的 target 会被重定向到 svg，
    // 导致节点上的双击「进入卷内」永远不触发
    svgRef.current?.releasePointerCapture(e.pointerId);
    const d = dragRef.current;
    dragRef.current = null;
    if (!d) return;
    if (d.kind === 'node') {
      // 自由拖动：松手即停在原地，位置落库（归一化，重启不丢）
      if (!d.moved) return;
      const p = positionsRef.current.get(d.id);
      if (!p) return;
      try {
        await api.moveStoryNode(d.id, p.x / WORLD_W, p.y / WORLD_H);
      } catch (err) {
        showToast(String(err), 'error');
      }
    } else if (d.kind === 'edge-bend') {
      if (!d.moved) {
        // 原地点击 = 编辑连线
        setEditingEdge(d.edge);
        return;
      }
      const bend = bends.get(d.edge.id) ?? 0;
      try {
        await api.setStoryEdgeBend(d.edge.id, Math.round(bend * 10) / 10);
      } catch (err) {
        showToast(String(err), 'error');
      }
    } else if (d.kind === 'connect') {
      const w = toWorld(e.clientX, e.clientY);
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
    } else if (d.kind === 'char') {
      if (!d.moved) {
        setFocusChar((f) => (f === d.id ? null : d.id));
        return;
      }
      const p = charManual.get(d.id);
      if (!p) return;
      try {
        await api.moveCharacterNode(d.id, p.x / WORLD_W, p.y / WORLD_H);
        const pr = await api.listCharacters();
        setProfiles(pr);
      } catch (err) {
        showToast(String(err), 'error');
      }
    } else if (d.kind === 'char-connect') {
      const w = toWorld(e.clientX, e.clientY);
      setCharConnecting(null);
      // 命中判定：人物节点（建关系）优先，其次卷卡（绑定人物→卷）
      let hitChar: number | null = null;
      for (const n of graphNodes) {
        if (n.characterId !== d.from && Math.hypot(w.x - n.x, w.y - n.y) < 18) {
          hitChar = n.characterId;
          break;
        }
      }
      if (hitChar !== null) {
        setPendingRelation({ from: d.from, to: hitChar });
        return;
      }
      let hitVolume: number | null = null;
      for (const [id, p] of positionsRef.current) {
        if (w.x >= p.x && w.x <= p.x + NODE_W && w.y >= p.y && w.y <= p.y + NODE_H) {
          hitVolume = id;
          break;
        }
      }
      if (hitVolume !== null) {
        try {
          await api.createCharacterBinding({ characterId: d.from, volumeId: hitVolume, chapterId: null });
          const b = await api.listCharacterBindings();
          setBindings(b);
          showToast(`已将「${charNameOf(d.from)}」关联到该卷`);
        } catch (err) {
          showToast(String(err), 'error');
        }
      }
    }
  };

  // ---------- 右键菜单 ----------

  const onNodeContextMenu = (e: React.MouseEvent, node: StoryNode) => {
    e.preventDefault();
    e.stopPropagation();
    setSelectedNode(node.id);
    ContextMenu.open(e.clientX, e.clientY, [
      { label: '编辑卷细纲', onClick: () => setSelectedNode(node.id) },
      { label: `进入卷内（${node.chapterCount} 章）`, onClick: () => setDrilledVolumeId(node.id) },
      {
        label: '新建卷',
        onClick: () => {
          // 在当前节点右侧留出一个节点位，作为新卷的生成位置
          const p = positions.get(node.id)!;
          setPendingVolumePos({
            x: (p.x + NODE_W + 40) / WORLD_W,
            y: p.y / WORLD_H,
          });
          setShowNewVolume(true);
        },
      },
      { separator: true, label: '' },
      {
        label: '删除卷…',
        danger: true,
        icon: <IconTrash size={14} />,
        onClick: () => void deleteVolumeNode(node),
      },
    ]);
  };

  const onCharContextMenu = (e: React.MouseEvent, characterId: number) => {
    e.preventDefault();
    e.stopPropagation();
    const profile = profiles.find((p) => p.id === characterId);
    ContextMenu.open(e.clientX, e.clientY, [
      { label: '打开角色卡', onClick: () => focusCharacter(characterId) },
      {
        label: '编辑人物',
        onClick: () => {
          if (profile) setEditingCharProfile(profile);
        },
      },
      {
        label: '从画布移除',
        onClick: async () => {
          try {
            await api.removeCharacterFromCanvas(characterId);
            setCharManual((prev) => {
              const next = new Map(prev);
              next.delete(characterId);
              return next;
            });
            if (focusChar === characterId) setFocusChar(null);
            setProfiles(await api.listCharacters());
            showToast('已从画布移除，可随时重新添加');
          } catch (err) {
            showToast(String(err), 'error');
          }
        },
      },
      {
        label: '删除人物',
        danger: true,
        icon: <IconTrash size={14} />,
        onClick: async () => {
          if (!window.confirm(`确定删除人物「${profile?.name ?? characterId}」？该人物的所有关系、提及记录将一并清除。`)) return;
          try {
            await api.deleteCharacter(characterId);
            setCharManual((prev) => {
              const next = new Map(prev);
              next.delete(characterId);
              return next;
            });
            if (focusChar === characterId) setFocusChar(null);
            setProfiles(await api.listCharacters());
            window.dispatchEvent(new Event('nf:cards-updated'));
            notifyStoryChanged();
          } catch (err) {
            showToast(String(err), 'error');
          }
        },
      },
    ]);
  };

  const onBackgroundContextMenu = (e: React.MouseEvent) => {
    if (e.target !== e.currentTarget && !(e.target instanceof SVGRectElement)) return;
    e.preventDefault();
    const w = toWorld(e.clientX, e.clientY);
    ContextMenu.open(e.clientX, e.clientY, [
      {
        label: '新建卷',
        onClick: () => {
          // 就地生成：以右键点为节点左上角，避免新建后到处找
          setPendingVolumePos({ x: w.x / WORLD_W, y: w.y / WORLD_H });
          setShowNewVolume(true);
        },
      },
      {
        label: '添加人物到图谱…',
        onClick: () => setCharPick({ x: w.x / WORLD_W, y: w.y / WORLD_H }),
      },
    ]);
  };

  // ---------- 操作 ----------

  const doAutoLayout = async () => {
    const ok = window.confirm(
      '按剧情线 / 连线结构一键整理：主线居中一行、支线浮上、暗线沉下，并重建卷间顺序连线。\n\n整理后你仍可自由拖动节点（位置会保留）。因果 / 分支 / 汇合 / 伏笔连线不受影响。继续？',
    );
    if (!ok) return;
    try {
      await api.autoLayoutStoryMap();
      await loadGraph(true);
      fitView();
      notifyStoryChanged();
      showToast('已按剧情线整理');
    } catch (e) {
      showToast(String(e), 'error');
    }
  };

  const createVolume = async (title: string) => {
    const t = title.trim();
    if (!t) return;
    const pos = pendingVolumePos;
    setPendingVolumePos(null);
    try {
      await api.createVolume(t, pos?.x, pos?.y);
      await refreshTree();
      await loadGraph();
      notifyStoryChanged();
      showToast(`已创建卷「${t}」，双击进入卷内添加章节`);
    } catch (e) {
      showToast(String(e), 'error');
    }
  };

  const openChapterInEditor = async (chapterId: number) => {
    const { selectChapter } = useAppStore.getState();
    const ok = await useEditorStore.getState().loadChapter(chapterId);
    if (!ok) return;
    selectChapter(chapterId);
    setViewMode('editor');
  };

  /** 节点索引（卷 id → 节点） */
  const nodeById = useMemo(() => new Map((graph?.nodes ?? []).map((n) => [n.id, n])), [graph]);

  // ---------- 人物层派生（v0.9.13） ----------

  /** 每卷核心人物：按卷聚合提及数，取前 4 */
  const coreCharsByVolume = useMemo(() => {
    const m = new Map<number, CharacterVolumePresence[]>();
    for (const p of presence) {
      const arr = m.get(p.volumeId);
      if (arr) arr.push(p);
      else m.set(p.volumeId, [p]);
    }
    for (const arr of m.values()) arr.sort((a, b) => b.mentionCount - a.mentionCount);
    return m;
  }, [presence]);

  // 图谱坐标乐观值跟随数据库（拖动落库 / 重置后回读）
  useEffect(() => {
    const m = new Map<number, { x: number; y: number }>();
    for (const pr of profiles) {
      if (pr.mapX !== null && pr.mapY !== null) m.set(pr.id, { x: pr.mapX * WORLD_W, y: pr.mapY * WORLD_H });
    }
    setCharManual(m);
  }, [profiles]);

  /** 跨卷核心人物：≥2 卷出场（全部画轨迹带；节点只上提及 Top6，防过载） */
  const crossChars = useMemo(() => {
    const byChar = new Map<number, { info: CharacterVolumePresence; volumes: CharacterVolumePresence[]; total: number }>();
    for (const p of presence) {
      let e = byChar.get(p.characterId);
      if (!e) {
        e = { info: p, volumes: [], total: 0 };
        byChar.set(p.characterId, e);
      }
      e.volumes.push(p);
      e.total += p.mentionCount;
    }
    return [...byChar.values()]
      .filter((e) => e.volumes.length >= 2)
      .map((e) => {
        e.volumes.sort(
          (a, b) =>
            (nodeById.get(a.volumeId)?.sortOrder ?? 0) -
            (nodeById.get(b.volumeId)?.sortOrder ?? 0),
        );
        return e;
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [presence, graph]);


  /** 节点上画布的跨卷人物：按全书总提及取前 6（其余仅保留轨迹带） */
  const coreCross = useMemo(
    () => [...crossChars].sort((a, b) => b.total - a.total).slice(0, 6),
    [crossChars],
  );
  const coreCharIds = useMemo(() => new Set(coreCross.map((e) => e.info.characterId)), [coreCross]);

  /**
   * 轨迹带折线：穿过出场卷中心，按「首卷序→末卷序→姓名」排序纵向分道。
   * 每个人物一条带，人物节点就坐在自己的带上——带即人、点即人。
   */
  const bands = useMemo(() => {
    const n = crossChars.length;
    const spacing = n > 1 ? Math.min(26, 150 / (n - 1)) : 0;
    const sorted = [...crossChars].sort((a, b) => {
      const key = (e: typeof a) => {
        const s0 = nodeById.get(e.volumes[0].volumeId)?.sortOrder ?? 0;
        const s1 = nodeById.get(e.volumes[e.volumes.length - 1].volumeId)?.sortOrder ?? 0;
        return s0 * 1000 + s1;
      };
      return key(a) - key(b) || a.info.name.localeCompare(b.info.name);
    });
    return sorted.flatMap((e, i) => {
      const off = n > 1 ? (i - (n - 1) / 2) * spacing : 0;
      const pts = e.volumes
        .map((v) => positions.get(v.volumeId))
        .filter((p): p is { x: number; y: number } => Boolean(p))
        .map((p) => ({ x: p.x + NODE_W / 2, y: p.y + NODE_H / 2 + off }));
      if (pts.length < 2) return [];
      const d = pts.map((p, j) => `${j === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ');
      return [
        {
          charId: e.info.characterId,
          name: e.info.name,
          color: roleColor(e.info.role),
          d,
          pts,
        },
      ];
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [crossChars, positions, graph]);

  /** 人物节点位置 = 自己轨迹带第一段（首卷→第二次出场卷）的中点，正落在带上 */
  const charPositions = useMemo(() => {
    const pos = new Map<number, { x: number; y: number }>();
    for (const b of bands) {
      if (!coreCharIds.has(b.charId)) continue;
      const [p0, p1] = [b.pts[0], b.pts[1]];
      pos.set(b.charId, { x: (p0.x + p1.x) / 2, y: (p0.y + p1.y) / 2 });
    }
    return pos;
  }, [bands, coreCharIds]);
  /** L1 人物图谱节点：跨卷人物（轨迹带自动定位）∪ 手动上图谱的人物（落库坐标） */
  const graphNodes = useMemo(() => {
    const list: {
      characterId: number;
      name: string;
      role: string;
      x: number;
      y: number;
      volumeCount: number;
    }[] = [];
    const seen = new Set<number>();
    for (const e of crossChars) {
      const auto = charPositions.get(e.info.characterId);
      if (!auto) continue;
      seen.add(e.info.characterId);
      const m = charManual.get(e.info.characterId);
      list.push({
        characterId: e.info.characterId,
        name: e.info.name,
        role: e.info.role,
        x: m ? m.x : auto.x,
        y: m ? m.y : auto.y,
        volumeCount: e.volumes.length,
      });
    }
    for (const pr of profiles) {
      if (seen.has(pr.id)) continue;
      const m =
        charManual.get(pr.id) ??
        (pr.mapX !== null && pr.mapY !== null
          ? { x: pr.mapX * WORLD_W, y: pr.mapY * WORLD_H }
          : undefined);
      if (!m) continue;
      list.push({
        characterId: pr.id,
        name: pr.name,
        role: pr.role,
        x: m.x,
        y: m.y,
        volumeCount: presence.filter((p) => p.characterId === pr.id).length,
      });
    }
    return list;
  }, [crossChars, charPositions, profiles, charManual, presence]);

  const charNameOf = (id: number) =>
    profiles.find((p) => p.id === id)?.name ?? presence.find((p) => p.characterId === id)?.name ?? '?';

  /** 关系作用范围选项：跨卷 + 各卷 */
  const relationScopeOptions = useMemo(
    () => [{ id: null, title: '跨卷（全书）' }],
    [],
  );


  /** L1 人物关系边：图谱上的人物之间的关系（跨卷关系只连跨卷人物，本卷关系不显示） */
  const charRelEdges = useMemo(() => {
    const visible = new Set(graphNodes.map((n) => n.characterId));
    return relations
      .filter((r) => r.volumeId === null && visible.has(r.fromChar) && visible.has(r.toChar))
      .map((r) => ({
        id: r.id,
        from: r.fromChar,
        to: r.toChar,
        kind: 'character' as const,
        edgeType: r.relCategory,
        label: r.relType || r.label || REL_CATEGORY_STYLE[r.relCategory]?.name || '',
        direction: r.direction,
      }));
  }, [relations, graphNodes]);

  /** 每卷活跃伏笔数（edgeType=4 且 status=0，匹配 from/to） */
  const activeForeshadows = useMemo(() => {
    const m = new Map<number, number>();
    for (const e of graph?.edges ?? []) {
      if (e.edgeType !== 4 || e.status !== 0) continue;
      m.set(e.fromNode, (m.get(e.fromNode) ?? 0) + 1);
      if (e.toNode !== e.fromNode) m.set(e.toNode, (m.get(e.toNode) ?? 0) + 1);
    }
    return m;
  }, [graph]);

  /** 人物视角高亮集合：聚焦人物的出场卷 + 直接关系人物 */
  const focusSets = useMemo(() => {
    if (focusChar === null) return null;
    const vols = new Set(
      presence.filter((p) => p.characterId === focusChar).map((p) => p.volumeId),
    );
    const chars = new Set<number>([focusChar]);
    for (const r of relations) {
      if (r.fromChar === focusChar) chars.add(r.toChar);
      if (r.toChar === focusChar) chars.add(r.fromChar);
    }
    return { vols, chars };
  }, [focusChar, presence, relations]);

  /** 人物视角下的透明度：聚焦相关元素 1，其余 0.15 */
  const volOpacity = (id: number) =>
    focusSets ? (focusSets.vols.has(id) ? 1 : 0.15) : 1;
  const charOpacity = (id: number) =>
    focusSets ? (focusSets.chars.has(id) ? 1 : 0.15) : 1;
  const plotEdgeOpacity = (e: StoryEdge) =>
    focusSets ? (focusSets.vols.has(e.fromNode) && focusSets.vols.has(e.toNode) ? 1 : 0.15) : 1;

  // ---------- 边路由：类型分道 + 超量合并（v0.9.13） ----------

  const { routed, overflow } = useMemo(
    () =>
      routeEdges(
        (graph?.edges ?? []).map((e) => ({
          id: e.id,
          from: e.fromNode,
          to: e.toNode,
          kind: 'plot' as const,
          edgeType: e.edgeType,
          label: e.label,
        })),
      ),
    [graph?.edges],
  );
  const routedById = new Map(routed.map((r) => [r.edge.id, r]));
  const overflowKey = (from: number, to: number) =>
    from < to ? `${from}-${to}` : `${to}-${from}`;

  // ---------- 下钻：卷内视图（L2） ----------

  if (drilledVolumeId !== null) {
    return (
      <VolumeView
        key={drilledVolumeId}
        volumeId={drilledVolumeId}
        onBack={() => setDrilledVolumeId(null)}
        onOpenChapter={(id) => void openChapterInEditor(id)}
      />
    );
  }

  if (!graph) {
    return (
      <div className="story-map">
        <div className="story-map-empty">故事地图加载中…</div>
      </div>
    );
  }

  const selected = selectedNode !== null ? nodeById.get(selectedNode) : undefined;
  const hasEdges = graph.edges.length > 0;


  return (
    <div className="story-map">
      <div className="story-map-toolbar">
        <button className="btn btn-mini" onClick={() => void doAutoLayout()}>
          <IconSparkle /> 自动布局
        </button>
        <button
          className="btn btn-mini"
          onClick={() => {
            // 工具栏新建：落在当前视图中心
            const svg = svgRef.current;
            if (svg) {
              const rect = svg.getBoundingClientRect();
              const w = toWorld(rect.left + rect.width / 2, rect.top + rect.height / 2);
              setPendingVolumePos({ x: w.x / WORLD_W, y: w.y / WORLD_H });
            }
            setShowNewVolume(true);
          }}
        >
          <IconPlus /> 新建卷
        </button>
        <button className="btn btn-mini" onClick={() => setShowArcs(true)}>
          <IconLink /> 剧情线（{graph.arcs.length}）
        </button>
        <button
          className={`btn btn-mini${showCharacters ? ' active' : ''}`}
          data-tip="人物图谱：拖动移位 · 圆点拉线建关系 / 关联卷"
          onClick={() => setShowCharacters((v) => !v)}
        >
          👤 人物层
        </button>
        <div className="story-map-legend">
          <span className="lg lg-seq">顺序</span>
          <span className="lg lg-cause">因果</span>
          <span className="lg lg-branch">分支 / 汇合</span>
          <span className="lg lg-foreshadow">伏笔回收</span>
          <span className="lg lg-parallel">平行</span>
          <span className="lg lg-flashback">闪回</span>
        </div>
        <div className="story-map-toolbar-right">
          <span className="canvas-axis-hint" data-tip="横轴＝故事时间/章节顺序，纵轴＝剧情线泳道">
            横轴时间 · 纵轴剧情线
          </span>
          <button className="btn btn-mini" data-tip="适应视图" onClick={() => fitView()}>
            <IconFitView />
          </button>
          <span className="story-map-zoom">{Math.round(view.k * 100)}%</span>
          <ShortcutHelp shortcuts={STORYMAP_SHORTCUTS} title="全书故事图谱 · 操作" />
        </div>
      </div>

      {graph.nodes.length === 0 ? (
        <div className="story-map-empty">
          <p>还没有卷。</p>
          <button
            className="btn btn-primary"
            onClick={() => {
              const svg = svgRef.current;
              if (svg) {
                const rect = svg.getBoundingClientRect();
                const w = toWorld(rect.left + rect.width / 2, rect.top + rect.height / 2);
                setPendingVolumePos({ x: w.x / WORLD_W, y: w.y / WORLD_H });
              }
              setShowNewVolume(true);
            }}
          >
            <IconPlus /> 从新建第一卷开始
          </button>
        </div>
      ) : (
        <svg
          ref={svgRef}
          className="story-map-canvas"
          onPointerDown={onBackgroundDown}
          onPointerMove={onPointerMove}
          onPointerUp={(e) => void onPointerUp(e)}
          onDoubleClick={(e) => e.target === e.currentTarget && fitView()}
          onContextMenu={onBackgroundContextMenu}
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
            {/* 轨迹带层：跨卷人物的出场轨迹（最底层，压在连线和节点之下） */}
            {showCharacters &&
              bands.map((b) => (
                <path
                  key={`band-${b.charId}`}
                  d={b.d}
                  fill="none"
                  stroke={b.color}
                  strokeWidth={3}
                  opacity={focusChar === null ? 0.25 : focusChar === b.charId ? 0.55 : 0.06}
                  pointerEvents="none"
                >
                  <title>{`${b.name} 的出场轨迹`}</title>
                </path>
              ))}

            {/* 人物→卷 手动绑定关联线（细虚线） */}
            {showCharacters &&
              bindings.map((b) => {
                const n = graphNodes.find((g) => g.characterId === b.characterId);
                const vp = b.volumeId !== null ? positions.get(b.volumeId) : undefined;
                if (!n || !vp) return null;
                const a = rectAnchor({ x: n.x - 11, y: n.y - 11, w: 22, h: 22 }, { x: vp.x, y: vp.y, w: NODE_W, h: NODE_H });
                const c = rectAnchor({ x: vp.x, y: vp.y, w: NODE_W, h: NODE_H }, { x: n.x - 11, y: n.y - 11, w: 22, h: 22 });
                return (
                  <line
                    key={`bind-${b.id}`}
                    x1={a.x}
                    y1={a.y}
                    x2={c.x}
                    y2={c.y}
                    stroke={roleColor(n.role)}
                    strokeWidth={1.4}
                    strokeDasharray='3 4'
                    opacity={focusSets ? (focusSets.chars.has(b.characterId) && b.volumeId !== null && focusSets.vols.has(b.volumeId) ? 0.9 : 0.08) : 0.45}
                    pointerEvents='none'
                  >
                    <title>{`${charNameOf(b.characterId)} 手动关联到此卷`}</title>
                  </line>
                );
              })}

            {/* 连线层：类型分道 + 标签嵌线（中点断开，文字即线） */}
            {graph.edges.map((e) => {
              const r = routedById.get(e.id);
              const a = positions.get(e.fromNode);
              const b = positions.get(e.toNode);
              if (!r || !a || !b) return null;
              const ra = { x: a.x, y: a.y, w: NODE_W, h: NODE_H };
              const rb = { x: b.x, y: b.y, w: NODE_W, h: NODE_H };
              const p1 = rectAnchor(ra, rb);
              const p2 = rectAnchor(rb, ra);
              const arcStyled = e.edgeType !== 0;
              // 标签：因果/分支/汇合/伏笔/平行/闪回显示；顺序边语义自明
              const labelText =
                e.edgeType === 0 ? '' : truncate(e.label || EDGE_TYPE_NAME[e.edgeType], 12);
              const labelFs = labelFontSize(10.5, view.k);
              const len = Math.hypot(p2.x - p1.x, p2.y - p1.y);
              const geo = edgeGeometry(
                p1,
                p2,
                edgeOffsetPx(len, r.lane, bends.get(e.id) ?? 0),
                labelText ? estimateTextWidth(labelText, labelFs) + 16 : 0,
              );
              const dParts = geo.segA && geo.segB ? [geo.segA, geo.segB] : [geo.d];
              // 徽标与拖弯手柄避开中点标签：徽标 t=0.2、手柄 t=0.75
              const badgePos = quadPoint(p1, geo.ctrl, p2, 0.2);
              const bendDotPos = quadPoint(p1, geo.ctrl, p2, 0.75);
              const edgeArc = e.arcId !== null ? graph.arcs.find((ar) => ar.id === e.arcId) : undefined;
              const eArcColor = edgeArc ? edgeArc.color || ARC_PALETTE[edgeArc.id % ARC_PALETTE.length] : null;
              const labelColor =
                eArcColor ??
                (e.edgeType === 4
                  ? 'var(--sm-foreshadow)'
                  : e.edgeType === 2 || e.edgeType === 3
                    ? 'var(--sm-branch)'
                    : e.edgeType === 5
                      ? 'var(--sm-parallel)'
                      : e.edgeType === 6
                        ? 'var(--sm-flashback)'
                        : e.edgeType === 0
                          ? 'var(--text-dim)'
                          : 'var(--accent)');
              return (
                <g
                  key={e.id}
                  className={`sm-edge et-${e.edgeType}${edgeArc ? ' has-arc' : ''}${editingEdge?.id === e.id ? ' focused' : ''}`}
                  data-status={e.status}
                  opacity={plotEdgeOpacity(e)}
                >
                  {dParts.map((d, i) => (
                    <path
                      key={i}
                      d={d}
                      fill="none"
                      className="sm-edge-line"
                      style={eArcColor ? { stroke: eArcColor } : undefined}
                      markerEnd={
                        i === dParts.length - 1
                          ? e.edgeType === 1
                            ? 'url(#sm-arrow-cause)'
                            : e.edgeType === 4
                              ? 'url(#sm-arrow-foreshadow)'
                              : 'url(#sm-arrow)'
                          : undefined
                      }
                    />
                  ))}
                  {/* 加宽透明线便于命中：拖动调弧度 / 原地点击编辑 */}
                  <path
                    d={geo.d}
                    fill="none"
                    className="sm-edge-hit"
                    onPointerDown={(ev) => onEdgePointerDown(ev, e, r.lane)}
                  />
                  {/* 拖弯手柄：悬停连线时浮现小圆点（避开中点标签） */}
                  <circle cx={bendDotPos.x} cy={bendDotPos.y} r="5" className="sm-edge-bend-dot" />
                  {edgeArc && eArcColor && (
                    <circle
                      cx={badgePos.x}
                      cy={badgePos.y}
                      r="5.5"
                      className="sm-edge-arc-badge"
                      style={{ stroke: eArcColor }}
                    >
                      <title>{`剧情线：${edgeArc.title}`}</title>
                    </circle>
                  )}
                  {e.status === 1 && e.edgeType === 4 && (
                    <circle cx={badgePos.x} cy={badgePos.y} r="7" className="sm-edge-done-dot" />
                  )}
                  {labelText && (
                    <text
                      x={geo.label.x}
                      y={geo.label.y}
                      className="sm-edge-label"
                      textAnchor="middle"
                      dominantBaseline="central"
                      style={{
                        fill: arcStyled ? labelColor : 'var(--text-dim)',
                        paintOrder: 'stroke',
                        stroke: 'var(--bg)',
                        strokeWidth: 4 * (labelFs / 10.5),
                        fontSize: labelFs,
                      }}
                    >
                      {labelText}
                    </text>
                  )}
                </g>
              );
            })}

            {/* 超量合并徽标：同对卷 >4 条边时溢出部分收进 +N */}
            {overflow.map((o) => {
              const b = positions.get(o.to);
              if (!b) return null;
              return (
                <g
                  key={`ovf-${overflowKey(o.from, o.to)}`}
                  className="sm-overflow-badge"
                  transform={`translate(${b.x + NODE_W - 16},${b.y - 12})`}
                  onPointerDown={(ev) => {
                    ev.stopPropagation();
                    ContextMenu.open(
                      ev.clientX,
                      ev.clientY,
                      o.hidden.map((he) => ({
                        label: `${EDGE_TYPE_NAME[he.edgeType]}：${truncate(he.label || '（无说明）', 16)}`,
                        onClick: () => {
                          const full = graph.edges.find((x) => x.id === he.id);
                          if (full) setEditingEdge(full);
                        },
                      })),
                    );
                  }}
                >
                  <circle r="9" />
                  <text textAnchor="middle" dy="3.5">{`+${o.count}`}</text>
                  <title>{`还有 ${o.count} 条连线，点击展开`}</title>
                </g>
              );
            })}

            {/* 人物关系边层：跨卷人物之间的跨卷关系（独立偏移空间） */}
            {showCharacters &&
              (() => {
                const { routed: relRouted } = routeEdges(charRelEdges);
                return relRouted.map(({ edge: re, lane }) => {
                  // 优先用轨迹带自动定位坐标，没有则 fallback 到 graphNodes 中的手动坐标
                  const ca = charPositions.get(re.from)
                    ?? (() => { const g = graphNodes.find((n) => n.characterId === re.from); return g ? { x: g.x, y: g.y } : undefined; })();
                  const cb = charPositions.get(re.to)
                    ?? (() => { const g = graphNodes.find((n) => n.characterId === re.to); return g ? { x: g.x, y: g.y } : undefined; })();
                  if (!ca || !cb) return null;
                  const style = REL_CATEGORY_STYLE[re.edgeType] ?? REL_CATEGORY_STYLE[3];
                  const { p0: p1, p1: p2, offset } = circleEdgeEndpoints(
                    ca.x, ca.y, 15,
                    cb.x, cb.y, 15,
                    lane,
                  );
                  const relDisp = truncate(re.label, 8);
                  const relFs = labelFontSize(9.5, view.k);
                  const geo = edgeGeometry(
                    p1,
                    p2,
                    offset,
                    relDisp ? estimateTextWidth(relDisp, relFs) + 12 : 0,
                  );
                  const relParts = geo.segA && geo.segB ? [geo.segA, geo.segB] : [geo.d];
                  const dimmed =
                    focusSets !== null &&
                    !(focusSets.chars.has(re.from) && focusSets.chars.has(re.to));
                  return (
                    <g key={`rel-${re.id}`} opacity={dimmed ? 0.1 : 1}>
                      {relParts.map((d, i) => (
                        <path
                          key={i}
                          d={d}
                          fill="none"
                          stroke={style.color}
                          strokeWidth={1.8}
                          strokeDasharray={style.dash ?? (re.direction === 1 ? 'none' : 'none')}
                          markerEnd={i === relParts.length - 1 && re.direction === 1 ? 'url(#sm-arrow)' : undefined}
                        />
                      ))}
                      <path
                        d={geo.d}
                        fill="none"
                        className="sm-edge-hit"
                        onPointerDown={(ev) => {
                          ev.stopPropagation();
                          const full = relations.find((r) => r.id === re.id);
                          if (full) setEditingRelation(full);
                        }}
                      />
                      <text
                        x={geo.label.x}
                        y={geo.label.y}
                        textAnchor="middle"
                        dominantBaseline="central"
                        className="sm-rel-label"
                        style={{
                          fill: style.color,
                          paintOrder: 'stroke',
                          stroke: 'var(--bg)',
                          strokeWidth: 4 * (relFs / 9.5),
                          fontSize: relFs,
                        }}
                      >
                        {relDisp}
                      </text>
                    </g>
                  );
                });
              })()}

            {/* 人物拉线中的临时线 */}
            {charConnecting && (
              <line
                x1={graphNodes.find((n) => n.characterId === charConnecting.from)?.x ?? 0}
                y1={graphNodes.find((n) => n.characterId === charConnecting.from)?.y ?? 0}
                x2={charConnecting.x}
                y2={charConnecting.y}
                stroke={roleColor('主角')}
                strokeWidth={1.8}
                strokeDasharray='5 4'
                pointerEvents='none'
              />
            )}

            {/* 拖拽中的临时连线 */}
            {connecting && (
              <line
                x1={(positions.get(connecting.from)?.x ?? 0) + NODE_W}
                y1={(positions.get(connecting.from)?.y ?? 0) + NODE_H / 2}
                x2={connecting.x}
                y2={connecting.y}
                className="sm-edge-temp"
              />
            )}

            {/* 节点层（卷） */}
            {graph.nodes.map((n) => {
              const p = positions.get(n.id)!;
              const donePct = n.chapterCount > 0 ? n.doneChapters / n.chapterCount : 0;
              const cores = (coreCharsByVolume.get(n.id) ?? []).slice(0, 4);
              const foreshadowCount = activeForeshadows.get(n.id) ?? 0;
              const tags = eventTags(n.summary);
              return (
                <g
                  key={n.id}
                  className={`sm-node sm-volume-node${selectedNode === n.id ? ' selected' : ''}`}
                  transform={`translate(${p.x},${p.y})`}
                  opacity={volOpacity(n.id)}
                  onPointerDown={(e) => onNodeDown(e, n)}
                  onDoubleClick={(e) => {
                    e.stopPropagation();
                    setDrilledVolumeId(n.id);
                  }}
                  onContextMenu={(e) => onNodeContextMenu(e, n)}
                >
                  <rect className="sm-node-rect" width={NODE_W} height={NODE_H} rx="10" />
                  <text className="sm-node-stage" x="14" y="22">
                    阶段 {n.sortOrder + 1}
                    {n.nodeType !== 0 && ` · ${NODE_TYPE_NAME[n.nodeType] ?? ''}`}
                  </text>
                  {/* 活跃伏笔徽标 */}
                  {foreshadowCount > 0 && (
                    <g className="sm-node-foreshadow" transform={`translate(${NODE_W - 14},16)`}>
                      <circle r="4" className="sm-node-foreshadow-dot" />
                      <text textAnchor="end" x="-7" dy="3.5" className="sm-node-foreshadow-num">
                        {foreshadowCount} 伏笔
                      </text>
                      <title>{`${foreshadowCount} 个活跃伏笔与本卷相关`}</title>
                    </g>
                  )}
                  <text className="sm-node-title" x="14" y="44">
                    {truncate(n.title, 11)}
                  </text>
                  <text className="sm-node-meta" x="14" y="61">
                    {n.doneChapters}/{n.chapterCount} 章 · {fmt(n.wordCount)} 字
                  </text>
                  {/* 完成度条 */}
                  <rect className="sm-node-progress-bg" x="14" y="69" width={NODE_W - 28} height="4" rx="2" />
                  <rect
                    className="sm-node-progress"
                    x="14"
                    y="69"
                    width={Math.max(2, (NODE_W - 28) * donePct)}
                    height="4"
                    rx="2"
                  />
                  {/* 核心人物行：本卷提及 Top4 */}
                  {showCharacters &&
                    cores.map((c, i) => (
                      <g key={c.characterId} transform={`translate(${18 + i * 48},92)`}>
                        <circle r="6" fill={roleColor(c.role)} opacity={0.85} />
                        <text y="18" textAnchor="middle" className="sm-node-charname">
                          {truncate(c.name, 4)}
                        </text>
                        <title>{`${c.name}（${c.role || '未设定'}）· 本卷提及 ${c.mentionCount} 次`}</title>
                      </g>
                    ))}
                  {/* 关键事件标签（卷细纲短语截取） */}
                  {tags.length > 0 && (
                    <text className="sm-node-events" x="14" y={NODE_H - 10}>
                      {tags.map((t) => `── ${t}`).join('  ')}
                    </text>
                  )}
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

            {/* 人物节点层：跨卷核心人物（≥2 卷出场），圆形 */}
            {showCharacters &&
              graphNodes.map((n) => {
                const isFocus = focusChar === n.characterId;
                return (
                  <g
                    key={`char-${n.characterId}`}
                    className={`sm-char-node${isFocus ? ' focus' : ''}`}
                    transform={`translate(${n.x},${n.y})`}
                    opacity={charOpacity(n.characterId)}
                    onPointerDown={(ev) => onCharDown(ev, n)}
                    onContextMenu={(e) => onCharContextMenu(e, n.characterId)}
                  >
                    <circle r="9" className="sm-char-halo" style={{ stroke: roleColor(n.role) }} />
                    <circle r="7" className="sm-char-body" style={{ fill: roleColor(n.role) }} />
                    <text textAnchor="middle" y="20" className="sm-char-name sm-char-name-full">
                      {n.name}
                    </text>
                    {/* 拉线圆点：拖到人物建关系，拖到卷卡绑定 */}
                    <circle
                      className="sm-node-handle vc-char-handle"
                      cx="15"
                      cy="-11"
                      r="4.5"
                      onPointerDown={(ev) => onCharHandleDown(ev, n.characterId)}
                    />
                    <title>
                      {`${n.name}（${n.role || '未设定'}）\n${n.volumeCount > 0 ? `跨 ${n.volumeCount} 卷出场（连线为出场轨迹）\n` : ''}拖动移位；圆点拉线：到人物=建关系，到卷卡=关联`}
                    </title>
                  </g>
                );
              })}
          </g>
        </svg>
      )}

      {/* 人物视角提示条 */}
      {focusChar !== null && (
        <div className="story-map-focusbar">
          人物视角：
          {charNameOf(focusChar)}
          <button className="btn btn-mini" onClick={() => setFocusChar(null)}>
            退出
          </button>
        </div>
      )}

      {graph.nodes.length > 0 && !hasEdges && (
        <div className="story-map-hint">
          拖拽节点右侧圆点到另一卷，标记阶段推进（顺序 / 因果）或伏笔回收。
        </div>
      )}

      {/* 选中节点详情抽屉：卷细纲编辑 */}
      {selected && (
        <VolumeDrawer
          key={selected.id}
          node={selected}
          onClose={() => setSelectedNode(null)}
          onEnterVolume={() => setDrilledVolumeId(selected.id)}
          onDelete={() => void deleteVolumeNode(selected)}
        />
      )}

      {/* 建连线：选类型（伏笔需填内容 + 可选章级锚点） */}
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

      {/* 新建卷 */}
      {showNewVolume && (
        <PromptModal
          title="新建卷（故事阶段）"
          placeholder="卷名，如：第一卷 · 初入江湖"
          confirmText="创建"
          onCancel={() => setShowNewVolume(false)}
          onConfirm={(v) => {
            setShowNewVolume(false);
            void createVolume(v);
          }}
        />
      )}

      {/* 建人物关系（画布拉线） */}
      {pendingRelation && (
        <RelationCreateModal
          fromChar={pendingRelation.from}
          toChar={pendingRelation.to}
          fromName={charNameOf(pendingRelation.from)}
          toName={charNameOf(pendingRelation.to)}
          defaultScope={null}
          scopeOptions={relationScopeOptions}
          onClose={() => setPendingRelation(null)}
          onCreated={async () => {
            setPendingRelation(null);
            setRelations(await api.listCharacterRelations());
          }}
        />
      )}

      {/* 编辑人物关系（点击关系边） */}
      {editingRelation && (
        <RelationEditModal
          relation={editingRelation}
          nameById={new Map(graphNodes.map((n) => [n.characterId, n.name]))}
          scopeOptions={relationScopeOptions}
          onClose={() => setEditingRelation(null)}
          onChanged={async () => {
            setEditingRelation(null);
            setRelations(await api.listCharacterRelations());
          }}
        />
      )}

      {/* 编辑人物（右键角色节点 → 编辑人物） */}
      {editingCharProfile && (
        <Modal title={`编辑人物：${editingCharProfile.name}`} onClose={() => setEditingCharProfile(null)} width={420}>
          <CharacterForm
            initial={editingCharProfile}
            busy={false}
            onCancel={() => setEditingCharProfile(null)}
            onSubmit={async (v) => {
              try {
                await api.updateCharacter(editingCharProfile.id, v);
                setEditingCharProfile(null);
                setProfiles(await api.listCharacters());
                notifyStoryChanged();
              } catch (err) {
                showToast(String(err), 'error');
              }
            }}
          />
        </Modal>
      )}

      {/* 添加人物到图谱 */}
      {charPick && (
        <CharacterPickModal
          profiles={profiles}
          usedIds={new Set(graphNodes.map((n) => n.characterId))}
          title='添加人物到图谱'
          onClose={() => setCharPick(null)}
          onPick={async (p) => {
            try {
              await api.moveCharacterNode(p.id, charPick.x, charPick.y);
              setCharPick(null);
              setShowCharacters(true);
              setProfiles(await api.listCharacters());
              showToast(`已将「${p.name}」放上图谱，可自由拖动`);
            } catch (e) {
              showToast(String(e), 'error');
            }
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

/** 卷节点抽屉：卷细纲编辑（600ms 防抖保存）+ 统计 + 操作 */
function VolumeDrawer({
  node,
  onClose,
  onEnterVolume,
  onDelete,
}: {
  node: StoryNode;
  onClose: () => void;
  onEnterVolume: () => void;
  onDelete: () => void;
}) {
  const { draft: sDraft, setDraft: setSDraft, error: sError } = useDurableDraft<{ summary: string }>(
    node.id,
    { summary: node.summary },
    async (id, d) => {
      await api.setVolumeSummary(id, d.summary);
      window.dispatchEvent(new Event('nf:story-updated'));
    },
    SUMMARY_DEBOUNCE_MS,
  );
  const summary = sDraft.summary;

  const donePct = node.chapterCount > 0 ? Math.round((node.doneChapters / node.chapterCount) * 100) : 0;

  return (
    <div className="story-map-drawer">
      <div className="drawer-head">
        <span className="drawer-title" title={node.title}>
          {node.title}
        </span>
        <button className="icon-btn" data-tip="关闭" onClick={onClose}>✕</button>
      </div>
      <div className="drawer-rows">
        <div className="drawer-row">
          <span>阶段</span>
          <b>第 {node.sortOrder + 1} 卷</b>
        </div>
        <div className="drawer-row">
          <span>章节</span>
          <b>{node.chapterCount} 章 · 完稿 {node.doneChapters}（{donePct}%）</b>
        </div>
        <div className="drawer-row">
          <span>字数</span>
          <b>{fmt(node.wordCount)}</b>
        </div>
      </div>
      <span className="field-label">卷细纲（本卷目标 / 冲突 / 钩子，自动保存）</span>
      <textarea
        className="input drawer-summary-input"
        value={summary}
        rows={7}
        placeholder="这一卷写什么？主角目标、核心冲突、结尾钩子……"
        onChange={(e) => setSDraft({ summary: e.target.value })}
      />
      {sError && <div className="draft-error-line">卷细纲保存失败：{sError}</div>}
      <div className="drawer-actions">
        <button className="btn btn-primary btn-mini" onClick={onEnterVolume}>
          进入卷内
        </button>
        <button className="btn btn-mini danger" onClick={onDelete}>
          <IconTrash /> 删除卷
        </button>
      </div>
    </div>
  );
}

const EDGE_CHOICES = [0, 1, 2, 3, 4, 5, 6];

/** 建连线弹窗：类型选择；伏笔填内容 + 可选章级锚点（章列表来自目录树） */
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
  const tree = useAppStore((s) => s.tree)!;
  const [edgeType, setEdgeType] = useState(1);
  const [label, setLabel] = useState('');
  const [arcId, setArcId] = useState<number | null>(null);
  const [fromChapterId, setFromChapterId] = useState<number | null>(null);
  const [toChapterId, setToChapterId] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  const chaptersOf = (volumeId: number) =>
    tree.chapters.filter((c) => c.volumeId === volumeId);
  const fromChapters = chaptersOf(from.id);
  const toChapters = chaptersOf(to.id);
  const sameVolume = from.id === to.id;

  const create = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await api.createStoryEdge({
        fromNode: from.id,
        toNode: to.id,
        edgeType,
        arcId,
        // 伏笔才带章级锚点；同卷伏笔要求两端锚点齐全（后端校验）
        fromChapterId: edgeType === 4 ? fromChapterId : null,
        toChapterId: edgeType === 4 ? toChapterId : null,
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
        {sameVolume ? `卷内伏笔：《${truncate(from.title, 10)}》` : `《${truncate(from.title, 10)}》 → 《${truncate(to.title, 10)}》`}
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
        onKeyDown={(e) => e.key === 'Enter' && void create()}
        placeholder={edgeType === 4 ? '例如：捡到的玉佩暗藏身世之谜' : '例如：这一阶段的失败直接导致…'}
      />
      {edgeType === 4 && (
        <>
          <span className="field-label">
            埋设位置{sameVolume ? '（同卷伏笔必选）' : '（可选，精确到章）'}
          </span>
          <select
            className="select"
            value={fromChapterId ?? ''}
            onChange={(e) => setFromChapterId(e.target.value === '' ? null : Number(e.target.value))}
          >
            <option value="">卷级（本卷任意位置）</option>
            {fromChapters.map((c) => (
              <option key={c.id} value={c.id}>{c.title}</option>
            ))}
          </select>
          <span className="field-label">
            回收位置{sameVolume ? '（同卷伏笔必选）' : '（可选，精确到章）'}
          </span>
          <select
            className="select"
            value={toChapterId ?? ''}
            onChange={(e) => setToChapterId(e.target.value === '' ? null : Number(e.target.value))}
          >
            <option value="">卷级（本卷任意位置）</option>
            {toChapters.map((c) => (
              <option key={c.id} value={c.id}>{c.title}</option>
            ))}
          </select>
        </>
      )}
      <span className="field-label">
        所属剧情线（可选，连线将染上剧情线颜色）
      </span>
      <div className="arc-select-row">
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
        {arcId !== null && (
          <span
            className="arc-swatch"
            style={{
              background: (() => {
                const a = arcs.find((x) => x.id === arcId);
                return a ? arcColor(a) : 'var(--border)';
              })(),
            }}
          />
        )}
      </div>
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
            onClick={() => void save(() => api.updateStoryEdge(edge.id, label.trim(), arcId))}
          >
            保存
          </button>
        </>
      }
    >
      <p className="modal-hint">
        《{truncate(from?.title ?? '?', 10)}》 → 《{truncate(to?.title ?? '?', 10)}》
        {edge.edgeType === 4 && (edge.fromChapterId !== null || edge.toChapterId !== null) && (
          <span className="edge-anchor-hint">（已锚定到具体章节，位置见伏笔总览）</span>
        )}
      </p>
      <span className="field-label">说明{edge.edgeType === 4 ? '（伏笔内容）' : ''}</span>
      <input className="input" value={label} onChange={(e) => setLabel(e.target.value)} />
      <span className="field-label">所属剧情线（连线将染上剧情线颜色）</span>
      <div className="arc-select-row">
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
        {arcId !== null && (
          <span
            className="arc-swatch"
            style={{
              background: (() => {
                const a = arcs.find((x) => x.id === arcId);
                return a ? arcColor(a) : 'var(--border)';
              })(),
            }}
          />
        )}
      </div>
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
        <p className="info-empty">
          还没有剧情线。建线后可在建连线 / 编辑连线时把连线归入，总览泳道按线分层。
        </p>
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
              title="删除（连线保留，仅清归属）"
              onClick={async () => {
                const ok = window.confirm(
                  `删除剧情线「${a.title}」？\n\n卷与连线不受影响，仅清空归属。`,
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
