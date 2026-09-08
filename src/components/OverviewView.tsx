/**
 * 全书总览（支撑视图，V7 设计文档 V1.1）：剧情线泳道 / 伏笔总览 / 结构总览。
 *
 * - 泳道：X 轴 = 卷顺序（节点 = 卷）；泳道 = 剧情线（story_arcs），
 *   卷经由「归属于该线的连线」进入泳道；跨泳道桥接线，hover 高亮该线，
 *   一眼可见多线并行、断档（弧线空缺的卷段）与汇合点
 * - 伏笔：列表 + 过滤 + 超期预警（跨度 > 阈值，settings 可配）；
 *   位置粒度 = 卷级或「第N卷·第M章」，章级锚点可跳正文
 * - 结构：三幕 / 起承转合模板叠加卷轴（一卷一阶段通常天然吻合）
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import * as api from '../api';
import { useAppStore } from '../store/appStore';
import { useEditorStore } from '../store/editorStore';
import type { ForeshadowView, StoryGraph } from '../types/models';
import { fmt } from '../utils/text';

type Tab = 'lanes' | 'foreshadow' | 'structure';

const ARC_KIND_NAME = ['主线', '支线', '暗线'];
const FORESHADOW_STATUS_NAME = ['活跃', '已回收', '失效'];
const ARC_PALETTE = ['#5b8def', '#e2b93b', '#b56ad9', '#4fc47f', '#e2734f', '#3bc7d6'];
const arcColor = (id: number, color: string) => color || ARC_PALETTE[id % ARC_PALETTE.length];

/** 结构模板：各阶段名称与卷数占比 */
const STRUCTURE_TEMPLATES: Record<string, { name: string; share: number }[]> = {
  three: [
    { name: '第一幕·设置', share: 0.25 },
    { name: '第二幕·对抗', share: 0.5 },
    { name: '第三幕·解决', share: 0.25 },
  ],
  kishotenketsu: [
    { name: '起', share: 0.1 },
    { name: '承', share: 0.3 },
    { name: '转', share: 0.3 },
    { name: '合', share: 0.3 },
  ],
};

export function OverviewView() {
  const showToast = useAppStore((s) => s.showToast);
  const focusMapNode = useAppStore((s) => s.focusMapNode);
  const [tab, setTab] = useState<Tab>('lanes');
  const [graph, setGraph] = useState<StoryGraph | null>(null);
  const [foreshadows, setForeshadows] = useState<ForeshadowView[]>([]);
  const [threshold, setThreshold] = useState(10);
  const [thresholdDraft, setThresholdDraft] = useState('10');
  const [statusFilter, setStatusFilter] = useState<'all' | 0 | 1 | 2>('all');
  const [arcFilter, setArcFilter] = useState<'all' | number>('all');

  const loadAll = useCallback(async () => {
    try {
      const [g, f, t] = await Promise.all([
        api.listStoryGraph(),
        api.listForeshadows(),
        api.getForeshadowThreshold(),
      ]);
      setGraph(g);
      setForeshadows(f);
      setThreshold(t);
      setThresholdDraft(String(t));
    } catch (e) {
      showToast(String(e), 'error');
    }
  }, [showToast]);

  useEffect(() => {
    void loadAll();
    const h = () => void loadAll();
    window.addEventListener('nf:story-updated', h);
    return () => window.removeEventListener('nf:story-updated', h);
  }, [loadAll]);

  const saveThreshold = async () => {
    const n = Number(thresholdDraft);
    if (!Number.isFinite(n) || n < 1) return;
    try {
      await api.setForeshadowThreshold(Math.floor(n));
      await loadAll();
      showToast('超期阈值已更新');
    } catch (e) {
      showToast(String(e), 'error');
    }
  };

  if (!graph) {
    return <div className="overview-view"><div className="story-map-empty">全书总览加载中…</div></div>;
  }

  const filteredForeshadows = foreshadows.filter(
    (f) =>
      (statusFilter === 'all' || f.status === statusFilter) &&
      (arcFilter === 'all' || f.arcId === arcFilter),
  );

  return (
    <div className="overview-view">
      <div className="overview-tabs">
        <button className={`btn btn-mini${tab === 'lanes' ? ' active' : ''}`} onClick={() => setTab('lanes')}>
          剧情线泳道
        </button>
        <button className={`btn btn-mini${tab === 'foreshadow' ? ' active' : ''}`} onClick={() => setTab('foreshadow')}>
          伏笔总览（{foreshadows.filter((f) => f.status === 0).length} 活跃）
        </button>
        <button className={`btn btn-mini${tab === 'structure' ? ' active' : ''}`} onClick={() => setTab('structure')}>
          结构总览
        </button>
      </div>

      {tab === 'lanes' && <LanesView graph={graph} onJump={focusMapNode} />}
      {tab === 'foreshadow' && (
        <ForeshadowTable
          rows={filteredForeshadows}
          arcs={graph.arcs}
          statusFilter={statusFilter}
          arcFilter={arcFilter}
          threshold={threshold}
          thresholdDraft={thresholdDraft}
          onStatusFilter={setStatusFilter}
          onArcFilter={setArcFilter}
          onThresholdDraft={setThresholdDraft}
          onSaveThreshold={() => void saveThreshold()}
        />
      )}
      {tab === 'structure' && <StructureView graph={graph} onJump={focusMapNode} />}
    </div>
  );
}

