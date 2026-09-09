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
import type { CharacterHeat, CharacterMeta, CharacterProfile, CharacterRelation } from '../types/models';
import { roleColor } from './canvas/routing';
import { useDurableDraft } from '../hooks/useDurableDraft';
import { RenameCharacterModal } from './tools/RenameCharacterModal';
import { CharacterArcModal } from './tools/CharacterArcModal';
import { HeatBars } from './character/HeatBars';
import { RelationsSection } from './character/RelationsSection';

const ROLE_OPTIONS = ['主角', '配角', '反派', '龙套'];
const FILTER_OPTIONS = ['全部', ...ROLE_OPTIONS];
const IMPORTANCE_LABEL = ['龙套', '次要', '配角', '核心'];
const ROW_H = 38; // 虚拟列表行高（px），与 CSS .char-list-item 高度保持一致
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
        if (v.filter) setFilter(v.filter);
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
    if (selectedId === null) {
      setHeat(null);
      return;
    }
    let cancelled = false;
    getCharacterHeat(selectedId).then((h) => {
      if (!cancelled) setHeat(h);
    }).catch(() => { if (!cancelled) setHeat(null); });
    return () => { cancelled = true; };
  }, [selectedId]);

  // 可靠草稿：切换角色前自动 flush 上一角色，保存失败显示持久错误条
  const { draft, setDraft, dirty, saving, error, reset, retry, flush } = useDurableDraft<CharDraft>(
    selectedId,
    emptyDraft(),
    async (id, d) => {
      const aliases = d.aliasesText
        .split(/[、,，\s]+/)
        .map((s) => s.trim())
        .filter(Boolean);
      const tags = d.tagsText
        .split(/[、,，\s]+/)
        .map((s) => s.trim())
        .filter(Boolean);
      const customFields: Record<string, string> = {};
      for (const kv of d.custom) {
        const k = kv.k.trim();
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
        name: d.name.trim() || undefined,
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
    try {
      const [list, cf, rels] = await Promise.all([listCharacters(), getAliasConflicts(), listAllCharacterRelations()]);
      setChars(list);
      setConflicts(cf);
      setRelations(rels);
      if (list.length > 0 && selectedId === null) {
        setSelectedId(list[0].id);
      }
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
    if (charFocusId !== null) {
      setSelectedId(charFocusId);
      clearCharFocus();
    }
  }, [charFocusId, clearCharFocus]);

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
        custom: Object.entries(selected.customFields ?? {}).map(([k, v]) => ({ k, v })),
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

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
        // 重要度优先，其次角色序，再按全书提及
        if ((b.importance ?? 1) !== (a.importance ?? 1))
          return (b.importance ?? 1) - (a.importance ?? 1);
        const order: Record<string, number> = { 主角: 0, 反派: 1, 配角: 2, 龙套: 3 };
        const ra = order[a.role] ?? 9;
        const rb = order[b.role] ?? 9;
        if (ra !== rb) return ra - rb;
        return b.totalMentions - a.totalMentions;
      });
  }, [chars, search, filter]);

  // 虚拟列表可见窗口（100~300 人物也不卡顿，审查 UX-3）
  const totalH = filtered.length * ROW_H;
  const startIdx = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN);
  const endIdx = Math.min(
    filtered.length,
    Math.ceil((scrollTop + viewportH) / ROW_H) + OVERSCAN,
  );
  const visible = filtered.slice(startIdx, endIdx);

  const handleAdd = async () => {
    try {
      const c = await addCharacter('新角色', [], '配角', '');
      setChars((prev) => [...prev, c]);
      setSelectedId(c.id);
    } catch {
      // ignore
    }
  };

  const handleDelete = async () => {
    if (selectedId === null) return;
    if (!confirm(`确定删除角色「${selected?.name}」？该角色的关联和提及记录将一并清除。`)) return;
    try {
      await deleteCharacter(selectedId);
      const list = await listCharacters();
      setChars(list);
      setSelectedId(list.length > 0 ? list[0].id : null);
    } catch {
      // ignore
    }
  };

  const setCustom = (i: number, patch: Partial<{ k: string; v: string }>) =>
    setDraft({
      custom: draft.custom.map((kv, idx) => (idx === i ? { ...kv, ...patch } : kv)),
    });

  return (
    <div className="char-card-view">
      {/* 左侧角色列表 */}
      <aside className="char-list-panel">
        <div className="char-list-header">
          <input
            className="char-search"
            placeholder="搜索名 / 别名 / 阵营 / 标签…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <button className="btn btn-mini btn-primary" onClick={handleAdd}>
            + 新建
          </button>
        </div>
        <div className="char-filter-row">
          {FILTER_OPTIONS.map((f) => (
            <button
              key={f}
              className={`char-filter-chip${filter === f ? ' active' : ''}`}
              onClick={() => setFilter(f)}
            >
              {f}
            </button>
          ))}
        </div>
        {conflicts.length > 0 && (
          <div className="char-conflict-banner" title="同一称谓被多张人物卡声明，统计只会归属其一，请改名或调整别名">
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
              {chars.length === 0 ? '还没有角色，点击右上角新建' : '没有匹配的角色'}
            </div>
          ) : (
            <div style={{ height: totalH, position: 'relative' }}>
              {visible.map((c, i) => {
                const idx = startIdx + i;
                return (
                  <div
                    key={c.id}
                    className={`char-list-item${selectedId === c.id ? ' active' : ''}`}
                    style={{
                      position: 'absolute',
                      top: idx * ROW_H,
                      left: 0,
                      right: 0,
                      height: ROW_H,
                    }}
                    onClick={() => setSelectedId(c.id)}
                    title={`${c.name}${c.faction ? ' · ' + c.faction : ''}`}
                  >
                    <span className="char-dot" style={{ background: roleColor(c.role) }} />
                    <span className="char-item-name">
                      {c.name}
                      {c.isPov && <span className="char-pov-badge" title="POV 视角人物">视</span>}
                      {c.alive === false && <span className="char-dead-badge" title="已死亡">亡</span>}
                    </span>
                    {c.aliases.length > 0 && (
                      <span className="char-item-alias">{c.aliases[0]}</span>
                    )}
                    <span className="char-item-count">{c.totalMentions}</span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
        <div className="char-list-footer">
          共 {chars.length} 个角色{filtered.length !== chars.length && ` · 筛选 ${filtered.length}`}
        </div>
      </aside>

      {/* 右侧角色卡编辑区 */}
      <main className="char-editor">
        {selected ? (
          <>
            <div className="char-editor-header">
              <input
                className="char-name-input"
                value={draft.name}
                onChange={(e) => setDraft({ name: e.target.value })}
                placeholder="角色姓名"
              />
              <select
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
              <span className="char-save-state">
                {error ? '保存失败' : saving ? '保存中…' : dirty ? '未保存' : '已保存'}
              </span>
              <button
                className={`btn btn-mini ${dirty ? 'btn-primary' : 'btn-ghost'}`}
                disabled={!dirty || saving}
                onClick={() => void flush()}
              >
                {saving ? '保存中…' : '保存'}
              </button>
            </div>

            {error && (
              <div className="char-error-bar">
                保存失败：{error}
                <button className="btn btn-mini" onClick={() => void retry()}>
                  重试
                </button>
              </div>
            )}

            {/* 群像扩展字段：重要度 / POV / 存亡 / 阵营 */}
            <div className="char-meta-grid">
              <label className="char-field">
                <span className="char-field-label">重要度</span>
                <select
                  value={draft.importance}
                  onChange={(e) => setDraft({ importance: Number(e.target.value) })}
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
                  onChange={(e) => setDraft({ alive: e.target.value as AliveState })}
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
                  onChange={(e) => setDraft({ isPov: e.target.checked })}
                />
                <span className="char-field-label">POV 视角人物</span>
              </label>
              <label className="char-field char-field-wide">
                <span className="char-field-label">阵营 / 势力</span>
                <input
                  value={draft.faction}
                  onChange={(e) => setDraft({ faction: e.target.value })}
                  placeholder="如：守夜人 / 第三舰队…"
                />
              </label>
              <label className="char-field char-field-wide">
                <span className="char-field-label">标签</span>
                <input
                  value={draft.tagsText}
                  onChange={(e) => setDraft({ tagsText: e.target.value })}
                  placeholder="多个标签用顿号 / 逗号分隔"
                />
              </label>
            </div>

            <div className="char-meta-row">
              <label className="char-meta-label">别名</label>
              <input
                className="char-aliases-input"
                value={draft.aliasesText}
                onChange={(e) => setDraft({ aliasesText: e.target.value })}
                placeholder="多个别名用顿号或逗号分隔"
              />
            </div>

            <div className="char-stats-row">
              <div className="char-stat">
                <span className="char-stat-num">{selected.totalMentions}</span>
                <span className="char-stat-label">全书提及</span>
              </div>
              <div className="char-stat">
                <span className="char-stat-num">{selected.chapterCount}</span>
                <span className="char-stat-label">出场章节</span>
              </div>
              {selected.firstChapterTitle && (
                <div className="char-stat char-stat-wide">
                  <span className="char-stat-label">首次出场</span>
                  <span className="char-stat-text">{selected.firstChapterTitle}</span>
                </div>
              )}
              {selected.lastChapterTitle && (
                <div className="char-stat char-stat-wide">
                  <span className="char-stat-label">最近出场</span>
                  <span className="char-stat-text">{selected.lastChapterTitle}</span>
                </div>
              )}
            </div>

            <div className="char-notes-area">
              <div className="char-notes-label">角色人设</div>
              <textarea
                className="char-notes-textarea"
                value={draft.notes}
                onChange={(e) => setDraft({ notes: e.target.value })}
                placeholder={`外貌描写\n性格特征\n背景故事\n人物弧光\n关键台词\n关系网络\n……`}
                spellCheck={false}
              />
            </div>

            {/* 自定义字段：作者按需扩展结构化人设，不预设固定列（审查 UX-3） */}
            <div className="char-custom-area">
              <div className="char-notes-label">
                自定义字段
                <button
                  className="btn btn-mini"
                  onClick={() => setDraft({ custom: [...draft.custom, { k: '', v: '' }] })}
                >
                  + 添加
                </button>
              </div>
              {draft.custom.map((kv, i) => (
                <div className="char-custom-row" key={i}>
                  <input
                    className="char-custom-key"
                    value={kv.k}
                    placeholder="字段名（如：武器 / 生日 / 口头禅）"
                    onChange={(e) => setCustom(i, { k: e.target.value })}
                  />
                  <input
                    className="char-custom-val"
                    value={kv.v}
                    placeholder="内容"
                    onChange={(e) => setCustom(i, { v: e.target.value })}
                  />
                  <button
                    className="btn btn-mini btn-ghost"
                    onClick={() =>
                      setDraft({ custom: draft.custom.filter((_, idx) => idx !== i) })
                    }
                  >
                    删
                  </button>
                </div>
              ))}
            </div>

            {/* 热度走势 */}
            <div className="char-heat-section">
              <div className="char-section-title">出场热度</div>
              {heat ? (
                <HeatBars heat={heat} />
              ) : (
                <p className="heat-sub">加载中…</p>
              )}
            </div>

            {/* 人物关系 */}
            {selected && (
              <div className="char-relations-section">
                <div className="char-section-title">人物关系</div>
                <RelationsSection
                  characterId={selected.id}
                  characters={chars}
                  relations={relations}
                  onChanged={async () => {
                    setRelations(await listAllCharacterRelations());
                  }}
                />
              </div>
            )}

            <div className="char-actions">
              <button className="btn btn-ghost" onClick={() => setViewMode('map')}>
                在故事地图查看
              </button>
              <button className="btn btn-ghost" onClick={() => setShowRename(true)}>
                全书改名
              </button>
              <button className="btn btn-ghost" onClick={() => setShowArc(true)}>
                弧光追踪
              </button>
              <button className="btn btn-danger-ghost" onClick={handleDelete}>
                删除角色
              </button>
            </div>
            {showRename && selected && (
              <RenameCharacterModal
                characterId={selected.id}
                currentName={selected.name}
                onClose={() => setShowRename(false)}
                onRenamed={() => void load()}
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
          </div>
        )}
      </main>
    </div>
  );
}
