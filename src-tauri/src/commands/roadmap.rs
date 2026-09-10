//! 路线图 P0–P2：伏笔台账 / 线过滤 / 时间轴 / 状态账本 / 看板 /
//! POV 仪表盘 / 设定词条 / 称谓漂移 / 龙套铸造 / 张力·文风·结构快照。
//!
//! 全部规则只依赖本地 SQLite，不调用云端与 LLM。

use crate::commands::AppState;
use crate::error::{AppError, Result};
use crate::models::{
    AddressDriftHit, AddressForm, BatchCharacterResult, BoardCard, ChapterRoadmapMeta,
    CharacterStateSnapshot, ForeshadowItem, LoreEntry, PovDashboard, PovStat,
    StructureSnapshotMeta, StyleFingerprint, TimelineNode,
};
use rusqlite::{params, Connection};
use serde::Deserialize;
use tauri::State;

fn chapter_titles(conn: &Connection) -> Result<std::collections::HashMap<i64, String>> {
    let mut stmt = conn.prepare("SELECT id, title FROM chapters WHERE deleted_at IS NULL")?;
    let rows = stmt.query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))?;
    let mut m = std::collections::HashMap::new();
    for row in rows {
        let (id, t) = row?;
        m.insert(id, t);
    }
    Ok(m)
}

fn global_chapter_index(conn: &Connection) -> Result<Vec<i64>> {
    let mut stmt = conn.prepare(
        "SELECT c.id FROM chapters c
         JOIN volumes v ON v.id = c.volume_id
         WHERE c.deleted_at IS NULL
         ORDER BY v.sort_order, c.sort_order, c.id",
    )?;
    let ids = stmt
        .query_map([], |r| r.get::<_, i64>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(ids)
}

fn index_map(ids: &[i64]) -> std::collections::HashMap<i64, usize> {
    ids.iter().enumerate().map(|(i, id)| (*id, i)).collect()
}

fn foreshadow_threshold(conn: &Connection) -> Result<i64> {
    let v: Option<String> = conn
        .query_row(
            "SELECT value FROM settings WHERE key = 'foreshadow_overdue_threshold'",
            [],
            |r| r.get(0),
        )
        .ok();
    Ok(v.and_then(|s| s.parse().ok()).unwrap_or(10))
}

fn chapter_arc_map(conn: &Connection) -> Result<std::collections::HashMap<i64, Vec<i64>>> {
    let mut stmt = conn.prepare("SELECT chapter_id, arc_id FROM chapter_arc_members")?;
    let rows = stmt.query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?)))?;
    let mut m: std::collections::HashMap<i64, Vec<i64>> = std::collections::HashMap::new();
    for row in rows {
        let (ch, arc) = row?;
        m.entry(ch).or_default().push(arc);
    }
    Ok(m)
}

// ========== 伏笔台账 ==========

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForeshadowPatch {
    pub title: Option<String>,
    pub foreshadow_type: Option<i32>,
    pub plant_chapter_id: Option<Option<i64>>,
    pub expect_chapter_id: Option<Option<i64>>,
    pub resolve_chapter_id: Option<Option<i64>>,
    pub status: Option<i32>,
    pub arc_id: Option<Option<i64>>,
    pub character_id: Option<Option<i64>>,
    pub note: Option<String>,
}

fn load_foreshadows(conn: &Connection) -> Result<Vec<ForeshadowItem>> {
    let order = global_chapter_index(conn)?;
    let idx = index_map(&order);
    let thr = foreshadow_threshold(conn)?;
    let mut stmt = conn.prepare(
        "SELECT f.id, f.title, f.foreshadow_type, f.plant_chapter_id, f.expect_chapter_id,
                f.resolve_chapter_id, f.status, f.arc_id, f.character_id, f.note,
                a.title, ch.name
         FROM foreshadows f
         LEFT JOIN story_arcs a ON a.id = f.arc_id
         LEFT JOIN characters ch ON ch.id = f.character_id
         ORDER BY f.status, f.id",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok((
            r.get::<_, i64>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, i32>(2)?,
            r.get::<_, Option<i64>>(3)?,
            r.get::<_, Option<i64>>(4)?,
            r.get::<_, Option<i64>>(5)?,
            r.get::<_, i32>(6)?,
            r.get::<_, Option<i64>>(7)?,
            r.get::<_, Option<i64>>(8)?,
            r.get::<_, String>(9)?,
            r.get::<_, Option<String>>(10)?,
            r.get::<_, Option<String>>(11)?,
        ))
    })?;
    let titles = chapter_titles(conn)?;
    let mut out = Vec::new();
    for row in rows {
        let (id, title, ftype, plant, expect, resolve, status, arc_id, char_id, note, arc_t, ch_n) =
            row?;
        let title_of = |cid: Option<i64>| cid.and_then(|c| titles.get(&c).cloned());
        let span = match (plant, resolve.or(expect)) {
            (Some(p), Some(t)) => match (idx.get(&p), idx.get(&t)) {
                (Some(a), Some(b)) => (*b as i64) - (*a as i64),
                _ => -1,
            },
            _ => -1,
        };
        let overdue = status == 0 && span > thr;
        out.push(ForeshadowItem {
            id,
            title,
            foreshadow_type: ftype,
            plant_chapter_id: plant,
            plant_chapter_title: title_of(plant),
            expect_chapter_id: expect,
            expect_chapter_title: title_of(expect),
            resolve_chapter_id: resolve,
            resolve_chapter_title: title_of(resolve),
            status,
            arc_id,
            arc_title: arc_t,
            character_id: char_id,
            character_name: ch_n,
            note,
            span,
            overdue,
        });
    }
    Ok(out)
}

#[tauri::command]
pub fn list_foreshadow_ledger(state: State<'_, AppState>) -> Result<Vec<ForeshadowItem>> {
    state.with_project(|db| load_foreshadows(&db.conn))
}

#[tauri::command]
pub fn create_foreshadow(
    state: State<'_, AppState>,
    title: String,
    foreshadow_type: Option<i32>,
    plant_chapter_id: Option<i64>,
    expect_chapter_id: Option<i64>,
    arc_id: Option<i64>,
    character_id: Option<i64>,
    note: Option<String>,
) -> Result<ForeshadowItem> {
    let title = title.trim().to_string();
    if title.is_empty() {
        return Err(AppError::Msg("伏笔标题不能为空".into()));
    }
    state.with_project(|db| {
        db.conn.execute(
            "INSERT INTO foreshadows
             (title, foreshadow_type, plant_chapter_id, expect_chapter_id, arc_id, character_id, note)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                title,
                foreshadow_type.unwrap_or(0),
                plant_chapter_id,
                expect_chapter_id,
                arc_id,
                character_id,
                note.unwrap_or_default()
            ],
        )?;
        let id = db.conn.last_insert_rowid();
        load_foreshadows(&db.conn)?
            .into_iter()
            .find(|f| f.id == id)
            .ok_or_else(|| AppError::Msg("伏笔创建失败".into()))
    })
}

