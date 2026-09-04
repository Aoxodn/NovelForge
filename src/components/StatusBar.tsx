/** 底部写作状态栏（阶段 6 增强版）：
 *  保存状态 | 今日码字（目标进度）| 速度 | 时长 | 空闲 | 本章/全书字数 | 预估稿费
 *  微反馈：保存中呼吸灯、保存完成绿色闪光、字数滚动动画 */
import { useAppStore } from '../store/appStore';
import { useEditorStore } from '../store/editorStore';
import { useCountUp } from '../hooks/useCountUp';
import { useWritingSession, fmtDuration } from '../hooks/useWritingSession';
import { fmt } from '../utils/text';

export function StatusBar() {
  const tree = useAppStore((s) => s.tree)!;
  const todayWords = useAppStore((s) => s.todayWords);
  const writerSettings = useAppStore((s) => s.writerSettings);
  const dirty = useEditorStore((s) => s.dirty);
  const saving = useEditorStore((s) => s.saving);
  const saveError = useEditorStore((s) => s.saveError);
  const lastSavedAt = useEditorStore((s) => s.lastSavedAt);
  const wordCount = useEditorStore((s) => s.wordCount);
  const chapterId = useEditorStore((s) => s.chapterId);

  const session = useWritingSession();
  const chapterWords = useCountUp(wordCount);
  const bookWords = useCountUp(tree.stats.totalWordCount);
  const animatedToday = useCountUp(todayWords);

  let stateText: string;
  let stateClass = '';
  if (saveError) {
    stateText = '保存失败，正在重试';
    stateClass = 'error';
  } else if (saving) {
    stateText = '保存中…';
    stateClass = 'saving';
  } else if (dirty) {
    stateText = '自动保存已启用';
  } else if (lastSavedAt) {
    stateText = `已保存 ${lastSavedAt}`;
    stateClass = 'saved';
  } else {
    stateText = '就绪';
  }

  const { dailyGoal, feePerK } = writerSettings;
  const goalPct = dailyGoal > 0 ? Math.min(100, (todayWords / dailyGoal) * 100) : 0;
  // 预估稿费 = 今日字数 × 单价 / 1000
  const fee = feePerK > 0 ? ((todayWords * feePerK) / 1000).toFixed(2) : null;

  return (
    <footer className="statusbar">
      <div className={`save-dot ${stateClass}`} />
      <span
        key={lastSavedAt ?? 'none'}
        className={`status-text${stateClass === 'saved' ? ' saved' : ''}`}
      >
        {stateText}
      </span>

      <div className="status-right">
        <span className="status-item" title="今日净增字数（保存后校准）">
          今日 <b className="status-num">{fmt(animatedToday)}</b>
          {dailyGoal > 0 && (
            <span className="status-goal" title={`日更目标 ${fmt(dailyGoal)} 字`}>
              <i className="status-goal-bar">
                <i style={{ width: `${goalPct}%` }} />
              </i>
              {Math.floor(goalPct)}%
            </span>
          )}
        </span>
        <span className="status-sep">|</span>
        <span className="status-item" title="本次会话：字数 / 速度 / 写作时长 / 空闲">
          速度 <b className="status-num">{fmt(session.speed)}</b> 字/时
        </span>
        <span className="status-sep">|</span>
        <span className="status-item">时长 {fmtDuration(session.activeSeconds)}</span>
        <span className="status-sep">|</span>
        <span className="status-item">空闲 {fmtDuration(session.idleSeconds)}</span>
        {chapterId !== null && (
          <>
            <span className="status-sep">|</span>
            <span className="status-item">本章 {fmt(chapterWords)} 字</span>
          </>
        )}
        <span className="status-sep">|</span>
        <span className="status-item">全书 {fmt(bookWords)} 字</span>
        {fee !== null && (
          <>
            <span className="status-sep">|</span>
            <span className="status-item status-fee" title={`稿费单价 ${feePerK} 元/千字`}>
              预估 ¥{fee}
            </span>
          </>
        )}
      </div>
    </footer>
  );
}
