//! 码字统计命令（阶段 6）：仪表盘数据源。
//!
//! 数据来自 `writing_daily` 表（save_chapter 时按自然日累加净增字数）。
//! 全部为确定性聚合计算，无识别逻辑。

use crate::commands::AppState;
use crate::error::Result;
use crate::models::{DailyWords, WritingStats};
use tauri::State;

// ---------- 日期工具（无 chrono 依赖，民用历法换算） ----------

/// 公元纪日 → 连续天数（Howard Hinnant 算法，1970-01-01 为 0）
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400; // [0, 399]
    let mp = (m + 9) % 12; // [0, 11]，3 月为 0
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe - 719468
}

/// 解析 "YYYY-MM-DD" 为连续天数；非法格式返回 None
fn parse_date(s: &str) -> Option<i64> {
    let mut parts = s.split('-');
    let y: i64 = parts.next()?.parse().ok()?;
    let m: i64 = parts.next()?.parse().ok()?;
    let d: i64 = parts.next()?.parse().ok()?;
    if parts.next().is_some() || !(1..=12).contains(&m) || !(1..=31).contains(&d) {
        return None;
    }
    Some(days_from_civil(y, m, d))
}

/// 连续写作天数：有记录（words > 0）的日期序列中，
/// 从今天（或今天无记录时从昨天）起向前连续不断的天数。
fn compute_streak(days: &std::collections::HashSet<i64>, today: i64) -> i64 {
    if days.is_empty() {
        return 0;
    }
    // 今天没写不算断更：从昨天起算
    let mut cursor = if days.contains(&today) { today } else { today - 1 };
    let mut streak = 0;
    while days.contains(&cursor) {
        streak += 1;
        cursor -= 1;
    }
    streak
}

/// 码字统计仪表盘数据
#[tauri::command]
pub fn get_writing_stats(state: State<'_, AppState>) -> Result<WritingStats> {
    state.with_project(|db| {
        let today: String =
            db.conn
                .query_row("SELECT date('now','localtime')", [], |r| r.get(0))?;

        // 有记录的日子（正增长才计活跃）
        let rows: Vec<(String, i64)> = {
            let mut stmt = db.conn.prepare(
                "SELECT date, words FROM writing_daily WHERE words > 0 ORDER BY date DESC",
            )?;
            let rows = stmt
                .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))?
                .collect::<std::result::Result<Vec<_>, _>>()?;
            rows
        };

        // 标量子查询：当天无记录也返回一行 0，避免 query_row 报 QueryReturnedNoRows
        let today_words: i64 = db.conn.query_row(
            "SELECT COALESCE((SELECT words FROM writing_daily WHERE date = date('now','localtime')), 0)",
            [],
            |r| r.get(0),
        )?;

        let day_set: std::collections::HashSet<i64> =
            rows.iter().filter_map(|(d, _)| parse_date(d)).collect();
        let today_num = parse_date(&today).unwrap_or(0);
        let streak = compute_streak(&day_set, today_num);

        let active_days = rows.len() as i64;
        let (best_day, best_day_words) = rows
            .iter()
            .max_by_key(|(_, w)| *w)
            .map(|(d, w)| (Some(d.clone()), *w))
            .unwrap_or((None, 0));

        // 近 60 天记录（升序，前端补零绘图）
        let daily: Vec<DailyWords> = rows
            .iter()
            .filter(|(d, _)| {
                parse_date(d)
                    .map(|n| today_num - n < 60)
                    .unwrap_or(false)
            })
            .map(|(d, w)| DailyWords {
                date: d.clone(),
                words: *w,
            })
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect();

        let (total_words, chapter_count): (i64, i64) = db.conn.query_row(
            "SELECT COALESCE(SUM(word_count), 0), COUNT(*) FROM chapters WHERE deleted_at IS NULL",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;

        Ok(WritingStats {
            today_words,
            streak,
            active_days,
            best_day_words,
            best_day,
            daily,
            total_words,
            chapter_count,
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn set(days: &[i64]) -> std::collections::HashSet<i64> {
        days.iter().copied().collect()
    }

    #[test]
    fn civil_date_anchor() {
        // 1970-01-01 = 0；2026-09-04 对应固定值（与已知算法对照）
        assert_eq!(days_from_civil(1970, 1, 1), 0);
        assert_eq!(parse_date("2026-09-04"), Some(days_from_civil(2026, 9, 4)));
        // 相邻日期差 1
        assert_eq!(
            days_from_civil(2026, 9, 5) - days_from_civil(2026, 9, 4),
            1
        );
        // 跨月：2/28 → 3/1（2026 非闰年）
        assert_eq!(
            days_from_civil(2026, 3, 1) - days_from_civil(2026, 2, 28),
            1
        );
        // 跨闰日：2024-02-28 → 2024-02-29
        assert_eq!(
            days_from_civil(2024, 2, 29) - days_from_civil(2024, 2, 28),
            1
        );
    }

    #[test]
    fn parse_rejects_bad_format() {
        assert_eq!(parse_date("2026-13-01"), None);
        assert_eq!(parse_date("not-a-date"), None);
        assert_eq!(parse_date("2026-09"), None);
    }

    #[test]
    fn streak_counts_consecutive_days() {
        let today = days_from_civil(2026, 9, 4);
        // 今天 + 昨天 + 前天 = 3
        assert_eq!(compute_streak(&set(&[today, today - 1, today - 2]), today), 3);
        // 今天还没写：从昨天起算 = 2
        assert_eq!(compute_streak(&set(&[today - 1, today - 2]), today), 2);
        // 昨天断更：0
        assert_eq!(compute_streak(&set(&[today - 2]), today), 0);
        // 空记录：0
        assert_eq!(compute_streak(&set(&[]), today), 0);
        // 中间断档：只算最近连续段
        assert_eq!(
            compute_streak(&set(&[today, today - 1, today - 3, today - 4]), today),
            2
        );
    }
}
