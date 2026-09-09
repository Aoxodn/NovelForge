import { useEffect, useMemo, useRef, useState } from 'react';
import { useAppStore } from '../store/appStore';
import {
  addCharacter,
  deleteCharacter,
  getAliasConflicts,
  getCharacterHeat,
  listAllCharacterRelations,
  listCharacters,
  updateCharacter,
  type AliasConflict,
} from '../api';
import type {
  CharacterHeat,
  CharacterMeta,
  CharacterProfile,
  CharacterRelation,
} from '../types/models';
import { roleColor } from './canvas/routing';
import { useDurableDraft } from '../hooks/useDurableDraft';
import { RenameCharacterModal } from './tools/RenameCharacterModal';
import { CharacterArcModal } from './tools/CharacterArcModal';
import { HeatBars } from './character/HeatBars';
import { RelationsSection } from './character/RelationsSection';
import { nextCharacterName } from '../utils/characterName';
import '../styles/characters.css';

const ROLE_OPTIONS = ['主角', '配角', '反派', '龙套'];
const FILTER_OPTIONS = ['全部', ...ROLE_OPTIONS];
const IMPORTANCE_LABEL = ['龙套', '次要', '配角', '核心'];
const ROW_H = 52;
const OVERSCAN = 8;

type AliveState = 'unknown' | 'alive' | 'dead';

interface CharDraft {
  name: string;
  aliasesText: string;
  role: string;
  notes: string;
  faction: string;
  alive: AliveState;
  importance: number;
  isPov: boolean;
  tagsText: string;
  /** 自定义字段（键值对，结构化存储，审查 UX-3） */
  custom: { k: string; v: string }[];
}

const emptyDraft = (): CharDraft => ({
  name: '',
  aliasesText: '',
  role: '配角',
  notes: '',
  faction: '',
  alive: 'unknown',
  importance: 1,
  isPov: false,
  tagsText: '',
  custom: [],
});

const VIEW_KEY = 'nf-char-view';

