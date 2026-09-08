/**
 * 人物图谱共享弹窗（L1 故事地图 / L2 卷内画布共用）：
 * - RelationCreateModal：画布上从人物节点拉线到另一人物 → 建关系
 * - RelationEditModal：点击关系边 → 编辑子类型 / 方向 / 说明 / 作用范围 / 删除
 * - CharacterPickModal：右键空白「添加人物」→ 从人物卡中挑一个上画布
 */
import { useState } from 'react';
import * as api from '../api';
import { useAppStore } from '../store/appStore';
import type { CharacterProfile, CharacterRelation } from '../types/models';
import { Modal } from './Modal';
import { REL_CATEGORY_STYLE, REL_TYPE_OPTIONS } from './canvas/routing';

const CATEGORIES = [1, 2, 3, 4, 5];

/** 关系表单主体（新建 / 编辑共用） */
function RelationForm({
  category,
  setCategory,
  relType,
  setRelType,
  customType,
  setCustomType,
  direction,
  setDirection,
  label,
  setLabel,
  scope,
  setScope,
  scopeOptions,
}: {
  category: number;
  setCategory: (v: number) => void;
  relType: string;
  setRelType: (v: string) => void;
  customType: string;
  setCustomType: (v: string) => void;
  direction: number;
  setDirection: (v: number) => void;
  label: string;
  setLabel: (v: string) => void;
  scope: number | null;
  setScope: (v: number | null) => void;
  scopeOptions: { id: number | null; title: string }[];
}) {
  return (
    <>
      <div className="edge-type-picker">
        {CATEGORIES.map((c) => (
          <button
            key={c}
            className={`btn btn-mini edge-choice${category === c ? ' active' : ''}`}
            style={category === c ? { borderColor: REL_CATEGORY_STYLE[c].color, color: REL_CATEGORY_STYLE[c].color } : undefined}
            onClick={() => {
              setCategory(c);
              setRelType('');
            }}
          >
            {REL_CATEGORY_STYLE[c].name}
          </button>
        ))}
      </div>
      <span className="field-label">子类型</span>
      <div style={{ display: 'flex', gap: 8 }}>
        <select className="select" value={relType} onChange={(e) => setRelType(e.target.value)}>
          <option value="">选择…</option>
          {(REL_TYPE_OPTIONS[category] ?? []).map((t) => (
            <option key={t} value={t}>{t}</option>
          ))}
        </select>
        <input
          className="input"
          style={{ flex: 1 }}
          value={customType}
          placeholder="或自定义类型"
          onChange={(e) => setCustomType(e.target.value)}
        />
      </div>
      <span className="field-label">方向</span>
      <div className="edge-type-picker">
        <button className={`btn btn-mini${direction === 0 ? ' active' : ''}`} onClick={() => setDirection(0)}>
          双向 —
        </button>
        <button className={`btn btn-mini${direction === 1 ? ' active' : ''}`} onClick={() => setDirection(1)}>
          单向 →
        </button>
      </div>
      <span className="field-label">补充说明（可选）</span>
      <input className="input" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="如：亦师亦敌" />
      <span className="field-label">作用范围</span>
      <select
        className="select"
        value={scope === null ? '' : String(scope)}
        onChange={(e) => setScope(e.target.value === '' ? null : Number(e.target.value))}
      >
        {scopeOptions.map((o) => (
          <option key={String(o.id)} value={String(o.id)}>{o.title}</option>
        ))}
      </select>
    </>
  );
}

export function RelationCreateModal({
  fromChar,
  toChar,
  fromName,
  toName,
  defaultScope,
  scopeOptions,
  onClose,
  onCreated,
}: {
  fromChar: number;
  toChar: number;
  fromName: string;
  toName: string;
  /** 默认作用范围（L2 传当前卷，L1 传 null = 跨卷） */
  defaultScope: number | null;
  scopeOptions: { id: number | null; title: string }[];
  onClose: () => void;
  onCreated: () => void | Promise<void>;
}) {
  const showToast = useAppStore((s) => s.showToast);
  const [category, setCategory] = useState<number>(3);
  const [relType, setRelType] = useState('');
  const [customType, setCustomType] = useState('');
  const [direction, setDirection] = useState(0);
  const [label, setLabel] = useState('');
  const [scope, setScope] = useState<number | null>(defaultScope);

  const create = async () => {
    try {
      await api.createCharacterRelation({
        fromChar,
        toChar,
        relCategory: category,
        relType: (customType.trim() || relType).trim(),
        label: label.trim(),
        direction,
        volumeId: scope,
      });
      await onCreated();
    } catch (e) {
      showToast(String(e), 'error');
    }
  };

  return (
    <Modal
      title="建立人物关系"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>取消</button>
          <button className="btn btn-primary" onClick={() => void create()}>
            创建
          </button>
        </>
      }
    >
      <p className="modal-hint">
        {fromName} {direction === 1 ? '→' : '—'} {toName}
      </p>
      <RelationForm
        category={category}
        setCategory={setCategory}
        relType={relType}
        setRelType={setRelType}
        customType={customType}
        setCustomType={setCustomType}
        direction={direction}
        setDirection={setDirection}
        label={label}
        setLabel={setLabel}
        scope={scope}
        setScope={setScope}
        scopeOptions={scopeOptions}
      />
    </Modal>
  );
}

