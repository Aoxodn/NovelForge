/** 顶部栏：返回首页 / 项目信息 / 视图切换 / 搜索 / 人物地点卡 / 码字统计 / 随机取名 / 导出 / 备份 / 主题切换 */
import { useAppStore } from '../store/appStore';
import { useCountUp } from '../hooks/useCountUp';
import { IconBack, IconChart, IconDice, IconExport, IconFocus, IconMap, IconOverview, IconSearch, IconSettings, IconShield, IconUsers } from './icons';
import { WindowControls } from './WindowControls';
import { fmt } from '../utils/text';
import type { Theme } from '../types/models';

const THEME_ORDER: Theme[] = ['dark', 'light', 'sepia'];
const THEME_LABEL: Record<Theme, string> = { dark: '深色', light: '浅色', sepia: '护眼' };

interface TopBarProps {
  /** 返回首页（由 ProjectView 处理：先播关书动画再真正关闭项目） */
  onBack: () => void;
  onOpenSettings: () => void;
  onOpenExport: () => void;
  onOpenSearch: () => void;
  onOpenBackup: () => void;
  onOpenCards: () => void;
  onOpenStats: () => void;
  onOpenNames: () => void;
}

export function TopBar({ onBack, onOpenSettings, onOpenExport, onOpenSearch, onOpenBackup, onOpenCards, onOpenStats, onOpenNames }: TopBarProps) {
  const tree = useAppStore((s) => s.tree)!;
  const theme = useAppStore((s) => s.theme);
  const setTheme = useAppStore((s) => s.setTheme);
  const focusMode = useAppStore((s) => s.focusMode);
  const toggleFocusMode = useAppStore((s) => s.toggleFocusMode);
  const viewMode = useAppStore((s) => s.viewMode);
  const setViewMode = useAppStore((s) => s.setViewMode);
  // 全书字数滚动（保存后微反馈）
  const totalWords = useCountUp(tree.stats.totalWordCount);

  const cycleTheme = () => {
    const idx = THEME_ORDER.indexOf(theme);
    setTheme(THEME_ORDER[(idx + 1) % THEME_ORDER.length]);
  };

  return (
    <header className="topbar" data-tauri-drag-region="deep">
      <div className="topbar-left">
        <button className="icon-btn" title="返回首页" onClick={onBack}>
          <IconBack />
        </button>
        <span className="topbar-brand">NovelForge</span>
      </div>

      <div className="topbar-center">
        <span className="topbar-title">《{tree.info.name}》</span>
        {tree.info.author && <span className="topbar-author">{tree.info.author}</span>}
        <span className="topbar-words">{fmt(totalWords)} 字</span>
      </div>

      <div className="topbar-right">
        <button
          className={`icon-btn${viewMode === 'map' ? ' active' : ''}`}
          title="故事地图（大纲画布）"
          onClick={() => setViewMode(viewMode === 'map' ? 'editor' : 'map')}
        >
          <IconMap />
        </button>
        <button
          className={`icon-btn${viewMode === 'overview' ? ' active' : ''}`}
          title="全书总览（剧情线 / 伏笔 / 结构）"
          onClick={() => setViewMode(viewMode === 'overview' ? 'editor' : 'overview')}
        >
          <IconOverview />
        </button>
        <span className="topbar-sep" />
        <button
          className={`icon-btn${focusMode ? ' active' : ''}`}
          title={focusMode ? '退出专注模式 (Ctrl+J)' : '专注模式 (Ctrl+J)'}
          onClick={toggleFocusMode}
        >
          <IconFocus />
        </button>
        <button className="icon-btn" title="全文搜索 (Ctrl+F)" onClick={onOpenSearch}>
          <IconSearch />
        </button>
        <button className="icon-btn" title="人物 / 地点卡" onClick={onOpenCards}>
          <IconUsers />
        </button>
        <button className="icon-btn" title="码字统计" onClick={onOpenStats}>
          <IconChart />
        </button>
        <button className="icon-btn" title="随机取名" onClick={onOpenNames}>
          <IconDice />
        </button>
        <button className="icon-btn" title="导出 (TXT / DOCX / MD)" onClick={onOpenExport}>
          <IconExport />
        </button>
        <button className="icon-btn" title="备份与恢复" onClick={onOpenBackup}>
          <IconShield />
        </button>
        <button className="btn btn-ghost" onClick={cycleTheme} title="切换主题">
          {THEME_LABEL[theme]}
        </button>
        <button className="icon-btn" title="显示设置（字体 / 字号 / 行距）" onClick={onOpenSettings}>
          <IconSettings />
        </button>
        <WindowControls />
      </div>
    </header>
  );
}