#[tauri::command]
pub fn update_foreshadow(
    state: State<'_, AppState>,
    id: i64,
    patch: ForeshadowPatch,
) -> Result<ForeshadowItem> {
    state.with_project(|db| {
        let exists: i64 = db.conn.query_row(
            "SELECT COUNT(*) FROM foreshadows WHERE id = ?1",
            params![id],
            |r| r.get(0),
        )?;
        if exists == 0 {
            return Err(AppError::Msg("伏笔不存在".into()));
        }
        let touch = "updated_at = datetime('now','localtime')";
        if let Some(t) = &patch.title {
            db.conn.execute(
                &format!("UPDATE foreshadows SET title = ?1, {touch} WHERE id = ?2"),
                params![t, id],
            )?;
        }
        if let Some(t) = patch.foreshadow_type {
            db.conn.execute(
                &format!("UPDATE foreshadows SET foreshadow_type = ?1, {touch} WHERE id = ?2"),
                params![t, id],
            )?;
        }
        if let Some(p) = patch.plant_chapter_id {
            db.conn.execute(
                &format!("UPDATE foreshadows SET plant_chapter_id = ?1, {touch} WHERE id = ?2"),
                params![p, id],
            )?;
        }
        if let Some(p) = patch.expect_chapter_id {
            db.conn.execute(
                &format!("UPDATE foreshadows SET expect_chapter_id = ?1, {touch} WHERE id = ?2"),
                params![p, id],
            )?;
        }
        if let Some(p) = patch.resolve_chapter_id {
            db.conn.execute(
                &format!("UPDATE foreshadows SET resolve_chapter_id = ?1, {touch} WHERE id = ?2"),
                params![p, id],
            )?;
        }
        if let Some(s) = patch.status {
            if s == 1 {
                db.conn.execute(
                    &format!(
                        "UPDATE foreshadows SET status = 1,
                         resolve_chapter_id = COALESCE(resolve_chapter_id, expect_chapter_id),
                         {touch} WHERE id = ?1"
                    ),
                    params![id],
                )?;
            } else {
                db.conn.execute(
                    &format!("UPDATE foreshadows SET status = ?1, {touch} WHERE id = ?2"),
                    params![s, id],
                )?;
            }
        }
        if let Some(a) = patch.arc_id {
            db.conn.execute(
                &format!("UPDATE foreshadows SET arc_id = ?1, {touch} WHERE id = ?2"),
                params![a, id],
            )?;
        }
        if let Some(c) = patch.character_id {
            db.conn.execute(
                &format!("UPDATE foreshadows SET character_id = ?1, {touch} WHERE id = ?2"),
                params![c, id],
            )?;
        }
        if let Some(n) = patch.note {
            db.conn.execute(
                &format!("UPDATE foreshadows SET note = ?1, {touch} WHERE id = ?2"),
                params![n, id],
            )?;
        }
        load_foreshadows(&db.conn)?
            .into_iter()
            .find(|f| f.id == id)
            .ok_or_else(|| AppError::Msg("伏笔不存在".into()))
    })
}

#[tauri::command]
pub fn delete_foreshadow(state: State<'_, AppState>, id: i64) -> Result<()> {
    state.with_project(|db| {
        let n = db
            .conn
            .execute("DELETE FROM foreshadows WHERE id = ?1", params![id])?;
        if n == 0 {
            return Err(AppError::Msg("伏笔不存在".into()));
        }
        Ok(())
    })
}

#[tauri::command]
pub fn foreshadows_for_chapter(
    state: State<'_, AppState>,
    chapter_id: i64,
) -> Result<Vec<ForeshadowItem>> {
    state.with_project(|db| {
        Ok(load_foreshadows(&db.conn)?
            .into_iter()
            .filter(|f| {
                f.plant_chapter_id == Some(chapter_id)
                    || f.expect_chapter_id == Some(chapter_id)
                    || f.resolve_chapter_id == Some(chapter_id)
            })
            .collect())
    })
}

// ========== 剧情线成员 ==========

#[tauri::command]
pub fn get_chapter_arcs(state: State<'_, AppState>, chapter_id: i64) -> Result<Vec<i64>> {
    state.with_project(|db| {
        let mut stmt = db
            .conn
            .prepare("SELECT arc_id FROM chapter_arc_members WHERE chapter_id = ?1")?;
        let ids = stmt
            .query_map(params![chapter_id], |r| r.get(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(ids)
    })
}

#[tauri::command]
pub fn set_chapter_arcs(
    state: State<'_, AppState>,
    chapter_id: i64,
    arc_ids: Vec<i64>,
    primary_arc_id: Option<i64>,
) -> Result<()> {
    state.with_project(|db| {
        db.conn.execute(
            "DELETE FROM chapter_arc_members WHERE chapter_id = ?1",
            params![chapter_id],
        )?;
        for (i, arc) in arc_ids.iter().enumerate() {
            let is_primary = if Some(*arc) == primary_arc_id {
                1
            } else if primary_arc_id.is_none() && i == 0 {
                1
            } else {
                0
            };
            db.conn.execute(
                "INSERT INTO chapter_arc_members (chapter_id, arc_id, is_primary)
                 VALUES (?1, ?2, ?3)",
                params![chapter_id, arc, is_primary],
            )?;
        }
        Ok(())
    })
}

/// 按线过滤的章节元数据（active_arc_id = None 或 0 = 不过滤）
fn roadmap_meta_rows(
    conn: &Connection,
    active_arc_id: Option<i64>,
) -> Result<Vec<ChapterRoadmapMeta>> {
    let arcs = chapter_arc_map(conn)?;
    let mut stmt = conn.prepare(
        "SELECT c.id, c.volume_id, c.title, c.word_count, c.target_words, c.board_lane,
                c.status, c.summary, c.story_time, c.story_order, c.timeline_group,
                c.tension, c.pov_character_id, v.title, ch.name,
                (SELECT COUNT(*) FROM foreshadows f
                  WHERE f.plant_chapter_id = c.id OR f.expect_chapter_id = c.id
                     OR f.resolve_chapter_id = c.id)
         FROM chapters c
         JOIN volumes v ON v.id = c.volume_id
         LEFT JOIN characters ch ON ch.id = c.pov_character_id
         WHERE c.deleted_at IS NULL
         ORDER BY v.sort_order, c.sort_order, c.id",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok((
            r.get::<_, i64>(0)?,
            r.get::<_, i64>(1)?,
            r.get::<_, String>(2)?,
            r.get::<_, i64>(3)?,
            r.get::<_, i64>(4)?,
            r.get::<_, i64>(5)?,
            r.get::<_, i64>(6)?,
            r.get::<_, String>(7)?,
            r.get::<_, String>(8)?,
            r.get::<_, Option<f64>>(9)?,
            r.get::<_, String>(10)?,
            r.get::<_, Option<i64>>(11)?,
            r.get::<_, Option<i64>>(12)?,
            r.get::<_, String>(13)?,
            r.get::<_, Option<String>>(14)?,
            r.get::<_, i64>(15)?,
        ))
    })?;
    let mut out = Vec::new();
    for row in rows {
        let (
            id,
            volume_id,
            title,
            word_count,
            target_words,
            board_lane,
            status,
            summary,
            story_time,
            story_order,
            timeline_group,
            tension,
            pov_id,
            _vol_title,
            pov_name,
            fs_count,
        ) = row?;
        let _ = _vol_title;
        let arc_ids = arcs.get(&id).cloned().unwrap_or_default();
        if let Some(active) = active_arc_id {
            if active > 0 && !arc_ids.contains(&active) {
                continue;
            }
        }
        out.push(ChapterRoadmapMeta {
            id,
            volume_id,
            title,
            word_count,
            target_words,
            board_lane,
            status,
            summary,
            story_time,
            story_order,
            timeline_group,
            tension,
            pov_character_id: pov_id,
            pov_name,
            arc_ids,
            foreshadow_count: fs_count,
        });
    }
    Ok(out)
}

