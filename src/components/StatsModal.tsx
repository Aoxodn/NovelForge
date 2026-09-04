/**
 * 码字统计仪表盘（阶段 6）：今日 / 连续天数 / 最佳日 + 近 60 天柱状图。
 * 全部为 writing_daily 表的确定性聚合，数据随保存实时累积。
 */
import { useEffect, useMemo, useState } from 'react';
import * as api from '../api';
import { useAppStore } from '../store/appStore';
import { Modal } from './Modal';
import { fmt } from '../utils/text';
import type { WritingStats } from '../types/models';

/** 近 N 天柱状图：无记录的日子补零 */
function DailyChart({ stats }: { stats: WritingStats }) {
  const days = useMemo(() => {
    const map = new Map(stats.daily.map((d) => [d.date, d.words]));
    const out: { date: string; words: number; label: string }[] = [];
    const today = new Date();
    for (let i = 59; i >= 0; i--) {
      const d = new Date(today.getTime() - i * 86400_000);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      out.push({
        date: key,
        words: map.get(key) ?? 0,
        label: `${d.getMonth() + 1}/${d.getDate()}`,
      });
    }
    return out;
  }, [stats.daily]);

  const max = Math.max(1, ...days.map((d) => d.words));

  return (
    <div className="daily-chart">
      {days.map((d) => (
        <div
          key={d.date}
          className={`daily-col${d.words > 0 ? ' active' : ''}`}
          title={`${d.date}：${fmt(d.words)} 字`}
        >
          <i style={{ height: `${Math.max(2, (d.words / max) * 100)}%` }} />
        </div>
      ))}
    </div>
  );
}

export function StatsModal({ onClose }: { onClose: () => void }) {
  const showToast = useAppStore((s) => s.showToast);
  const writerSettings = useAppStore((s) => s.writerSettings);
  const [stats, setStats] = useState<WritingStats | null>(null);

  useEffect(() => {
    void api.getWritingStats().then(setStats).catch((e) => showToast(String(e), 'error'));
  }, [showToast]);

  const fee =
    stats && writerSettings.feePerK > 0
      ? ((stats.todayWords * writerSettings.feePerK) / 1000).toFixed(2)
      : null;

  return (
    <Modal title="码字统计" onClose={onClose} width={680}>
      {!stats ? (
        <p className="info-empty">加载中…</p>
      ) : (
        <>
          <div className="stats-grid">
            <div className="stat-card">
              <span className="stat-num">{fmt(stats.todayWords)}</span>
              <span className="stat-label">
                今日码字{writerSettings.dailyGoal > 0 && ` / 目标 ${fmt(writerSettings.dailyGoal)}`}
              </span>
            </div>
            <div className="stat-card">
              <span className="stat-num">{stats.streak}</span>
              <span className="stat-label">连续天数</span>
            </div>
            <div className="stat-card">
              <span className="stat-num">{stats.activeDays}</span>
              <span className="stat-label">累计写作天数</span>
            </div>
            <div className="stat-card">
              <span className="stat-num">{fmt(stats.bestDayWords)}</span>
              <span className="stat-label">
                最佳单日{stats.bestDay && `（${stats.bestDay}）`}
              </span>
            </div>
          </div>

          <h4 className="stats-section-title">近 60 天</h4>
          <DailyChart stats={stats} />

          <div className="stats-foot">
            <span>全书 {fmt(stats.totalWords)} 字 · {stats.chapterCount} 章</span>
            {fee !== null && <span>今日预估稿费 ¥{fee}</span>}
          </div>
        </>
      )}
    </Modal>
  );
}
