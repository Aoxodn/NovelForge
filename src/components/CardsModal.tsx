/**
 * 人物 / 地点卡管理（阶段 6）：作者手动建卡 + 精确匹配统计。
 *
 * 设计原则（与阶段 5 自动识别的本质区别）：
 * - 无候选 / 无确认流程——作者建谁就是谁，引擎只做精确计数
 * - 建卡即出统计：出现次数 / 覆盖章数 / 首末章 / 热度走势 / 断档预警
 * - 别名合并计数（「林默」与「默儿」计入同一张卡）
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import * as api from '../api';
import { useAppStore } from '../store/appStore';
import { Modal } from './Modal';
import { IconDice, IconMapPin, IconPlus, IconRefresh, IconTrash, IconUsers } from './icons';
import { fmt } from '../utils/text';
import type { CharacterHeat, CharacterProfile, LocationProfile } from '../types/models';

/** 断档预警阈值：超过 N 章未出场才提示（短断档是正常写作节奏） */
const ABSENT_WARN_THRESHOLD = 10;

const ROLES = ['', '主角', '配角', '反派', '龙套'];

/** 热度走势：纯 SVG 柱状图，零依赖 */
function HeatBars({ heat }: { heat: CharacterHeat }) {
  const data = heat.perChapter;
  const max = Math.max(1, ...data);
  const W = 560;
  const H = 56;
  const bw = Math.max(1, W / Math.max(1, data.length));
  return (
    <div className="heat-wrap">
      <svg
        className="heat-chart"
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        role="img"
        aria-label="出场热度走势"
      >
        {data.map((n, i) => (
          <rect
            key={i}
            x={i * bw}
            y={H - (n / max) * (H - 4)}
            width={Math.max(0.5, bw - 0.6)}
            height={n === 0 ? 1 : (n / max) * (H - 4)}
            className={n === 0 ? 'heat-bar heat-bar-zero' : 'heat-bar'}
          >
            <title>{`第 ${i + 1} 章：${n} 次`}</title>
          </rect>
        ))}
      </svg>
      <div className="heat-meta">
        <span>共 {data.length} 章</span>
        {heat.absentStreak >= ABSENT_WARN_THRESHOLD && (
          <span className="badge-warn">断档 {heat.absentStreak} 章</span>
        )}
        {heat.absentStreak > 0 && heat.absentStreak < ABSENT_WARN_THRESHOLD && (
          <span className="heat-sub">近 {heat.absentStreak} 章未出场</span>
        )}
      </div>
    </div>
  );
}

