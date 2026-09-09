/**
 * 保存失败阻断对话框（审查 P0）：
 * 切章 / 返回首页 / 关闭窗口时若自动保存失败，弹出本对话框，
 * 提供「重试保存 / 导出未保存正文 / 强制退出」三条路径，
 * 杜绝保存失败后仍清空编辑器、静默丢字。
 */
import { useState } from 'react';
import { save as saveDialog } from '@tauri-apps/plugin-dialog';
import * as api from '../api';

interface Props {
  /** 失败原因 */
  reason: string;
  /** 章节标题 */
  title: string;
  /** 未保存正文 */
  content: string;
  /** 重试保存（成功返回 true） */
  onRetry: () => Promise<boolean>;
  /** 强制退出（用户已知晓风险） */
  onForceExit: () => void;
  /** 关闭对话框（取消退出，回到编辑） */
  onCancel: () => void;
}

export function SaveFailureDialog({ reason, title, content, onRetry, onForceExit, onCancel }: Props) {
  const [busy, setBusy] = useState(false);
  const [hint, setHint] = useState('');

  const handleRetry = async () => {
    setBusy(true);
    setHint('');
    try {
      const ok = await onRetry();
      if (ok) onCancel();
      else setHint('仍然保存失败，可导出正文后再退出，或选择强制退出。');
    } finally {
      setBusy(false);
    }
  };

  const handleExport = async () => {
    setBusy(true);
    setHint('');
    try {
      const path = await saveDialog({
        defaultPath: `${title || '未命名章节'}-抢救备份.txt`,
        filters: [{ name: '纯文本', extensions: ['txt'] }],
      });
      if (!path) {
        setBusy(false);
        return;
      }
      await api.emergencyDumpText(path, title || '未命名章节', content);
      setHint('正文已导出。现在可以安全退出。');
    } catch (e) {
      setHint(`导出失败：${String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-mask">
      <div className="modal" style={{ width: 480 }} onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span>保存失败，正文尚未落库</span>
        </div>
        <div className="modal-body">
          <p style={{ margin: '0 0 10px', color: 'var(--text-dim)', fontSize: 13, lineHeight: 1.6 }}>
            自动保存未成功，直接退出会丢失当前章节未保存的内容。请选择处理方式：
          </p>
          <div
            style={{
              padding: '8px 10px',
              background: 'rgba(226,91,91,0.08)',
              borderRadius: 6,
              fontSize: 12,
              color: 'var(--text-dim)',
              marginBottom: 12,
              wordBreak: 'break-all',
            }}
          >
            {reason}
          </div>
          {hint && (
            <div style={{ fontSize: 12, color: 'var(--accent)', marginBottom: 10 }}>{hint}</div>
          )}
        </div>
        <div className="modal-footer" style={{ justifyContent: 'space-between' }}>
          <button className="btn btn-danger-ghost" disabled={busy} onClick={onForceExit}>
            强制退出（丢弃）
          </button>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn" disabled={busy} onClick={onCancel}>
              返回编辑
            </button>
            <button className="btn btn-ghost" disabled={busy} onClick={handleExport}>
              导出未保存正文
            </button>
            <button className="btn btn-primary" disabled={busy} onClick={handleRetry}>
              {busy ? '处理中…' : '重试保存'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
