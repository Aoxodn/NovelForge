/**
 * 人物 / 地点速览弹窗（v1.1.2 重组）：
 * - 定位：快速浏览、搜索、筛选、排序、自定义拖拽、快速新建、地点管理
 * - 点击人物 → 跳转角色卡深度编辑页（CharacterCardView）
 * - 深度编辑（人设、关系、热度、改名、弧光）统一收口到角色卡页
 * - CharacterForm 仍导出，供故事地图 / 卷画布的「编辑人物」弹窗复用
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as api from '../api';
import { useAppStore } from '../store/appStore';
import { Modal } from './Modal';
import { IconDice, IconMapPin, IconPlus, IconRefresh, IconTrash, IconUsers, IconGripVertical, IconSearch, IconExternalLink } from './icons';
import { fmt } from '../utils/text';
import { nextCharacterName } from '../utils/characterName';
import type { CharacterMeta, CharacterProfile, LocationProfile } from '../types/models';

const ROLES = ['', '主角', '配角', '反派', '龙套'];
const IMPORTANCE_LABELS = ['龙套', '次要', '配角', '核心主角'];

type SortMode = 'name' | 'importance' | 'mentions' | 'role' | 'custom';
type AliveFilter = 'all' | 'alive' | 'dead';
type PovFilter = 'all' | 'pov' | 'nonpov';

const ROLE_ORDER: Record<string, number> = { 主角: 0, 配角: 1, 反派: 2, 龙套: 3, '': 4 };

/** 人物编辑表单（新建 / 编辑共用，含群像扩展字段）—— 供本弹窗新建 & 地图/卷画布编辑复用 */
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
  const [faction, setFaction] = useState(initial?.faction ?? '');
  const [alive, setAlive] = useState<'unknown' | 'alive' | 'dead'>(
    initial?.alive === null || initial?.alive === undefined ? 'unknown' : initial.alive ? 'alive' : 'dead',
  );
  const [importance, setImportance] = useState(initial?.importance ?? 1);
  const [isPov, setIsPov] = useState(initial?.isPov ?? false);
  const [tags, setTags] = useState(initial?.tags?.join('、') ?? '');
  const isSingleChar = [...name.trim()].length === 1;

  const submit = () => {
    const list = aliases.split(/[、,，;；\s]+/).map((s) => s.trim()).filter(Boolean);
    const excl = excludeWords.split(/[、,，;；\s]+/).map((s) => s.trim()).filter(Boolean);
    const tagList = tags.split(/[、,，;；\s]+/).map((s) => s.trim()).filter(Boolean);
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
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="如：林默" autoFocus />
      </div>
      <div className="form-row">
        <label>别名 / 称谓</label>
        <input className="input" value={aliases} onChange={(e) => setAliases(e.target.value)} placeholder="如：默儿、林师兄（顿号或逗号分隔）" />
      </div>
      <div className="form-row form-row-3col">
        <div>
          <label>角色定位</label>
          <select className="select" value={role} onChange={(e) => setRole(e.target.value)}>
            {ROLES.map((r) => (<option key={r} value={r}>{r || '未设定'}</option>))}
          </select>
        </div>
        <div>
          <label>重要度</label>
          <select className="select" value={importance} onChange={(e) => setImportance(Number(e.target.value))}>
            {IMPORTANCE_LABELS.map((label, i) => (<option key={i} value={i}>{label}</option>))}
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
          <input className="input" value={faction} onChange={(e) => setFaction(e.target.value)} placeholder="如：青云宗" />
        </div>
        <div>
          <label>标签</label>
          <input className="input" value={tags} onChange={(e) => setTags(e.target.value)} placeholder="如：智者、黑化（顿号分隔）" />
        </div>
        <div className="form-pov-check">
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
            <input type="checkbox" checked={isPov} onChange={(e) => setIsPov(e.target.checked)} />
            POV 视角人物
          </label>
        </div>
      </div>
      <div className="form-row">
        <label>备注</label>
        <textarea className="input textarea" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="性格、外貌、人物小传……（仅作者可见，不参与导出）" rows={3} />
      </div>
      {isSingleChar && (
        <div className="form-row">
          <label>误判排除词</label>
          <input className="input" value={excludeWords} onChange={(e) => setExcludeWords(e.target.value)} placeholder="如：简单、简历（这些词里的「简」不算人名）" />
          <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 4 }}>
            单字名会被常用词误判，填入排除词后统计时自动跳过。
          </div>
        </div>
      )}
      <div className="card-form-actions">
        <button className="btn" onClick={onCancel} disabled={busy}>取消</button>
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
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="如：青云宗" autoFocus />
      </div>
      <div className="form-row">
        <label>备注</label>
        <textarea className="input textarea" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="方位、势力归属、场景氛围……" rows={3} />
      </div>
      <div className="card-form-actions">
        <button className="btn" onClick={onCancel} disabled={busy}>取消</button>
        <button className="btn btn-primary" onClick={() => onSubmit({ name: name.trim(), notes: notes.trim() })} disabled={busy || !name.trim()}>
          {initial ? '保存' : '创建'}
        </button>
      </div>
    </div>
  );
}

