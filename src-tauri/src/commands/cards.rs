//! 人物 / 地点卡命令（阶段 6）：作者手动建卡 + 精确匹配统计。
//!
//! 与阶段 5 的本质区别：不做实体识别（无语义理解，精度不可达），
//! 所有实体由作者显式创建；引擎只负责「这个名字在正文出现了几次」——
//! 精确匹配（见 [`crate::matching`]），确定性、零误判、零确认流程。
//!
//! 提及计数的更新时机：
//! - `save_chapter` 事务内重算本章（增量，见 [`update_chapter_mentions`]）
//! - add / update 后全量重算该卡（仅一张卡，量小）
//! - [`rebuild_mentions`] 全量重建（V3 迁移后 / 数据异常时兜底）

use crate::commands::AppState;
use crate::error::{AppError, Result};
use crate::matching::count_occurrences;
use crate::models::{
    ChapterPresenceView, CharacterHeat, CharacterProfile, EntityMentionView, LocationProfile,
};
use rusqlite::{params, Connection};
use tauri::State;

// ---------- 内部工具 ----------

/// 解析 characters.aliases（JSON 数组）为字符串列表
fn parse_aliases(json: &str) -> Vec<String> {
    serde_json::from_str(json).unwrap_or_default()
}

/// 人物的全部匹配词：名字 + 别名
fn character_patterns(name: &str, aliases: &[String]) -> Vec<String> {
    let mut v = Vec::with_capacity(aliases.len() + 1);
    v.push(name.to_string());
    v.extend(aliases.iter().cloned());
    v
}

/// 全书章节顺序（卷序 → 章序 → id）
fn chapter_order(conn: &Connection) -> Result<Vec<i64>> {
    let mut stmt = conn.prepare(
        "SELECT c.id FROM chapters c
         JOIN volumes v ON v.id = c.volume_id
         WHERE c.deleted_at IS NULL
         ORDER BY v.sort_order, c.sort_order, c.id",
    )?;
    let ids = stmt
        .query_map([], |r| r.get::<_, i64>(0))?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(ids)
}

/// 章节首/末出现的查询结果：character_id → (first_title, last_title)
type ChapterEnds = std::collections::HashMap<i64, (Option<i64>, String, Option<i64>, String)>;

/// 按全书顺序计算每个实体的首/末出现章节（mentioned > 0 的章）
fn chapter_ends(conn: &Connection, table: &str, key_col: &str) -> Result<ChapterEnds> {
    let sql = format!(
        "SELECT m.{key_col}, c.id, c.title
         FROM {table} m
         JOIN chapters c ON c.id = m.chapter_id
         JOIN volumes v ON v.id = c.volume_id
         WHERE m.mention_count > 0
         ORDER BY v.sort_order, c.sort_order, c.id"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt
        .query_map([], |r| {
            Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?, r.get::<_, String>(2)?))
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    let mut map: ChapterEnds = std::collections::HashMap::new();
    for (entity_id, ch_id, ch_title) in rows {
        map.entry(entity_id)
            .and_modify(|e| {
                e.2 = Some(ch_id);
                e.3 = ch_title.clone();
            })
            .or_insert((Some(ch_id), ch_title.clone(), Some(ch_id), ch_title));
    }
    Ok(map)
}

/// 单章提及重算（save_chapter 事务内调用）：删旧 → 精确匹配 → 插新
pub(crate) fn update_chapter_mentions(
    conn: &Connection,
    chapter_id: i64,
    content: &str,
) -> Result<()> {
    // 人物（名字 + 别名）
    let characters: Vec<(i64, Vec<String>)> = {
        let mut stmt =
            conn.prepare("SELECT id, name, aliases FROM characters")?;
        let rows = stmt
            .query_map([], |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    character_patterns(&r.get::<_, String>(1)?, &parse_aliases(&r.get::<_, String>(2)?)),
                ))
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        rows
    };
    conn.execute(
        "DELETE FROM character_mentions WHERE chapter_id = ?1",
        params![chapter_id],
    )?;
    for (cid, pats) in &characters {
        let n = count_occurrences(content, pats);
        if n > 0 {
            conn.execute(
                "INSERT INTO character_mentions (character_id, chapter_id, mention_count)
                 VALUES (?1, ?2, ?3)",
                params![cid, chapter_id, n as i64],
            )?;
        }
    }

    // 地点
    let locations: Vec<(i64, String)> = {
        let mut stmt = conn.prepare("SELECT id, name FROM locations")?;
        let rows = stmt
            .query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        rows
    };
    conn.execute(
        "DELETE FROM location_mentions WHERE chapter_id = ?1",
        params![chapter_id],
    )?;
    for (lid, name) in &locations {
        let n = count_occurrences(content, &[name.clone()]);
        if n > 0 {
            conn.execute(
                "INSERT INTO location_mentions (location_id, chapter_id, mention_count)
                 VALUES (?1, ?2, ?3)",
                params![lid, chapter_id, n as i64],
            )?;
        }
    }
    Ok(())
}

