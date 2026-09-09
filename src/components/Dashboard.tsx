/** 首页仪表盘：书架 + 新建 / 打开 / 导入（文档第五十二节） */
import { useEffect, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import * as api from "../api";
import { useAppStore } from "../store/appStore";
import type { RecentProject } from "../types/models";
import { NewProjectModal } from "./NewProjectModal";
import { WindowControls } from "./WindowControls";
import { IconDocPlus, IconFolderPlus, IconImport, IconMore, IconTrash } from "./icons";
import { ContextMenu } from "./ContextMenu";
import "../styles/dashboard.css";

/** 书封底色：按书名哈希从固定色板取色，同一本书永远同色 */
function bookTone(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return h % 8;
}

function formatOpenedAt(value: string): string {
  const parsed = new Date(
    value.includes("T") ? value : value.replace(" ", "T"),
  );
  if (Number.isNaN(parsed.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(parsed);
}

/** 「翻开书本」动画时长，与 global.css 中 bookOpen 关键帧保持一致 */
const BOOK_OPEN_MS = 500;

export function Dashboard() {
  const openProject = useAppStore((s) => s.openProject);
  const showToast = useAppStore((s) => s.showToast);
  const [recent, setRecent] = useState<RecentProject[]>([]);
  const [modal, setModal] = useState<"blank" | "import" | null>(null);
  const [busy, setBusy] = useState(false);
  const [openingPath, setOpeningPath] = useState<string | null>(null);
  const latestProject = recent[0] ?? null;

  const refresh = async () => {
    try {
      setRecent(await api.listRecentProjects());
    } catch {
      /* 全局库异常时保持空列表 */
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  const openExisting = async () => {
    try {
      const selected = await openDialog({
        directory: true,
        title: "选择小说项目文件夹（包含 project.novel）",
      });
      if (typeof selected === "string") {
        setBusy(true);
        await openProject(selected);
      }
    } catch (e) {
      showToast(String(e), "error");
    } finally {
      setBusy(false);
    }
  };

  const removeRecent = async (path: string) => {
    try {
      await api.removeRecentProject(path);
      await refresh();
    } catch (e) {
      showToast(String(e), "error");
    }
  };

  const renameProject = async (path: string, oldName: string) => {
    const name = window.prompt("修改书名", oldName);
    if (name === null) return;
    const trimmed = name.trim();
    if (!trimmed) {
      showToast("书名不能为空", "error");
      return;
    }
    if (trimmed === oldName) return;
    try {
      await api.renameProjectByPath(path, trimmed);
      await refresh();
      showToast("已修改书名");
    } catch (e) {
      showToast(String(e), "error");
    }
  };

  /** 先播放「翻开书本」动画，封面立起后再切换进项目视图 */
  const openWithAnim = async (path: string) => {
    setOpeningPath(path);
    await new Promise((r) => setTimeout(r, BOOK_OPEN_MS));
    try {
      await openProject(path);
    } catch (e) {
      showToast(String(e), "error");
    } finally {
      setOpeningPath(null);
    }
  };

  return (
    <div className="dashboard">
      <div className="dash-titlebar" data-tauri-drag-region="deep">
        <div className="dash-brand" data-tauri-drag-region="deep">
          <span className="dash-brand-mark">文</span>
          <span>NovelForge</span>
        </div>
        <div className="dash-local-badge" data-tauri-drag-region="deep">
          <span aria-hidden="true" /> 本地创作空间
        </div>
        <WindowControls />
      </div>

      <div className="dashboard-scroll">
        <div className="dashboard-inner">
          <section className="dashboard-hero">
            <div className="dashboard-hero-copy">
              <span className="dashboard-eyebrow">
                {latestProject ? "欢迎回来" : "为长篇创作而生"}
              </span>
              {latestProject ? (
                <>
                  <h1>
                    继续写下去。
                    <br />
                    <span>灵感不必等待。</span>
                  </h1>
                  <button
                    className="dashboard-return-copy"
                    onClick={() => void openWithAnim(latestProject.path)}
                    disabled={busy || openingPath !== null}
                    title={`打开《${latestProject.name}》`}
                  >
                    <strong>最近创作《{latestProject.name}》</strong>
                    <span>
                      上次打开 · {formatOpenedAt(latestProject.lastOpenedAt)}
                    </span>
                  </button>
                </>
              ) : (
                <>
                  <h1>
                    让故事，
                    <br />
                    <span>在你手中成形。</span>
                  </h1>
                  <p>
                    从第一句灵感到完整世界观，在一个安静、专注、完全属于你的空间里完成它。
                  </p>
                </>
              )}
              {latestProject && (
                <div className="dashboard-hero-actions">
                  <button
                    className="dash-primary-action dash-continue-action"
                    onClick={() => void openWithAnim(latestProject.path)}
                    disabled={busy || openingPath !== null}
                    title={`继续《${latestProject.name}》`}
                  >
                    <span className="continue-label">
                      继续《{latestProject.name}》
                    </span>
                    <span aria-hidden="true">›</span>
                  </button>
                </div>
              )}
              <div className="dashboard-privacy">
                <span className="privacy-lock" aria-hidden="true">
                  ✓
                </span>
                本地保存，离线可用，不上传你的文字
              </div>
            </div>

            <div className="dashboard-product" aria-hidden="true">
              <div className="product-glow" />
              <div className="product-window">
                <div className="product-toolbar">
                  <span />
                  <span />
                  <span />
                  <b>长夜听雨</b>
                </div>
                <div className="product-body">
                  <div className="product-sidebar">
                    <i className="wide" />
                    <i />
                    <i />
                    <i className="active" />
                    <i />
                    <i />
                  </div>
                  <div className="product-page">
                    <small>第三卷 · 风雪故人归</small>
                    <strong>第十二章　渡口</strong>
                    <p>雨从檐角落下来，在青石板上碎成一层薄雾。</p>
                    <p>她停在灯火之外，终于听见那个人叫出了自己的名字。</p>
                    <div className="product-caret" />
                  </div>
                  <div className="product-inspector">
                    <i />
                    <i className="short" />
                    <em>人物</em>
                    <i />
                    <i className="short" />
                  </div>
                </div>
              </div>
            </div>
          </section>

          <section className="recent-section recent-section-priority">
            <div className="section-heading">
              <div>
                <span>最近作品</span>
                <h2>一眼找到，立即续写。</h2>
              </div>
              {recent.length > 0 && (
                <span className="project-count">{recent.length} 部作品</span>
              )}
            </div>
            {recent.length === 0 ? (
              <div className="recent-empty">
                <span>你的第一部作品，会出现在这里。</span>
                <button onClick={() => setModal("blank")}>
                  开始创作 <i aria-hidden="true">›</i>
                </button>
              </div>
            ) : (
              <div className="bookshelf">
                {recent.map((p, i) => (
                  <div
                    key={p.path}
                    className="book-slot"
                    style={{ animationDelay: `${Math.min(i, 8) * 45}ms` }}
                  >
                    <button
                      className={`book-card book-tone-${bookTone(p.name)}${
                        openingPath === p.path ? " opening" : ""
                      }`}
                      disabled={busy || openingPath !== null}
                      onClick={() => void openWithAnim(p.path)}
                      title={p.path}
                    >
                      <span className="book-cover">
                        <span className="book-frame" aria-hidden="true" />
                        <span className="book-series">NOVELFORGE ORIGINAL</span>
                        <span className="book-title">{p.name}</span>
                        <span className="book-monogram">文</span>
                      </span>
                      <span className="book-info">
                        <strong>{p.name}</strong>
                        <span>上次打开 · {formatOpenedAt(p.lastOpenedAt)}</span>
                      </span>
                    </button>
                    <button
                      className="icon-btn book-more"
                      title="更多操作"
                      onClick={(e) => {
                        e.stopPropagation();
                        ContextMenu.open(e.clientX, e.clientY, [
                          {
                            label: "改名",
                            onClick: () => void renameProject(p.path, p.name),
                          },
                          { type: "separator" } as any,
                          {
                            label: "从书架移除",
                            danger: true,
                            icon: <IconTrash size={14} />,
                            onClick: () => void removeRecent(p.path),
                          },
                        ]);
                      }}
                    >
                      <IconMore />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="dashboard-start">
            <div className="section-heading">
              <div>
                <span>更多方式</span>
                <h2>开始另一段旅程。</h2>
              </div>
            </div>
            <div className="dashboard-actions">
              <button
                className="action-card"
                onClick={() => setModal("blank")}
                disabled={busy}
              >
                <span className="action-icon">
                  <IconDocPlus size={22} />
                </span>
                <span className="action-copy">
                  <span className="action-label">新建小说</span>
                  <span className="action-hint">从空白作品开始构建世界</span>
                </span>
                <span className="action-arrow" aria-hidden="true">
                  ›
                </span>
              </button>
              <button
                className="action-card"
                onClick={() => setModal("import")}
                disabled={busy}
              >
                <span className="action-icon">
                  <IconImport size={22} />
                </span>
                <span className="action-copy">
                  <span className="action-label">智能导入</span>
                  <span className="action-hint">识别 TXT / DOCX / MD 章节</span>
                </span>
                <span className="action-arrow" aria-hidden="true">
                  ›
                </span>
              </button>
              <button
                className="action-card"
                onClick={() => void openExisting()}
                disabled={busy}
              >
                <span className="action-icon">
                  <IconFolderPlus size={22} />
                </span>
                <span className="action-copy">
                  <span className="action-label">打开项目</span>
                  <span className="action-hint">从本地文件夹继续创作</span>
                </span>
                <span className="action-arrow" aria-hidden="true">
                  ›
                </span>
              </button>
            </div>
          </section>
        </div>
      </div>

      {modal && <NewProjectModal mode={modal} onClose={() => setModal(null)} />}
    </div>
  );
}
