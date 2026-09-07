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
import { OutlineModal } from './OutlineModal';
import {
  IconChevron,
  IconFormat,
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
  const [drag, setDrag] = useState<DragState | null>(null);
  const [showImport, setShowImport] = useState(false);
  const [prompt, setPrompt] = useState<
    | { kind: 'newVolume' }
    | { kind: 'renameVolume'; volume: Volume }
    | { kind: 'newChapter'; volumeId: number }
    | { kind: 'renameChapter'; chapter: ChapterMeta }
    | null
  >(null);
  /** 正在编辑卷大纲的卷（弹窗） */
  const [outlineVolume, setOutlineVolume] = useState<Volume | null>(null);
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

  const onChapterClick = (id: number) => {
    if (id === selectedChapterId) return;
    selectChapter(id);
    void loadChapter(id);
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
      selectChapter(detail.id);
      await loadChapter(detail.id);
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
    if (!drag) return;
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
    if (!drag) return;
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
      { label: '卷大纲…', onClick: () => setOutlineVolume(volume) },
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

  /** 全书排版：规范化所有章节文本，原文自动存版本快照 */
  const formatAll = async () => {
    const ok = window.confirm(
      '全书排版将规范所有章节文本：\n\n· 去除段首 / 行尾空白（含全角缩进）\n· 删除空行\n\n每章修改前自动保存版本快照，可在版本历史恢复。继续？',
    );
    if (!ok) return;
    try {
      const n = await api.formatAllChapters();
      await refreshTree();
      const ed = useEditorStore.getState();
      if (ed.chapterId !== null) {
        if (ed.dirty) await ed.save(false);
        await ed.loadChapter(ed.chapterId);
      }
      showToast(n > 0 ? `已排版 ${n} 章（原文本已存快照）` : '所有章节都已符合规范');
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
      onDragEnd={() => setDrag(null)}
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
                { label: '全书排版', icon: <IconFormat />, onClick: () => void formatAll() },
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
                className="volume-row"
                onClick={() => toggleCollapse(volume.id)}
                onContextMenu={(e) => volumeMenu(e, volume)}
                onDragOver={(e) => {
                  if (drag) e.preventDefault();
                }}
                onDrop={() => dropOnVolume(volume.id)}
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
                      {ch.nodeType !== 0 ? (
                        <span
                          className="chapter-node-mark"
                          title={`${['', '事件', '转折', '支线', '结局'][ch.nodeType]}规划节点（空章节，不参与导出）`}
                        >
                          ◇
                        </span>
                      ) : (
                        <span className="chapter-status-dot" data-status={ch.status} />
                      )}
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

      {outlineVolume && (
        <OutlineModal
          title={`卷大纲 · ${outlineVolume.title}`}
          hint="本卷主线 / 目标 / 剧情走向"
          initial={outlineVolume.summary}
          onClose={() => setOutlineVolume(null)}
          onSave={async (text) => {
            try {
              await api.setVolumeSummary(outlineVolume.id, text);
              await refreshTree();
              showToast('卷大纲已保存');
            } catch (e) {
              showToast(String(e), 'error');
            }
          }}
        />
      )}
    </aside>
  );
}
