/**
 * 画布共享内核（v0.9.13 分形画布）：L1 StoryMap 与 L2 VolumeCanvas 共用。
 *
 * 层间约定（禁止跨层调用）：本模块是纯函数库，不知道「卷 / 章节」是什么，
 * 只消费 CanvasEdge 形状的普通对象。三大职责：
 *  1. 边路由：类型分道（同对节点多边按 edgeType 分泳道，而非按 id 均匀偏移）
 *  2. 贝塞尔几何：路径 + 标签锚点（t=0.78 靠近效应端）
 *  3. 样式表：剧情边 / 关系大类 / 人物角色的颜色与线型
 */
import type { CanvasEdge } from '../../types/models';

/** 泳道基础间距（世界像素） */
export const LANE_HEIGHT = 32;
/** 标签锚定位置：t=0.5（曲线中点，文字嵌在断开的线里） */
export const LABEL_T = 0.5;
/** 同对节点超量合并阈值：渲染前 6 条，多余合并为 +N 徽标 */
export const MAX_EDGES_PER_PAIR = 6;

/** 剧情边类型基准泳道：0中线 / 因果+1 / 分支+2 / 汇合-1 / 伏笔-2 / 平行+3 / 闪回-3 */
const PLOT_BASE_LANE: Record<number, number> = { 0: 0, 1: 1, 2: 2, 3: -1, 4: -2, 5: 3, 6: -3 };

/** 超量合并的渲染优先级：顺序 > 因果 > 伏笔 > 分支 > 汇合 > 平行 > 闪回 */
const PLOT_PRIORITY: Record<number, number> = { 0: 0, 1: 1, 4: 2, 2: 3, 3: 4, 5: 5, 6: 6 };

/** 剧情边样式：色 / 线型 / 名称 */
export const PLOT_EDGE_STYLE: Record<number, { name: string; color: string; dash?: string }> = {
  0: { name: '顺序', color: 'var(--sm-seq, var(--border))' },
  1: { name: '因果', color: 'var(--accent)' },
  2: { name: '分支', color: 'var(--accent)', dash: '6 4' },
  3: { name: '汇合', color: 'var(--accent)', dash: '6 4' },
  4: { name: '伏笔', color: 'var(--sm-foreshadow, #9a6fd0)', dash: '2 4' },
  5: { name: '平行', color: 'var(--sm-parallel, #3bc7d6)' },
  6: { name: '闪回', color: 'var(--sm-flashback, #e2734f)', dash: '5 5' },
};

/** 关系大类样式（v0.9.13 五大关系类）：色 + 线型 + 名称 */
export const REL_CATEGORY_STYLE: Record<
  number,
  { name: string; color: string; dash?: string }
> = {
  1: { name: '血缘', color: '#E1B98F' },
  2: { name: '情感', color: '#EAA7B2' },
  3: { name: '社会', color: '#5b8def' },
  4: { name: '阵营', color: '#EA6668', dash: '6 4' },
  5: { name: '叙事', color: '#B56AD9', dash: '2 4' },
};

/** 关系大类常用子类型（UI 下拉 + 自定义输入） */
export const REL_TYPE_OPTIONS: Record<number, string[]> = {
  1: ['父子', '母子', '父女', '母女', '兄弟', '姐妹', '兄妹', '姐弟', '祖孙', '叔侄', '舅甥', '表亲', '堂亲', '夫妻', '婚约', '其他亲属'],
  2: ['恋人', '夫妻', '暗恋', '前任', '情敌', '暧昧', '知己', '其他情感'],
  3: ['朋友', '挚友', '损友', '师徒', '主仆', '上下级', '同僚', '同学', '战友', '邻居', '网友', '其他社会关系'],
  4: ['盟友', '同伙', '敌人', '仇人', '宿敌', '背叛', '加害', '守护', '竞争', '对手', '其他阵营关系'],
  5: ['引路者', '绊脚石', '镜像', '催化剂', '见证者', '继承者', '其他叙事功能'],
};

/** 人物角色色：主角蓝 / 配角灰 / 反派红 / 龙套（功能性）橙 */
export const ROLE_COLOR: Record<string, string> = {
  主角: '#5b8def',
  配角: '#9aa3b2',
  反派: '#e25b5b',
  龙套: '#e2954f',
};

export const roleColor = (role: string) => ROLE_COLOR[role] || '#9aa3b2';

// ---------- 节点锚点 ----------

