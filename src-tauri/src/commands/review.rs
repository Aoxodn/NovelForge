//! 写作辅助工具集（审查新增功能）：
//!   1. 全书安全重命名——逐章替换预览、可排除引号内文本、单事务应用并自动快照；
//!   2. 连续性检查器——死者再现 / 伏笔逾期 / 长期断档的确定性规则 + 用户确认队列；
//!   3. 修订工作台——跨章查找替换、长句 / 重复词静态检查。
//!
//! 全部规则只依赖本地数据库，不调用云端 AI。

use crate::commands::cards::{chapter_order, load_char_entities, rebuild_all_mentions};
use crate::commands::AppState;
use crate::error::{AppError, Result};
use crate::mention_index::MentionMatcher;
use crate::text::count_text;
use rusqlite::params;
use serde::Serialize;
use tauri::State;

/// 逐章命中（重命名预览 / 跨章替换共用）
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChapterHit {
    pub chapter_id: i64,
    pub chapter_title: String,
    pub count: i64,
    /// 上下文片段（纯文本，前端可自行高亮命中词）
    pub snippets: Vec<String>,
}

// ---------- 引号区间 ----------

const QUOTE_PAIRS: &[(char, char)] = &[
    ('“', '”'),
    ('‘', '’'),
    ('「', '」'),
    ('『', '』'),
    ('"', '"'),
    ('\'', '\''),
];

/// 返回正文里「引号内」的字节区间集合，用于「排除对白中的命中」。
fn quoted_ranges(content: &str) -> Vec<(usize, usize)> {
    let mut ranges = Vec::new();
    for (open, close) in QUOTE_PAIRS {
        let mut start: Option<usize> = None;
        let mut byte = 0usize;
        for ch in content.chars() {
            let next = byte + ch.len_utf8();
            if ch == *open && start.is_none() {
                start = Some(byte);
            } else if ch == *close {
                if let Some(s) = start.take() {
                    ranges.push((s, next));
                }
            }
            byte = next;
        }
    }
    ranges
}

fn in_any(ranges: &[(usize, usize)], s: usize, e: usize) -> bool {
    ranges.iter().any(|(a, b)| s >= *a && e <= *b)
}

/// 以字符为单位安全截取命中点前后上下文
fn snippet_around(content: &str, mid_s: usize, mid_e: usize, radius: usize) -> String {
    let mut starts: Vec<usize> = content.char_indices().map(|(i, _)| i).collect();
    starts.push(content.len());
    let pos = |byte: usize| starts.binary_search(&byte).unwrap_or_else(|i| i.min(starts.len() - 1));
    let ci = pos(mid_s);
    let a = starts[ci.saturating_sub(radius)];
    let end_pos = pos(mid_e);
    let b = starts[(end_pos + radius).min(starts.len() - 1)];
    content[a..b].replace('\n', " ").trim().to_string()
}

/// 读取章节 (id,title,content)，按全书顺序，可选限定 id 集合、排除软删
fn load_chapters(
    conn: &rusqlite::Connection,
    only: Option<&[i64]>,
) -> Result<Vec<(i64, String, String)>> {
    let order = chapter_order(conn)?;
    let mut out = Vec::new();
    for id in order {
        if let Some(list) = only {
            if !list.contains(&id) {
                continue;
            }
        }
        let row = conn.query_row(
            "SELECT id, title, content FROM chapters WHERE id = ?1",
            params![id],
            |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?)),
        );
        if let Ok(triple) = row {
            out.push(triple);
        }
    }
    Ok(out)
}

// ---------- 全书安全重命名 ----------

