//! 卷命令：创建 / 重命名 / 删除 / 排序。

use crate::commands::AppState;
use crate::error::{AppError, Result};
use crate::models::Volume;
use rusqlite::{params, Connection};
use tauri::State;

fn fetch_volume(conn: &Connection, id: i64) -> Result<Volume> {
    conn.query_row(
        "SELECT v.id, v.title, v.sort_order, v.summary, v.updated_at,
                (SELECT COUNT(*) FROM chapters c WHERE c.volume_id = v.id AND c.deleted_at IS NULL),
                (SELECT COALESCE(SUM(c.word_count), 0) FROM chapters c WHERE c.volume_id = v.id AND c.deleted_at IS NULL)
         FROM volumes v WHERE v.id = ?1",
        params![id],
        |row| {
            Ok(Volume {
                id: row.get(0)?,
                title: row.get(1)?,
                sort_order: row.get(2)?,
                summary: row.get(3)?,
                updated_at: row.get(4)?,
                chapter_count: row.get(5)?,
                word_count: row.get(6)?,
            })
        },
    )
    .map_err(|e| match e {
        rusqlite::Error::QueryReturnedNoRows => AppError::Msg("卷不存在".into()),
        other => other.into(),
    })
}

/// 新建卷（追加到末尾）。可传入归一化画布坐标（右键空白处就地创建）。
#[tauri::command]
pub fn create_volume(
    state: State<'_, AppState>,
    title: String,
    map_x: Option<f64>,
    map_y: Option<f64>,
) -> Result<Volume> {
    let title = title.trim().to_string();
    if title.is_empty() {
        return Err(AppError::Msg("卷名不能为空".into()));
    }

    state.with_project(|db| {
        let next: i32 = db.conn.query_row(
            "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM volumes",
            [],
            |r| r.get(0),
        )?;
        let mx = map_x.map(|v| v.clamp(-0.5, 1.5));
        let my = map_y.map(|v| v.clamp(-0.5, 1.5));
        db.conn.execute(
            "INSERT INTO volumes (title, sort_order, map_x, map_y) VALUES (?1, ?2, ?3, ?4)",
            params![title, next, mx, my],
        )?;
        fetch_volume(&db.conn, db.conn.last_insert_rowid())
    })
}

/// 重命名卷
#[tauri::command]
pub fn rename_volume(state: State<'_, AppState>, volume_id: i64, title: String) -> Result<()> {
    let title = title.trim().to_string();
    if title.is_empty() {
        return Err(AppError::Msg("卷名不能为空".into()));
    }
    state.with_project(|db| {
        let n = db.conn.execute(
            "UPDATE volumes SET title = ?1, updated_at = datetime('now','localtime') WHERE id = ?2",
            params![title, volume_id],
        )?;
        if n == 0 {
            return Err(AppError::Msg("卷不存在".into()));
        }
        Ok(())
    })
}

/// 保存卷大纲（卷级纲要：本卷主线 / 目标字数 / 剧情走向）
#[tauri::command]
pub fn set_volume_summary(state: State<'_, AppState>, volume_id: i64, summary: String) -> Result<()> {
    state.with_project(|db| {
        let n = db.conn.execute(
            "UPDATE volumes SET summary = ?1, updated_at = datetime('now','localtime') WHERE id = ?2",
            params![summary, volume_id],
        )?;
        if n == 0 {
            return Err(AppError::Msg("卷不存在".into()));
        }
        Ok(())
    })
}

/// 删除卷（级联删除其下所有章节与版本，前端需二次确认）
#[tauri::command]
pub fn delete_volume(state: State<'_, AppState>, volume_id: i64) -> Result<()> {
    state.with_project(|db| {
        let tx = db.conn.unchecked_transaction()?;
        let n = tx.execute("DELETE FROM volumes WHERE id = ?1", params![volume_id])?;
        if n == 0 {
            return Err(AppError::Msg("卷不存在".into()));
        }
        tx.commit()?; // 外键级联在同一事务内完成
        Ok(())
    })
}

/// 移动卷到指定位置（0 起）。整体重排，保证 sort_order 连续。
#[tauri::command]
pub fn move_volume(state: State<'_, AppState>, volume_id: i64, target_index: i32) -> Result<()> {
    state.with_project(|db| {
        // 当前顺序
        let mut ids: Vec<i64> = {
            let mut stmt = db
                .conn
                .prepare("SELECT id FROM volumes ORDER BY sort_order, id")?;
            let ids: Vec<i64> = stmt
                .query_map([], |r| r.get::<_, i64>(0))?
                .collect::<std::result::Result<Vec<_>, _>>()?;
            ids
        };

        let pos = ids
            .iter()
            .position(|id| *id == volume_id)
            .ok_or_else(|| AppError::Msg("卷不存在".into()))?;
        ids.remove(pos);

        let idx = (target_index.max(0) as usize).min(ids.len());
        ids.insert(idx, volume_id);

        let tx = db.conn.unchecked_transaction()?;
        for (i, id) in ids.iter().enumerate() {
            tx.execute(
                "UPDATE volumes SET sort_order = ?1 WHERE id = ?2",
                params![i as i32, id],
            )?;
        }
        tx.commit()?;
        Ok(())
    })
}
