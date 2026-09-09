//! 人物关系命令（v0.9.13 广义人物关系体系）。
//!
//! - 五大类（1血缘 2情感 3社会 4阵营 5叙事）+ 自由文本子类型 + 单双向
//! - `volume_id = NULL` 跨卷关系；具体卷 = 仅该卷 L2 显示
//! - 出场统计命令：character_mentions 按卷聚合，供画布人物层（L1 轨迹带 /
//!   卷节点核心人物行 / L2 人物节点）派生渲染，不落库

use crate::commands::AppState;
use crate::error::{AppError, Result};
use crate::models::{CharacterRelation, CharacterVolumePresence};
use rusqlite::{params, Connection, Row};
use tauri::State;

fn row_to_relation(row: &Row) -> rusqlite::Result<CharacterRelation> {
    Ok(CharacterRelation {
        id: row.get(0)?,
        from_char: row.get(1)?,
        to_char: row.get(2)?,
        rel_category: row.get(3)?,
        rel_type: row.get(4)?,
        label: row.get(5)?,
        direction: row.get(6)?,
        volume_id: row.get(7)?,
        created_at: row.get(8)?,
    })
}

const REL_COLS: &str = "id, from_char, to_char, rel_category, rel_type, label, direction, volume_id, created_at";

fn fetch_relation(conn: &Connection, id: i64) -> Result<CharacterRelation> {
    conn.query_row(
        &format!("SELECT {REL_COLS} FROM character_relations WHERE id = ?1"),
        params![id],
        row_to_relation,
    )
    .map_err(|_| AppError::Msg("人物关系不存在".into()))
}

fn validate_category(category: i32) -> Result<()> {
    if !(1..=5).contains(&category) {
        return Err(AppError::Msg("无效的关系大类".into()));
    }
    Ok(())
}

fn validate_direction(direction: i32) -> Result<()> {
    if !(0..=1).contains(&direction) {
        return Err(AppError::Msg("无效的关系方向".into()));
    }
    Ok(())
}

/// 校验人物存在；返回 (from, to) 的名字（错误提示用）
fn validate_characters(conn: &Connection, from_char: i64, to_char: i64) -> Result<()> {
    if from_char == to_char {
        return Err(AppError::Msg("关系两端不能是同一人物".into()));
    }
    let n: i64 = conn.query_row(
        "SELECT COUNT(*) FROM characters WHERE id IN (?1, ?2)",
        params![from_char, to_char],
        |r| r.get(0),
    )?;
    if n < 2 {
        return Err(AppError::Msg("人物不存在".into()));
    }
    Ok(())
}

fn validate_volume(conn: &Connection, volume_id: Option<i64>) -> Result<()> {
    if let Some(vid) = volume_id {
        let n: i64 = conn.query_row(
            "SELECT COUNT(*) FROM volumes WHERE id = ?1",
            params![vid],
            |r| r.get(0),
        )?;
        if n == 0 {
            return Err(AppError::Msg("卷不存在".into()));
        }
    }
    Ok(())
}

/// 人物关系列表（画布隔离口径）。
/// `volume_id = None` → 仅跨卷关系（volume_id IS NULL），供 L1 全书故事地图。
/// `Some(vid)` → 仅该卷关系（volume_id = vid），供 L2 卷内画布。
/// 两层完全隔离，互不渗透。管理视图需要全部关系请用 [`list_all_character_relations`]。
#[tauri::command]
pub fn list_character_relations(
    state: State<'_, AppState>,
    volume_id: Option<i64>,
) -> Result<Vec<CharacterRelation>> {
    state.with_project(|db| {
        let sql = match volume_id {
            None => format!(
                "SELECT {REL_COLS} FROM character_relations WHERE volume_id IS NULL ORDER BY id"
            ),
            Some(_) => format!(
                "SELECT {REL_COLS} FROM character_relations WHERE volume_id = ?1 ORDER BY id"
            ),
        };
        let mut stmt = db.conn.prepare(&sql)?;
        let list = match volume_id {
            None => stmt
                .query_map([], row_to_relation)?
                .collect::<std::result::Result<Vec<_>, _>>()?,
            Some(vid) => stmt
                .query_map(params![vid], row_to_relation)?
                .collect::<std::result::Result<Vec<_>, _>>()?,
        };
        Ok(list)
    })
}

