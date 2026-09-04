//! 章节命令：创建 / 读取 / 保存（自动保存核心）/ 移动 / 删除 / 版本快照与恢复。

use crate::commands::AppState;
use crate::error::{AppError, Result};
use crate::models::{ChapterDetail, ChapterVersionMeta, SaveResult};
use crate::text;
use rusqlite::{params, Connection};
use tauri::State;

/// 每章保留的历史版本数量上限，超出时清理最旧的
const MAX_VERSIONS_PER_CHAPTER: i64 = 50;

fn fetch_chapter_detail(conn: &Connection, id: i64) -> Result<ChapterDetail> {
    conn.query_row(
        "SELECT id, volume_id, title, content, word_count, char_count, status, summary, notes, updated_at
         FROM chapters WHERE id = ?1",
        params![id],
        |row| {
            Ok(ChapterDetail {
                id: row.get(0)?,
                volume_id: row.get(1)?,
                title: row.get(2)?,
                content: row.get(3)?,
                word_count: row.get(4)?,
                char_count: row.get(5)?,
                status: row.get(6)?,
                summary: row.get(7)?,
                notes: row.get(8)?,
                updated_at: row.get(9)?,
            })
        },
    )
    .map_err(|e| match e {
        rusqlite::Error::QueryReturnedNoRows => AppError::Msg("章节不存在（可能已被删除）".into()),
        other => other.into(),
    })
}

/// 在指定卷末尾新建章节。title 为空时自动按全书序号命名「第N章」。
#[tauri::command]
pub fn create_chapter(
    state: State<'_, AppState>,
    volume_id: i64,
    title: Option<String>,
) -> Result<ChapterDetail> {
    state.with_project(|db| {
        // 校验卷存在
        let exists: i64 = db.conn.query_row(
            "SELECT COUNT(*) FROM volumes WHERE id = ?1",
            params![volume_id],
            |r| r.get(0),
        )?;
        if exists == 0 {
            return Err(AppError::Msg("目标卷不存在".into()));
        }

        let title = match title {
            Some(t) if !t.trim().is_empty() => t.trim().to_string(),
            _ => {
                // 默认标题：全书章节总数 + 1
                let total: i64 =
                    db.conn.query_row("SELECT COUNT(*) FROM chapters", [], |r| r.get(0))?;
                format!("第{}章", total + 1)
            }
        };

        let next: i32 = db.conn.query_row(
            "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM chapters WHERE volume_id = ?1",
            params![volume_id],
            |r| r.get(0),
        )?;

        let tx = db.conn.unchecked_transaction()?;
        tx.execute(
            "INSERT INTO chapters (volume_id, title, sort_order) VALUES (?1, ?2, ?3)",
            params![volume_id, title, next],
        )?;
        tx.commit()?;

        fetch_chapter_detail(&db.conn, db.conn.last_insert_rowid())
    })
}

/// 读取章节完整内容（编辑器加载）
#[tauri::command]
pub fn get_chapter(state: State<'_, AppState>, chapter_id: i64) -> Result<ChapterDetail> {
    state.with_project(|db| fetch_chapter_detail(&db.conn, chapter_id))
}

