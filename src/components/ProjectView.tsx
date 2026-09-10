/**
 * 项目视图：三栏桌面布局（文档第十一节）
 *   顶栏 / 目录树 | 编辑器 | 信息面板 / 状态栏
 * 并挂载全局快捷键（Ctrl+N / Ctrl+F）、窗口关闭前自动保存冲刷、
 * 30 分钟周期自动备份（文档第六十五节）。
 */
import { useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEditorStore } from "../store/editorStore";
import { useAppStore } from "../store/appStore";
import * as api from "../api";
import { ChapterTree } from "./ChapterTree";
import { ChapterEditor } from "./ChapterEditor";
import { InfoPanel } from "./InfoPanel";
import { StatusBar } from "./StatusBar";
import { TopBar } from "./TopBar";
import { SettingsPanel } from "./SettingsPanel";
import { ExportModal } from "./ExportModal";
import { SearchPanel } from "./SearchPanel";
import { BackupModal } from "./BackupModal";
import { CardsModal } from "./CardsModal";
import { StatsModal } from "./StatsModal";
import { NameGeneratorModal } from "./NameGeneratorModal";
import { StoryMap } from "./StoryMap";
import { OverviewView } from "./OverviewView";
import { CharacterCardView } from "./CharacterCardView";
import { SaveFailureDialog } from "./SaveFailureDialog";
import { ContinuityModal } from "./tools/ContinuityModal";
import { RevisionModal } from "./tools/RevisionModal";
import { SceneBoardModal } from "./tools/SceneBoardModal";
import {
  AddressConsistency,
  BatchForgeModal,
  ForeshadowLedger,
  LoreLibrary,
  PovDashboardView,
  ProgressBoard,
  StateLedgerModal,
  StoryTimelineView,
  StyleAndStructure,
} from "./tools/RoadmapTools";
import { SplitOutlinePane } from "./SplitOutlinePane";
import "../styles/workspace.css";

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
  /** 保存失败阻断对话框：null=不显示；'back'=返回首页流程；'close'=关窗流程 */
  const [saveBlock, setSaveBlock] = useState<{
    reason: string;
    flow: "back" | "close";
  } | null>(null);
  /** 关窗流程持有的窗口句柄（强制退出时 destroy） */
  const winRef = useRef<Awaited<ReturnType<typeof getCurrentWindow>> | null>(
    null,
  );
  const projectPath = useAppStore((s) => s.tree?.projectPath ?? null);
  const closeProject = useAppStore((s) => s.closeProject);
  const focusMode = useAppStore((s) => s.focusMode);
  const viewMode = useAppStore((s) => s.viewMode);
  const toolModal = useAppStore((s) => s.toolModal);
  const setToolModal = useAppStore((s) => s.setToolModal);
  const selectedChapterId = useAppStore((s) => s.selectedChapterId);
  const splitMode = useAppStore((s) => s.splitMode);
  const currentChapterTitle = useAppStore((s) => {
    const hit = s.tree?.chapters.find((c) => c.id === s.selectedChapterId);
    return hit?.title ?? "";
  });

  /** 退出项目的最后一步：调用方已决定是否需要保存。 */
  const finishExitProject = async () => {
    useEditorStore.getState().clear();
    await closeProject();
  };

  /** 正常退出：clear/close 会让编辑器失去最后一份内存快照，先完整冲刷队列。 */
  const doExitProject = async () => {
    await useEditorStore.getState().flush();
    await finishExitProject();
  };

  /** 用户在保存失败对话框中明确选择“强制退出”：有意丢弃内存稿。 */
  const forceExitProject = async () => {
    await finishExitProject();
  };

  /** 返回：在故事地图 / 总览等视图时先回写作界面（避免误退项目），
   *  已在写作界面才走「关书动画 → 退出项目」流程；保存失败必须阻断 */
  const handleBack = () => {
    if (closing) return;
    if (useAppStore.getState().viewMode !== "editor") {
      useAppStore.getState().setViewMode("editor");
      return;
    }
    setClosing(true);
    setTimeout(async () => {
      try {
        await doExitProject();
      } catch (e) {
        // 保存失败：停止退出，弹出阻断对话框
        setClosing(false);
        setSaveBlock({ reason: String(e), flow: "back" });
        return;
      }
    }, 320);
  };

  // 打开项目后做增量提及统计（审查 P1-3）：后端只重算 content_hash 过期 / 缺失
  // 的章节，已索引章节不重扫；后台线程计算，完成后广播事件刷新面板与卡片。
  useEffect(() => {
    if (!projectPath) return;
    let cancelled = false;
    void api
      .rebuildMentions()
      .then(() => {
        if (!cancelled) window.dispatchEvent(new Event("nf:cards-updated"));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [projectPath]);

  // 卡片弹窗内跳转「随机取名」
  useEffect(() => {
    const h = () => setShowNames(true);
    window.addEventListener("nf:open-name-generator", h);
    return () => window.removeEventListener("nf:open-name-generator", h);
  }, []);

  // 全局快捷键：Ctrl+N 新建章节；Ctrl+F 全文搜索；Ctrl+J / F11 专注模式；Esc 退出专注
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === "n") {
        e.preventDefault();
        // 目录组件在非写作视图仍保持挂载；先切回写作视图，再打开新章对话框，
        // 避免弹窗创建在被隐藏的三栏区域中。
        if (useAppStore.getState().viewMode !== "editor") {
          useAppStore.getState().setViewMode("editor");
          window.setTimeout(() => {
            window.dispatchEvent(new CustomEvent("nf:new-chapter"));
          }, 0);
        } else {
          window.dispatchEvent(new CustomEvent("nf:new-chapter"));
        }
      } else if (e.ctrlKey && e.key.toLowerCase() === "f") {
        e.preventDefault();
        setShowSearch(true);
      } else if (
        (e.ctrlKey && e.key.toLowerCase() === "j") ||
        e.key === "F11"
      ) {
        e.preventDefault();
        useAppStore.getState().toggleFocusMode();
      } else if (e.ctrlKey && e.key === "\\") {
        e.preventDefault();
        useAppStore.getState().toggleSplitMode();
      } else if (e.key === "Escape") {
        // 模态层拥有 Esc 的最高优先级（Modal 自己负责关闭）；不要同时切视图/退出专注。
        if (document.querySelector(".modal-mask")) return;
        // Esc 逐层退出：专注模式 → 故事地图 / 总览视图 →（编辑界面内不拦截）
        const s = useAppStore.getState();
        if (s.focusMode) s.toggleFocusMode();
        else if (s.viewMode !== "editor") s.setViewMode("editor");
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  // 窗口关闭前冲刷未保存内容（防崩溃丢字）；保存失败时阻断关闭并弹出抢救对话框
  useEffect(() => {
    // 非 Tauri 环境（浏览器预览）无窗口 API，跳过
    let win: ReturnType<typeof getCurrentWindow>;
    try {
      win = getCurrentWindow();
    } catch {
      return;
    }
    winRef.current = win;
    const promise = win.onCloseRequested(async (event) => {
      const ed = useEditorStore.getState();
      if (ed.chapterId !== null && (ed.dirty || ed.saving || ed.savePending)) {
        event.preventDefault();
        try {
          await ed.flush();
          await win.destroy();
        } catch (e) {
          // 保存失败：不销毁窗口，交给用户选择重试/导出/强制退出
          setSaveBlock({ reason: String(e), flow: "close" });
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
    <div className={`project-view${closing ? " closing" : ""}`}>
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
        className={`main-columns${focusMode ? " focus" : ""}${viewMode !== "editor" ? " view-switched" : ""}`}
      >
        {splitMode && viewMode === "editor" && !focusMode && (
          <SplitOutlinePane />
        )}
        <ChapterTree />
        <ChapterEditor />
        <InfoPanel />
        {showSettings && viewMode === "editor" && (
          <SettingsPanel onClose={() => setShowSettings(false)} />
        )}
      </div>
      {/* 故事地图 / 全书总览 / 路线图视图 */}
      {viewMode === "map" && (
        <div className="story-view">
          <StoryMap />
        </div>
      )}
      {viewMode === "overview" && (
        <div className="story-view">
          <OverviewView />
        </div>
      )}
      {viewMode === "characters" && (
        <div className="story-view">
          <CharacterCardView />
        </div>
      )}
      {viewMode === "timeline" && (
        <div className="story-view">
          <StoryTimelineView />
        </div>
      )}
      {viewMode === "board" && (
        <div className="story-view">
          <ProgressBoard />
        </div>
      )}
      {viewMode === "lore" && (
        <div className="story-view">
          <LoreLibrary />
        </div>
      )}
      {viewMode === "foreshadow" && (
        <div className="story-view">
          <ForeshadowLedger />
        </div>
      )}
      {viewMode === "pov" && (
        <div className="story-view">
          <PovDashboardView />
        </div>
      )}
      {viewMode === "address" && (
        <div className="story-view">
          <AddressConsistency />
        </div>
      )}
      {viewMode === "style" && (
        <div className="story-view">
          <StyleAndStructure />
        </div>
      )}
      <StatusBar />
      {showExport && <ExportModal onClose={() => setShowExport(false)} />}
      {showBackup && <BackupModal onClose={() => setShowBackup(false)} />}
      {showSearch && <SearchPanel onClose={() => setShowSearch(false)} />}
      {showCards && <CardsModal onClose={() => setShowCards(false)} />}
      {showStats && <StatsModal onClose={() => setShowStats(false)} />}
      {showNames && <NameGeneratorModal onClose={() => setShowNames(false)} />}
      {toolModal === "continuity" && (
        <ContinuityModal onClose={() => setToolModal("none")} />
      )}
      {toolModal === "revision" && (
        <RevisionModal onClose={() => setToolModal("none")} />
      )}
      {toolModal === "scenes" && selectedChapterId !== null && (
        <SceneBoardModal
          chapterId={selectedChapterId}
          chapterTitle={currentChapterTitle}
          onClose={() => setToolModal("none")}
        />
      )}
      {toolModal === "state" && (
        <StateLedgerModal onClose={() => setToolModal("none")} />
      )}
      {toolModal === "forge" && (
        <BatchForgeModal onClose={() => setToolModal("none")} />
      )}
      {saveBlock && (
        <SaveFailureDialog
          reason={saveBlock.reason}
          title={useEditorStore.getState().title}
          content={useEditorStore.getState().content}
          onCancel={() => setSaveBlock(null)}
          onRetry={async () => {
            try {
              await useEditorStore.getState().flush();
            } catch {
              return false;
            }
            // 保存成功：继续原本被阻断的流程
            const flow = saveBlock.flow;
            setSaveBlock(null);
            if (flow === "close") {
              await winRef.current?.destroy();
            } else {
              // flush 已在本次重试中完成，避免重复保存；只执行退出收尾。
              await finishExitProject();
            }
            return true;
          }}
          onForceExit={async () => {
            const flow = saveBlock.flow;
            setSaveBlock(null);
            if (flow === "close") {
              await winRef.current?.destroy();
            } else {
              // 明确的强制退出允许丢弃未保存内容，不能再次调用 flush。
              await forceExitProject();
            }
          }}
        />
      )}
    </div>
  );
}
