/**
 * 回收站：软删除章节列表，支持恢复 / 彻底删除。
 * 打开时后端自动清理超过 7 天的条目。
 */
import { useCallback, useEffect, useState } from 'react';
import * as api from '../api';
import { useAppStore } from '../store/appStore';
import { Modal } from './Modal';
import { fmt } from '../utils/text';
import type { DeletedChapter } from '../types/models';

export function TrashModal({
  onClose,
  onChanged,
}: {
  onClose: () => void;
  onChanged: () => Promise<void> | void;
}) {
  const showToast = useAppStore((s) => s.showToast);
  const [list, setList] = useState<DeletedChapter[]>([]);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setList(await api.listDeletedChapters());
    } catch (e) {
      showToast(String(e), 'error');
    }
  }, [showToast]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const restore = async (c: DeletedChapter) => {
    if (busy) return;
    setBusy(true);
    try {
      await api.restoreChapter(c.id);
      await onChanged();
      await refresh();
      showToast(`已恢复「${c.title}」`);
    } catch (e) {
      showToast(String(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  const purge = async (c: DeletedChapter) => {
    if (busy) return;
    const ok = window.confirm(
      `彻底删除「${c.title}」？\n\n此操作不可恢复（连同历史版本一并删除）。`,
    );
    if (!ok) return;
    setBusy(true);
    try {
      await api.purgeChapter(c.id);
      await refresh();
      showToast('已彻底删除');
    } catch (e) {
      showToast(String(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="回收站" onClose={onClose} width={520}>
      {list.length === 0 ? (
        <p className="cards-empty">
          回收站是空的。
          <br />
          <span className="cards-empty-sub">
            删除的章节会在这里保留 7 天，到期自动彻底清除。
          </span>
        </p>
      ) : (
        <>
          <ul className="trash-list">
            {list.map((c) => (
              <li key={c.id} className="trash-item">
                <div className="trash-main">
                  <span className="trash-title">{c.title}</span>
                  <span className="trash-meta">
                    {c.volumeTitle} · {fmt(c.wordCount)} 字 · {c.deletedAt} 删除
                  </span>
                </div>
                <button className="btn btn-mini" disabled={busy} onClick={() => void restore(c)}>
                  恢复
                </button>
                <button
                  className="btn btn-mini btn-danger"
                  disabled={busy}
                  onClick={() => void purge(c)}
                >
                  彻底删除
                </button>
              </li>
            ))}
          </ul>
          <p className="form-hint">回收站中的章节不参与字数统计 / 导出 / 搜索，超过 7 天自动清除。</p>
        </>
      )}
    </Modal>
  );
}
