/**
 * 卷内视图（L2 / 分形画布·可编辑，v0.9.13）。
 *
 * 与 L1 故事地图同一套交互语言：
 * - 章节节点自由拖动，松手落库（chapters.map_x / map_y，归一化坐标）
 * - 节点右侧圆点拖出连线 → 建章间边（顺序/因果/分支/汇合/伏笔/平行/闪回），
 *   边可拖弯（中点手柄）、点击编辑（标签 / 伏笔状态 / 删除）
 * - 小节（章节群）：组框包络组内章节，整体拖动；右键组框 重命名 / 纵向对齐 / 删除；
 *   右键章节 加入 / 移出小节；布局策略「小节分组」按组纵排、组间横排
 * - 右键空白 就地新建章节 / 新建小节；双击章节打开正文
 * - 布局策略：线性分支 / 辐射 / 力导向 / 小节分组；「自动布局」按策略重排并落库
 * - 右侧详情面板：空白 = 卷信息 + 卷细纲编辑（自动保存）；章节 = 章纲/笔记/
 *   出场人物/关联连线/打开正文；人物 = 备注/出场章节/关系
 * - 「列表」开关保留旧卡片列表（跨卷移动 / 拖拽排序在列表完成）
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useDurableDraft } from '../hooks/useDurableDraft';
import { useRafCoalesce } from '../hooks/useRafCoalesce';
import { useCanvasViewport } from '../hooks/useCanvasViewport';
import * as api from '../api';
import { useAppStore } from '../store/appStore';
import type {
  ChapterGroup,
  CharacterProfile,
  CharacterRelation,
  CharacterVolumePresence,
  VolumeChapterBrief,
  VolumeDetail,
} from '../types/models';
import { fmt } from '../utils/text';
import { Modal, PromptModal } from './Modal';
import { ContextMenu } from './ContextMenu';
import { CharacterForm } from './CardsModal';
import { CharacterPickModal, RelationCreateModal, RelationEditModal } from './CharacterGraphModals';
import {
  circleEdgeEndpoints,
  edgeGeometry,
  edgeOffsetPx,
  estimateTextWidth,
  labelFontSize,
  LAYOUT_STRATEGY_DESC,
  LAYOUT_STRATEGY_NAME,
  layoutForce,
  layoutGroups,
  layoutLinearBranch,
  layoutRadial,
  perpComponent,
  quadPoint,
  REL_CATEGORY_STYLE,
  rectAnchor,
  roleColor,
  routeEdges,
  type LayoutStrategy,
} from './canvas/routing';
import { IconBack, IconPlus, IconSparkle, IconTrash } from './icons';
import { ShortcutHelp, VOLUME_SHORTCUTS } from './CanvasChrome';

const DEBOUNCE_MS = 600;
const WORLD_NODE_W = 212;
const WORLD_NODE_H = 92;
const WORLD_W = 2400;
const WORLD_H = 1500;
const WORLD_CY = 480;

type CharMention = { chapterId: number; characterId: number; mentionCount: number };

const EDGE_TYPE_NAME = ['顺序', '因果', '分支', '汇合', '伏笔回收', '平行叙事', '闪回/插叙'];
const FORESHADOW_STATUS_NAME = ['活跃', '已回收', '失效'];
const EDGE_CHOICES = [0, 1, 2, 3, 4, 5, 6];

/** 小节连线（本地渲染态，key = `g:{id}`） */
type GroupEdgeItem = {
  key: string;
  id: number;
  fromGroup: number;
  toGroup: number | null;
  toChapter: number | null;
  edgeType: number;
  label: string;
  status: number;
  bend: number;
};

/** 章间边（本地渲染态）：kind 区分持久化目标（chapter_edges / story_edges 伏笔） */
type EdgeItem = {
  /** `c:{id}` / `v:{id}`，弧度乐观值与事件绑定的稳定键 */
  key: string;
  id: number;
  kind: 'chapter' | 'volume';
  from: number;
  to: number;
  edgeType: number;
  label: string;
  status: number;
  bend: number;
};

