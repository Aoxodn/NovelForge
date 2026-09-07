/** 首页仪表盘：书架 + 新建 / 打开 / 导入（文档第五十二节） */
import { useEffect, useState } from 'react';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import * as api from '../api';
import { useAppStore } from '../store/appStore';
import type { RecentProject } from '../types/models';
import { NewProjectModal } from './NewProjectModal';
import { WindowControls } from './WindowControls';
import { IconDocPlus, IconFolderPlus, IconImport, IconTrash } from './icons';

/** 书封底色：按书名哈希从固定色板取色，同一本书永远同色 */
function bookTone(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return h % 6;
}

/** 「翻开书本」动画时长，与 global.css 中 bookOpen 关键帧保持一致 */
const BOOK_OPEN_MS = 500;

export function Dashboard() {
  const openProject = useAppStore((s) => s.openProject);
  const [recent, setRecent] = useState<RecentProject[]>([]);
  const [modal, setModal] = useState<'blank' | 'import' | null>(null);
  const [busy, setBusy] = useState(false);
  const [openingPath, setOpeningPath] = useState<string | null>(null);

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
    const selected = await openDialog({
      directory: true,
      title: '选择小说项目文件夹（包含 project.novel）',
    });
    if (typeof selected === 'string') {
      setBusy(true);
      await openProject(selected);
      setBusy(false);
    }
  };

  const removeRecent = async (path: string) => {
    await api.removeRecentProject(path);
    void refresh();
  };

  /** 先播放「翻开书本」动画，封面立起后再切换进项目视图 */
  const openWithAnim = async (path: string) => {
    setOpeningPath(path);
    await new Promise((r) => setTimeout(r, BOOK_OPEN_MS));
    try {
      await openProject(path);
    } finally {
      setOpeningPath(null);
    }
  };

  return (
    <div className="dashboard">
      {/* 无边框窗口：顶部拖拽条 + 窗口控制按钮 */}
      <div className="dash-titlebar" data-tauri-drag-region="deep">
        <WindowControls />
      </div>

      <div className="dashboard-scroll">
        <div className="dashboard-inner">
          <header className="dashboard-header">
            <div className="dashboard-logo">文</div>
            <h1>
              NovelForge <span className="logo-cn">小说工坊</span>
            </h1>
            <p className="dashboard-sub">本地优先 · 完全离线 · 你的小说只属于你</p>
          </header>

          <div className="dashboard-actions">
            <button className="action-card" onClick={() => setModal('blank')} disabled={busy}>
              <span className="action-icon">
                <IconDocPlus size={20} />
              </span>
              <span className="action-label">新建小说</span>
              <span className="action-hint">从零开始创作</span>
            </button>
            <button className="action-card" onClick={() => setModal('import')} disabled={busy}>
              <span className="action-icon">
                <IconImport size={20} />
              </span>
              <span className="action-label">导入小说</span>
              <span className="action-hint">TXT / DOCX 智能分章</span>
            </button>
            <button className="action-card" onClick={openExisting} disabled={busy}>
              <span className="action-icon">
                <IconFolderPlus size={20} />
              </span>
              <span className="action-label">打开项目</span>
              <span className="action-hint">继续已有作品</span>
            </button>
          </div>

          <section className="recent-section">
            <h2>我的书架</h2>
            {recent.length === 0 ? (
              <p className="recent-empty">书架上还没有作品，从「新建小说」开始你的第一部作品吧。</p>
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
                        openingPath === p.path ? ' opening' : ''
                      }`}
                      disabled={busy || openingPath !== null}
                      onClick={() => void openWithAnim(p.path)}
                      title={p.path}
                    >
                      <span className="book-frame" aria-hidden="true" />
                      <span className="book-series">NOVELFORGE</span>
                      <span className="book-title">{p.name}</span>
                      <span className="book-divider" aria-hidden="true" />
                      <span className="book-meta">LOCAL EDITION</span>
                    </button>
                    <button
                      className="icon-btn book-remove"
                      title="从书架移除"
                      onClick={() => removeRecent(p.path)}
                    >
                      <IconTrash />
                    </button>
                    <span className="book-time">{p.lastOpenedAt}</span>
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>
      </div>

      {modal && <NewProjectModal mode={modal} onClose={() => setModal(null)} />}
    </div>
  );
}
