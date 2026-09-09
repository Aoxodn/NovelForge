/**
 * 场景级写作板（审查新增功能 P1）。
 * 章下分场景：POV / 时间 / 地点 / 目标 / 冲突 / 结果 / 目标字数 / 场景正文，
 * 支持上下移动重排，并可把全部场景合成为章节正文（覆盖前自动留版本）。
 */
import { useEffect, useState } from 'react';
import {
  composeScenesToChapter,
  createScene,
  deleteScene,
  listScenes,
  reorderScenes,
  updateScene,
  type Scene,
} from '../../api';
import { useAppStore } from '../../store/appStore';
import { useEditorStore } from '../../store/editorStore';
import { Modal } from '../Modal';

interface Props {
  chapterId: number;
  chapterTitle: string;
  onClose: () => void;
}

export function SceneBoardModal({ chapterId, chapterTitle, onClose }: Props) {
  const showToast = useAppStore((s) => s.showToast);
  const refreshTree = useAppStore((s) => s.refreshTree);
  const [scenes, setScenes] = useState<Scene[]>([]);
  const [loading, setLoading] = useState(true);
  const [composing, setComposing] = useState(false);

  const reload = () =>
    listScenes(chapterId)
      .then(setScenes)
      .catch((e) => showToast(String(e), 'error'))
      .finally(() => setLoading(false));

  useEffect(() => {
    setLoading(true);
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chapterId]);

  const add = async () => {
    try {
      await createScene(chapterId);
      await reload();
    } catch (e) {
      showToast(String(e), 'error');
    }
  };

  const patch = async (id: number, p: Partial<Scene>) => {
    setScenes((prev) => prev.map((s) => (s.id === id ? { ...s, ...p } : s)));
    try {
      await updateScene(id, p);
    } catch (e) {
      showToast(String(e), 'error');
    }
  };

  const remove = async (id: number) => {
    if (!confirm('删除这个场景？')) return;
    await deleteScene(id).catch((e) => showToast(String(e), 'error'));
    void reload();
  };

  const move = async (index: number, dir: -1 | 1) => {
    const target = index + dir;
    if (target < 0 || target >= scenes.length) return;
    const next = scenes.slice();
    [next[index], next[target]] = [next[target], next[index]];
    setScenes(next);
    await reorderScenes(
      chapterId,
      next.map((s) => s.id),
    ).catch((e) => showToast(String(e), 'error'));
  };

  const compose = async (overwrite: boolean) => {
    setComposing(true);
    try {
      const text = await composeScenesToChapter(chapterId, overwrite);
      await useEditorStore.getState().loadChapter(chapterId, true);
      await refreshTree();
      showToast(`已合成为章节正文（${text.length} 字）`, 'info');
      onClose();
    } catch (e) {
      showToast(String(e), 'error');
    } finally {
      setComposing(false);
    }
  };

  return (
    <Modal
      title={`场景写作板 · ${chapterTitle}`}
      onClose={onClose}
      width={760}
      footer={
        <>
          <span className="tool-hint-inline">场景按顺序合成为章节正文，地点会以【】标注。</span>
          <span className="tool-spacer" />
          <button className="btn" disabled={composing} onClick={() => compose(false)}>
            合成（仅空章）
          </button>
          <button className="btn btn-primary" disabled={composing} onClick={() => compose(true)}>
            {composing ? '合成中…' : '合成并覆盖正文'}
          </button>
        </>
      }
    >
      {loading ? (
        <p className="info-empty">加载中…</p>
      ) : scenes.length === 0 ? (
        <p className="info-empty">本章还没有场景，点「新增场景」开始拆解。</p>
      ) : (
        <div className="scene-list">
          {scenes.map((s, i) => (
            <div className="scene-card" key={s.id}>
              <div className="scene-head">
                <span className="arc-index">场景 {i + 1}</span>
                <button className="btn btn-mini" disabled={i === 0} onClick={() => move(i, -1)}>
                  ↑
                </button>
                <button
                  className="btn btn-mini"
                  disabled={i === scenes.length - 1}
                  onClick={() => move(i, 1)}
                >
                  ↓
                </button>
                <button className="btn btn-mini btn-ghost" onClick={() => remove(s.id)}>
                  删除
                </button>
              </div>
              <div className="scene-meta-grid">
                <input
                  placeholder="POV 视角"
                  value={s.pov}
                  onChange={(e) => patch(s.id, { pov: e.target.value })}
                />
                <input
                  placeholder="时间"
                  value={s.timeOfScene}
                  onChange={(e) => patch(s.id, { timeOfScene: e.target.value })}
                />
                <input
                  placeholder="地点"
                  value={s.place}
                  onChange={(e) => patch(s.id, { place: e.target.value })}
                />
                <input
                  type="number"
                  placeholder="目标字数"
                  value={s.targetWords || ''}
                  onChange={(e) => patch(s.id, { targetWords: Number(e.target.value) || 0 })}
                />
              </div>
              <div className="scene-meta-grid">
                <input
                  placeholder="目标（这场要达成什么）"
                  value={s.goal}
                  onChange={(e) => patch(s.id, { goal: e.target.value })}
                />
                <input
                  placeholder="冲突（阻碍是什么）"
                  value={s.conflict}
                  onChange={(e) => patch(s.id, { conflict: e.target.value })}
                />
                <input
                  placeholder="结果（收尾 / 转折）"
                  value={s.result}
                  onChange={(e) => patch(s.id, { result: e.target.value })}
                />
              </div>
              <textarea
                className="scene-content"
                rows={4}
                placeholder="场景正文草稿"
                value={s.content}
                onChange={(e) => patch(s.id, { content: e.target.value })}
              />
            </div>
          ))}
        </div>
      )}
      <div className="tool-row">
        <button className="btn" onClick={add}>
          + 新增场景
        </button>
      </div>
    </Modal>
  );
}