// ---------- a. 剧情线泳道（X 轴 = 卷顺序） ----------

function LanesView({ graph, onJump }: { graph: StoryGraph; onJump: (volumeId: number) => void }) {
  const [hoverArc, setHoverArc] = useState<'none' | number | null>(null);

  const nodes = useMemo(
    () => [...graph.nodes].sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id),
    [graph.nodes],
  );
  const nodeById = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);

  /** 每条弧线覆盖的卷集合（经由归属于该线的连线） */
  const arcVolumes = useMemo(() => {
    const map = new Map<number, Set<number>>();
    for (const e of graph.edges) {
      if (e.arcId === null) continue;
      const set = map.get(e.arcId) ?? new Set<number>();
      set.add(e.fromNode);
      set.add(e.toNode);
      map.set(e.arcId, set);
    }
    return map;
  }, [graph.edges]);

  const lanes = useMemo(() => {
    const items: { key: string; arcId: number | null; title: string; color: string | null }[] =
      graph.arcs
        .filter((a) => arcVolumes.has(a.id))
        .map((a) => ({
          key: `arc-${a.id}`,
          arcId: a.id,
          title: `${a.title}（${ARC_KIND_NAME[a.kind] ?? ''}）`,
          color: arcColor(a.id, a.color),
        }));
    const covered = new Set<number>();
    for (const set of arcVolumes.values()) {
      for (const v of set) covered.add(v);
    }
    if (nodes.some((n) => !covered.has(n.id))) {
      items.push({ key: 'none', arcId: null, title: '未分类', color: null });
    }
    return items;
  }, [graph.arcs, arcVolumes, nodes]);

  const total = Math.max(nodes.length, 1);
  const orderPct = (order: number) => ((order + 0.5) / total) * 100;
  const LANE_H = 68;
  const LABEL_W = 118;

  if (nodes.length === 0) {
    return (
      <div className="overview-body">
        <p className="info-empty">还没有卷。到故事地图「新建卷」建立第一个故事阶段。</p>
      </div>
    );
  }

  const laneYOf = (arcId: number | null) => {
    const idx = lanes.findIndex((l) => l.arcId === arcId);
    return idx * LANE_H + LANE_H / 2;
  };

  return (
    <div className="overview-body lanes-scroll">
      <div className="lanes-wrap" style={{ position: 'relative' }}>
        {/* 桥接线（跨泳道），跳过顺序边（相邻关系由排布本身表达） */}
        <svg
          className="lanes-edges"
          width="100%"
          height={lanes.length * LANE_H}
          viewBox={`0 0 1000 ${lanes.length * LANE_H}`}
          preserveAspectRatio="none"
        >
          {graph.edges
            .filter((e) => e.edgeType !== 0)
            .map((e) => {
              const a = nodeById.get(e.fromNode);
              const b = nodeById.get(e.toNode);
              if (!a || !b) return null;
              const x1 = ((a.sortOrder + 0.5) / total) * 1000;
              const x2 = ((b.sortOrder + 0.5) / total) * 1000;
              const y1 = laneYOf(e.arcId);
              const y2 = laneYOf(e.arcId);
              const dim = hoverArc !== null && e.arcId !== hoverArc;
              const my = (y1 + y2) / 2;
              return (
                <path
                  key={e.id}
                  className={`ov-edge et-${e.edgeType}${dim ? ' dim' : ''}`}
                  d={`M ${x1} ${y1} C ${x1} ${my}, ${x2} ${my}, ${x2} ${y2}`}
                  data-status={e.status}
                />
              );
            })}
        </svg>

        {lanes.map((lane) => {
          const inLane = nodes.filter((n) =>
            lane.arcId === null
              ? ![...arcVolumes.values()].some((s) => s.has(n.id))
              : arcVolumes.get(lane.arcId)?.has(n.id),
          );
          const dim = hoverArc !== null && hoverArc !== lane.arcId;
          return (
            <div
              key={lane.key}
              className={`lane-row${dim ? ' dim' : ''}`}
              style={{ height: LANE_H }}
              onMouseEnter={() => setHoverArc(lane.arcId)}
              onMouseLeave={() => setHoverArc(null)}
            >
              <div className="lane-label" style={lane.color ? { color: lane.color } : undefined}>
                {lane.title}
              </div>
              <div className="lane-track">
                {inLane.map((n) => (
                  <button
                    key={n.id}
                    className="lane-chip"
                    title={`第 ${n.sortOrder + 1} 卷 · ${n.title} · ${n.chapterCount} 章`}
                    style={{ left: `${orderPct(n.sortOrder)}%`, borderColor: lane.color ?? undefined }}
                    onClick={() => onJump(n.id)}
                  >
                    <span className="lane-chip-dot" data-done={n.chapterCount > 0 && n.doneChapters === n.chapterCount ? '1' : '0'} />
                    {n.title.length > 8 ? `${n.title.slice(0, 8)}…` : n.title}
                  </button>
                ))}
              </div>
            </div>
          );
        })}

        {/* X 轴刻度（每卷） */}
        <div className="lane-axis" style={{ paddingLeft: LABEL_W }}>
          {nodes.map((n) => (
            <span key={n.id} className="lane-axis-tick" style={{ left: `${orderPct(n.sortOrder)}%` }}>
              卷{n.sortOrder + 1}
            </span>
          ))}
        </div>
      </div>

      {graph.arcs.length === 0 && (
        <p className="info-empty lanes-hint">
          还没有剧情线。到故事地图右上角「剧情线」创建主线 / 支线 / 暗线，建连线时归入，泳道就会分层。
        </p>
      )}
      <div className="lanes-legend">
        <span className="lg lg-cause">因果</span>
        <span className="lg lg-branch">分支 / 汇合</span>
        <span className="lg lg-foreshadow">伏笔回收</span>
        <span className="legend-tip">悬停泳道高亮该线；点击卷跳转故事地图</span>
      </div>
    </div>
  );
}

