import { useEffect, useMemo, useRef, useState } from 'react';
import { useAppStore } from '../store/appStore';
import { addCharacter, deleteCharacter, listCharacters, updateCharacter } from '../api';
import type { CharacterProfile } from '../types/models';
import { roleColor } from './canvas/routing';

const ROLE_OPTIONS = ['主角', '配角', '反派', '龙套'];
const FILTER_OPTIONS = ['全部', ...ROLE_OPTIONS];

export function CharacterCardView() {
  const charFocusId = useAppStore((s) => s.charFocusId);
  const clearCharFocus = useAppStore((s) => s.clearCharFocus);
  const setViewMode = useAppStore((s) => s.setViewMode);

  const [chars, setChars] = useState<CharacterProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('全部');

  // 编辑状态
  const [editName, setEditName] = useState('');
  const [editAliases, setEditAliases] = useState('');
  const [editRole, setEditRole] = useState('配角');
  const [editNotes, setEditNotes] = useState('');
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const list = await listCharacters();
      setChars(list);
      if (list.length > 0 && selectedId === null) {
        setSelectedId(list[0].id);
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  // 从图谱跳转过来时选中对应角色
  useEffect(() => {
    if (charFocusId !== null) {
      setSelectedId(charFocusId);
      clearCharFocus();
    }
  }, [charFocusId, clearCharFocus]);

  const selected = useMemo(
    () => chars.find((c) => c.id === selectedId) ?? null,
    [chars, selectedId],
  );

  // 选中角色时加载到编辑区
  useEffect(() => {
    if (selected) {
      setEditName(selected.name);
      setEditAliases(selected.aliases.join('、'));
      setEditRole(selected.role || '配角');
      setEditNotes(selected.notes || '');
      setDirty(false);
    }
  }, [selected]);

  // 自动保存（防抖 800ms）
  useEffect(() => {
    if (!dirty || selectedId === null) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      setSaving(true);
      try {
        const aliases = editAliases
          .split(/[、,，\s]+/)
          .map((s) => s.trim())
          .filter(Boolean);
        await updateCharacter(selectedId, {
          name: editName.trim() || selected?.name,
          aliases,
          role: editRole,
          notes: editNotes,
        });
        setDirty(false);
        // 刷新列表（名字/角色可能变了）
        const list = await listCharacters();
        setChars(list);
      } catch {
        // 保存失败不弹错，用户继续编辑
      } finally {
        setSaving(false);
      }
    }, 800);
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, [dirty, editName, editAliases, editRole, editNotes, selectedId, selected]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return chars
      .filter((c) => filter === '全部' || c.role === filter)
      .filter(
        (c) =>
          !q ||
          c.name.toLowerCase().includes(q) ||
          c.aliases.some((a) => a.toLowerCase().includes(q)),
      )
      .sort((a, b) => {
        // 主角 > 反派 > 配角 > 龙套，同级别按提及数降序
        const order: Record<string, number> = { 主角: 0, 反派: 1, 配角: 2, 龙套: 3 };
        const ra = order[a.role] ?? 9;
        const rb = order[b.role] ?? 9;
        if (ra !== rb) return ra - rb;
        return b.totalMentions - a.totalMentions;
      });
  }, [chars, search, filter]);

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

  const markDirty = () => setDirty(true);

  return (
    <div className="char-card-view">
      {/* 左侧角色列表 */}
      <aside className="char-list-panel">
        <div className="char-list-header">
          <input
            className="char-search"
            placeholder="搜索角色名 / 别名…"
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
        <div className="char-list">
          {loading ? (
            <div className="char-list-empty">加载中…</div>
          ) : filtered.length === 0 ? (
            <div className="char-list-empty">
              {chars.length === 0 ? '还没有角色，点击右上角新建' : '没有匹配的角色'}
            </div>
          ) : (
            filtered.map((c) => (
              <div
                key={c.id}
                className={`char-list-item${selectedId === c.id ? ' active' : ''}`}
                onClick={() => setSelectedId(c.id)}
              >
                <span
                  className="char-dot"
                  style={{ background: roleColor(c.role) }}
                />
                <span className="char-item-name">{c.name}</span>
                {c.aliases.length > 0 && (
                  <span className="char-item-alias">{c.aliases[0]}</span>
                )}
                <span className="char-item-count">{c.totalMentions}</span>
              </div>
            ))
          )}
        </div>
        <div className="char-list-footer">共 {chars.length} 个角色</div>
      </aside>

      {/* 右侧角色卡编辑区 */}
      <main className="char-editor">
        {selected ? (
          <>
            <div className="char-editor-header">
              <input
                className="char-name-input"
                value={editName}
                onChange={(e) => {
                  setEditName(e.target.value);
                  markDirty();
                }}
                placeholder="角色姓名"
              />
              <select
                className="char-role-select"
                value={editRole}
                onChange={(e) => {
                  setEditRole(e.target.value);
                  markDirty();
                }}
              >
                {ROLE_OPTIONS.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
              <span className="char-save-state">
                {saving ? '保存中…' : dirty ? '未保存' : '已保存'}
              </span>
            </div>

            <div className="char-meta-row">
              <label className="char-meta-label">别名</label>
              <input
                className="char-aliases-input"
                value={editAliases}
                onChange={(e) => {
                  setEditAliases(e.target.value);
                  markDirty();
                }}
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
                value={editNotes}
                onChange={(e) => {
                  setEditNotes(e.target.value);
                  markDirty();
                }}
                placeholder={`外貌描写\n性格特征\n背景故事\n人物弧光\n关键台词\n关系网络\n……`}
                spellCheck={false}
              />
            </div>

            <div className="char-actions">
              <button
                className="btn btn-ghost"
                onClick={() => setViewMode('map')}
              >
                在故事地图查看
              </button>
              <button className="btn btn-danger-ghost" onClick={handleDelete}>
                删除角色
              </button>
            </div>
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