export function CharacterCardView() {
  const charFocusId = useAppStore((s) => s.charFocusId);
  const clearCharFocus = useAppStore((s) => s.clearCharFocus);
  const setViewMode = useAppStore((s) => s.setViewMode);

  const [chars, setChars] = useState<CharacterProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('全部');
  const [conflicts, setConflicts] = useState<AliasConflict[]>([]);
  const [showRename, setShowRename] = useState(false);
  const [showArc, setShowArc] = useState(false);
  const [heat, setHeat] = useState<CharacterHeat | null>(null);
  const [relations, setRelations] = useState<CharacterRelation[]>([]);
  const [section, setSection] = useState<'profile' | 'story'>('profile');
  const [sort, setSort] = useState('importance');
  const [busy, setBusy] = useState(false);
  const actionRef = useRef(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [heatError, setHeatError] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const focusNewName = useRef(false);

  // 虚拟列表窗口
  const listRef = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportH, setViewportH] = useState(600);

  // 恢复保存的视图（筛选 / 排序），审查 UX-3「保存视图」
  useEffect(() => {
    try {
      const raw = localStorage.getItem(VIEW_KEY);
      if (raw) {
        const v = JSON.parse(raw) as { filter?: string };
        if (v.filter && FILTER_OPTIONS.includes(v.filter)) setFilter(v.filter);
      }
    } catch {
      /* ignore */
    }
  }, []);
  useEffect(() => {
    try {
      localStorage.setItem(VIEW_KEY, JSON.stringify({ filter }));
    } catch {
      /* ignore */
    }
  }, [filter]);

  const selected = useMemo(
    () => chars.find((c) => c.id === selectedId) ?? null,
    [chars, selectedId],
  );

  // 选中角色变化时加载热度走势
  useEffect(() => {
    setHeat(null);
    setHeatError(false);
    if (selectedId === null) {
      return;
    }
    let cancelled = false;
    getCharacterHeat(selectedId)
      .then((h) => {
        if (!cancelled) setHeat(h);
      })
      .catch(() => {
        if (!cancelled) setHeatError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedId]);

  // 可靠草稿：切换角色前自动 flush 上一角色，保存失败显示持久错误条
  const { draft, setDraft, dirty, saving, error, reset, retry, flush } =
    useDurableDraft<CharDraft>(
      selectedId,
      emptyDraft(),
      async (id, d) => {
        if (!d.name.trim())
          throw new Error('请填写角色姓名，草稿仍保留在本页。');
        const aliases = d.aliasesText
          .split(/[、,，\s]+/)
          .map((s) => s.trim())
          .filter(Boolean);
        const tags = d.tagsText
          .split(/[、,，\s]+/)
          .map((s) => s.trim())
          .filter(Boolean);
        const customFields: Record<string, string> = Object.create(null);
        for (const kv of d.custom) {
          const k = kv.k.trim();
          if (!k && kv.v.trim())
            throw new Error('请为已填写内容的自定义字段设置名称。');
          if (k && Object.prototype.hasOwnProperty.call(customFields, k))
            throw new Error(`自定义字段「${k}」重名，请使用不同的字段名。`);
          if (k) customFields[k] = kv.v;
        }
        const meta: CharacterMeta = {
          faction: d.faction,
          alive: d.alive === 'unknown' ? null : d.alive === 'alive',
          importance: d.importance,
          isPov: d.isPov,
          tags,
          customFields,
        };
        await updateCharacter(id, {
          name: d.name.trim(),
          aliases,
          role: d.role,
          notes: d.notes,
          meta,
        });
        // 刷新列表（名字/角色/统计可能变化）
        const list = await listCharacters();
        setChars(list);
      },
      800,
    );

  const load = async () => {
    setLoading(true);
    setActionError(null);
    try {
      const [list, cf, rels] = await Promise.all([
        listCharacters(),
        getAliasConflicts(),
        listAllCharacterRelations(),
      ]);
      setChars(list);
      setConflicts(cf);
      setRelations(rels);
      setSelectedId((id) =>
        list.some((c) => c.id === id) ? id : (list[0]?.id ?? null),
      );
      return list;
    } catch (e) {
      setActionError(`加载角色失败：${String(e)}`);
      return null;
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 监听视口尺寸（用于虚拟列表窗口计算）
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    setViewportH(el.clientHeight);
    const ro = new ResizeObserver(() => setViewportH(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // 从图谱跳转过来时选中对应角色
  useEffect(() => {
    if (!loading && charFocusId !== null) {
      if (chars.some((c) => c.id === charFocusId))
        void selectCharacter(charFocusId);
      clearCharFocus();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [charFocusId, loading, clearCharFocus]);

  // 选中角色变化时把权威数据装载进草稿
  useEffect(() => {
    if (selected) {
      reset({
        name: selected.name,
        aliasesText: selected.aliases.join('、'),
        role: selected.role || '配角',
        notes: selected.notes || '',
        faction: selected.faction || '',
        alive:
          selected.alive === null || selected.alive === undefined
            ? 'unknown'
            : selected.alive
              ? 'alive'
              : 'dead',
        importance: selected.importance ?? 1,
        isPov: !!selected.isPov,
        tagsText: (selected.tags ?? []).join('、'),
        custom: Object.entries(selected.customFields ?? {}).map(([k, v]) => ({
          k,
          v,
        })),
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.id]);

  useEffect(() => {
    contentRef.current?.scrollTo({ top: 0 });
  }, [selectedId, section]);

  useEffect(() => {
    if (focusNewName.current && !busy) {
      nameRef.current?.focus();
      nameRef.current?.select();
      focusNewName.current = false;
    }
  }, [selectedId, busy]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return chars
      .filter((c) => filter === '全部' || c.role === filter)
      .filter(
        (c) =>
          !q ||
          c.name.toLowerCase().includes(q) ||
          c.aliases.some((a) => a.toLowerCase().includes(q)) ||
          (c.faction || '').toLowerCase().includes(q) ||
          (c.tags ?? []).some((t) => t.toLowerCase().includes(q)),
      )
      .sort((a, b) => {
        if (sort === 'name') return a.name.localeCompare(b.name, 'zh-CN');
        if (sort === 'mentions')
          return b.totalMentions - a.totalMentions || a.id - b.id;
        // 重要度优先，其次角色序，再按全书提及
        if ((b.importance ?? 1) !== (a.importance ?? 1))
          return (b.importance ?? 1) - (a.importance ?? 1);
        const order: Record<string, number> = {
          主角: 0,
          反派: 1,
          配角: 2,
          龙套: 3,
        };
        const ra = order[a.role] ?? 9;
        const rb = order[b.role] ?? 9;
        if (ra !== rb) return ra - rb;
        return b.totalMentions - a.totalMentions;
      });
  }, [chars, search, filter, sort]);

  useEffect(() => {
    setScrollTop(0);
    if (listRef.current) listRef.current.scrollTop = 0;
  }, [search, filter, sort]);

  useEffect(() => {
    const idx = filtered.findIndex((c) => c.id === selectedId);
    const el = listRef.current;
    if (!el || idx < 0) return;
    const top = idx * ROW_H;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (top + ROW_H > el.scrollTop + el.clientHeight)
      el.scrollTop = top + ROW_H - el.clientHeight;
    setScrollTop(el.scrollTop);
    // Only reveal on selection; editing must not repeatedly move the list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

  // 虚拟列表可见窗口（100~300 人物也不卡顿，审查 UX-3）
  const totalH = filtered.length * ROW_H;
  const safeScrollTop = Math.min(scrollTop, Math.max(0, totalH - viewportH));
  const startIdx = Math.max(0, Math.floor(safeScrollTop / ROW_H) - OVERSCAN);
  const endIdx = Math.min(
    filtered.length,
    Math.ceil((safeScrollTop + viewportH) / ROW_H) + OVERSCAN,
  );
  const visible = filtered.slice(startIdx, endIdx);

  // Await the current save queue before replacing a draft or deleting its row.
  const runAction = async (action: () => void | Promise<void>) => {
    if (actionRef.current) return;
    actionRef.current = true;
    setBusy(true);
    setActionError(null);
    try {
      if (await flush()) await action();
    } catch (e) {
      setActionError(String(e));
    } finally {
      actionRef.current = false;
      setBusy(false);
    }
  };

  const selectCharacter = (id: number) => {
    if (id === selectedId) return;
    return runAction(() => {
      setSelectedId(id);
      setShowRename(false);
      setShowArc(false);
    });
  };

  const handleAdd = () =>
    runAction(async () => {
      const latest = await listCharacters();
      const c = await addCharacter(nextCharacterName(latest), [], '配角', '');
      setChars([...latest, c]);
      setSearch('');
      setFilter('全部');
      setSection('profile');
      focusNewName.current = true;
      setSelectedId(c.id);
    });

  const handleDelete = async () => {
    if (selectedId === null) return;
    if (
      !confirm(
        `确定删除角色「${selected?.name}」？该角色的关联和提及记录将一并清除。`,
      )
    )
      return;
    await runAction(async () => {
      await deleteCharacter(selectedId);
      const list = chars.filter((c) => c.id !== selectedId);
      setChars(list);
      setRelations((prev) =>
        prev.filter(
          (r) => r.fromChar !== selectedId && r.toChar !== selectedId,
        ),
      );
      setSelectedId(list.length > 0 ? list[0].id : null);
    });
  };

  const setCustom = (i: number, patch: Partial<{ k: string; v: string }>) =>
    setDraft({
      custom: draft.custom.map((kv, idx) =>
        idx === i ? { ...kv, ...patch } : kv,
      ),
    });

  return (
    <div className="char-card-view">
      {/* 左侧角色列表 */}
      <aside className="char-list-panel">
        <div className="char-library-heading">
          <div>
            <h2>角色库</h2>
            <span>{chars.length} 位人物 · 编织你的群像</span>
          </div>
          <button
            className="btn btn-mini btn-primary"
            disabled={busy || loading}
            onClick={() => void handleAdd()}
          >
            {busy ? '处理中…' : '+ 新建角色'}
          </button>
        </div>
        <div className="char-list-header">
          <input
            className="char-search"
            aria-label="搜索角色"
            placeholder="搜索名 / 别名 / 阵营 / 标签…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <div className="char-filter-row">
          {FILTER_OPTIONS.map((f) => (
            <button
              key={f}
              className={`char-filter-chip${filter === f ? ' active' : ''}`}
              aria-pressed={filter === f}
              onClick={() => setFilter(f)}
            >
              {f}
            </button>
          ))}
        </div>
        <div className="char-list-sort">
          <span>{filtered.length} 位角色</span>
          <select
            aria-label="角色排序"
            value={sort}
            onChange={(e) => setSort(e.target.value)}
          >
            <option value="importance">重要度优先</option>
            <option value="mentions">提及最多</option>
            <option value="name">姓名排序</option>
          </select>
        </div>
        {conflicts.length > 0 && (
          <div
            className="char-conflict-banner"
            title="同一称谓被多张人物卡声明，统计只会归属其一，请改名或调整别名"
          >
            ⚠ {conflicts.length} 处称谓冲突
          </div>
        )}
        <div
          className="char-list"
          ref={listRef}
          onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
        >
          {loading ? (
            <div className="char-list-empty">加载中…</div>
          ) : filtered.length === 0 ? (
            <div className="char-list-empty">
              {chars.length === 0
                ? '还没有角色，点击右上角新建'
                : '没有匹配的角色'}
            </div>
          ) : (
            <div style={{ height: totalH, position: 'relative' }}>
              {visible.map((c, i) => {
                const idx = startIdx + i;
                return (
                  <button
                    key={c.id}
                    disabled={busy}
                    aria-pressed={selectedId === c.id}
                    className={`char-list-item${selectedId === c.id ? ' active' : ''}`}
                    style={{
                      position: 'absolute',
                      top: idx * ROW_H,
                      left: 0,
                      right: 0,
                      height: ROW_H,
                    }}
                    onClick={() => void selectCharacter(c.id)}
                    title={`${c.name}${c.faction ? ' · ' + c.faction : ''}`}
                  >
                    <span
                      className="char-dot"
                      style={{ background: roleColor(c.role) }}
                    />
                    <span className="char-item-name">
                      {c.name}
                      {c.isPov && (
                        <span className="char-pov-badge" title="POV 视角人物">
                          视
                        </span>
                      )}
                      {c.alive === false && (
                        <span className="char-dead-badge" title="已死亡">
                          亡
                        </span>
                      )}
                    </span>
                    {c.aliases.length > 0 && (
                      <span className="char-item-alias">{c.aliases[0]}</span>
                    )}
                    <span className="char-item-count" title="全书提及次数">
                      {c.totalMentions} 次
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
        <div className="char-list-footer">
          共 {chars.length} 个角色
          {filtered.length !== chars.length && ` · 筛选 ${filtered.length}`}
        </div>
      </aside>

      {/* 右侧角色卡编辑区 */}
      <main className="char-editor">
        {actionError && (
          <div className="char-error-bar" role="alert">
            <span>{actionError}</span>
            <button
              className="btn btn-mini"
              disabled={busy || dirty}
              onClick={() => void load()}
            >
              重新加载
            </button>
            <button
              className="btn btn-mini btn-ghost"
              onClick={() => setActionError(null)}
            >
              关闭
            </button>
          </div>
        )}
        {selected ? (
          <>
            <div className="char-editor-header">
              <input
                ref={nameRef}
                aria-label="角色姓名"
                disabled={busy || showRename}
                className="char-name-input"
                value={draft.name}
                onChange={(e) => setDraft({ name: e.target.value })}
                placeholder="角色姓名"
              />
              <select
                aria-label="角色定位"
                disabled={busy}
                className="char-role-select"
                value={draft.role}
                onChange={(e) => setDraft({ role: e.target.value })}
              >
                {ROLE_OPTIONS.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
              <span className="char-save-state" role="status">
                {error
                  ? '保存失败'
                  : saving
                    ? '保存中…'
                    : dirty
                      ? '未保存'
                      : '已保存'}
              </span>
              <button
                className={`btn btn-mini ${dirty ? 'btn-primary' : 'btn-ghost'}`}
                disabled={!dirty || saving || busy}
                onClick={() => void flush()}
              >
                {saving ? '保存中…' : '保存'}
              </button>
            </div>

            {error && (
              <div className="char-error-bar" role="alert">
                保存失败：{error}
                <button className="btn btn-mini" onClick={() => void retry()}>
                  重试
                </button>
              </div>
            )}

            <nav className="char-section-nav" aria-label="角色信息分区">
              <button
                aria-pressed={section === 'profile'}
                onClick={() => setSection('profile')}
              >
                角色档案
              </button>
              <button
                aria-pressed={section === 'story'}
                onClick={() => setSection('story')}
              >
                出场与关系
              </button>
              <span>编辑后自动保存</span>
            </nav>
            <div className="char-editor-scroll" ref={contentRef}>
              <fieldset
                className="char-detail-fields"
                disabled={busy || showRename}
              >
                <div
                  className="char-profile-content"
                  hidden={section !== 'profile'}
                >
                  <section className="char-sheet">
                    <div className="char-section-heading">
                      <h3>基本信息</h3>
                      <p>定义身份、阵营与故事中的位置</p>
                    </div>

                    {/* 群像扩展字段：重要度 / POV / 存亡 / 阵营 */}
                    <div className="char-meta-grid">
                      <label className="char-field">
                        <span className="char-field-label">重要度</span>
                        <select
                          value={draft.importance}
                          onChange={(e) =>
                            setDraft({ importance: Number(e.target.value) })
                          }
                        >
                          {IMPORTANCE_LABEL.map((lab, i) => (
                            <option key={i} value={i}>
                              {i} · {lab}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="char-field">
                        <span className="char-field-label">存亡</span>
                        <select
                          value={draft.alive}
                          onChange={(e) =>
                            setDraft({ alive: e.target.value as AliveState })
                          }
                        >
                          <option value="unknown">未知</option>
                          <option value="alive">存活</option>
                          <option value="dead">死亡</option>
                        </select>
                      </label>
                      <label className="char-field char-field-check">
                        <input
                          type="checkbox"
                          checked={draft.isPov}
                          onChange={(e) =>
                            setDraft({ isPov: e.target.checked })
                          }
                        />
                        <span className="char-field-label">POV 视角人物</span>
                      </label>
                      <label className="char-field char-field-wide">
                        <span className="char-field-label">阵营 / 势力</span>
                        <input
                          value={draft.faction}
                          onChange={(e) =>
                            setDraft({ faction: e.target.value })
                          }
                          placeholder="如：守夜人 / 第三舰队…"
                        />
                      </label>
                      <label className="char-field char-field-wide">
                        <span className="char-field-label">标签</span>
                        <input
                          value={draft.tagsText}
                          onChange={(e) =>
                            setDraft({ tagsText: e.target.value })
                          }
                          placeholder="多个标签用顿号 / 逗号分隔"
                        />
                      </label>
                    </div>

                    <div className="char-meta-row">
                      <label className="char-meta-label" htmlFor="char-aliases">
                        别名
                      </label>
                      <input
                        id="char-aliases"
                        className="char-aliases-input"
                        value={draft.aliasesText}
                        onChange={(e) =>
                          setDraft({ aliasesText: e.target.value })
                        }
                        placeholder="多个别名用顿号或逗号分隔"
                      />
                    </div>
                    <p className="char-field-hint">
                      这里只修改角色卡姓名；同步替换正文请使用底部「全书改名」。
                    </p>
                  </section>

                  <section className="char-sheet char-notes-area">
                    <div className="char-section-heading">
                      <h3>角色人设</h3>
                      <p>从欲望、弱点和冲突开始，让人物有自己的生命</p>
                    </div>
                    <textarea
                      aria-label="角色人设"
                      className="char-notes-textarea"
                      value={draft.notes}
                      onChange={(e) => setDraft({ notes: e.target.value })}
                      placeholder={`外貌描写\n性格特征\n背景故事\n人物弧光\n关键台词\n关系网络\n……`}
                      spellCheck={false}
                    />
                  </section>

                  {/* 自定义字段：作者按需扩展结构化人设，不预设固定列（审查 UX-3） */}
                  <section className="char-sheet char-custom-area">
                    <div className="char-notes-label">
                      自定义字段
                      <button
                        className="btn btn-mini"
                        onClick={() =>
                          setDraft({
                            custom: [...draft.custom, { k: '', v: '' }],
                          })
                        }
                      >
                        + 添加
                      </button>
                    </div>
                    {draft.custom.length === 0 && (
                      <p className="char-field-hint">
                        按需添加年龄、武器、口头禅等设定，无需填写固定模板。
                      </p>
                    )}
                    {draft.custom.map((kv, i) => (
                      <div className="char-custom-row" key={i}>
                        <input
                          className="char-custom-key"
                          aria-label={`自定义字段 ${i + 1} 名称`}
                          value={kv.k}
                          placeholder="字段名（如：武器 / 生日 / 口头禅）"
                          onChange={(e) => setCustom(i, { k: e.target.value })}
                        />
                        <input
                          className="char-custom-val"
                          aria-label={`自定义字段 ${i + 1} 内容`}
                          value={kv.v}
                          placeholder="内容"
                          onChange={(e) => setCustom(i, { v: e.target.value })}
                        />
                        <button
                          className="btn btn-mini btn-ghost"
                          onClick={() =>
                            setDraft({
                              custom: draft.custom.filter(
                                (_, idx) => idx !== i,
                              ),
                            })
                          }
                        >
                          移除
                        </button>
                      </div>
                    ))}
                  </section>
                </div>

                <div
                  className="char-story-content"
                  hidden={section !== 'story'}
                >
                  <div className="char-stats-row">
                    <div className="char-stat">
                      <span className="char-stat-num">
                        {selected.totalMentions}
                      </span>
                      <span className="char-stat-label">全书提及</span>
                    </div>
                    <div className="char-stat">
                      <span className="char-stat-num">
                        {selected.chapterCount}
                      </span>
                      <span className="char-stat-label">出场章节</span>
                    </div>
                    <div className="char-stat char-stat-wide">
                      <span className="char-stat-label">首次出场</span>
                      <span className="char-stat-text">
                        {selected.firstChapterTitle || '尚未出场'}
                      </span>
                    </div>
                    <div className="char-stat char-stat-wide">
                      <span className="char-stat-label">最近出场</span>
                      <span className="char-stat-text">
                        {selected.lastChapterTitle || '尚未出场'}
                      </span>
                    </div>
                  </div>

                  {/* 热度走势 */}
                  <div className="char-sheet char-heat-section">
                    <div className="char-section-title">出场热度</div>
                    {heatError ? (
                      <p className="char-field-hint" role="status">
                        热度加载失败，请切换角色后重试。
                      </p>
                    ) : heat ? (
                      heat.perChapter.length === 0 ? (
                        <p className="char-field-hint">
                          还没有章节。开始写作后，这里会展示角色的出场分布。
                        </p>
                      ) : (
                        <HeatBars heat={heat} />
                      )
                    ) : (
                      <p className="heat-sub">加载中…</p>
                    )}
                  </div>

                  {/* 人物关系 */}
                  {selected && (
                    <div className="char-sheet char-relations-section">
                      <div className="char-section-title">人物关系</div>
                      <RelationsSection
                        key={selected.id}
                        characterId={selected.id}
                        characters={chars}
                        relations={relations}
                        onChanged={async () => {
                          setRelations(await listAllCharacterRelations());
                        }}
                      />
                    </div>
                  )}
                </div>
              </fieldset>
            </div>

            <div className="char-actions">
              <button
                className="btn btn-ghost"
                disabled={busy}
                onClick={() => void runAction(() => setViewMode('map'))}
              >
                在故事地图查看
              </button>
              <button
                className="btn btn-ghost"
                disabled={busy}
                onClick={() => void runAction(() => setShowRename(true))}
              >
                全书改名
              </button>
              <button
                className="btn btn-ghost"
                disabled={busy}
                onClick={() => void runAction(() => setShowArc(true))}
              >
                弧光追踪
              </button>
              <button
                className="btn btn-danger-ghost"
                disabled={busy}
                onClick={handleDelete}
              >
                删除角色
              </button>
            </div>
            {showRename && selected && (
              <RenameCharacterModal
                characterId={selected.id}
                currentName={selected.name}
                onClose={() => setShowRename(false)}
                onRenamed={() =>
                  void runAction(async () => {
                    const list = await load();
                    const renamed = list?.find((c) => c.id === selectedId);
                    if (renamed)
                      reset({
                        ...draft,
                        name: renamed.name,
                        aliasesText: renamed.aliases.join('、'),
                      });
                  })
                }
              />
            )}
            {showArc && selected && (
              <CharacterArcModal
                characterId={selected.id}
                characterName={selected.name}
                onClose={() => setShowArc(false)}
              />
            )}
          </>
        ) : (
          <div className="char-editor-empty">
            <div className="char-empty-icon">👤</div>
            <p>从左侧选择一个角色，或新建角色开始编辑</p>
            <button
              className="btn btn-primary"
              disabled={busy || loading}
              onClick={() => void handleAdd()}
            >
              + 创建角色
            </button>
          </div>
        )}
      </main>
    </div>
  );
}
