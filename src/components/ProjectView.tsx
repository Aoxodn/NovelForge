/**
 * 项目视图：三栏桌面布局（文档第十一节）
 *   顶栏 / 目录树 | 编辑器 | 信息面板 / 状态栏
 * 并挂载全局快捷键（Ctrl+N / Ctrl+F）、窗口关闭前自动保存冲刷、
 * 30 分钟周期自动备份（文档第六十五节）。
 */
import { useEffect, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { useEditorStore } from '../store/editorStore';
import { useAppStore } from '../store/appStore';
import * as api from '../api';
import { ChapterTree } from './ChapterTree';
import { ChapterEditor } from './ChapterEditor';
import { InfoPanel } from './InfoPanel';
import { StatusBar } from './StatusBar';
import { TopBar } from './TopBar';
import { SettingsPanel } from './SettingsPanel';
import { ExportModal } from './ExportModal';
import { SearchPanel } from './SearchPanel';
import { BackupModal } from './BackupModal';
import { CardsModal } from './CardsModal';
import { StatsModal } from './StatsModal';
import { NameGeneratorModal } from './NameGeneratorModal';
import { StoryMap } from './StoryMap';
import { OverviewView } from './OverviewView';
import { CharacterCardView } from './CharacterCardView';

/** 自动备份周期（文档：每 30 分钟） */
const AUTO_BACKUP_INTERVAL_MS = 30 * 60 * 1000;

export function ProjectView() {
  const [showSettings, setShowSettings] = useState(false);
  const [showExport, setShowExport] = useState(false);
  const [showSearch, setShowSearch] = useState(false);
  const [showBackup, setShowBackup] = useState(false);
  const [showCards, setShowCards] = useState(false);
  const [showStats, setShowStats] = useState(false);
  const [showNames, setShowNames] = useState(false);
  /** true = 正在播放「合上书本」退场动画 */
  const [closing, setClosing] = useState(false);
  const projectPath = useAppStore((s) => s.tree?.projectPath ?? null);
  const closeProject = useAppStore((s) => s.closeProject);
  const focusMode = useAppStore((s) => s.focusMode);
  const viewMode = useAppStore((s) => s.viewMode);

  /** 返回：在故事地图 / 总览等视图时先回写作界面（避免误退项目），
   *  已在写作界面才走「关书动画 → 退出项目」流程 */
  const handleBack = () => {
    if (closing) return;
    if (useAppStore.getState().viewMode !== 'editor') {
      useAppStore.getState().setViewMode('editor');
      return;
    }
    setClosing(true);
    setTimeout(async () => {
      // 返回前确保未保存内容落库
      const ed = useEditorStore.getState();
      if (ed.chapterId !== null && ed.dirty) await ed.save(false);
      ed.clear();
      await closeProject();
    }, 320);
  };

  // 打开项目后重建人物/地点出场统计（V3 迁移后 mentions 为空；
  // 后台线程精确匹配，完成后广播事件刷新信息面板与卡片）
  useEffect(() => {
    if (!projectPath) return;
    let cancelled = false;
    void api
      .rebuildMentions()
      .then(() => {
        if (!cancelled) window.dispatchEvent(new Event('nf:cards-updated'));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [projectPath]);

  // 卡片弹窗内跳转「随机取名」
  useEffect(() => {
    const h = () => setShowNames(true);
    window.addEventListener('nf:open-name-generator', h);
    return () => window.removeEventListener('nf:open-name-generator', h);
  }, []);

  // 全局快捷键：Ctrl+N 新建章节；Ctrl+F 全文搜索；Ctrl+J / F11 专注模式；Esc 退出专注
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === 'n') {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent('nf:new-chapter'));
      } else if (e.ctrlKey && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        setShowSearch(true);
      } else if ((e.ctrlKey && e.key.toLowerCase() === 'j') || e.key === 'F11') {
        e.preventDefault();
        useAppStore.getState().toggleFocusMode();
      } else if (e.key === 'Escape') {
        // Esc 逐层退出：专注模式 → 故事地图 / 总览视图 →（编辑界面内不拦截）
        const s = useAppStore.getState();
        if (s.focusMode) s.toggleFocusMode();
        else if (s.viewMode !== 'editor') s.setViewMode('editor');
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  // 窗口关闭前冲刷未保存内容（防崩溃丢字）；保存失败也放行关闭，
  // 内容已在 500ms 防抖周期内尽量落库
  useEffect(() => {
    // 非 Tauri 环境（浏览器预览）无窗口 API，跳过
    let win: ReturnType<typeof getCurrentWindow>;
    try {
      win = getCurrentWindow();
    } catch {
      return;
    }
    const promise = win.onCloseRequested(async (event) => {
      const ed = useEditorStore.getState();
      if (ed.chapterId !== null && ed.dirty) {
        event.preventDefault();
        try {
          await ed.save(false);
        } finally {
          await win.destroy();
        }
      }
    });
    return () => {
      void promise.then((unlisten) => unlisten());
    };
  }, []);

  // 周期自动备份：静默执行，失败不打断写作（下次周期重试）
  useEffect(() => {
    const timer = setInterval(() => {
      void api.backupProject(true).catch(() => undefined);
    }, AUTO_BACKUP_INTERVAL_MS);
    return () => clearInterval(timer);
  }, []);

  return (
    <div className={`project-view${closing ? ' closing' : ''}`}>
      <TopBar
        onBack={handleBack}
        onOpenSettings={() => setShowSettings(true)}
        onOpenExport={() => setShowExport(true)}
        onOpenSearch={() => setShowSearch(true)}
        onOpenBackup={() => setShowBackup(true)}
        onOpenCards={() => setShowCards(true)}
        onOpenStats={() => setShowStats(true)}
        onOpenNames={() => setShowNames(true)}
      />
      {/* 专注模式仅用 CSS 隐藏两栏：组件保持挂载，卷展开状态不丢、数据不重拉 */}
      <div
        className={`main-columns${focusMode ? ' focus' : ''}${viewMode !== 'editor' ? ' view-switched' : ''}`}
      >
        <ChapterTree />
        <ChapterEditor />
        <InfoPanel />
        {showSettings && viewMode === 'editor' && (
          <SettingsPanel onClose={() => setShowSettings(false)} />
        )}
      </div>
      {/* 故事地图 / 全书总览：与三栏并列的独立视图（同源 story graph） */}
      {viewMode === 'map' && (
        <div className="story-view">
          <StoryMap />
        </div>
      )}
      {viewMode === 'overview' && (
        <div className="story-view">
          <OverviewView />
        </div>
      )}
      {viewMode === 'characters' && (
        <div className="story-view">
          <CharacterCardView />
        </div>
      )}
      <StatusBar />
      {showExport && <ExportModal onClose={() => setShowExport(false)} />}
      {showBackup && <BackupModal onClose={() => setShowBackup(false)} />}
      {showSearch && <SearchPanel onClose={() => setShowSearch(false)} />}
      {showCards && <CardsModal onClose={() => setShowCards(false)} />}
      {showStats && <StatsModal onClose={() => setShowStats(false)} />}
      {showNames && <NameGeneratorModal onClose={() => setShowNames(false)} />}
    </div>
  );
}
