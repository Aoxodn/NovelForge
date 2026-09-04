/**
 * 编辑器状态：当前编辑的章节、内容、脏标记与保存状态。
 *
 * 自动保存数据流（文档第十五节）：
 *   用户输入 → editorStore.setContent（dirty=true）
 *   → useAutoSave 500ms 防抖 → editorStore.save(false) → Rust 事务写入
 *   → 每 5 分钟快照 save(true) 写入 chapter_versions
 */
import { create } from 'zustand';
import * as api from '../api';
import { useAppStore } from './appStore';

interface EditorStore {
  chapterId: number | null;
  volumeId: number | null;
  title: string;
  content: string;
  status: number;
  /** 有未保存的修改 */
  dirty: boolean;
  saving: boolean;
  lastSavedAt: string | null;
  saveError: string | null;
  /** 前端实时统计（Rust 返回后校准） */
  wordCount: number;
  charCount: number;
  /** 上次快照时间戳（ms），用于 5 分钟周期快照 */
  lastSnapshotAt: number;

  loadChapter: (id: number) => Promise<void>;
  clear: () => void;
  setTitle: (t: string) => void;
  setContent: (c: string) => void;
  setStatus: (s: number) => Promise<void>;
  save: (snapshot: boolean) => Promise<void>;
}

export const useEditorStore = create<EditorStore>((set, get) => ({
  chapterId: null,
  volumeId: null,
  title: '',
  content: '',
  status: 0,
  dirty: false,
  saving: false,
  lastSavedAt: null,
  saveError: null,
  wordCount: 0,
  charCount: 0,
  lastSnapshotAt: 0,

  loadChapter: async (id) => {
    // 切换章节前先冲刷未保存内容，防止丢字
    const s = get();
    if (s.chapterId !== null && s.dirty) {
      await get().save(false);
    }
    try {
      const detail = await api.getChapter(id);
      set({
        chapterId: detail.id,
        volumeId: detail.volumeId,
        title: detail.title,
        content: detail.content,
        status: detail.status,
        dirty: false,
        saving: false,
        saveError: null,
        wordCount: detail.wordCount,
        charCount: detail.charCount,
        lastSavedAt: detail.updatedAt,
        lastSnapshotAt: Date.now(),
      });
    } catch (e) {
      useAppStore.getState().showToast(String(e), 'error');
    }
  },

  clear: () =>
    set({
      chapterId: null,
      volumeId: null,
      title: '',
      content: '',
      status: 0,
      dirty: false,
      saving: false,
      lastSavedAt: null,
      saveError: null,
      wordCount: 0,
      charCount: 0,
    }),

  setTitle: (t) => {
    if (t === get().title) return;
    set({ title: t, dirty: true });
  },

  setContent: (c) => {
    if (c === get().content) return;
    set({ content: c, dirty: true });
  },

  setStatus: async (s) => {
    const id = get().chapterId;
    if (id === null) return;
    try {
      await api.setChapterStatus(id, s);
      set({ status: s });
      useAppStore.getState().refreshTree();
    } catch (e) {
      useAppStore.getState().showToast(String(e), 'error');
    }
  },

  save: async (snapshot) => {
    const s = get();
    if (s.chapterId === null || s.saving) return;
    if (!snapshot && !s.dirty) return;

    // 保存发起时捕获内容快照，避免保存期间的新输入被误标为已保存
    const { chapterId, title, content } = s;
    set({ saving: true, saveError: null });
    try {
      const res = await api.saveChapter(chapterId, title, content, snapshot);
      const cur = get();
      const unchanged = cur.title === title && cur.content === content;
      set({
        saving: false,
        lastSavedAt: res.savedAt,
        wordCount: res.wordCount,
        charCount: res.charCount,
        ...(unchanged ? { dirty: false } : {}),
        ...(res.snapshotCreated || snapshot ? { lastSnapshotAt: Date.now() } : {}),
      });
      // 侧栏字数/统计更新（refreshTree 内部为静默刷新）
      // 今日码字由后端权威值校准（状态栏「今日 +N」）
      useAppStore.getState().setTodayWords(res.todayWords);
      useAppStore.getState().refreshTree();
    } catch (e) {
      set({ saving: false, saveError: String(e) });
    }
  },
}));