/// 单张人物卡的全量重算（add / update 后调用）
fn rescan_character(conn: &Connection, character_id: i64) -> Result<()> {
    let (name, aliases_json): (String, String) = conn.query_row(
        "SELECT name, aliases FROM characters WHERE id = ?1",
        params![character_id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    let pats = character_patterns(&name, &parse_aliases(&aliases_json));

    let chapters: Vec<(i64, String)> = {
        let mut stmt = conn.prepare("SELECT id, content FROM chapters WHERE deleted_at IS NULL")?;
        let rows = stmt
            .query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        rows
    };
    conn.execute(
        "DELETE FROM character_mentions WHERE character_id = ?1",
        params![character_id],
    )?;
    for (ch_id, content) in &chapters {
        let n = count_occurrences(content, &pats);
        if n > 0 {
            conn.execute(
                "INSERT INTO character_mentions (character_id, chapter_id, mention_count)
                 VALUES (?1, ?2, ?3)",
                params![character_id, ch_id, n as i64],
            )?;
        }
    }
    Ok(())
}

/// 单张地点卡的全量重算
fn rescan_location(conn: &Connection, location_id: i64) -> Result<()> {
    let name: String = conn.query_row(
        "SELECT name FROM locations WHERE id = ?1",
        params![location_id],
        |r| r.get(0),
    )?;
    let chapters: Vec<(i64, String)> = {
        let mut stmt = conn.prepare("SELECT id, content FROM chapters WHERE deleted_at IS NULL")?;
        let rows = stmt
            .query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        rows
    };
    conn.execute(
        "DELETE FROM location_mentions WHERE location_id = ?1",
        params![location_id],
    )?;
    for (ch_id, content) in &chapters {
        let n = count_occurrences(content, &[name.clone()]);
        if n > 0 {
            conn.execute(
                "INSERT INTO location_mentions (location_id, chapter_id, mention_count)
                 VALUES (?1, ?2, ?3)",
                params![location_id, ch_id, n as i64],
            )?;
        }
    }
    Ok(())
}

/// 人物档案组装：基础行 + 聚合统计 + 首末章
fn build_character_profiles(conn: &Connection) -> Result<Vec<CharacterProfile>> {
    let mut stmt =
        conn.prepare("SELECT id, name, aliases, role, notes FROM characters ORDER BY name")?;
    let base = stmt
        .query_map([], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, String>(4)?,
            ))
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;

    // 聚合统计
    let mut agg: std::collections::HashMap<i64, (i64, i64)> = std::collections::HashMap::new();
    {
        let mut s = conn.prepare(
            "SELECT character_id, COALESCE(SUM(mention_count),0), COUNT(*)
             FROM character_mentions GROUP BY character_id",
        )?;
        let rows = s
            .query_map([], |r| {
                Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?, r.get::<_, i64>(2)?))
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        for (id, total, chapters) in rows {
            agg.insert(id, (total, chapters));
        }
    }
    let ends = chapter_ends(conn, "character_mentions", "character_id")?;

    Ok(base
        .into_iter()
        .map(|(id, name, aliases, role, notes)| {
            let (total, ch_count) = agg.get(&id).copied().unwrap_or((0, 0));
            let end = ends.get(&id);
            CharacterProfile {
                id,
                name,
                aliases: parse_aliases(&aliases),
                role,
                notes,
                total_mentions: total,
                chapter_count: ch_count,
                first_chapter_id: end.and_then(|e| e.0),
                first_chapter_title: end.map(|e| e.1.clone()),
                last_chapter_id: end.and_then(|e| e.2),
                last_chapter_title: end.map(|e| e.3.clone()),
            }
        })
        .collect())
}

/// 地点档案组装
fn build_location_profiles(conn: &Connection) -> Result<Vec<LocationProfile>> {
    let mut stmt = conn.prepare("SELECT id, name, notes FROM locations ORDER BY name")?;
    let base = stmt
        .query_map([], |r| {
            Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?))
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;

    let mut agg: std::collections::HashMap<i64, (i64, i64)> = std::collections::HashMap::new();
    {
        let mut s = conn.prepare(
            "SELECT location_id, COALESCE(SUM(mention_count),0), COUNT(*)
             FROM location_mentions GROUP BY location_id",
        )?;
        let rows = s
            .query_map([], |r| {
                Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?, r.get::<_, i64>(2)?))
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        for (id, total, chapters) in rows {
            agg.insert(id, (total, chapters));
        }
    }
    let ends = chapter_ends(conn, "location_mentions", "location_id")?;

    Ok(base
        .into_iter()
        .map(|(id, name, notes)| {
            let (total, ch_count) = agg.get(&id).copied().unwrap_or((0, 0));
            let end = ends.get(&id);
            LocationProfile {
                id,
                name,
                notes,
                total_mentions: total,
                chapter_count: ch_count,
                first_chapter_title: end.map(|e| e.1.clone()),
                last_chapter_title: end.map(|e| e.3.clone()),
            }
        })
        .collect())
}

// ---------- 人物卡 ----------

/// 人物列表（含全书聚合统计）
#[tauri::command]
pub fn list_characters(state: State<'_, AppState>) -> Result<Vec<CharacterProfile>> {
    state.with_project(|db| build_character_profiles(&db.conn))
}

/// 新建人物卡（手动建卡，建后立即全量统计该卡）
#[tauri::command]
pub fn add_character(
    state: State<'_, AppState>,
    name: String,
    aliases: Option<Vec<String>>,
    role: Option<String>,
    notes: Option<String>,
) -> Result<CharacterProfile> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err(AppError::Msg("人物名字不能为空".into()));
    }
    let aliases: Vec<String> = aliases
        .unwrap_or_default()
        .iter()
        .map(|a| a.trim().to_string())
        .filter(|a| !a.is_empty() && *a != name)
        .collect();
    let aliases_json = serde_json::to_string(&aliases).unwrap_or_else(|_| "[]".into());

    state.with_project(|db| {
        let tx = db.conn.unchecked_transaction()?;
        tx.execute(
            "INSERT INTO characters (name, aliases, status, role, notes) VALUES (?1, ?2, 1, ?3, ?4)",
            params![
                name,
                aliases_json,
                role.unwrap_or_default(),
                notes.unwrap_or_default()
            ],
        )
        .map_err(|e| match e {
            rusqlite::Error::SqliteFailure(err, _)
                if err.code == rusqlite::ErrorCode::ConstraintViolation =>
            {
                AppError::Msg(format!("人物「{name}」已存在"))
            }
            other => other.into(),
        })?;
        let id = tx.last_insert_rowid();
        rescan_character(&tx, id)?;
        tx.commit()?;

        build_character_profiles(&db.conn)?
            .into_iter()
            .find(|c| c.id == id)
            .ok_or_else(|| AppError::Msg("新建人物读取失败".into()))
    })
}

