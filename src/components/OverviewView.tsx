/**
 * 全书总览（L2）：剧情线泳道 / 伏笔总览 / 结构总览（V6，设计文档 V1.1）。
 *
 * - 泳道：按 story_arcs 分行，X 轴为全局章节序；跨泳道画桥接线，
 *   hover 高亮同弧线；一眼可见多线并行、断更段、汇合点
 * - 伏笔：列表 + 过滤 + 超期预警（跨度 > 阈值，settings 可配）
 * - 结构：三幕 / 起承转合模板叠加章节轴，显示各阶段字数占比与当前位置
 * - 点击节点 / 伏笔 → 跳到故事地图定位
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import * as api from '../api';
import { useAppStore } from '../store/appStore';
import type { ForeshadowView, StoryGraph } from '../types/models';

type Tab = 'lanes' | 'foreshadow' | 'structure';
type DOMRectLike = { cx: number; cy: number };

const ARC_KIND_NAME = ['主线', '支线', '暗线'];
const FORESHADOW_STATUS_NAME = ['活跃', '已回收', '失效'];
const ARC_PALETTE = ['#5b8def', '#e2b93b', '#b56ad9', '#4fc47f', '#e2734f', '#3bc7d6'];
const arcColor = (id: number, color: string) => color || ARC_PALETTE[id % ARC_PALETTE.length];

/** 结构模板：各阶段名称与章节数占比 */
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
          onJump={focusMapNode}
        />
      )}
      {tab === 'structure' && <StructureView graph={graph} onJump={focusMapNode} />}
    </div>
  );
}

// ---------- a. 剧情线泳道 ----------