export function RelationEditModal({
  relation,
  nameById,
  scopeOptions,
  onClose,
  onChanged,
}: {
  relation: CharacterRelation;
  nameById: Map<number, string>;
  scopeOptions: { id: number | null; title: string }[];
  onClose: () => void;
  onChanged: () => void | Promise<void>;
}) {
  const showToast = useAppStore((s) => s.showToast);
  const [category, setCategory] = useState<number>(relation.relCategory);
  const [relType, setRelType] = useState(relation.relType);
  const [customType, setCustomType] = useState('');
  const [direction, setDirection] = useState(relation.direction);
  const [label, setLabel] = useState(relation.label);
  const [scope, setScope] = useState<number | null>(relation.volumeId);

  const save = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      await onChanged();
    } catch (e) {
      showToast(String(e), 'error');
    }
  };

  return (
    <Modal
      title={`人物关系 · ${REL_CATEGORY_STYLE[relation.relCategory]?.name ?? '?'}`}
      onClose={onClose}
      footer={
        <>
          <button
            className="btn danger"
            onClick={() => void save(() => api.deleteCharacterRelation(relation.id))}
          >
            删除关系
          </button>
          <button
            className="btn btn-primary"
            onClick={() =>
              void save(() =>
                api.updateCharacterRelation(relation.id, {
                  relCategory: category,
                  relType: (customType.trim() || relType).trim(),
                  label: label.trim(),
                  direction,
                  volumeId: scope,
                }),
              )
            }
          >
            保存
          </button>
        </>
      }
    >
      <p className="modal-hint">
        {nameById.get(relation.fromChar) ?? '?'} {relation.direction === 1 ? '→' : '—'}{' '}
        {nameById.get(relation.toChar) ?? '?'}
      </p>
      <RelationForm
        category={category}
        setCategory={setCategory}
        relType={relType}
        setRelType={setRelType}
        customType={customType}
        setCustomType={setCustomType}
        direction={direction}
        setDirection={setDirection}
        label={label}
        setLabel={setLabel}
        scope={scope}
        setScope={setScope}
        scopeOptions={scopeOptions}
      />
    </Modal>
  );
}

export function CharacterPickModal({
  profiles,
  usedIds,
  title,
  onClose,
  onPick,
}: {
  profiles: CharacterProfile[];
  /** 已在画布上的人物（置灰不可再选） */
  usedIds: Set<number>;
  title: string;
  onClose: () => void;
  onPick: (p: CharacterProfile) => void | Promise<void>;
}) {
  const list = profiles.filter((p) => !usedIds.has(p.id));
  return (
    <Modal title={title} onClose={onClose} width={460}>
      {list.length === 0 ? (
        <p className="info-empty">没有可添加的人物了。先在「人物 / 地点卡」里建卡。</p>
      ) : (
        <div className="vc-chip-list">
          {list.map((p) => (
            <button key={p.id} className="vc-chip" onClick={() => void onPick(p)}>
              <span
                className="vc-chip-dot"
                style={{ background: p.role === '反派' ? '#e25b5b' : p.role === '龙套' ? '#e2954f' : '#5b8def' }}
              />
              {p.name}
              {p.role ? ` · ${p.role}` : ''}
            </button>
          ))}
        </div>
      )}
      <p className="modal-hint" style={{ marginTop: 10 }}>
        添加后可自由拖动位置；从节点圆点拉线到另一人物建关系，或拖到卷 / 章上建立关联。
      </p>
    </Modal>
  );
}
