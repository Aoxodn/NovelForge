/**
 * 全书安全重命名（审查新增功能 P1）。
 * 先逐章预览命中（唯一归属、可排除对白），确认后单事务替换并自动留章节快照，旧名并入别名。
 */
import { useEffect, useState } from 'react';
import {
  applyRenameCharacter,
  previewRenameCharacter,
  type ChapterHit,
} from '../../api';
import { useAppStore } from '../../store/appStore';
import { Modal } from '../Modal';

interface Props {
  characterId: number;
  currentName: string;
  onClose: () => void;
  /** 应用成功后回调（刷新角色列表） */
  onRenamed?: () => void;
}

export function RenameCharacterModal({ characterId, currentName, onClose, onRenamed }: Props) {
  const showToast = useAppStore((s) => s.showToast);
  const [newName, setNewName] = useState(currentName);
  const [excludeQuotes, setExcludeQuotes] = useState(false);
  const [hits, setHits] = useState<ChapterHit[] | null>(null);
  const [busy, setBusy] = useState(false);

  const total = (hits ?? []).reduce((s, h) => s + h.count, 0);

  const loadPreview = (eq: boolean) => {
    setHits(null);
    previewRenameCharacter(characterId, eq, null)
      .then(setHits)
      .catch((e) => showToast(String(e), 'error'));
  };

  useEffect(() => {
    loadPreview(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [characterId]);

  const toggleQuotes = (v: boolean) => {
    setExcludeQuotes(v);
    loadPreview(v);
  };

  const apply = async () => {
    const name = newName.trim();
    if (!name) {
      showToast('新名字不能为空', 'error');
      return;
    }
    setBusy(true);
    try {
      const n = await applyRenameCharacter(characterId, name, excludeQuotes, null);
      showToast(`已在 ${n} 处完成改名，旧名已并入别名并自动留档`, 'info');
      onRenamed?.();
      onClose();
    } catch (e) {
      showToast(String(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={`全书改名 · ${currentName}`}
      onClose={onClose}
      width={620}
      footer={
        <>
          <label className="tool-check">
            <input
              type="checkbox"
              checked={excludeQuotes}
              onChange={(e) => toggleQuotes(e.target.checked)}
            />
            排除对白（引号内不替换）
          </label>
          <span className="tool-spacer" />
          <button className="btn" onClick={onClose}>
            取消
          </button>
          <button className="btn btn-primary" disabled={busy || total === 0} onClick={apply}>
            {busy ? '处理中…' : `确认替换 ${total} 处`}
          </button>
        </>
      }
    >
      <div className="tool-row">
        <span className="tool-label">新名字</span>
        <input
          className="input"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          placeholder="输入新的角色名"
          autoFocus
        />
      </div>
      <div className="tool-hint">
        替换为单事务执行，每个被改动的章节都会先存一份历史版本，可在章节历史中回退；旧名
        「{currentName}」会自动加入别名，保证改名后仍能识别。
      </div>
      {hits === null ? (
        <p className="info-empty">正在扫描全书…</p>
      ) : hits.length === 0 ? (
        <p className="info-empty">当前正文没有检测到该角色的名字或别名。</p>
      ) : (
        <div className="tool-hit-list">
          <div className="tool-hit-summary">
            共 {hits.length} 章 / {total} 处
          </div>
          {hits.map((h) => (
            <div className="tool-hit" key={h.chapterId}>
              <div className="tool-hit-head">
                <span>{h.chapterTitle}</span>
                <span className="tool-hit-count">{h.count} 处</span>
              </div>
              {h.snippets.map((sn, i) => (
                <div className="tool-snippet" key={i}>
                  …{sn}…
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}
