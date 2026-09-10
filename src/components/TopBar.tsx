/** Project toolbar: identity / primary views / focused actions / overflow tools. */
import { useEffect, useId, useRef, useState } from "react";
import { useAppStore } from "../store/appStore";
import { useCountUp } from "../hooks/useCountUp";
import {
  IconBack,
  IconChart,
  IconDice,
  IconExport,
  IconFocus,
  IconMap,
  IconMore,
  IconOverview,
  IconSearch,
  IconSettings,
  IconShield,
  IconUsers,
} from "./icons";
import { WindowControls } from "./WindowControls";
import { fmt } from "../utils/text";
import * as api from "../api";
import type { Theme } from "../types/models";
import "../styles/roadmap.css";

const THEME_ORDER: Theme[] = ["dark", "light", "sepia"];
const THEME_LABEL: Record<Theme, string> = {
  dark: "深色",
  light: "浅色",
  sepia: "护眼",
};

interface TopBarProps {
  onBack: () => void;
  onOpenSettings: () => void;
  onOpenExport: () => void;
  onOpenSearch: () => void;
  onOpenBackup: () => void;
  onOpenCards: () => void;
  onOpenStats: () => void;
  onOpenNames: () => void;
}

export function TopBar({
  onBack,
  onOpenSettings,
  onOpenExport,
  onOpenSearch,
  onOpenBackup,
  onOpenCards,
  onOpenStats,
  onOpenNames,
}: TopBarProps) {
  const tree = useAppStore((s) => s.tree)!;
  const theme = useAppStore((s) => s.theme);
  const setTheme = useAppStore((s) => s.setTheme);
  const focusMode = useAppStore((s) => s.focusMode);
  const toggleFocusMode = useAppStore((s) => s.toggleFocusMode);
  const viewMode = useAppStore((s) => s.viewMode);
  const setViewMode = useAppStore((s) => s.setViewMode);
  const setToolModal = useAppStore((s) => s.setToolModal);
  const refreshTree = useAppStore((s) => s.refreshTree);
  const showToast = useAppStore((s) => s.showToast);
  const selectedChapterId = useAppStore((s) => s.selectedChapterId);
  const activeArcId = useAppStore((s) => s.activeArcId);
  const setActiveArcId = useAppStore((s) => s.setActiveArcId);
  const splitMode = useAppStore((s) => s.splitMode);
  const toggleSplitMode = useAppStore((s) => s.toggleSplitMode);
  const totalWords = useCountUp(tree.stats.totalWordCount);
  const [arcs, setArcs] = useState<{ id: number; title: string }[]>([]);

  useEffect(() => {
    void api
      .listStoryArcs()
      .then((list) =>
        setArcs(list.map((a) => ({ id: a.id, title: a.title }))),
      )
      .catch(() => setArcs([]));
  }, [tree.projectPath]);
  const [moreOpen, setMoreOpen] = useState(false);
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const [savingName, setSavingName] = useState(false);
  const moreRef = useRef<HTMLDivElement>(null);
  const moreButtonRef = useRef<HTMLButtonElement>(null);
  const didOpenMore = useRef(false);
  const restoreMoreFocus = useRef(true);
  const popoverId = `toolbar-popover-${useId().replace(/:/g, "")}`;

  useEffect(() => {
    if (moreOpen) {
      didOpenMore.current = true;
      const first = moreRef.current?.querySelector<HTMLButtonElement>(
        "button:not(:disabled)",
      );
      first?.focus();
      return;
    }
    if (didOpenMore.current && restoreMoreFocus.current) {
      moreButtonRef.current?.focus();
    }
    restoreMoreFocus.current = true;
  }, [moreOpen]);

  useEffect(() => {
    if (!moreOpen) return;
    const close = (event: MouseEvent) => {
      if (!moreRef.current?.contains(event.target as Node)) {
        restoreMoreFocus.current = true;
        setMoreOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        restoreMoreFocus.current = true;
        setMoreOpen(false);
      }
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [moreOpen]);

  const cycleTheme = () => {
    const idx = THEME_ORDER.indexOf(theme);
    setTheme(THEME_ORDER[(idx + 1) % THEME_ORDER.length]);
  };

  const startEditName = () => {
    setNameDraft(tree.info.name);
    setEditingName(true);
  };
  const commitName = async () => {
    const trimmed = nameDraft.trim();
    if (!trimmed || trimmed === tree.info.name) {
      setEditingName(false);
      return;
    }
    setSavingName(true);
    try {
      await api.updateProjectInfo({ name: trimmed });
      await refreshTree();
      showToast(`书名已改为「${trimmed}」`);
      setEditingName(false);
    } catch (e) {
      showToast(String(e), "error");
    } finally {
      setSavingName(false);
    }
  };
  const run = (action: () => void) => {
    // Menu actions may open a modal; its own focus initializer will take over
    // after this deferred restoration when a dialog is mounted.
    restoreMoreFocus.current = false;
    setMoreOpen(false);
    action();
    requestAnimationFrame(() => {
      if (!document.querySelector('[role="dialog"][aria-modal="true"]')) {
        moreButtonRef.current?.focus();
      }
    });
  };

  const views = [
    { mode: "editor" as const, label: "写作", icon: null },
    { mode: "map" as const, label: "图谱", icon: <IconMap size={14} /> },
    {
      mode: "overview" as const,
      label: "总览",
      icon: <IconOverview size={14} />,
    },
    {
      mode: "characters" as const,
      label: "角色",
      icon: <IconUsers size={14} />,
    },
    { mode: "timeline" as const, label: "时间轴", icon: null },
    { mode: "board" as const, label: "看板", icon: null },
    { mode: "foreshadow" as const, label: "伏笔", icon: null },
    { mode: "lore" as const, label: "设定", icon: null },
    { mode: "pov" as const, label: "POV", icon: null },
  ];

  return (
    <header className="topbar" data-tauri-drag-region="deep">
      <div className="topbar-left">
        <button
          className="icon-btn workspace-back"
          data-tip={viewMode !== "editor" ? "返回写作" : "返回首页"}
          aria-label={viewMode !== "editor" ? "返回写作" : "返回首页"}
          onClick={onBack}
        >
          <IconBack />
        </button>
        <span className="workspace-mark" aria-hidden="true">
          文
        </span>
        <div className="project-identity" data-tauri-drag-region="deep">
          {editingName ? (
            <input
              className="topbar-title-input"
              value={nameDraft}
              autoFocus
              disabled={savingName}
              onChange={(e) => setNameDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void commitName();
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  setEditingName(false);
                }
              }}
              onBlur={() => void commitName()}
              onMouseDown={(e) => e.stopPropagation()}
            />
          ) : (
            <button
              className="topbar-title-btn"
              onClick={startEditName}
              title="点击修改书名"
            >
              {tree.info.name}
            </button>
          )}
          <span className="project-meta">
            {fmt(totalWords)} 字
            {tree.info.author ? ` · ${tree.info.author}` : ""}
          </span>
        </div>
      </div>

      <nav className="view-switcher" aria-label="项目视图">
        {views.map((view) => (
          <button
            key={view.mode}
            className={viewMode === view.mode ? "active" : ""}
            aria-current={viewMode === view.mode ? "page" : undefined}
            onClick={() => setViewMode(view.mode)}
          >
            {view.icon}
            <span>{view.label}</span>
          </button>
        ))}
      </nav>

      <div className="topbar-center-tools">
        {arcs.length > 0 ? (
          <select
            className="arc-filter"
            value={activeArcId}
            onChange={(e) => setActiveArcId(Number(e.target.value))}
            title="全局剧情线过滤"
            aria-label="全局剧情线过滤"
          >
            <option value={0}>全部剧情线</option>
            {arcs.map((a) => (
              <option key={a.id} value={a.id}>
                {a.title}
              </option>
            ))}
          </select>
        ) : null}
        <button
          className={`icon-btn${splitMode ? " active" : ""}`}
          data-tip={splitMode ? "关闭分屏 (Ctrl+\\)" : "大纲分屏 (Ctrl+\\)"}
          aria-label="大纲分屏"
          onClick={toggleSplitMode}
        >
          <span aria-hidden="true">◫</span>
        </button>
      </div>

      <div className="topbar-right">
        <button
          className="icon-btn"
          data-tip="全文搜索 (Ctrl+F)"
          aria-label="全文搜索"
          onClick={onOpenSearch}
        >
          <IconSearch />
        </button>
        <button
          className={`icon-btn${focusMode ? " active" : ""}`}
          data-tip={focusMode ? "退出专注模式 (Ctrl+J)" : "专注模式 (Ctrl+J)"}
          aria-label={focusMode ? "退出专注模式" : "专注模式"}
          onClick={toggleFocusMode}
        >
          <IconFocus />
        </button>
        <button className="toolbar-export" onClick={onOpenExport}>
          <IconExport size={14} /> <span>导出</span>
        </button>

        <div className="toolbar-more" ref={moreRef}>
          <button
            ref={moreButtonRef}
            className={`icon-btn${moreOpen ? " active" : ""}`}
            aria-label="更多工具"
            aria-haspopup="menu"
            aria-expanded={moreOpen}
            aria-controls={popoverId}
            onClick={() => {
              restoreMoreFocus.current = moreOpen;
              setMoreOpen((open) => !open);
            }}
          >
            <IconMore />
          </button>
          {moreOpen && (
            <div
              id={popoverId}
              className="toolbar-popover"
              role="menu"
              aria-label="更多工具"
            >
              <div className="toolbar-menu-label">创作工具</div>
              <button role="menuitem" onClick={() => run(onOpenCards)}>
                <IconUsers />
                人物与地点
              </button>
              <button role="menuitem" onClick={() => run(onOpenStats)}>
                <IconChart />
                码字统计
              </button>
              <button role="menuitem" onClick={() => run(onOpenNames)}>
                <IconDice />
                随机取名
              </button>
              <button
                disabled={selectedChapterId === null}
                role="menuitem"
                onClick={() => run(() => setToolModal("scenes"))}
              >
                <IconOverview />
                场景写作板
              </button>
              <button
                role="menuitem"
                onClick={() => run(() => setToolModal("continuity"))}
              >
                <IconShield />
                连续性检查
              </button>
              <button
                role="menuitem"
                onClick={() => run(() => setToolModal("revision"))}
              >
                <IconSearch />
                修订工作台
              </button>
              <button
                role="menuitem"
                onClick={() => run(() => setToolModal("state"))}
              >
                <IconUsers />
                人物状态账本
              </button>
              <button
                role="menuitem"
                onClick={() => run(() => setToolModal("forge"))}
              >
                <IconDice />
                龙套批量铸造
              </button>
              <button
                role="menuitem"
                onClick={() => run(() => setViewMode("address"))}
              >
                <IconShield />
                称谓一致性
              </button>
              <button
                role="menuitem"
                onClick={() => run(() => setViewMode("style"))}
              >
                <IconChart />
                文风与结构快照
              </button>
              <span className="toolbar-menu-sep" />
              <div className="toolbar-menu-label">项目</div>
              <button role="menuitem" onClick={() => run(onOpenBackup)}>
                <IconShield />
                备份与恢复
              </button>
              <button role="menuitem" onClick={() => run(cycleTheme)}>
                <span className="menu-symbol" aria-hidden="true">
                  ◐
                </span>
                主题：{THEME_LABEL[theme]}
              </button>
              <button role="menuitem" onClick={() => run(onOpenSettings)}>
                <IconSettings />
                显示设置
              </button>
            </div>
          )}
        </div>
        <WindowControls />
      </div>
    </header>
  );
}