/// 保存章节 —— 自动保存的核心入口。
///
/// 前端 500ms 防抖触发（snapshot=false），每 5 分钟或 Ctrl+S 时带快照（snapshot=true）。
/// 事务保证：更新正文 + 字数统计 + 版本快照 + 快照清理，要么全部成功要么全部回滚。
#[tauri::command]
pub fn save_chapter(
    state: State<'_, AppState>,
    chapter_id: i64,
    title: String,
    content: String,
    snapshot: bool,
) -> Result<SaveResult> {
    let title = title.trim().to_string();
    if title.is_empty() {
        return Err(AppError::Msg("章节标题不能为空".into()));
    }

    state.with_project(|db| {
        let stats = text::count_text(&content);

        let old_words: i64 = db
            .conn
            .query_row(
                "SELECT word_count FROM chapters WHERE id = ?1",
                params![chapter_id],
                |r| r.get(0),
            )
            .map_err(|e| match e {
                rusqlite::Error::QueryReturnedNoRows => {
                    AppError::Msg("章节不存在（可能已被删除）".into())
                }
                other => other.into(),
            })?;

        let tx = db.conn.unchecked_transaction()?;

        tx.execute(
            "UPDATE chapters
             SET title = ?1, content = ?2, word_count = ?3, char_count = ?4,
                 content_hash = ?5,
                 updated_at = datetime('now','localtime')
             WHERE id = ?6",
            params![
                title,
                content,
                stats.words,
                stats.chars,
                // 增量分析预留：内容指纹（FNV-1a，忽略空白），内容未变则跳过重分析
                format!("{:016x}", text::content_fingerprint(&content)),
                chapter_id
            ],
        )?;

        let mut snapshot_created = false;
        if snapshot {
            // 内容与最近一个版本相同时不重复建快照
            let same_as_last: bool = tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM chapter_versions
                               WHERE chapter_id = ?1 AND content = ?2)",
                params![chapter_id, content],
                |r| r.get(0),
            )?;
            if !same_as_last {
                tx.execute(
                    "INSERT INTO chapter_versions (chapter_id, title, content, word_count, version_type)
                     SELECT id, title, content, word_count, 0 FROM chapters WHERE id = ?1",
                    params![chapter_id],
                )?;
                snapshot_created = true;
            }
            // 清理超出上限的旧快照（保留最新 N 个）
            tx.execute(
                "DELETE FROM chapter_versions WHERE chapter_id = ?1 AND id NOT IN (
                     SELECT id FROM chapter_versions WHERE chapter_id = ?1
                     ORDER BY created_at DESC, id DESC LIMIT ?2
                 )",
                params![chapter_id, MAX_VERSIONS_PER_CHAPTER],
            )?;
        }

        // 码字统计：按自然日累加净增字数（只计正增长，删改不扣减）
        let delta = (stats.words - old_words).max(0);
        tx.execute(
            "INSERT INTO writing_daily (date, words, saves)
             VALUES (date('now','localtime'), ?1, 1)
             ON CONFLICT(date) DO UPDATE SET words = words + ?1, saves = saves + 1",
            params![delta],
        )?;

        // 人物 / 地点卡提及增量更新：本章重算（精确匹配，见 cards 模块）
        super::cards::update_chapter_mentions(&tx, chapter_id, &content)?;

        tx.commit()?;

        let saved_at: String = db.conn.query_row(
            "SELECT updated_at FROM chapters WHERE id = ?1",
            params![chapter_id],
            |r| r.get(0),
        )?;
        let today_words: i64 = db.conn.query_row(
            "SELECT COALESCE(words, 0) FROM writing_daily WHERE date = date('now','localtime')",
            [],
            |r| r.get(0),
        )?;

        Ok(SaveResult {
            word_count: stats.words,
            char_count: stats.chars,
            saved_at,
            snapshot_created,
            today_words,
        })
    })
}

/// 重命名章节（不改正文）
#[tauri::command]
pub fn rename_chapter(state: State<'_, AppState>, chapter_id: i64, title: String) -> Result<()> {
    let title = title.trim().to_string();
    if title.is_empty() {
        return Err(AppError::Msg("章节标题不能为空".into()));
    }
    state.with_project(|db| {
        let n = db.conn.execute(
            "UPDATE chapters SET title = ?1, updated_at = datetime('now','localtime') WHERE id = ?2",
            params![title, chapter_id],
        )?;
        if n == 0 {
            return Err(AppError::Msg("章节不存在".into()));
        }
        Ok(())
    })
}

/// 设置章节状态（0=草稿 1=完稿）
#[tauri::command]
pub fn set_chapter_status(
    state: State<'_, AppState>,
    chapter_id: i64,
    status: i32,
) -> Result<()> {
    if !(0..=1).contains(&status) {
        return Err(AppError::Msg("无效的章节状态".into()));
    }
    state.with_project(|db| {
        let n = db.conn.execute(
            "UPDATE chapters SET status = ?1 WHERE id = ?2",
            params![status, chapter_id],
        )?;
        if n == 0 {
            return Err(AppError::Msg("章节不存在".into()));
        }
        Ok(())
    })
}

/// 删除章节（连同其历史版本，外键级联）
#[tauri::command]
pub fn delete_chapter(state: State<'_, AppState>, chapter_id: i64) -> Result<()> {
    state.with_project(|db| {
        let tx = db.conn.unchecked_transaction()?;
        let n = tx.execute("DELETE FROM chapters WHERE id = ?1", params![chapter_id])?;
        if n == 0 {
            return Err(AppError::Msg("章节不存在".into()));
        }
        tx.commit()?;
        Ok(())
    })
}

