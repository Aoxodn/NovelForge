/**
 * 路线图工具集：伏笔台账 / 时间轴 / 看板 / 设定词条 / POV / 称谓 / 文风。
 * 挂载于 ProjectView，按 viewMode 切换。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useAppStore } from "../../store/appStore";
import * as api from "../../api";
import type {
  AddressDriftHit,
  AddressForm,
  BoardCard,
  CharacterProfile,
  CharacterStateSnapshot,
  ForeshadowItem,
  LoreEntry,
  PovDashboard,
  StructureSnapshotMeta,
  StyleFingerprint,
  StoryArc,
  TimelineNode,
} from "../../types/models";
import { Modal } from "../Modal";
import "../../styles/roadmap.css";

const FS_TYPES = ["悬念", "信物", "谎言", "预言", "其他"];
const FS_STATUS = ["活跃", "已回收", "失效"];
const LANES = ["构思", "细纲", "初稿", "修订", "定稿"];
const LORE_KINDS = [
  { key: "concept", label: "概念" },
  { key: "place", label: "地点" },
  { key: "faction", label: "势力" },
  { key: "item", label: "器物" },
  { key: "rule", label: "规则" },
  { key: "event", label: "事件" },
];

function ToolShell(props: {
  title: string;
  subtitle?: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="nf-roadmap">
      <header className="nf-roadmap__head">
        <div>
          <h2>{props.title}</h2>
          {props.subtitle ? (
            <p className="nf-roadmap__sub">{props.subtitle}</p>
          ) : null}
        </div>
        <div className="nf-roadmap__actions">{props.actions}</div>
      </header>
      <div className="nf-roadmap__body">{props.children}</div>
    </div>
  );
}

// ---------- 伏笔台账 ----------

export function ForeshadowLedger() {
  const tree = useAppStore((s) => s.tree);
  const activeArcId = useAppStore((s) => s.activeArcId);
  const selectChapter = useAppStore((s) => s.selectChapter);
  const setViewMode = useAppStore((s) => s.setViewMode);
  const showToast = useAppStore((s) => s.showToast);
  const [items, setItems] = useState<ForeshadowItem[]>([]);
  const [statusFilter, setStatusFilter] = useState(-1);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState({
    title: "",
    foreshadowType: 0,
    plantChapterId: 0,
    expectChapterId: 0,
    arcId: 0,
    note: "",
  });

  const reload = useCallback(async () => {
    try {
      const all = await api.listForeshadowLedger();
      setItems(
        activeArcId > 0 ? all.filter((f) => f.arcId === activeArcId) : all,
      );
    } catch (e) {
      showToast(String(e), "error");
    }
  }, [activeArcId, showToast]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const chapters = tree?.chapters ?? [];
  const [arcs, setArcs] = useState<StoryArc[]>([]);

  useEffect(() => {
    void api
      .listStoryArcs()
      .then(setArcs)
      .catch(() => setArcs([]));
  }, []);

  const visible = items.filter((f) => statusFilter < 0 || f.status === statusFilter);
  const overdue = items.filter((f) => f.overdue).length;
  const active = items.filter((f) => f.status === 0).length;

  const onCreate = async () => {
    if (!draft.title.trim()) return;
    try {
      await api.createForeshadow({
        title: draft.title,
        foreshadowType: draft.foreshadowType,
        plantChapterId: draft.plantChapterId || null,
        expectChapterId: draft.expectChapterId || null,
        arcId: draft.arcId || null,
        note: draft.note,
      });
      setCreating(false);
      setDraft({
        title: "",
        foreshadowType: 0,
        plantChapterId: 0,
        expectChapterId: 0,
        arcId: 0,
        note: "",
      });
      await reload();
      showToast("伏笔已埋设");
    } catch (e) {
      showToast(String(e), "error");
    }
  };

  const markResolved = async (id: number) => {
    try {
      await api.updateForeshadow(id, { status: 1 });
      await reload();
      showToast("已标记回收");
    } catch (e) {
      showToast(String(e), "error");
    }
  };

  const markInvalid = async (id: number) => {
    try {
      await api.updateForeshadow(id, { status: 2 });
      await reload();
    } catch (e) {
      showToast(String(e), "error");
    }
  };

  const remove = async (id: number) => {
    try {
      await api.deleteForeshadow(id);
      await reload();
    } catch (e) {
      showToast(String(e), "error");
    }
  };

  const jump = (cid: number | null) => {
    if (!cid) return;
    selectChapter(cid);
    setViewMode("editor");
  };

  return (
    <ToolShell
      title="伏笔工作台"
      subtitle={`活跃 ${active} · 逾期 ${overdue} · 共 ${items.length}`}
      actions={
        <button className="btn primary" onClick={() => setCreating(true)}>
          埋设伏笔
        </button>
      }
    >
      <div className="nf-filters">
        {[-1, 0, 1, 2].map((s) => (
          <button
            key={s}
            className={statusFilter === s ? "chip on" : "chip"}
            onClick={() => setStatusFilter(s)}
          >
            {s < 0 ? "全部" : FS_STATUS[s]}
          </button>
        ))}
      </div>
      <div className="nf-table-wrap">
        <table className="nf-table">
          <thead>
            <tr>
              <th>标题</th>
              <th>类型</th>
              <th>状态</th>
              <th>埋设</th>
              <th>预期</th>
              <th>回收</th>
              <th>跨度</th>
              <th>剧情线</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((f) => (
              <tr key={f.id} className={f.overdue ? "row-overdue" : undefined}>
                <td>
                  <div className="cell-title">{f.title}</div>
                  {f.note ? <div className="cell-note">{f.note}</div> : null}
                </td>
                <td>{FS_TYPES[f.foreshadowType] ?? "其他"}</td>
                <td>
                  <span className={`badge s${f.status}`}>
                    {FS_STATUS[f.status] ?? "?"}
                  </span>
                  {f.overdue ? <span className="badge warn">逾期</span> : null}
                </td>
                <td>
                  <button
                    className="link"
                    onClick={() => jump(f.plantChapterId)}
                    disabled={!f.plantChapterId}
                  >
                    {f.plantChapterTitle ?? "—"}
                  </button>
                </td>
                <td>
                  <button
                    className="link"
                    onClick={() => jump(f.expectChapterId)}
                    disabled={!f.expectChapterId}
                  >
                    {f.expectChapterTitle ?? "—"}
                  </button>
                </td>
                <td>
                  <button
                    className="link"
                    onClick={() => jump(f.resolveChapterId)}
                    disabled={!f.resolveChapterId}
                  >
                    {f.resolveChapterTitle ?? "—"}
                  </button>
                </td>
                <td>{f.span >= 0 ? f.span : "—"}</td>
                <td>{f.arcTitle ?? "—"}</td>
                <td className="ops">
                  {f.status === 0 ? (
                    <>
                      <button className="link" onClick={() => markResolved(f.id)}>
                        回收
                      </button>
                      <button className="link" onClick={() => markInvalid(f.id)}>
                        失效
                      </button>
                    </>
                  ) : (
                    <button
                      className="link"
                      onClick={() =>
                        api
                          .updateForeshadow(f.id, { status: 0 })
                          .then(reload)
                          .catch((e) => showToast(String(e), "error"))
                      }
                    >
                      重开
                    </button>
                  )}
                  <button className="link danger" onClick={() => remove(f.id)}>
                    删除
                  </button>
                </td>
              </tr>
            ))}
            {visible.length === 0 ? (
              <tr>
                <td colSpan={9} className="empty">
                  暂无伏笔，点右上角「埋设伏笔」开始
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      {creating ? (
        <Modal title="埋设伏笔" onClose={() => setCreating(false)}>
          <label className="field">
            <span>标题</span>
            <input
              value={draft.title}
              onChange={(e) => setDraft({ ...draft, title: e.target.value })}
              placeholder="例如：玉佩上的裂痕"
              autoFocus
            />
          </label>
          <label className="field">
            <span>类型</span>
            <select
              value={draft.foreshadowType}
              onChange={(e) =>
                setDraft({ ...draft, foreshadowType: Number(e.target.value) })
              }
            >
              {FS_TYPES.map((t, i) => (
                <option key={t} value={i}>
                  {t}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>埋设章</span>
            <select
              value={draft.plantChapterId}
              onChange={(e) =>
                setDraft({ ...draft, plantChapterId: Number(e.target.value) })
              }
            >
              <option value={0}>未指定</option>
              {chapters.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.title}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>预期回收章</span>
            <select
              value={draft.expectChapterId}
              onChange={(e) =>
                setDraft({ ...draft, expectChapterId: Number(e.target.value) })
              }
            >
              <option value={0}>未指定</option>
              {chapters.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.title}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>剧情线</span>
            <select
              value={draft.arcId}
              onChange={(e) =>
                setDraft({ ...draft, arcId: Number(e.target.value) })
              }
            >
              <option value={0}>未归属</option>
              {arcs.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.title}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>备注</span>
            <textarea
              value={draft.note}
              onChange={(e) => setDraft({ ...draft, note: e.target.value })}
              rows={3}
            />
          </label>
          <div className="modal-actions">
            <button className="btn" onClick={() => setCreating(false)}>
              取消
            </button>
            <button className="btn primary" onClick={onCreate}>
              埋设
            </button>
          </div>
        </Modal>
      ) : null}
    </ToolShell>
  );
}

// ---------- 故事时间轴 ----------

export function StoryTimelineView() {
  const tree = useAppStore((s) => s.tree);
  const activeArcId = useAppStore((s) => s.activeArcId);
  const selectChapter = useAppStore((s) => s.selectChapter);
  const setViewMode = useAppStore((s) => s.setViewMode);
  const showToast = useAppStore((s) => s.showToast);
  const [nodes, setNodes] = useState<TimelineNode[]>([]);
  const [group, setGroup] = useState("all");
  const [arcs, setArcs] = useState<StoryArc[]>([]);

  useEffect(() => {
    void api
      .listStoryArcs()
      .then(setArcs)
      .catch(() => setArcs([]));
  }, []);

  useEffect(() => {
    void api
      .getStoryTimeline(activeArcId || null)
      .then(setNodes)
      .catch((e) => showToast(String(e), "error"));
  }, [activeArcId, showToast]);

  const groups = useMemo(() => {
    const s = new Set(nodes.map((n) => n.timelineGroup));
    return ["all", ...Array.from(s)];
  }, [nodes]);

  const visible =
    group === "all" ? nodes : nodes.filter((n) => n.timelineGroup === group);

  const byGroup = useMemo(() => {
    const m = new Map<string, TimelineNode[]>();
    for (const n of visible) {
      const arr = m.get(n.timelineGroup) ?? [];
      arr.push(n);
      m.set(n.timelineGroup, arr);
    }
    return Array.from(m.entries());
  }, [visible]);

  const setStoryTime = async (id: number, storyTime: string) => {
    try {
      await api.updateChapterRoadmap(id, { storyTime });
      setNodes((prev) =>
        prev.map((n) => (n.id === id ? { ...n, storyTime } : n)),
      );
    } catch (e) {
      showToast(String(e), "error");
    }
  };

  const setTension = async (id: number, tension: number) => {
    try {
      await api.updateChapterRoadmap(id, { tension });
      setNodes((prev) =>
        prev.map((n) => (n.id === id ? { ...n, tension } : n)),
      );
    } catch (e) {
      showToast(String(e), "error");
    }
  };

  return (
    <ToolShell
      title="故事时间轴"
      subtitle="叙事时 ≠ 发表序：按泳道排列故事时间，可改张力 1–5"
    >
      <div className="nf-filters">
        {groups.map((g) => (
          <button
            key={g}
            className={group === g ? "chip on" : "chip"}
            onClick={() => setGroup(g)}
          >
            {g === "all" ? "全部泳道" : g}
          </button>
        ))}
      </div>
      {byGroup.map(([g, list]) => (
        <section key={g} className="nf-lane">
          <h3>{g === "main" ? "主线" : g}</h3>
          <div className="nf-lane-track">
            {list.map((n) => (
              <article
                key={n.id}
                className="nf-lane-card"
                onClick={() => {
                  selectChapter(n.id);
                  setViewMode("editor");
                }}
              >
                <div className="ord">#{n.globalOrder + 1}</div>
                <div className="ttl">{n.title}</div>
                <div className="meta">
                  {n.povName ?? "无POV"} · {n.wordCount}字
                </div>
                <input
                  className="story-time"
                  defaultValue={n.storyTime}
                  placeholder="故事时间"
                  onClick={(e) => e.stopPropagation()}
                  onBlur={(e) => {
                    const v = e.target.value;
                    if (v !== n.storyTime) void setStoryTime(n.id, v);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                  }}
                />
                <label className="arc-tag" onClick={(e) => e.stopPropagation()}>
                  线
                  <select
                    value={n.arcIds[0] ?? 0}
                    onChange={(e) => {
                      const arcId = Number(e.target.value);
                      void api
                        .setChapterArcs(n.id, arcId ? [arcId] : [], arcId || null)
                        .then(() => {
                          setNodes((prev) =>
                            prev.map((x) =>
                              x.id === n.id
                                ? { ...x, arcIds: arcId ? [arcId] : [] }
                                : x,
                            ),
                          );
                        })
                        .catch((err) => showToast(String(err), "error"));
                    }}
                  >
                    <option value={0}>未归属</option>
                    {arcs.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.title}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="tension-row" onClick={(e) => e.stopPropagation()}>
                  {[1, 2, 3, 4, 5].map((t) => (
                    <button
                      key={t}
                      className={
                        n.tension === t ? "t on" : "t"
                      }
                      onClick={() => setTension(n.id, t)}
                    >
                      {t}
                    </button>
                  ))}
                </div>
              </article>
            ))}
          </div>
        </section>
      ))}
      {byGroup.length === 0 ? (
        <p className="empty">暂无章节</p>
      ) : null}
      {tree ? null : null}
    </ToolShell>
  );
}

// ---------- 进度看板 ----------

export function ProgressBoard() {
  const activeArcId = useAppStore((s) => s.activeArcId);
  const selectChapter = useAppStore((s) => s.selectChapter);
  const setViewMode = useAppStore((s) => s.setViewMode);
  const showToast = useAppStore((s) => s.showToast);
  const [cards, setCards] = useState<BoardCard[]>([]);

  useEffect(() => {
    void api
      .getBoard(activeArcId || null)
      .then(setCards)
      .catch((e) => showToast(String(e), "error"));
  }, [activeArcId, showToast]);

  const move = async (id: number, lane: number) => {
    try {
      await api.updateChapterRoadmap(id, { boardLane: lane });
      setCards((prev) =>
        prev.map((c) => (c.id === id ? { ...c, boardLane: lane } : c)),
      );
    } catch (e) {
      showToast(String(e), "error");
    }
  };

  const totalTarget = cards.reduce((s, c) => s + (c.targetWords || 0), 0);
  const totalWords = cards.reduce((s, c) => s + c.wordCount, 0);
  const done = cards.filter((c) => c.boardLane >= 4).length;

  return (
    <ToolShell
      title="章节进度看板"
      subtitle={`完稿 ${done}/${cards.length} · 已写 ${totalWords} / 目标 ${totalTarget || "—"}`}
    >
      <div className="nf-board">
        {LANES.map((lane, li) => {
          const list = cards.filter((c) => c.boardLane === li);
          return (
            <div key={lane} className="nf-board-col">
              <h3>
                {lane} <span>{list.length}</span>
              </h3>
              {list.map((c) => (
                <article
                  key={c.id}
                  className="nf-board-card"
                >
                  <div
                    className="ttl"
                    onClick={() => {
                      selectChapter(c.id);
                      setViewMode("editor");
                    }}
                  >
                    {c.title}
                  </div>
                  <div className="meta">
                    {c.wordCount}
                    {c.targetWords > 0 ? ` / ${c.targetWords}` : ""} 字
                    {c.foreshadowCount > 0 ? ` · 伏笔${c.foreshadowCount}` : ""}
                  </div>
                  {c.summary ? <div className="sum">{c.summary.slice(0, 40)}</div> : null}
                  <div className="lane-jump">
                    {LANES.map((_, i) =>
                      i === c.boardLane ? null : (
                        <button
                          key={i}
                          className="link"
                          onClick={() => move(c.id, i)}
                        >
                          →{LANES[i]}
                        </button>
                      ),
                    )}
                  </div>
                </article>
              ))}
            </div>
          );
        })}
      </div>
    </ToolShell>
  );
}

// ---------- POV 仪表盘 ----------

export function PovDashboardView() {
  const activeArcId = useAppStore((s) => s.activeArcId);
  const showToast = useAppStore((s) => s.showToast);
  const [data, setData] = useState<PovDashboard | null>(null);

  useEffect(() => {
    void api
      .getPovDashboard(activeArcId || null)
      .then(setData)
      .catch((e) => showToast(String(e), "error"));
  }, [activeArcId, showToast]);

  if (!data) {
    return (
      <ToolShell title="POV 轮转">
        <p className="empty">加载中…</p>
      </ToolShell>
    );
  }

  const palette = [
    "#3D5A80",
    "#A66A2E",
    "#6B8F71",
    "#9B4D6A",
    "#5C6B7A",
    "#C4A35A",
    "#7A6B8A",
  ];
  const nameColor = new Map<string, string>();
  data.stats.forEach((s, i) => {
    nameColor.set(s.name, palette[i % palette.length]);
  });

  return (
    <ToolShell
      title="POV 轮转仪表盘"
      subtitle={`最长连续 ${data.maxRunLen} 章 · ${data.maxRunName || "—"}`}
    >
      <div className="nf-pov-strip">
        {data.perChapter.map((name, i) => (
          <div
            key={data.chapterIds[i]}
            className="nf-pov-cell"
            title={`#${i + 1} ${name}`}
            style={{
              background: nameColor.get(name) ?? "#888",
              opacity: name === "未指定" ? 0.35 : 1,
            }}
          />
        ))}
      </div>
      <table className="nf-table">
        <thead>
          <tr>
            <th>POV</th>
            <th>章数</th>
            <th>最长连续</th>
            <th>最近出现序</th>
          </tr>
        </thead>
        <tbody>
          {data.stats.map((s) => (
            <tr key={s.name}>
              <td>
                <span
                  className="dot"
                  style={{ background: nameColor.get(s.name) ?? "#888" }}
                />
                {s.name}
              </td>
              <td>{s.chapterCount}</td>
              <td>{s.longestStreak}</td>
              <td>
                {s.lastChapterOrder != null ? `#${s.lastChapterOrder + 1}` : "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </ToolShell>
  );
}

// ---------- 设定词条 ----------

export function LoreLibrary() {
  const selectedChapterId = useAppStore((s) => s.selectedChapterId);
  const showToast = useAppStore((s) => s.showToast);
  const [entries, setEntries] = useState<LoreEntry[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState("");
  const [kind, setKind] = useState("concept");
  const [body, setBody] = useState("");
  const [linked, setLinked] = useState<Set<number>>(new Set());

  const reload = useCallback(async () => {
    try {
      setEntries(await api.listLoreEntries());
      if (selectedChapterId) {
        const linkedList = await api.loreForChapter(selectedChapterId);
        setLinked(new Set(linkedList.map((e) => e.id)));
      } else {
        setLinked(new Set());
      }
    } catch (e) {
      showToast(String(e), "error");
    }
  }, [selectedChapterId, showToast]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const current = entries.find((e) => e.id === selected) ?? null;

  const create = async () => {
    if (!title.trim()) return;
    try {
      const e = await api.createLoreEntry({ title, kind, body });
      setCreating(false);
      setTitle("");
      setBody("");
      setSelected(e.id);
      await reload();
    } catch (err) {
      showToast(String(err), "error");
    }
  };

  const saveBody = async () => {
    if (!current) return;
    try {
      await api.updateLoreEntry(current.id, { body: current.body });
      showToast("已保存");
    } catch (e) {
      showToast(String(e), "error");
    }
  };

  const toggleLink = async (entryId: number) => {
    if (!selectedChapterId) {
      showToast("请先选中章节", "error");
      return;
    }
    try {
      if (linked.has(entryId)) {
        await api.unlinkLoreFromChapter(entryId, selectedChapterId);
      } else {
        await api.linkLoreToChapter(entryId, selectedChapterId);
      }
      await reload();
    } catch (e) {
      showToast(String(e), "error");
    }
  };

  return (
    <ToolShell
      title="设定词条库"
      subtitle={
        selectedChapterId
          ? "点击「关联」挂到当前章节"
          : "选中章节后可双向关联"
      }
      actions={
        <button className="btn primary" onClick={() => setCreating(true)}>
          新建词条
        </button>
      }
    >
      <div className="nf-lore">
        <aside>
          {entries.map((e) => (
            <button
              key={e.id}
              className={selected === e.id ? "item on" : "item"}
              onClick={() => setSelected(e.id)}
            >
              <span className="kind">
                {LORE_KINDS.find((k) => k.key === e.kind)?.label ?? e.kind}
              </span>
              <span className="t" onClick={() => setSelected(e.id)}>
                {e.title}
              </span>
              {selectedChapterId ? (
                <button
                  type="button"
                  className={linked.has(e.id) ? "link on" : "link"}
                  onClick={(ev) => {
                    ev.stopPropagation();
                    void toggleLink(e.id);
                  }}
                >
                  {linked.has(e.id) ? "已关联" : "关联"}
                </button>
              ) : null}
            </button>
          ))}
          {entries.length === 0 ? <p className="empty">暂无词条</p> : null}
        </aside>
        <main>
          {current ? (
            <>
              <h3>{current.title}</h3>
              <textarea
                value={current.body}
                onChange={(e) =>
                  setEntries((prev) =>
                    prev.map((x) =>
                      x.id === current.id ? { ...x, body: e.target.value } : x,
                    ),
                  )
                }
                rows={16}
              />
              <div className="modal-actions">
                <button className="btn primary" onClick={saveBody}>
                  保存正文
                </button>
                <button
                  className="btn danger"
                  onClick={() =>
                    api
                      .deleteLoreEntry(current.id)
                      .then(() => {
                        setSelected(null);
                        return reload();
                      })
                      .catch((e) => showToast(String(e), "error"))
                  }
                >
                  删除
                </button>
              </div>
            </>
          ) : (
            <p className="empty">从左侧选择或新建词条</p>
          )}
        </main>
      </div>

      {creating ? (
        <Modal title="新建设定词条" onClose={() => setCreating(false)}>
          <label className="field">
            <span>标题</span>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              autoFocus
            />
          </label>
          <label className="field">
            <span>类型</span>
            <select value={kind} onChange={(e) => setKind(e.target.value)}>
              {LORE_KINDS.map((k) => (
                <option key={k.key} value={k.key}>
                  {k.label}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>正文</span>
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={6}
            />
          </label>
          <div className="modal-actions">
            <button className="btn" onClick={() => setCreating(false)}>
              取消
            </button>
            <button className="btn primary" onClick={create}>
              创建
            </button>
          </div>
        </Modal>
      ) : null}
    </ToolShell>
  );
}

// ---------- 称谓一致性 ----------

export function AddressConsistency() {
  const showToast = useAppStore((s) => s.showToast);
  const [forms, setForms] = useState<AddressForm[]>([]);
  const [hits, setHits] = useState<AddressDriftHit[]>([]);
  const [scanning, setScanning] = useState(false);

  const reload = useCallback(async () => {
    try {
      setForms(await api.listAddressForms());
    } catch (e) {
      showToast(String(e), "error");
    }
  }, [showToast]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const scan = async () => {
    setScanning(true);
    try {
      setHits(await api.scanAddressDrift());
    } catch (e) {
      showToast(String(e), "error");
    } finally {
      setScanning(false);
    }
  };

  return (
    <ToolShell
      title="称谓一致性"
      subtitle="先登记「首选 / 非首选」称谓，再扫描正文漂移"
      actions={
        <button className="btn primary" onClick={scan} disabled={scanning}>
          {scanning ? "扫描中…" : "扫描漂移"}
        </button>
      }
    >
      <section>
        <h3>称谓规范（{forms.length}）</h3>
        <p className="hint">
          在角色卡别名中维护称谓后，可用下方表单把非首选称谓登记出来供扫描。
        </p>
        <AddressFormEditor onSaved={reload} />
        <ul className="nf-addr-list">
          {forms.map((f) => (
            <li key={f.id}>
              <strong>{f.toName ?? f.toChar ?? "?"}</strong>
              {" ← "}
              {f.form}
              {f.preferred ? (
                <span className="badge">首选</span>
              ) : (
                <span className="badge warn">非首选</span>
              )}
              <button
                className="link danger"
                onClick={() =>
                  api
                    .deleteAddressForm(f.id)
                    .then(reload)
                    .catch((e) => showToast(String(e), "error"))
                }
              >
                删除
              </button>
            </li>
          ))}
        </ul>
      </section>
      <section>
        <h3>漂移命中（{hits.length}）</h3>
        <table className="nf-table">
          <thead>
            <tr>
              <th>角色</th>
              <th>非首选</th>
              <th>应改为</th>
              <th>章节</th>
              <th>次数</th>
              <th>片段</th>
            </tr>
          </thead>
          <tbody>
            {hits.map((h, i) => (
              <tr key={`${h.chapterId}-${h.form}-${i}`}>
                <td>{h.characterName}</td>
                <td>{h.form}</td>
                <td>{h.preferred}</td>
                <td>{h.chapterTitle}</td>
                <td>{h.count}</td>
                <td className="snippet">{h.snippet}</td>
              </tr>
            ))}
            {hits.length === 0 ? (
              <tr>
                <td colSpan={6} className="empty">
                  点击「扫描漂移」检查
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </section>
    </ToolShell>
  );
}

function AddressFormEditor({ onSaved }: { onSaved: () => void }) {
  const tree = useAppStore((s) => s.tree);
  const showToast = useAppStore((s) => s.showToast);
  const [toChar, setToChar] = useState(0);
  const [form, setForm] = useState("");
  const [preferred, setPreferred] = useState(false);
  // characters are loaded via CardsModal typically; we fetch lazily
  const [chars, setChars] = useState<CharacterProfile[]>([]);

  useEffect(() => {
    void api
      .listCharacters()
      .then(setChars)
      .catch(() => undefined);
  }, []);

  const save = async () => {
    if (!toChar || !form.trim()) return;
    try {
      await api.upsertAddressForm({ toChar, form, preferred });
      setForm("");
      onSaved();
    } catch (e) {
      showToast(String(e), "error");
    }
  };

  return (
    <div className="nf-addr-form">
      <select value={toChar} onChange={(e) => setToChar(Number(e.target.value))}>
        <option value={0}>选择角色…</option>
        {chars.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </select>
      <input
        value={form}
        onChange={(e) => setForm(e.target.value)}
        placeholder="称谓，如 师父"
      />
      <label>
        <input
          type="checkbox"
          checked={preferred}
          onChange={(e) => setPreferred(e.target.checked)}
        />
        首选
      </label>
      <button className="btn" onClick={save}>
        登记
      </button>
      {tree ? null : null}
    </div>
  );
}

// ---------- 文风 + 结构快照 ----------

export function StyleAndStructure() {
  const showToast = useAppStore((s) => s.showToast);
  const selectedChapterId = useAppStore((s) => s.selectedChapterId);
  const [style, setStyle] = useState<StyleFingerprint | null>(null);
  const [snaps, setSnaps] = useState<StructureSnapshotMeta[]>([]);
  const [label, setLabel] = useState("");
  const [scope, setScope] = useState<'book' | 'chapter'>('book');

  const loadStyle = async () => {
    try {
      setStyle(
        await api.getStyleFingerprint(
          scope === 'chapter' ? selectedChapterId : null,
        ),
      );
    } catch (e) {
      showToast(String(e), "error");
    }
  };

  const loadSnaps = useCallback(async () => {
    try {
      setSnaps(await api.listStructureSnapshots());
    } catch (e) {
      showToast(String(e), "error");
    }
  }, [showToast]);

  useEffect(() => {
    void loadSnaps();
  }, [loadSnaps]);

  const takeSnapshot = async () => {
    try {
      await api.createStructureSnapshot(label || undefined);
      setLabel("");
      await loadSnaps();
      showToast("结构快照已保存");
    } catch (e) {
      showToast(String(e), "error");
    }
  };

  return (
    <ToolShell title="文风指纹与结构快照" subtitle="纯本地统计，无模型调用">
      <section>
        <h3>文风指纹</h3>
        <div className="nf-filters">
          <button
            className={scope === "book" ? "chip on" : "chip"}
            onClick={() => setScope("book")}
          >
            全书
          </button>
          <button
            className={scope === "chapter" ? "chip on" : "chip"}
            onClick={() => setScope("chapter")}
            disabled={!selectedChapterId}
          >
            当前章
          </button>
          <button className="btn" onClick={loadStyle}>
            生成报告
          </button>
        </div>
        {style ? (
          <div className="nf-style-grid">
            <div>
              <span className="k">总字数</span>
              <span className="v">{style.totalWords}</span>
            </div>
            <div>
              <span className="k">对白占比</span>
              <span className="v">
                {(style.dialogueRatio * 100).toFixed(1)}%
              </span>
            </div>
            <div>
              <span className="k">段落均长</span>
              <span className="v">{style.avgParagraphLen.toFixed(1)}</span>
            </div>
            <div>
              <span className="k">句均长</span>
              <span className="v">{style.avgSentenceLen.toFixed(1)}</span>
            </div>
            <div>
              <span className="k">长句比</span>
              <span className="v">
                {(style.longSentenceRatio * 100).toFixed(1)}%
              </span>
            </div>
            <div>
              <span className="k">高频虚词</span>
              <span className="v">
                {style.topParticles.map(([w, c]) => `${w}×${c}`).join(" · ") ||
                  "—"}
              </span>
            </div>
            <div>
              <span className="k">副词近似</span>
              <span className="v">
                {style.topAdverbs.map(([w, c]) => `${w}×${c}`).join(" · ") ||
                  "—"}
              </span>
            </div>
          </div>
        ) : (
          <p className="empty">点击「生成报告」</p>
        )}
      </section>
      <section>
        <h3>结构快照（时间旅行）</h3>
        <div className="nf-addr-form">
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="快照标签，如 大改前"
          />
          <button className="btn primary" onClick={takeSnapshot}>
            创建快照
          </button>
        </div>
        <ul className="nf-addr-list">
          {snaps.map((s) => (
            <li key={s.id}>
              <strong>{s.label}</strong> · {s.createdAt} · 卷{s.volumeCount} 章
              {s.chapterCount} 伏笔{s.foreshadowCount}
              <button
                className="link danger"
                onClick={() =>
                  api
                    .deleteStructureSnapshot(s.id)
                    .then(loadSnaps)
                    .catch((e) => showToast(String(e), "error"))
                }
              >
                删除
              </button>
            </li>
          ))}
          {snaps.length === 0 ? (
            <li className="empty">暂无快照</li>
          ) : null}
        </ul>
      </section>
    </ToolShell>
  );
}

// ---------- 龙套批量铸造（弹窗） ----------

export function BatchForgeModal({ onClose }: { onClose: () => void }) {
  const showToast = useAppStore((s) => s.showToast);
  const refreshTree = useAppStore((s) => s.refreshTree);
  const [rows, setRows] = useState(
    Array.from({ length: 5 }, () => ({ name: "", faction: "" })),
  );
  const [creating, setCreating] = useState(false);

  const addRow = () =>
    setRows((r) => [...r, { name: "", faction: "" }]);

  const submit = async () => {
    const items = rows
      .filter((r) => r.name.trim())
      .map((r) => ({
        name: r.name.trim(),
        role: "龙套",
        faction: r.faction,
        importance: 0,
      }));
    if (!items.length) return;
    setCreating(true);
    try {
      const res = await api.batchCreateCharacters(items);
      showToast(`已铸造 ${res.created} 个龙套`);
      void refreshTree();
      window.dispatchEvent(new Event("nf:cards-updated"));
      onClose();
    } catch (e) {
      showToast(String(e), "error");
    } finally {
      setCreating(false);
    }
  };

  return (
    <Modal title="龙套批量铸造" onClose={onClose}>
      <p className="hint">一行一人，同名会自动加序号。默认重要度为龙套。</p>
      <div className="nf-forge">
        {rows.map((r, i) => (
          <div key={i} className="nf-forge-row">
            <input
              value={r.name}
              placeholder={`名字 ${i + 1}`}
              onChange={(e) =>
                setRows((prev) =>
                  prev.map((x, j) =>
                    j === i ? { ...x, name: e.target.value } : x,
                  ),
                )
              }
            />
            <input
              value={r.faction}
              placeholder="阵营（可空）"
              onChange={(e) =>
                setRows((prev) =>
                  prev.map((x, j) =>
                    j === i ? { ...x, faction: e.target.value } : x,
                  ),
                )
              }
            />
          </div>
        ))}
      </div>
      <div className="modal-actions">
        <button className="btn" onClick={addRow}>
          加一行
        </button>
        <button className="btn" onClick={onClose}>
          取消
        </button>
        <button className="btn primary" onClick={submit} disabled={creating}>
          {creating ? "铸造中…" : "批量创建"}
        </button>
      </div>
    </Modal>
  );
}

// ---------- 状态账本（弹窗） ----------

export function StateLedgerModal({ onClose }: { onClose: () => void }) {
  const tree = useAppStore((s) => s.tree);
  const showToast = useAppStore((s) => s.showToast);
  const selectedChapterId = useAppStore((s) => s.selectedChapterId);
  const [chars, setChars] = useState<CharacterProfile[]>([]);
  const [charId, setCharId] = useState(0);
  const [rows, setRows] = useState<CharacterStateSnapshot[]>([]);
  const [draft, setDraft] = useState({
    location: "",
    affiliation: "",
    knows: "",
    note: "",
    alive: -1 as number,
  });

  useEffect(() => {
    void api
      .listCharacters()
      .then((list) => {
        setChars(list);
        if (list[0]) setCharId(list[0].id);
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!charId) return;
    void api
      .listStateSnapshots(charId)
      .then(setRows)
      .catch((e) => showToast(String(e), "error"));
  }, [charId, showToast]);

  const save = async () => {
    if (!charId) return;
    try {
      await api.upsertStateSnapshot({
        characterId: charId,
        chapterId: selectedChapterId,
        location: draft.location,
        affiliation: draft.affiliation,
        knows: draft.knows
          .split(/[,，\n]/)
          .map((s) => s.trim())
          .filter(Boolean),
        note: draft.note,
        alive: draft.alive < 0 ? null : draft.alive,
      });
      setRows(await api.listStateSnapshots(charId));
      setDraft({ location: "", affiliation: "", knows: "", note: "", alive: -1 });
      showToast("状态已记录");
    } catch (e) {
      showToast(String(e), "error");
    }
  };

  return (
    <Modal title="人物知情 / 状态账本" onClose={onClose} width={720}>
      <div className="nf-state-head">
        <select value={charId} onChange={(e) => setCharId(Number(e.target.value))}>
          {chars.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <span className="hint">
          {selectedChapterId
            ? `挂到当前章（#${selectedChapterId}）`
            : "未选章，记为无锚点快照"}
        </span>
      </div>
      <div className="nf-state-form">
        <input
          value={draft.location}
          placeholder="地点"
          onChange={(e) => setDraft({ ...draft, location: e.target.value })}
        />
        <input
          value={draft.affiliation}
          placeholder="阵营 / 归属"
          onChange={(e) => setDraft({ ...draft, affiliation: e.target.value })}
        />
        <select
          value={draft.alive}
          onChange={(e) => setDraft({ ...draft, alive: Number(e.target.value) })}
        >
          <option value={-1}>存亡未知</option>
          <option value={1}>存活</option>
          <option value={0}>死亡</option>
        </select>
        <input
          value={draft.knows}
          placeholder="已知信息（逗号分隔）"
          onChange={(e) => setDraft({ ...draft, knows: e.target.value })}
        />
        <input
          value={draft.note}
          placeholder="备注"
          onChange={(e) => setDraft({ ...draft, note: e.target.value })}
        />
        <button className="btn primary" onClick={save}>
          记录切片
        </button>
      </div>
      <table className="nf-table">
        <thead>
          <tr>
            <th>章</th>
            <th>地点</th>
            <th>存亡</th>
            <th>归属</th>
            <th>知情</th>
            <th>备注</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td>{r.chapterTitle ?? "—"}</td>
              <td>{r.location}</td>
              <td>
                {r.alive == null ? "未知" : r.alive === 1 ? "存活" : "死亡"}
              </td>
              <td>{r.affiliation}</td>
              <td>{r.knows.join("、")}</td>
              <td>{r.note}</td>
              <td>
                <button
                  className="link danger"
                  onClick={() =>
                    api
                      .deleteStateSnapshot(r.id)
                      .then(() => setRows((p) => p.filter((x) => x.id !== r.id)))
                      .catch((e) => showToast(String(e), "error"))
                  }
                >
                  删
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {tree ? null : null}
    </Modal>
  );
}
