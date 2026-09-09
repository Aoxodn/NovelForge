/** 无边框窗口控制按钮：最小化 / 最大化还原 / 关闭（右上角，Windows 风格）。
 *  仅 Windows 使用自定义无边框标题栏；macOS / Linux 走原生标题栏，直接不渲染（审查跨平台项）。 */
import { useEffect, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { IconClose, IconMaximize, IconMinimize, IconRestore } from './icons';

function isWindows(): boolean {
  if (typeof navigator === 'undefined') return true;
  const p = (navigator.platform || '').toLowerCase();
  const ua = (navigator.userAgent || '').toLowerCase();
  return p.includes('win') || ua.includes('windows');
}

export function WindowControls() {
  const [maximized, setMaximized] = useState(false);
  const [windows] = useState(isWindows);

  useEffect(() => {
    if (!windows) return;
    // 非 Tauri 环境（如浏览器直接预览）下窗口 API 不可用，跳过即可
    let win: ReturnType<typeof getCurrentWindow>;
    try {
      win = getCurrentWindow();
    } catch {
      return;
    }
    void win.isMaximized().then(setMaximized).catch(() => undefined);
    let unlisten: (() => void) | null = null;
    void win
      .onResized(() => {
        void win.isMaximized().then(setMaximized).catch(() => undefined);
      })
      .then((fn) => {
        unlisten = fn;
      });
    return () => unlisten?.();
  }, []);

  if (!windows) return null;

  return (
    <div className="win-controls">
      <button
        className="win-btn"
        data-tip="最小化"
        aria-label="最小化"
        onClick={() => void getCurrentWindow().minimize()}
      >
        <IconMinimize />
      </button>
      <button
        className="win-btn"
        data-tip={maximized ? '还原' : '最大化'}
        aria-label={maximized ? '还原' : '最大化'}
        onClick={() => void getCurrentWindow().toggleMaximize()}
      >
        {maximized ? <IconRestore /> : <IconMaximize />}
      </button>
      <button
        className="win-btn win-close"
        data-tip="关闭"
        aria-label="关闭"
        onClick={() => void getCurrentWindow().close()}
      >
        <IconClose />
      </button>
    </div>
  );
}
