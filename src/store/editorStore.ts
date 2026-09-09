/**
 * 编辑器状态：当前编辑的章节、内容、脏标记与保存状态。
 *
 * 自动保存数据流（文档第十五节）：
 *   用户输入 → editorStore.setContent（dirty=true）
 *   → useAutoSave 500ms 防抖 → editorStore.save(false) → Rust 事务写入
 *   → 每 5 分钟快照 save(true) 写入 chapter_versions
 *
 * 保存可靠性（审查 P0）：
 *   - save() 失败必须 reject，调用方据此中止切章/退出，杜绝静默丢字
 *   - 串行保存队列：保存期间若有新输入，置 savePending，当前请求完成后
 *     立即用最新快照再保存一次，保证最后几次输入不会留在内存
 */
import { create } from 'zustand';
import * as api from '../api';
import { useAppStore } from './appStore';

export type SaveOutcome = 'saved' | 'noop' | 'queued';

interface EditorStore {
  chapterId: number | null;
  volumeId: number | null;
  title: string;
  content: string;
  status: number;
  /** 有未保存的修改 */
  dirty: boolean;
  saving: boolean;
  /** 保存进行中又产生了新修改，当前请求结束后需再存一轮 */
  savePending: boolean;
  lastSavedAt: string | null;
  saveError: string | null;
  /** 前端实时统计（Rust 返回后校准） */
  wordCount: number;
  charCount: number;
  /** 上次快照时间戳（ms），用于 5 分钟周期快照 */
  lastSnapshotAt: number;

  loadChapter: (id: number, skipPreSave?: boolean) => Promise<boolean>;
  clear: () => void;
  setTitle: (t: string) => void;
  setContent: (c: string) => void;
  setStatus: (s: number) => Promise<void>;
  /** 保存；成功返回 saved/noop/queued，失败 reject */
  save: (snapshot: boolean) => Promise<SaveOutcome>;
}

/** 串行保存循环的安全阀：极端连续输入下最多连续追存的轮数 */
const MAX_SAVE_LOOPS = 20;

export const useEditorStore = create<EditorStore>((set, get) => ({
  chapterId: null,
  volumeId: null,
  title: '',
  content: '',
  status: 0,
  dirty: false,
  saving: false,
  savePending: false,
  lastSavedAt: null,
  saveError: null,
  wordCount: 0,
  charCount: 0,
  lastSnapshotAt: 0,

  loadChapter: async (id, skipPreSave = false) => {
    // 切换章节前先冲刷未保存内容；保存失败必须中止加载，防止丢字。
    // skipPreSave 用于「恢复历史版本」等需要丢弃内存内容、强制以库为准的场景。
    const s = get();
    if (!skipPreSave && s.chapterId !== null && s.dirty) {
      try {
        await get().save(false);
      } catch (e) {
        useAppStore.getState().showToast(`保存失败，已阻止切换章节：${String(e)}`, 'error');
        return false;
      }
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
        savePending: false,
        saveError: null,
        wordCount: detail.wordCount,
        charCount: detail.charCount,
        lastSavedAt: detail.updatedAt,
        lastSnapshotAt: Date.now(),
      });
      return true;
    } catch (e) {
      useAppStore.getState().showToast(String(e), 'error');
      return false;
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
      savePending: false,
      lastSavedAt: null,
      saveError: null,
      wordCount: 0,
      charCount: 0,
    }),

  setTitle: (t) => {
    if (t === get().title) return;
    // 保存进行中的修改标记为待追存
    if (get().saving) set({ title: t, dirty: true, savePending: true });
    else set({ title: t, dirty: true });
  },

  setContent: (c) => {
    if (c === get().content) return;
    if (get().saving) set({ content: c, dirty: true, savePending: true });
    else set({ content: c, dirty: true });
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
    const start = get();
    if (start.chapterId === null) return 'noop';
    // 已有保存在途：登记待追存后返回，由在途循环负责再存，避免并发写
    if (start.saving) {
      set({ savePending: true });
      return 'queued';
    }
    if (!snapshot && !start.dirty) return 'noop';

    let wantSnapshot = snapshot;
    // 串行保存循环：每轮保存发起时的快照；若期间又有新输入则再存一轮
    for (let loop = 0; loop < MAX_SAVE_LOOPS; loop++) {
      const cur = get();
      if (cur.chapterId === null) return 'noop';
      // 捕获本轮要保存的内容
      const chapterId = cur.chapterId;
      const title = cur.title;
      const content = cur.content;
      set({ saving: true, saveError: null, savePending: false });
      let res;
      try {
        res = await api.saveChapter(chapterId, title, content, wantSnapshot);
      } catch (e) {
        // 失败必须抛出，保留 dirty 让调用方/重试机制处理
        set({ saving: false, saveError: String(e), dirty: true });
        throw e;
      }
      const after = get();
      const unchanged = after.title === title && after.content === content;
      set({
        saving: false,
        lastSavedAt: res.savedAt,
        wordCount: res.wordCount,
        charCount: res.charCount,
        ...(unchanged ? { dirty: false } : {}),
        ...(res.snapshotCreated || wantSnapshot ? { lastSnapshotAt: Date.now() } : {}),
      });
      // 今日码字由后端权威值校准
      useAppStore.getState().setTodayWords(res.todayWords);
      void useAppStore.getState().refreshTree();
      // 保存期间又有新输入 → 用最新内容再存一轮（普通保存，不重复建快照）
      const latest = get();
      if (latest.savePending && latest.dirty) {
        wantSnapshot = false;
        continue;
      }
      return 'saved';
    }
    // 达到安全阀仍未追平：保持 dirty，交由下次防抖保存兜底
    set({ saving: false });
    return 'saved';
  },
}));