/// 更新人物卡（名字/别名变化后重算该卡统计）
#[tauri::command]
pub fn update_character(
    state: State<'_, AppState>,
    character_id: i64,
    name: Option<String>,
    aliases: Option<Vec<String>>,
    role: Option<String>,
    notes: Option<String>,
) -> Result<()> {
    state.with_project(|db| {
        let exists: i64 = db.conn.query_row(
            "SELECT COUNT(*) FROM characters WHERE id = ?1",
            params![character_id],
            |r| r.get(0),
        )?;
        if exists == 0 {
            return Err(AppError::Msg("人物不存在".into()));
        }

        let mut rescan = false;
        if let Some(n) = name {
            let n = n.trim().to_string();
            if n.is_empty() {
                return Err(AppError::Msg("人物名字不能为空".into()));
            }
            db.conn.execute(
                "UPDATE characters SET name = ?1, updated_at = datetime('now','localtime') WHERE id = ?2",
                params![n, character_id],
            )?;
            rescan = true;
        }
        if let Some(list) = aliases {
            let cleaned: Vec<String> = list
                .iter()
                .map(|a| a.trim().to_string())
                .filter(|a| !a.is_empty())
                .collect();
            let json = serde_json::to_string(&cleaned).unwrap_or_else(|_| "[]".into());
            db.conn.execute(
                "UPDATE characters SET aliases = ?1, updated_at = datetime('now','localtime') WHERE id = ?2",
                params![json, character_id],
            )?;
            rescan = true;
        }
        if let Some(r) = role {
            db.conn.execute(
                "UPDATE characters SET role = ?1, updated_at = datetime('now','localtime') WHERE id = ?2",
                params![r, character_id],
            )?;
        }
        if let Some(n) = notes {
            db.conn.execute(
                "UPDATE characters SET notes = ?1, updated_at = datetime('now','localtime') WHERE id = ?2",
                params![n, character_id],
            )?;
        }
        if rescan {
            rescan_character(&db.conn, character_id)?;
        }
        Ok(())
    })
}

