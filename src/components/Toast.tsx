/** 全局提示 Toast */
import { useAppStore } from '../store/appStore';

export function Toast() {
  const toast = useAppStore((s) => s.toast);
  if (!toast) return null;
  return <div className={`toast ${toast.kind}`}>{toast.text}</div>;
}
