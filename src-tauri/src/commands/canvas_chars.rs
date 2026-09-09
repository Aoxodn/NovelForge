//! 人物图谱命令（v0.9.13 可编辑人物层）：
//! L1 全书人物坐标 / L2 卷内人物坐标 / 人物手动绑定卷·章。
//!
//! - 人物节点位置纯画布数据，不参与提及统计；
//! - 绑定（character_bindings）让正文未提及的人物也能挂到卷 / 章上，
//!   与 mentions 派生的出场并存在画布上；目标卷/章删除时级联清理。

use crate::commands::AppState;
use crate::error::{AppError, Result};
use crate::models::{CharacterBinding, CharacterCanvasPos};
use rusqlite::{params, Connection};
use tauri::State;

/// 保存 L1 全书人物图谱坐标（拖动松手落库，归一化 ±0.5 越界夹紧）
#[tauri::command]
pub fn move_character_node(
    state: State<'_, AppState>,
    character_id: i64,
    map_x: f64,
    map_y: f64,
) -> Result<()> {
    state.with_project(|db| {
        let n = db.conn.execute(
            "UPDATE characters SET map_x = ?1, map_y = ?2,
                 updated_at = datetime('now','localtime')
             WHERE id = ?3",
            params![map_x.clamp(-0.5, 1.5), map_y.clamp(-0.5, 1.5), character_id],
        )?;
        if n == 0 {
            return Err(AppError::Msg("人物不存在".into()));
        }
        Ok(())
    })
}

/// 从 L1 全书画布移除人物（清 map_x/map_y，不删卡；之后可重新添加）
#[tauri::command]
pub fn remove_character_from_canvas(
    state: State<'_, AppState>,
    character_id: i64,
) -> Result<()> {
    state.with_project(|db| {
        let n = db.conn.execute(
            "UPDATE characters SET map_x = NULL, map_y = NULL,
                 updated_at = datetime('now','localtime')
             WHERE id = ?1",
            params![character_id],
        )?;
        if n == 0 {
            return Err(AppError::Msg("人物不存在".into()));
        }
        Ok(())
    })
}

/// 保存 L2 卷内人物节点坐标（upsert）
#[tauri::command]
pub fn set_char_volume_pos(
    state: State<'_, AppState>,
    character_id: i64,
    volume_id: i64,
    map_x: f64,
    map_y: f64,
) -> Result<()> {
    state.with_project(|db| {
        let ok: i64 = db.conn.query_row(
            "SELECT COUNT(*) FROM characters WHERE id = ?1",
            params![character_id],
            |r| r.get(0),
        )?;
        if ok == 0 {
            return Err(AppError::Msg("人物不存在".into()));
        }
        db.conn.execute(
            "INSERT INTO char_volume_pos (character_id, volume_id, map_x, map_y)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(character_id, volume_id)
             DO UPDATE SET map_x = ?3, map_y = ?4",
            params![character_id, volume_id, map_x, map_y],
        )?;
        Ok(())
    })
}

/// 从 L2 卷内画布移除人物（删除 char_volume_pos 记录，不删卡）
#[tauri::command]
pub fn remove_character_from_volume(
    state: State<'_, AppState>,
    character_id: i64,
    volume_id: i64,
) -> Result<()> {
    state.with_project(|db| {
        db.conn.execute(
            "DELETE FROM char_volume_pos WHERE character_id = ?1 AND volume_id = ?2",
            params![character_id, volume_id],
        )?;
        Ok(())
    })
}

fn fetch_binding(conn: &Connection, id: i64) -> Result<CharacterBinding> {
    conn.query_row(
        "SELECT id, character_id, volume_id, chapter_id FROM character_bindings WHERE id = ?1",
        params![id],
        |r| {
            Ok(CharacterBinding {
                id: r.get(0)?,
                character_id: r.get(1)?,
                volume_id: r.get(2)?,
                chapter_id: r.get(3)?,
            })
        },
    )
    .map_err(|_| AppError::Msg("绑定不存在".into()))
}

