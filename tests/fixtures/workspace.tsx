/** In-memory project workspace fixture. No real project or database is opened. */
import React, { useEffect } from "react";
import { createRoot } from "react-dom/client";
import { mockIPC } from "@tauri-apps/api/mocks";
import { useAppStore } from "../../src/store/appStore";
import { useEditorStore } from "../../src/store/editorStore";
import { TopBar } from "../../src/components/TopBar";
import { ChapterTree } from "../../src/components/ChapterTree";
import { ChapterEditor } from "../../src/components/ChapterEditor";
import { InfoPanel } from "../../src/components/InfoPanel";
import { StatusBar } from "../../src/components/StatusBar";
import type { Theme } from "../../src/types/models";
import "../../src/styles/global.css";
import "../../src/styles/workspace.css";

const params = new URLSearchParams(location.search);
const filled = params.get("mode") === "filled";
const requestedTheme: Theme =
  params.get("theme") === "dark" || params.get("theme") === "sepia"
    ? (params.get("theme") as Theme)
    : "light";
document.documentElement.dataset.theme = requestedTheme;

const detail = {
  id: 1,
  volumeId: 1,
  title: "第十二章　渡口",
  content:
    "雨从檐角落下来，在青石板上碎成一层薄雾。\n\n沈照夜停在灯火之外。她已经走了很远，久到几乎忘记故乡的雨是什么声音。\n\n“你终于来了。”\n\n那个人没有回头，只将一封被雨水浸透的信放在窗边。",
  wordCount: 78,
  charCount: 93,
  status: 0,
  summary: "沈照夜在渡口与故人重逢，拿到父亲留下的信。",
  notes: "注意压住重逢情绪；结尾用信上的落款制造钩子。",
  updatedAt: "19:42",
};

const tree = {
  info: {
    name: "长夜听雨",
    author: "林岸",
    description: "",
    outline: "少女为寻找失踪的父亲踏入旧城，在七场雨中揭开听雨楼的秘密。",
    createdAt: "2026-09-01",
    updatedAt: "2026-09-09",
  },
  projectPath: "fixture/project",
  volumes: [
    {
      id: 1,
      title: "第一卷　雨夜来客",
      sortOrder: 0,
      summary: "",
      chapterCount: filled ? 3 : 0,
      wordCount: filled ? 12840 : 0,
      updatedAt: "",
    },
    {
      id: 2,
      title: "第二卷　旧城无声",
      sortOrder: 1,
      summary: "",
      chapterCount: filled ? 2 : 0,
      wordCount: filled ? 9320 : 0,
      updatedAt: "",
    },
  ],
  chapters: filled
    ? [
        {
          id: 2,
          volumeId: 1,
          title: "第十章　来信",
          wordCount: 3650,
          sortOrder: 0,
          status: 1,
          updatedAt: "",
        },
        {
          id: 3,
          volumeId: 1,
          title: "第十一章　故人",
          wordCount: 4112,
          sortOrder: 1,
          status: 1,
          updatedAt: "",
        },
        {
          id: 1,
          volumeId: 1,
          title: detail.title,
          wordCount: detail.wordCount,
          sortOrder: 2,
          status: 0,
          updatedAt: "",
        },
        {
          id: 4,
          volumeId: 2,
          title: "第十三章　城门",
          wordCount: 4080,
          sortOrder: 0,
          status: 0,
          updatedAt: "",
        },
        {
          id: 5,
          volumeId: 2,
          title: "第十四章　暗巷",
          wordCount: 5162,
          sortOrder: 1,
          status: 0,
          updatedAt: "",
        },
      ]
    : [],
  stats: {
    totalWordCount: filled ? 22160 : 0,
    totalCharCount: filled ? 25600 : 0,
    volumeCount: 2,
    chapterCount: filled ? 5 : 0,
  },
};

useAppStore.setState({
  tree,
  theme: requestedTheme,
  selectedChapterId: filled ? 1 : null,
  viewMode: "editor",
  focusMode: false,
  todayWords: filled ? 2019 : 0,
});
useEditorStore.setState(
  filled
    ? {
        chapterId: detail.id,
        volumeId: detail.volumeId,
        title: detail.title,
        content: detail.content,
        status: detail.status,
        dirty: false,
        saving: false,
        savePending: false,
        lastSavedAt: detail.updatedAt,
        saveError: null,
        wordCount: detail.wordCount,
        charCount: detail.charCount,
      }
    : { chapterId: null, volumeId: null, title: "", content: "", dirty: false },
);

mockIPC(async (command) => {
  if (command.startsWith("plugin:window|")) return false;
  if (command === "get_chapter") return structuredClone(detail);
  if (command === "list_chapter_versions") return [];
  if (command === "get_chapter_presence") {
    return {
      characters: [{ id: 1, name: "沈照夜", mentionCount: 2 }],
      locations: [{ id: 1, name: "渡口", mentionCount: 1 }],
    };
  }
  if (command === "get_chapter_story_context")
    throw new Error("fixture: no story edges");
  throw new Error(`Unexpected fixture command: ${command}`);
});

const noop = () => undefined;
function FixtureShell() {
  const focusMode = useAppStore((s) => s.focusMode);
  const viewMode = useAppStore((s) => s.viewMode);
  const theme = useAppStore((s) => s.theme);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const state = useAppStore.getState();
      if (state.focusMode) state.toggleFocusMode();
      else if (state.viewMode !== "editor") state.setViewMode("editor");
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <div className="app">
      <div className="project-view">
        <TopBar
          onBack={noop}
          onOpenSettings={noop}
          onOpenExport={noop}
          onOpenSearch={noop}
          onOpenBackup={noop}
          onOpenCards={noop}
          onOpenStats={noop}
          onOpenNames={noop}
        />
        <div
          className={`main-columns${focusMode ? " focus" : ""}${viewMode !== "editor" ? " view-switched" : ""}`}
          data-testid="fixture-main-columns"
        >
          <ChapterTree />
          <ChapterEditor />
          <InfoPanel />
        </div>
        {viewMode !== "editor" && (
          <div className="story-view" data-testid="fixture-story-view">
            <div className="editor-empty">
              <span className="editor-empty-eyebrow">NovelForge 工作区</span>
              <h1>
                {viewMode === "map"
                  ? "故事地图"
                  : viewMode === "overview"
                    ? "全书总览"
                    : "角色卡"}
              </h1>
            </div>
          </div>
        )}
        <StatusBar />
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <FixtureShell />
  </React.StrictMode>,
);
