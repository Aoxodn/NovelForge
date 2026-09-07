//! 全文搜索（文档第四十二节）：
//!
//! - 普通文本搜索 / 正则搜索
//! - 结果按章节组织：章节名 + 卷名 + 上下文片段（前端负责高亮）
//! - 每章最多返回 MATCHES_PER_CHAPTER 个匹配，全书上限 MAX_TOTAL_HITS
//! - 重计算在后台线程（100 万字全书扫描为毫秒级，但保持架构一致）
//!
//! 后续阶段扩展：标签 / 人物 / 地点搜索（阶段 5 数据表就绪后接入）。

use crate::commands::AppState;
use crate::error::{AppError, Result};
use crate::models::SearchHit;
use regex::Regex;
use tauri::State as TauriState;

/// 每章最多返回的匹配数
const MATCHES_PER_CHAPTER: usize = 20;
/// 全书命中章节上限
const MAX_TOTAL_HITS: usize = 300;
/// 片段上下文半径（字符数）
const SNIPPET_RADIUS: usize = 24;

#[tauri::command]
pub async fn search_project(
    state: TauriState<'_, AppState>,
    query: String,
    use_regex: bool,
) -> Result<Vec<SearchHit>> {
    let query = query.trim().to_string();
    if query.is_empty() {
        return Ok(vec![]);
    }

    // 预编译正则（错误提前返回给用户）
    let re = if use_regex {
        Some(
            Regex::new(&query)
                .map_err(|e| AppError::Msg(format!("无效的正则表达式：{e}")))?,
        )
    } else {
        None
    };

    // 逐章读取正文（同步完成后再进入后台线程，避免跨 await 持锁）
    let rows: Vec<(i64, String, String, String)> = state.with_project(|db| {
        let mut stmt = db.conn.prepare(
            "SELECT c.id, c.title, v.title, c.content
             FROM chapters c JOIN volumes v ON c.volume_id = v.id
             WHERE c.deleted_at IS NULL
             ORDER BY v.sort_order, c.sort_order, c.id",
        )?;
        let mut out = Vec::new();
        let mut rows = stmt.query([])?;
        while let Some(r) = rows.next()? {
            out.push((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?));
        }
        Ok(out)
    })?;

    // 扫描在后台线程执行，不阻塞 UI
    let hits = tauri::async_runtime::spawn_blocking(move || {
        scan_chapters(rows, &query, re.as_ref())
    })
    .await
    .map_err(|e| AppError::Msg(format!("搜索任务失败：{e}")))?;

    Ok(hits)
}

/// 对所有章节执行匹配，生成命中列表
fn scan_chapters(
    rows: Vec<(i64, String, String, String)>,
    query: &str,
    re: Option<&Regex>,
) -> Vec<SearchHit> {
    let mut hits = Vec::new();

    for (chapter_id, chapter_title, volume_title, content) in rows {
        if hits.len() >= MAX_TOTAL_HITS {
            break;
        }

        // 收集本章所有匹配的字节区间 (start, len)
        let mut matches: Vec<(usize, usize)> = Vec::new();
        if let Some(re) = re {
            for m in re.find_iter(&content) {
                if m.start() != m.end() {
                    matches.push((m.start(), m.end() - m.start()));
                }
                if matches.len() >= MATCHES_PER_CHAPTER {
                    break;
                }
            }
        } else {
            let mut from = 0;
            while let Some(pos) = content[from..].find(query) {
                matches.push((from + pos, query.len()));
                from += pos + query.len();
                if matches.len() >= MATCHES_PER_CHAPTER {
                    break;
                }
            }
        }

        if matches.is_empty() {
            continue;
        }

        // 取第一个匹配生成三段式上下文（前文 / 匹配词 / 后文），
        // 前端直接拼接渲染，避免跨语言的字节/码元偏移换算
        let (first_start, first_len) = matches[0];
        let (before, matched, after) = make_snippet(&content, first_start, first_start + first_len);

        // 附加匹配数（超过上限时标记为 N+）
        let shown = matches.len();
        let match_count = if shown >= MATCHES_PER_CHAPTER {
            format!("{shown}+")
        } else {
            shown.to_string()
        };

        hits.push(SearchHit {
            chapter_id,
            chapter_title,
            volume_title,
            snippet_before: before,
            snippet_match: matched,
            snippet_after: after,
            match_count,
        });
    }

    hits
}