export function VolumeView({
  volumeId,
  onBack,
  onOpenChapter,
}: {
  volumeId: number;
  onBack: () => void;
  onOpenChapter: (chapterId: number) => void;
}) {
  const showToast = useAppStore((s) => s.showToast);
  const refreshTree = useAppStore((s) => s.refreshTree);
  const focusCharacter = useAppStore((s) => s.focusCharacter);
  const [detail, setDetail] = useState<VolumeDetail | null>(null);
  const [mentions, setMentions] = useState<CharMention[]>([]);
  const [presence, setPresence] = useState<CharacterVolumePresence[]>([]);
  const [relations, setRelations] = useState<CharacterRelation[]>([]);
  const [profiles, setProfiles] = useState<CharacterProfile[]>([]);
  /** 卷级伏笔的章级锚点边（story_edges，跨卷伏笔在本卷的呈现） */
  const [volumeFsEdges, setVolumeFsEdges] = useState<
    { id: number; from: number; to: number; label: string; status: number; bend: number }[]
  >([]);

  const [positions, setPositions] = useState<Map<number, { x: number; y: number }>>(new Map());
  const positionsRef = useRef(positions);
  positionsRef.current = positions;
  /** 手动弧度乐观值（key = `c:{id}` / `v:{id}`） */
  const [bends, setBends] = useState<Map<string, number>>(new Map());

  const [showCharacters, setShowCharacters] = useState(true);
  const [showRelations, setShowRelations] = useState(true);
  const [showAppearance, setShowAppearance] = useState(false);
  const [showSeq, setShowSeq] = useState(true);
  const [showGroups, setShowGroups] = useState(true);
  const [showList, setShowList] = useState(false);
  const [strategy, setStrategy] = useState<LayoutStrategy>('linear-branch');

  const [selectedChapter, setSelectedChapter] = useState<number | null>(null);
  const [selectedChar, setSelectedChar] = useState<number | null>(null);
  const [editingCharProfile, setEditingCharProfile] = useState<CharacterProfile | null>(null);
  const [focusChar, setFocusChar] = useState<number | null>(null);
  const [pendingEdge, setPendingEdge] = useState<{ from: number; to: number } | null>(null);
  const [editingEdge, setEditingEdge] = useState<EdgeItem | null>(null);
  const [pendingGroupEdge, setPendingGroupEdge] = useState<{
    fromGroup: number;
    toGroup: number | null;
    toChapter: number | null;
  } | null>(null);
  const [editingGroupEdge, setEditingGroupEdge] = useState<GroupEdgeItem | null>(null);
  const [gconnecting, setGconnecting] = useState<{ fromGroup: number; x: number; y: number } | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  /** 就地新建章节的目标位置（归一化）；null = 用默认位置 */
  const [pendingChapterPos, setPendingChapterPos] = useState<{ x: number; y: number } | null>(null);
  const [groupPicker, setGroupPicker] = useState<number | null>(null);
  /** 人物图谱（可编辑人物层） */
  const [charManual, setCharManual] = useState<Map<number, { x: number; y: number }>>(new Map());
  const [charConnecting, setCharConnecting] = useState<{ from: number; x: number; y: number } | null>(null);
  const [pendingRelation, setPendingRelation] = useState<{ from: number; to: number } | null>(null);
  const [editingRelation, setEditingRelation] = useState<CharacterRelation | null>(null);
  const [charPick, setCharPick] = useState<{ x: number; y: number } | null>(null);
  const [renameGroup, setRenameGroup] = useState<ChapterGroup | null>(null);
  const [prompt, setPrompt] = useState<{ kind: 'newGroup' } | null>(null);

  const [connecting, setConnecting] = useState<{ from: number; x: number; y: number } | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  // 视口（平移/缩放/世界坐标）收敛到共享 hook（审查 P2-2），随 detail/showList 重绑滚轮
  const { view, setView, viewRef, toWorld } = useCanvasViewport(
    svgRef,
    `${detail?.node.id ?? ''}-${showList}`,
  );
  const lastClickRef = useRef<{ id: number; t: number } | null>(null);
  const dragRef = useRef<
    | { kind: 'pan'; sx: number; sy: number; ox: number; oy: number }
    | { kind: 'node'; id: number; dx: number; dy: number; moved: boolean }
    | { kind: 'connect'; from: number }
    | { kind: 'group'; id: number; ox: number; oy: number; base: Map<number, { x: number; y: number }>; moved: boolean }
    | {
        kind: 'edge-bend';
        item: EdgeItem;
        lane: number;
        p0: { x: number; y: number };
        p1: { x: number; y: number };
        startPerp: number;
        startBend: number;
        moved: boolean;
      }
    | { kind: 'gconnect'; fromGroup: number }
    | { kind: 'char'; id: number; dx: number; dy: number; moved: boolean }
    | { kind: 'char-connect'; from: number }
    | {
        kind: 'gbend';
        item: GroupEdgeItem;
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

  const load = useCallback(async () => {
    try {
      const [d, m, p, r, chars, graph] = await Promise.all([
        api.getVolumeDetail(volumeId),
        api.listVolumeCharacterMentions(volumeId),
        api.listCharacterVolumePresence(),
        api.listCharacterRelations(volumeId),
        api.listCharacters(),
        api.listStoryGraph(),
      ]);
      setDetail(d);
      setMentions(m);
      setPresence(p.filter((x) => x.volumeId === volumeId));
      setRelations(r);
      setProfiles(chars);
      const ids = new Set(d.chapters.map((c) => c.id));
      setVolumeFsEdges(
        graph.edges
          .filter(
            (e) =>
              e.edgeType === 4 &&
              e.fromChapterId !== null &&
              e.toChapterId !== null &&
              ids.has(e.fromChapterId) &&
              ids.has(e.toChapterId),
          )
          .map((e) => ({
            id: e.id,
            from: e.fromChapterId!,
            to: e.toChapterId!,
            label: e.label,
            status: e.status,
            bend: e.bend,
          })),
      );
    } catch (e) {
      showToast(String(e), 'error');
    }
  }, [volumeId, showToast]);

  useEffect(() => {
    void load();
    const h = () => void load();
    window.addEventListener('nf:story-updated', h);
    window.addEventListener('nf:cards-updated', h);
    return () => {
      window.removeEventListener('nf:story-updated', h);
      window.removeEventListener('nf:cards-updated', h);
    };
  }, [load]);

  /** 章节坐标：落库值优先；无坐标的按卷内顺序线性兜底 */
  useEffect(() => {
    if (!detail) return;
    setPositions(() => {
      const pos = new Map<number, { x: number; y: number }>();
      detail.chapters.forEach((c, i) => {
        pos.set(
          c.id,
          c.mapX !== null && c.mapY !== null
            ? { x: c.mapX * WORLD_W, y: c.mapY * WORLD_H }
            : { x: 100 + i * 300, y: WORLD_CY },
        );
      });
      return pos;
    });
  }, [detail]);

  // 人物图谱坐标乐观值跟随数据库（拖动落库后回读）
  useEffect(() => {
    const m = new Map<number, { x: number; y: number }>();
    for (const p of detail?.charPositions ?? []) {
      m.set(p.characterId, { x: p.mapX * WORLD_W, y: p.mapY * WORLD_H });
    }
    setCharManual(m);
  }, [detail]);

  const notify = () => window.dispatchEvent(new Event('nf:story-updated'));

  const fitView = useCallback(() => {
    const svg = svgRef.current;
    if (!svg || !detail || detail.chapters.length === 0) return;
    const pos = positionsRef.current;
    const xs: number[] = [];
    const ys: number[] = [];
    for (const c of detail.chapters) {
      const p = pos.get(c.id);
      if (p) {
        xs.push(p.x);
        ys.push(p.y);
      }
    }
    if (xs.length === 0) return;
    const minX = Math.min(...xs) - 80;
    const maxX = Math.max(...xs) + WORLD_NODE_W + 80;
    const minY = Math.min(...ys) - 140;
    const maxY = Math.max(...ys) + WORLD_NODE_H + 120;
    const cw = svg.clientWidth;
    const ch = svg.clientHeight;
    const k = Math.min(cw / (maxX - minX), ch / (maxY - minY), 1.4);
    setView({
      k,
      x: (cw - (maxX - minX) * k) / 2 - minX * k,
      y: (ch - (maxY - minY) * k) / 2 - minY * k,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail]);

  // 进入卷内后自适应视图
  useEffect(() => {
    if (detail) fitView();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail?.node.id, showList]);

  // Esc 逐层退出：人物视角 → 选中详情 → 返回故事地图
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      e.stopImmediatePropagation();
      if (focusChar !== null) setFocusChar(null);
      else if (selectedChapter !== null) setSelectedChapter(null);
      else if (selectedChar !== null) setSelectedChar(null);
      else onBack();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onBack, focusChar, selectedChapter, selectedChar]);

  // ---------- 派生 ----------

  const chapterById = useMemo(
    () => new Map((detail?.chapters ?? []).map((c) => [c.id, c])),
    [detail],
  );
  const orderedChapters = detail?.chapters ?? [];
  const groups = detail?.groups ?? [];

  /** 手工章间边（渲染态，含乐观 bend） */
  const edgeItems: EdgeItem[] = useMemo(() => {
    const list: EdgeItem[] = (detail?.chapterEdges ?? []).map((e) => ({
      key: `c:${e.id}`,
      id: e.id,
      kind: 'chapter' as const,
      from: e.fromChapter,
      to: e.toChapter,
      edgeType: e.edgeType,
      label: e.label,
      status: e.status,
      bend: bends.get(`c:${e.id}`) ?? e.bend,
    }));
    for (const e of volumeFsEdges) {
      list.push({
        key: `v:${e.id}`,
        id: e.id,
        kind: 'volume' as const,
        from: e.from,
        to: e.to,
        edgeType: 4,
        label: e.label,
        status: e.status,
        bend: bends.get(`v:${e.id}`) ?? e.bend,
      });
    }
    return list;
  }, [detail, bends, volumeFsEdges]);

  /** 小节连线（渲染态，含乐观 bend） */
  const groupEdgeItems: GroupEdgeItem[] = useMemo(
    () =>
      (detail?.groupEdges ?? []).map((e) => ({
        key: `g:${e.id}`,
        id: e.id,
        fromGroup: e.fromGroup,
        toGroup: e.toGroup,
        toChapter: e.toChapter,
        edgeType: e.edgeType,
        label: e.label,
        status: e.status,
        bend: bends.get(`g:${e.id}`) ?? e.bend,
      })),
    [detail, bends],
  );

  /** 小节连线锚点：源组框边框 → 目标组框/章节边框 */
  const groupEdgeAnchors = (ge: GroupEdgeItem) => {
    const sb = groupBoxes.get(ge.fromGroup);
    if (!sb) return null;
    const sRect = { x: sb.x, y: sb.y, w: sb.w, h: sb.h };
    let tRect: { x: number; y: number; w: number; h: number };
    if (ge.toGroup !== null) {
      const tb = groupBoxes.get(ge.toGroup);
      if (!tb) return null;
      tRect = { x: tb.x, y: tb.y, w: tb.w, h: tb.h };
    } else {
      const cp = positions.get(ge.toChapter ?? -1);
      if (!cp) return null;
      tRect = { x: cp.x, y: cp.y, w: WORLD_NODE_W, h: WORLD_NODE_H };
    }
    return { p1: rectAnchor(sRect, tRect), p2: rectAnchor(tRect, sRect) };
  };

  /** 有手工边的章对（无向键）：派生顺序线避让 */
  const manualPairs = useMemo(() => {
    const s = new Set<string>();
    for (const e of edgeItems) s.add(e.from < e.to ? `${e.from}-${e.to}` : `${e.to}-${e.from}`);
    return s;
  }, [edgeItems]);

  /** 派生顺序边：相邻章，且该对没有手工边 */
  const seqEdges = useMemo(() => {
    const out: { from: number; to: number }[] = [];
    if (!showSeq) return out;
    for (let i = 1; i < orderedChapters.length; i++) {
      const a = orderedChapters[i - 1].id;
      const b = orderedChapters[i].id;
      const key = a < b ? `${a}-${b}` : `${b}-${a}`;
      if (!manualPairs.has(key)) out.push({ from: a, to: b });
    }
    return out;
  }, [orderedChapters, manualPairs, showSeq]);

  /** 组框：成员外包络（含标题栏），空组给最小尺寸 */
  const groupBoxes = useMemo(() => {
    const boxes = new Map<
      number,
      { id: number; title: string; x: number; y: number; w: number; h: number; members: number[] }
    >();
    for (const g of groups) {
      const members = orderedChapters.filter((c) => c.groupId === g.id).map((c) => c.id);
      const pts = members
        .map((id) => positions.get(id))
        .filter((p): p is { x: number; y: number } => Boolean(p));
      if (pts.length === 0) {
        boxes.set(g.id, { id: g.id, title: g.title, x: 100, y: WORLD_CY, w: 220, h: 140, members });
      } else {
        const x = Math.min(...pts.map((p) => p.x)) - 18;
        const y = Math.min(...pts.map((p) => p.y)) - 48;
        const w = Math.max(...pts.map((p) => p.x + WORLD_NODE_W)) + 18 - x;
        const h = Math.max(...pts.map((p) => p.y + WORLD_NODE_H)) + 18 - y;
        boxes.set(g.id, { id: g.id, title: g.title, x, y, w, h, members });
      }
    }
    return boxes;
  }, [groups, orderedChapters, positions]);

  /** 小节间汇总弧：两组成员之间存在章间边时，组框之间画一条淡弧 */
  const groupArcs = useMemo(() => {
    const arcs: { key: string; a: { x: number; y: number }; b: { x: number; y: number }; n: number }[] = [];
    const groupOf = new Map(orderedChapters.map((c) => [c.id, c.groupId]));
    const pairCount = new Map<string, number>();
    for (const e of edgeItems) {
      const ga = groupOf.get(e.from) ?? null;
      const gb = groupOf.get(e.to) ?? null;
      if (ga === null || gb === null || ga === gb) continue;
      const key = ga < gb ? `${ga}-${gb}` : `${gb}-${ga}`;
      pairCount.set(key, (pairCount.get(key) ?? 0) + 1);
    }
    for (const [key, n] of pairCount) {
      const [ia, ib] = key.split('-').map(Number);
      const ba = groupBoxes.get(ia);
      const bb = groupBoxes.get(ib);
      if (!ba || !bb) continue;
      arcs.push({
        key,
        a: { x: ba.x + ba.w / 2, y: ba.y + ba.h / 2 },
        b: { x: bb.x + bb.w / 2, y: bb.y + bb.h / 2 },
        n,
      });
    }
    return arcs;
  }, [edgeItems, orderedChapters, groupBoxes]);

  // ---------- 布局 ----------

  const computeLayout = useCallback(
    (s: LayoutStrategy): Map<number, { x: number; y: number }> => {
      const chapters = orderedChapters;
      const ids = chapters.map((c) => c.id);
      if (s === 'radial') {
        const weight = new Map<number, number>();
        for (const m of mentions) weight.set(m.chapterId, (weight.get(m.chapterId) ?? 0) + m.mentionCount);
        return layoutRadial(
          ids.map((id) => ({ id, weight: weight.get(id) ?? 0 })),
          WORLD_W / 2,
          WORLD_CY,
        ).positions;
      }
      if (s === 'force') {
        const edges = [
          ...ids.slice(1).map((id, i) => ({ from: ids[i], to: id })),
          ...edgeItems.filter((e) => e.kind === 'chapter').map((e) => ({ from: e.from, to: e.to })),
        ];
        return layoutForce(ids, edges, WORLD_W / 2, WORLD_CY).positions;
      }
      if (s === 'groups') {
        return layoutGroups(
          chapters.map((c) => ({ id: c.id, groupId: c.groupId })),
          groups.map((g) => g.id),
        ).positions;
      }
      return layoutLinearBranch(
        ids,
        edgeItems
          .filter((e) => e.kind === 'chapter')
          .map((e) => ({ from: e.from, to: e.to, edgeType: e.edgeType })),
        WORLD_CY,
      ).positions;
    },
    [orderedChapters, mentions, edgeItems, groups],
  );

  /** 把世界坐标点居中到视口（保持当前缩放） */
  const centerOn = (x: number, y: number) => {
    const svg = svgRef.current;
    if (!svg) return;
    const k = viewRef.current.k;
    setView({
      k,
      x: svg.clientWidth / 2 - x * k,
      y: svg.clientHeight / 2 - y * k,
    });
  };

  /** 应用布局策略：重排 + 全部落库 + 焦点追踪（选中章优先，否则自适应全图） */
  const applyStrategy = async (s: LayoutStrategy) => {
    setStrategy(s);
    const pos = computeLayout(s);
    setPositions(pos);
    positionsRef.current = pos;
    // 焦点追踪：重排后视图跟着内容走，图不再「跑不见」
    if (selectedChapter !== null && pos.get(selectedChapter)) {
      const p = pos.get(selectedChapter)!;
      centerOn(p.x + WORLD_NODE_W / 2, p.y + WORLD_NODE_H / 2);
    } else {
      fitView();
    }
    try {
      for (const [id, p] of pos) {
        await api.moveChapterNode(id, p.x / WORLD_W, p.y / WORLD_H);
      }
      showToast(`已按「${LAYOUT_STRATEGY_NAME[s]}」重排 · ${LAYOUT_STRATEGY_DESC[s]}`);
    } catch (e) {
      showToast(String(e), 'error');
    }
  };

  // ---------- 指针交互 ----------

  const onBackgroundDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    setSelectedChapter(null);
    setSelectedChar(null);
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

  const onChapterDown = (e: React.PointerEvent, c: VolumeChapterBrief) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    setSelectedChapter(c.id);
    setSelectedChar(null);
    // 双击打开正文：不依赖原生 dblclick（WebView2 指针捕获下不可靠）
    const now = Date.now();
    const last = lastClickRef.current;
    lastClickRef.current = { id: c.id, t: now };
    if (last && last.id === c.id && now - last.t < 350) {
      lastClickRef.current = null;
      dragRef.current = null;
      onOpenChapter(c.id);
      return;
    }
    const w = toWorld(e.clientX, e.clientY);
    const p = positionsRef.current.get(c.id)!;
    dragRef.current = { kind: 'node', id: c.id, dx: w.x - p.x, dy: w.y - p.y, moved: false };
    svgRef.current?.setPointerCapture(e.pointerId);
  };

  const onConnectDown = (e: React.PointerEvent, c: VolumeChapterBrief) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    dragRef.current = { kind: 'connect', from: c.id };
    const w = toWorld(e.clientX, e.clientY);
    setConnecting({ from: c.id, x: w.x, y: w.y });
    svgRef.current?.setPointerCapture(e.pointerId);
  };

  const onGroupDown = (e: React.PointerEvent, gid: number) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    const box = groupBoxes.get(gid);
    if (!box) return;
    const w = toWorld(e.clientX, e.clientY);
    const base = new Map<number, { x: number; y: number }>();
    for (const m of box.members) {
      const p = positionsRef.current.get(m);
      if (p) base.set(m, { ...p });
    }
    dragRef.current = { kind: 'group', id: gid, ox: w.x, oy: w.y, base, moved: false };
    svgRef.current?.setPointerCapture(e.pointerId);
  };

  const onEdgePointerDown = (e: React.PointerEvent, item: EdgeItem, lane: number) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    const a = positionsRef.current.get(item.from);
    const b = positionsRef.current.get(item.to);
    if (!a || !b) return;
    const p0 = rectAnchor(
      { x: a.x, y: a.y, w: WORLD_NODE_W, h: WORLD_NODE_H },
      { x: b.x, y: b.y, w: WORLD_NODE_W, h: WORLD_NODE_H },
    );
    const p1 = rectAnchor(
      { x: b.x, y: b.y, w: WORLD_NODE_W, h: WORLD_NODE_H },
      { x: a.x, y: a.y, w: WORLD_NODE_W, h: WORLD_NODE_H },
    );
    const w = toWorld(e.clientX, e.clientY);
    dragRef.current = {
      kind: 'edge-bend',
      item,
      lane,
      p0,
      p1,
      startPerp: perpComponent(p0, p1, w),
      startBend: bends.get(item.key) ?? 0,
      moved: false,
    };
    svgRef.current?.setPointerCapture(e.pointerId);
  };

  /** 人物节点按下：拖动移位（松手落库），原地松开 = 选中 + 人物视角开关 */
  const onCharDown = (
    e: React.PointerEvent,
    c: { characterId: number; cx: number; cy: number },
  ) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    const w = toWorld(e.clientX, e.clientY);
    dragRef.current = { kind: 'char', id: c.characterId, dx: w.x - c.cx, dy: w.y - c.cy, moved: false };
    svgRef.current?.setPointerCapture(e.pointerId);
  };

  /** 人物节点圆点拉线：拖到人物=建关系，拖到章节=绑定人物→章 */
  const onCharHandleDown = (e: React.PointerEvent, id: number) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    dragRef.current = { kind: 'char-connect', from: id };
    const w = toWorld(e.clientX, e.clientY);
    setCharConnecting({ from: id, x: w.x, y: w.y });
    svgRef.current?.setPointerCapture(e.pointerId);
  };

  /** 人物右键：查看详情 / 移出本卷（有卷级绑定时） */
  const onCharContextMenu = (e: React.MouseEvent, characterId: number) => {
    e.preventDefault();
    e.stopPropagation();
    setSelectedChar(characterId);
    setSelectedChapter(null);
    const profile = profiles.find((p) => p.id === characterId);
    const items: Parameters<typeof ContextMenu.open>[2] = [
      { label: '查看人物详情', onClick: () => setSelectedChar(characterId) },
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
            await api.removeCharacterFromVolume(characterId, volumeId);
            setCharManual((prev) => {
              const next = new Map(prev);
              next.delete(characterId);
              return next;
            });
            if (selectedChar === characterId) setSelectedChar(null);
            await load();
            showToast('已从画布移除，可随时重新添加');
          } catch (err) {
            showToast(String(err), 'error');
          }
        },
      },
      {
        label: '删除人物',
        danger: true,
        onClick: async () => {
          if (!window.confirm(`确定删除人物「${profile?.name ?? characterId}」？该人物的所有关系、提及记录将一并清除。`)) return;
          try {
            await api.deleteCharacter(characterId);
            if (selectedChar === characterId) setSelectedChar(null);
            await load();
            notify();
          } catch (err) {
            showToast(String(err), 'error');
          }
        },
      },
    ];
    const vb = detail?.bindings.find((b) => b.volumeId === volumeId && b.characterId === characterId);
    if (vb) {
      items.push({
        label: '移出本卷（解除绑定）',
        danger: true,
        onClick: async () => {
          try {
            await api.deleteCharacterBinding(vb.id);
            await load();
            notify();
          } catch (err) {
            showToast(String(err), 'error');
          }
        },
      });
    }
    ContextMenu.open(e.clientX, e.clientY, items);
  };

  /** 组框圆点拖出连线 */
  const onGroupConnectDown = (e: React.PointerEvent, gid: number) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    dragRef.current = { kind: 'gconnect', fromGroup: gid };
    const w = toWorld(e.clientX, e.clientY);
    setGconnecting({ fromGroup: gid, x: w.x, y: w.y });
    svgRef.current?.setPointerCapture(e.pointerId);
  };

  /** 小节连线按下：拖动 = 调弧度，原地点击 = 编辑弹窗 */
  const onGroupEdgePointerDown = (e: React.PointerEvent, item: GroupEdgeItem, lane: number) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    const anchors = groupEdgeAnchors(item);
    if (!anchors) return;
    const w = toWorld(e.clientX, e.clientY);
    dragRef.current = {
      kind: 'gbend',
      item,
      lane,
      p0: anchors.p1,
      p1: anchors.p2,
      startPerp: perpComponent(anchors.p1, anchors.p2, w),
      startBend: bends.get(item.key) ?? 0,
      moved: false,
    };
    svgRef.current?.setPointerCapture(e.pointerId);
  };

  const applyMove = (clientX: number, clientY: number) => {
    const d = dragRef.current;
    if (!d) return;
    if (d.kind === 'pan') {
      setView((v) => ({ ...v, x: d.ox + (clientX - d.sx), y: d.oy + (clientY - d.sy) }));
    } else if (d.kind === 'node') {
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
    } else if (d.kind === 'group') {
      const w = toWorld(clientX, clientY);
      const dx = w.x - d.ox;
      const dy = w.y - d.oy;
      if (Math.hypot(dx, dy) > 4) d.moved = true;
      setPositions((prev) => {
        const next = new Map(prev);
        for (const [id, p] of d.base) next.set(id, { x: p.x + dx, y: p.y + dy });
        return next;
      });
    } else if (d.kind === 'edge-bend') {
      const w = toWorld(clientX, clientY);
      const delta = perpComponent(d.p0, d.p1, w) - d.startPerp;
      if (Math.abs(delta) > 4) d.moved = true;
      const bend = Math.max(-400, Math.min(400, d.startBend + delta));
      setBends((prev) => {
        const next = new Map(prev);
        next.set(d.item.key, bend);
        return next;
      });
    } else if (d.kind === 'gconnect') {
      const w = toWorld(clientX, clientY);
      setGconnecting((c) => (c ? { ...c, x: w.x, y: w.y } : c));
    } else if (d.kind === 'gbend') {
      const w = toWorld(clientX, clientY);
      const delta = perpComponent(d.p0, d.p1, w) - d.startPerp;
      if (Math.abs(delta) > 4) d.moved = true;
      const bend = Math.max(-400, Math.min(400, d.startBend + delta));
      setBends((prev) => {
        const next = new Map(prev);
        next.set(d.item.key, bend);
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
    svgRef.current?.releasePointerCapture(e.pointerId);
    const d = dragRef.current;
    dragRef.current = null;
    if (!d) return;
    if (d.kind === 'node') {
      if (!d.moved) return;
      const p = positionsRef.current.get(d.id);
      if (!p) return;
      try {
        await api.moveChapterNode(d.id, p.x / WORLD_W, p.y / WORLD_H);
        notify();
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
          w.x <= p.x + WORLD_NODE_W &&
          w.y >= p.y &&
          w.y <= p.y + WORLD_NODE_H
        ) {
          target = id;
          break;
        }
      }
      setConnecting(null);
      if (target !== null) setPendingEdge({ from: d.from, to: target });
    } else if (d.kind === 'group') {
      if (!d.moved) return;
      try {
        const batch = [];
        for (const [id] of d.base) {
          const cur = positionsRef.current.get(id);
          if (!cur) continue;
          batch.push({ chapterId: id, mapX: cur.x / WORLD_W, mapY: cur.y / WORLD_H });
        }
        // 单事务批量提交，避免逐章 IPC 失败留下半移动状态（审查 P2-1）
        await api.moveChapterNodes(batch);
        notify();
      } catch (err) {
        showToast(String(err), 'error');
      }
    } else if (d.kind === 'edge-bend') {
      if (!d.moved) {
        setEditingEdge(d.item);
        return;
      }
      const bend = Math.round((bends.get(d.item.key) ?? 0) * 10) / 10;
      try {
        if (d.item.kind === 'chapter') await api.setChapterEdgeBend(d.item.id, bend);
        else await api.setStoryEdgeBend(d.item.id, bend);
      } catch (err) {
        showToast(String(err), 'error');
      }
    } else if (d.kind === 'gconnect') {
      const w = toWorld(e.clientX, e.clientY);
      // 命中判定：章节卡优先（更具体），其次其他组框
      let toChapter: number | null = null;
      for (const [id, p] of positionsRef.current) {
        if (w.x >= p.x && w.x <= p.x + WORLD_NODE_W && w.y >= p.y && w.y <= p.y + WORLD_NODE_H) {
          toChapter = id;
          break;
        }
      }
      let toGroup: number | null = null;
      if (toChapter === null) {
        for (const b of groupBoxes.values()) {
          if (b.id !== d.fromGroup && w.x >= b.x && w.x <= b.x + b.w && w.y >= b.y && w.y <= b.y + b.h) {
            toGroup = b.id;
            break;
          }
        }
      }
      setGconnecting(null);
      if (toChapter !== null || toGroup !== null) {
        setPendingGroupEdge({ fromGroup: d.fromGroup, toGroup, toChapter });
      }
    } else if (d.kind === 'gbend') {
      if (!d.moved) {
        setEditingGroupEdge(d.item);
        return;
      }
      const bend = Math.round((bends.get(d.item.key) ?? 0) * 10) / 10;
      try {
        await api.setGroupEdgeBend(d.item.id, bend);
      } catch (err) {
        showToast(String(err), 'error');
      }
    } else if (d.kind === 'char') {
      if (!d.moved) {
        setSelectedChar(d.id);
        setSelectedChapter(null);
        setFocusChar((f) => (f === d.id ? null : d.id));
        return;
      }
      const p = charManual.get(d.id);
      if (!p) return;
      try {
        await api.setCharVolumePos(d.id, volumeId, p.x / WORLD_W, p.y / WORLD_H);
        notify();
      } catch (err) {
        showToast(String(err), 'error');
      }
    } else if (d.kind === 'char-connect') {
      const w = toWorld(e.clientX, e.clientY);
      setCharConnecting(null);
      // 命中判定：人物节点（建关系，默认限本卷）优先，其次章节卡（绑定人物→章）
      let hitChar: number | null = null;
      for (const n of charNodes) {
        if (n.characterId !== d.from && Math.hypot(w.x - n.cx, w.y - n.cy) < n.r + 6) {
          hitChar = n.characterId;
          break;
        }
      }
      if (hitChar !== null) {
        setPendingRelation({ from: d.from, to: hitChar });
        return;
      }
      let hitChapter: number | null = null;
      for (const [id, p] of positionsRef.current) {
        if (w.x >= p.x && w.x <= p.x + WORLD_NODE_W && w.y >= p.y && w.y <= p.y + WORLD_NODE_H) {
          hitChapter = id;
          break;
        }
      }
      if (hitChapter !== null) {
        try {
          await api.createCharacterBinding({ characterId: d.from, volumeId: null, chapterId: hitChapter });
          await load();
          notify();
          showToast(`已将「${profiles.find((x) => x.id === d.from)?.name ?? '?'}」关联到该章`);
        } catch (err) {
          showToast(String(err), 'error');
        }
      }
    }
  };

  // ---------- 右键菜单 ----------

  const onChapterContextMenu = (e: React.MouseEvent, c: VolumeChapterBrief) => {
    e.preventDefault();
    e.stopPropagation();
    setSelectedChapter(c.id);
    const items: Parameters<typeof ContextMenu.open>[2] = [
      { label: '打开正文', onClick: () => onOpenChapter(c.id) },
      { label: '查看 / 编辑信息', onClick: () => setSelectedChapter(c.id) },
    ];
    if (c.groupId === null) {
      items.push({ label: '加入小节…', onClick: () => setGroupPicker(c.id) });
    } else {
      items.push({
        label: '移出小节',
        onClick: async () => {
          try {
            await api.setChapterGroup(c.id, null);
            await load();
            notify();
          } catch (err) {
            showToast(String(err), 'error');
          }
        },
      });
    }
    items.push({ separator: true, label: '' });
    items.push({
      label: '删除章节（入回收站）…',
      danger: true,
      icon: <IconTrash size={14} />,
      onClick: async () => {
        if (!window.confirm(`删除章节「${c.title}」？\n\n章节进入回收站，7 天内可恢复。`)) return;
        try {
          await api.deleteChapter(c.id);
          setSelectedChapter(null);
          await refreshTree();
          await load();
          notify();
          showToast('已移入回收站');
        } catch (err) {
          showToast(String(err), 'error');
        }
      },
    });
    ContextMenu.open(e.clientX, e.clientY, items);
  };

  const onGroupContextMenu = (e: React.MouseEvent, g: ChapterGroup) => {
    e.preventDefault();
    e.stopPropagation();
    ContextMenu.open(e.clientX, e.clientY, [
      { label: '重命名小节', onClick: () => setRenameGroup(g) },
      {
        label: '纵向对齐成员',
        onClick: async () => {
          const box = groupBoxes.get(g.id);
          if (!box) return;
          const next = new Map(positionsRef.current);
          box.members.forEach((id, i) => {
            next.set(id, { x: box.x + 18, y: box.y + 48 + i * 118 });
          });
          setPositions(next);
          positionsRef.current = next;
          try {
            for (const id of box.members) {
              const p = next.get(id)!;
              await api.moveChapterNode(id, p.x / WORLD_W, p.y / WORLD_H);
            }
            notify();
            showToast('成员已纵向对齐');
          } catch (err) {
            showToast(String(err), 'error');
          }
        },
      },
      { separator: true, label: '' },
      {
        label: '删除小节（章节保留）…',
        danger: true,
        icon: <IconTrash size={14} />,
        onClick: async () => {
          if (!window.confirm(`删除小节「${g.title}」？\n\n章节保留，仅解除分组。`)) return;
          try {
            await api.deleteChapterGroup(g.id);
            await load();
            notify();
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
        label: '新建章节',
        onClick: () => {
          setPendingChapterPos({ x: w.x / WORLD_W, y: w.y / WORLD_H });
          setShowAdd(true);
        },
      },
      { label: '新建小节', onClick: () => setPrompt({ kind: 'newGroup' }) },
      {
        label: '添加人物到本卷…',
        onClick: () => setCharPick({ x: w.x / WORLD_W, y: w.y / WORLD_H }),
      },
    ]);
  };

  // ---------- 视图 / 操作 ----------

  const moveChapterTo = async (id: number, targetIndex: number) => {
    try {
      await api.moveChapter(id, volumeId, targetIndex);
      await load();
      await refreshTree();
      notify();
    } catch (e) {
      showToast(String(e), 'error');
    }
  };

  // ---------- 人物 / 焦点派生 ----------

  const charNodes = useMemo(() => {
    if (!detail) return [];
    const totals = new Map<number, number>();
    const perChapter = new Map<number, Map<number, number>>();
    for (const m of mentions) {
      totals.set(m.characterId, (totals.get(m.characterId) ?? 0) + m.mentionCount);
      let pc = perChapter.get(m.characterId);
      if (!pc) {
        pc = new Map();
        perChapter.set(m.characterId, pc);
      }
      pc.set(m.chapterId, (pc.get(m.chapterId) ?? 0) + m.mentionCount);
    }
    const info = presence.map((p) => {
      const pc = perChapter.get(p.characterId);
      let topChapter = 0;
      let topCount = -1;
      for (const [cid, cnt] of pc ?? []) {
        if (cnt > topCount) {
          topCount = cnt;
          topChapter = cid;
        }
      }
      const mentionCount = totals.get(p.characterId) ?? p.mentionCount;
      return {
        characterId: p.characterId,
        name: p.name,
        role: p.role,
        mentionCount,
        r: Math.min(30, 14 + Math.log2(Math.max(1, mentionCount)) * 2.5),
        topChapter,
        chapters: [...(pc?.keys() ?? [])],
      };
    });
    const perChapterCount = new Map<number, number>();
    const list = info
      .map((c) => {
        const cp = positions.get(c.topChapter);
        if (!cp) return null;
        const idx = perChapterCount.get(c.topChapter) ?? 0;
        perChapterCount.set(c.topChapter, idx + 1);
        const col = idx % 3;
        const row = Math.floor(idx / 3);
        return {
          ...c,
          cx: cp.x + WORLD_NODE_W / 2 + (col - 1) * 62,
          cy: cp.y + WORLD_NODE_H + 30 + row * 52,
        };
      })
      .filter((c): c is NonNullable<typeof c> => c !== null);
    // 人物图谱坐标覆盖（拖动落库 / 乐观值）
    for (const c of list) {
      const o = charManual.get(c.characterId);
      if (o) {
        c.cx = o.x;
        c.cy = o.y;
        continue;
      }
      const saved = detail.charPositions.find((p) => p.characterId === c.characterId);
      if (saved) {
        c.cx = saved.mapX * WORLD_W;
        c.cy = saved.mapY * WORLD_H;
      }
    }
    // 手动绑定但正文未提及的人物（画布常驻节点）
    const inCanvas = new Set(list.map((c) => c.characterId));
    let slot = 0;
    for (const b of detail.bindings) {
      if (b.volumeId !== volumeId || inCanvas.has(b.characterId)) continue;
      inCanvas.add(b.characterId);
      const pr = profiles.find((x) => x.id === b.characterId);
      const o =
        charManual.get(b.characterId) ??
        (() => {
          const saved = detail.charPositions.find((p) => p.characterId === b.characterId);
          return saved ? { x: saved.mapX * WORLD_W, y: saved.mapY * WORLD_H } : undefined;
        })();
      list.push({
        characterId: b.characterId,
        name: pr?.name ?? '?',
        role: pr?.role ?? '',
        mentionCount: 0,
        r: 11,
        topChapter: -1,
        chapters: [],
        cx: o?.x ?? 160 + (slot % 4) * 84,
        cy: o?.y ?? 90 + Math.floor(slot / 4) * 64,
      });
      slot += 1;
    }
    return list;
  }, [detail, mentions, presence, positions, charManual, profiles, volumeId]);

  const charIdsInVolume = useMemo(() => new Set(charNodes.map((c) => c.characterId)), [charNodes]);

  const focusSets = useMemo(() => {
    if (focusChar === null) return null;
    const chapters = new Set(mentions.filter((m) => m.characterId === focusChar).map((m) => m.chapterId));
    const chars = new Set<number>([focusChar]);
    for (const r of relations) {
      if (r.fromChar === focusChar) chars.add(r.toChar);
      if (r.toChar === focusChar) chars.add(r.fromChar);
    }
    return { chapters, chars };
  }, [focusChar, mentions, relations]);

  const dimChapter = (id: number) => (focusSets ? (focusSets.chapters.has(id) ? '' : 'dim') : '');
  const dimChar = (id: number) => (focusSets ? (focusSets.chars.has(id) ? '' : 'dim') : '');

  if (!detail) {
    return (
      <div className="volume-view">
        <div className="story-map-empty">卷内画布加载中…</div>
      </div>
    );
  }

  const { node, chapters } = detail;
  const selChapter = selectedChapter !== null ? chapterById.get(selectedChapter) : undefined;
  const selChar = selectedChar !== null ? charNodes.find((c) => c.characterId === selectedChar) : undefined;

  // 剧情边路由：手工边（含卷级伏笔）+ 派生顺序线一起分道
  const { routed: routedPlot, overflow: plotOverflow } = routeEdges([
    ...edgeItems.map((e) => ({
      id: e.id,
      from: e.from,
      to: e.to,
      kind: 'plot' as const,
      edgeType: e.edgeType,
      label: e.label,
    })),
    ...seqEdges.map((e) => ({
      id: -100 - e.to,
      from: e.from,
      to: e.to,
      kind: 'plot' as const,
      edgeType: 0,
      label: '',
    })),
  ]);
  const laneByPlotId = new Map(routedPlot.map((r) => [r.edge.id, r.lane]));

  const { routed: routedRel } = routeEdges(
    relations
      .filter(
        (r) =>
          showCharacters &&
          showRelations &&
          charIdsInVolume.has(r.fromChar) &&
          charIdsInVolume.has(r.toChar),
      )
      .map((r) => ({
        id: r.id,
        from: r.fromChar,
        to: r.toChar,
        kind: 'character' as const,
        edgeType: r.relCategory,
        label: r.relType || r.label || REL_CATEGORY_STYLE[r.relCategory]?.name || '',
        direction: r.direction,
      })),
  );

  // ---------- 列表视图 ----------
  if (showList) {
    return (
      <div className="volume-view">
        <div className="volume-breadcrumb">
          <button className="btn btn-mini" onClick={onBack}>
            <IconBack /> 故事地图
          </button>
          <span className="volume-bc-sep">›</span>
          <span className="volume-bc-title" title={node.title}>{node.title}</span>
          <span className="volume-bc-meta">
            第 {node.sortOrder + 1} 卷 · {chapters.length} 章 · {fmt(node.wordCount)} 字
          </span>
          <div className="chapter-detail-nav">
            <button className="btn btn-mini active" onClick={() => setShowList(false)}>
              画布视图
            </button>
            <button className="btn btn-mini" onClick={() => setShowAdd(true)}>
              <IconPlus /> 添加章节
            </button>
          </div>
        </div>
        <ChapterCardList
          chapters={chapters}
          onOpen={(id) => onOpenChapter(id)}
          onReorder={(id, i) => void moveChapterTo(id, i)}
        />
        {showAdd && (
          <AddChapterModal
            volumeId={volumeId}
            onClose={() => setShowAdd(false)}
            onDone={async (count) => {
              setShowAdd(false);
              await load();
              await refreshTree();
              notify();
              if (count > 0) showToast(`已移入 ${count} 章`);
            }}
          />
        )}
      </div>
    );
  }

  // ---------- 画布视图（L2 可编辑） ----------
  return (
    <div className="volume-view">
      <div className="volume-breadcrumb">
        <button className="btn btn-mini" onClick={onBack}>
          <IconBack /> 故事地图
        </button>
        <span className="volume-bc-sep">›</span>
        <span className="volume-bc-title" title={node.title}>{node.title}</span>
        <span className="volume-bc-meta">
          第 {node.sortOrder + 1} 卷 · {chapters.length} 章 · {fmt(node.wordCount)} 字
        </span>
        <div className="chapter-detail-nav">
          <button
            className={`btn btn-mini${showCharacters ? ' active' : ''}`}
            onClick={() => setShowCharacters((v) => !v)}
          >
            👤 人物层
          </button>
          <button
            className={`btn btn-mini${showRelations ? ' active' : ''}`}
            onClick={() => setShowRelations((v) => !v)}
          >
            🔗 关系边
          </button>
          <button
            className={`btn btn-mini${showSeq ? ' active' : ''}`}
            data-tip="相邻章自动顺序线"
            onClick={() => setShowSeq((v) => !v)}
          >
            — 顺序线
          </button>
          <button
            className={`btn btn-mini${showGroups ? ' active' : ''}`}
            onClick={() => setShowGroups((v) => !v)}
          >
            ▦ 小节
          </button>
          <button
            className={`btn btn-mini${showAppearance ? ' active' : ''}`}
            onClick={() => setShowAppearance((v) => !v)}
          >
            👁 出场边
          </button>
          <select
            className="select select-mini"
            value={strategy}
            onChange={(e) => void applyStrategy(e.target.value as LayoutStrategy)}
            title={
              '布局策略：' +
              (Object.keys(LAYOUT_STRATEGY_NAME) as LayoutStrategy[])
                .map((k) => `${LAYOUT_STRATEGY_NAME[k]}=${LAYOUT_STRATEGY_DESC[k]}`)
                .join('；')
            }
          >
            {(Object.keys(LAYOUT_STRATEGY_NAME) as LayoutStrategy[]).map((s) => (
              <option key={s} value={s}>{LAYOUT_STRATEGY_NAME[s]}</option>
            ))}
          </select>
          <button className="btn btn-mini" onClick={() => void applyStrategy(strategy)}>
            <IconSparkle /> 自动布局
          </button>
          <button className="btn btn-mini" onClick={() => setPrompt({ kind: 'newGroup' })}>
            ▦ 新建小节
          </button>
          <button className="btn btn-mini" onClick={() => setShowList(true)}>
            列表
          </button>
          <button className="btn btn-mini" onClick={() => setShowAdd(true)}>
            <IconPlus /> 添加章节
          </button>
          <ShortcutHelp shortcuts={VOLUME_SHORTCUTS} title={`卷「${node.title}」章节图 · 操作`} />
        </div>
      </div>

      {focusChar !== null && (
        <div className="story-map-focusbar">
          人物视角：{profiles.find((p) => p.id === focusChar)?.name ?? presence.find((p) => p.characterId === focusChar)?.name ?? '?'}
          <button className="btn btn-mini" onClick={() => setFocusChar(null)}>
            退出
          </button>
        </div>
      )}

      <div className="volume-canvas-layout">
        <div className="volume-canvas-main">
          <svg
            ref={svgRef}
            className="story-map-canvas"
            onPointerDown={onBackgroundDown}
            onPointerMove={onPointerMove}
            onPointerUp={(e) => void onPointerUp(e)}
            onContextMenu={onBackgroundContextMenu}
          >
            <defs>
              <pattern id="vc-grid" width="28" height="28" patternUnits="userSpaceOnUse">
                <circle cx="1.2" cy="1.2" r="1.2" fill="var(--border)" />
              </pattern>
              <marker id="vc-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M0 0L10 5L0 10z" fill="var(--text-faint)" />
              </marker>
              <marker id="vc-arrow-accent" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M0 0L10 5L0 10z" fill="var(--accent)" />
              </marker>
              <marker id="vc-arrow-foreshadow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M0 0L10 5L0 10z" fill="var(--sm-foreshadow)" />
              </marker>
            </defs>
            <rect width="100%" height="100%" fill="url(#vc-grid)" />
            <g transform={`translate(${view.x},${view.y}) scale(${view.k})`}>
              {/* 小节组框（最底层，整体可拖动） */}
              {showGroups &&
                [...groupBoxes.values()].map((b) => (
                  <g
                    key={`g-${b.id}`}
                    className="vc-group-box"
                    onPointerDown={(e) => onGroupDown(e, b.id)}
                    onContextMenu={(e) => {
                      const g = groups.find((x) => x.id === b.id);
                      if (g) onGroupContextMenu(e, g);
                    }}
                  >
                    <rect x={b.x} y={b.y} width={b.w} height={b.h} rx="14" className="vc-group-rect" />
                    <text x={b.x + 12} y={b.y + 22} className="vc-group-title">
                      ▦ {b.title}（{b.members.length}）
                    </text>
                    {/* 连线起点圆点（右侧中点）：拖到小节 / 章节上建小节连线 */}
                    <circle
                      className="sm-node-handle vc-group-handle"
                      cx={b.x + b.w}
                      cy={b.y + b.h / 2}
                      r="6"
                      onPointerDown={(e) => onGroupConnectDown(e, b.id)}
                    />
                  </g>
                ))}

              {/* 小节间汇总弧 */}
              {showGroups &&
                groupArcs.map((a) => (
                  <path
                    key={`ga-${a.key}`}
                    d={`M ${a.a.x} ${a.a.y} Q ${(a.a.x + a.b.x) / 2} ${Math.min(a.a.y, a.b.y) - 90} ${a.b.x} ${a.b.y}`}
                    fill="none"
                    className="vc-group-arc"
                    strokeWidth={2 + Math.min(4, a.n)}
                  >
                    <title>{`两个小节之间存在 ${a.n} 条章间连线`}</title>
                  </path>
                ))}

              {/* 人物→章 手动绑定关联线（细虚线，区别于提及出场边） */}
              {showCharacters &&
                (detail?.bindings ?? [])
                  .filter((b) => b.chapterId !== null)
                  .map((b) => {
                    const n = charNodes.find((c) => c.characterId === b.characterId);
                    const cp = positions.get(b.chapterId ?? -1);
                    if (!n || !cp) return null;
                    const a = rectAnchor(
                      { x: n.cx - n.r, y: n.cy - n.r, w: n.r * 2, h: n.r * 2 },
                      { x: cp.x, y: cp.y, w: WORLD_NODE_W, h: WORLD_NODE_H },
                    );
                    const t = rectAnchor(
                      { x: cp.x, y: cp.y, w: WORLD_NODE_W, h: WORLD_NODE_H },
                      { x: n.cx - n.r, y: n.cy - n.r, w: n.r * 2, h: n.r * 2 },
                    );
                    return (
                      <line
                        key={`bind-${b.id}`}
                        x1={a.x}
                        y1={a.y}
                        x2={t.x}
                        y2={t.y}
                        stroke={roleColor(n.role)}
                        strokeWidth={1.4}
                        strokeDasharray='3 4'
                        opacity={0.55}
                        pointerEvents='none'
                      >
                        <title>{`${n.name} 手动关联到此章`}</title>
                      </line>
                    );
                  })}

              {/* 人物拉线中的临时线 */}
              {charConnecting && (
                <line
                  x1={charNodes.find((c) => c.characterId === charConnecting.from)?.cx ?? 0}
                  y1={charNodes.find((c) => c.characterId === charConnecting.from)?.cy ?? 0}
                  x2={charConnecting.x}
                  y2={charConnecting.y}
                  stroke={roleColor('主角')}
                  strokeWidth={1.8}
                  strokeDasharray='5 4'
                  pointerEvents='none'
                />
              )}

              {/* 小节连线（组框 → 组框 / 章节，可拖弯 / 点击编辑） */}
              {groupEdgeItems.map((ge) => {
                const anchors = groupEdgeAnchors(ge);
                if (!anchors) return null;
                const bend = bends.get(ge.key) ?? ge.bend;
                const gDisp = truncate(ge.label || EDGE_TYPE_NAME[ge.edgeType], 12);
                const gFs = labelFontSize(9.5, view.k);
                const len = Math.hypot(anchors.p2.x - anchors.p1.x, anchors.p2.y - anchors.p1.y);
                const geo = edgeGeometry(
                  anchors.p1,
                  anchors.p2,
                  edgeOffsetPx(len, 0, bend),
                  gDisp ? estimateTextWidth(gDisp, gFs) + 16 : 0,
                );
                const gParts = geo.segA && geo.segB ? [geo.segA, geo.segB] : [geo.d];
                const gBendDot = quadPoint(anchors.p1, geo.ctrl, anchors.p2, 0.75);
                const color =
                  ge.edgeType === 4
                    ? 'var(--sm-foreshadow)'
                    : ge.edgeType === 2 || ge.edgeType === 3
                      ? 'var(--sm-branch)'
                      : ge.edgeType === 5
                        ? 'var(--sm-parallel)'
                        : ge.edgeType === 6
                          ? 'var(--sm-flashback)'
                          : 'var(--accent)';
                return (
                  <g key={`ge-${ge.key}`} className="vc-edge">
                    {gParts.map((d, i) => (
                      <path
                        key={i}
                        d={d}
                        fill="none"
                        className="sm-edge-line"
                        stroke={color}
                        strokeDasharray={
                          ge.edgeType === 4 ? '2 5' : ge.edgeType === 2 || ge.edgeType === 3 ? '8 5' : undefined
                        }
                        strokeWidth={2.6}
                        markerEnd={
                          i === gParts.length - 1
                            ? ge.edgeType === 4
                              ? 'url(#vc-arrow-foreshadow)'
                              : 'url(#vc-arrow-accent)'
                            : undefined
                        }
                      />
                    ))}
                    <path
                      d={geo.d}
                      fill="none"
                      className="sm-edge-hit"
                      onPointerDown={(ev) => onGroupEdgePointerDown(ev, ge, 0)}
                    />
                    <circle cx={gBendDot.x} cy={gBendDot.y} r="5" className="sm-edge-bend-dot" />
                    <text
                      x={geo.label.x}
                      y={geo.label.y}
                      textAnchor="middle"
                      dominantBaseline="central"
                      className="vc-label"
                      style={{
                        fill: color,
                        paintOrder: 'stroke',
                        stroke: 'var(--bg)',
                        strokeWidth: 4 * (gFs / 9.5),
                        fontSize: gFs,
                      }}
                    >
                      {gDisp}
                    </text>
                  </g>
                );
              })}

              {/* 出场边（人→章） */}
              {showCharacters &&
                showAppearance &&
                mentions.map((m, i) => {
                  const ch = charNodes.find((c) => c.characterId === m.characterId);
                  const cp = positions.get(m.chapterId);
                  if (!ch || !cp) return null;
                  const dim = focusSets
                    ? focusSets.chapters.has(m.chapterId) && focusSets.chars.has(m.characterId)
                      ? ''
                      : 'dim'
                    : '';
                  return (
                    <line
                      key={`ap-${i}`}
                      x1={ch.cx}
                      y1={ch.cy}
                      x2={cp.x + WORLD_NODE_W / 2}
                      y2={cp.y + WORLD_NODE_H / 2}
                      className={`vc-appearance-line vc-edge${dim ? ' dim' : ''}`}
                      opacity={0.25}
                      strokeWidth={Math.min(3, 0.6 + m.mentionCount * 0.15)}
                    />
                  );
                })}

              {/* 手工章间边 + 卷级章锚伏笔（可拖弯 / 点击编辑） */}
              {edgeItems.map((e) => {
                const a = positions.get(e.from);
                const b = positions.get(e.to);
                if (!a || !b) return null;
                const lane = laneByPlotId.get(e.id) ?? 0;
                const p1 = rectAnchor(
                  { x: a.x, y: a.y, w: WORLD_NODE_W, h: WORLD_NODE_H },
                  { x: b.x, y: b.y, w: WORLD_NODE_W, h: WORLD_NODE_H },
                );
                const p2 = rectAnchor(
                  { x: b.x, y: b.y, w: WORLD_NODE_W, h: WORLD_NODE_H },
                  { x: a.x, y: a.y, w: WORLD_NODE_W, h: WORLD_NODE_H },
                );
                const bend = bends.get(e.key) ?? e.bend;
                const disp = truncate(e.label || EDGE_TYPE_NAME[e.edgeType], 12);
                const dispFs = labelFontSize(9.5, view.k);
                const len = Math.hypot(p2.x - p1.x, p2.y - p1.y);
                const geo = edgeGeometry(
                  p1,
                  p2,
                  edgeOffsetPx(len, lane, bend),
                  disp ? estimateTextWidth(disp, dispFs) + 16 : 0,
                );
                const dParts = geo.segA && geo.segB ? [geo.segA, geo.segB] : [geo.d];
                const bendDotPos = quadPoint(p1, geo.ctrl, p2, 0.75);
                const dim = focusSets
                  ? focusSets.chapters.has(e.from) && focusSets.chapters.has(e.to)
                    ? ''
                    : 'dim'
                  : '';
                const color =
                  e.edgeType === 4
                    ? 'var(--sm-foreshadow)'
                    : e.edgeType === 2 || e.edgeType === 3
                      ? 'var(--sm-branch)'
                      : e.edgeType === 5
                        ? 'var(--sm-parallel)'
                        : e.edgeType === 6
                          ? 'var(--sm-flashback)'
                          : 'var(--accent)';
                return (
                  <g key={`pe-${e.key}`} className={`vc-edge${dim ? ' dim' : ''}`}>
                    {dParts.map((d, i) => (
                      <path
                        key={i}
                        d={d}
                        fill="none"
                        className="sm-edge-line"
                        stroke={color}
                        strokeDasharray={
                          e.edgeType === 4 ? '2 5' : e.edgeType === 2 || e.edgeType === 3 ? '8 5' : undefined
                        }
                        strokeWidth={2.4}
                        markerEnd={
                          i === dParts.length - 1
                            ? e.edgeType === 4
                              ? 'url(#vc-arrow-foreshadow)'
                              : 'url(#vc-arrow-accent)'
                            : undefined
                        }
                      />
                    ))}
                    <path
                      d={geo.d}
                      fill="none"
                      className="sm-edge-hit"
                      onPointerDown={(ev) => onEdgePointerDown(ev, e, lane)}
                    />
                    <circle cx={bendDotPos.x} cy={bendDotPos.y} r="5" className="sm-edge-bend-dot" />
                    <text
                      x={geo.label.x}
                      y={geo.label.y}
                      textAnchor="middle"
                      dominantBaseline="central"
                      className="vc-label"
                      style={{
                        fill: color,
                        paintOrder: 'stroke',
                        stroke: 'var(--bg)',
                        strokeWidth: 4 * (dispFs / 9.5),
                        fontSize: dispFs,
                      }}
                    >
                      {disp}
                    </text>
                  </g>
                );
              })}

              {/* 派生顺序线（相邻章，细弱，不可编辑） */}
              {seqEdges.map((e) => {
                const a = positions.get(e.from);
                const b = positions.get(e.to);
                if (!a || !b) return null;
                const lane = laneByPlotId.get(-100 - e.to) ?? 0;
                const p1 = rectAnchor(
                  { x: a.x, y: a.y, w: WORLD_NODE_W, h: WORLD_NODE_H },
                  { x: b.x, y: b.y, w: WORLD_NODE_W, h: WORLD_NODE_H },
                );
                const p2 = rectAnchor(
                  { x: b.x, y: b.y, w: WORLD_NODE_W, h: WORLD_NODE_H },
                  { x: a.x, y: a.y, w: WORLD_NODE_W, h: WORLD_NODE_H },
                );
                const len = Math.hypot(p2.x - p1.x, p2.y - p1.y);
                const geo = edgeGeometry(p1, p2, edgeOffsetPx(len, lane));
                const dim = focusSets
                  ? focusSets.chapters.has(e.from) && focusSets.chapters.has(e.to)
                    ? ''
                    : 'dim'
                  : '';
                return (
                  <path
                    key={`seq-${e.to}`}
                    d={geo.d}
                    fill="none"
                    className={`vc-edge${dim ? ' dim' : ''}`}
                    stroke="var(--text-faint)"
                    strokeWidth={1.6}
                    markerEnd="url(#vc-arrow)"
                  />
                );
              })}
              {plotOverflow.map((o) => {
                const b = positions.get(o.to);
                if (!b) return null;
                return (
                  <g
                    key={`ovf-${o.from}-${o.to}`}
                    className="sm-overflow-badge"
                    transform={`translate(${b.x + WORLD_NODE_W - 16},${b.y - 12})`}
                  >
                    <circle r="9" />
                    <text textAnchor="middle" dy="3.5">{`+${o.count}`}</text>
                  </g>
                );
              })}

              {/* 人物关系边 */}
              {routedRel.map(({ edge: re, lane }) => {
                const ca = charNodes.find((c) => c.characterId === re.from);
                const cb = charNodes.find((c) => c.characterId === re.to);
                if (!ca || !cb) return null;
                const style = REL_CATEGORY_STYLE[re.edgeType] ?? REL_CATEGORY_STYLE[3];
                const { p0: p1, p1: p2, offset } = circleEdgeEndpoints(
                  ca.cx, ca.cy, ca.r + 2,
                  cb.cx, cb.cy, cb.r + 2,
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
                const dim = focusSets
                  ? focusSets.chars.has(re.from) && focusSets.chars.has(re.to)
                    ? ''
                    : 'dim'
                  : '';
                return (
                  <g key={`re-${re.id}`} className={`vc-edge${dim ? ' dim' : ''}`}>
                    {relParts.map((d, i) => (
                      <path
                        key={i}
                        d={d}
                        fill="none"
                        stroke={style.color}
                        strokeWidth={1.8}
                        strokeDasharray={style.dash}
                        markerEnd={i === relParts.length - 1 && re.direction === 1 ? 'url(#vc-arrow)' : undefined}
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
                      className="vc-label"
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
              })}

              {/* 小节连线拖拽中的临时线 */}
              {gconnecting && groupBoxes.get(gconnecting.fromGroup) && (() => {
                const b = groupBoxes.get(gconnecting.fromGroup)!;
                return (
                  <line
                    x1={b.x + b.w}
                    y1={b.y + b.h / 2}
                    x2={gconnecting.x}
                    y2={gconnecting.y}
                    className="sm-edge-temp"
                  />
                );
              })()}

              {/* 连线拖拽中的临时线 */}
              {connecting && positions.get(connecting.from) && (
                <line
                  x1={(positions.get(connecting.from)?.x ?? 0) + WORLD_NODE_W}
                  y1={(positions.get(connecting.from)?.y ?? 0) + WORLD_NODE_H / 2}
                  x2={connecting.x}
                  y2={connecting.y}
                  className="sm-edge-temp"
                />
              )}

              {/* 章节节点 */}
              {chapters.map((c) => {
                const p = positions.get(c.id);
                if (!p) return null;
                const isSel = selectedChapter === c.id;
                return (
                  <g
                    key={c.id}
                    className={`sm-node vc-chapter-node${isSel ? ' selected' : ''} ${dimChapter(c.id)}`.trim()}
                    transform={`translate(${p.x},${p.y})`}
                    onPointerDown={(e) => onChapterDown(e, c)}
                    onContextMenu={(e) => onChapterContextMenu(e, c)}
                  >
                    <rect
                      className="sm-node-rect"
                      width={WORLD_NODE_W}
                      height={WORLD_NODE_H}
                      rx="10"
                      style={{ stroke: c.status === 1 ? 'var(--ok)' : undefined }}
                    />
                    <text className="sm-node-stage" x="14" y="22">
                      第 {c.globalOrder + 1} 章{c.groupId !== null ? ' · ▦' : ''}
                    </text>
                    <text className="sm-node-title" x="14" y="46">
                      {truncate(c.title, 11)}
                    </text>
                    <text className="sm-node-meta" x="14" y="66">
                      {fmt(c.wordCount)} 字 · {c.status === 1 ? '完稿' : '草稿'}
                    </text>
                    <text className="sm-node-events" x="14" y="84">
                      {c.summary ? truncate(c.summary, 16) : ''}
                    </text>
                    {/* 连线起点圆点 */}
                    <circle
                      className="sm-node-handle"
                      cx={WORLD_NODE_W + 4}
                      cy={WORLD_NODE_H / 2}
                      r="6"
                      onPointerDown={(e) => onConnectDown(e, c)}
                    />
                  </g>
                );
              })}

              {/* 人物节点 */}
              {showCharacters &&
                charNodes.map((c) => {
                  const isFocus = focusChar === c.characterId;
                  const isSel = selectedChar === c.characterId;
                  return (
                    <g
                      key={`c-${c.characterId}`}
                      className={`sm-char-node vc-char-node${isFocus || isSel ? ' focus' : ''} ${dimChar(c.characterId)}`.trim()}
                      transform={`translate(${c.cx},${c.cy})`}
                      onPointerDown={(e) => onCharDown(e, c)}
                      onContextMenu={(e) => onCharContextMenu(e, c.characterId)}
                    >
                      <circle r={Math.max(c.r * 0.7, 7)} className="sm-char-halo" style={{ stroke: roleColor(c.role) }} />
                      <circle r={Math.max(c.r * 0.6, 6)} className="sm-char-body" style={{ fill: roleColor(c.role) }} />
                      <text textAnchor="middle" y={Math.max(c.r * 0.6, 6) + 14} className="sm-char-name sm-char-name-full">
                        {c.name}
                      </text>
                      {/* 拉线圆点：拖到人物建关系，拖到章节绑定 */}
                      <circle
                        className="sm-node-handle vc-char-handle"
                        cx={c.r + 4}
                        cy={-(c.r + 4)}
                        r="4.5"
                        onPointerDown={(e) => onCharHandleDown(e, c.characterId)}
                      />
                      <title>
                        {`${c.name}（${c.role || '未设定'}）\n${c.mentionCount > 0 ? `本卷提及 ${c.mentionCount} 次 · 出场 ${c.chapters.length} 章\n` : '手动关联人物（本卷正文未提及）\n'}拖动移位；圆点拉线：到人物=建关系，到章节=关联`}
                      </title>
                    </g>
                  );
                })}
            </g>
          </svg>
        </div>

        {/* 右侧详情面板 */}
        <aside className="volume-canvas-detail">
          {selChapter ? (
            <ChapterDetailPanel
              key={selChapter.id}
              chapter={selChapter}
              mentions={mentions.filter((m) => m.chapterId === selChapter.id)}
              presence={presence}
              links={edgeItems.filter((e) => e.from === selChapter.id || e.to === selChapter.id)}
              chapterById={chapterById}
              onSelectChar={(id) => {
                setSelectedChar(id);
                setSelectedChapter(null);
              }}
              onOpenContent={() => onOpenChapter(selChapter.id)}
            />
          ) : selChar ? (
            <CharacterDetailPanel
              key={selChar.characterId}
              character={selChar}
              profile={profiles.find((p) => p.id === selChar.characterId)}
              mentions={mentions.filter((m) => m.characterId === selChar.characterId)}
              relations={relations}
              profiles={profiles}
              chapterById={chapterById}
              onSelectChapter={(id) => {
                setSelectedChapter(id);
                setSelectedChar(null);
              }}
              onSelectChar={(id) => setSelectedChar(id)}
              onExit={() => setSelectedChar(null)}
            />
          ) : (
            <VolumeInfoPanel node={node} chapterCount={chapters.length} />
          )}
        </aside>
      </div>

      {/* 建章间边 */}
      {pendingEdge && (
        <ChapterEdgeCreateModal
          from={chapterById.get(pendingEdge.from)!}
          to={chapterById.get(pendingEdge.to)!}
          onClose={() => setPendingEdge(null)}
          onCreated={async () => {
            setPendingEdge(null);
            await load();
            notify();
          }}
        />
      )}

      {/* 编辑章间边 */}
      {editingEdge && (
        <ChapterEdgeEditModal
          item={editingEdge}
          chapterById={chapterById}
          onClose={() => setEditingEdge(null)}
          onChanged={async () => {
            setEditingEdge(null);
            await load();
            notify();
          }}
        />
      )}

      {/* 建小节连线 */}
      {pendingGroupEdge && (
        <GroupEdgeCreateModal
          fromTitle={groupBoxes.get(pendingGroupEdge.fromGroup)?.title ?? '?'}
          toTitle={
            pendingGroupEdge.toGroup !== null
              ? groupBoxes.get(pendingGroupEdge.toGroup)?.title ?? '?'
              : chapterById.get(pendingGroupEdge.toChapter ?? -1)?.title ?? '?'
          }
          onClose={() => setPendingGroupEdge(null)}
          onCreated={async (edgeType, label) => {
            try {
              await api.createGroupEdge({
                volumeId,
                fromGroup: pendingGroupEdge.fromGroup,
                toGroup: pendingGroupEdge.toGroup,
                toChapter: pendingGroupEdge.toChapter,
                edgeType,
                label,
              });
              setPendingGroupEdge(null);
              await load();
              notify();
            } catch (e) {
              showToast(String(e), 'error');
            }
          }}
        />
      )}

      {/* 编辑小节连线 */}
      {editingGroupEdge && (
        <GroupEdgeEditModal
          item={editingGroupEdge}
          groupBoxes={groupBoxes}
          chapterById={chapterById}
          onClose={() => setEditingGroupEdge(null)}
          onChanged={async () => {
            setEditingGroupEdge(null);
            await load();
            notify();
          }}
        />
      )}

      {/* 加入小节 */}
      {groupPicker !== null && (
        <GroupPickerModal
          chapterId={groupPicker}
          groups={groups}
          onClose={() => setGroupPicker(null)}
          onNewGroup={async (title) => {
            try {
              const g = await api.createChapterGroup(volumeId, title);
              await api.setChapterGroup(groupPicker, g.id);
              setGroupPicker(null);
              await load();
              notify();
              showToast(`已创建小节「${title}」并加入`);
            } catch (e) {
              showToast(String(e), 'error');
            }
          }}
          onPick={async (gid) => {
            try {
              await api.setChapterGroup(groupPicker, gid);
              setGroupPicker(null);
              await load();
              notify();
            } catch (e) {
              showToast(String(e), 'error');
            }
          }}
        />
      )}

      {prompt?.kind === 'newGroup' && (
        <PromptModal
          title="新建小节（章节群）"
          placeholder="小节名，如：第一小节 · 初入江湖"
          confirmText="创建"
          onCancel={() => setPrompt(null)}
          onConfirm={async (v) => {
            const title = v.trim();
            setPrompt(null);
            if (!title) return;
            try {
              await api.createChapterGroup(volumeId, title);
              await load();
              notify();
              showToast(`已创建小节「${title}」，右键章节加入，或把章节拖进框内`);
            } catch (e) {
              showToast(String(e), 'error');
            }
          }}
        />
      )}

      {renameGroup && (
        <PromptModal
          title="重命名小节"
          initial={renameGroup.title}
          onCancel={() => setRenameGroup(null)}
          onConfirm={async (v) => {
            const title = v.trim();
            const g = renameGroup;
            setRenameGroup(null);
            if (!title) return;
            try {
              await api.renameChapterGroup(g.id, title);
              await load();
              notify();
            } catch (e) {
              showToast(String(e), 'error');
            }
          }}
        />
      )}

      {/* 建人物关系（画布拉线） */}
      {pendingRelation && (
        <RelationCreateModal
          fromChar={pendingRelation.from}
          toChar={pendingRelation.to}
          fromName={charNodes.find((c) => c.characterId === pendingRelation.from)?.name ?? '?'}
          toName={charNodes.find((c) => c.characterId === pendingRelation.to)?.name ?? '?'}
          defaultScope={volumeId}
          scopeOptions={[{ id: volumeId, title: '仅本卷' }]}
          onClose={() => setPendingRelation(null)}
          onCreated={async () => {
            setPendingRelation(null);
            setRelations(await api.listCharacterRelations(volumeId));
            notify();
          }}
        />
      )}

      {/* 编辑人物关系（点击关系边） */}
      {editingRelation && (
        <RelationEditModal
          relation={editingRelation}
          nameById={new Map(profiles.map((p) => [p.id, p.name]))}
          scopeOptions={[{ id: volumeId, title: '仅本卷' }]}
          onClose={() => setEditingRelation(null)}
          onChanged={async () => {
            setEditingRelation(null);
            setRelations(await api.listCharacterRelations(volumeId));
            notify();
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
                await load();
                notify();
              } catch (err) {
                showToast(String(err), 'error');
              }
            }}
          />
        </Modal>
      )}

      {/* 添加人物到本卷 */}
      {charPick && (
        <CharacterPickModal
          profiles={profiles}
          usedIds={new Set(charNodes.map((c) => c.characterId))}
          title='添加人物到本卷'
          onClose={() => setCharPick(null)}
          onPick={async (p) => {
            try {
              await api.createCharacterBinding({ characterId: p.id, volumeId, chapterId: null });
              await api.setCharVolumePos(p.id, volumeId, charPick.x, charPick.y);
              setCharPick(null);
              await load();
              notify();
              showToast(`已将「${p.name}」加入本卷画布`);
            } catch (e) {
              showToast(String(e), 'error');
            }
          }}
        />
      )}

      {showAdd && (
        <AddChapterModal
          volumeId={volumeId}
          pos={pendingChapterPos}
          onClose={() => {
            setShowAdd(false);
            setPendingChapterPos(null);
          }}
          onDone={async (count) => {
            setShowAdd(false);
            setPendingChapterPos(null);
            await load();
            await refreshTree();
            notify();
            if (count > 0) showToast(`已移入 ${count} 章`);
          }}
        />
      )}
    </div>
  );
}

function truncate(s: string, n: number) {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

// ---------- 详情面板：卷信息（含卷细纲，600ms 防抖自动保存） ----------

function VolumeInfoPanel({ node, chapterCount }: { node: VolumeDetail['node']; chapterCount: number }) {
  const { draft: vDraft, setDraft: setVDraft, error: vError } = useDurableDraft<{ summary: string }>(
    node.id,
    { summary: node.summary },
    async (id, d) => {
      await api.setVolumeSummary(id, d.summary);
      window.dispatchEvent(new Event('nf:story-updated'));
    },
    DEBOUNCE_MS,
  );
  const summary = vDraft.summary;

  const donePct = node.chapterCount > 0 ? Math.round((node.doneChapters / node.chapterCount) * 100) : 0;
  return (
    <>
      <div className="vc-detail-title">
        <span title={node.title}>{node.title}</span>
      </div>
      <div className="vc-detail-meta">
        第 {node.sortOrder + 1} 卷 · {chapterCount} 章 · 完稿 {node.doneChapters}（{donePct}%）·{' '}
        {fmt(node.wordCount)} 字
      </div>
      <div>
        <h4>卷细纲（本卷目标 / 冲突 / 钩子，自动保存）</h4>
        <textarea
          className="input"
          value={summary}
          rows={9}
          placeholder="这一卷写什么？主角目标、核心冲突、结尾钩子……"
          onChange={(e) => setVDraft({ summary: e.target.value })}
        />
        {vError && <div className="draft-error-line">卷细纲保存失败：{vError}</div>}
      </div>
      <div className="info-empty">
        画布操作：拖动章节自由摆放；节点右侧圆点拖出连线；悬停连线拖中点小圆点调弧度、点击编辑；
        右键空白新建章节 / 小节；右键小节重命名 / 纵向对齐；双击章节打开正文。
      </div>
    </>
  );
}

// ---------- 详情面板：章节 ----------

function ChapterDetailPanel({
  chapter,
  mentions,
  presence,
  links,
  chapterById,
  onSelectChar,
  onOpenContent,
}: {
  chapter: VolumeChapterBrief;
  mentions: CharMention[];
  presence: CharacterVolumePresence[];
  links: EdgeItem[];
  chapterById: Map<number, VolumeChapterBrief>;
  onSelectChar: (id: number) => void;
  onOpenContent: () => void;
}) {
  const { draft: cDraft, setDraft: setCDraft, error: cError } = useDurableDraft<{ summary: string; notes: string }>(
    chapter.id,
    { summary: chapter.summary, notes: chapter.notes },
    async (id, d) => {
      await api.setChapterOutline(id, d.summary, d.notes);
      window.dispatchEvent(new Event('nf:story-updated'));
    },
    DEBOUNCE_MS,
  );
  const summary = cDraft.summary;
  const notes = cDraft.notes;

  const charNames = new Map(presence.map((p) => [p.characterId, p.name]));

  return (
    <>
      <div className="vc-detail-title">
        <span title={chapter.title}>{chapter.title}</span>
        <span className="badge-role">{chapter.status === 1 ? '完稿' : '草稿'}</span>
      </div>
      <div className="vc-detail-meta">
        第 {chapter.globalOrder + 1} 章 · {fmt(chapter.wordCount)} 字
      </div>
      <div>
        <h4>本章出场人物（{mentions.length}）</h4>
        {mentions.length === 0 ? (
          <span className="vc-detail-meta">本章暂无已建卡人物出场</span>
        ) : (
          <div className="vc-chip-list">
            {mentions.map((m) => (
              <button key={m.characterId} className="vc-chip" onClick={() => onSelectChar(m.characterId)}>
                <span className="vc-chip-dot" style={{ background: '#5b8def' }} />
                {charNames.get(m.characterId) ?? '?'} · {m.mentionCount}
              </button>
            ))}
          </div>
        )}
      </div>
      <div>
        <h4>本章关联连线（{links.length}）</h4>
        {links.length === 0 ? (
          <span className="vc-detail-meta">无。可从章节节点右侧圆点拖出连线。</span>
        ) : (
          links.map((f) => {
            const other = f.from === chapter.id ? chapterById.get(f.to) : chapterById.get(f.from);
            const isFrom = f.from === chapter.id;
            const color = f.edgeType === 4 ? 'var(--sm-foreshadow)' : 'var(--accent)';
            return (
              <div key={f.key} className="vc-rel-row">
                <span className="vc-rel-swatch" style={{ background: color }} />
                <span>
                  {EDGE_TYPE_NAME[f.edgeType]} {isFrom ? '→' : '←'}{' '}
                  {other ? `《${truncate(other.title, 10)}》` : ''}
                  {f.edgeType === 4 && (
                    <em className="vc-detail-meta">
                      {' '}
                      {f.status === 0 ? '活跃' : f.status === 1 ? '已回收' : '失效'}
                    </em>
                  )}
                  {f.label && f.edgeType !== 4 ? (
                    <em className="vc-detail-meta"> {truncate(f.label, 12)}</em>
                  ) : null}
                </span>
              </div>
            );
          })
        )}
      </div>
      <div>
        <h4>章纲</h4>
        <textarea
          className="input"
          value={summary}
          rows={5}
          placeholder="这一章写什么？（自动保存）"
          onChange={(e) => setCDraft({ summary: e.target.value })}
        />
      </div>
      <div>
        <h4>作者笔记</h4>
        <textarea
          className="input"
          value={notes}
          rows={4}
          placeholder="待改、灵感速记……（不参与导出）"
          onChange={(e) => setCDraft({ notes: e.target.value })}
        />
        {cError && <div className="draft-error-line">章纲保存失败：{cError}</div>}
      </div>
      <button className="btn btn-primary" onClick={onOpenContent}>
        打开正文（进入写作）
      </button>
    </>
  );
}

// ---------- 详情面板：人物 ----------

function CharacterDetailPanel({
  character,
  profile,
  mentions,
  relations,
  profiles,
  chapterById,
  onSelectChapter,
  onSelectChar,
  onExit,
}: {
  character: { characterId: number; name: string; role: string; mentionCount: number; chapters: number[] };
  profile?: CharacterProfile;
  mentions: CharMention[];
  relations: CharacterRelation[];
  profiles: CharacterProfile[];
  chapterById: Map<number, VolumeChapterBrief>;
  onSelectChapter: (id: number) => void;
  onSelectChar: (id: number) => void;
  onExit: () => void;
}) {
  const nameById = new Map(profiles.map((p) => [p.id, p.name]));
  const rels = relations.filter(
    (r) => r.fromChar === character.characterId || r.toChar === character.characterId,
  );
  return (
    <>
      <div className="vc-detail-title">
        <span className="vc-chip-dot" style={{ width: 12, height: 12, background: roleColor(character.role) }} />
        <span>{character.name}</span>
        {character.role && <span className="badge-role">{character.role}</span>}
      </div>
      {profile?.aliases.length ? (
        <div className="vc-detail-meta">别名：{profile.aliases.join('、')}</div>
      ) : null}
      <div className="vc-detail-meta">
        本卷提及 {character.mentionCount} 次 · 出场 {character.chapters.length} 章
      </div>
      {profile?.notes && (
        <div>
          <h4>人物备注</h4>
          <p className="vc-detail-meta" style={{ whiteSpace: 'pre-wrap' }}>{profile.notes}</p>
        </div>
      )}
      <div>
        <h4>本卷出场章节（{mentions.length}）</h4>
        <div className="vc-chip-list">
          {[...mentions]
            .sort(
              (a, b) =>
                (chapterById.get(a.chapterId)?.globalOrder ?? 0) -
                (chapterById.get(b.chapterId)?.globalOrder ?? 0),
            )
            .map((m) => {
              const c = chapterById.get(m.chapterId);
              return (
                <button key={m.chapterId} className="vc-chip" onClick={() => onSelectChapter(m.chapterId)}>
                  {c ? c.title : '?'} · {m.mentionCount}
                </button>
              );
            })}
        </div>
      </div>
      <div>
        <h4>关联人物（{rels.length}）</h4>
        {rels.length === 0 ? (
          <span className="vc-detail-meta">暂无关系。可在顶栏「人物地点」的人物卡中建立关系。</span>
        ) : (
          rels.map((r) => {
            const otherId = r.fromChar === character.characterId ? r.toChar : r.fromChar;
            const style = REL_CATEGORY_STYLE[r.relCategory] ?? REL_CATEGORY_STYLE[3];
            const dirLabel = r.direction === 1 ? (r.fromChar === character.characterId ? '→' : '←') : '—';
            return (
              <div key={r.id} className="vc-rel-row">
                <span className="vc-rel-swatch" style={{ background: style.color }} />
                <span className="vc-rel-name" onClick={() => onSelectChar(otherId)}>
                  {nameById.get(otherId) ?? '?'}
                </span>
                <span className="vc-detail-meta">
                  {dirLabel} {r.relType || style.name}
                  {r.label ? `（${r.label}）` : ''}
                </span>
              </div>
            );
          })
        )}
      </div>
      <button className="btn btn-mini" onClick={onExit}>
        退出人物详情
      </button>
    </>
  );
}

// ---------- 建章间边弹窗 ----------

function ChapterEdgeCreateModal({
  from,
  to,
  onClose,
  onCreated,
}: {
  from: VolumeChapterBrief;
  to: VolumeChapterBrief;
  onClose: () => void;
  onCreated: () => void | Promise<void>;
}) {
  const showToast = useAppStore((s) => s.showToast);
  const [edgeType, setEdgeType] = useState(1);
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);

  const create = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await api.createChapterEdge({
        fromChapter: from.id,
        toChapter: to.id,
        edgeType,
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
      title="建立章间连线"
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
        onKeyDown={(e) => e.key === 'Enter' && void create()}
        placeholder={edgeType === 4 ? '例如：捡到的玉佩暗藏身世之谜' : '例如：这一章的失败直接导致…'}
      />
    </Modal>
  );
}

// ---------- 编辑章间边弹窗 ----------

function ChapterEdgeEditModal({
  item,
  chapterById,
  onClose,
  onChanged,
}: {
  item: EdgeItem;
  chapterById: Map<number, VolumeChapterBrief>;
  onClose: () => void;
  onChanged: () => void | Promise<void>;
}) {
  const showToast = useAppStore((s) => s.showToast);
  const [label, setLabel] = useState(item.label);
  const [status, setStatus] = useState(item.status);
  const from = chapterById.get(item.from);
  const to = chapterById.get(item.to);

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
      title={EDGE_TYPE_NAME[item.edgeType]}
      onClose={onClose}
      footer={
        <>
          <button
            className="btn danger"
            onClick={() =>
              void save(async () => {
                if (item.kind === 'chapter') await api.deleteChapterEdge(item.id);
                else await api.deleteStoryEdge(item.id);
              })
            }
          >
            删除连线
          </button>
          <button
            className="btn btn-primary"
            onClick={() =>
              void save(async () => {
                if (item.kind === 'chapter') await api.updateChapterEdge(item.id, label.trim(), status);
                else await api.updateStoryEdge(item.id, label.trim(), null);
              })
            }
          >
            保存
          </button>
        </>
      }
    >
      <p className="modal-hint">
        《{truncate(from?.title ?? '?', 10)}》 → 《{truncate(to?.title ?? '?', 10)}》
        {item.kind === 'volume' && (
          <span className="edge-anchor-hint">（卷级伏笔的章级锚点）</span>
        )}
      </p>
      <span className="field-label">说明{item.edgeType === 4 ? '（伏笔内容）' : ''}</span>
      <input className="input" value={label} onChange={(e) => setLabel(e.target.value)} />
      {item.edgeType === 4 && item.kind === 'chapter' && (
        <>
          <span className="field-label">伏笔状态</span>
          <div className="edge-type-picker">
            {[0, 1, 2].map((s) => (
              <button
                key={s}
                className={`btn btn-mini${status === s ? ' active' : ''}`}
                onClick={() => setStatus(s)}
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

// ---------- 建小节连线弹窗 ----------

function GroupEdgeCreateModal({
  fromTitle,
  toTitle,
  onClose,
  onCreated,
}: {
  fromTitle: string;
  toTitle: string;
  onClose: () => void;
  onCreated: (edgeType: number, label: string) => void | Promise<void>;
}) {
  const [edgeType, setEdgeType] = useState(1);
  const [label, setLabel] = useState('');
  return (
    <Modal
      title="建立小节连线"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>取消</button>
          <button className="btn btn-primary" onClick={() => void onCreated(edgeType, label.trim())}>
            创建
          </button>
        </>
      }
    >
      <p className="modal-hint">
        ▦ {fromTitle} → {toTitle.startsWith('《') ? toTitle : `▦ ${toTitle}`}
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
        placeholder={edgeType === 4 ? '例如：玉佩之谜在此小节埋下' : '例如：这个小节的失败导致…'}
      />
    </Modal>
  );
}

// ---------- 编辑小节连线弹窗 ----------

function GroupEdgeEditModal({
  item,
  groupBoxes,
  chapterById,
  onClose,
  onChanged,
}: {
  item: GroupEdgeItem;
  groupBoxes: Map<
    number,
    { id: number; title: string; x: number; y: number; w: number; h: number; members: number[] }
  >;
  chapterById: Map<number, VolumeChapterBrief>;
  onClose: () => void;
  onChanged: () => void | Promise<void>;
}) {
  const showToast = useAppStore((s) => s.showToast);
  const [label, setLabel] = useState(item.label);
  const [status, setStatus] = useState(item.status);
  const fromTitle = groupBoxes.get(item.fromGroup)?.title ?? '?';
  const toTitle =
    item.toGroup !== null
      ? groupBoxes.get(item.toGroup)?.title ?? '?'
      : chapterById.get(item.toChapter ?? -1)?.title ?? '?';

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
      title={`小节连线 · ${EDGE_TYPE_NAME[item.edgeType]}`}
      onClose={onClose}
      footer={
        <>
          <button
            className="btn danger"
            onClick={() => void save(() => api.deleteGroupEdge(item.id))}
          >
            删除连线
          </button>
          <button
            className="btn btn-primary"
            onClick={() => void save(() => api.updateGroupEdge(item.id, label.trim(), status))}
          >
            保存
          </button>
        </>
      }
    >
      <p className="modal-hint">
        ▦ {fromTitle} → {item.toGroup !== null ? `▦ ${toTitle}` : `《${truncate(toTitle, 10)}》`}
      </p>
      <span className="field-label">说明{item.edgeType === 4 ? '（伏笔内容）' : ''}</span>
      <input className="input" value={label} onChange={(e) => setLabel(e.target.value)} />
      {item.edgeType === 4 && (
        <>
          <span className="field-label">伏笔状态</span>
          <div className="edge-type-picker">
            {[0, 1, 2].map((st) => (
              <button
                key={st}
                className={`btn btn-mini${status === st ? ' active' : ''}`}
                onClick={() => setStatus(st)}
              >
                {FORESHADOW_STATUS_NAME[st]}
              </button>
            ))}
          </div>
        </>
      )}
    </Modal>
  );
}

// ---------- 加入小节弹窗 ----------

function GroupPickerModal({
  chapterId,
  groups,
  onClose,
  onNewGroup,
  onPick,
}: {
  chapterId: number;
  groups: ChapterGroup[];
  onClose: () => void;
  onNewGroup: (title: string) => void | Promise<void>;
  onPick: (groupId: number) => void | Promise<void>;
}) {
  const [title, setTitle] = useState('');
  return (
    <Modal title="加入小节" onClose={onClose} width={420}>
      <span className="field-label">新建小节并加入</span>
      <div style={{ display: 'flex', gap: 8 }}>
        <input
          className="input"
          value={title}
          placeholder="小节名称"
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && title.trim() && void onNewGroup(title.trim())}
        />
        <button
          className="btn btn-primary btn-mini"
          disabled={!title.trim()}
          onClick={() => void onNewGroup(title.trim())}
        >
          创建并加入
        </button>
      </div>
      {groups.length > 0 && (
        <>
          <span className="field-label">或选择已有小节</span>
          <div className="vc-chip-list">
            {groups.map((g) => (
              <button key={g.id} className="vc-chip" onClick={() => void onPick(g.id)}>
                ▦ {g.title}
              </button>
            ))}
          </div>
        </>
      )}
      <p className="modal-hint" style={{ marginTop: 10 }}>
        章节 #{chapterId} 加入后，可在「小节分组」布局下随组纵排，或拖组框整体移动。
      </p>
    </Modal>
  );
}

// ---------- 章节卡片列表（拖拽排序） ----------

function ChapterCardList({
  chapters,
  onOpen,
  onReorder,
}: {
  chapters: VolumeChapterBrief[];
  onOpen: (id: number) => void;
  onReorder: (id: number, targetIndex: number) => void;
}) {
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);
  return (
    <ul
      className="chapter-card-list"
      onDragOver={(e) => e.preventDefault()}
      onDrop={() => {
        setDragIndex(null);
        setOverIndex(null);
      }}
    >
      {chapters.map((c, i) => (
        <li
          key={c.id}
          className={`vol-chapter-card${overIndex === i ? ' drop-over' : ''}${dragIndex === i ? ' dragging' : ''}`}
          draggable
          onDragStart={() => setDragIndex(i)}
          onDragEnd={() => {
            setDragIndex(null);
            setOverIndex(null);
          }}
          onDragOver={(e) => {
            e.preventDefault();
            setOverIndex(i);
          }}
          onDrop={(e) => {
            e.stopPropagation();
            if (dragIndex !== null && dragIndex !== i) onReorder(chapters[dragIndex].id, i);
            setDragIndex(null);
            setOverIndex(null);
          }}
          onClick={() => onOpen(c.id)}
        >
          <span className="vol-chapter-dot" data-status={c.status} title={c.status === 1 ? '完稿' : '草稿'} />
          <div className="vol-chapter-main">
            <div className="vol-chapter-title">
              <span>{c.title}</span>
              <span className="vol-chapter-words">{fmt(c.wordCount)} 字</span>
            </div>
            {c.summary && <p className="vol-chapter-summary">{c.summary}</p>}
          </div>
          <span className="vol-chapter-order" title="全书章节序">{c.globalOrder + 1}</span>
        </li>
      ))}
    </ul>
  );
}

// ---------- 添加章节弹窗（跨卷移入 / 就地新建） ----------

function AddChapterModal({
  volumeId,
  pos,
  onClose,
  onDone,
}: {
  volumeId: number;
  /** 就地新建的画布位置（归一化），仅新建章节时使用 */
  pos?: { x: number; y: number } | null;
  onClose: () => void;
  onDone: (movedCount: number) => void | Promise<void>;
}) {
  const tree = useAppStore((s) => s.tree)!;
  const showToast = useAppStore((s) => s.showToast);
  const refreshTree = useAppStore((s) => s.refreshTree);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [newTitle, setNewTitle] = useState('');
  const [busy, setBusy] = useState(false);

  const others = tree.volumes
    .filter((v) => v.id !== volumeId)
    .map((v) => ({
      volume: v,
      chapters: tree.chapters.filter((c) => c.volumeId === v.id),
    }))
    .filter((g) => g.chapters.length > 0);

  const toggle = (id: number) => {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const confirm = async () => {
    if (busy) return;
    setBusy(true);
    try {
      if (newTitle.trim()) {
        const ch = await api.createChapter(volumeId, newTitle.trim());
        if (pos) await api.moveChapterNode(ch.id, pos.x, pos.y);
      }
      let insertAt = tree.chapters.filter((c) => c.volumeId === volumeId).length;
      for (const id of picked) {
        await api.moveChapter(id, volumeId, insertAt);
        insertAt += 1;
      }
      await refreshTree();
      await onDone(picked.size + (newTitle.trim() ? 1 : 0));
    } catch (e) {
      showToast(String(e), 'error');
      setBusy(false);
    }
  };

  return (
    <Modal
      title="添加章节到本卷"
      onClose={onClose}
      width={560}
      footer={
        <>
          <button className="btn" onClick={onClose}>取消</button>
          <button
            className="btn btn-primary"
            disabled={busy || (picked.size === 0 && !newTitle.trim())}
            onClick={() => void confirm()}
          >
            添加（{picked.size + (newTitle.trim() ? 1 : 0)}）
          </button>
        </>
      }
    >
      <span className="field-label">
        新建章节（并入本卷末尾{pos ? '，落在画布指定位置' : ''}）
      </span>
      <div className="add-chapter-new">
        <input
          className="input"
          value={newTitle}
          placeholder="章节标题（留空 = 不新建）"
          onChange={(e) => setNewTitle(e.target.value)}
        />
      </div>
      <span className="field-label">从其他卷移入（勾选，跨卷移动原章节）</span>
      {others.length === 0 ? (
        <p className="info-empty">其他卷没有章节。</p>
      ) : (
        <div className="add-chapter-groups">
          {others.map(({ volume, chapters }) => (
            <div key={volume.id} className="add-chapter-group">
              <div className="add-chapter-group-title">
                {volume.title}
                <span className="add-chapter-group-count">{chapters.length} 章</span>
              </div>
              <div className="add-chapter-chips">
                {chapters.map((c) => (
                  <button
                    key={c.id}
                    className={`chip add-chapter-chip${picked.has(c.id) ? ' active' : ''}`}
                    onClick={() => toggle(c.id)}
                    title={`${c.title} · ${fmt(c.wordCount)} 字`}
                  >
                    {c.title.length > 12 ? `${c.title.slice(0, 12)}…` : c.title}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}