function LanesView({ graph, onJump }: { graph: StoryGraph; onJump: (id: number) => void }) {
  const [hoverArc, setHoverArc] = useState<'none' | number | null>(null);
  const nodeById = useMemo(() => new Map(graph.nodes.map((n) => [n.id, n])), [graph]);

  const lanes = useMemo(() => {
    const items: { key: string; arcId: number | null; title: string; color: string | null }[] =
      graph.arcs.map((a) => ({
        key: `arc-${a.id}`,
        arcId: a.id,
        title: `${a.title}（${ARC_KIND_NAME[a.kind] ?? ''}）`,
        color: arcColor(a.id, a.color),
      }));
    if (graph.nodes.some((n) => n.arcId === null)) {
      items.push({ key: 'none', arcId: null, title: '未分类', color: null });
    }
    return items;
  }, [graph]);

  const total = Math.max(graph.nodes.length, 1);
  const orderPct = (order: number) => ((order + 0.5) / total) * 100;
  /** 每条泳道的槽位高度，边桥接时算 y 用 */
  const LANE_H = 68;
  const LABEL_W = 118;

  if (graph.nodes.length === 0) {
    return (
      <div className="overview-body">
        <p className="info-empty">还没有章节。先在三栏写作界面创建章节，再到故事地图排布。</p>
      </div>
    );
  }

  // 边桥接线端点（世界坐标：x=百分比映射到泳道区宽度，用 viewBox 归一）
  const laneYOf = (arcId: number | null) => {
    const idx = lanes.findIndex((l) => l.arcId === arcId);
    return idx * LANE_H + LANE_H / 2;
  };

  const edgeArcOf = (e: (typeof graph.edges)[number]) => {
    if (e.arcId !== null) return e.arcId;
    return nodeById.get(e.fromNode)?.arcId ?? 'none';
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
              const x1 = (a.globalOrder + 0.5) / total * 1000;
              const x2 = (b.globalOrder + 0.5) / total * 1000;
              const y1 = laneYOf(a.arcId);
              const y2 = laneYOf(b.arcId);
              const dim = hoverArc !== null && edgeArcOf(e) !== hoverArc;
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
          const nodes = graph.nodes.filter((n) => n.arcId === lane.arcId);
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
                {nodes.map((n) => (
                  <button
                    key={n.id}
                    className="lane-chip"
                    title={`第 ${n.globalOrder + 1} 章 · ${n.title}`}
                    style={{ left: `${orderPct(n.globalOrder)}%`, borderColor: lane.color ?? undefined }}
                    onClick={() => onJump(n.id)}
                  >
                    <span className="lane-chip-dot" data-status={n.status} />
                    {n.title.length > 6 ? `${n.title.slice(0, 6)}…` : n.title}
                  </button>
                ))}
              </div>
            </div>
          );
        })}

        {/* X 轴刻度（每 5 章） */}
        <div className="lane-axis" style={{ paddingLeft: LABEL_W }}>
          {Array.from({ length: total }, (_, i) => i)
            .filter((i) => i % 5 === 0 || i === total - 1)
            .map((i) => (
              <span key={i} className="lane-axis-tick" style={{ left: `${orderPct(i)}%` }}>
                {i + 1}
              </span>
            ))}
        </div>
      </div>

      {graph.arcs.length === 0 && (
        <p className="info-empty lanes-hint">
          还没有剧情线。到故事地图右上角「剧情线」创建主线 / 支线 / 暗线，再把节点归入，泳道就会分层。
        </p>
      )}
      <div className="lanes-legend">
        <span className="lg lg-cause">因果</span>
        <span className="lg lg-branch">分支 / 汇合</span>
        <span className="lg lg-foreshadow">伏笔回收</span>
        <span className="legend-tip">悬停泳道高亮该线；点击节点跳转故事地图</span>
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
  onJump,
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
  onJump: (id: number) => void;
}) {
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
          没有符合过滤条件的伏笔。在故事地图中拖出「伏笔回收」连线（需填内容）即可登记伏笔。
        </p>
      ) : (
        <table className="foreshadow-table">
          <thead>
            <tr>
              <th>伏笔内容</th>
              <th>埋设章</th>
              <th>回收章</th>
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
                  <button className="link-btn" onClick={() => onJump(f.fromNode)}>
                    {f.fromTitle}
                    {f.fromTrashed && <em>（回收站）</em>}
                  </button>
                </td>
                <td>
                  <button className="link-btn" onClick={() => onJump(f.toNode)}>
                    {f.toTitle}
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

// ---------- c. 结构总览 ----------

function StructureView({ graph, onJump }: { graph: StoryGraph; onJump: (id: number) => void }) {
  const [tplKey, setTplKey] = useState<'three' | 'kishotenketsu'>('three');
  const template = STRUCTURE_TEMPLATES[tplKey];
  const nodes = graph.nodes;
  const totalWords = nodes.reduce((s, n) => s + n.wordCount, 0);

  /** 按章节数占比切分阶段，统计每阶段的章节数 / 字数 / 起止章 */
  const stages = useMemo(() => {
    const n = nodes.length;
    let cursor = 0;
    return template.map((t, i) => {
      const count = i === template.length - 1 ? n - cursor : Math.round(n * t.share);
      const slice = nodes.slice(cursor, cursor + Math.max(count, 0));
      cursor += Math.max(count, 0);
      return {
        ...t,
        chapters: slice.length,
        words: slice.reduce((s, x) => s + x.wordCount, 0),
        first: slice[0]?.id ?? null,
        orderStart: slice[0]?.globalOrder ?? 0,
        orderEnd: slice[slice.length - 1]?.globalOrder ?? -1,
      };
    });
  }, [nodes, template]);

  if (nodes.length === 0) {
    return (
      <div className="overview-body">
        <p className="info-empty">还没有章节，结构总览需要至少一章。</p>
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
        <span className="legend-tip">模板按章节数比例切分阶段；点击阶段跳到该阶段起点</span>
      </div>

      <div className="structure-band">
        {stages.map((s) => (
          <button
            key={s.name}
            className="structure-stage"
            style={{ width: `${(s.chapters / total) * 100}%` }}
            onClick={() => s.first !== null && onJump(s.first)}
            title={`${s.name}：第 ${s.orderStart + 1} ~ ${s.orderEnd + 1} 章`}
          >
            <span className="stage-name">{s.name}</span>
            <span className="stage-chapters">{s.chapters} 章</span>
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
              {s.words.toLocaleString()} 字
            </span>
          </div>
        ))}
      </div>
      <p className="info-empty structure-hint">
        全书共 {total} 章 · {totalWords.toLocaleString()} 字。阶段边界是模板参考值，按你的叙事节奏调整即可。
      </p>
    </div>
  );
}

// 保持 anchor 引用树摇不剔除（泳道坐标计算与其共用语义）
void (null as unknown as DOMRectLike | null);
