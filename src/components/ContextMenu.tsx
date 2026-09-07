/**
 * 全局右键菜单（单例 Portal 实现）。
 * 用法：ContextMenu.open(x, y, [{ label, onClick, danger, icon }, ...])
 */
import type { ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useEffect, useState } from 'react';

export interface MenuItem {
  label: string;
  onClick?: () => void;
  danger?: boolean;
  separator?: boolean;
  disabled?: boolean;
  /** 可选图标（显示在文字左侧） */
  icon?: ReactNode;
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;
let openState: { x: number; y: number; items: MenuItem[] } | null = null;
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((l) => l());
}

const Menu = () => {
  const [state, setState] = useState(openState);
  useEffect(() => {
    const l = () => setState(openState);
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, []);

  useEffect(() => {
    if (!state) return;
    // 点击菜单项本身不关闭：否则 mousedown 先移除 DOM，click 无法派发到菜单项
    const close = (e: Event) => {
      if (e.target instanceof Element && e.target.closest('.context-menu')) return;
      ContextMenu.close();
    };
    window.addEventListener('mousedown', close);
    window.addEventListener('blur', close);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('blur', close);
      window.removeEventListener('resize', close);
    };
  }, [state]);

  if (!state) return null;

  return (
    <div
      className="context-menu"
      style={{
        left: Math.min(state.x, window.innerWidth - 180),
        top: Math.min(state.y, window.innerHeight - state.items.length * 30 - 16),
      }}
    >
      {state.items.map((item, i) =>
        item.separator ? (
          <div key={i} className="menu-separator" />
        ) : (
          <button
            key={i}
            className={`menu-item${item.danger ? ' danger' : ''}${item.icon ? ' has-icon' : ''}`}
            disabled={item.disabled}
            onClick={() => {
              ContextMenu.close();
              item.onClick?.();
            }}
          >
            {item.icon && <span className="menu-item-icon">{item.icon}</span>}
            {item.label}
          </button>
        ),
      )}
    </div>
  );
};

export const ContextMenu = {
  open(x: number, y: number, items: MenuItem[]) {
    if (!container) {
      container = document.createElement('div');
      container.id = 'context-menu-root';
      document.body.appendChild(container);
      root = createRoot(container);
      root.render(<Menu />);
    }
    openState = { x, y, items };
    emit();
  },
  close() {
    openState = null;
    emit();
  },
};
