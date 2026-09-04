/** 首页仪表盘：最近项目 + 新建 / 打开 / 导入（文档第五十二节） */
import { useEffect, useState } from 'react';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import * as api from '../api';
import { useAppStore } from '../store/appStore';
import type { RecentProject } from '../types/models';
import { NewProjectModal } from './NewProjectModal';
import { WindowControls } from './WindowControls';
import { IconDocPlus, IconFolderPlus, IconImport, IconTrash } from './icons';

export function Dashboard() {
  const openProject = useAppStore((s) => s.openProject);
  const [recent, setRecent] = useState<RecentProject[]>([]);
  const [modal, setModal] = useState<'blank' | 'import' | null>(null);
  const [busy, setBusy] = useState(false);

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
            <h2>最近项目</h2>
            {recent.length === 0 ? (
              <p className="recent-empty">还没有打开过的项目，从「新建小说」开始创作吧。</p>
            ) : (
              <ul className="recent-list">
                {recent.map((p) => (
                  <li key={p.path}>
                    <button
                      className="recent-item"
                      disabled={busy}
                      onClick={() => openProject(p.path)}
                      title={p.path}
                    >
                      <span className="recent-name">《{p.name}》</span>
                      <span className="recent-path">{p.path}</span>
                      <span className="recent-time">{p.lastOpenedAt}</span>
                    </button>
                    <button
                      className="icon-btn recent-remove"
                      title="从列表移除"
                      onClick={() => removeRecent(p.path)}
                    >
                      <IconTrash />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>

      {modal && <NewProjectModal mode={modal} onClose={() => setModal(null)} />}
    </div>
  );
}