/// 删除人物卡（提及记录外键级联删除）
#[tauri::command]
pub fn delete_character(state: State<'_, AppState>, character_id: i64) -> Result<()> {
    state.with_project(|db| {
        let n = db.conn.execute(
            "DELETE FROM characters WHERE id = ?1",
            params![character_id],
        )?;
        if n == 0 {
            return Err(AppError::Msg("人物不存在".into()));
        }
        Ok(())
    })
}

/// 人物热度：按全书章节顺序的出现次数序列 + 断档预警
#[tauri::command]
pub fn get_character_heat(
    state: State<'_, AppState>,
    character_id: i64,
) -> Result<CharacterHeat> {
    state.with_project(|db| {
        let name: String = db
            .conn
            .query_row(
                "SELECT name FROM characters WHERE id = ?1",
                params![character_id],
                |r| r.get(0),
            )
            .map_err(|_| AppError::Msg("人物不存在".into()))?;

        let order = chapter_order(&db.conn)?;
        let mut counts: std::collections::HashMap<i64, i64> = std::collections::HashMap::new();
        {
            let mut stmt = db.conn.prepare(
                "SELECT chapter_id, mention_count FROM character_mentions WHERE character_id = ?1",
            )?;
            let rows = stmt
                .query_map(params![character_id], |r| {
                    Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?))
                })?
                .collect::<std::result::Result<Vec<_>, _>>()?;
            for (ch, n) in rows {
                counts.insert(ch, n);
            }
        }

        let per_chapter: Vec<i64> = order
            .iter()
            .map(|id| counts.get(id).copied().unwrap_or(0))
            .collect();
        let absent_streak = per_chapter
            .iter()
            .rev()
            .take_while(|n| **n == 0)
            .count() as i64;

        Ok(CharacterHeat {
            character_id,
            name,
            per_chapter,
            absent_streak,
        })
    })
}

