/**
 * 人物 / 地点卡管理（阶段 6 + 审查 UX-3 群像增强）：
 * - 搜索（名字 / 别名 / 阵营 / 标签）
 * - 多维排序（名字 / 重要度 / 出场次数 / 角色定位 / 自定义拖拽）
 * - 分类筛选（角色定位 / 存亡 / POV）
 * - 群像扩展字段（阵营 / 存亡 / 重要度 / POV / 标签）
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import * as api from '../api';
import { useAppStore } from '../store/appStore';
import { Modal } from './Modal';
import { IconDice, IconMapPin, IconPlus, IconRefresh, IconTrash, IconUsers, IconGripVertical, IconSearch } from './icons';
import { fmt } from '../utils/text';
import type { CharacterHeat, CharacterMeta, CharacterProfile, CharacterRelation, LocationProfile } from '../types/models';
import { REL_CATEGORY_STYLE, REL_TYPE_OPTIONS } from './canvas/routing';

/** 断档预警阈值：超过 N 章未出场才提示（短断档是正常写作节奏） */
const ABSENT_WARN_THRESHOLD = 10;

const ROLES = ['', '主角', '配角', '反派', '龙套'];
const IMPORTANCE_LABELS = ['龙套', '次要', '配角', '核心主角'];

type SortMode = 'name' | 'importance' | 'mentions' | 'role' | 'custom';
type AliveFilter = 'all' | 'alive' | 'dead';
type PovFilter = 'all' | 'pov' | 'nonpov';

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

