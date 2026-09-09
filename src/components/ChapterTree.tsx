/**
 * 左侧小说目录（文档第十一、十二节）：
 * 卷（可折叠）/ 章节两级树；支持右键菜单、跨卷拖拽、卷内排序。
 */
import { useEffect, useMemo, useState } from 'react';
import * as api from '../api';
import { useAppStore } from '../store/appStore';
import { useEditorStore } from '../store/editorStore';
import type { ChapterMeta, Volume } from '../types/models';
import { ContextMenu } from './ContextMenu';
import { PromptModal } from './Modal';
import { ImportModal } from './ImportModal';
import {
  IconChevron,
  IconImport,
  IconMore,
  IconPlus,
  IconSortReverse,
  IconTrash,
} from './icons';
import { TrashModal } from './TrashModal';
import { fmt } from '../utils/text';

interface DragState {
  type: 'chapter';
  chapterId: number;
  fromVolumeId: number;
}
interface VolumeDragState {
  type: 'volume';
  volumeId: number;
}
type AnyDrag = DragState | VolumeDragState | null;

export function ChapterTree() {
  const tree = useAppStore((s) => s.tree)!;
  const selectedChapterId = useAppStore((s) => s.selectedChapterId);
  const selectChapter = useAppStore((s) => s.selectChapter);
  const refreshTree = useAppStore((s) => s.refreshTree);
  const showToast = useAppStore((s) => s.showToast);
  const pendingImportPath = useAppStore((s) => s.pendingImportPath);
  const setPendingImportPath = useAppStore((s) => s.setPendingImportPath);
  const loadChapter = useEditorStore((s) => s.loadChapter);
  const clearEditor = useEditorStore((s) => s.clear);

  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());
  const [drag, setDrag] = useState<AnyDrag>(null);
  /** 卷拖拽时的悬停位置（用于显示插入指示线） */
  const [dragOverVol, setDragOverVol] = useState<{ volumeId: number; pos: 'before' | 'after' } | null>(null);
  const [showImport, setShowImport] = useState(false);
  const [prompt, setPrompt] = useState<
    | { kind: 'newVolume' }
    | { kind: 'renameVolume'; volume: Volume }
    | { kind: 'newChapter'; volumeId: number }
    | { kind: 'renameChapter'; chapter: ChapterMeta }
    | null
  >(null);
  /** 回收站弹窗 */
  const [showTrash, setShowTrash] = useState(false);

  // 按卷分组
  const chaptersByVolume = useMemo(() => {
    const map = new Map<number, ChapterMeta[]>();
    for (const v of tree.volumes) map.set(v.id, []);
    for (const c of tree.chapters) map.get(c.volumeId)?.push(c);
    return map;
  }, [tree]);

  // Ctrl+N 全局快捷键：在当前章节所在卷（否则第一个卷）新建章节
  useEffect(() => {
    const handler = () => {
      const currentVolumeId = useEditorStore.getState().volumeId;
      const target =
        tree.volumes.find((v) => v.id === currentVolumeId) ?? tree.volumes[0];
      if (target) setPrompt({ kind: 'newChapter', volumeId: target.id });
    };
    window.addEventListener('nf:new-chapter', handler);
    return () => window.removeEventListener('nf:new-chapter', handler);
  }, [tree]);

  // 首页「导入小说」流程：项目打开后自动弹出智能导入（预选文件）
  useEffect(() => {
    if (pendingImportPath) setShowImport(true);
  }, [pendingImportPath]);

  const onChapterClick = async (id: number) => {
    if (id === selectedChapterId) return;
    const ok = await loadChapter(id);
    if (ok) selectChapter(id);
  };

  // ---------- 创建 / 重命名 / 删除 ----------

  const doCreateVolume = async (title: string) => {
    if (!title.trim()) return;
    try {
      await api.createVolume(title.trim());
      setPrompt(null);
      await refreshTree();
    } catch (e) {
      showToast(String(e), 'error');
    }
  };

  const doRenameVolume = async (volume: Volume, title: string) => {
    if (!title.trim()) return;
    try {
      await api.renameVolume(volume.id, title.trim());
      setPrompt(null);
      await refreshTree();
    } catch (e) {
      showToast(String(e), 'error');
    }
  };

  const doCreateChapter = async (volumeId: number, title: string) => {
    try {
      const detail = await api.createChapter(volumeId, title.trim() || undefined);
      setPrompt(null);
      await refreshTree();
      const ok = await loadChapter(detail.id);
      if (ok) selectChapter(detail.id);
    } catch (e) {
      showToast(String(e), 'error');
    }
  };

  const doRenameChapter = async (chapter: ChapterMeta, title: string) => {
    if (!title.trim()) return;
    try {
      await api.renameChapter(chapter.id, title.trim());
      setPrompt(null);
      await refreshTree();
      // 若正在编辑该章，同步编辑器标题
      const ed = useEditorStore.getState();
      if (ed.chapterId === chapter.id) ed.setTitle(title.trim());
    } catch (e) {
      showToast(String(e), 'error');
    }
  };

  const confirmDeleteVolume = async (volume: Volume) => {
    const ok = window.confirm(
      `确定删除卷「${volume.title}」吗？\n\n该卷下 ${volume.chapterCount} 个章节（含历史版本）将被一并删除，此操作不可撤销。`,
    );
    if (!ok) return;
    try {
      await api.deleteVolume(volume.id);
      // 若当前编辑章节位于被删卷中，清空编辑器
      const ed = useEditorStore.getState();
      const inDeleted = chaptersByVolume.get(volume.id)?.some((c) => c.id === ed.chapterId);
      if (inDeleted) {
        selectChapter(null);
        clearEditor();
      }
      await refreshTree();
    } catch (e) {
      showToast(String(e), 'error');
    }
  };

  const confirmDeleteChapter = async (chapter: ChapterMeta) => {
    const ok = window.confirm(`确定删除「${chapter.title}」吗？\n\n章节将进入回收站，保留 7 天，可随时恢复。`);
    if (!ok) return;
    try {
      await api.deleteChapter(chapter.id);
      const ed = useEditorStore.getState();
      if (ed.chapterId === chapter.id) {
        selectChapter(null);
        clearEditor();
      }
      await refreshTree();
    } catch (e) {
      showToast(String(e), 'error');
    }
  };

  // ---------- 移动 ----------

  const moveChapterWithin = async (
    chapterId: number,
    currentIndex: number,
    targetIndex: number,
    volumeId: number,
  ) => {
    if (targetIndex === currentIndex) return;
    try {
      await api.moveChapter(chapterId, volumeId, targetIndex);
      await refreshTree();
    } catch (e) {
      showToast(String(e), 'error');
    }
  };

  const dropOnVolume = async (volumeId: number) => {
    if (!drag || drag.type !== 'chapter') return;
    const list = chaptersByVolume.get(volumeId) ?? [];
    if (drag.fromVolumeId === volumeId) return; // 同卷且目标是卷尾 = 无操作（除非想移到末尾）
    try {
      await api.moveChapter(drag.chapterId, volumeId, list.length);
      await refreshTree();
    } catch (e) {
      showToast(String(e), 'error');
    } finally {
      setDrag(null);
    }
  };

  const dropOnChapter = async (target: ChapterMeta) => {
    if (!drag || drag.type !== 'chapter') return;
    if (drag.chapterId === target.id) return;
    const list = chaptersByVolume.get(target.volumeId) ?? [];
    let targetIndex = list.findIndex((c) => c.id === target.id);
    // 同卷向下拖动时，插入位需要补偿被移出的元素
    if (drag.fromVolumeId === target.volumeId) {
      const fromIndex = list.findIndex((c) => c.id === drag.chapterId);
      if (fromIndex !== -1 && fromIndex < targetIndex) targetIndex -= 1;
    }
    try {
      await api.moveChapter(drag.chapterId, target.volumeId, targetIndex);
      await refreshTree();
    } catch (e) {
      showToast(String(e), 'error');
    } finally {
      setDrag(null);
    }
  };

  // ---------- 右键菜单 ----------

  const volumeMenu = (e: React.MouseEvent, volume: Volume) => {
    e.preventDefault();
    e.stopPropagation();
    ContextMenu.open(e.clientX, e.clientY, [
      { label: '新建章节', onClick: () => setPrompt({ kind: 'newChapter', volumeId: volume.id }) },
      { separator: true, label: '' },
      { label: '重命名卷', onClick: () => setPrompt({ kind: 'renameVolume', volume }) },
      { label: '上移', onClick: () => moveVolume(volume, -1) },
      { label: '下移', onClick: () => moveVolume(volume, 1) },
      { label: '章节倒序', icon: <IconSortReverse />, onClick: () => void reverseVolume(volume) },
      { separator: true, label: '' },
      { label: '删除卷', danger: true, onClick: () => confirmDeleteVolume(volume) },
    ]);
  };

  const chapterMenu = (e: React.MouseEvent, chapter: ChapterMeta, list: ChapterMeta[]) => {
    e.preventDefault();
    e.stopPropagation();
    const idx = list.findIndex((c) => c.id === chapter.id);
    ContextMenu.open(e.clientX, e.clientY, [
      { label: '重命名章节', onClick: () => setPrompt({ kind: 'renameChapter', chapter }) },
      { label: '上移', disabled: idx <= 0, onClick: () => moveChapterWithin(chapter.id, idx, idx - 1, chapter.volumeId) },
      { label: '下移', disabled: idx >= list.length - 1, onClick: () => moveChapterWithin(chapter.id, idx, idx + 1, chapter.volumeId) },
      { separator: true, label: '' },
      { label: '删除章节', danger: true, onClick: () => confirmDeleteChapter(chapter) },
    ]);
  };

  const reverseVolume = async (volume: Volume) => {
    try {
      await api.reverseVolumeChapters(volume.id);
      await refreshTree();
      showToast('章节已倒序');
    } catch (e) {
      showToast(String(e), 'error');
    }
  };

  // 目录空白处右键：新建入口随处可用（行级菜单已 stopPropagation，不会叠加）
  const blankMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    const lastVolume = tree.volumes[tree.volumes.length - 1];
    ContextMenu.open(e.clientX, e.clientY, [
      { label: '新建卷', onClick: () => setPrompt({ kind: 'newVolume' }) },
      {
        label: '新建章节（追加到末卷）',
        disabled: !lastVolume,
        onClick: () => setPrompt({ kind: 'newChapter', volumeId: lastVolume.id }),
      },
      { separator: true, label: '' },
      { label: '导入小说…', onClick: () => setShowImport(true) },
    ]);
  };

  const moveVolume = async (volume: Volume, delta: number) => {
    const idx = tree.volumes.findIndex((v) => v.id === volume.id);
    const target = idx + delta;
    if (target < 0 || target >= tree.volumes.length) return;
    try {
      await api.moveVolume(volume.id, target);
      await refreshTree();
    } catch (e) {
      showToast(String(e), 'error');
    }
  };

  // 卷拖拽排序：拖到目标卷的上方或下方
  const dropVolumeReorder = async (targetVolumeId: number, pos: 'before' | 'after') => {
    if (!drag || drag.type !== 'volume') return;
    if (drag.volumeId === targetVolumeId) {
      setDrag(null);
      setDragOverVol(null);
      return;
    }
    const fromIdx = tree.volumes.findIndex((v) => v.id === drag.volumeId);
    let targetIdx = tree.volumes.findIndex((v) => v.id === targetVolumeId);
    if (fromIdx === -1 || targetIdx === -1) return;
    // 同方向拖动时补偿被移出元素的位移
    if (fromIdx < targetIdx && pos === 'before') targetIdx -= 1;
    if (fromIdx < targetIdx && pos === 'after') targetIdx -= 0; // after 不需要补偿
    if (pos === 'after') targetIdx += 1;
    targetIdx = Math.max(0, Math.min(targetIdx, tree.volumes.length));
    try {
      await api.moveVolume(drag.volumeId, targetIdx);
      await refreshTree();
    } catch (e) {
      showToast(String(e), 'error');
    } finally {
      setDrag(null);
      setDragOverVol(null);
    }
  };

  const toggleCollapse = (id: number) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // ---------- 渲染 ----------

  return (
    <aside
      className="sidebar"
      onDragEnd={() => {
        setDrag(null);
        setDragOverVol(null);
      }}
      onContextMenu={blankMenu}
    >
      <div className="sidebar-header">
        <span>目录</span>
        <div className="sidebar-actions">
          <button
            className="icon-btn"
            title="导入 TXT / DOCX / MD（智能拆章）"
            onClick={() => setShowImport(true)}
          >
            <IconImport />
          </button>
          <button
            className="icon-btn"
            title="新建"
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              const lastVolume = tree.volumes[tree.volumes.length - 1];
              ContextMenu.open(r.left, r.bottom + 4, [
                {
                  label: '新建章节',
                  disabled: !lastVolume,
                  onClick: () => setPrompt({ kind: 'newChapter', volumeId: lastVolume.id }),
                },
                { label: '新建分卷', onClick: () => setPrompt({ kind: 'newVolume' }) },
              ]);
            }}
          >
            <IconPlus />
          </button>
          <button
            className="icon-btn"
            title="更多操作"
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              ContextMenu.open(r.left - 100, r.bottom + 4, [
                { label: '回收站', icon: <IconTrash />, onClick: () => setShowTrash(true) },
              ]);
            }}
          >
            <IconMore />
          </button>
        </div>
      </div>

      <div className="sidebar-tree">
        {tree.volumes.map((volume) => {
          const chapters = chaptersByVolume.get(volume.id) ?? [];
          const isCollapsed = collapsed.has(volume.id);
          return (
            <div key={volume.id} className="volume-group">
              <div
                className={`volume-row${dragOverVol?.volumeId === volume.id ? ` drop-${dragOverVol.pos}` : ''}${drag?.type === 'volume' && drag.volumeId === volume.id ? ' dragging' : ''}`}
                draggable
                onClick={() => toggleCollapse(volume.id)}
                onContextMenu={(e) => volumeMenu(e, volume)}
                onDragStart={(e) => {
                  e.stopPropagation();
                  setDrag({ type: 'volume', volumeId: volume.id });
                  e.dataTransfer.effectAllowed = 'move';
                }}
                onDragOver={(e) => {
                  if (drag?.type === 'volume') {
                    e.preventDefault();
                    e.dataTransfer.dropEffect = 'move';
                    const rect = e.currentTarget.getBoundingClientRect();
                    const pos = e.clientY < rect.top + rect.height / 2 ? 'before' : 'after';
                    setDragOverVol({ volumeId: volume.id, pos });
                  } else if (drag) {
                    e.preventDefault();
                  }
                }}
                onDragLeave={() => {
                  if (dragOverVol?.volumeId === volume.id) setDragOverVol(null);
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  if (drag?.type === 'volume') {
                    void dropVolumeReorder(volume.id, dragOverVol?.pos ?? 'after');
                  } else {
                    dropOnVolume(volume.id);
                  }
                }}
              >
                <IconChevron open={!isCollapsed} />
                <span className="volume-title" title={volume.title}>
                  {volume.title}
                </span>
                <span className="volume-meta">
                  {volume.chapterCount > 0 && `${fmt(volume.wordCount)}字`}
                </span>
              </div>

              {!isCollapsed && (
                <ul className="chapter-list">
                  {chapters.length === 0 && <li className="chapter-empty">（空卷，右键新建章节）</li>}
                  {chapters.map((ch) => (
                    <li
                      key={ch.id}
                      className={`chapter-row${ch.id === selectedChapterId ? ' active' : ''}`}
                      draggable
                      onDragStart={() =>
                        setDrag({ type: 'chapter', chapterId: ch.id, fromVolumeId: ch.volumeId })
                      }
                      onDragOver={(e) => {
                        if (drag) e.preventDefault();
                      }}
                      onDrop={(e) => {
                        e.stopPropagation();
                        void dropOnChapter(ch);
                      }}
                      onClick={() => onChapterClick(ch.id)}
                      onContextMenu={(e) => chapterMenu(e, ch, chapters)}
                    >
                      <span className="chapter-status-dot" data-status={ch.status} />
                      <span className="chapter-title" title={ch.title}>
                        {ch.title}
                      </span>
                      <span className="chapter-words">{fmt(ch.wordCount)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          );
        })}
      </div>

      {prompt?.kind === 'newVolume' && (
        <PromptModal
          title="新建卷"
          placeholder="例如：第一卷 青云"
          onCancel={() => setPrompt(null)}
          onConfirm={doCreateVolume}
        />
      )}
      {prompt?.kind === 'renameVolume' && (
        <PromptModal
          title="重命名卷"
          initial={prompt.volume.title}
          onCancel={() => setPrompt(null)}
          onConfirm={(v) => doRenameVolume(prompt.volume, v)}
        />
      )}
      {prompt?.kind === 'newChapter' && (
        <PromptModal
          title="新建章节"
          placeholder="留空则自动编号（第N章）"
          onCancel={() => setPrompt(null)}
          onConfirm={(v) => doCreateChapter(prompt.volumeId, v)}
        />
      )}
      {prompt?.kind === 'renameChapter' && (
        <PromptModal
          title="重命名章节"
          initial={prompt.chapter.title}
          onCancel={() => setPrompt(null)}
          onConfirm={(v) => doRenameChapter(prompt.chapter, v)}
        />
      )}

      {showImport && (
        <ImportModal
          presetPath={pendingImportPath ?? undefined}
          onClose={() => {
            setShowImport(false);
            if (pendingImportPath) setPendingImportPath(null);
          }}
        />
      )}

      {showTrash && (
        <TrashModal onClose={() => setShowTrash(false)} onChanged={refreshTree} />
      )}
    </aside>
  );
}
