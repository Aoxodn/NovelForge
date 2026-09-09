//! 场景级写作板（审查新增功能 P1）。
//!
//! 章节之下再拆「场景」：记录 POV / 时间 / 地点 / 目标 / 冲突 / 结果 / 目标字数，
//! 支持拖拽重排，并可把各场景正文合成为章节草稿。

use crate::commands::AppState;
use crate::error::{AppError, Result};
use crate::text::count_text;
use rusqlite::params;
use serde::{Deserialize, Serialize};
use tauri::State;

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Scene {
    pub id: i64,
    pub chapter_id: i64,
    pub sort_order: i64,
    pub pov: String,
    #[serde(rename = "timeOfScene")]
    pub time_of_scene: String,
    pub place: String,
    pub goal: String,
    pub conflict: String,
    pub result: String,
    pub target_words: i64,
    pub content: String,
}

fn row_to_scene(r: &rusqlite::Row<'_>) -> rusqlite::Result<Scene> {
    Ok(Scene {
        id: r.get(0)?,
        chapter_id: r.get(1)?,
        sort_order: r.get(2)?,
        pov: r.get(3)?,
        time_of_scene: r.get(4)?,
        place: r.get(5)?,
        goal: r.get(6)?,
        conflict: r.get(7)?,
        result: r.get(8)?,
        target_words: r.get(9)?,
        content: r.get(10)?,
    })
}

const COLS: &str = "id, chapter_id, sort_order, pov, time_of_scene, place, goal, conflict, result, target_words, content";

/// 列出某章的全部场景（按顺序）
#[tauri::command]
pub fn list_scenes(state: State<'_, AppState>, chapter_id: i64) -> Result<Vec<Scene>> {
    state.with_project(|db| {
        let mut stmt = db.conn.prepare(&format!(
            "SELECT {COLS} FROM scenes WHERE chapter_id = ?1 ORDER BY sort_order, id"
        ))?;
        let rows = stmt.query_map(params![chapter_id], row_to_scene)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    })
}

/// 在指定章节末尾新建一个空场景
#[tauri::command]
pub fn create_scene(state: State<'_, AppState>, chapter_id: i64) -> Result<Scene> {
    state.with_project(|db| {
        let exists: i64 = db.conn.query_row(
            "SELECT COUNT(*) FROM chapters WHERE id = ?1 AND deleted_at IS NULL",
            params![chapter_id],
            |r| r.get(0),
        )?;
        if exists == 0 {
            return Err(AppError::Msg("章节不存在".into()));
        }
        let next: i64 = db
            .conn
            .query_row(
                "SELECT COALESCE(MAX(sort_order) + 1, 0) FROM scenes WHERE chapter_id = ?1",
                params![chapter_id],
                |r| r.get(0),
            )
            .unwrap_or(0);
        db.conn.execute(
            "INSERT INTO scenes (chapter_id, sort_order) VALUES (?1, ?2)",
            params![chapter_id, next],
        )?;
        let id = db.conn.last_insert_rowid();
        let scene = db.conn.query_row(
            &format!("SELECT {COLS} FROM scenes WHERE id = ?1"),
            params![id],
            row_to_scene,
        )?;
        Ok(scene)
    })
}

