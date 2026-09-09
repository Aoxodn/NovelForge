/**
 * 人物弧光追踪（审查新增功能 P2）。
 * 按章节为角色记录「欲望 — 选择 — 代价 — 状态变化」，叠加在人物轨迹之上。
 */
import { useEffect, useMemo, useState } from 'react';
import {
  createArc,
  deleteArc,
  listArcs,
  updateArc,
  type CharacterArc,
} from '../../api';
import { useAppStore } from '../../store/appStore';
import { Modal } from '../Modal';

interface Props {
  characterId: number;
  characterName: string;
  onClose: () => void;
}

const FIELDS: { key: keyof CharacterArc; label: string; ph: string }[] = [
  { key: 'desire', label: '欲望', ph: '这一阶段他想要什么？' },
  { key: 'choice', label: '选择', ph: '他为此做了什么 / 放弃了什么？' },
  { key: 'cost', label: '代价', ph: '他失去 / 承担了什么？' },
  { key: 'stateChange', label: '状态变化', ph: '经历后他成为了什么样的人？' },
];

export function CharacterArcModal({ characterId, characterName, onClose }: Props) {
  const tree = useAppStore((s) => s.tree);
  const showToast = useAppStore((s) => s.showToast);
  const [arcs, setArcs] = useState<CharacterArc[]>([]);
  const [loading, setLoading] = useState(true);

  const chapterOptions = useMemo(() => {
    return (tree?.chapters ?? []).map((c) => ({ id: c.id, title: c.title }));
  }, [tree]);

  const reload = () =>
    listArcs(characterId)
      .then(setArcs)
      .catch((e) => showToast(String(e), 'error'))
      .finally(() => setLoading(false));

  useEffect(() => {
    setLoading(true);
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [characterId]);

  const add = async () => {
    try {
      await createArc(characterId, null);
      await reload();
    } catch (e) {
      showToast(String(e), 'error');
    }
  };

  const patch = async (id: number, p: Partial<CharacterArc>) => {
    setArcs((prev) => prev.map((a) => (a.id === id ? { ...a, ...p } : a)));
    try {
      await updateArc(id, p);
    } catch (e) {
      showToast(String(e), 'error');
    }
  };

  const remove = async (id: number) => {
    if (!confirm('删除这个弧光节点？')) return;
    await deleteArc(id).catch((e) => showToast(String(e), 'error'));
    void reload();
  };

  return (
    <Modal
      title={`人物弧光 · ${characterName}`}
      onClose={onClose}
      width={720}
      footer={
        <>
          <span className="tool-hint-inline">沿章节顺序记录角色的成长与转折，避免群像角色成长跳跃。</span>
          <span className="tool-spacer" />
          <button className="btn btn-primary" onClick={add}>
            + 新增弧光节点
          </button>
        </>
      }
    >
      {loading ? (
        <p className="info-empty">加载中…</p>
      ) : arcs.length === 0 ? (
        <p className="info-empty">还没有弧光节点，点击右下角新增。</p>
      ) : (
        <div className="arc-list">
          {arcs.map((a, i) => (
            <div className="arc-card" key={a.id}>
              <div className="arc-card-head">
                <span className="arc-index">#{i + 1}</span>
                <select
                  value={a.chapterId ?? ''}
                  onChange={(e) =>
                    patch(a.id, { chapterId: e.target.value ? Number(e.target.value) : null })
                  }
                >
                  <option value="">不绑定章节</option>
                  {chapterOptions.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.title}
                    </option>
                  ))}
                </select>
                <button className="btn btn-mini btn-ghost" onClick={() => remove(a.id)}>
                  删除
                </button>
              </div>
              <div className="arc-grid">
                {FIELDS.map((f) => (
                  <label className="arc-field" key={f.key}>
                    <span>{f.label}</span>
                    <textarea
                      rows={2}
                      value={(a[f.key] as string) ?? ''}
                      placeholder={f.ph}
                      onChange={(e) => patch(a.id, { [f.key]: e.target.value } as Partial<CharacterArc>)}
                    />
                  </label>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}