export function CardsModal({ onClose }: { onClose: () => void }) {
  const showToast = useAppStore((s) => s.showToast);
  const focusCharacter = useAppStore((s) => s.focusCharacter);
  const [tab, setTab] = useState<'characters' | 'locations'>('characters');
  const [characters, setCharacters] = useState<CharacterProfile[]>([]);
  const [locations, setLocations] = useState<LocationProfile[]>([]);
  const [busy, setBusy] = useState(false);
  const [rebuilding, setRebuilding] = useState(false);
  const [creating, setCreating] = useState(false);
  const creatingRef = useRef(false);
  const [editingLocation, setEditingLocation] = useState<number | null>(null);

  // 搜索 / 排序 / 筛选
  const [search, setSearch] = useState('');
  const [sortMode, setSortMode] = useState<SortMode>('importance');
  const [roleFilter, setRoleFilter] = useState<string>('');
  const [aliveFilter, setAliveFilter] = useState<AliveFilter>('all');
  const [povFilter, setPovFilter] = useState<PovFilter>('all');
  const [dragId, setDragId] = useState<number | null>(null);

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

  const notify = () => window.dispatchEvent(new Event('nf:cards-updated'));

  const submitLocation = async (v: { name: string; notes: string }) => {
    setBusy(true);
    try {
      if (editingLocation === null) {
        await api.addLocation(v.name, v.notes);
        showToast(`地点「${v.name}」已创建`);
      } else {
        await api.updateLocation(editingLocation, v);
        showToast('已保存');
      }
      setEditingLocation(null);
      await refresh();
      notify();
    } catch (e) {
      showToast(String(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  const removeLocation = async (id: number, name: string) => {
    if (!window.confirm(`删除地点「${name}」？`)) return;
    setBusy(true);
    try {
      await api.deleteLocation(id);
      setEditingLocation(null);
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
        list = [...list].sort((a, b) => (ROLE_ORDER[a.role] ?? 4) - (ROLE_ORDER[b.role] ?? 4) || a.name.localeCompare(b.name, 'zh-Hans-CN'));
        break;
      case 'custom':
        list = [...list].sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id);
        break;
    }
    return list;
  }, [characters, search, roleFilter, aliveFilter, povFilter, sortMode]);

  const handleDrop = async (targetId: number) => {
    if (dragId === null || dragId === targetId) { setDragId(null); return; }
    const ids = filteredCharacters.map((c) => c.id);
    const from = ids.indexOf(dragId);
    const to = ids.indexOf(targetId);
    if (from < 0 || to < 0) { setDragId(null); return; }
    const newIds = [...ids];
    newIds.splice(from, 1);
    newIds.splice(to, 0, dragId);
    const orders: [number, number][] = newIds.map((id, i) => [id, i]);
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

  const openCharacter = (id: number) => {
    focusCharacter(id);
    onClose();
  };

  return (
    <Modal title="人物 / 地点" onClose={onClose} width={800}>
      <div className="cards-toolbar">
        <div className="tabs">
          <button className={`tab${tab === 'characters' ? ' active' : ''}`} onClick={() => { setTab('characters'); setEditingLocation(null); }}>
            <IconUsers /> 人物<em>{characters.length}</em>
          </button>
          <button className={`tab${tab === 'locations' ? ' active' : ''}`} onClick={() => { setTab('locations'); setEditingLocation(null); }}>
            <IconMapPin /> 地点<em>{locations.length}</em>
          </button>
        </div>
        <div className="cards-toolbar-actions">
          <button className="btn btn-ghost" onClick={rollName} title="打开随机取名"><IconDice size={14} /> 取名</button>
          {tab === 'characters' && (
            <button className="btn btn-ghost" onClick={() => void rebuild()} disabled={rebuilding} title="全量重算出场统计">
              <IconRefresh size={14} /> {rebuilding ? '重建中…' : '重建统计'}
            </button>
          )}
          <button className="btn btn-primary" disabled={creating} onClick={() => {
            if (tab === 'characters') {
              if (creatingRef.current) return;
              creatingRef.current = true;
              setCreating(true);
              void (async () => {
                try {
                  const latest = await api.listCharacters();
                  const c = await api.addCharacter(nextCharacterName(latest), [], '配角', '');
                  await refresh();
                  notify();
                  focusCharacter(c.id);
                  onClose();
                } catch (e) {
                  showToast(String(e), 'error');
                } finally {
                  creatingRef.current = false;
                  setCreating(false);
                }
              })();
            } else {
              setEditingLocation(-1);
            }
          }}>
            <IconPlus size={14} /> 新建{tab === 'characters' ? '人物' : '地点'}
          </button>
        </div>
      </div>

      {/* 新建地点表单 */}
      {editingLocation === -1 && (
        <LocationForm onSubmit={(v) => void submitLocation(v)} onCancel={() => setEditingLocation(null)} busy={busy} />
      )}

      {/* 人物：搜索 / 排序 / 筛选栏 */}
      {tab === 'characters' && (
        <div className="cards-filter-bar">
          <div className="cards-search">
            <IconSearch size={14} />
            <input className="input" placeholder="搜索名字 / 别名 / 阵营 / 标签…" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
          <select className="select select-mini cards-sort" value={sortMode} onChange={(e) => setSortMode(e.target.value as SortMode)} title="排序方式">
            <option value="importance">按重要度</option>
            <option value="name">按名字</option>
            <option value="mentions">按出场次数</option>
            <option value="role">按角色定位</option>
            <option value="custom">自定义拖拽</option>
          </select>
          <div className="cards-filter-chips">
            {['', '主角', '配角', '反派', '龙套'].map((r) => (
              <button key={r || 'all'} className={`chip${roleFilter === r ? ' active' : ''}`} onClick={() => setRoleFilter(r)}>{r || '全部'}</button>
            ))}
          </div>
          <div className="cards-filter-chips">
            {(['all', 'alive', 'dead'] as AliveFilter[]).map((f) => (
              <button key={f} className={`chip${aliveFilter === f ? ' active' : ''}`} onClick={() => setAliveFilter(f)}>
                {f === 'all' ? '存亡' : f === 'alive' ? '存活' : '死亡'}
              </button>
            ))}
          </div>
          <div className="cards-filter-chips">
            {(['all', 'pov', 'nonpov'] as PovFilter[]).map((f) => (
              <button key={f} className={`chip${povFilter === f ? ' active' : ''}`} onClick={() => setPovFilter(f)}>
                {f === 'all' ? 'POV' : f === 'pov' ? '是POV' : '非POV'}
              </button>
            ))}
          </div>
          {hasActiveFilter && (
            <button className="btn btn-ghost btn-mini" onClick={() => { setSearch(''); setRoleFilter(''); setAliveFilter('all'); setPovFilter('all'); }}>清除筛选</button>
          )}
        </div>
      )}

      {/* 列表 */}
      {tab === 'characters' ? (
        filteredCharacters.length === 0 ? (
          <div className="cards-empty">
            <p>{hasActiveFilter ? '没有符合筛选条件的人物。' : '还没有人物卡。点击「新建人物」开始。'}</p>
            <p className="cards-empty-sub">建卡后自动统计全书出场次数、覆盖章节与断档情况。</p>
          </div>
        ) : (
          <ul className="cards-list">
            {filteredCharacters.map((c) => (
              <li key={c.id} className={`card-item${dragId === c.id ? ' card-item-dragging' : ''}`}
                draggable={sortMode === 'custom'}
                onDragStart={() => setDragId(c.id)}
                onDragOver={(e) => e.preventDefault()}
                onDrop={() => void handleDrop(c.id)}
                onDragEnd={() => setDragId(null)}
              >
                <div className="card-item-head">
                  {sortMode === 'custom' && (
                    <span className="card-drag-handle" title="拖拽排序"><IconGripVertical size={14} /></span>
                  )}
                  <button className="card-head" onClick={() => openCharacter(c.id)} title="点击进入角色卡深度编辑">
                    <span className="card-name">{c.name}</span>
                    {c.role && <span className="badge-role">{c.role}</span>}
                    {c.faction && <span className="badge-faction">{c.faction}</span>}
                    {c.isPov && <span className="badge-pov">POV</span>}
                    {c.alive === false && <span className="badge-dead">已故</span>}
                    {c.tags.length > 0 && c.tags.slice(0, 2).map((t) => (<span key={t} className="badge-tag">{t}</span>))}
                    {c.aliases.length > 0 && <span className="card-aliases">{c.aliases.join('、')}</span>}
                    <span className="card-stats">{fmt(c.totalMentions)} 次 · {c.chapterCount} 章</span>
                    <span style={{ opacity: 0.4, marginLeft: 4, display: 'inline-flex' }}><IconExternalLink size={12} /></span>
                  </button>
                </div>
                <div className="card-sub">
                  {c.firstChapterTitle ? (
                    <span>首现《{c.firstChapterTitle}》 · 末现《{c.lastChapterTitle}》</span>
                  ) : (
                    <span className="heat-sub">正文尚未出现（写完即自动统计）</span>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )
      ) : tab === 'locations' && editingLocation === null ? (
        locations.length === 0 ? (
          <div className="cards-empty">
            <p>还没有地点卡。点击「新建地点」，记录故事发生的舞台。</p>
          </div>
        ) : (
          <ul className="cards-list">
            {locations.map((l) => (
              <li key={l.id} className="card-item">
                <button className="card-head" onClick={() => setEditingLocation(l.id)}>
                  <span className="card-name">{l.name}</span>
                  <span className="card-stats">{fmt(l.totalMentions)} 次 · {l.chapterCount} 章</span>
                </button>
                <div className="card-sub">
                  {l.firstChapterTitle ? (
                    <span>首现《{l.firstChapterTitle}》 · 末现《{l.lastChapterTitle}》</span>
                  ) : (
                    <span className="heat-sub">正文尚未出现</span>
                  )}
                </div>
                {editingLocation === l.id && (
                  <>
                    <LocationForm initial={l} onSubmit={(v) => void submitLocation(v)} onCancel={() => setEditingLocation(null)} busy={busy} />
                    <div className="card-danger">
                      <button className="btn btn-danger btn-mini" onClick={() => void removeLocation(l.id, l.name)} disabled={busy}>
                        <IconTrash size={13} /> 删除此卡
                      </button>
                    </div>
                  </>
                )}
              </li>
            ))}
          </ul>
        )
      ) : null}
    </Modal>
  );
}