/// 更新场景（任一字段可选；纯字段更新，不触发全书扫描）
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn update_scene(
    state: State<'_, AppState>,
    scene_id: i64,
    pov: Option<String>,
    time_of_scene: Option<String>,
    place: Option<String>,
    goal: Option<String>,
    conflict: Option<String>,
    result: Option<String>,
    target_words: Option<i64>,
    content: Option<String>,
) -> Result<()> {
    state.with_project(|db| {
        // 逐字段执行（字段数量固定且少，可读性优先；单连接无并发问题）
        let mut n = 0usize;
        macro_rules! upd {
            ($col:literal, $val:expr) => {
                if let Some(v) = $val {
                    n += db.conn.execute(
                        &format!(
                            "UPDATE scenes SET {} = ?1, updated_at = datetime('now','localtime') WHERE id = ?2",
                            $col
                        ),
                        params![v, scene_id],
                    )?;
                }
            };
        }
        upd!("pov", pov);
        upd!("time_of_scene", time_of_scene);
        upd!("place", place);
        upd!("goal", goal);
        upd!("conflict", conflict);
        upd!("result", result);
        upd!("target_words", target_words);
        upd!("content", content);
        if n == 0 {
            return Ok(());
        }
        let affected: i64 = db
            .conn
            .query_row("SELECT COUNT(*) FROM scenes WHERE id = ?1", params![scene_id], |r| {
                r.get(0)
            })?;
        if affected == 0 {
            return Err(AppError::Msg("场景不存在".into()));
        }
        Ok(())
    })
}

/// 删除场景
#[tauri::command]
pub fn delete_scene(state: State<'_, AppState>, scene_id: i64) -> Result<()> {
    state.with_project(|db| {
        db.conn.execute("DELETE FROM scenes WHERE id = ?1", params![scene_id])?;
        Ok(())
    })
}

/// 拖拽重排：按传入 id 顺序重写 sort_order（单事务）
#[tauri::command]
pub fn reorder_scenes(
    state: State<'_, AppState>,
    chapter_id: i64,
    ordered_ids: Vec<i64>,
) -> Result<()> {
    state.with_project(|db| {
        let tx = db.conn.unchecked_transaction()?;
        for (i, sid) in ordered_ids.iter().enumerate() {
            tx.execute(
                "UPDATE scenes SET sort_order = ?1 WHERE id = ?2 AND chapter_id = ?3",
                params![i as i64, sid, chapter_id],
            )?;
        }
        tx.commit()?;
        Ok(())
    })
}

/// 把本章所有场景正文合成为章节草稿。
/// overwrite=false 时仅在章节为空时写入；true 时覆盖（调用前应由上层做快照）。
/// 返回合成后的正文。
#[tauri::command]
pub fn compose_scenes_to_chapter(
    state: State<'_, AppState>,
    chapter_id: i64,
    overwrite: bool,
) -> Result<String> {
    state.with_project(|db| {
        let (title, old): (String, String) = db
            .conn
            .query_row(
                "SELECT title, content FROM chapters WHERE id = ?1",
                params![chapter_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .map_err(|_| AppError::Msg("章节不存在".into()))?;
        if !overwrite && !old.trim().is_empty() {
            return Err(AppError::Msg("章节已有正文，如需覆盖请勾选覆盖".into()));
        }
        let mut stmt = db.conn.prepare(
            "SELECT content, place FROM scenes WHERE chapter_id = ?1 ORDER BY sort_order, id",
        )?;
        let parts = stmt
            .query_map(params![chapter_id], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let mut composed = String::new();
        for (content, place) in parts {
            let body = content.trim();
            if body.is_empty() {
                continue;
            }
            if !place.trim().is_empty() {
                composed.push_str(&format!("【{}】\n", place.trim()));
            }
            composed.push_str(body);
            composed.push_str("\n\n");
        }
        let composed = composed.trim_end().to_string();
        let stats = count_text(&composed);
        // 覆盖前留一份手动快照，保证可回退
        if !old.trim().is_empty() {
            db.conn.execute(
                "INSERT INTO chapter_versions (chapter_id, title, content, word_count, version_type)
                 VALUES (?1, ?2, ?3, ?4, 1)",
                params![chapter_id, title, old, count_text(&old).words],
            )?;
        }
        db.conn.execute(
            "UPDATE chapters SET content = ?1, word_count = ?2, char_count = ?3,
                content_hash = '', updated_at = datetime('now','localtime') WHERE id = ?4",
            params![composed, stats.words, stats.chars, chapter_id],
        )?;
        Ok(composed)
    })
}
