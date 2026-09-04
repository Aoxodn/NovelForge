/**
 * 导出对话框（文档第四十八节）：格式（TXT/DOCX/MD）× 范围（全部/当前卷/当前章节）。
 * PDF 涉及排版引擎，留待后续版本。
 */
import { useState } from 'react';
import { save as saveDialog } from '@tauri-apps/plugin-dialog';
import * as api from '../api';
import { useAppStore } from '../store/appStore';
import { useEditorStore } from '../store/editorStore';
import type { ExportFormat, ExportScope } from '../types/models';
import { Modal } from './Modal';
import { fmt } from '../utils/text';

const FORMATS: { value: ExportFormat; label: string; ext: string; desc: string }[] = [
  { value: 'txt', label: 'TXT', ext: 'txt', desc: '通用纯文本（UTF-8 带 BOM）' },
  { value: 'docx', label: 'DOCX', ext: 'docx', desc: 'Word 文档（标题居中加粗）' },
  { value: 'md', label: 'Markdown', ext: 'md', desc: '结构化标记文本' },
];

export function ExportModal({ onClose }: { onClose: () => void }) {
  const tree = useAppStore((s) => s.tree)!;
  const showToast = useAppStore((s) => s.showToast);
  const editorVolumeId = useEditorStore((s) => s.volumeId);
  const editorChapterId = useEditorStore((s) => s.chapterId);

  const [format, setFormat] = useState<ExportFormat>('txt');
  const [scope, setScope] = useState<ExportScope>('all');
  const [busy, setBusy] = useState(false);

  // 当前卷 / 当前章节的默认目标
  const currentVolume = tree.volumes.find((v) => v.id === editorVolumeId) ?? null;

  const doExport = async () => {
    if (busy) return;
    const f = FORMATS.find((x) => x.value === format)!;

    // 范围校验
    if (scope === 'volume' && !currentVolume) {
      showToast('请先选择一个章节以确定当前卷', 'error');
      return;
    }
    if (scope === 'chapter' && editorChapterId === null) {
      showToast('请先打开要导出的章节', 'error');
      return;
    }

    const scopeLabel =
      scope === 'all' ? '全书' : scope === 'volume' ? `《${currentVolume!.title}》` : '当前章节';
    const selected = await saveDialog({
      title: `导出 ${scopeLabel}`,
      defaultPath: `${tree.info.name}${scope === 'all' ? '' : ` - ${scopeLabel}`}.${f.ext}`,
      filters: [{ name: f.label, extensions: [f.ext] }],
    });
    if (typeof selected !== 'string' || !selected) return;

    setBusy(true);
    try {
      const res = await api.exportNovel({
        format,
        scope,
        volumeId: scope === 'volume' ? currentVolume!.id : null,
        chapterId: scope === 'chapter' ? editorChapterId : null,
        outputPath: selected,
      });
      showToast(`已导出 ${res.chapterCount} 章（${fmt(res.wordCount)} 字）`);
      onClose();
    } catch (e) {
      showToast(String(e), 'error');
      setBusy(false);
    }
  };

  return (
    <Modal
      title="导出小说"
      onClose={busy ? () => undefined : onClose}
      width={460}
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button className="btn btn-primary" onClick={() => void doExport()} disabled={busy}>
            {busy ? '导出中…' : '选择位置并导出'}
          </button>
        </>
      }
    >
      <div className="form-row">
        <label>格式</label>
        <div className="export-formats">
          {FORMATS.map((f) => (
            <button
              key={f.value}
              className={`export-format${format === f.value ? ' active' : ''}`}
              onClick={() => setFormat(f.value)}
            >
              <span className="export-format-name">{f.label}</span>
              <span className="export-format-desc">{f.desc}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="form-row">
        <label>范围</label>
        <div className="export-scopes">
          <button
            className={`chip${scope === 'all' ? ' active' : ''}`}
            onClick={() => setScope('all')}
          >
            全书（{tree.stats.chapterCount} 章）
          </button>
          <button
            className={`chip${scope === 'volume' ? ' active' : ''}`}
            onClick={() => setScope('volume')}
            disabled={!currentVolume}
            title={currentVolume ? undefined : '未选择章节'}
          >
            当前卷{currentVolume ? `（${currentVolume.chapterCount} 章）` : ''}
          </button>
          <button
            className={`chip${scope === 'chapter' ? ' active' : ''}`}
            onClick={() => setScope('chapter')}
            disabled={editorChapterId === null}
            title={editorChapterId !== null ? undefined : '未打开章节'}
          >
            当前章节
          </button>
        </div>
      </div>
      <p className="form-hint">导出包含卷名与章节标题；作者笔记与内部数据不会写入。</p>
    </Modal>
  );
}
