/**
 * 修订工作台（审查新增功能 P2）。
 * ① 静态检查：超长句、相邻重复词 / 叠字、重复标点；② 跨章查找替换（预览 + 单事务 + 自动快照）。
 */
import { useState } from 'react';
import {
  analyzeRevision,
  applyCrossReplace,
  previewCrossReplace,
  type ChapterHit,
  type RevisionHit,
} from '../../api';
import { useAppStore } from '../../store/appStore';
import { Modal } from '../Modal';

const REV_KIND_LABEL: Record<string, string> = {
  long_sentence: '超长句',
  repeated_word: '重复词',
  repeated_punct: '叠字 / 标点',
};

export function RevisionModal({ onClose }: { onClose: () => void }) {
  const showToast = useAppStore((s) => s.showToast);
  const selectChapter = useAppStore((s) => s.selectChapter);
  const [tab, setTab] = useState<'lint' | 'replace'>('lint');

  // 静态检查
  const [longLimit, setLongLimit] = useState(80);
  const [revHits, setRevHits] = useState<RevisionHit[] | null>(null);
  const [lintBusy, setLintBusy] = useState(false);

  // 跨章替换
  const [find, setFind] = useState('');
  const [replace, setReplace] = useState('');
  const [hits, setHits] = useState<ChapterHit[] | null>(null);
  const [repBusy, setRepBusy] = useState(false);

  const runLint = async () => {
    setLintBusy(true);
    try {
      setRevHits(await analyzeRevision(longLimit));
    } catch (e) {
      showToast(String(e), 'error');
    } finally {
      setLintBusy(false);
    }
  };

  const doPreview = async () => {
    if (!find.trim()) {
      showToast('请输入查找内容', 'error');
      return;
    }
    setHits(null);
    try {
      setHits(await previewCrossReplace(find, null));
    } catch (e) {
      showToast(String(e), 'error');
    }
  };

  const doApply = async () => {
    const total = (hits ?? []).reduce((s, h) => s + h.count, 0);
    if (total === 0) return;
    if (!confirm(`将在 ${hits?.length ?? 0} 章替换 ${total} 处，改动章节会自动留存历史版本，确认？`))
      return;
    setRepBusy(true);
    try {
      const n = await applyCrossReplace(find, replace, null);
      showToast(`已替换 ${n} 处`, 'info');
      setHits([]);
    } catch (e) {
      showToast(String(e), 'error');
    } finally {
      setRepBusy(false);
    }
  };

  const gotoChapter = (id: number) => {
    selectChapter(id);
    onClose();
  };

  return (
    <Modal title="修订工作台" onClose={onClose} width={700}>
      <div className="tool-tabs">
        <button className={tab === 'lint' ? 'active' : ''} onClick={() => setTab('lint')}>
          静态检查
        </button>
        <button className={tab === 'replace' ? 'active' : ''} onClick={() => setTab('replace')}>
          跨章查找替换
        </button>
      </div>

      {tab === 'lint' && (
        <>
          <div className="tool-row">
            <label className="tool-inline">
              单句超过
              <input
                type="number"
                min={20}
                value={longLimit}
                onChange={(e) => setLongLimit(Number(e.target.value) || 80)}
              />
              字提示拆分
            </label>
            <span className="tool-spacer" />
            <button className="btn btn-primary" disabled={lintBusy} onClick={runLint}>
              {lintBusy ? '检查中…' : '开始检查'}
            </button>
          </div>
          {revHits === null ? (
            <p className="info-empty">点击「开始检查」扫描全书。</p>
          ) : revHits.length === 0 ? (
            <p className="info-empty">未发现明显问题。</p>
          ) : (
            <div className="issue-list">
              {revHits.slice(0, 500).map((h, i) => (
                <div className="issue-card" key={i} onClick={() => gotoChapter(h.chapterId)}>
                  <div className="issue-head">
                    <span className="issue-kind">{REV_KIND_LABEL[h.kind] ?? h.kind}</span>
                    <span className="issue-title">{h.chapterTitle}</span>
                  </div>
                  <p className="issue-detail">
                    {h.message}
                    {h.snippet ? `：${h.snippet}` : ''}
                  </p>
                </div>
              ))}
              {revHits.length > 500 && (
                <p className="info-empty">仅显示前 500 条，共 {revHits.length} 条。</p>
              )}
            </div>
          )}
        </>
      )}

      {tab === 'replace' && (
        <>
          <div className="tool-row">
            <span className="tool-label">查找</span>
            <input
              className="input"
              value={find}
              onChange={(e) => setFind(e.target.value)}
              placeholder="要全书替换的原文"
            />
          </div>
          <div className="tool-row">
            <span className="tool-label">替换为</span>
            <input
              className="input"
              value={replace}
              onChange={(e) => setReplace(e.target.value)}
              placeholder="留空即删除"
            />
          </div>
          <div className="tool-row">
            <span className="tool-spacer" />
            <button className="btn" onClick={doPreview}>
              预览
            </button>
            <button
              className="btn btn-primary"
              disabled={repBusy || !hits || hits.reduce((s, h) => s + h.count, 0) === 0}
              onClick={doApply}
            >
              {repBusy ? '替换中…' : '确认替换'}
            </button>
          </div>
          {hits === null ? (
            <p className="info-empty">输入后点「预览」查看将改动的章节。</p>
          ) : hits.length === 0 ? (
            <p className="info-empty">全书没有匹配内容。</p>
          ) : (
            <div className="tool-hit-list">
              <div className="tool-hit-summary">
                {hits.length} 章 / {hits.reduce((s, h) => s + h.count, 0)} 处
              </div>
              {hits.map((h) => (
                <div className="tool-hit" key={h.chapterId} onClick={() => gotoChapter(h.chapterId)}>
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
        </>
      )}
    </Modal>
  );
}