#[tauri::command]
pub fn list_roadmap_chapters(
    state: State<'_, AppState>,
    active_arc_id: Option<i64>,
) -> Result<Vec<ChapterRoadmapMeta>> {
    state.with_project(|db| roadmap_meta_rows(&db.conn, active_arc_id))
}

// ========== 故事时间轴 ==========

#[tauri::command]
pub fn get_story_timeline(
    state: State<'_, AppState>,
    active_arc_id: Option<i64>,
) -> Result<Vec<TimelineNode>> {
    state.with_project(|db| {
        let metas = roadmap_meta_rows(&db.conn, active_arc_id)?;
        let mut nodes: Vec<TimelineNode> = Vec::with_capacity(metas.len());
        for (global_order, m) in metas.into_iter().enumerate() {
            // 叙事序：未设置时退回发表序（浮点）
            let story_order = m.story_order.unwrap_or(global_order as f64);
            nodes.push(TimelineNode {
                id: m.id,
                volume_id: m.volume_id,
                volume_title: String::new(), // 前端可从 tree 补全
                title: m.title,
                story_time: m.story_time,
                story_order,
                sort_order: 0,
                global_order: global_order as i64,
                timeline_group: m.timeline_group,
                status: m.status as i32,
                word_count: m.word_count,
                tension: m.tension,
                pov_character_id: m.pov_character_id,
                pov_name: m.pov_name,
                arc_ids: m.arc_ids,
            });
        }
        // 补全卷名
        let mut stmt = db.conn.prepare("SELECT id, title FROM volumes")?;
        let vols: std::collections::HashMap<i64, String> = stmt
            .query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))?
            .collect::<rusqlite::Result<_>>()?;
        for n in &mut nodes {
            if let Some(t) = vols.get(&n.volume_id) {
                n.volume_title = t.clone();
            }
        }
        nodes.sort_by(|a, b| {
            a.timeline_group
                .cmp(&b.timeline_group)
                .then(
                    a.story_order
                        .partial_cmp(&b.story_order)
                        .unwrap_or(std::cmp::Ordering::Equal),
                )
                .then(a.global_order.cmp(&b.global_order))
        });
        Ok(nodes)
    })
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoryTimePatch {
    pub story_time: Option<String>,
    pub story_order: Option<f64>,
    pub timeline_group: Option<String>,
    pub tension: Option<i64>,
    pub pov_character_id: Option<Option<i64>>,
    pub target_words: Option<i64>,
    pub board_lane: Option<i64>,
}

#[tauri::command]
pub fn update_chapter_roadmap(
    state: State<'_, AppState>,
    chapter_id: i64,
    patch: StoryTimePatch,
) -> Result<()> {
    state.with_project(|db| {
        let touch = "updated_at = datetime('now','localtime')";
        if let Some(t) = &patch.story_time {
            db.conn.execute(
                &format!("UPDATE chapters SET story_time = ?1, {touch} WHERE id = ?2"),
                params![t, chapter_id],
            )?;
        }
        if let Some(o) = patch.story_order {
            db.conn.execute(
                &format!("UPDATE chapters SET story_order = ?1, {touch} WHERE id = ?2"),
                params![o, chapter_id],
            )?;
        }
        if let Some(g) = &patch.timeline_group {
            db.conn.execute(
                &format!("UPDATE chapters SET timeline_group = ?1, {touch} WHERE id = ?2"),
                params![g, chapter_id],
            )?;
        }
        if let Some(t) = patch.tension {
            db.conn.execute(
                &format!("UPDATE chapters SET tension = ?1, {touch} WHERE id = ?2"),
                params![t, chapter_id],
            )?;
        }
        if let Some(p) = patch.pov_character_id {
            db.conn.execute(
                &format!("UPDATE chapters SET pov_character_id = ?1, {touch} WHERE id = ?2"),
                params![p, chapter_id],
            )?;
        }
        if let Some(w) = patch.target_words {
            db.conn.execute(
                &format!("UPDATE chapters SET target_words = ?1, {touch} WHERE id = ?2"),
                params![w, chapter_id],
            )?;
        }
        if let Some(l) = patch.board_lane {
            db.conn.execute(
                &format!("UPDATE chapters SET board_lane = ?1, {touch} WHERE id = ?2"),
                params![l, chapter_id],
            )?;
        }
        Ok(())
    })
}

// ========== 看板 ==========

#[tauri::command]
pub fn get_board(state: State<'_, AppState>, active_arc_id: Option<i64>) -> Result<Vec<BoardCard>> {
    state.with_project(|db| {
        let metas = roadmap_meta_rows(&db.conn, active_arc_id)?;
        let mut out = Vec::with_capacity(metas.len());
        for m in metas {
            let volume_title: String = db.conn.query_row(
                "SELECT title FROM volumes WHERE id = ?1",
                params![m.volume_id],
                |r| r.get(0),
            )?;
            out.push(BoardCard {
                id: m.id,
                volume_id: m.volume_id,
                volume_title,
                title: m.title,
                board_lane: m.board_lane,
                status: m.status,
                word_count: m.word_count,
                target_words: m.target_words,
                summary: m.summary,
                arc_ids: m.arc_ids,
                foreshadow_count: m.foreshadow_count,
                tension: m.tension,
            });
        }
        Ok(out)
    })
}

// ========== 人物状态账本 ==========

