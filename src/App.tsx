/**
 * 应用根组件：仪表盘 / 项目视图 路由切换 + 主题挂载。
 */
import { useEffect } from 'react';
import { useAppStore } from './store/appStore';
import { Dashboard } from './components/Dashboard';
import { ProjectView } from './components/ProjectView';
import { Toast } from './components/Toast';

export default function App() {
  const tree = useAppStore((s) => s.tree);
  const theme = useAppStore((s) => s.theme);

  // 主题应用到根元素（CSS 变量切换，见 styles/global.css）
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  return (
    <div className="app">
      {tree ? <ProjectView /> : <Dashboard />}
      <Toast />
    </div>
  );
}
