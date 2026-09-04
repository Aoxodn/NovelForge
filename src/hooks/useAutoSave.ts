/**
 * 自动保存 Hook（文档第十五节策略）：
 *
 *   输入 → 500ms 防抖 → save(false)  异步 SQLite 写入
 *   每 5 分钟且有新修改 → save(true)  创建版本快照
 *
 * 挂载于编辑器组件；卸载时清空所有定时器。
 */
import { useEffect } from 'react';
import { useEditorStore } from '../store/editorStore';

/** 自动保存防抖间隔 */
const SAVE_DEBOUNCE_MS = 500;
/** 版本快照周期 */
const SNAPSHOT_INTERVAL_MS = 5 * 60 * 1000;

export function useAutoSave() {
  const dirty = useEditorStore((s) => s.dirty);
  const chapterId = useEditorStore((s) => s.chapterId);
  const content = useEditorStore((s) => s.content);

  // 1) 防抖保存：内容停止变化 500ms 后写库
  useEffect(() => {
    if (!dirty || chapterId === null) return;
    const timer = setTimeout(() => {
      void useEditorStore.getState().save(false);
    }, SAVE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [content, dirty, chapterId]);

  // 2) 周期快照：每 30 秒检查一次，距上次快照超过 5 分钟且期间有修改则建快照
  useEffect(() => {
    if (chapterId === null) return;
    const timer = setInterval(() => {
      const s = useEditorStore.getState();
      if (s.chapterId === null) return;
      const elapsed = Date.now() - s.lastSnapshotAt;
      if (elapsed >= SNAPSHOT_INTERVAL_MS && (s.dirty || s.saveError)) {
        void s.save(true);
      }
    }, 30_000);
    return () => clearInterval(timer);
  }, [chapterId]);
}
