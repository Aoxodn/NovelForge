import type { CharacterHeat } from '../../types/models';

/** 断档预警阈值：超过 N 章未出场才提示 */
const ABSENT_WARN_THRESHOLD = 10;

/** 热度走势：纯 SVG 柱状图，零依赖 */
export function HeatBars({ heat }: { heat: CharacterHeat }) {
  const data = heat.perChapter;
  const max = Math.max(1, ...data);
  const W = 560;
  const H = 56;
  const bw = Math.max(1, W / Math.max(1, data.length));
  return (
    <div className="heat-wrap">
      <svg
        className="heat-chart"
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        role="img"
        aria-label="出场热度走势"
      >
        {data.map((n, i) => (
          <rect
            key={i}
            x={i * bw}
            y={H - (n / max) * (H - 4)}
            width={Math.max(0.5, bw - 0.6)}
            height={n === 0 ? 1 : (n / max) * (H - 4)}
            className={n === 0 ? 'heat-bar heat-bar-zero' : 'heat-bar'}
          >
            <title>{`第 ${i + 1} 章：${n} 次`}</title>
          </rect>
        ))}
      </svg>
      <div className="heat-meta">
        <span>共 {data.length} 章</span>
        {heat.absentStreak >= ABSENT_WARN_THRESHOLD && (
          <span className="badge-warn">断档 {heat.absentStreak} 章</span>
        )}
        {heat.absentStreak > 0 && heat.absentStreak < ABSENT_WARN_THRESHOLD && (
          <span className="heat-sub">近 {heat.absentStreak} 章未出场</span>
        )}
      </div>
    </div>
  );
}