// ---------- 地点卡 ----------

/// 地点列表（含全书聚合统计）
#[tauri::command]
pub fn list_locations(state: State<'_, AppState>) -> Result<Vec<LocationProfile>> {
    state.with_project(|db| build_location_profiles(&db.conn))
}

/// 新建地点卡
#[tauri::command]
pub fn add_location(
    state: State<'_, AppState>,
    name: String,
    notes: Option<String>,
) -> Result<LocationProfile> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err(AppError::Msg("地点名字不能为空".into()));
    }
    state.with_project(|db| {
        let tx = db.conn.unchecked_transaction()?;
        tx.execute(
            "INSERT INTO locations (name, status, notes) VALUES (?1, 1, ?2)",
            params![name, notes.unwrap_or_default()],
        )
        .map_err(|e| match e {
            rusqlite::Error::SqliteFailure(err, _)
                if err.code == rusqlite::ErrorCode::ConstraintViolation =>
            {
                AppError::Msg(format!("地点「{name}」已存在"))
            }
            other => other.into(),
        })?;
        let id = tx.last_insert_rowid();
        rescan_location(&tx, id)?;
        tx.commit()?;

        build_location_profiles(&db.conn)?
            .into_iter()
            .find(|l| l.id == id)
            .ok_or_else(|| AppError::Msg("新建地点读取失败".into()))
    })
}

/// 更新地点卡
#[tauri::command]
pub fn update_location(
    state: State<'_, AppState>,
    location_id: i64,
    name: Option<String>,
    notes: Option<String>,
) -> Result<()> {
    state.with_project(|db| {
        let exists: i64 = db.conn.query_row(
            "SELECT COUNT(*) FROM locations WHERE id = ?1",
            params![location_id],
            |r| r.get(0),
        )?;
        if exists == 0 {
            return Err(AppError::Msg("地点不存在".into()));
        }
        let mut rescan = false;
        if let Some(n) = name {
            let n = n.trim().to_string();
            if n.is_empty() {
                return Err(AppError::Msg("地点名字不能为空".into()));
            }
            db.conn.execute(
                "UPDATE locations SET name = ?1, updated_at = datetime('now','localtime') WHERE id = ?2",
                params![n, location_id],
            )?;
            rescan = true;
        }
        if let Some(n) = notes {
            db.conn.execute(
                "UPDATE locations SET notes = ?1, updated_at = datetime('now','localtime') WHERE id = ?2",
                params![n, location_id],
            )?;
        }
        if rescan {
            rescan_location(&db.conn, location_id)?;
        }
        Ok(())
    })
}

/// 删除地点卡
#[tauri::command]
pub fn delete_location(state: State<'_, AppState>, location_id: i64) -> Result<()> {
    state.with_project(|db| {
        let n = db.conn.execute(
            "DELETE FROM locations WHERE id = ?1",
            params![location_id],
        )?;
        if n == 0 {
            return Err(AppError::Msg("地点不存在".into()));
        }
        Ok(())
    })
}

// ---------- 章内出场 ----------

