/**
 * 大纲编辑弹窗：全书大纲 / 卷大纲共用。
 * Ctrl+Enter 或「保存」按钮提交，Esc / 遮罩点击取消。
 */
import { useState } from 'react';
import { Modal } from './Modal';

interface OutlineModalProps {
  title: string;
  hint: string;
  initial: string;
  onClose: () => void;
  onSave: (text: string) => Promise<void>;
}

export function OutlineModal({ title, hint, initial, onClose, onSave }: OutlineModalProps) {
  const [text, setText] = useState(initial);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await onSave(text);
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={title}
      onClose={onClose}
      width={560}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            取消
          </button>
          <button className="btn btn-primary" disabled={busy} onClick={() => void save()}>
            {busy ? '保存中…' : '保存'}
          </button>
        </>
      }
    >
      <div className="form-row">
        <label>{hint}（Ctrl+Enter 保存）</label>
        <textarea
          className="input textarea outline-modal-input"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.ctrlKey && e.key === 'Enter') {
              e.preventDefault();
              void save();
            }
          }}
          placeholder="自由书写，支持长文本…"
          autoFocus
        />
      </div>
    </Modal>
  );
}