/** 人物编辑表单（新建 / 编辑共用，含群像扩展字段） */
export function CharacterForm({
  initial,
  onSubmit,
  onCancel,
  busy,
}: {
  initial?: CharacterProfile;
  onSubmit: (v: {
    name: string;
    aliases: string[];
    role: string;
    notes: string;
    excludeWords: string[];
    meta: CharacterMeta;
  }) => void;
  onCancel: () => void;
  busy: boolean;
}) {
  const [name, setName] = useState(initial?.name ?? '');
  const [aliases, setAliases] = useState(initial?.aliases.join('、') ?? '');
  const [role, setRole] = useState(initial?.role ?? '');
  const [notes, setNotes] = useState(initial?.notes ?? '');
  const [excludeWords, setExcludeWords] = useState(initial?.excludeWords?.join('、') ?? '');
  // 群像扩展字段
  const [faction, setFaction] = useState(initial?.faction ?? '');
  const [alive, setAlive] = useState<'unknown' | 'alive' | 'dead'>(
    initial?.alive === null ? 'unknown' : initial?.alive ? 'alive' : 'dead',
  );
  const [importance, setImportance] = useState(initial?.importance ?? 1);
  const [isPov, setIsPov] = useState(initial?.isPov ?? false);
  const [tags, setTags] = useState(initial?.tags?.join('、') ?? '');
  const isSingleChar = [...name.trim()].length === 1;

  const submit = () => {
    const list = aliases
      .split(/[、,，;；\s]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    const excl = excludeWords
      .split(/[、,，;；\s]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    const tagList = tags
      .split(/[、,，;；\s]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    const meta: CharacterMeta = {
      faction: faction.trim(),
      alive: alive === 'unknown' ? null : alive === 'alive',
      importance,
      isPov,
      tags: tagList,
    };
    onSubmit({ name: name.trim(), aliases: list, role, notes: notes.trim(), excludeWords: excl, meta });
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
      <div className="form-row form-row-3col">
        <div>
          <label>角色定位</label>
          <select className="select" value={role} onChange={(e) => setRole(e.target.value)}>
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {r || '未设定'}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label>重要度</label>
          <select className="select" value={importance} onChange={(e) => setImportance(Number(e.target.value))}>
            {IMPORTANCE_LABELS.map((label, i) => (
              <option key={i} value={i}>
                {label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label>存亡</label>
          <select className="select" value={alive} onChange={(e) => setAlive(e.target.value as typeof alive)}>
            <option value="unknown">未知</option>
            <option value="alive">存活</option>
            <option value="dead">死亡</option>
          </select>
        </div>
      </div>
      <div className="form-row form-row-3col">
        <div>
          <label>阵营 / 势力</label>
          <input
            className="input"
            value={faction}
            onChange={(e) => setFaction(e.target.value)}
            placeholder="如：青云宗"
          />
        </div>
        <div>
          <label>标签</label>
          <input
            className="input"
            value={tags}
            onChange={(e) => setTags(e.target.value)}
            placeholder="如：智者、黑化、伏笔（顿号分隔）"
          />
        </div>
        <div className="form-pov-check">
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={isPov}
              onChange={(e) => setIsPov(e.target.checked)}
            />
            POV 视角人物
          </label>
        </div>
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
      {isSingleChar && (
        <div className="form-row">
          <label>误判排除词</label>
          <input
            className="input"
            value={excludeWords}
            onChange={(e) => setExcludeWords(e.target.value)}
            placeholder="如：简单、简历、简介（这些词里的「简」不算人名）"
          />
          <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 4 }}>
            单字名会被常用词误判（如「简」在「简单」中），填入排除词后统计时自动跳过。
          </div>
        </div>
      )}
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

/** 人物关系管理区 */
function RelationsSection({
  characterId,
  characters,
  relations,
  onChanged,
}: {
  characterId: number;
  characters: CharacterProfile[];
  relations: CharacterRelation[];
  onChanged: () => void | Promise<void>;
}) {
  const showToast = useAppStore((s) => s.showToast);
  const tree = useAppStore((s) => s.tree);
  const mine = relations.filter((r) => r.fromChar === characterId || r.toChar === characterId);
  const nameById = new Map(characters.map((c) => [c.id, c.name]));

  const [otherId, setOtherId] = useState<number | ''>('');
  const [category, setCategory] = useState(3);
  const [relType, setRelType] = useState('');
  const [customType, setCustomType] = useState('');
  const [label, setLabel] = useState('');
  const [direction, setDirection] = useState(0);
  const [scope, setScope] = useState<number | ''>('');
  const [busy, setBusy] = useState(false);

  const create = async () => {
    if (otherId === '' || busy) return;
    setBusy(true);
    try {
      await api.createCharacterRelation({
        fromChar: characterId,
        toChar: Number(otherId),
        relCategory: category,
        relType: (customType.trim() || relType).trim(),
        label: label.trim(),
        direction,
        volumeId: scope === '' ? null : Number(scope),
      });
      showToast('关系已创建');
      setCustomType('');
      setLabel('');
      await onChanged();
    } catch (e) {
      showToast(String(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (r: CharacterRelation) => {
    const other = r.fromChar === characterId ? r.toChar : r.fromChar;
    if (!window.confirm(`删除与「${nameById.get(other) ?? '?'}」的${REL_CATEGORY_STYLE[r.relCategory]?.name ?? ''}关系？`))
      return;
    try {
      await api.deleteCharacterRelation(r.id);
      await onChanged();
    } catch (e) {
      showToast(String(e), 'error');
    }
  };

  return (
    <div className="rel-section">
      <span className="field-label">人物关系（{mine.length}）</span>
      {mine.length === 0 ? (
        <p className="info-empty">还没有关系。为该人物建立血缘 / 情感 / 社会 / 阵营 / 叙事五类关系，关系将在故事地图画布上可视化。</p>
      ) : (
        <ul className="rel-list">
          {mine.map((r) => {
            const otherId2 = r.fromChar === characterId ? r.toChar : r.fromChar;
            const style = REL_CATEGORY_STYLE[r.relCategory] ?? REL_CATEGORY_STYLE[3];
            const dirLabel = r.direction === 1 ? (r.fromChar === characterId ? '→' : '←') : '—';
            const scopeLabel =
              r.volumeId === null
                ? '跨卷'
                : tree?.volumes.find((v) => v.id === r.volumeId)?.title ?? '指定卷';
            return (
              <li key={r.id} className="rel-row">
                <span className="rel-swatch" style={{ background: style.color }} />
                <button
                  className="rel-name"
                  onClick={() => {
                    const other = characters.find((c) => c.id === otherId2);
                    if (other) {
                      showToast(`对方：${other.name}（${other.role || '未设定'}）`);
                    }
                  }}
                >
                  {nameById.get(otherId2) ?? '?'}
                </button>
                <span className="rel-meta">
                  {dirLabel} {r.relType || style.name}
                  {r.label ? ` · ${r.label}` : ''} · {scopeLabel}
                </span>
                <button className="icon-btn" title="删除关系" onClick={() => void remove(r)}>
                  <IconTrash size={13} />
                </button>
              </li>
            );
          })}
        </ul>
      )}

      <div className="rel-add">
        <select className="select select-mini" value={otherId} onChange={(e) => setOtherId(e.target.value === '' ? '' : Number(e.target.value))}>
          <option value="">选择人物…</option>
          {characters
            .filter((c) => c.id !== characterId)
            .map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
        </select>
        <select
          className="select select-mini"
          value={category}
          onChange={(e) => {
            setCategory(Number(e.target.value));
            setRelType('');
          }}
        >
          {[1, 2, 3, 4, 5].map((c) => (
            <option key={c} value={c}>{REL_CATEGORY_STYLE[c].name}</option>
          ))}
        </select>
        <select className="select select-mini" value={relType} onChange={(e) => setRelType(e.target.value)}>
          <option value="">子类型…</option>
          {(REL_TYPE_OPTIONS[category] ?? []).map((t) => (
            <option key={t} value={t}>{t}</option>
          ))}
        </select>
        <input
          className="input input-mini"
          style={{ width: 90 }}
          value={customType}
          placeholder="自定义类型"
          onChange={(e) => setCustomType(e.target.value)}
        />
        <select className="select select-mini" value={direction} onChange={(e) => setDirection(Number(e.target.value))}>
          <option value={0}>双向</option>
          <option value={1}>单向 →对方</option>
        </select>
        <select className="select select-mini" value={scope} onChange={(e) => setScope(e.target.value === '' ? '' : Number(e.target.value))}>
          <option value="">跨卷关系</option>
          {(tree?.volumes ?? []).map((v) => (
            <option key={v.id} value={v.id}>仅 {v.title.length > 8 ? `${v.title.slice(0, 8)}…` : v.title}</option>
          ))}
        </select>
        <input
          className="input input-mini"
          style={{ width: 110 }}
          value={label}
          placeholder="补充说明（可选）"
          onChange={(e) => setLabel(e.target.value)}
        />
        <button className="btn btn-primary btn-mini" disabled={busy || otherId === ''} onClick={() => void create()}>
          <IconPlus size={13} /> 建立关系
        </button>
      </div>
    </div>
  );
}

const ROLE_ORDER: Record<string, number> = { 主角: 0, 配角: 1, 反派: 2, 龙套: 3, '': 4 };

export function CardsModal({ onClose }: { onClose: () => void }) {
  const showToast = useAppStore((s) => s.showToast);
  const [tab, setTab] = useState<'characters' | 'locations'>('characters');
  const [characters, setCharacters] = useState<CharacterProfile[]>([]);
  const [locations, setLocations] = useState<LocationProfile[]>([]);
  const [relations, setRelations] = useState<CharacterRelation[]>([]);
  const [busy, setBusy] = useState(false);
  const [rebuilding, setRebuilding] = useState(false);
  const [editing, setEditing] = useState<number | 'new' | null>(null);
  const [heatOf, setHeatOf] = useState<number | null>(null);
  const [heat, setHeat] = useState<CharacterHeat | null>(null);

  // 搜索 / 排序 / 筛选
  const [search, setSearch] = useState('');
  const [sortMode, setSortMode] = useState<SortMode>('importance');
  const [roleFilter, setRoleFilter] = useState<string>('');
  const [aliveFilter, setAliveFilter] = useState<AliveFilter>('all');
  const [povFilter, setPovFilter] = useState<PovFilter>('all');
  // 自定义拖拽排序
  const [dragId, setDragId] = useState<number | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [c, l, r] = await Promise.all([
        api.listCharacters(),
        api.listLocations(),
        api.listAllCharacterRelations(),
      ]);
      setCharacters(c);
      setLocations(l);
      setRelations(r);
    } catch (e) {
      showToast(String(e), 'error');
    }
  }, [showToast]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

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
    excludeWords: string[];
    meta: CharacterMeta;
  }) => {
    setBusy(true);
    try {
      if (editing === 'new') {
        await api.addCharacter(v.name, v.aliases, v.role, v.notes, v.excludeWords, v.meta);
        showToast(`人物「${v.name}」已创建`);
      } else if (typeof editing === 'number') {
        await api.updateCharacter(editing, {
          name: v.name,
          aliases: v.aliases,
          role: v.role,
          notes: v.notes,
          excludeWords: v.excludeWords,
          meta: v.meta,
        });
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

  // 筛选 + 排序后的人物列表
  const filteredCharacters = useMemo(() => {
    const q = search.trim().toLowerCase();
    let list = characters.filter((c) => {
      if (q) {
        const hay = `${c.name} ${c.aliases.join(' ')} ${c.faction} ${c.tags.join(' ')}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      if (roleFilter && c.role !== roleFilter) return false;
      if (aliveFilter === 'alive' && c.alive !== true) return false;
      if (aliveFilter === 'dead' && c.alive !== false) return false;
      if (povFilter === 'pov' && !c.isPov) return false;
      if (povFilter === 'nonpov' && c.isPov) return false;
      return true;
    });
    switch (sortMode) {
      case 'name':
        list = [...list].sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
        break;
      case 'importance':
        list = [...list].sort((a, b) => b.importance - a.importance || a.name.localeCompare(b.name, 'zh-Hans-CN'));
        break;
      case 'mentions':
        list = [...list].sort((a, b) => b.totalMentions - a.totalMentions || a.name.localeCompare(b.name, 'zh-Hans-CN'));
        break;
      case 'role':
        list = [...list].sort(
          (a, b) => (ROLE_ORDER[a.role] ?? 4) - (ROLE_ORDER[b.role] ?? 4) || a.name.localeCompare(b.name, 'zh-Hans-CN'),
        );
        break;
      case 'custom':
        list = [...list].sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id);
        break;
    }
    return list;
  }, [characters, search, roleFilter, aliveFilter, povFilter, sortMode]);

  // 自定义拖拽：放下后重排并落库
  const handleDrop = async (targetId: number) => {
    if (dragId === null || dragId === targetId) {
      setDragId(null);
      return;
    }
    const ids = filteredCharacters.map((c) => c.id);
    const from = ids.indexOf(dragId);
    const to = ids.indexOf(targetId);
    if (from < 0 || to < 0) {
      setDragId(null);
      return;
    }
    const newIds = [...ids];
    newIds.splice(from, 1);
    newIds.splice(to, 0, dragId);
    const orders: [number, number][] = newIds.map((id, i) => [id, i]);
    // 乐观更新
    setCharacters((prev) => {
      const orderMap = new Map(orders);
      return prev.map((c) => ({ ...c, sortOrder: orderMap.get(c.id) ?? c.sortOrder }));
    });
    setDragId(null);
    try {
      await api.reorderCharacters(orders);
      notify();
    } catch (e) {
      showToast(String(e), 'error');
      await refresh();
    }
  };

  const hasActiveFilter = search !== '' || roleFilter !== '' || aliveFilter !== 'all' || povFilter !== 'all';

  return (
    <Modal title="人物 / 地点" onClose={onClose} width={800}>
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

      {tab === 'characters' && (
        <div className="cards-filter-bar">
          <div className="cards-search">
            <IconSearch size={14} />
            <input
              className="input"
              placeholder="搜索名字 / 别名 / 阵营 / 标签…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <select
            className="select select-mini cards-sort"
            value={sortMode}
            onChange={(e) => setSortMode(e.target.value as SortMode)}
            title="排序方式"
          >
            <option value="importance">按重要度</option>
            <option value="name">按名字</option>
            <option value="mentions">按出场次数</option>
            <option value="role">按角色定位</option>
            <option value="custom">自定义拖拽</option>
          </select>
          <div className="cards-filter-chips">
            {['', '主角', '配角', '反派', '龙套'].map((r) => (
              <button
                key={r || 'all'}
                className={`chip${roleFilter === r ? ' active' : ''}`}
                onClick={() => setRoleFilter(r)}
              >
                {r || '全部'}
              </button>
            ))}
          </div>
          <div className="cards-filter-chips">
            {(['all', 'alive', 'dead'] as AliveFilter[]).map((f) => (
              <button
                key={f}
                className={`chip${aliveFilter === f ? ' active' : ''}`}
                onClick={() => setAliveFilter(f)}
              >
                {f === 'all' ? '存亡' : f === 'alive' ? '存活' : '死亡'}
              </button>
            ))}
          </div>
          <div className="cards-filter-chips">
            {(['all', 'pov', 'nonpov'] as PovFilter[]).map((f) => (
              <button
                key={f}
                className={`chip${povFilter === f ? ' active' : ''}`}
                onClick={() => setPovFilter(f)}
              >
                {f === 'all' ? 'POV' : f === 'pov' ? '是POV' : '非POV'}
              </button>
            ))}
          </div>
          {hasActiveFilter && (
            <button
              className="btn btn-ghost btn-mini"
              onClick={() => {
                setSearch('');
                setRoleFilter('');
                setAliveFilter('all');
                setPovFilter('all');
              }}
            >
              清除筛选
            </button>
          )}
        </div>
      )}

      {editing === 'new' &&
        (tab === 'characters' ? (
          <CharacterForm onSubmit={(v) => void submitCharacter(v)} onCancel={() => setEditing(null)} busy={busy} />
        ) : (
          <LocationForm onSubmit={(v) => void submitLocation(v)} onCancel={() => setEditing(null)} busy={busy} />
        ))}

      {tab === 'characters' && filteredCharacters.length === 0 && editing !== 'new' ? (
        <div className="cards-empty">
          <p>{hasActiveFilter ? '没有符合筛选条件的人物。' : '还没有人物卡。点击「新建人物」，为你的主角建第一张卡。'}</p>
          <p className="cards-empty-sub">
            建卡后自动统计全书出场次数、覆盖章节与断档情况——精确匹配，零误判。
          </p>
        </div>
      ) : tab === 'locations' && locations.length === 0 && editing !== 'new' ? (
        <div className="cards-empty">
          <p>还没有地点卡。点击「新建地点」，记录故事发生的舞台。</p>
        </div>
      ) : (
        <ul className="cards-list">
          {tab === 'characters'
            ? filteredCharacters.map((c) => (
                <li
                  key={c.id}
                  className={`card-item${dragId === c.id ? ' card-item-dragging' : ''}`}
                  draggable={sortMode === 'custom'}
                  onDragStart={() => setDragId(c.id)}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={() => void handleDrop(c.id)}
                  onDragEnd={() => setDragId(null)}
                >
                  <div className="card-item-head">
                    {sortMode === 'custom' && (
                      <span className="card-drag-handle" title="拖拽排序">
                        <IconGripVertical size={14} />
                      </span>
                    )}
                    <button
                      className="card-head"
                      onClick={() => {
                        setEditing(editing === c.id ? null : c.id);
                        setHeatOf(heatOf === c.id ? null : c.id);
                      }}
                    >
                      <span className="card-name">{c.name}</span>
                      {c.role && <span className="badge-role">{c.role}</span>}
                      {c.faction && <span className="badge-faction">{c.faction}</span>}
                      {c.isPov && <span className="badge-pov">POV</span>}
                      {c.alive === false && <span className="badge-dead">已故</span>}
                      {c.tags.length > 0 && c.tags.slice(0, 2).map((t) => (
                        <span key={t} className="badge-tag">{t}</span>
                      ))}
                      {c.aliases.length > 0 && (
                        <span className="card-aliases">{c.aliases.join('、')}</span>
                      )}
                      <span className="card-stats">
                        {fmt(c.totalMentions)} 次 · {c.chapterCount} 章
                      </span>
                    </button>
                  </div>
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
                      <RelationsSection
                        characterId={c.id}
                        characters={characters}
                        relations={relations}
                        onChanged={refresh}
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
