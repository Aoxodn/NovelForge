/** In-memory dashboard fixture. It never reads or opens a real project. */
import React from "react";
import { createRoot } from "react-dom/client";
import { mockIPC } from "@tauri-apps/api/mocks";
import { Dashboard } from "../../src/components/Dashboard";
import "../../src/styles/global.css";

const params = new URLSearchParams(location.search);
document.documentElement.dataset.theme = params.get("theme") || "light";

const recent = [
  {
    name: "长夜听雨",
    path: "fixture/one",
    lastOpenedAt: "2026-09-09 19:07:08",
  },
  {
    name: "群星沉默之后",
    path: "fixture/two",
    lastOpenedAt: "2026-09-08 23:12:00",
  },
  {
    name: "春山来信",
    path: "fixture/three",
    lastOpenedAt: "2026-09-05 09:20:00",
  },
  {
    name: "第七座城",
    path: "fixture/four",
    lastOpenedAt: "2026-08-28 16:45:00",
  },
];

mockIPC(async (command, payload) => {
  if (command === "list_recent_projects") return structuredClone(recent);
  if (command === "open_project") {
    const args = payload as { path: string };
    (window as typeof window & { __openedPath?: string }).__openedPath =
      args.path;
    return {
      projectPath: args.path,
      info: {
        name: "长夜听雨",
        author: "林岸",
        description: "",
        outline: "",
      },
      volumes: [],
      chapters: [],
      stats: { totalWordCount: 0, volumeCount: 0, chapterCount: 0 },
    };
  }
  if (command === "get_writing_stats") {
    return { todayWords: 0, totalSeconds: 0, speed: 0 };
  }
  if (command.startsWith("plugin:window|")) return false;
  throw new Error(`Unexpected fixture command: ${command}`);
});

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <div className="app">
      <Dashboard />
    </div>
  </React.StrictMode>,
);