/// 移动章节：跨卷移动 + 卷内排序。
/// `target_index` 为目标卷中的位置（0 起），整卷重排保证 sort_order 连续。
#[tauri::command]
pub fn move_chapter(
    state: State<'_, AppState>,
    chapter_id: i64,
    target_volume_id: i64,
    target_index: i32,
) -> Result<()> {
    state.with_project(|db| {
        let (current_volume, _): (i64, i32) = db.conn.query_row(
            "SELECT volume_id, sort_order FROM chapters WHERE id = ?1",
            params![chapter_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(|_| AppError::Msg("章节不存在".into()))?;

        // 目标卷当前章节顺序（排除被移动章节）
        let mut ids: Vec<i64> = {
            let mut stmt = db.conn.prepare(
                "SELECT id FROM chapters
                 WHERE volume_id = ?1 AND id != ?2
                 ORDER BY sort_order, id",
            )?;
            let ids: Vec<i64> = stmt
                .query_map(params![target_volume_id, chapter_id], |r| {
                    r.get::<_, i64>(0)
                })?
                .collect::<std::result::Result<Vec<_>, _>>()?;
            ids
        };

        let idx = (target_index.max(0) as usize).min(ids.len());
        ids.insert(idx, chapter_id);

        let tx = db.conn.unchecked_transaction()?;
        if current_volume != target_volume_id {
            tx.execute(
                "UPDATE chapters SET volume_id = ?1 WHERE id = ?2",
                params![target_volume_id, chapter_id],
            )?;
        }
        for (i, id) in ids.iter().enumerate() {
            tx.execute(
                "UPDATE chapters SET sort_order = ?1 WHERE id = ?2",
                params![i as i32, id],
            )?;
        }
        tx.commit()?;
        Ok(())
    })
}

/// 章节历史版本列表
#[tauri::command]
pub fn list_chapter_versions(
    state: State<'_, AppState>,
    chapter_id: i64,
) -> Result<Vec<ChapterVersionMeta>> {
    state.with_project(|db| {
        let mut stmt = db.conn.prepare(
            "SELECT id, chapter_id, title, word_count, version_type, created_at
             FROM chapter_versions WHERE chapter_id = ?1
             ORDER BY created_at DESC, id DESC
             LIMIT 50",
        )?;
        let list = stmt
            .query_map(params![chapter_id], |row| {
                Ok(ChapterVersionMeta {
                    id: row.get(0)?,
                    chapter_id: row.get(1)?,
                    title: row.get(2)?,
                    word_count: row.get(3)?,
                    version_type: row.get(4)?,
                    created_at: row.get(5)?,
                })
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(list)
    })
}

/// 恢复章节到指定历史版本。
/// 恢复前先把当前内容备份为版本（version_type=2），避免误恢复造成损失。
#[tauri::command]
pub fn restore_chapter_version(
    state: State<'_, AppState>,
    chapter_id: i64,
    version_id: i64,
) -> Result<ChapterDetail> {
    state.with_project(|db| {
        let exists: i64 = db.conn.query_row(
            "SELECT COUNT(*) FROM chapters WHERE id = ?1",
            params![chapter_id],
            |r| r.get(0),
        )?;
        if exists == 0 {
            return Err(AppError::Msg("章节不存在".into()));
        }

        let (v_title, v_content, v_word): (String, String, i64) = db.conn.query_row(
            "SELECT title, content, word_count FROM chapter_versions
             WHERE id = ?1 AND chapter_id = ?2",
            params![version_id, chapter_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .map_err(|_| AppError::Msg("历史版本不存在".into()))?;

        let stats = text::count_text(&v_content);
        let tx = db.conn.unchecked_transaction()?;

        // 1. 备份当前内容
        tx.execute(
            "INSERT INTO chapter_versions (chapter_id, title, content, word_count, version_type)
             SELECT id, title, content, word_count, 2 FROM chapters WHERE id = ?1",
            params![chapter_id],
        )?;
        // 2. 写回旧版本
        tx.execute(
            "UPDATE chapters
             SET title = ?1, content = ?2, word_count = ?3, char_count = ?4,
                 updated_at = datetime('now','localtime')
             WHERE id = ?5",
            params![v_title, v_content, stats.words, stats.chars, chapter_id],
        )?;

        tx.commit()?;
        let _ = v_word;
        fetch_chapter_detail(&db.conn, chapter_id)
    })
}