/// 全部人物关系（跨卷 + 各卷），仅供人物卡管理视图等需要全量的场景。
#[tauri::command]
pub fn list_all_character_relations(
    state: State<'_, AppState>,
) -> Result<Vec<CharacterRelation>> {
    state.with_project(|db| {
        let mut stmt = db
            .conn
            .prepare(&format!("SELECT {REL_COLS} FROM character_relations ORDER BY id"))?;
        let list = stmt
            .query_map([], row_to_relation)?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(list)
    })
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn create_character_relation(
    state: State<'_, AppState>,
    from_char: i64,
    to_char: i64,
    rel_category: i32,
    rel_type: String,
    label: String,
    direction: i32,
    volume_id: Option<i64>,
) -> Result<CharacterRelation> {
    validate_category(rel_category)?;
    validate_direction(direction)?;
    let rel_type = rel_type.trim().to_string();
    let label = label.trim().to_string();
    state.with_project(|db| {
        validate_characters(&db.conn, from_char, to_char)?;
        validate_volume(&db.conn, volume_id)?;
        db.conn.execute(
            "INSERT INTO character_relations
                (from_char, to_char, rel_category, rel_type, label, direction, volume_id)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![from_char, to_char, rel_category, rel_type, label, direction, volume_id],
        )?;
        fetch_relation(&db.conn, db.conn.last_insert_rowid())
    })
}

/// 编辑人物关系（全字段覆盖，前端编辑面板总是提交完整行）
#[tauri::command]
pub fn update_character_relation(
    state: State<'_, AppState>,
    relation_id: i64,
    rel_category: i32,
    rel_type: String,
    label: String,
    direction: i32,
    volume_id: Option<i64>,
) -> Result<()> {
    validate_category(rel_category)?;
    validate_direction(direction)?;
    let rel_type = rel_type.trim().to_string();
    let label = label.trim().to_string();
    state.with_project(|db| {
        validate_volume(&db.conn, volume_id)?;
        let n = db.conn.execute(
            "UPDATE character_relations
             SET rel_category = ?1, rel_type = ?2, label = ?3, direction = ?4, volume_id = ?5
             WHERE id = ?6",
            params![rel_category, rel_type, label, direction, volume_id, relation_id],
        )?;
        if n == 0 {
            return Err(AppError::Msg("人物关系不存在".into()));
        }
        Ok(())
    })
}

#[tauri::command]
pub fn delete_character_relation(state: State<'_, AppState>, relation_id: i64) -> Result<()> {
    state.with_project(|db| {
        let n = db.conn.execute(
            "DELETE FROM character_relations WHERE id = ?1",
            params![relation_id],
        )?;
        if n == 0 {
            return Err(AppError::Msg("人物关系不存在".into()));
        }
        Ok(())
    })
}

/// 人物 × 卷出场统计：character_mentions 按卷聚合（回收站章节不计）。
/// 画布人物层的唯一数据源——L1 轨迹带 / 卷节点核心人物行 / L2 人物节点
/// 全部由前端从这份聚合派生。
#[tauri::command]
pub fn list_character_volume_presence(
    state: State<'_, AppState>,
) -> Result<Vec<CharacterVolumePresence>> {
    state.with_project(|db| {
        let mut stmt = db.conn.prepare(
            "SELECT ch.id, ch.name, ch.role, c.volume_id, SUM(m.mention_count)
             FROM character_mentions m
             JOIN chapters c ON c.id = m.chapter_id AND c.deleted_at IS NULL
             JOIN characters ch ON ch.id = m.character_id
             WHERE m.mention_count > 0
             GROUP BY ch.id, c.volume_id
             ORDER BY ch.id, c.volume_id",
        )?;
        let list = stmt
            .query_map([], |r| {
                Ok(CharacterVolumePresence {
                    character_id: r.get(0)?,
                    name: r.get(1)?,
                    role: r.get(2)?,
                    volume_id: r.get(3)?,
                    mention_count: r.get(4)?,
                })
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(list)
    })
}

/// 卷内按章的人物提及：L2 人物节点「围绕出场章节辐射分布」的数据源。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChapterCharacterMention {
    pub chapter_id: i64,
    pub character_id: i64,
    pub mention_count: i64,
}

#[tauri::command]
pub fn list_volume_character_mentions(
    state: State<'_, AppState>,
    volume_id: i64,
) -> Result<Vec<ChapterCharacterMention>> {
    state.with_project(|db| {
        let mut stmt = db.conn.prepare(
            "SELECT m.chapter_id, m.character_id, m.mention_count
             FROM character_mentions m
             JOIN chapters c ON c.id = m.chapter_id
             WHERE c.volume_id = ?1 AND c.deleted_at IS NULL AND m.mention_count > 0
             ORDER BY m.chapter_id, m.mention_count DESC",
        )?;
        let list = stmt
            .query_map(params![volume_id], |r| {
                Ok(ChapterCharacterMention {
                    chapter_id: r.get(0)?,
                    character_id: r.get(1)?,
                    mention_count: r.get(2)?,
                })
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(list)
    })
}