/// 预览某角色在全书各章的出现（命中区间唯一归属该角色，天然排除复合长名双计数）
#[tauri::command]
pub fn preview_rename_character(
    state: State<'_, AppState>,
    character_id: i64,
    exclude_quotes: bool,
    chapter_ids: Option<Vec<i64>>,
) -> Result<Vec<ChapterHit>> {
    state.with_project(|db| {
        let entities = load_char_entities(&db.conn)?;
        let matcher = MentionMatcher::build(&entities);
        let mut hits = Vec::new();
        for (id, title, content) in load_chapters(&db.conn, chapter_ids.as_deref())? {
            let qr = if exclude_quotes {
                quoted_ranges(&content)
            } else {
                Vec::new()
            };
            let spans = matcher
                .spans(&content)
                .into_iter()
                .filter(|(s, e, owner)| *owner == character_id && !in_any(&qr, *s, *e))
                .collect::<Vec<_>>();
            if spans.is_empty() {
                continue;
            }
            let snippets = spans
                .iter()
                .take(3)
                .map(|(s, e, _)| snippet_around(&content, *s, *e, 10))
                .collect();
            hits.push(ChapterHit {
                chapter_id: id,
                chapter_title: title,
                count: spans.len() as i64,
                snippets,
            });
        }
        Ok(hits)
    })
}