/** 人物编辑表单（新建 / 编辑共用） */
function CharacterForm({
  initial,
  onSubmit,
  onCancel,
  busy,
}: {
  initial?: CharacterProfile;
  onSubmit: (v: { name: string; aliases: string[]; role: string; notes: string }) => void;
  onCancel: () => void;
  busy: boolean;
}) {
  const [name, setName] = useState(initial?.name ?? '');
  const [aliases, setAliases] = useState(initial?.aliases.join('、') ?? '');
  const [role, setRole] = useState(initial?.role ?? '');
  const [notes, setNotes] = useState(initial?.notes ?? '');

  const submit = () => {
    const list = aliases
      .split(/[、,，;；\s]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    onSubmit({ name: name.trim(), aliases: list, role, notes: notes.trim() });
  };

  return (
    <div className="card-form">
      <div className="form-row">
        <label>名字</label>
        <input
          className="input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="如：林默"
          autoFocus
        />
      </div>
      <div className="form-row">
        <label>别名 / 称谓</label>
        <input
          className="input"
          value={aliases}
          onChange={(e) => setAliases(e.target.value)}
          placeholder="如：默儿、林师兄（用顿号或逗号分隔）"
        />
      </div>
      <div className="form-row">
        <label>角色定位</label>
        <select className="select" value={role} onChange={(e) => setRole(e.target.value)}>
          {ROLES.map((r) => (
            <option key={r} value={r}>
              {r || '未设定'}
            </option>
          ))}
        </select>
      </div>
      <div className="form-row">
        <label>备注</label>
        <textarea
          className="input textarea"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="性格、外貌、人物小传……（仅作者可见，不参与导出）"
          rows={3}
        />
      </div>
      <div className="card-form-actions">
        <button className="btn" onClick={onCancel} disabled={busy}>
          取消
        </button>
        <button className="btn btn-primary" onClick={submit} disabled={busy || !name.trim()}>
          {initial ? '保存' : '创建'}
        </button>
      </div>
    </div>
  );
}

/** 地点编辑表单 */
function LocationForm({
  initial,
  onSubmit,
  onCancel,
  busy,
}: {
  initial?: LocationProfile;
  onSubmit: (v: { name: string; notes: string }) => void;
  onCancel: () => void;
  busy: boolean;
}) {
  const [name, setName] = useState(initial?.name ?? '');
  const [notes, setNotes] = useState(initial?.notes ?? '');
  return (
    <div className="card-form">
      <div className="form-row">
        <label>名字</label>
        <input
          className="input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="如：青云宗"
          autoFocus
        />
      </div>
      <div className="form-row">
        <label>备注</label>
        <textarea
          className="input textarea"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="方位、势力归属、场景氛围……"
          rows={3}
        />
      </div>
      <div className="card-form-actions">
        <button className="btn" onClick={onCancel} disabled={busy}>
          取消
        </button>
        <button className="btn btn-primary" onClick={() => onSubmit({ name: name.trim(), notes: notes.trim() })} disabled={busy || !name.trim()}>
          {initial ? '保存' : '创建'}
        </button>
      </div>
    </div>
  );
}

export function CardsModal({ onClose }: { onClose: () => void }) {
  const showToast = useAppStore((s) => s.showToast);
  const [tab, setTab] = useState<'characters' | 'locations'>('characters');
  const [characters, setCharacters] = useState<CharacterProfile[]>([]);
  const [locations, setLocations] = useState<LocationProfile[]>([]);
  const [busy, setBusy] = useState(false);
  const [rebuilding, setRebuilding] = useState(false);
  /** 展开编辑的卡 id；'new' 表示新建表单 */
  const [editing, setEditing] = useState<number | 'new' | null>(null);
  /** 展开热度走势的人物 id */
  const [heatOf, setHeatOf] = useState<number | null>(null);
  const [heat, setHeat] = useState<CharacterHeat | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [c, l] = await Promise.all([api.listCharacters(), api.listLocations()]);
      setCharacters(c);
      setLocations(l);
    } catch (e) {
      showToast(String(e), 'error');
    }
  }, [showToast]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // 热度走势：展开时按需拉取
  useEffect(() => {
    if (heatOf === null) {
      setHeat(null);
      return;
    }
    let cancelled = false;
    void api.getCharacterHeat(heatOf).then((h) => {
      if (!cancelled) setHeat(h);
    });
    return () => {
      cancelled = true;
    };
  }, [heatOf]);

  const notify = () => window.dispatchEvent(new Event('nf:cards-updated'));

  const submitCharacter = async (v: {
    name: string;
    aliases: string[];
    role: string;
    notes: string;
  }) => {
    setBusy(true);
    try {
      if (editing === 'new') {
        await api.addCharacter(v.name, v.aliases, v.role, v.notes);
        showToast(`人物「${v.name}」已创建`);
      } else if (typeof editing === 'number') {
        await api.updateCharacter(editing, v);
        showToast('已保存');
      }
      setEditing(null);
      await refresh();
      notify();
    } catch (e) {
      showToast(String(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  const submitLocation = async (v: { name: string; notes: string }) => {
    setBusy(true);
    try {
      if (editing === 'new') {
        await api.addLocation(v.name, v.notes);
        showToast(`地点「${v.name}」已创建`);
      } else if (typeof editing === 'number') {
        await api.updateLocation(editing, v);
        showToast('已保存');
      }
      setEditing(null);
      await refresh();
      notify();
    } catch (e) {
      showToast(String(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (kind: 'character' | 'location', id: number, name: string) => {
    if (!window.confirm(`删除${kind === 'character' ? '人物' : '地点'}「${name}」？\n仅删除卡片，不影响正文。`))
      return;
    setBusy(true);
    try {
      if (kind === 'character') await api.deleteCharacter(id);
      else await api.deleteLocation(id);
      setEditing(null);
      await refresh();
      notify();
      showToast('已删除');
    } catch (e) {
      showToast(String(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  const rebuild = async () => {
    setRebuilding(true);
    try {
      const n = await api.rebuildMentions();
      await refresh();
      notify();
      showToast(`统计已重建（${fmt(n)} 条出场记录）`);
    } catch (e) {
      showToast(String(e), 'error');
    } finally {
      setRebuilding(false);
    }
  };

  const rollName = () => {
    window.dispatchEvent(new CustomEvent('nf:open-name-generator'));
  };

  const list = useMemo(
    () => (tab === 'characters' ? characters : locations),
    [tab, characters, locations],
  );

  return (
    <Modal title="人物 / 地点" onClose={onClose} width={760}>
      <div className="cards-toolbar">
        <div className="tabs">
          <button
            className={`tab${tab === 'characters' ? ' active' : ''}`}
            onClick={() => {
              setTab('characters');
              setEditing(null);
              setHeatOf(null);
            }}
          >
            <IconUsers /> 人物
            <em>{characters.length}</em>
          </button>
          <button
            className={`tab${tab === 'locations' ? ' active' : ''}`}
            onClick={() => {
              setTab('locations');
              setEditing(null);
              setHeatOf(null);
            }}
          >
            <IconMapPin /> 地点
            <em>{locations.length}</em>
          </button>
        </div>
        <div className="cards-toolbar-actions">
          <button className="btn btn-ghost" onClick={rollName} title="打开随机取名">
            <IconDice size={14} /> 取名
          </button>
          <button
            className="btn btn-ghost"
            onClick={() => void rebuild()}
            disabled={rebuilding}
            title="全量重算所有卡的出场统计（正文大改后使用）"
          >
            <IconRefresh size={14} /> {rebuilding ? '重建中…' : '重建统计'}
          </button>
          <button
            className="btn btn-primary"
            onClick={() => setEditing('new')}
            disabled={editing === 'new'}
          >
            <IconPlus size={14} /> 新建{tab === 'characters' ? '人物' : '地点'}
          </button>
        </div>
      </div>

      {editing === 'new' &&
        (tab === 'characters' ? (
          <CharacterForm onSubmit={(v) => void submitCharacter(v)} onCancel={() => setEditing(null)} busy={busy} />
        ) : (
          <LocationForm onSubmit={(v) => void submitLocation(v)} onCancel={() => setEditing(null)} busy={busy} />
        ))}

      {list.length === 0 && editing !== 'new' ? (
        <div className="cards-empty">
          <p>
            {tab === 'characters'
              ? '还没有人物卡。点击「新建人物」，为你的主角建第一张卡。'
              : '还没有地点卡。点击「新建地点」，记录故事发生的舞台。'}
          </p>
          <p className="cards-empty-sub">
            建卡后自动统计全书出场次数、覆盖章节与断档情况——精确匹配，零误判。
          </p>
        </div>
      ) : (
        <ul className="cards-list">
          {tab === 'characters'
            ? characters.map((c) => (
                <li key={c.id} className="card-item">
                  <button
                    className="card-head"
                    onClick={() => {
                      setEditing(editing === c.id ? null : c.id);
                      setHeatOf(heatOf === c.id ? null : c.id);
                    }}
                  >
                    <span className="card-name">{c.name}</span>
                    {c.role && <span className="badge-role">{c.role}</span>}
                    {c.aliases.length > 0 && (
                      <span className="card-aliases">{c.aliases.join('、')}</span>
                    )}
                    <span className="card-stats">
                      {fmt(c.totalMentions)} 次 · {c.chapterCount} 章
                    </span>
                  </button>
                  <div className="card-sub">
                    {c.firstChapterTitle ? (
                      <span>
                        首现《{c.firstChapterTitle}》 · 末现《{c.lastChapterTitle}》
                      </span>
                    ) : (
                      <span className="heat-sub">正文尚未出现（写完即自动统计）</span>
                    )}
                  </div>
                  {heatOf === c.id && heat && heat.characterId === c.id && (
                    <HeatBars heat={heat} />
                  )}
                  {editing === c.id && (
                    <>
                      <CharacterForm
                        initial={c}
                        onSubmit={(v) => void submitCharacter(v)}
                        onCancel={() => setEditing(null)}
                        busy={busy}
                      />
                      <div className="card-danger">
                        <button
                          className="btn btn-danger btn-mini"
                          onClick={() => void remove('character', c.id, c.name)}
                          disabled={busy}
                        >
                          <IconTrash size={13} /> 删除此卡
                        </button>
                      </div>
                    </>
                  )}
                </li>
              ))
            : locations.map((l) => (
                <li key={l.id} className="card-item">
                  <button
                    className="card-head"
                    onClick={() => setEditing(editing === l.id ? null : l.id)}
                  >
                    <span className="card-name">{l.name}</span>
                    <span className="card-stats">
                      {fmt(l.totalMentions)} 次 · {l.chapterCount} 章
                    </span>
                  </button>
                  <div className="card-sub">
                    {l.firstChapterTitle ? (
                      <span>
                        首现《{l.firstChapterTitle}》 · 末现《{l.lastChapterTitle}》
                      </span>
                    ) : (
                      <span className="heat-sub">正文尚未出现</span>
                    )}
                  </div>
                  {editing === l.id && (
                    <>
                      <LocationForm
                        initial={l}
                        onSubmit={(v) => void submitLocation(v)}
                        onCancel={() => setEditing(null)}
                        busy={busy}
                      />
                      <div className="card-danger">
                        <button
                          className="btn btn-danger btn-mini"
                          onClick={() => void remove('location', l.id, l.name)}
                          disabled={busy}
                        >
                          <IconTrash size={13} /> 删除此卡
                        </button>
                      </div>
                    </>
                  )}
                </li>
              ))}
        </ul>
      )}
    </Modal>
  );
}