/** 矩形节点（w×h，左上角 x,y）边框上朝向另一中心的锚点 */
export function rectAnchor(
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; w: number; h: number },
): { x: number; y: number } {
  const acx = a.x + a.w / 2;
  const acy = a.y + a.h / 2;
  const bcx = b.x + b.w / 2;
  const bcy = b.y + b.h / 2;
  const dx = bcx - acx;
  const dy = bcy - acy;
  if (dx === 0 && dy === 0) return { x: acx, y: acy };
  const sx = dx !== 0 ? a.w / 2 / Math.abs(dx) : Infinity;
  const sy = dy !== 0 ? a.h / 2 / Math.abs(dy) : Infinity;
  const t = Math.min(sx, sy);
  return { x: acx + dx * t, y: acy + dy * t };
}

/** 圆形节点（圆心 cx,cy 半径 r）边框上朝向另一中心的锚点 */
export function circleAnchor(
  cx: number,
  cy: number,
  r: number,
  tx: number,
  ty: number,
): { x: number; y: number } {
  const dx = tx - cx;
  const dy = ty - cy;
  const len = Math.hypot(dx, dy);
  if (len === 0) return { x: cx, y: cy };
  return { x: cx + (dx / len) * r, y: cy + (dy / len) * r };
}

/**
 * 圆形节点对的曲线端点：两端点在各自圆上按泳道角度错开，避免多条平行边的箭头头部重叠。
 *
 * 原理：circleAnchor 用两圆心直线算锚点，所有平行边的终点都落在目标圆同一点 → 箭头重叠。
 * 这里将两端锚点沿圆周旋转一个与 lane 成正比的角度（同向旋转，保持弦大致平行于圆心连线），
 * 终点自然在圆上分开，箭头头部不再重叠；曲线控制点仍按偏移量弯曲，视觉连贯。
 *
 * @param ax,ay 源圆心  @param ar 源圆半径（含边距）
 * @param bx,by 目标圆心 @param br 目标圆半径（含边距）
 * @param lane 泳道系数（来自 routeEdges，可正可负）
 * @returns p0 源圆上起点, p1 目标圆上终点, offset 曲线垂直偏移量（px）
 */
export function circleEdgeEndpoints(
  ax: number,
  ay: number,
  ar: number,
  bx: number,
  by: number,
  br: number,
  lane: number,
): { p0: { x: number; y: number }; p1: { x: number; y: number }; offset: number } {
  const baseAngle = Math.atan2(by - ay, bx - ax); // A→B 方向角
  const angleShift = lane * 0.45; // 每泳道单位 ~25.8°，两条边(lane±0.6)差 ~31°，箭头充分分离
  // 源圆起点：朝向 B，同向旋转 angleShift
  const p0 = {
    x: ax + Math.cos(baseAngle + angleShift) * ar,
    y: ay + Math.sin(baseAngle + angleShift) * ar,
  };
  // 目标圆终点：朝向 A（baseAngle+π），同向旋转 angleShift
  const p1 = {
    x: bx + Math.cos(baseAngle + Math.PI + angleShift) * br,
    y: by + Math.sin(baseAngle + Math.PI + angleShift) * br,
  };
  const len = Math.hypot(p1.x - p0.x, p1.y - p0.y) || 1;
  const offset = edgeOffsetPx(len, lane);
  return { p0, p1, offset };
}

// ---------- 边路由：类型分道 ----------

export interface RoutedEdge {
  edge: CanvasEdge;
  /** 最终泳道（垂直偏移系数 × LANE_HEIGHT） */
  lane: number;
}

export interface RoutingResult {
  /** 参与渲染的边（≤ 每对 MAX_EDGES_PER_PAIR 条） */
  routed: RoutedEdge[];
  /** 超量合并：每对溢出边的汇总（终点旁 +N 徽标） */
  overflow: { from: number; to: number; count: number; hidden: CanvasEdge[] }[];
}

/** 无向配对键（同对节点不分方向归入同组） */
const pairKey = (a: number, b: number) => (a < b ? `${a}-${b}` : `${b}-${a}`);

/**
 * 类型分道：同对节点的多条边按 edgeType 基准泳道错开，
 * 同对同类型多条边再按 subIndex ±0.4 微错（第2条+0.4，第3条-0.4，交替）。
 * 人物关系边（kind='character'）使用独立偏移空间，不与剧情边争道。
 * 每对超过 MAX_EDGES_PER_PAIR 条时按优先级裁剪并输出溢出汇总。
 */
