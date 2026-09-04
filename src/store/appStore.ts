/**
 * 应用级状态：当前项目树、选中章节、主题、编辑器偏好、全局提示。
 * UI 组件只读状态并调用 action，不直接触碰 API 层。
 */
import { create } from 'zustand';
import * as api from '../api';
import type { ProjectTree, Theme } from '../types/models';

export interface EditorSettings {
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
}

/** 写手偏好：码字统计 / 稿费 / 提醒（纯前端持久化，与项目数据无关） */
export interface WriterSettings {
  /** 日更目标字数（0 = 不显示目标进度） */
  dailyGoal: number;
  /** 稿费单价（元 / 千字，0 = 不显示预估稿费） */
  feePerK: number;
  /** 摸鱼提醒：空闲超过 N 分钟提醒一次（0 = 关闭） */
  idleReminderMin: number;
}

interface AppStore {
  tree: ProjectTree | null;
  selectedChapterId: number | null;
  theme: Theme;
  editorSettings: EditorSettings;
  writerSettings: WriterSettings;
  /** 今日累计码字（打开项目时拉取，保存后由后端权威值刷新） */
  todayWords: number;
  toast: { text: string; kind: 'info' | 'error' } | null;
  /** 首页「导入小说」流程带入的待导入文件：进入项目后自动打开智能导入 */
  pendingImportPath: string | null;

  createProject: (opts: {
    name: string;
    author: string;
    description: string;
    parentDir: string;
  }) => Promise<boolean>;
  openProject: (path: string) => Promise<boolean>;
  closeProject: () => Promise<void>;
  refreshTree: () => Promise<void>;
  selectChapter: (id: number | null) => void;
  setPendingImportPath: (p: string | null) => void;
  setTheme: (t: Theme) => void;
  updateEditorSettings: (patch: Partial<EditorSettings>) => void;
  updateWriterSettings: (patch: Partial<WriterSettings>) => void;
  setTodayWords: (n: number) => void;
  showToast: (text: string, kind?: 'info' | 'error') => void;
  clearToast: () => void;
}

const THEME_KEY = 'nf-theme';
const EDITOR_KEY = 'nf-editor-settings';
const WRITER_KEY = 'nf-writer-settings';

function loadTheme(): Theme {
  const v = localStorage.getItem(THEME_KEY);
  return v === 'light' || v === 'dark' || v === 'sepia' ? v : 'dark';
}

function loadEditorSettings(): EditorSettings {
  const fallback: EditorSettings = {
    fontFamily: "'Microsoft YaHei', 'PingFang SC', sans-serif",
    fontSize: 17,
    lineHeight: 1.9,
  };
  try {
    const raw = localStorage.getItem(EDITOR_KEY);
    if (raw) return { ...fallback, ...JSON.parse(raw) };
  } catch {
    /* 忽略损坏的本地配置 */
  }
  return fallback;
}

function loadWriterSettings(): WriterSettings {
  const fallback: WriterSettings = { dailyGoal: 0, feePerK: 0, idleReminderMin: 0 };
  try {
    const raw = localStorage.getItem(WRITER_KEY);
    if (raw) return { ...fallback, ...JSON.parse(raw) };
  } catch {
    /* 忽略损坏的本地配置 */
  }
  return fallback;
}

function persistEditorSettings(s: EditorSettings) {
  localStorage.setItem(EDITOR_KEY, JSON.stringify(s));
}

export const useAppStore = create<AppStore>((set, get) => ({
  tree: null,
  selectedChapterId: null,
  theme: loadTheme(),
  editorSettings: loadEditorSettings(),
  writerSettings: loadWriterSettings(),
  todayWords: 0,
  toast: null,
  pendingImportPath: null,

  createProject: async (opts) => {
    try {
      const tree = await api.createProject(opts);
      set({ tree, selectedChapterId: null });
      return true;
    } catch (e) {
      get().showToast(String(e), 'error');
      return false;
    }
  },

  openProject: async (path) => {
    try {
      const tree = await api.openProject(path);
      set({ tree, selectedChapterId: null });
      // 今日码字：打开项目时拉取一次，之后由保存回包刷新
      void api
        .getWritingStats()
        .then((s) => set({ todayWords: s.todayWords }))
        .catch(() => undefined);
      return true;
    } catch (e) {
      get().showToast(String(e), 'error');
      return false;
    }
  },

  closeProject: async () => {
    await api.closeProject();
    set({ tree: null, selectedChapterId: null, todayWords: 0 });
  },

  refreshTree: async () => {
    // 静默刷新：失败不打断写作（保持旧树）；项目已关闭时直接跳过，
    // 避免在途保存回调与关闭项目的竞态导致崩溃
    const current = get().tree;
    if (!current) return;
    try {
      const tree = await api.openProject(current.projectPath);
      set({ tree });
    } catch {
      /* 项目文件被外部移动等异常场景，忽略 */
    }
  },

  selectChapter: (id) => set({ selectedChapterId: id }),

  setPendingImportPath: (p) => set({ pendingImportPath: p }),

  setTheme: (t) => {
    localStorage.setItem(THEME_KEY, t);
    set({ theme: t });
  },

  updateEditorSettings: (patch) => {
    const next = { ...get().editorSettings, ...patch };
    persistEditorSettings(next);
    set({ editorSettings: next });
  },

  updateWriterSettings: (patch) => {
    const next = { ...get().writerSettings, ...patch };
    localStorage.setItem(WRITER_KEY, JSON.stringify(next));
    set({ writerSettings: next });
  },

  setTodayWords: (n) => set({ todayWords: n }),

  showToast: (text, kind = 'info') => {
    set({ toast: { text, kind } });
    // 3 秒后自动清除（记录定时器避免叠加提示错乱）
    const current = get().toast;
    if (current) {
      setTimeout(() => {
        if (get().toast?.text === current.text) set({ toast: null });
      }, 3000);
    }
  },

  clearToast: () => set({ toast: null }),
}));