fn state_rows(conn: &Connection, character_id: Option<i64>) -> Result<Vec<CharacterStateSnapshot>> {
    let order = global_chapter_index(conn)?;
    let idx = index_map(&order);
    let mut sql = String::from(
        "SELECT s.id, s.character_id, s.chapter_id, s.location, s.alive, s.affiliation,
                s.knows, s.note, ch.name, c.title
         FROM character_state_snapshots s
         JOIN characters ch ON ch.id = s.character_id
         LEFT JOIN chapters c ON c.id = s.chapter_id
         WHERE 1=1",
    );
    if character_id.is_some() {
        sql.push_str(" AND s.character_id = ?1");
    }
    sql.push_str(" ORDER BY s.character_id, s.id");
    let mut stmt = conn.prepare(&sql)?;
    let map_row = |r: &rusqlite::Row<'_>| {
        Ok((
            r.get::<_, i64>(0)?,
            r.get::<_, i64>(1)?,
            r.get::<_, Option<i64>>(2)?,
            r.get::<_, String>(3)?,
            r.get::<_, Option<i64>>(4)?,
            r.get::<_, String>(5)?,
            r.get::<_, String>(6)?,
            r.get::<_, String>(7)?,
            r.get::<_, String>(8)?,
            r.get::<_, Option<String>>(9)?,
        ))
    };
    let rows: Vec<_> = if let Some(cid) = character_id {
        stmt.query_map(params![cid], map_row)?
            .collect::<rusqlite::Result<_>>()?
    } else {
        stmt.query_map([], map_row)?
            .collect::<rusqlite::Result<_>>()?
    };
    let mut out = Vec::with_capacity(rows.len());
    for r in rows {
        let (id, character_id, chapter_id, location, alive, affiliation, knows, note, ch_name, c_title) =
            r;
        let knows_vec: Vec<String> = serde_json::from_str(&knows).unwrap_or_default();
        out.push(CharacterStateSnapshot {
            id,
            character_id,
            character_name: ch_name,
            chapter_id,
            chapter_title: c_title,
            chapter_order: chapter_id.and_then(|c| idx.get(&c).map(|i| *i as i64)),
            location,
            alive,
            affiliation,
            knows: knows_vec,
            note,
        });
    }
    Ok(out)
}

#[tauri::command]
pub fn list_state_snapshots(
    state: State<'_, AppState>,
    character_id: Option<i64>,
) -> Result<Vec<CharacterStateSnapshot>> {
    state.with_project(|db| state_rows(&db.conn, character_id))
}

#[tauri::command]
pub fn upsert_state_snapshot(
    state: State<'_, AppState>,
    character_id: i64,
    chapter_id: Option<i64>,
    location: Option<String>,
    alive: Option<i64>,
    affiliation: Option<String>,
    knows: Option<Vec<String>>,
    note: Option<String>,
) -> Result<CharacterStateSnapshot> {
    state.with_project(|db| {
        // 同角色 + 同章（含双方皆空）则更新，否则插入
        let existing: Option<i64> = db
            .conn
            .query_row(
                "SELECT id FROM character_state_snapshots
                 WHERE character_id = ?1 AND chapter_id IS ?2
                 LIMIT 1",
                params![character_id, chapter_id],
                |r| r.get(0),
            )
            .ok();
        let knows_json = serde_json::to_string(&knows.unwrap_or_default())
            .unwrap_or_else(|_| "[]".into());
        if let Some(id) = existing {
            db.conn.execute(
                "UPDATE character_state_snapshots SET
                 location = ?1, alive = ?2, affiliation = ?3, knows = ?4, note = ?5,
                 updated_at = datetime('now','localtime')
                 WHERE id = ?6",
                params![
                    location.unwrap_or_default(),
                    alive,
                    affiliation.unwrap_or_default(),
                    knows_json,
                    note.unwrap_or_default(),
                    id
                ],
            )?;
            return state_rows(&db.conn, Some(character_id))?
                .into_iter()
                .find(|s| s.id == id)
                .ok_or_else(|| AppError::Msg("状态快照不存在".into()));
        }
        db.conn.execute(
            "INSERT INTO character_state_snapshots
             (character_id, chapter_id, location, alive, affiliation, knows, note)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                character_id,
                chapter_id,
                location.unwrap_or_default(),
                alive,
                affiliation.unwrap_or_default(),
                knows_json,
                note.unwrap_or_default()
            ],
        )?;
        let id = db.conn.last_insert_rowid();
        state_rows(&db.conn, Some(character_id))?
            .into_iter()
            .find(|s| s.id == id)
            .ok_or_else(|| AppError::Msg("状态快照不存在".into()))
    })
}

#[tauri::command]
pub fn delete_state_snapshot(state: State<'_, AppState>, id: i64) -> Result<()> {
    state.with_project(|db| {
        db.conn.execute(
            "DELETE FROM character_state_snapshots WHERE id = ?1",
            params![id],
        )?;
        Ok(())
    })
}

// ========== POV 轮转仪表盘 ==========

#[tauri::command]
pub fn get_pov_dashboard(
    state: State<'_, AppState>,
    active_arc_id: Option<i64>,
) -> Result<PovDashboard> {
    state.with_project(|db| {
        let metas = roadmap_meta_rows(&db.conn, active_arc_id)?;
        let mut per_chapter = Vec::with_capacity(metas.len());
        let mut chapter_ids = Vec::with_capacity(metas.len());
        let mut runs: std::collections::HashMap<String, (i64, i64)> = std::collections::HashMap::new();
        // name -> (chapter_count, longest_streak)
        let mut last_name = String::new();
        let mut cur_streak = 0i64;
        let mut max_run_len = 0i64;
        let mut max_run_name = String::new();
        let mut last_order: std::collections::HashMap<String, i64> = std::collections::HashMap::new();
        for (i, m) in metas.iter().enumerate() {
            let name = m.pov_name.clone().unwrap_or_else(|| "未指定".into());
            if name == last_name {
                cur_streak += 1;
            } else {
                cur_streak = 1;
                last_name = name.clone();
            }
            if cur_streak > max_run_len {
                max_run_len = cur_streak;
                max_run_name = name.clone();
            }
            let e = runs.entry(name.clone()).or_insert((0, 0));
            e.0 += 1;
            if cur_streak > e.1 {
                e.1 = cur_streak;
            }
            last_order.insert(name.clone(), i as i64);
            per_chapter.push(name);
            chapter_ids.push(m.id);
        }
        let mut stats: Vec<PovStat> = runs
            .into_iter()
            .map(|(name, (count, streak))| {
                let last = last_order.get(&name).copied();
                PovStat {
                    character_id: 0,
                    name,
                    chapter_count: count,
                    longest_streak: streak,
                    last_chapter_order: last,
                }
            })
            .collect();
        stats.sort_by(|a, b| b.chapter_count.cmp(&a.chapter_count));
        Ok(PovDashboard {
            per_chapter,
            chapter_ids,
            stats,
            max_run_len,
            max_run_name,
        })
    })
}

