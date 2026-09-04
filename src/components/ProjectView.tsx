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
import { SettingsModal } from './SettingsModal';
import { ExportModal } from './ExportModal';
import { SearchPanel } from './SearchPanel';
import { BackupModal } from './BackupModal';
import { CardsModal } from './CardsModal';
import { StatsModal } from './StatsModal';
import { NameGeneratorModal } from './NameGeneratorModal';

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
  const projectPath = useAppStore((s) => s.tree?.projectPath ?? null);

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

  // 全局快捷键：Ctrl+N 新建章节；Ctrl+F 全文搜索
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === 'n') {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent('nf:new-chapter'));
      } else if (e.ctrlKey && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        setShowSearch(true);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  // 窗口关闭前冲刷未保存内容（防崩溃丢字）；保存失败也放行关闭，
  // 内容已在 500ms 防抖周期内尽量落库
  useEffect(() => {
    const win = getCurrentWindow();
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
    <div className="project-view">
      <TopBar
        onOpenSettings={() => setShowSettings(true)}
        onOpenExport={() => setShowExport(true)}
        onOpenSearch={() => setShowSearch(true)}
        onOpenBackup={() => setShowBackup(true)}
        onOpenCards={() => setShowCards(true)}
        onOpenStats={() => setShowStats(true)}
        onOpenNames={() => setShowNames(true)}
      />
      <div className="main-columns">
        <ChapterTree />
        <ChapterEditor />
        <InfoPanel />
      </div>
      <StatusBar />
      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}
      {showExport && <ExportModal onClose={() => setShowExport(false)} />}
      {showBackup && <BackupModal onClose={() => setShowBackup(false)} />}
      {showSearch && <SearchPanel onClose={() => setShowSearch(false)} />}
      {showCards && <CardsModal onClose={() => setShowCards(false)} />}
      {showStats && <StatsModal onClose={() => setShowStats(false)} />}
      {showNames && <NameGeneratorModal onClose={() => setShowNames(false)} />}
    </div>
  );
}
