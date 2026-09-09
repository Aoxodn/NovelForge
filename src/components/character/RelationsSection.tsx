import { useState } from 'react';
import * as api from '../../api';
import { useAppStore } from '../../store/appStore';
import { IconPlus, IconTrash } from '../icons';
import type { CharacterProfile, CharacterRelation } from '../../types/models';
import { REL_CATEGORY_STYLE, REL_TYPE_OPTIONS } from '../canvas/routing';

/** 人物关系管理区：五类关系的新建 / 编辑 / 删除 */
export function RelationsSection({
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