// ========== 设定词条库 ==========

fn lore_rows(conn: &Connection) -> Result<Vec<LoreEntry>> {
    let mut stmt = conn.prepare(
        "SELECT e.id, e.kind, e.title, e.body, e.aliases, e.tags,
                (SELECT COUNT(*) FROM lore_chapter_links l WHERE l.entry_id = e.id)
         FROM lore_entries e
         ORDER BY e.kind, e.title",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok((
            r.get::<_, i64>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
            r.get::<_, String>(3)?,
            r.get::<_, String>(4)?,
            r.get::<_, String>(5)?,
            r.get::<_, i64>(6)?,
        ))
    })?;
    let mut out = Vec::new();
    for row in rows {
        let (id, kind, title, body, aliases, tags, chapter_count) = row?;
        out.push(LoreEntry {
            id,
            kind,
            title,
            body,
            aliases: serde_json::from_str(&aliases).unwrap_or_default(),
            tags: serde_json::from_str(&tags).unwrap_or_default(),
            chapter_count,
        });
    }
    Ok(out)
}

#[tauri::command]
pub fn list_lore_entries(state: State<'_, AppState>) -> Result<Vec<LoreEntry>> {
    state.with_project(|db| lore_rows(&db.conn))
}

#[tauri::command]
pub fn create_lore_entry(
    state: State<'_, AppState>,
    title: String,
    kind: Option<String>,
    body: Option<String>,
    aliases: Option<Vec<String>>,
    tags: Option<Vec<String>>,
) -> Result<LoreEntry> {
    let title = title.trim().to_string();
    if title.is_empty() {
        return Err(AppError::Msg("词条标题不能为空".into()));
    }
    state.with_project(|db| {
        db.conn.execute(
            "INSERT INTO lore_entries (kind, title, body, aliases, tags)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                kind.unwrap_or_else(|| "concept".into()),
                title,
                body.unwrap_or_default(),
                serde_json::to_string(&aliases.unwrap_or_default()).unwrap_or_else(|_| "[]".into()),
                serde_json::to_string(&tags.unwrap_or_default()).unwrap_or_else(|_| "[]".into()),
            ],
        )?;
        let id = db.conn.last_insert_rowid();
        lore_rows(&db.conn)?
            .into_iter()
            .find(|e| e.id == id)
            .ok_or_else(|| AppError::Msg("词条创建失败".into()))
    })
}

#[tauri::command]
pub fn update_lore_entry(
    state: State<'_, AppState>,
    id: i64,
    title: Option<String>,
    kind: Option<String>,
    body: Option<String>,
    aliases: Option<Vec<String>>,
    tags: Option<Vec<String>>,
) -> Result<LoreEntry> {
    state.with_project(|db| {
        if let Some(t) = &title {
            db.conn.execute(
                "UPDATE lore_entries SET title = ?1, updated_at = datetime('now','localtime') WHERE id = ?2",
                params![t, id],
            )?;
        }
        if let Some(k) = &kind {
            db.conn.execute(
                "UPDATE lore_entries SET kind = ?1, updated_at = datetime('now','localtime') WHERE id = ?2",
                params![k, id],
            )?;
        }
        if let Some(b) = &body {
            db.conn.execute(
                "UPDATE lore_entries SET body = ?1, updated_at = datetime('now','localtime') WHERE id = ?2",
                params![b, id],
            )?;
        }
        if let Some(a) = aliases {
            db.conn.execute(
                "UPDATE lore_entries SET aliases = ?1, updated_at = datetime('now','localtime') WHERE id = ?2",
                params![
                    serde_json::to_string(&a).unwrap_or_else(|_| "[]".into()),
                    id
                ],
            )?;
        }
        if let Some(t) = tags {
            db.conn.execute(
                "UPDATE lore_entries SET tags = ?1, updated_at = datetime('now','localtime') WHERE id = ?2",
                params![
                    serde_json::to_string(&t).unwrap_or_else(|_| "[]".into()),
                    id
                ],
            )?;
        }
        lore_rows(&db.conn)?
            .into_iter()
            .find(|e| e.id == id)
            .ok_or_else(|| AppError::Msg("词条不存在".into()))
    })
}

#[tauri::command]
pub fn delete_lore_entry(state: State<'_, AppState>, id: i64) -> Result<()> {
    state.with_project(|db| {
        db.conn
            .execute("DELETE FROM lore_entries WHERE id = ?1", params![id])?;
        Ok(())
    })
}

#[tauri::command]
pub fn link_lore_to_chapter(
    state: State<'_, AppState>,
    entry_id: i64,
    chapter_id: i64,
) -> Result<()> {
    state.with_project(|db| {
        db.conn.execute(
            "INSERT OR IGNORE INTO lore_chapter_links (entry_id, chapter_id) VALUES (?1, ?2)",
            params![entry_id, chapter_id],
        )?;
        Ok(())
    })
}

#[tauri::command]
pub fn unlink_lore_from_chapter(
    state: State<'_, AppState>,
    entry_id: i64,
    chapter_id: i64,
) -> Result<()> {
    state.with_project(|db| {
        db.conn.execute(
            "DELETE FROM lore_chapter_links WHERE entry_id = ?1 AND chapter_id = ?2",
            params![entry_id, chapter_id],
        )?;
        Ok(())
    })
}