/// 生成匹配处三段式上下文 (前文, 匹配词, 后文)。
/// 前后各带 SNIPPET_RADIUS 个字符，越界时补省略号；
/// 换行替换为空格（1:1 字节替换不影响其余两段的内容正确性）。
fn make_snippet(content: &str, start: usize, end: usize) -> (String, String, String) {
    // 向前回退 SNIPPET_RADIUS 个字符（对齐 UTF-8 字符边界）
    let mut cut_start = start;
    let mut chars_back = 0;
    while cut_start > 0 && chars_back < SNIPPET_RADIUS {
        cut_start -= 1;
        while cut_start > 0 && !content.is_char_boundary(cut_start) {
            cut_start -= 1;
        }
        chars_back += 1;
    }

    // 向后推进 SNIPPET_RADIUS 个字符
    let mut cut_end = end;
    let mut chars_fwd = 0;
    while cut_end < content.len() && chars_fwd < SNIPPET_RADIUS {
        cut_end += 1;
        while cut_end < content.len() && !content.is_char_boundary(cut_end) {
            cut_end += 1;
        }
        chars_fwd += 1;
    }

    let before = format!(
        "{}{}",
        if cut_start > 0 { "…" } else { "" },
        content[cut_start..start].replace(['\n', '\r'], " ")
    );
    let matched = content[start..end].to_string();
    let after = format!(
        "{}{}",
        content[end..cut_end].replace(['\n', '\r'], " "),
        if cut_end < content.len() { "…" } else { "" }
    );
    (before, matched, after)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rows() -> Vec<(i64, String, String, String)> {
        vec![
            (
                1,
                "第一章".into(),
                "第一卷".into(),
                "林默把玉佩收进怀里。\n他对玉佩十分珍视。\n第二天，玉佩不见了。".into(),
            ),
            (
                2,
                "第二章".into(),
                "第一卷".into(),
                "苏婉问：“你见过我的剑吗？”\n林默摇头。".into(),
            ),
        ]
    }

    #[test]
    fn plain_search_finds_chapters() {
        let hits = scan_chapters(rows(), "玉佩", None);
        assert_eq!(hits.len(), 1); // 只有第一章含「玉佩」
        assert_eq!(hits[0].chapter_id, 1);
        assert_eq!(hits[0].match_count, "3");
        // 三段拼接应还原上下文，匹配词本体即搜索词
        assert_eq!(hits[0].snippet_match, "玉佩");
        let joined = format!(
            "{}{}{}",
            hits[0].snippet_before, hits[0].snippet_match, hits[0].snippet_after
        );
        assert!(joined.contains("林默把玉佩收进"));
        // 换行被替换为空格
        assert!(!joined.contains('\n'));
    }

    #[test]
    fn regex_search() {
        let re = Regex::new("林[默某]").unwrap();
        let hits = scan_chapters(rows(), "林[默某]", Some(&re));
        assert_eq!(hits.len(), 2); // 两章都有「林默」
        assert_eq!(hits[0].snippet_match, "林默");
    }

    #[test]
    fn no_match_returns_empty() {
        assert!(scan_chapters(rows(), "不存在的词", None).is_empty());
    }

    #[test]
    fn snippet_respects_char_boundaries() {
        // 100 个汉字（300 字节），取第 50 字符处的匹配：
        // 前后均超过半径 → 两端都应有省略号，且不 panic
        let long = "一二三四五六七八九十".repeat(10);
        let (before, m, after) = make_snippet(&long, 150, 153);
        assert!(before.starts_with('…'));
        assert!(after.ends_with('…'));
        assert_eq!(m, "一"); // 字节 150 = 第 51 个字符（0 起第 50），50 mod 10 = 0 → 「一」
        // 前文长度 = 半径 24 字符
        assert_eq!(before.chars().count() - 1, 24);
        assert_eq!(after.chars().count() - 1, 24);
    }
}
