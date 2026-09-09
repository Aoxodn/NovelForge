/**
 * 连续性检查器（审查新增功能 P1）。
 * 纯本地确定性规则：死者再现 / 伏笔逾期未回收 / 角色长期断档。
 * 问题带确认队列，可忽略或标记已解决，并可跳转到对应章节。
 */
import { useEffect, useState } from 'react';
import {
  listContinuity,
  scanContinuity,
  setContinuityStatus,
  type ContinuityIssue,
} from '../../api';
import { useAppStore } from '../../store/appStore';
import { Modal } from '../Modal';

const KIND_LABEL: Record<string, string> = {
  dead_reappear: '死者再现',
  foreshadow_overdue: '伏笔逾期',
  long_absence: '长期断档',
};

export function ContinuityModal({ onClose }: { onClose: () => void }) {
  const showToast = useAppStore((s) => s.showToast);
  const selectChapter = useAppStore((s) => s.selectChapter);
  const setViewMode = useAppStore((s) => s.setViewMode);
  const [issues, setIssues] = useState<ContinuityIssue[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [absenceGap, setAbsenceGap] = useState(10);
  const [overdueGap, setOverdueGap] = useState(15);

  const reload = () =>
    listContinuity()
      .then(setIssues)
      .catch((e) => showToast(String(e), 'error'));

  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const scan = async () => {
    setBusy(true);
    try {
      const r = await scanContinuity(absenceGap, overdueGap);
      setIssues(r);
      showToast(`扫描完成，当前 ${r.length} 条待处理`, 'info');
    } catch (e) {
      showToast(String(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  const setStatus = async (id: number, status: number) => {
    await setContinuityStatus(id, status).catch((e) => showToast(String(e), 'error'));
    void reload();
  };

  const goto = (it: ContinuityIssue) => {
    if (it.chapterId != null) {
      selectChapter(it.chapterId);
      setViewMode('editor');
      onClose();
    }
  };

  return (
    <Modal
      title="连续性检查"
      onClose={onClose}
      width={680}
      footer={
        <>
          <label className="tool-inline">
            断档阈值
            <input
              type="number"
              min={1}
              value={absenceGap}
              onChange={(e) => setAbsenceGap(Number(e.target.value) || 10)}
            />
            章
          </label>
          <label className="tool-inline">
            伏笔阈值
            <input
              type="number"
              min={1}
              value={overdueGap}
              onChange={(e) => setOverdueGap(Number(e.target.value) || 15)}
            />
            章
          </label>
          <span className="tool-spacer" />
          <button className="btn btn-primary" disabled={busy} onClick={scan}>
            {busy ? '扫描中…' : '重新扫描'}
          </button>
        </>
      }
    >
      <div className="tool-hint">
        规则完全在本地运行：已标记死亡的角色再次出现、活跃伏笔超过阈值未回收、角色长期不出场。
        结果只做提示，是否处理由你决定。
      </div>
      {issues === null ? (
        <p className="info-empty">加载中…</p>
      ) : issues.length === 0 ? (
        <p className="info-empty">没有待处理的连续性问题。</p>
      ) : (
        <div className="issue-list">
          {issues.map((it) => (
            <div className={`issue-card issue-${it.kind}`} key={it.id}>
              <div className="issue-head">
                <span className="issue-kind">{KIND_LABEL[it.kind] ?? it.kind}</span>
                <span className="issue-title">{it.title}</span>
              </div>
              <p className="issue-detail">{it.detail}</p>
              <div className="issue-actions">
                {it.chapterId != null && (
                  <button className="btn btn-mini" onClick={() => goto(it)}>
                    跳到章节
                  </button>
                )}
                <button className="btn btn-mini" onClick={() => setStatus(it.id, 2)}>
                  已解决
                </button>
                <button className="btn btn-mini btn-ghost" onClick={() => setStatus(it.id, 1)}>
                  忽略
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}