export function routeEdges(edges: CanvasEdge[]): RoutingResult {
  const groups = new Map<string, CanvasEdge[]>();
  for (const e of edges) {
    const key = `${e.kind}:${pairKey(e.from, e.to)}`;
    const arr = groups.get(key);
    if (arr) arr.push(e);
    else groups.set(key, [e]);
  }

  const routed: RoutedEdge[] = [];
  const overflow: RoutingResult['overflow'] = [];

  for (const arr of groups.values()) {
    const isPlot = arr[0].kind !== 'character';
    if (isPlot) {
      arr.sort(
        (a, b) =>
          (PLOT_PRIORITY[a.edgeType] ?? 9) - (PLOT_PRIORITY[b.edgeType] ?? 9) || a.id - b.id,
      );
    } else {
      arr.sort((a, b) => a.id - b.id);
    }
    const keep = arr.slice(0, MAX_EDGES_PER_PAIR);
    if (arr.length > MAX_EDGES_PER_PAIR) {
      overflow.push({
        from: arr[0].from,
        to: arr[0].to,
        count: arr.length - MAX_EDGES_PER_PAIR,
        hidden: arr.slice(MAX_EDGES_PER_PAIR),
      });
    }
    // 同类型 subIndex：按类型分组后在组内居中排列 ±0.4
    const byType = new Map<number, CanvasEdge[]>();
    for (const e of keep) {
      const list = byType.get(e.edgeType);
      if (list) list.push(e);
      else byType.set(e.edgeType, [e]);
    }
    if (isPlot) {
      for (const [type, list] of byType) {
        list.forEach((e, i) => {
          const sub = i - (list.length - 1) / 2;
          const subOffset = sub === 0 ? 0 : (sub > 0 ? 1 : -1) * Math.ceil(Math.abs(sub)) * 0.4;
          const base = PLOT_BASE_LANE[type] ?? 0;
          routed.push({ edge: e, lane: base + subOffset });
        });
      }
    } else {
      // 人物关系：同对所有关系边统一按顺序分配泳道，不按类型分组
      // （按类型分组会导致不同类型的单条边都拿到 lane=0 而完全重叠）
      keep.forEach((e, i) => {
        const sub = i - (keep.length - 1) / 2;
        routed.push({ edge: e, lane: sub * 1.2 });
      });
    }
  }
  return { routed, overflow };
}

// ---------- 贝塞尔几何 ----------

export interface EdgeGeometry {
  /** 完整路径（命中层 / 无标签时渲染） */
  d: string;
  /** 挖去标签间隙后的前段路径（有标签时渲染，无箭头） */
  segA?: string;
  /** 挖去标签间隙后的后段路径（有标签时渲染，箭头挂此段） */
  segB?: string;
  /** 标签锚点（t = LABEL_T，曲线中点，文字居中嵌在缺口里） */
  label: { x: number; y: number };
  /** 曲线中点（与 label 同点，徽标 / 拖弯手柄用） */
  mid: { x: number; y: number };
  /** 曲线终点 */
  end: { x: number; y: number };
  /** 控制点（二次贝塞尔 C，供 t 参数取点） */
  ctrl: { x: number; y: number };
}

type Pt = { x: number; y: number };

const lerpPt = (a: Pt, b: Pt, t: number): Pt => ({
  x: a.x + (b.x - a.x) * t,
  y: a.y + (b.y - a.y) * t,
});

/** 二次贝塞尔上 t 处的点 */
export function quadPoint(p0: Pt, c: Pt, p1: Pt, t: number): Pt {
  const u = 1 - t;
  return {
    x: u * u * p0.x + 2 * t * u * c.x + t * t * p1.x,
    y: u * u * p0.y + 2 * t * u * c.y + t * t * p1.y,
  };
}

/** De Casteljau 在 t 处切一刀：返回 [0,t] 与 [t,1] 两段 */
function splitQuad(p0: Pt, c: Pt, p1: Pt, t: number) {
  const a = lerpPt(p0, c, t);
  const b = lerpPt(c, p1, t);
  const m = lerpPt(a, b, t);
  return { seg: { p0, c: a, p1: m }, rest: { p0: m, c: b, p1 } };
}

/** 取二次贝塞尔的 [t0,t1] 段 */
function quadSegment(p0: Pt, c: Pt, p1: Pt, t0: number, t1: number) {
  if (t0 <= 0.0001) return splitQuad(p0, c, p1, t1).seg;
  const head = splitQuad(p0, c, p1, t1).seg;
  return splitQuad(head.p0, head.c, head.p1, t0 / t1).rest;
}

