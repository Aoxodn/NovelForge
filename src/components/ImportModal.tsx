/**
 * 智能导入对话框（文档第十六至二十三节）：
 *
 * 选择文件 → 后台规则引擎分析 → 预览（章节 / 置信度 / 字数 / 正文摘要）
 * → 点击行可取消/恢复章节边界 → 选择目标卷 → 确认事务落库。
 *
 * 两种取消语义（防止「标题不同但内容重复」）：
 * - 普通章节取消：误判边界，正文并入前一章（智能合并）；
 * - 重复章节（标「重」）取消：内容已存在，正文直接丢弃。
 *
 * 设计要点：分析结果缓存于 Rust 侧，确认时只回传
 * 「会话 id + 被取消的边界索引」，大文本不经过前端往返。
 */
import { useEffect, useState } from 'react';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import * as api from '../api';
import { useAppStore } from '../store/appStore';
import type { ImportAnalysis, PreviewChapter } from '../types/models';
import { Modal } from './Modal';
import { fmt } from '../utils/text';

export function ImportModal({
  onClose,
  presetPath,
}: {
  onClose: () => void;
  /** 预选文件路径（从首页「导入小说」流程带入），跳过文件选择器 */
  presetPath?: string;
}) {
  const tree = useAppStore((s) => s.tree)!;
  const refreshTree = useAppStore((s) => s.refreshTree);
  const showToast = useAppStore((s) => s.showToast);

  const [analysis, setAnalysis] = useState<ImportAnalysis | null>(null);
  const [excluded, setExcluded] = useState<Set<number>>(new Set());
  const [discarded, setDiscarded] = useState<Set<number>>(new Set());
  const [volumeChoice, setVolumeChoice] = useState<string>('new');
  const [newVolumeTitle, setNewVolumeTitle] = useState('');
  const [expanded, setExpanded] = useState<number | null>(null);
  const [importing, setImporting] = useState(false);

  // 打开即弹出文件选择并分析（后台线程，不阻塞 UI）；
  // 带预选路径时（首页导入流程）跳过选择器直接分析
  useEffect(() => {
    let cancelled = false;
    (async () => {
      let file: string | null = presetPath ?? null;
      if (!file) {
        file = await openDialog({
          multiple: false,
          title: '选择要导入的小说文档',
          filters: [{ name: '小说文档', extensions: ['txt', 'docx', 'md'] }],
        });
      }
      if (typeof file !== 'string') {
        onClose();
        return;
      }
      try {
        const a = await api.importAnalyzeFile(file);
        if (!cancelled) setAnalysis(a);
      } catch (e) {
        showToast(String(e), 'error');
        onClose();
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 重复章节默认排除（丢弃语义：内容已在库中，不再导入）
  useEffect(() => {
    if (!analysis) return;
    const dups = analysis.chapters.filter((c) => c.duplicateOf).map((c) => c.index);
    if (dups.length > 0) setDiscarded(new Set(dups));
  }, [analysis]);

  // 卸载（取消 / 关闭）时显式释放后端分析缓存，避免大文本长期滞留内存（审查 P1-7）。
  // 成功导入后后端已消费该缓存，此处 cancel 为幂等空操作。
  useEffect(() => {
    const id = analysis?.id;
    return () => {
      if (id) void api.importCancel(id).catch(() => undefined);
    };
  }, [analysis?.id]);

  // 普通块取消 → 并入前一章；重复块取消 → 丢弃内容
  const toggleChapter = (c: PreviewChapter) => {
    const toggle = (setter: typeof setExcluded) =>
      setter((prev) => {
        const next = new Set(prev);
        if (next.has(c.index)) next.delete(c.index);
        else next.add(c.index);
        return next;
      });
    if (c.duplicateOf) toggle(setDiscarded);
    else toggle(setExcluded);
  };

  const keptCount = analysis
    ? analysis.chapters.length - excluded.size - discarded.size
    : 0;

  const confirm = async () => {
    if (!analysis || importing) return;
    setImporting(true);
    const volumeId = volumeChoice === 'new' ? null : Number(volumeChoice);
    const newTitle =
      volumeChoice === 'new'
        ? newVolumeTitle.trim() || analysis.fileName
        : null;
    try {
      const res = await api.importConfirm({
        analysisId: analysis.id,
        excluded: [...excluded],
        discarded: [...discarded],
        volumeId,
        newVolumeTitle: newTitle,
      });
      showToast(`已导入 ${res.chapterCount} 章（${fmt(res.wordCount)} 字）`);
      await refreshTree();
      onClose();
    } catch (e) {
      showToast(String(e), 'error');
      setImporting(false);
    }
  };

  return (
    <Modal
      title="智能导入"
      onClose={importing ? () => undefined : onClose}
      width={680}
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={importing}>
            取消
          </button>
          <button
            className="btn btn-primary"
            onClick={() => void confirm()}
            disabled={importing || !analysis || keptCount === 0}
          >
            {importing ? '导入中…' : `确认导入 ${keptCount} 章`}
          </button>
        </>
      }
    >
      {!analysis ? (
        <div className="import-loading">正在分析文档，识别章节结构…</div>
      ) : (
        <>
          <div className="import-summary">
            <span className="import-file" title={analysis.fileName}>
              {analysis.fileName}
            </span>
            <span>
              检测到 <b>{analysis.chapters.length}</b> 章
            </span>
            <span>
              共 <b>{fmt(analysis.totalWordCount)}</b> 字
            </span>
          </div>

          <div className="form-row import-volume-row">
            <label>导入到</label>
            <div className="dir-picker">
              <select
                className="select"
                value={volumeChoice}
                onChange={(e) => setVolumeChoice(e.target.value)}
              >
                <option value="new">＋ 新建卷</option>
                {tree.volumes.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.title}（{v.chapterCount} 章）
                  </option>
                ))}
              </select>
              {volumeChoice === 'new' && (
                <input
                  className="input"
                  placeholder={`卷名（默认：${analysis.fileName}）`}
                  value={newVolumeTitle}
                  onChange={(e) => setNewVolumeTitle(e.target.value)}
                />
              )}
            </div>
          </div>

          <p className="form-hint">
            点击章节行可取消 / 恢复导入：普通章节取消后正文并入前一章；标记「重」的章节与已有内容重复，取消后不导入（内容已在库中）；⚠
            为低置信度，建议展开核对。
          </p>

          <div className="import-list">
            {analysis.chapters.map((c) => {
              const off = excluded.has(c.index) || discarded.has(c.index);
              return (
                <div
                  key={c.index}
                  className={`import-chapter${off ? ' excluded' : ''}${c.duplicateOf ? ' dup' : ''}`}
                >
                  <div
                    className="import-chapter-main"
                    onClick={() => toggleChapter(c)}
                    title={c.duplicateOf ? `与${c.duplicateOf}内容重复` : undefined}
                  >
                    {c.duplicateOf ? (
                      <span className="conf-badge dup" title={`重复：${c.duplicateOf}`}>
                        重
                      </span>
                    ) : (
                      <span
                        className={`conf-badge ${
                          c.confidence >= 0.9
                            ? 'high'
                            : c.confidence >= 0.6
                              ? 'mid'
                              : 'low'
                        }`}
                        title={`识别规则：${c.rule}`}
                      >
                        {c.confidence >= 0.6 ? '✓' : '⚠'}
                      </span>
                    )}
                    <span className="import-chapter-title">{c.title}</span>
                    <span className="import-chapter-words">
                      {fmt(c.wordCount)} 字
                    </span>
                    <span className="import-chapter-conf">
                      {Math.round(c.confidence * 100)}%
                    </span>
                    <button
                      className="btn btn-mini"
                      onClick={(e) => {
                        e.stopPropagation();
                        setExpanded(expanded === c.index ? null : c.index);
                      }}
                    >
                      {expanded === c.index ? '收起' : '预览'}
                    </button>
                  </div>
                  {expanded === c.index && (
                    <div className="import-chapter-preview">
                      {c.preview || '（无正文）'}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}
    </Modal>
  );
}
