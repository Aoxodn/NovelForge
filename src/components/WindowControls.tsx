/** 无边框窗口控制按钮：最小化 / 最大化还原 / 关闭（右上角，Windows 风格） */
import { useEffect, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { IconClose, IconMaximize, IconMinimize, IconRestore } from './icons';

export function WindowControls() {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    const win = getCurrentWindow();
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

  return (
    <div className="win-controls">
      <button
        className="win-btn"
        title="最小化"
        onClick={() => void getCurrentWindow().minimize()}
      >
        <IconMinimize />
      </button>
      <button
        className="win-btn"
        title={maximized ? '还原' : '最大化'}
        onClick={() => void getCurrentWindow().toggleMaximize()}
      >
        {maximized ? <IconRestore /> : <IconMaximize />}
      </button>
      <button
        className="win-btn win-close"
        title="关闭"
        onClick={() => void getCurrentWindow().close()}
      >
        <IconClose />
      </button>
    </div>
  );
}