const quadPath = (seg: { p0: Pt; c: Pt; p1: Pt }) =>
  `M ${seg.p0.x} ${seg.p0.y} Q ${seg.c.x} ${seg.c.y} ${seg.p1.x} ${seg.p1.y}`;

/** 估算文字世界宽度（CJK 全宽，拉丁/数字半宽） */
export function estimateTextWidth(text: string, fontSize: number): number {
  let w = 0;
  for (const ch of text) w += ch.charCodeAt(0) > 0x2e7f ? fontSize : fontSize * 0.55;
  return w;
}

/**
 * 泳道偏移系数 → 垂直偏移像素。基准间距随边长放大：
 * 长边（卷级跨度 800px+）用 32px 弧高几乎看不出弯曲，按边长 12% 放大，
 * 上限 150px 防止短边被过度吹大；用户手动拖弯在此基础上叠加（bend）。
 */
export function laneUnit(len: number): number {
  return Math.min(150, Math.max(LANE_HEIGHT, len * 0.12));
}

/** 总垂直偏移 = 类型泳道 × 基准间距 + 用户拖弯量 */
export function edgeOffsetPx(len: number, lane: number, bend = 0): number {
  return lane * laneUnit(len) + bend;
}

/**
 * 二次贝塞尔边：控制点 = 中点 M + 垂直法线 × offsetPx。
 * P(t) = (1-t)²P₀ + 2t(1-t)C + t²P₁；t=0.78 时权重 0.0484 / 0.3432 / 0.6084。
 */
export function edgeGeometry(
  p0: { x: number; y: number },
  p1: { x: number; y: number },
  offsetPx: number,
  labelGap = 0,
): EdgeGeometry {
  const mx = (p0.x + p1.x) / 2;
  const my = (p0.y + p1.y) / 2;
  const dx = p1.x - p0.x;
  const dy = p1.y - p0.y;
  const len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len;
  const ny = dx / len;
  const ctrl = { x: mx + nx * offsetPx, y: my + ny * offsetPx };
  const label = quadPoint(p0, ctrl, p1, LABEL_T);
  const d =
    offsetPx === 0
      ? `M ${p0.x} ${p0.y} L ${p1.x} ${p1.y}`
      : `M ${p0.x} ${p0.y} Q ${ctrl.x} ${ctrl.y} ${p1.x} ${p1.y}`;

  // 断线嵌字：按弧长在标签两侧各挖 gap/2，曲线切成两段
  let segA: string | undefined;
  let segB: string | undefined;
  if (labelGap > 0) {
    const N = 48;
    let total = 0;
    const pts: { t: number; p: Pt }[] = [];
    for (let i = 0; i <= N; i++) {
      const t = i / N;
      const pt = quadPoint(p0, ctrl, p1, t);
      pts.push({ t, p: pt });
      if (i > 0) total += Math.hypot(pt.x - pts[i - 1].p.x, pt.y - pts[i - 1].p.y);
    }
    if (labelGap < total * 0.7) {
      const half = (total - labelGap) / 2;
      let acc = 0;
      let t0 = LABEL_T;
      let t1 = LABEL_T;
      let found0 = false;
      for (let i = 1; i <= N; i++) {
        const step = Math.hypot(pts[i].p.x - pts[i - 1].p.x, pts[i].p.y - pts[i - 1].p.y);
        if (!found0 && acc + step >= half) {
          t0 = pts[i - 1].t + ((half - acc) / step) * (pts[i].t - pts[i - 1].t);
          found0 = true;
        }
        if (found0 && acc + step >= half + labelGap) {
          t1 = pts[i - 1].t + ((half + labelGap - acc) / step) * (pts[i].t - pts[i - 1].t);
          break;
        }
        acc += step;
      }
      segA = quadPath(quadSegment(p0, ctrl, p1, 0, t0));
      segB = quadPath(quadSegment(p0, ctrl, p1, t1, 1));
    }
  }

  return {
    d,
    segA,
    segB,
    label,
    mid: quadPoint(p0, ctrl, p1, 0.5),
    end: p1,
    ctrl,
  };
}

/** 点 p 相对 p0→p1 直线的垂直分量（有符号，方向 = 直线的左法线） */
export function perpComponent(
  p0: { x: number; y: number },
  p1: { x: number; y: number },
  p: { x: number; y: number },
): number {
  const dx = p1.x - p0.x;
  const dy = p1.y - p0.y;
  const len = Math.hypot(dx, dy) || 1;
  return (-(p.y - p0.y) * dx + (p.x - p0.x) * dy) / len;
}