/// 手动绑定人物 → 卷 / 章（二选一；重复绑定幂等返回已有记录）
#[tauri::command]
pub fn create_character_binding(
    state: State<'_, AppState>,
    character_id: i64,
    volume_id: Option<i64>,
    chapter_id: Option<i64>,
) -> Result<CharacterBinding> {
    if (volume_id.is_none()) == (chapter_id.is_none()) {
        return Err(AppError::Msg("绑定目标必须是一个卷或一个章节".into()));
    }
    state.with_project(|db| {
        let ok: i64 = db.conn.query_row(
            "SELECT COUNT(*) FROM characters WHERE id = ?1",
            params![character_id],
            |r| r.get(0),
        )?;
        if ok == 0 {
            return Err(AppError::Msg("人物不存在".into()));
        }
        if let Some(vid) = volume_id {
            let ok: i64 = db.conn.query_row(
                "SELECT COUNT(*) FROM volumes WHERE id = ?1",
                params![vid],
                |r| r.get(0),
            )?;
            if ok == 0 {
                return Err(AppError::Msg("卷不存在".into()));
            }
            let dup: i64 = db.conn.query_row(
                "SELECT COUNT(*) FROM character_bindings
                 WHERE character_id = ?1 AND volume_id = ?2",
                params![character_id, vid],
                |r| r.get(0),
            )?;
            if dup > 0 {
                return Err(AppError::Msg("该人物已绑定此卷".into()));
            }
        }
        if let Some(cid) = chapter_id {
            let ok: i64 = db.conn.query_row(
                "SELECT COUNT(*) FROM chapters WHERE id = ?1 AND deleted_at IS NULL",
                params![cid],
                |r| r.get(0),
            )?;
            if ok == 0 {
                return Err(AppError::Msg("章节不存在".into()));
            }
            let dup: i64 = db.conn.query_row(
                "SELECT COUNT(*) FROM character_bindings
                 WHERE character_id = ?1 AND chapter_id = ?2",
                params![character_id, cid],
                |r| r.get(0),
            )?;
            if dup > 0 {
                return Err(AppError::Msg("该人物已绑定此章".into()));
            }
        }
        db.conn.execute(
            "INSERT INTO character_bindings (character_id, volume_id, chapter_id)
             VALUES (?1, ?2, ?3)",
            params![character_id, volume_id, chapter_id],
        )?;
        fetch_binding(&db.conn, db.conn.last_insert_rowid())
    })
}

/// 解除绑定（人物 / 卷 / 章本身不受影响）
#[tauri::command]
pub fn delete_character_binding(state: State<'_, AppState>, binding_id: i64) -> Result<()> {
    state.with_project(|db| {
        let n = db.conn.execute(
            "DELETE FROM character_bindings WHERE id = ?1",
            params![binding_id],
        )?;
        if n == 0 {
            return Err(AppError::Msg("绑定不存在".into()));
        }
        Ok(())
    })
}

/// 全部人物→卷绑定（L1 关联线用；L2 卷级绑定由 get_volume_detail 下发）
#[tauri::command]
pub fn list_character_bindings(state: State<'_, AppState>) -> Result<Vec<CharacterBinding>> {
    state.with_project(|db| {
        let mut stmt = db.conn.prepare(
            "SELECT id, character_id, volume_id, chapter_id FROM character_bindings
             WHERE volume_id IS NOT NULL ORDER BY id",
        )?;
        let list = stmt
            .query_map([], |r| {
                Ok(CharacterBinding {
                    id: r.get(0)?,
                    character_id: r.get(1)?,
                    volume_id: r.get(2)?,
                    chapter_id: None,
                })
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(list)
    })
}

/// L2 卷内人物画布坐标（未拖动过的人物无记录，前端用提及堆叠兜底）
#[tauri::command]
pub fn list_char_volume_pos(
    state: State<'_, AppState>,
    volume_id: i64,
) -> Result<Vec<CharacterCanvasPos>> {
    state.with_project(|db| {
        let mut stmt = db.conn.prepare(
            "SELECT p.character_id, p.map_x, p.map_y
             FROM char_volume_pos p
             JOIN characters c ON c.id = p.character_id
             WHERE p.volume_id = ?1",
        )?;
        let list = stmt
            .query_map(params![volume_id], |r| {
                Ok(CharacterCanvasPos {
                    character_id: r.get(0)?,
                    map_x: r.get(1)?,
                    map_y: r.get(2)?,
                })
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(list)
    })
}
