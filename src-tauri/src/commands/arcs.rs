//! 人物弧光追踪（审查新增功能 P2）。
//!
//! 按章节为角色记录「欲望 — 选择 — 代价 — 状态变化」，
//! 叠加在 L1/L2 人物轨迹之上，解决群像角色长期消失或成长跳跃。

use crate::commands::AppState;
use crate::error::{AppError, Result};
use rusqlite::params;
use serde::{Deserialize, Serialize};
use tauri::State;

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CharacterArc {
    pub id: i64,
    pub character_id: i64,
    pub chapter_id: Option<i64>,
    pub sort_order: i64,
    pub desire: String,
    pub choice: String,
    pub cost: String,
    pub state_change: String,
    pub note: String,
    /// 关联章节标题（便于前端直接展示，无章节时为 null）
    pub chapter_title: Option<String>,
}

const COLS: &str = "a.id, a.character_id, a.chapter_id, a.sort_order, a.desire, a.choice,
        a.cost, a.state_change, a.note, c.title";

fn row(r: &rusqlite::Row<'_>) -> rusqlite::Result<CharacterArc> {
    Ok(CharacterArc {
        id: r.get(0)?,
        character_id: r.get(1)?,
        chapter_id: r.get(2)?,
        sort_order: r.get(3)?,
        desire: r.get(4)?,
        choice: r.get(5)?,
        cost: r.get(6)?,
        state_change: r.get(7)?,
        note: r.get(8)?,
        chapter_title: r.get(9)?,
    })
}

/// 列出某角色的全部弧光节点（顺序优先，其次章节顺序）
#[tauri::command]
pub fn list_arcs(
    state: State<'_, AppState>,
    character_id: i64,
) -> Result<Vec<CharacterArc>> {
    state.with_project(|db| {
        let mut stmt = db.conn.prepare(&format!(
            "SELECT {COLS} FROM character_arcs a
             LEFT JOIN chapters c ON c.id = a.chapter_id
             WHERE a.character_id = ?1
             ORDER BY a.sort_order, a.id"
        ))?;
        let rows = stmt.query_map(params![character_id], row)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    })
}

/// 新建弧光节点（可指定章节，默认追加到末尾）
#[tauri::command]
pub fn create_arc(
    state: State<'_, AppState>,
    character_id: i64,
    chapter_id: Option<i64>,
) -> Result<CharacterArc> {
    state.with_project(|db| {
        let exists: i64 = db.conn.query_row(
            "SELECT COUNT(*) FROM characters WHERE id = ?1",
            params![character_id],
            |r| r.get(0),
        )?;
        if exists == 0 {
            return Err(AppError::Msg("人物不存在".into()));
        }
        let next: i64 = db
            .conn
            .query_row(
                "SELECT COALESCE(MAX(sort_order) + 1, 0) FROM character_arcs WHERE character_id = ?1",
                params![character_id],
                |r| r.get(0),
            )
            .unwrap_or(0);
        db.conn.execute(
            "INSERT INTO character_arcs (character_id, chapter_id, sort_order) VALUES (?1, ?2, ?3)",
            params![character_id, chapter_id, next],
        )?;
        let id = db.conn.last_insert_rowid();
        let arc = db.conn.query_row(
            &format!(
                "SELECT {COLS} FROM character_arcs a
                 LEFT JOIN chapters c ON c.id = a.chapter_id WHERE a.id = ?1"
            ),
            params![id],
            row,
        )?;
        Ok(arc)
    })
}

/// 更新弧光节点字段（全部可选）
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn update_arc(
    state: State<'_, AppState>,
    arc_id: i64,
    chapter_id: Option<Option<i64>>,
    desire: Option<String>,
    choice: Option<String>,
    cost: Option<String>,
    state_change: Option<String>,
    note: Option<String>,
) -> Result<()> {
    state.with_project(|db| {
        let mut n = 0usize;
        // Option<Option<i64>>：None=不改；Some(None)=解绑章节；Some(Some(id))=绑定
        if let Some(cid) = chapter_id {
            n += db.conn.execute(
                "UPDATE character_arcs SET chapter_id = ?1, updated_at = datetime('now','localtime') WHERE id = ?2",
                params![cid, arc_id],
            )?;
        }
        macro_rules! upd {
            ($col:literal, $val:expr) => {
                if let Some(v) = $val {
                    n += db.conn.execute(
                        &format!(
                            "UPDATE character_arcs SET {} = ?1, updated_at = datetime('now','localtime') WHERE id = ?2",
                            $col
                        ),
                        params![v, arc_id],
                    )?;
                }
            };
        }
        upd!("desire", desire);
        upd!("choice", choice);
        upd!("cost", cost);
        upd!("state_change", state_change);
        upd!("note", note);
        if n == 0 {
            return Ok(());
        }
        let affected: i64 = db.conn.query_row(
            "SELECT COUNT(*) FROM character_arcs WHERE id = ?1",
            params![arc_id],
            |r| r.get(0),
        )?;
        if affected == 0 {
            return Err(AppError::Msg("弧光节点不存在".into()));
        }
        Ok(())
    })
}

#[tauri::command]
pub fn delete_arc(state: State<'_, AppState>, arc_id: i64) -> Result<()> {
    state.with_project(|db| {
        db.conn.execute("DELETE FROM character_arcs WHERE id = ?1", params![arc_id])?;
        Ok(())
    })
}

#[tauri::command]
pub fn reorder_arcs(
    state: State<'_, AppState>,
    character_id: i64,
    ordered_ids: Vec<i64>,
) -> Result<()> {
    state.with_project(|db| {
        let tx = db.conn.unchecked_transaction()?;
        for (i, aid) in ordered_ids.iter().enumerate() {
            tx.execute(
                "UPDATE character_arcs SET sort_order = ?1 WHERE id = ?2 AND character_id = ?3",
                params![i as i64, aid, character_id],
            )?;
        }
        tx.commit()?;
        Ok(())
    })
}
