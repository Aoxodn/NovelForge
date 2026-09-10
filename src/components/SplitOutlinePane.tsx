/**
 * 编辑器分屏左栏：对照细纲 / 场景 / 伏笔（P0-5）。
 */
import { useEffect, useState } from "react";
import { useAppStore } from "../store/appStore";
import * as api from "../api";
import type { ForeshadowItem } from "../types/models";

interface SceneBrief {
  id: number;
  pov: string;
  timeOfScene: string;
  place: string;
  goal: string;
  conflict: string;
  result: string;
}

export function SplitOutlinePane() {
  const selectedChapterId = useAppStore((s) => s.selectedChapterId);
  const tree = useAppStore((s) => s.tree);
  const splitPane = useAppStore((s) => s.splitPane);
  const setSplitPane = useAppStore((s) => s.setSplitPane);
  const toggleSplitMode = useAppStore((s) => s.toggleSplitMode);

  const chapter = tree?.chapters.find((c) => c.id === selectedChapterId) ?? null;
  const volume = tree?.volumes.find((v) => v.id === chapter?.volumeId) ?? null;

  const [scenes, setScenes] = useState<SceneBrief[]>([]);
  const [foreshadows, setForeshadows] = useState<ForeshadowItem[]>([]);
  const [summary, setSummary] = useState("");
  const [arcIds, setArcIds] = useState<number[]>([]);
  const [arcs, setArcs] = useState<{ id: number; title: string }[]>([]);

  useEffect(() => {
    void api
      .listStoryArcs()
      .then((list) => setArcs(list.map((a) => ({ id: a.id, title: a.title }))))
      .catch(() => setArcs([]));
  }, []);

  useEffect(() => {
    if (!selectedChapterId) {
      setScenes([]);
      setForeshadows([]);
      setSummary("");
      setArcIds([]);
      return;
    }
    let cancelled = false;
    void api
      .listScenes(selectedChapterId)
      .then((list) => {
        if (!cancelled) setScenes(list as unknown as SceneBrief[]);
      })
      .catch(() => undefined);
    void api
      .foreshadowsForChapter(selectedChapterId)
      .then((list) => {
        if (!cancelled) setForeshadows(list);
      })
      .catch(() => undefined);
    void api
      .getChapter(selectedChapterId)
      .then((detail) => {
        if (!cancelled) setSummary(detail.summary);
      })
      .catch(() => undefined);
    void api
      .getChapterArcs(selectedChapterId)
      .then((ids) => {
        if (!cancelled) setArcIds(ids);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [selectedChapterId]);

  return (
    <aside className="nf-split-pane">
      <div className="nf-split-pane__tabs">
        <button
          className={splitPane === "outline" ? "on" : ""}
          onClick={() => setSplitPane("outline")}
        >
          细纲
        </button>
        <button
          className={splitPane === "scenes" ? "on" : ""}
          onClick={() => setSplitPane("scenes")}
        >
          场景
        </button>
        <button
          className={splitPane === "foreshadow" ? "on" : ""}
          onClick={() => setSplitPane("foreshadow")}
        >
          伏笔
        </button>
        <button onClick={toggleSplitMode} title="关闭分屏">
          ×
        </button>
      </div>
      <div className="nf-split-pane__body">
        {!chapter ? (
          <p className="hint">未选中章节</p>
        ) : splitPane === "outline" ? (
          <>
            <h4>
              {volume ? `${volume.title} · ` : ""}
              {chapter.title}
            </h4>
            {tree?.info.outline ? (
              <>
                <h4>全书主线</h4>
                <pre>{tree.info.outline.slice(0, 400)}</pre>
              </>
            ) : null}
            {volume?.summary ? (
              <>
                <h4>本卷纲</h4>
                <pre>{volume.summary}</pre>
              </>
            ) : null}
            <h4>本章细纲</h4>
            <pre>{summary || "（空）"}</pre>
            {arcs.length > 0 && selectedChapterId ? (
              <>
                <h4>剧情线归属</h4>
                <div className="arc-checks">
                  {arcs.map((a) => {
                    const on = arcIds.includes(a.id);
                    return (
                      <label key={a.id}>
                        <input
                          type="checkbox"
                          checked={on}
                          onChange={() => {
                            const next = on
                              ? arcIds.filter((x) => x !== a.id)
                              : [...arcIds, a.id];
                            void api
                              .setChapterArcs(
                                selectedChapterId,
                                next,
                                next[0] ?? null,
                              )
                              .then(() => setArcIds(next))
                              .catch(() => undefined);
                          }}
                        />
                        {a.title}
                      </label>
                    );
                  })}
                </div>
              </>
            ) : null}
          </>
        ) : splitPane === "scenes" ? (
          <>
            {scenes.length === 0 ? (
              <p className="hint">
                暂无场景。可在工具菜单打开「场景写作板」。
              </p>
            ) : (
              scenes.map((s) => (
                <div key={s.id} className="scene-item">
                  <div>
                    <strong>POV</strong> {s.pov || "—"} · <strong>时</strong>{" "}
                    {s.timeOfScene || "—"} · <strong>地</strong> {s.place || "—"}
                  </div>
                  <div>
                    <strong>目标</strong> {s.goal || "—"}
                  </div>
                  <div>
                    <strong>冲突</strong> {s.conflict || "—"}
                  </div>
                  <div>
                    <strong>结果</strong> {s.result || "—"}
                  </div>
                </div>
              ))
            )}
          </>
        ) : (
          <>
            {foreshadows.length === 0 ? (
              <p className="hint">本章暂无关联伏笔</p>
            ) : (
              foreshadows.map((f) => (
                <div key={f.id} className="fs-item">
                  <div>
                    <strong>{f.title}</strong>
                    {f.overdue ? <span className="badge warn">逾期</span> : null}
                  </div>
                  <div className="hint">
                    {["活跃", "已回收", "失效"][f.status] ?? ""} · 跨度{" "}
                    {f.span >= 0 ? f.span : "—"}
                  </div>
                  {f.note ? <div>{f.note}</div> : null}
                </div>
              ))
            )}
          </>
        )}
      </div>
    </aside>
  );
}