// ---------- b. 伏笔总览 ----------

function ForeshadowTable({
  rows,
  arcs,
  statusFilter,
  arcFilter,
  threshold,
  thresholdDraft,
  onStatusFilter,
  onArcFilter,
  onThresholdDraft,
  onSaveThreshold,
}: {
  rows: ForeshadowView[];
  arcs: StoryGraph['arcs'];
  statusFilter: 'all' | 0 | 1 | 2;
  arcFilter: 'all' | number;
  threshold: number;
  thresholdDraft: string;
  onStatusFilter: (v: 'all' | 0 | 1 | 2) => void;
  onArcFilter: (v: 'all' | number) => void;
  onThresholdDraft: (v: string) => void;
  onSaveThreshold: () => void;
}) {
  const focusMapNode = useAppStore((s) => s.focusMapNode);
  const selectChapter = useAppStore((s) => s.selectChapter);

  /** 位置跳转：章级锚点 → 打开正文；卷级 → 地图定位 */
  const jump = (chapterId: number | null, volumeId: number) => {
    if (chapterId !== null) {
      selectChapter(chapterId);
      void useEditorStore.getState().loadChapter(chapterId);
      useAppStore.getState().setViewMode('editor');
    } else {
      focusMapNode(volumeId);
    }
  };

  return (
    <div className="overview-body">
      <div className="filter-chips foreshadow-filter">
        {(['all', 0, 1, 2] as const).map((s) => (
          <button
            key={s}
            className={`chip${statusFilter === s ? ' active' : ''}`}
            onClick={() => onStatusFilter(s)}
          >
            {s === 'all' ? '全部' : FORESHADOW_STATUS_NAME[s]}
          </button>
        ))}
        <select
          className="select select-mini"
          value={arcFilter}
          onChange={(e) => onArcFilter(e.target.value === 'all' ? 'all' : Number(e.target.value))}
        >
          <option value="all">全部剧情线</option>
          {arcs.map((a) => (
            <option key={a.id} value={a.id}>{a.title}</option>
          ))}
        </select>
        <span className="foreshadow-threshold">
          超期阈值
          <input
            className="input input-mini"
            type="number"
            min={1}
            max={500}
            value={thresholdDraft}
            onChange={(e) => onThresholdDraft(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && onSaveThreshold()}
          />
          章
          <button className="btn btn-mini" onClick={onSaveThreshold}>应用</button>
        </span>
      </div>

      {rows.length === 0 ? (
        <p className="info-empty">
          没有符合过滤条件的伏笔。在故事地图中拖出「伏笔回收」连线（需填内容）即可登记伏笔，
          可精确锚定到埋设章 / 回收章。
        </p>
      ) : (
        <table className="foreshadow-table">
          <thead>
            <tr>
              <th>伏笔内容</th>
              <th>埋设位置</th>
              <th>回收位置</th>
              <th>跨度</th>
              <th>状态</th>
              <th>剧情线</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((f) => (
              <tr key={f.id} className={f.status === 2 ? ' invalidated' : ''}>
                <td className="fs-label" title={f.label}>{f.label || '（未命名）'}</td>
                <td>
                  <button className="link-btn" title={f.fromDesc} onClick={() => jump(f.fromChapterId, f.fromNode)}>
                    {f.fromDesc}
                    {f.fromTrashed && <em>（回收站）</em>}
                  </button>
                </td>
                <td>
                  <button className="link-btn" title={f.toDesc} onClick={() => jump(f.toChapterId, f.toNode)}>
                    {f.toDesc}
                    {f.toTrashed && <em>（回收站）</em>}
                  </button>
                </td>
                <td>
                  {f.span > 0 ? `${f.span} 章` : '—'}
                  {f.overdue && (
                    <span className="fs-overdue" title={`跨度超过 ${threshold} 章`}>⚠ 超期</span>
                  )}
                </td>
                <td>
                  <span className={`fs-status st-${f.status}`}>{FORESHADOW_STATUS_NAME[f.status]}</span>
                </td>
                <td>{f.arcId !== null ? arcs.find((a) => a.id === f.arcId)?.title ?? '—' : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

// ---------- c. 结构总览（叠加卷轴） ----------

function StructureView({ graph, onJump }: { graph: StoryGraph; onJump: (volumeId: number) => void }) {
  const [tplKey, setTplKey] = useState<'three' | 'kishotenketsu'>('three');
  const template = STRUCTURE_TEMPLATES[tplKey];
  const nodes = useMemo(
    () => [...graph.nodes].sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id),
    [graph.nodes],
  );
  const totalWords = nodes.reduce((s, n) => s + n.wordCount, 0);

  /** 按卷数占比切分阶段，统计每阶段的卷数 / 字数 / 起止卷 */
  const stages = useMemo(() => {
    const n = nodes.length;
    let cursor = 0;
    return template.map((t, i) => {
      const count = i === template.length - 1 ? n - cursor : Math.round(n * t.share);
      const slice = nodes.slice(cursor, cursor + Math.max(count, 0));
      cursor += Math.max(count, 0);
      return {
        ...t,
        volumes: slice.length,
        chapters: slice.reduce((s, x) => s + x.chapterCount, 0),
        words: slice.reduce((s, x) => s + x.wordCount, 0),
        first: slice[0]?.id ?? null,
        orderStart: slice[0]?.sortOrder ?? 0,
        orderEnd: slice[slice.length - 1]?.sortOrder ?? -1,
      };
    });
  }, [nodes, template]);

  if (nodes.length === 0) {
    return (
      <div className="overview-body">
        <p className="info-empty">还没有卷，结构总览需要至少一卷。</p>
      </div>
    );
  }

  const total = nodes.length;

  return (
    <div className="overview-body">
      <div className="structure-picker">
        {Object.entries({ three: '三幕式', kishotenketsu: '起承转合' }).map(([k, name]) => (
          <button
            key={k}
            className={`btn btn-mini${tplKey === k ? ' active' : ''}`}
            onClick={() => setTplKey(k as 'three' | 'kishotenketsu')}
          >
            {name}
          </button>
        ))}
        <span className="legend-tip">模板按卷数比例切分阶段（一卷一阶段通常天然吻合）；点击阶段跳到该阶段起点</span>
      </div>

      <div className="structure-band">
        {stages.map((s) => (
          <button
            key={s.name}
            className="structure-stage"
            style={{ width: `${(s.volumes / total) * 100}%` }}
            onClick={() => s.first !== null && onJump(s.first)}
            title={`${s.name}：第 ${s.orderStart + 1} ~ ${s.orderEnd + 1} 卷`}
          >
            <span className="stage-name">{s.name}</span>
            <span className="stage-chapters">{s.volumes} 卷 · {fmt(s.chapters)} 章</span>
          </button>
        ))}
      </div>

      <div className="structure-words">
        {stages.map((s) => (
          <div key={s.name} className="structure-word-row">
            <span className="stage-name">{s.name}</span>
            <div className="word-bar">
              <div
                className="word-bar-fill"
                style={{ width: `${totalWords > 0 ? (s.words / totalWords) * 100 : 0}%` }}
              />
            </div>
            <span className="word-num">
              {totalWords > 0 ? Math.round((s.words / totalWords) * 100) : 0}% ·{' '}
              {fmt(s.words)} 字
            </span>
          </div>
        ))}
      </div>
      <p className="info-empty structure-hint">
        全书共 {total} 卷 · {fmt(graph.nodes.reduce((s, n) => s + n.chapterCount, 0))} 章 ·{' '}
        {fmt(totalWords)} 字。阶段边界是模板参考值，按你的叙事节奏调整即可。
      </p>
    </div>
  );
}