/**
 * 标签反缩放字号：标签在世界坐标系里随视图缩放，缩小画布时按 k^(-0.55)
 * 放大字号（屏幕上「稍微加粗」），放大时相对收敛（「稍微变细」）。
 * q=1 为完全不补偿（默认 SVG 行为），q=0 为屏幕恒定大小；0.55 取折中。
 */
export function labelFontSize(base: number, k: number, q = 0.45): number {
  const scale = Math.min(3, Math.max(0.5, Math.pow(k, q - 1)));
  return Math.round(base * scale * 10) / 10;
}

/** 标签显隐规则：顺序边语义自明不显示；因果/分支/汇合/伏笔默认显示 */
export function plotLabelVisible(edge: CanvasEdge): boolean {
  return edge.edgeType !== 0 && Boolean(edge.label);
}

// ---------- 布局策略（L2） ----------

export interface LayoutInput {
  /** 节点 id → {x,y} 世界坐标（左上角） */
  positions: Map<number, { x: number; y: number }>;
}

export type LayoutStrategy = 'linear-branch' | 'radial' | 'force' | 'groups';

export const LAYOUT_STRATEGY_NAME: Record<LayoutStrategy, string> = {
  'linear-branch': '线性分支',
  radial: '辐射',
  force: '力导向',
  groups: '小节分组',
};

/** 每种布局一句话用途（切换 toast / 下拉提示共用） */
export const LAYOUT_STRATEGY_DESC: Record<LayoutStrategy, string> = {
  'linear-branch': '主线横排按章序阅读；有伏笔锚点的章节上浮/下沉',
  radial: '提及最多的核心章居中，其余章节环绕一圈',
  force: '有连线的章节互相靠拢、无关联的推开，看连接结构',
  groups: '同小节纵向成列、小节之间横向排开',
};

export const WORLD_NODE_W = 212;
export const WORLD_NODE_H = 92;
export const CHAPTER_STEP_X = 280;

/**
 * linear-branch（L2 默认）：主干横向（按 sortOrder），
 * 有章间边（伏笔锚点边）的支线上下偏移，人物节点由调用方围绕章节派生。
 */
export function layoutLinearBranch(
  chapterIds: number[],
  edges: { from: number; to: number; edgeType: number }[],
  worldCY: number,
): LayoutInput {
  const positions = new Map<number, { x: number; y: number }>();
  // 支线识别：非顺序边（章间伏笔等）的回收章沉到主干下方 160px，埋设章上方 120px
  const targets = new Set(edges.filter((e) => e.edgeType !== 0).map((e) => e.to));
  const sources = new Set(edges.filter((e) => e.edgeType !== 0).map((e) => e.from));
  const branchRows = new Map<number, number>();
  for (const id of targets) branchRows.set(id, (branchRows.get(id) ?? 0) + 1);
  chapterIds.forEach((id, i) => {
    let y = worldCY;
    if (targets.has(id)) y = worldCY + 160 * (branchRows.get(id) ?? 1);
    else if (sources.has(id)) y = worldCY - 120;
    positions.set(id, { x: 80 + i * CHAPTER_STEP_X, y });
  });
  return { positions };
}

/**
 * groups（小节分组）：同小节章节纵向堆叠成列，小节之间横向排开，
 * 未分组章节排在小节列之后。返回每章「左上角」坐标。
 */
export function layoutGroups(
  chapters: { id: number; groupId: number | null }[],
  groupOrder: number[],
): LayoutInput {
  const positions = new Map<number, { x: number; y: number }>();
  const COL_GAP = 340;
  const ROW_GAP = 118;
  const byGroup = new Map<number, number[]>(); // groupId -> chapter ids（按传入顺序）
  const loose: number[] = [];
  for (const c of chapters) {
    if (c.groupId !== null) {
      const arr = byGroup.get(c.groupId);
      if (arr) arr.push(c.id);
      else byGroup.set(c.groupId, [c.id]);
    } else {
      loose.push(c.id);
    }
  }
  let col = 0;
  for (const gid of groupOrder) {
    const members = byGroup.get(gid);
    if (!members) continue;
    members.forEach((id, i) => {
      positions.set(id, { x: 100 + col * COL_GAP, y: 140 + i * ROW_GAP });
    });
    col += 1;
  }
  loose.forEach((id, i) => {
    positions.set(id, { x: 100 + col * COL_GAP, y: 140 + i * ROW_GAP });
  });
  return { positions };
}