#[tauri::command]
pub fn lore_for_chapter(state: State<'_, AppState>, chapter_id: i64) -> Result<Vec<LoreEntry>> {
    state.with_project(|db| {
        let mut stmt = db.conn.prepare(
            "SELECT e.id, e.kind, e.title, e.body, e.aliases, e.tags, 0
             FROM lore_entries e
             JOIN lore_chapter_links l ON l.entry_id = e.id
             WHERE l.chapter_id = ?1
             ORDER BY e.title",
        )?;
        let rows = stmt.query_map(params![chapter_id], |r| {
            Ok(LoreEntry {
                id: r.get(0)?,
                kind: r.get(1)?,
                title: r.get(2)?,
                body: r.get(3)?,
                aliases: serde_json::from_str(&r.get::<_, String>(4)?).unwrap_or_default(),
                tags: serde_json::from_str(&r.get::<_, String>(5)?).unwrap_or_default(),
                chapter_count: r.get(6)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    })
}

// ========== 称谓规范 / 漂移 ==========

fn address_form_rows(conn: &Connection) -> Result<Vec<AddressForm>> {
    let mut stmt = conn.prepare(
        "SELECT a.id, a.from_char, a.to_char, a.form, a.preferred, a.note,
                c1.name, c2.name
         FROM address_forms a
         LEFT JOIN characters c1 ON c1.id = a.from_char
         LEFT JOIN characters c2 ON c2.id = a.to_char
         ORDER BY a.id",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok(AddressForm {
            id: r.get(0)?,
            from_char: r.get(1)?,
            to_char: r.get(2)?,
            form: r.get(3)?,
            preferred: r.get::<_, i64>(4)? != 0,
            note: r.get(5)?,
            from_name: r.get(6)?,
            to_name: r.get(7)?,
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

#[tauri::command]
pub fn list_address_forms(state: State<'_, AppState>) -> Result<Vec<AddressForm>> {
    state.with_project(|db| address_form_rows(&db.conn))
}

#[tauri::command]
pub fn upsert_address_form(
    state: State<'_, AppState>,
    from_char: Option<i64>,
    to_char: Option<i64>,
    form: String,
    preferred: bool,
    note: Option<String>,
) -> Result<Vec<AddressForm>> {
    let form = form.trim().to_string();
    if form.is_empty() {
        return Err(AppError::Msg("称谓不能为空".into()));
    }
    state.with_project(|db| {
        // 同 to_char + form 覆盖更新，避免重复行
        let existing: Option<i64> = db
            .conn
            .query_row(
                "SELECT id FROM address_forms
                 WHERE IFNULL(to_char, -1) = IFNULL(?1, -1) AND form = ?2
                 LIMIT 1",
                params![to_char, form],
                |r| r.get(0),
            )
            .ok();
        if let Some(id) = existing {
            db.conn.execute(
                "UPDATE address_forms SET preferred = ?1, note = ?2, from_char = ?3
                 WHERE id = ?4",
                params![
                    if preferred { 1 } else { 0 },
                    note.unwrap_or_default(),
                    from_char,
                    id
                ],
            )?;
        } else {
            db.conn.execute(
                "INSERT INTO address_forms (from_char, to_char, form, preferred, note)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![
                    from_char,
                    to_char,
                    form,
                    if preferred { 1 } else { 0 },
                    note.unwrap_or_default()
                ],
            )?;
        }
        address_form_rows(&db.conn)
    })
}

#[tauri::command]
pub fn delete_address_form(state: State<'_, AppState>, id: i64) -> Result<()> {
    state.with_project(|db| {
        db.conn
            .execute("DELETE FROM address_forms WHERE id = ?1", params![id])?;
        Ok(())
    })
}

/// 确定性称谓漂移：对每个 to_char，收集所有非 preferred 称谓在章节中的出现。
/// 无 LLM：按 characters.aliases 中「称谓型」别名 + address_forms 非首选项扫描。
#[tauri::command]
pub fn scan_address_drift(state: State<'_, AppState>) -> Result<Vec<AddressDriftHit>> {
    state.with_project(|db| {
        let forms = address_form_rows(&db.conn)?;
        let titles = chapter_titles(&db.conn)?;
        let order = global_chapter_index(&db.conn)?;
        let mut out = Vec::new();
        // 对每个「被称呼角色」，收集非首选称谓
        let mut by_target: std::collections::HashMap<i64, Vec<AddressForm>> =
            std::collections::HashMap::new();
        for f in &forms {
            if !f.preferred {
                if let Some(t) = f.to_char {
                    by_target.entry(t).or_default().push(f.clone());
                }
            }
        }
        if by_target.is_empty() {
            return Ok(out);
        }
        for (to_char, bad_forms) in by_target {
            let char_name: String = db
                .conn
                .query_row(
                    "SELECT name FROM characters WHERE id = ?1",
                    params![to_char],
                    |r| r.get(0),
                )
                .unwrap_or_default();
            // 首选称谓：同 target 的 preferred
            let preferred = forms
                .iter()
                .find(|f| f.to_char == Some(to_char) && f.preferred)
                .map(|f| f.form.clone())
                .unwrap_or_else(|| char_name.clone());
            for cid in &order {
                let content: String = db
                    .conn
                    .query_row(
                        "SELECT content FROM chapters WHERE id = ?1",
                        params![cid],
                        |r| r.get(0),
                    )
                    .unwrap_or_default();
                for bf in &bad_forms {
                    if bf.form.is_empty() {
                        continue;
                    }
                    let count = content.matches(&bf.form).count() as i64;
                    if count == 0 {
                        continue;
                    }
                    // 按字符边界截取片段，避免中文 UTF-8 字节切片 panic
                    let pos = content.find(&bf.form).unwrap_or(0);
                    let starts: Vec<usize> =
                        content.char_indices().map(|(i, _)| i).collect();
                    let end_bound = starts
                        .iter()
                        .copied()
                        .find(|&i| i > pos)
                        .unwrap_or(content.len());
                    let mut before = 0usize;
                    let mut after = starts.len();
                    for (i, b) in starts.iter().enumerate() {
                        if *b <= pos {
                            before = i;
                        }
                        if *b >= end_bound {
                            after = i;
                            break;
                        }
                    }
                    let a = before.saturating_sub(20);
                    let b = (after + 20).min(starts.len());
                    let snippet: String = starts[a..b]
                        .iter()
                        .filter_map(|&i| content[i..].chars().next())
                        .collect();
                    out.push(AddressDriftHit {
                        character_id: to_char,
                        character_name: char_name.clone(),
                        form: bf.form.clone(),
                        preferred: preferred.clone(),
                        chapter_id: *cid,
                        chapter_title: titles.get(cid).cloned().unwrap_or_default(),
                        count,
                        snippet: snippet.replace('\n', " "),
                    });
                }
            }
        }
        out.sort_by(|a, b| b.count.cmp(&a.count));
        Ok(out)
    })
}

// ========== 龙套批量铸造 ==========

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchCharacterItem {
    pub name: String,
    pub role: Option<String>,
    pub faction: Option<String>,
    pub importance: Option<i64>,
    pub tags: Option<Vec<String>>,
}

#[tauri::command]
pub fn batch_create_characters(
    state: State<'_, AppState>,
    items: Vec<BatchCharacterItem>,
) -> Result<BatchCharacterResult> {
    if items.is_empty() {
        return Err(AppError::Msg("列表为空".into()));
    }
    state.with_project(|db| {
        let tx = db.conn.unchecked_transaction()?;
        let mut ids = Vec::new();
        for item in &items {
            let name = item.name.trim().to_string();
            if name.is_empty() {
                continue;
            }
            // 唯一名：冲突则加后缀
            let mut final_name = name.clone();
            let mut n = 2;
            loop {
                let exists: i64 = tx.query_row(
                    "SELECT COUNT(*) FROM characters WHERE name = ?1",
                    params![final_name],
                    |r| r.get(0),
                )?;
                if exists == 0 {
                    break;
                }
                final_name = format!("{name} {n}");
                n += 1;
                if n > 999 {
                    return Err(AppError::Msg("无法生成唯一角色名".into()));
                }
            }
            tx.execute(
                "INSERT INTO characters (name, role, faction, importance, tags)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![
                    final_name,
                    item.role.clone().unwrap_or_else(|| "龙套".into()),
                    item.faction.clone().unwrap_or_default(),
                    item.importance.unwrap_or(0),
                    serde_json::to_string(&item.tags.clone().unwrap_or_default())
                        .unwrap_or_else(|_| "[]".into()),
                ],
            )?;
            ids.push(tx.last_insert_rowid());
        }
        tx.commit()?;
        Ok(BatchCharacterResult {
            created: ids.len() as i64,
            ids,
        })
    })
}

// ========== 文风指纹 ==========

#[tauri::command]
pub fn get_style_fingerprint(
    state: State<'_, AppState>,
    chapter_id: Option<i64>,
) -> Result<StyleFingerprint> {
    state.with_project(|db| {
        let contents: Vec<String> = if let Some(cid) = chapter_id {
            vec![db.conn.query_row(
                "SELECT content FROM chapters WHERE id = ?1 AND deleted_at IS NULL",
                params![cid],
                |r| r.get(0),
            )?]
        } else {
            let mut stmt = db.conn.prepare(
                "SELECT content FROM chapters WHERE deleted_at IS NULL
                 ORDER BY volume_id, sort_order",
            )?;
            let collected: Vec<String> = stmt
                .query_map([], |r| r.get::<_, String>(0))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            collected
        };
        let mut total_chars = 0i64;
        let mut dialogue_chars = 0i64;
        let mut para_lens = Vec::new();
        let mut sentence_lens = Vec::new();
        let mut long_sentences = 0i64;
        let mut sentence_count = 0i64;
        let mut adverb_hits: std::collections::HashMap<String, i64> =
            std::collections::HashMap::new();
        let particles = ["的", "了", "着", "地", "得"];
        let mut particle_hits: std::collections::HashMap<String, i64> =
            std::collections::HashMap::new();
        const LONG_SENT: usize = 40;
        for content in &contents {
            for para in content.split('\n').filter(|p| !p.trim().is_empty()) {
                let plen = para.chars().count() as i64;
                para_lens.push(plen);
                total_chars += plen;
                // 引号内计为对白
                let mut in_quote = false;
                let mut sent = 0usize;
                for ch in para.chars() {
                    if ch == '“' || ch == '「' {
                        in_quote = true;
                    } else if ch == '”' || ch == '」' {
                        in_quote = false;
                    }
                    if in_quote {
                        dialogue_chars += 1;
                    }
                    if ch == '。' || ch == '！' || ch == '？' || ch == '…' {
                        sentence_count += 1;
                        sentence_lens.push(sent as i64);
                        if sent >= LONG_SENT {
                            long_sentences += 1;
                        }
                        sent = 0;
                    } else {
                        sent += 1;
                    }
                }
                if sent > 0 {
                    sentence_count += 1;
                    sentence_lens.push(sent as i64);
                    if sent >= LONG_SENT {
                        long_sentences += 1;
                    }
                }
                for p in particles {
                    *particle_hits.entry(p.to_string()).or_default() += para.matches(p).count() as i64;
                }
                // 高频「地+动」近似：以「地」结尾的双字
                for w in ["地", "慢慢", "缓缓", "突然", "忽然", "竟然", "似乎"] {
                    let c = para.matches(w).count() as i64;
                    if c > 0 {
                        *adverb_hits.entry(w.to_string()).or_default() += c;
                    }
                }
            }
        }
        let avg_para = if para_lens.is_empty() {
            0.0
        } else {
            para_lens.iter().sum::<i64>() as f64 / para_lens.len() as f64
        };
        let avg_sent = if sentence_lens.is_empty() {
            0.0
        } else {
            sentence_lens.iter().sum::<i64>() as f64 / sentence_lens.len() as f64
        };
        let long_ratio = if sentence_count == 0 {
            0.0
        } else {
            long_sentences as f64 / sentence_count as f64
        };
        let dialogue_ratio = if total_chars == 0 {
            0.0
        } else {
            dialogue_chars as f64 / total_chars as f64
        };
        let mut top_adverbs: Vec<(String, i64)> = adverb_hits.into_iter().collect();
        top_adverbs.sort_by(|a, b| b.1.cmp(&a.1));
        top_adverbs.truncate(8);
        let mut top_particles: Vec<(String, i64)> = particle_hits.into_iter().collect();
        top_particles.sort_by(|a, b| b.1.cmp(&a.1));
        top_particles.truncate(5);
        Ok(StyleFingerprint {
            total_words: total_chars,
            dialogue_ratio,
            avg_paragraph_len: avg_para,
            avg_sentence_len: avg_sent,
            long_sentence_ratio: long_ratio,
            top_adverbs,
            top_particles,
        })
    })
}

// ========== 结构快照 ==========

fn structure_payload(conn: &Connection) -> Result<serde_json::Value> {
    let volumes: Vec<serde_json::Value> = {
        let mut stmt =
            conn.prepare("SELECT id, title, sort_order FROM volumes ORDER BY sort_order")?;
        let collected: Vec<serde_json::Value> = stmt
            .query_map([], |r| {
                Ok(serde_json::json!({
                    "id": r.get::<_, i64>(0)?,
                    "title": r.get::<_, String>(1)?,
                    "sortOrder": r.get::<_, i64>(2)?,
                }))
            })?
            .collect::<rusqlite::Result<_>>()?;
        collected
    };
    let chapters: Vec<serde_json::Value> = {
        let mut stmt = conn.prepare(
            "SELECT id, volume_id, title, sort_order, board_lane, story_time, story_order,
                    tension, pov_character_id, target_words
             FROM chapters WHERE deleted_at IS NULL
             ORDER BY volume_id, sort_order",
        )?;
        let collected: Vec<serde_json::Value> = stmt
            .query_map([], |r| {
                Ok(serde_json::json!({
                    "id": r.get::<_, i64>(0)?,
                    "volumeId": r.get::<_, i64>(1)?,
                    "title": r.get::<_, String>(2)?,
                    "sortOrder": r.get::<_, i64>(3)?,
                    "boardLane": r.get::<_, i64>(4)?,
                    "storyTime": r.get::<_, String>(5)?,
                    "storyOrder": r.get::<_, Option<f64>>(6)?,
                    "tension": r.get::<_, Option<i64>>(7)?,
                    "pov": r.get::<_, Option<i64>>(8)?,
                    "targetWords": r.get::<_, i64>(9)?,
                }))
            })?
            .collect::<rusqlite::Result<_>>()?;
        collected
    };
    let foreshadows = load_foreshadows(conn)?;
    Ok(serde_json::json!({
        "volumes": volumes,
        "chapters": chapters,
        "foreshadows": foreshadows,
    }))
}

fn snapshot_meta_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<StructureSnapshotMeta> {
    let payload: String = r.get(2)?;
    let parsed: serde_json::Value = serde_json::from_str(&payload).unwrap_or_default();
    Ok(StructureSnapshotMeta {
        id: r.get(0)?,
        label: r.get(1)?,
        created_at: r.get(3)?,
        volume_count: parsed["volumes"].as_array().map(|a| a.len() as i64).unwrap_or(0),
        chapter_count: parsed["chapters"].as_array().map(|a| a.len() as i64).unwrap_or(0),
        foreshadow_count: parsed["foreshadows"].as_array().map(|a| a.len() as i64).unwrap_or(0),
    })
}

#[tauri::command]
pub fn create_structure_snapshot(
    state: State<'_, AppState>,
    label: Option<String>,
) -> Result<StructureSnapshotMeta> {
    state.with_project(|db| {
        let payload = structure_payload(&db.conn)?;
        let label = label.unwrap_or_else(|| "手动快照".into());
        db.conn.execute(
            "INSERT INTO structure_snapshots (label, payload) VALUES (?1, ?2)",
            params![label, payload.to_string()],
        )?;
        let id = db.conn.last_insert_rowid();
        let mut stmt = db.conn.prepare(
            "SELECT id, label, payload, created_at FROM structure_snapshots WHERE id = ?1",
        )?;
        let meta = stmt.query_row(params![id], snapshot_meta_row)?;
        Ok(meta)
    })
}

#[tauri::command]
pub fn list_structure_snapshots(state: State<'_, AppState>) -> Result<Vec<StructureSnapshotMeta>> {
    state.with_project(|db| {
        let mut stmt = db.conn.prepare(
            "SELECT id, label, payload, created_at FROM structure_snapshots
             ORDER BY id DESC LIMIT 50",
        )?;
        let rows = stmt.query_map([], snapshot_meta_row)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    })
}

#[tauri::command]
pub fn get_structure_snapshot(
    state: State<'_, AppState>,
    id: i64,
) -> Result<serde_json::Value> {
    state.with_project(|db| {
        let payload: String = db.conn.query_row(
            "SELECT payload FROM structure_snapshots WHERE id = ?1",
            params![id],
            |r| r.get(0),
        )?;
        Ok(serde_json::from_str(&payload).unwrap_or_default())
    })
}

#[tauri::command]
pub fn delete_structure_snapshot(state: State<'_, AppState>, id: i64) -> Result<()> {
    state.with_project(|db| {
        db.conn.execute(
            "DELETE FROM structure_snapshots WHERE id = ?1",
            params![id],
        )?;
        Ok(())
    })
}

// ========== 张力：一键按章批量写入 ==========

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TensionPoint {
    pub chapter_id: i64,
    pub tension: i64,
}

#[tauri::command]
pub fn set_tension_points(
    state: State<'_, AppState>,
    points: Vec<TensionPoint>,
) -> Result<()> {
    state.with_project(|db| {
        let tx = db.conn.unchecked_transaction()?;
        for p in points {
            tx.execute(
                "UPDATE chapters SET tension = ?1, updated_at = datetime('now','localtime')
                 WHERE id = ?2",
                params![p.tension, p.chapter_id],
            )?;
        }
        tx.commit()?;
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::migrations::apply(&conn).unwrap();
        conn.execute("INSERT INTO volumes (id, title) VALUES (1, '卷一')", [])
            .unwrap();
        conn.execute(
            "INSERT INTO chapters (id, volume_id, title, content, sort_order)
             VALUES (1, 1, '第一章', '林默走进青云宗。', 0)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO chapters (id, volume_id, title, content, sort_order)
             VALUES (2, 1, '第二章', '林默修炼。', 1)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO characters (id, name) VALUES (1, '林默')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO story_arcs (id, title, kind) VALUES (1, '主线', 0)",
            [],
        )
        .unwrap();
        conn
    }

    #[test]
    fn foreshadow_ledger_crud_and_overdue() {
        let conn = fixture_db();
        conn.execute(
            "INSERT INTO foreshadows (title, foreshadow_type, plant_chapter_id, expect_chapter_id, status)
             VALUES ('玉佩裂痕', 1, 1, 2, 0)",
            [],
        )
        .unwrap();
        let list = load_foreshadows(&conn).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].title, "玉佩裂痕");
        assert_eq!(list[0].span, 1);
        assert!(!list[0].overdue);

        // 阈值改 0 后跨度 1 即逾期
        conn.execute(
            "INSERT INTO settings (key, value) VALUES ('foreshadow_overdue_threshold', '0')",
            [],
        )
        .unwrap();
        let list = load_foreshadows(&conn).unwrap();
        assert!(list[0].overdue);
    }

    #[test]
    fn chapter_arc_filter_shows_only_members() {
        let conn = fixture_db();
        conn.execute(
            "INSERT INTO chapter_arc_members (chapter_id, arc_id, is_primary) VALUES (1, 1, 1)",
            [],
        )
        .unwrap();
        let all = roadmap_meta_rows(&conn, None).unwrap();
        assert_eq!(all.len(), 2);
        let filtered = roadmap_meta_rows(&conn, Some(1)).unwrap();
        assert_eq!(filtered.len(), 1);
        assert_eq!(filtered[0].id, 1);
        assert_eq!(filtered[0].arc_ids, vec![1]);
    }

    #[test]
    fn state_snapshot_upsert_by_chapter() {
        let conn = fixture_db();
        conn.execute(
            "INSERT INTO character_state_snapshots
             (character_id, chapter_id, location, alive, affiliation, knows, note)
             VALUES (1, 1, '青云宗', 1, '外门', '[\"玉佩\"]', '')",
            [],
        )
        .unwrap();
        let rows = state_rows(&conn, Some(1)).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].location, "青云宗");
        assert_eq!(rows[0].knows, vec!["玉佩".to_string()]);
    }

    #[test]
    fn scan_snippet_is_char_safe_for_cjk() {
        // 回归：中文 UTF-8 不得在字节切片上 panic
        let content = "他看着手中的玉佩，心里想：「师父为何不说破？」沉默良久。";
        let form = "师父";
        let pos = content.find(form).unwrap();
        let starts: Vec<usize> = content.char_indices().map(|(i, _)| i).collect();
        assert!(starts.contains(&pos));
        let a = 0usize;
        let b = starts.len().min(40);
        let snippet: String = starts[a..b]
            .iter()
            .filter_map(|&i| content[i..].chars().next())
            .collect();
        assert!(snippet.contains("师父"));
    }

    #[test]
    fn v19_migration_reaches_current() {
        let conn = fixture_db();
        let v: i64 = conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        assert!(v >= 19);
        let n: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name IN
                 ('foreshadows','chapter_arc_members','character_state_snapshots','lore_entries','address_forms','structure_snapshots')",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(n, 6);
    }
}