/// 本章出场（实时精确匹配当前正文，按次数降序）
#[tauri::command]
pub fn get_chapter_presence(
    state: State<'_, AppState>,
    chapter_id: i64,
) -> Result<ChapterPresenceView> {
    state.with_project(|db| {
        let content: String = db
            .conn
            .query_row(
                "SELECT content FROM chapters WHERE id = ?1",
                params![chapter_id],
                |r| r.get(0),
            )
            .map_err(|_| AppError::Msg("章节不存在".into()))?;

        let mut characters: Vec<EntityMentionView> = {
            let mut stmt = db
                .conn
                .prepare("SELECT id, name, aliases FROM characters")?;
            let rows = stmt
                .query_map([], |r| {
                    Ok((
                        r.get::<_, i64>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, String>(2)?,
                    ))
                })?
                .collect::<std::result::Result<Vec<_>, _>>()?;
            rows.into_iter()
                .map(|(id, name, aliases)| EntityMentionView {
                    id,
                    mention_count: count_occurrences(
                        &content,
                        &character_patterns(&name, &parse_aliases(&aliases)),
                    ) as i64,
                    name,
                })
                .filter(|m| m.mention_count > 0)
                .collect()
        };
        characters.sort_by(|a, b| b.mention_count.cmp(&a.mention_count));

        let mut locations: Vec<EntityMentionView> = {
            let mut stmt = db.conn.prepare("SELECT id, name FROM locations")?;
            let rows = stmt
                .query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))?
                .collect::<std::result::Result<Vec<_>, _>>()?;
            rows.into_iter()
                .map(|(id, name)| EntityMentionView {
                    id,
                    mention_count: count_occurrences(&content, &[name.clone()]) as i64,
                    name,
                })
                .filter(|m| m.mention_count > 0)
                .collect()
        };
        locations.sort_by(|a, b| b.mention_count.cmp(&a.mention_count));

        Ok(ChapterPresenceView {
            chapter_id,
            characters,
            locations,
        })
    })
}