/**
 * radial：核心冲突（出场提及最多的章节）居中，其余章节在正圆上均匀环绕
 * （半径随章节数增加，保证任意数量都呈清晰的辐射状）。
 */
export function layoutRadial(
  chapters: { id: number; weight: number }[],
  worldCX: number,
  worldCY: number,
): LayoutInput {
  const positions = new Map<number, { x: number; y: number }>();
  if (chapters.length === 0) return { positions };
  const sorted = [...chapters].sort((a, b) => b.weight - a.weight);
  const core = sorted[0];
  positions.set(core.id, { x: worldCX - WORLD_NODE_W / 2, y: worldCY - WORLD_NODE_H / 2 });
  const rest = sorted.slice(1);
  if (rest.length > 0) {
    const R = Math.max(250, rest.length * 85);
    rest.forEach((c, i) => {
      const angle = (i / rest.length) * Math.PI * 2 - Math.PI / 2;
      positions.set(c.id, {
        x: worldCX + Math.cos(angle) * R - WORLD_NODE_W / 2,
        y: worldCY + Math.sin(angle) * R - WORLD_NODE_H / 2,
      });
    });
  }
  return { positions };
}

/**
 * force：力导向（连线吸引 + 节点互斥 + 中心引力，300 次迭代）。
 * 有连线的章节聚拢成簇、无关联的推开，结构由数据本身决定。
 */
export function layoutForce(
  ids: number[],
  edges: { from: number; to: number }[],
  worldCX: number,
  worldCY: number,
): LayoutInput {
  const pos = new Map<number, { x: number; y: number }>();
  const n = ids.length;
  // 初始布局：小圆环（确定性，避免每次切换结果漂移）
  ids.forEach((id, i) => {
    const angle = (i / Math.max(1, n)) * Math.PI * 2;
    pos.set(id, {
      x: worldCX + Math.cos(angle) * 260,
      y: worldCY + Math.sin(angle) * 190,
    });
  });
  const REPULSION = 90000;
  const ATTRACTION = 0.02;
  const GRAVITY = 0.03;
  for (let iter = 0; iter < 300; iter++) {
    const fx = new Map<number, number>();
    const fy = new Map<number, number>();
    for (const a of ids) {
      fx.set(a, 0);
      fy.set(a, 0);
    }
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const a = ids[i];
        const b = ids[j];
        const pa = pos.get(a)!;
        const pb = pos.get(b)!;
        let dx = pa.x - pb.x;
        let dy = pa.y - pb.y;
        let d2 = dx * dx + dy * dy;
        if (d2 < 1) {
          dx = Math.random() - 0.5;
          dy = Math.random() - 0.5;
          d2 = 1;
        }
        const f = REPULSION / d2;
        const d = Math.sqrt(d2);
        fx.set(a, fx.get(a)! + (dx / d) * f);
        fy.set(a, fy.get(a)! + (dy / d) * f);
        fx.set(b, fx.get(b)! - (dx / d) * f);
        fy.set(b, fy.get(b)! - (dy / d) * f);
      }
    }
    for (const e of edges) {
      if (!pos.has(e.from) || !pos.has(e.to)) continue;
      const pa = pos.get(e.from)!;
      const pb = pos.get(e.to)!;
      const dx = pb.x - pa.x;
      const dy = pb.y - pa.y;
      fx.set(e.from, fx.get(e.from)! + dx * ATTRACTION);
      fy.set(e.from, fy.get(e.from)! + dy * ATTRACTION);
      fx.set(e.to, fx.get(e.to)! - dx * ATTRACTION);
      fy.set(e.to, fy.get(e.to)! - dy * ATTRACTION);
    }
    for (const a of ids) {
      // 中心引力：防止整体漂出世界中心
      const p = pos.get(a)!;
      fx.set(a, fx.get(a)! + (worldCX - p.x) * GRAVITY);
      fy.set(a, fy.get(a)! + (worldCY - p.y) * GRAVITY);
    }
    for (const a of ids) {
      const p = pos.get(a)!;
      p.x = Math.max(60, Math.min(3200, p.x + Math.max(-30, Math.min(30, fx.get(a)!))));
      p.y = Math.max(60, Math.min(2200, p.y + Math.max(-30, Math.min(30, fy.get(a)!))));
    }
  }
  // 转「左上角」坐标
  const positions = new Map<number, { x: number; y: number }>();
  for (const [id, p] of pos) positions.set(id, { x: p.x - WORLD_NODE_W / 2, y: p.y - WORLD_NODE_H / 2 });
  return { positions };
}