/// 应用全书改名：把该角色的全部命中间隔替换为新名，旧名并入别名，单事务 + 自动快照。
/// 返回替换总次数。
#[tauri::command]
pub fn apply_rename_character(
    state: State<'_, AppState>,
    character_id: i64,
    new_name: String,
    exclude_quotes: bool,
    chapter_ids: Option<Vec<i64>>,
) -> Result<i64> {
    let new_name = new_name.trim().to_string();
    if new_name.is_empty() {
        return Err(AppError::Msg("新名字不能为空".into()));
    }
    state.with_project(|db| {
        let (old_name, aliases_json): (String, String) = db
            .conn
            .query_row(
                "SELECT name, aliases FROM characters WHERE id = ?1",
                params![character_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .map_err(|_| AppError::Msg("人物不存在".into()))?;
        if old_name == new_name {
            return Err(AppError::Msg("新名字与原名相同".into()));
        }

        let entities = load_char_entities(&db.conn)?;
        let matcher = MentionMatcher::build(&entities);
        let tx = db.conn.unchecked_transaction()?;
        let mut total = 0i64;

        for (id, title, content) in load_chapters(&tx, chapter_ids.as_deref())? {
            let qr = if exclude_quotes {
                quoted_ranges(&content)
            } else {
                Vec::new()
            };
            let mut spans = matcher
                .spans(&content)
                .into_iter()
                .filter(|(s, e, owner)| *owner == character_id && !in_any(&qr, *s, *e))
                .collect::<Vec<_>>();
            if spans.is_empty() {
                continue;
            }
            // 从后往前替换以保持字节索引有效
            spans.sort_by_key(|(s, _, _)| std::cmp::Reverse(*s));
            // 替换前快照（手动版本，可回退）
            tx.execute(
                "INSERT INTO chapter_versions (chapter_id, title, content, word_count, version_type)
                 VALUES (?1, ?2, ?3, ?4, 1)",
                params![id, title, content, count_text(&content).words],
            )?;
            let mut new_content = content.clone();
            for (s, e, _) in spans {
                new_content.replace_range(s..e, &new_name);
                total += 1;
            }
            let stats = count_text(&new_content);
            tx.execute(
                "UPDATE chapters SET content = ?1, word_count = ?2, char_count = ?3, content_hash = '',
                    updated_at = datetime('now','localtime') WHERE id = ?4",
                params![new_content, stats.words, stats.chars, id],
            )?;
        }

        // 旧名并入别名（若尚未存在），保证改名后仍能识别旧称谓
        let mut aliases: Vec<String> =
            serde_json::from_str(&aliases_json).unwrap_or_default();
        if !aliases.iter().any(|a| a == &old_name) {
            aliases.insert(0, old_name.clone());
        }
        let aliases_json = serde_json::to_string(&aliases).unwrap_or_else(|_| "[]".into());
        tx.execute(
            "UPDATE characters SET name = ?1, aliases = ?2, updated_at = datetime('now','localtime') WHERE id = ?3",
            params![new_name, aliases_json, character_id],
        )?;
        tx.commit()?;

        crate::mention_index::invalidate_cache();
        rebuild_all_mentions(&db.conn, None)?;
        Ok(total)
    })
}

// ---------- 连续性检查器 ----------

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContinuityIssue {
    pub id: i64,
    pub kind: String,
    pub fingerprint: String,
    pub title: String,
    pub detail: String,
    pub chapter_id: Option<i64>,
    pub ref_id: Option<i64>,
    pub status: i64,
}

fn issue_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<ContinuityIssue> {
    Ok(ContinuityIssue {
        id: r.get(0)?,
        kind: r.get(1)?,
        fingerprint: r.get(2)?,
        title: r.get(3)?,
        detail: r.get(4)?,
        chapter_id: r.get(5)?,
        ref_id: r.get(6)?,
        status: r.get(7)?,
    })
}

/// 扫描确定性连续性问题并入库（同指纹去重），返回待处理列表。
#[tauri::command]
pub fn scan_continuity(
    state: State<'_, AppState>,
    long_absence: Option<i64>,
    foreshadow_overdue: Option<i64>,
) -> Result<Vec<ContinuityIssue>> {
    let absence = long_absence.unwrap_or(10).max(1);
    let overdue = foreshadow_overdue.unwrap_or(15).max(1);
    state.with_project(|db| scan_continuity_conn(&db.conn, absence, overdue))
}

/// 连续性扫描的连接级实现（与 Tauri State 解耦，便于单测）
fn scan_continuity_conn(
    db: &rusqlite::Connection,
    absence: i64,
    overdue: i64,
) -> Result<Vec<ContinuityIssue>> {
        let order = chapter_order(db)?;
        let position = |cid: i64| order.iter().position(|x| *x == cid);
        let latest = order.len().saturating_sub(1) as i64;

        // ① 死者再现：alive=0 的角色在非删章节仍被提及
        {
            let mut stmt = db.prepare(
                "SELECT ch.id, ch.name, c.id, c.title
                 FROM characters ch
                 JOIN character_mentions m ON m.character_id = ch.id
                 JOIN chapters c ON c.id = m.chapter_id AND c.deleted_at IS NULL
                 WHERE ch.alive = 0 ORDER BY c.id",
            )?;
            let rows = stmt
                .query_map([], |r| {
                    Ok((
                        r.get::<_, i64>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, i64>(2)?,
                        r.get::<_, String>(3)?,
                    ))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            for (cid, name, chid, title) in rows {
                let fp = format!("dead:{cid}:{chid}");
                db.execute(
                    "INSERT OR IGNORE INTO continuity_issues
                        (kind, fingerprint, title, detail, chapter_id, ref_id)
                     VALUES ('dead_reappear', ?1, ?2, ?3, ?4, ?5)",
                    params![
                        fp,
                        format!("「{name}」已标记死亡却再次出现"),
                        format!("在《{title}》中检测到对已死亡角色「{name}」的提及，请确认是回忆 / 闪回还是设定矛盾。"),
                        chid,
                        cid
                    ],
                )?;
            }
        }

        // ② 伏笔逾期：活跃伏笔埋设后超过阈值仍未回收
        {
            let mut stmt = db.prepare(
                "SELECT id, label, from_chapter_id FROM story_edges
                 WHERE edge_type = 4 AND status = 0 AND from_chapter_id IS NOT NULL",
            )?;
            let rows = stmt
                .query_map([], |r| {
                    Ok((
                        r.get::<_, i64>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, i64>(2)?,
                    ))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            for (eid, label, from_ch) in rows {
                let Some(p) = position(from_ch) else { continue };
                let gap = latest - p as i64;
                if gap >= overdue {
                    let fp = format!("foreshadow:{eid}");
                    db.execute(
                        "INSERT OR IGNORE INTO continuity_issues
                            (kind, fingerprint, title, detail, chapter_id, ref_id)
                         VALUES ('foreshadow_overdue', ?1, ?2, ?3, ?4, ?5)",
                        params![
                            fp,
                            format!("伏笔已埋设 {gap} 章仍未回收"),
                            format!("伏笔「{}」距今 {} 章未标记回收，确认是有意长线还是已经遗漏。", if label.is_empty() {"未命名伏笔"} else {&label}, gap),
                            from_ch,
                            eid
                        ],
                    )?;
                }
            }
        }

        // ③ 长期断档：角色距上次出场超过阈值
        {
            let mut stmt = db.prepare(
                "SELECT ch.id, ch.name,
                        (SELECT c.id FROM character_mentions m
                         JOIN chapters c ON c.id = m.chapter_id AND c.deleted_at IS NULL
                         WHERE m.character_id = ch.id
                         ORDER BY c.sort_order DESC LIMIT 1) AS last_ch
                 FROM characters ch WHERE ch.status = 1",
            )?;
            let rows = stmt
                .query_map([], |r| {
                    Ok((
                        r.get::<_, i64>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, Option<i64>>(2)?,
                    ))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            for (cid, name, last_ch) in rows {
                let gap = match last_ch.and_then(position) {
                    Some(p) => latest - p as i64,
                    None => latest + 1, // 从未出场
                };
                if gap >= absence {
                    let fp = format!("absence:{cid}");
                    db.execute(
                        "INSERT OR IGNORE INTO continuity_issues
                            (kind, fingerprint, title, detail, chapter_id, ref_id)
                         VALUES ('long_absence', ?1, ?2, ?3, ?4, ?5)",
                        params![
                            fp,
                            format!("「{name}」已 {gap} 章未出场"),
                            format!("角色「{name}」距今约 {gap} 章没有出现，群像写作中容易被读者遗忘，可安排呼应。"),
                            last_ch,
                            cid
                        ],
                    )?;
                }
            }
        }

        list_issues(db)
}

fn list_issues(conn: &rusqlite::Connection) -> Result<Vec<ContinuityIssue>> {
    let mut stmt = conn.prepare(
        "SELECT id, kind, fingerprint, title, detail, chapter_id, ref_id, status
         FROM continuity_issues WHERE status = 0 ORDER BY kind, id",
    )?;
    let rows = stmt.query_map([], issue_row)?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

#[tauri::command]
pub fn list_continuity(state: State<'_, AppState>) -> Result<Vec<ContinuityIssue>> {
    state.with_project(|db| list_issues(&db.conn))
}

/// 更新问题状态：1=忽略 2=已解决（0=重新打开）
#[tauri::command]
pub fn set_continuity_status(
    state: State<'_, AppState>,
    issue_id: i64,
    status: i64,
) -> Result<()> {
    state.with_project(|db| {
        db.conn.execute(
            "UPDATE continuity_issues SET status = ?1 WHERE id = ?2",
            params![status, issue_id],
        )?;
        Ok(())
    })
}

// ---------- 修订工作台 ----------

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RevisionHit {
    pub chapter_id: i64,
    pub chapter_title: String,
    /// long_sentence / repeated_word / repeated_punct
    pub kind: String,
    pub message: String,
    pub snippet: String,
}

const LAUGH_CHARS: &[char] = &['哈', '啊', '嗯', '哦', '嘿', '嘻', '呀', '呜', '…'];

/// 静态文本检查：超长句、相邻重复词 / 叠字滥用、重复标点。
#[tauri::command]
pub fn analyze_revision(
    state: State<'_, AppState>,
    long_sentence: Option<i64>,
) -> Result<Vec<RevisionHit>> {
    let limit = long_sentence.unwrap_or(80).max(10) as usize;
    state.with_project(|db| {
        let mut out = Vec::new();
        for (id, title, content) in load_chapters(&db.conn, None)? {
            let chars: Vec<char> = content.chars().collect();
            // 相邻重复双字词：ABAB 且 A!=B（如「然后然后」「的的」由叠字路径处理）
            for i in 0..chars.len().saturating_sub(3) {
                if chars[i] == chars[i + 2]
                    && chars[i + 1] == chars[i + 3]
                    && chars[i] != chars[i + 1]
                    && chars[i].is_alphanumeric()
                {
                    let word: String = chars[i..i + 4].iter().collect();
                    out.push(RevisionHit {
                        chapter_id: id,
                        chapter_title: title.clone(),
                        kind: "repeated_word".into(),
                        message: format!("相邻重复词「{word}」"),
                        snippet: word,
                    });
                    if out.len() > 2000 {
                        return Ok(out);
                    }
                }
            }
            // 四连同字（语气词 / 省略号除外）
            for i in 0..chars.len().saturating_sub(3) {
                if chars[i] == chars[i + 1]
                    && chars[i + 1] == chars[i + 2]
                    && chars[i + 2] == chars[i + 3]
                    && !LAUGH_CHARS.contains(&chars[i])
                {
                    let word: String = chars[i..i + 4].iter().collect();
                    out.push(RevisionHit {
                        chapter_id: id,
                        chapter_title: title.clone(),
                        kind: "repeated_punct".into(),
                        message: format!("字符「{}」连续出现 4 次", chars[i]),
                        snippet: word,
                    });
                }
            }
            // 超长句
            let mut buf = String::new();
            let flush = |buf: &mut String, out: &mut Vec<RevisionHit>| {
                let t = buf.trim();
                let n = t.chars().count();
                if n > limit {
                    out.push(RevisionHit {
                        chapter_id: id,
                        chapter_title: title.clone(),
                        kind: "long_sentence".into(),
                        message: format!("单句 {n} 字，建议拆分（阈值 {limit}）"),
                        snippet: t.chars().take(40).collect(),
                    });
                }
                buf.clear();
            };
            for ch in content.chars() {
                if matches!(ch, '。' | '！' | '？' | '；' | '!' | '?' | ';' | '\n') {
                    flush(&mut buf, &mut out);
                } else {
                    buf.push(ch);
                }
            }
            flush(&mut buf, &mut out);
            if out.len() > 2000 {
                break;
            }
        }
        Ok(out)
    })
}

/// 跨章查找替换预览（字面匹配）
#[tauri::command]
pub fn preview_cross_replace(
    state: State<'_, AppState>,
    find: String,
    chapter_ids: Option<Vec<i64>>,
) -> Result<Vec<ChapterHit>> {
    if find.trim().is_empty() {
        return Err(AppError::Msg("查找内容不能为空".into()));
    }
    state.with_project(|db| {
        let mut hits = Vec::new();
        for (id, title, content) in load_chapters(&db.conn, chapter_ids.as_deref())? {
            let count = content.matches(find.as_str()).count() as i64;
            if count == 0 {
                continue;
            }
            let mut snippets = Vec::new();
            let mut from = 0usize;
            for _ in 0..3 {
                let Some(rel) = content[from..].find(find.as_str()) else { break };
                let s = from + rel;
                let e = s + find.len();
                snippets.push(snippet_around(&content, s, e, 10));
                from = e;
            }
            hits.push(ChapterHit {
                chapter_id: id,
                chapter_title: title,
                count,
                snippets,
            });
        }
        Ok(hits)
    })
}

/// 应用跨章替换：单事务、逐章快照，返回替换次数
#[tauri::command]
pub fn apply_cross_replace(
    state: State<'_, AppState>,
    find: String,
    replace: String,
    chapter_ids: Option<Vec<i64>>,
) -> Result<i64> {
    if find.trim().is_empty() {
        return Err(AppError::Msg("查找内容不能为空".into()));
    }
    state.with_project(|db| {
        let tx = db.conn.unchecked_transaction()?;
        let mut total = 0i64;
        for (id, title, content) in load_chapters(&tx, chapter_ids.as_deref())? {
            let count = content.matches(find.as_str()).count();
            if count == 0 {
                continue;
            }
            tx.execute(
                "INSERT INTO chapter_versions (chapter_id, title, content, word_count, version_type)
                 VALUES (?1, ?2, ?3, ?4, 1)",
                params![id, title, content, count_text(&content).words],
            )?;
            let new_content = content.replace(find.as_str(), &replace);
            total += count as i64;
            let stats = count_text(&new_content);
            tx.execute(
                "UPDATE chapters SET content = ?1, word_count = ?2, char_count = ?3, content_hash = '',
                    updated_at = datetime('now','localtime') WHERE id = ?4",
                params![new_content, stats.words, stats.chars, id],
            )?;
        }
        tx.commit()?;
        Ok(total)
    })
}


#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    fn db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::migrations::apply(&conn).unwrap();
        conn.execute("INSERT INTO volumes (id,title,sort_order) VALUES (1,'正文',0)", [])
            .unwrap();
        for i in 1..=12 {
            conn.execute(
                "INSERT INTO chapters (id,volume_id,title,sort_order,content) VALUES (?1,1,?2,?3,'')",
                rusqlite::params![i, format!("第{i}章"), i - 1],
            )
            .unwrap();
        }
        conn
    }

    #[test]
    fn quoted_ranges_detect_dialogue() {
        let r = quoted_ranges("他说“你好”然后离开");
        assert_eq!(r.len(), 1);
        let (s, e) = r[0];
        assert_eq!(&"他说“你好”然后离开"[s..e], "“你好”");
    }

    #[test]
    fn longest_match_avoids_compound_rename() {
        // 苏婉(1) 与 苏婉清(2)：改名预览只应命中归属 1 的独立「苏婉」
        let conn = db();
        conn.execute(
            "INSERT INTO characters (id,name,aliases,status) VALUES (1,'苏婉','[]',1),(2,'苏婉清','[]',1)",
            [],
        )
        .unwrap();
        conn.execute(
            "UPDATE chapters SET content='苏婉清走来，苏婉离开。' WHERE id=1",
            [],
        )
        .unwrap();
        let entities = crate::commands::cards::load_char_entities(&conn).unwrap();
        let matcher = MentionMatcher::build(&entities);
        let content: String = conn
            .query_row("SELECT content FROM chapters WHERE id=1", [], |r| r.get(0))
            .unwrap();
        let owned: i64 = matcher
            .spans(&content)
            .into_iter()
            .filter(|(_, _, o)| *o == 1)
            .count() as i64;
        assert_eq!(owned, 1, "复合长名不得算到短名角色头上");
    }

    #[test]
    fn continuity_flags_dead_absence_and_overdue_foreshadow() {
        let conn = db();
        // 已死亡角色 1，但在第 12 章仍有提及 → 死者再现
        conn.execute(
            "INSERT INTO characters (id,name,aliases,status,alive) VALUES (1,'亡者','[]',1,0)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO character_mentions (character_id,chapter_id,mention_count) VALUES (1,12,1)",
            [],
        )
        .unwrap();
        // 活跃伏笔埋设在第 1 章，阈值 5，距今 11 章 → 逾期
        conn.execute(
            "INSERT INTO story_edges (id,from_node,to_node,edge_type,from_chapter_id,status)
             VALUES (1,1,1,4,1,0)",
            [],
        )
        .unwrap();
        let issues = scan_continuity_conn(&conn, 50, 5).unwrap();
        let kinds: Vec<&str> = issues.iter().map(|i| i.kind.as_str()).collect();
        assert!(kinds.contains(&"dead_reappear"), "应报死者再现");
        assert!(kinds.contains(&"foreshadow_overdue"), "应报伏笔逾期");
        // 同指纹重复扫描不产生重复行
        let again = scan_continuity_conn(&conn, 50, 5).unwrap();
        assert_eq!(again.len(), issues.len(), "指纹去重应稳定");
    }

    #[test]
    fn long_absence_for_never_appeared_character() {
        let conn = db();
        conn.execute(
            "INSERT INTO characters (id,name,aliases,status) VALUES (1,'隐者','[]',1)",
            [],
        )
        .unwrap();
        let issues = scan_continuity_conn(&conn, 3, 999).unwrap();
        assert!(issues.iter().any(|i| i.kind == "long_absence"));
    }
}