/// 全量重建提及统计（后台线程计算计数，主线程短事务写入）。
/// 用于 V3 迁移后的首次打开、或统计口径异常时的兜底修复。
#[tauri::command]
pub async fn rebuild_mentions(state: State<'_, AppState>) -> Result<i64> {
    // 第一阶段：读全量数据（同步，持锁时间短）
    let (chapters, characters, locations) = state.with_project(|db| {
        let chapters: Vec<(i64, String)> = {
            let mut stmt = db.conn.prepare("SELECT id, content FROM chapters WHERE deleted_at IS NULL")?;
            let rows = stmt
                .query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))?
                .collect::<std::result::Result<Vec<_>, _>>()?;
            rows
        };
        let characters: Vec<(i64, Vec<String>)> = {
            let mut stmt = db.conn.prepare("SELECT id, name, aliases FROM characters")?;
            let rows = stmt
                .query_map([], |r| {
                    Ok((
                        r.get::<_, i64>(0)?,
                        character_patterns(
                            &r.get::<_, String>(1)?,
                            &parse_aliases(&r.get::<_, String>(2)?),
                        ),
                    ))
                })?
                .collect::<std::result::Result<Vec<_>, _>>()?;
            rows
        };
        let locations: Vec<(i64, String)> = {
            let mut stmt = db.conn.prepare("SELECT id, name FROM locations")?;
            let rows = stmt
                .query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))?
                .collect::<std::result::Result<Vec<_>, _>>()?;
            rows
        };
        Ok((chapters, characters, locations))
    })?;

    // 第二阶段：后台线程精确匹配计数（不碰 DB）
    let (char_hits, loc_hits) = tauri::async_runtime::spawn_blocking(move || {
        let mut char_hits: Vec<(i64, i64, i64)> = Vec::new();
        for (cid, pats) in &characters {
            for (ch_id, content) in &chapters {
                let n = count_occurrences(content, pats);
                if n > 0 {
                    char_hits.push((*cid, *ch_id, n as i64));
                }
            }
        }
        let mut loc_hits: Vec<(i64, i64, i64)> = Vec::new();
        for (lid, name) in &locations {
            for (ch_id, content) in &chapters {
                let n = count_occurrences(content, std::slice::from_ref(name));
                if n > 0 {
                    loc_hits.push((*lid, *ch_id, n as i64));
                }
            }
        }
        (char_hits, loc_hits)
    })
    .await
    .map_err(|e| AppError::Msg(format!("统计任务失败：{e}")))?;

    // 第三阶段：短事务写入
    let total = (char_hits.len() + loc_hits.len()) as i64;
    state.with_project(|db| {
        let tx = db.conn.unchecked_transaction()?;
        tx.execute("DELETE FROM character_mentions", [])?;
        tx.execute("DELETE FROM location_mentions", [])?;
        for (cid, ch_id, n) in &char_hits {
            tx.execute(
                "INSERT INTO character_mentions (character_id, chapter_id, mention_count)
                 VALUES (?1, ?2, ?3)",
                params![cid, ch_id, n],
            )?;
        }
        for (lid, ch_id, n) in &loc_hits {
            tx.execute(
                "INSERT INTO location_mentions (location_id, chapter_id, mention_count)
                 VALUES (?1, ?2, ?3)",
                params![lid, ch_id, n],
            )?;
        }
        tx.commit()?;
        Ok(total)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 内存库 + 全量迁移 + 基础数据（1 卷 2 章）
    fn fixture_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::migrations::apply(&conn).unwrap();
        conn.execute("INSERT INTO volumes (id, title) VALUES (1, '正文')", [])
            .unwrap();
        conn.execute(
            "INSERT INTO chapters (id, volume_id, title, content, sort_order)
             VALUES (1, 1, '第一章', '林默走进青云宗。苏婉看了他一眼。', 0)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO chapters (id, volume_id, title, content, sort_order)
             VALUES (2, 1, '第二章', '林默修炼。林默突破。青云宗钟声响起。', 1)",
            [],
        )
        .unwrap();
        conn
    }

    #[test]
    fn mention_counts_are_exact_and_incremental() {
        let conn = fixture_db();
        conn.execute(
            "INSERT INTO characters (id, name, aliases, status) VALUES (1, '林默', '[\"默儿\"]', 1)",
            [],
        )
        .unwrap();
        conn.execute("INSERT INTO locations (id, name, status) VALUES (1, '青云宗', 1)", [])
            .unwrap();

        // 增量重算第 2 章
        let content: String = conn
            .query_row("SELECT content FROM chapters WHERE id = 2", [], |r| r.get(0))
            .unwrap();
        update_chapter_mentions(&conn, 2, &content).unwrap();

        let char_n: i64 = conn
            .query_row(
                "SELECT mention_count FROM character_mentions WHERE character_id = 1 AND chapter_id = 2",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(char_n, 2, "第 2 章「林默」应出现 2 次");

        let loc_n: i64 = conn
            .query_row(
                "SELECT mention_count FROM location_mentions WHERE location_id = 1 AND chapter_id = 2",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(loc_n, 1);

        // 未出现的章节不产生记录
        let absent: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM character_mentions WHERE character_id = 1 AND chapter_id = 1",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(absent, 0, "第 1 章未重算前无记录");
    }

    #[test]
    fn profile_aggregation_includes_first_last_chapter() {
        let conn = fixture_db();
        conn.execute(
            "INSERT INTO characters (id, name, status) VALUES (1, '林默', 1)",
            [],
        )
        .unwrap();
        rescan_character(&conn, 1).unwrap();

        let profiles = build_character_profiles(&conn).unwrap();
        assert_eq!(profiles.len(), 1);
        let p = &profiles[0];
        assert_eq!(p.total_mentions, 3, "全书「林默」共 3 次");
        assert_eq!(p.chapter_count, 2);
        assert_eq!(p.first_chapter_title.as_deref(), Some("第一章"));
        assert_eq!(p.last_chapter_title.as_deref(), Some("第二章"));
    }

    #[test]
    fn v3_migration_drops_recognition_tables() {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::migrations::apply(&conn).unwrap();
        // 旧识别表已废弃
        for dropped in ["events", "timeline_markers", "analysis_cache"] {
            let n: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name = ?1",
                    params![dropped],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(n, 0, "表 {dropped} 应在 V3 迁移中被删除");
        }
        // 码字统计表已建立
        let n: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name = 'writing_daily'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(n, 1);
    }
}
