/**
 * 备份管理（文档第六十五、六十六节）：
 * - 立即备份（手动）
 * - 备份列表（自动 / 手动，含恢复）
 * - 恢复前当前数据自动另存 pre-restore 备份，任何恢复可反悔
 */
import { useCallback, useEffect, useState } from 'react';
import * as api from '../api';
import { useAppStore } from '../store/appStore';
import { useEditorStore } from '../store/editorStore';
import type { BackupInfo } from '../types/models';
import { Modal } from './Modal';

/** 备份文件体积可读化 */
function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function BackupModal({ onClose }: { onClose: () => void }) {
  const showToast = useAppStore((s) => s.showToast);
  const [backups, setBackups] = useState<BackupInfo[]>([]);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setBackups(await api.listBackups());
    } catch {
      setBackups([]);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const doBackup = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await api.backupProject(false);
      showToast('备份完成');
      await refresh();
    } catch (e) {
      showToast(String(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  const doRestore = async (b: BackupInfo) => {
    if (busy) return;
    const ok = window.confirm(
      `确定恢复到备份「${b.time}」吗？\n\n当前全部数据将被该备份覆盖。\n（恢复前会自动保存一份当前数据的备份，可再次恢复回来）`,
    );
    if (!ok) return;
    setBusy(true);
    try {
      // 恢复前冲刷未保存内容没有意义（库文件即将被覆盖），直接清空编辑器状态
      const ed = useEditorStore.getState();
      if (ed.chapterId !== null && ed.dirty) {
        await ed.save(false);
      }
      const tree = await api.restoreBackup(b.fileName);
      // 恢复后：重置编辑器并用新树刷新界面
      useEditorStore.getState().clear();
      useAppStore.setState({ tree, selectedChapterId: null });
      showToast('已恢复到备份');
      onClose();
    } catch (e) {
      showToast(String(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="备份与恢复"
      onClose={busy ? () => undefined : onClose}
      width={480}
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={busy}>
            关闭
          </button>
          <button className="btn btn-primary" onClick={() => void doBackup()} disabled={busy}>
            {busy ? '处理中…' : '立即备份'}
          </button>
        </>
      }
    >
      <p className="form-hint">
        自动备份每 30 分钟执行一次（保留最近 20 份）；备份保存在项目目录 backups/ 内，随项目一起迁移。
      </p>
      <div className="backup-list">
        {backups.length === 0 ? (
          <div className="search-empty">暂无备份</div>
        ) : (
          backups.map((b) => (
            <div key={b.fileName} className="backup-item">
              <span className={`backup-kind ${b.kind === '自动' ? 'auto' : 'manual'}`}>
                {b.kind}
              </span>
              <span className="backup-time">{b.time}</span>
              <span className="backup-size">{fmtSize(b.size)}</span>
              <button
                className="btn btn-mini"
                disabled={busy}
                onClick={() => void doRestore(b)}
              >
                恢复
              </button>
            </div>
          ))
        )}
      </div>
    </Modal>
  );
}
