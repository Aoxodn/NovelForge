import { useState } from 'react';

/**
 * 画布常驻面包屑（审查 UX-2）：让作者始终知道自己处于
 * 「全书图谱 > 某卷 > 章节图」的哪一层，点击可回退。
 */
export function CanvasBreadcrumb({ items }: { items: { label: string; onBack?: () => void }[] }) {
  return (
    <div className="canvas-breadcrumb">
      {items.map((it, i) => {
        const last = i === items.length - 1;
        return (
          <span key={i} className="cb-item">
            {i > 0 && <span className="cb-sep">›</span>}
            {it.onBack && !last ? (
              <button className="cb-link" onClick={it.onBack} title="返回上一层">
                {it.label}
              </button>
            ) : (
              <span className={last ? 'cb-current' : 'cb-link-static'}>{it.label}</span>
            )}
          </span>
        );
      })}
    </div>
  );
}

interface Shortcut {
  keys: string;
  desc: string;
}

/**
 * 画布快捷键 / 操作帮助（审查 UX-2）：单击、双击、拖动、拉线、右键等
 * 手势此前只在「没有边」时提示，现常驻可查，降低新用户学习成本。
 */
export function ShortcutHelp({ shortcuts, title = '画布操作' }: { shortcuts: Shortcut[]; title?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="canvas-help">
      <button
        className={`btn btn-mini${open ? ' active' : ''}`}
        data-tip="操作帮助"
        onClick={() => setOpen((v) => !v)}
      >
        ? 帮助
      </button>
      {open && (
        <div className="canvas-help-panel" role="dialog" aria-label={title}>
          <div className="canvas-help-title">{title}</div>
          <ul>
            {shortcuts.map((s, i) => (
              <li key={i}>
                <kbd>{s.keys}</kbd>
                <span>{s.desc}</span>
              </li>
            ))}
          </ul>
          <button className="btn btn-mini canvas-help-close" onClick={() => setOpen(false)}>
            知道了
          </button>
        </div>
      )}
    </div>
  );
}

/** L1 全书卷图的操作说明 */
export const STORYMAP_SHORTCUTS: Shortcut[] = [
  { keys: '拖空白', desc: '平移画布' },
  { keys: '滚轮', desc: '以光标为中心缩放' },
  { keys: '拖卷节点', desc: '移动卷的位置' },
  { keys: '双击卷', desc: '进入该卷的章节发展图' },
  { keys: '拖节点圆点', desc: '拉出关系连线（因果/分支/伏笔等）' },
  { keys: '拖连线', desc: '调整连线弧度' },
  { keys: '右键', desc: '节点 / 画布上下文菜单' },
  { keys: 'Delete', desc: '删除选中的卷' },
  { keys: '双击空白', desc: '适应视图' },
];

/** L2 卷内章节图的操作说明 */
export const VOLUME_SHORTCUTS: Shortcut[] = [
  { keys: '拖空白', desc: '平移画布' },
  { keys: '滚轮', desc: '以光标为中心缩放' },
  { keys: '拖章节卡', desc: '移动章节（松手落库）' },
  { keys: '拖小节', desc: '整组章节一起移动（单事务保存）' },
  { keys: '双击章节', desc: '打开本章细纲 / 正文' },
  { keys: '拖节点圆点', desc: '拉出章间关系 / 伏笔' },
  { keys: '拖连线', desc: '调整连线弧度' },
  { keys: '右键', desc: '节点 / 画布上下文菜单' },
  { keys: 'Esc', desc: '逐层退出（人物视角→选中→返回）' },
];
