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
use crate::mention_index::{self, EntityPatterns, MentionMatcher};
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

/// 解析 characters.exclude_words（JSON 数组）为字符串列表
fn parse_exclude_words(json: &str) -> Vec<String> {
    serde_json::from_str(json).unwrap_or_default()
}

/// 人物的全部匹配词：名字 + 别名
fn character_patterns(name: &str, aliases: &[String]) -> Vec<String> {
    let mut v = Vec::with_capacity(aliases.len() + 1);
    v.push(name.to_string());
    v.extend(aliases.iter().cloned());
    v
}

/// 读取全书人物匹配实体（id + 名字/别名 + 排除词）
pub(crate) fn load_char_entities(conn: &Connection) -> Result<Vec<EntityPatterns>> {
    let mut stmt = conn.prepare("SELECT id, name, aliases, exclude_words FROM characters")?;
    let rows = stmt
        .query_map([], |r| {
            let id: i64 = r.get(0)?;
            let name: String = r.get(1)?;
            let aliases: Vec<String> = parse_aliases(&r.get::<_, String>(2)?);
            let excludes: Vec<String> = parse_exclude_words(&r.get::<_, String>(3)?);
            Ok(EntityPatterns {
                id,
                patterns: character_patterns(&name, &aliases),
                excludes,
            })
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(rows)
}

/// 读取全书地点匹配实体
fn load_loc_entities(conn: &Connection) -> Result<Vec<EntityPatterns>> {
    let mut stmt = conn.prepare("SELECT id, name FROM locations")?;
    let rows = stmt
        .query_map([], |r| {
            Ok(EntityPatterns {
                id: r.get(0)?,
                patterns: vec![r.get::<_, String>(1)?],
                excludes: Vec::new(),
            })
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(rows)
}

/// 全书章节顺序（卷序 → 章序 → id）
pub(crate) fn chapter_order(conn: &Connection) -> Result<Vec<i64>> {
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
         WHERE m.mention_count > 0 AND c.deleted_at IS NULL
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

/// 记录某章已按当前 content_hash 纳入统计（增量索引状态，V15）
fn mark_chapter_indexed(conn: &Connection, chapter_id: i64) -> Result<()> {
    conn.execute(
        "INSERT INTO mention_index_state (chapter_id, content_hash)
         SELECT id, COALESCE(content_hash,'') FROM chapters WHERE id = ?1
         ON CONFLICT(chapter_id) DO UPDATE SET content_hash = excluded.content_hash",
        params![chapter_id],
    )?;
    Ok(())
}

/// 单章提及重算（save_chapter 事务内调用）：
/// 用全书共享的全局匹配器各扫描一次，每个文本区间唯一归属一个实体，
/// 删旧 → 计数 → 插新。匹配器按实体词指纹缓存，正文保存不重复编译正则。
pub(crate) fn update_chapter_mentions(
    conn: &Connection,
    chapter_id: i64,
    content: &str,
) -> Result<()> {
    let chars = load_char_entities(conn)?;
    let locs = load_loc_entities(conn)?;
    let (char_m, loc_m) = mention_index::matchers_for(chars, locs);
    let char_hits = char_m.count(content);
    let loc_hits = loc_m.count(content);

    conn.execute(
        "DELETE FROM character_mentions WHERE chapter_id = ?1",
        params![chapter_id],
    )?;
    {
        let mut ins = conn.prepare(
            "INSERT INTO character_mentions (character_id, chapter_id, mention_count)
             VALUES (?1, ?2, ?3)",
        )?;
        for (cid, n) in &char_hits {
            if *n > 0 {
                ins.execute(params![cid, chapter_id, n])?;
            }
        }
    }

    conn.execute(
        "DELETE FROM location_mentions WHERE chapter_id = ?1",
        params![chapter_id],
    )?;
    {
        let mut ins = conn.prepare(
            "INSERT INTO location_mentions (location_id, chapter_id, mention_count)
             VALUES (?1, ?2, ?3)",
        )?;
        for (lid, n) in &loc_hits {
            if *n > 0 {
                ins.execute(params![lid, chapter_id, n])?;
            }
        }
    }
    mark_chapter_indexed(conn, chapter_id)?;
    Ok(())
}

/// 全书提及重建（全局匹配器，每章只扫一次）。
/// 人物改名 / 别名变化会改变跨角色归属，必须全书重算而非只算一张卡。
/// only_chapter = Some(id) 时只重算指定章（供软删/恢复即时同步）。
/// 注意：本函数不自开事务，由调用方决定事务边界（可在已有事务内调用）。
pub(crate) fn rebuild_all_mentions(conn: &Connection, only_chapter: Option<i64>) -> Result<()> {
    let chars = load_char_entities(conn)?;
    let locs = load_loc_entities(conn)?;
    let (char_m, loc_m) = mention_index::matchers_for(chars, locs);

    // 选定要重算的章（仅未删除章）；None = 全书
    let chapters: Vec<(i64, String)> = if let Some(id) = only_chapter {
        let mut stmt =
            conn.prepare("SELECT id, content FROM chapters WHERE deleted_at IS NULL AND id = ?1")?;
        let rows = stmt
            .query_map(params![id], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        rows
    } else {
        let mut stmt =
            conn.prepare("SELECT id, content FROM chapters WHERE deleted_at IS NULL")?;
        let rows = stmt
            .query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        rows
    };

    match only_chapter {
        Some(id) => {
            conn.execute("DELETE FROM character_mentions WHERE chapter_id = ?1", params![id])?;
            conn.execute("DELETE FROM location_mentions WHERE chapter_id = ?1", params![id])?;
        }
        None => {
            conn.execute("DELETE FROM character_mentions", [])?;
            conn.execute("DELETE FROM location_mentions", [])?;
        }
    }
    for (ch_id, content) in &chapters {
        for (cid, n) in char_m.count(content) {
            if n > 0 {
                conn.execute(
                    "INSERT INTO character_mentions (character_id, chapter_id, mention_count)
                     VALUES (?1, ?2, ?3)",
                    params![cid, ch_id, n],
                )?;
            }
        }
        for (lid, n) in loc_m.count(content) {
            if n > 0 {
                conn.execute(
                    "INSERT INTO location_mentions (location_id, chapter_id, mention_count)
                     VALUES (?1, ?2, ?3)",
                    params![lid, ch_id, n],
                )?;
            }
        }
        mark_chapter_indexed(conn, *ch_id)?;
    }
    Ok(())
}

/// 人物群像扩展字段（审查 UX-3），add/update 时作为单个对象传入，避免 IPC 参数过多。
#[derive(Debug, serde::Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct CharacterMetaInput {
    pub faction: Option<String>,
    /// 存亡：null 未知 / true 存活 / false 死亡
    pub alive: Option<bool>,
    /// 重要度 0..3
    pub importance: Option<i64>,
    pub is_pov: Option<bool>,
    pub tags: Option<Vec<String>>,
    /// 自定义字段（对象），原样以 JSON 文本落库
    pub custom_fields: Option<serde_json::Value>,
}

/// 人物档案组装：基础行 + 聚合统计 + 首末章
fn build_character_profiles(conn: &Connection) -> Result<Vec<CharacterProfile>> {
    let mut stmt = conn.prepare(
        "SELECT id, name, aliases, role, notes, map_x, map_y, exclude_words,
                faction, alive, importance, is_pov, tags, custom_fields
         FROM characters ORDER BY importance DESC, name",
    )?;
    let base = stmt
        .query_map([], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, String>(4)?,
                r.get::<_, Option<f64>>(5)?,
                r.get::<_, Option<f64>>(6)?,
                r.get::<_, String>(7)?,
                r.get::<_, String>(8)?,
                r.get::<_, Option<i64>>(9)?,
                r.get::<_, i64>(10)?,
                r.get::<_, i64>(11)?,
                r.get::<_, String>(12)?,
                r.get::<_, String>(13)?,
            ))
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;

    // 聚合统计（JOIN chapters 排除软删章节，回收站章节不计入角色卡——审查 P1-3）
    let mut agg: std::collections::HashMap<i64, (i64, i64)> = std::collections::HashMap::new();
    {
        let mut s = conn.prepare(
            "SELECT m.character_id, COALESCE(SUM(m.mention_count),0), COUNT(*)
             FROM character_mentions m
             JOIN chapters c ON c.id = m.chapter_id AND c.deleted_at IS NULL
             GROUP BY m.character_id",
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
        .map(
            |(id, name, aliases, role, notes, map_x, map_y, exclude_words,
              faction, alive, importance, is_pov, tags, custom_fields)| {
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
                map_x,
                map_y,
                exclude_words: parse_exclude_words(&exclude_words),
                faction,
                alive,
                importance,
                is_pov: is_pov != 0,
                tags: parse_aliases(&tags),
                custom_fields: serde_json::from_str(&custom_fields).unwrap_or(serde_json::json!({})),
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
            "SELECT m.location_id, COALESCE(SUM(m.mention_count),0), COUNT(*)
             FROM location_mentions m
             JOIN chapters c ON c.id = m.chapter_id AND c.deleted_at IS NULL
             GROUP BY m.location_id",
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

/// 新建人物卡（手动建卡，建后立即全量统计该卡）。
/// meta 为群像扩展字段，打包成对象以控制 IPC 参数数量。
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn add_character(
    state: State<'_, AppState>,
    name: String,
    aliases: Option<Vec<String>>,
    role: Option<String>,
    notes: Option<String>,
    exclude_words: Option<Vec<String>>,
    meta: Option<CharacterMetaInput>,
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
    // 单字名且未指定排除词时，自动填入内置误判词词典
    let exclude: Vec<String> = match exclude_words {
        Some(list) => list.into_iter().map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect(),
        None => crate::char_stopwords::default_exclude_for(&name),
    };
    let exclude_json = serde_json::to_string(&exclude).unwrap_or_else(|_| "[]".into());
    let m = meta.unwrap_or_default();
    let tags_json = serde_json::to_string(&m.tags.unwrap_or_default()).unwrap_or_else(|_| "[]".into());
    let cf_json = serde_json::to_string(&m.custom_fields.unwrap_or(serde_json::json!({})))
        .unwrap_or_else(|_| "{}".into());
    let alive_v = m.alive.map(|a| a as i64);

    state.with_project(|db| {
        let tx = db.conn.unchecked_transaction()?;
        tx.execute(
            "INSERT INTO characters
                (name, aliases, status, role, notes, exclude_words,
                 faction, alive, importance, is_pov, tags, custom_fields)
             VALUES (?1, ?2, 1, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
            params![
                name,
                aliases_json,
                role.unwrap_or_default(),
                notes.unwrap_or_default(),
                exclude_json,
                m.faction.unwrap_or_default(),
                alive_v,
                m.importance.unwrap_or(1),
                m.is_pov.unwrap_or(false) as i64,
                tags_json,
                cf_json,
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
        mention_index::invalidate_cache();
        rebuild_all_mentions(&tx, None)?;
        tx.commit()?;

        build_character_profiles(&db.conn)?
            .into_iter()
            .find(|c| c.id == id)
            .ok_or_else(|| AppError::Msg("新建人物读取失败".into()))
    })
}

/// 更新人物卡（名字/别名变化后重算该卡统计；meta 为群像扩展字段）。
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn update_character(
    state: State<'_, AppState>,
    character_id: i64,
    name: Option<String>,
    aliases: Option<Vec<String>>,
    role: Option<String>,
    notes: Option<String>,
    exclude_words: Option<Vec<String>>,
    meta: Option<CharacterMetaInput>,
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
        if let Some(m) = meta {
            if let Some(faction) = m.faction {
                db.conn.execute(
                    "UPDATE characters SET faction = ?1, updated_at = datetime('now','localtime') WHERE id = ?2",
                    params![faction, character_id],
                )?;
            }
            if let Some(alive) = m.alive {
                db.conn.execute(
                    "UPDATE characters SET alive = ?1, updated_at = datetime('now','localtime') WHERE id = ?2",
                    params![alive as i64, character_id],
                )?;
            }
            if let Some(importance) = m.importance {
                db.conn.execute(
                    "UPDATE characters SET importance = ?1, updated_at = datetime('now','localtime') WHERE id = ?2",
                    params![importance, character_id],
                )?;
            }
            if let Some(is_pov) = m.is_pov {
                db.conn.execute(
                    "UPDATE characters SET is_pov = ?1, updated_at = datetime('now','localtime') WHERE id = ?2",
                    params![is_pov as i64, character_id],
                )?;
            }
            if let Some(tags) = m.tags {
                let json = serde_json::to_string(&tags).unwrap_or_else(|_| "[]".into());
                db.conn.execute(
                    "UPDATE characters SET tags = ?1, updated_at = datetime('now','localtime') WHERE id = ?2",
                    params![json, character_id],
                )?;
            }
            if let Some(cf) = m.custom_fields {
                let json = serde_json::to_string(&cf).unwrap_or_else(|_| "{}".into());
                db.conn.execute(
                    "UPDATE characters SET custom_fields = ?1, updated_at = datetime('now','localtime') WHERE id = ?2",
                    params![json, character_id],
                )?;
            }
        }
        if let Some(list) = exclude_words {
            let cleaned: Vec<String> = list
                .iter()
                .map(|a| a.trim().to_string())
                .filter(|a| !a.is_empty())
                .collect();
            let json = serde_json::to_string(&cleaned).unwrap_or_else(|_| "[]".into());
            db.conn.execute(
                "UPDATE characters SET exclude_words = ?1, updated_at = datetime('now','localtime') WHERE id = ?2",
                params![json, character_id],
            )?;
            rescan = true;
        }
        if rescan {
            // 名字/别名/排除词变化会改变跨角色的最长匹配归属，必须全书重建；
            // 只改 notes/role 不触发扫描（审查 P1-5）
            mention_index::invalidate_cache();
            rebuild_all_mentions(&db.conn, None)?;
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
        // 删除后，原本被长名占有的区间可能归还给其它角色，需全书重建
        mention_index::invalidate_cache();
        rebuild_all_mentions(&db.conn, None)?;
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
        mention_index::invalidate_cache();
        rebuild_all_mentions(&tx, None)?;
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
            mention_index::invalidate_cache();
            rebuild_all_mentions(&db.conn, None)?;
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
        mention_index::invalidate_cache();
        rebuild_all_mentions(&db.conn, None)?;
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

        // 全局匹配器：与统计口径一致，避免本章出场也出现跨角色双计数
        let char_entities = load_char_entities(&db.conn)?;
        let char_names: std::collections::HashMap<i64, String> = {
            let mut stmt = db.conn.prepare("SELECT id, name FROM characters")?;
            let rows = stmt
                .query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))?
                .collect::<std::result::Result<_, _>>()?;
            rows
        };
        let loc_entities = load_loc_entities(&db.conn)?;
        let loc_names: std::collections::HashMap<i64, String> = {
            let mut stmt = db.conn.prepare("SELECT id, name FROM locations")?;
            let rows = stmt
                .query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))?
                .collect::<std::result::Result<_, _>>()?;
            rows
        };
        let (char_m, loc_m) = mention_index::matchers_for(char_entities, loc_entities);
        let mut characters: Vec<EntityMentionView> = char_m
            .count(&content)
            .into_iter()
            .filter(|(_, n)| *n > 0)
            .filter_map(|(id, n)| {
                char_names.get(&id).map(|name| EntityMentionView {
                    id,
                    mention_count: n,
                    name: name.clone(),
                })
            })
            .collect();
        characters.sort_by_key(|a| std::cmp::Reverse(a.mention_count));

        let mut locations: Vec<EntityMentionView> = loc_m
            .count(&content)
            .into_iter()
            .filter(|(_, n)| *n > 0)
            .filter_map(|(id, n)| {
                loc_names.get(&id).map(|name| EntityMentionView {
                    id,
                    mention_count: n,
                    name: name.clone(),
                })
            })
            .collect();
        locations.sort_by_key(|a| std::cmp::Reverse(a.mention_count));

        Ok(ChapterPresenceView {
            chapter_id,
            characters,
            locations,
        })
    })
}

/// 别名 / 称谓冲突项：同一称谓被多张人物卡声明时，全局匹配只能归属其一，
/// 需要作者明确裁决归属（审查 P1-4）。
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AliasConflict {
    /// 冲突的共享称谓
    pub label: String,
    /// 涉及的人物卡 id（按 id 升序）
    pub character_ids: Vec<i64>,
    /// 对应的人物名（与 character_ids 一一对应）
    pub character_names: Vec<String>,
}

/// 检测全书人物之间重名 / 共享别名的冲突，供前端提示作者裁决归属。
#[tauri::command]
pub fn get_alias_conflicts(state: State<'_, AppState>) -> Result<Vec<AliasConflict>> {
    state.with_project(|db| {
        let entities = load_char_entities(&db.conn)?;
        let id_name: std::collections::HashMap<i64, String> = {
            let mut stmt = db.conn.prepare("SELECT id, name FROM characters")?;
            let rows = stmt
                .query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))?
                .collect::<std::result::Result<_, _>>()?;
            rows
        };
        let matcher = MentionMatcher::build(&entities);
        let mut out = Vec::new();
        for (label, a, b) in matcher.conflicts {
            let ids = vec![a, b];
            let names = ids
                .iter()
                .map(|id| id_name.get(id).cloned().unwrap_or_default())
                .collect();
            out.push(AliasConflict {
                label,
                character_ids: ids,
                character_names: names,
            });
        }
        out.sort_by(|x, y| x.label.cmp(&y.label));
        Ok(out)
    })
}

/// 单章重建计划：(章id, 内容指纹, 人物命中, 地点命中)
type ChapterMentionPlan = (i64, String, Vec<(i64, i64)>, Vec<(i64, i64)>);

/// 增量重建提及统计（审查 P1-3）。
///
/// 旧实现「先 DELETE 全表再写回」，且每次打开项目无条件全书重建；
/// 重建期间的新保存会被迟到的旧结果覆盖。现在：
///   1. 后台线程用全局匹配器按章计算（不碰 DB）；
///   2. 写回时逐章二次核对 content_hash——内容已变（期间被保存）则跳过该章，
///      绝不用旧快照覆盖新保存；
///   3. 只逐章替换，从不全表删除；软删章清空其残留提及。
#[tauri::command]
pub async fn rebuild_mentions(state: State<'_, AppState>) -> Result<i64> {
    use crate::mention_index::MentionMatcher;

    // 第一阶段：读实体词 + 全部未删章（带内容指纹）
    let (chars, locs, chapters) = state.with_project(|db| {
        let chars = load_char_entities(&db.conn)?;
        let locs = load_loc_entities(&db.conn)?;
        let mut stmt = db.conn.prepare(
            "SELECT c.id, c.content, COALESCE(c.content_hash,'')
             FROM chapters c
             LEFT JOIN mention_index_state s ON s.chapter_id = c.id
             WHERE c.deleted_at IS NULL
               AND (s.chapter_id IS NULL OR s.content_hash <> COALESCE(c.content_hash,''))",
        )?;
        let chapters = stmt
            .query_map([], |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                ))
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok((chars, locs, chapters))
    })?;

    // 第二阶段：后台计算（全局匹配器，每章只扫一次）
    let plan = tauri::async_runtime::spawn_blocking(move || {
        let cm = MentionMatcher::build(&chars);
        let lm = MentionMatcher::build(&locs);
        let mut plan: Vec<ChapterMentionPlan> = Vec::new();
        for (ch_id, content, hash) in chapters {
            let ch = cm
                .count(&content)
                .into_iter()
                .filter(|(_, n)| *n > 0)
                .collect();
            let lh = lm
                .count(&content)
                .into_iter()
                .filter(|(_, n)| *n > 0)
                .collect();
            plan.push((ch_id, hash, ch, lh));
        }
        plan
    })
    .await
    .map_err(|e| AppError::Msg(format!("统计任务失败：{e}")))?;

    // 第三阶段：逐章写回，写入前二次核对指纹，变了就跳过（不覆盖新保存）
    state.with_project(|db| {
        let mut refreshed = 0i64;
        let tx = db.conn.unchecked_transaction()?;
        for (ch_id, hash, char_hits, loc_hits) in plan {
            let cur: Option<String> = tx
                .query_row(
                    "SELECT content_hash FROM chapters WHERE id = ?1 AND deleted_at IS NULL",
                    params![ch_id],
                    |r| r.get(0),
                )
                .ok();
            let Some(cur_hash) = cur else {
                // 章已被删除：清掉它的残留提及与索引状态
                tx.execute("DELETE FROM character_mentions WHERE chapter_id = ?1", params![ch_id])?;
                tx.execute("DELETE FROM location_mentions WHERE chapter_id = ?1", params![ch_id])?;
                tx.execute("DELETE FROM mention_index_state WHERE chapter_id = ?1", params![ch_id])?;
                continue;
            };
            if cur_hash != hash {
                // 期间被重新保存过，本次结果过期，跳过留给下一次增量
                continue;
            }
            tx.execute("DELETE FROM character_mentions WHERE chapter_id = ?1", params![ch_id])?;
            tx.execute("DELETE FROM location_mentions WHERE chapter_id = ?1", params![ch_id])?;
            for (cid, n) in &char_hits {
                tx.execute(
                    "INSERT INTO character_mentions (character_id, chapter_id, mention_count)
                     VALUES (?1, ?2, ?3)",
                    params![cid, ch_id, n],
                )?;
            }
            for (lid, n) in &loc_hits {
                tx.execute(
                    "INSERT INTO location_mentions (location_id, chapter_id, mention_count)
                     VALUES (?1, ?2, ?3)",
                    params![lid, ch_id, n],
                )?;
            }
            tx.execute(
                "INSERT INTO mention_index_state (chapter_id, content_hash) VALUES (?1, ?2)
                 ON CONFLICT(chapter_id) DO UPDATE SET content_hash = excluded.content_hash",
                params![ch_id, cur_hash],
            )?;
            refreshed += 1;
        }
        tx.commit()?;
        Ok(refreshed)
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
        rebuild_all_mentions(&conn, None).unwrap();

        let profiles = build_character_profiles(&conn).unwrap();
        assert_eq!(profiles.len(), 1);
        let p = &profiles[0];
        assert_eq!(p.total_mentions, 3, "全书「林默」共 3 次");
        assert_eq!(p.chapter_count, 2);
        assert_eq!(p.first_chapter_title.as_deref(), Some("第一章"));
        assert_eq!(p.last_chapter_title.as_deref(), Some("第二章"));
    }

    #[test]
    fn nested_character_names_not_double_counted() {
        // 审查 P1-4：「苏婉」与「苏婉清」并存时，苏婉清不得被两人各计一次
        let conn = fixture_db();
        conn.execute(
            "UPDATE chapters SET content = '苏婉清来了。苏婉走了。' WHERE id = 1",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO characters (id, name, status) VALUES (1, '苏婉', 1), (2, '苏婉清', 1)",
            [],
        )
        .unwrap();
        rebuild_all_mentions(&conn, None).unwrap();
        let n1: i64 = conn
            .query_row(
                "SELECT COALESCE(SUM(mention_count),0) FROM character_mentions WHERE character_id = 1",
                [],
                |r| r.get(0),
            )
            .unwrap();
        let n2: i64 = conn
            .query_row(
                "SELECT COALESCE(SUM(mention_count),0) FROM character_mentions WHERE character_id = 2",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(n1, 1, "独立的「苏婉」只计 1 次");
        assert_eq!(n2, 1, "「苏婉清」只归苏婉清，计 1 次");
    }

    #[test]
    fn soft_deleted_chapter_excluded_from_aggregation() {
        // 审查 P1-3：回收站章节不计入角色卡聚合
        let conn = fixture_db();
        conn.execute(
            "INSERT INTO characters (id, name, status) VALUES (1, '林默', 1)",
            [],
        )
        .unwrap();
        rebuild_all_mentions(&conn, None).unwrap();
        assert_eq!(
            build_character_profiles(&conn).unwrap()[0].total_mentions,
            3
        );
        // 软删第 2 章并即时清空其提及
        conn.execute("UPDATE chapters SET deleted_at = datetime('now') WHERE id = 2", [])
            .unwrap();
        rebuild_all_mentions(&conn, Some(2)).unwrap();
        let p = &build_character_profiles(&conn).unwrap()[0];
        assert_eq!(p.total_mentions, 1, "只剩第 1 章的 1 次");
        assert_eq!(p.chapter_count, 1);
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

    /// 造 N 个角色
    fn seed_characters(conn: &Connection, n: i64) {
        for i in 0..n {
            conn.execute(
                "INSERT INTO characters (id, name, status) VALUES (?1, ?2, 1)",
                params![i, format!("角色{i:03}")],
            )
            .unwrap();
        }
    }

    /// 性能基准 A（审查 P1-5，保存路径）：典型单章约 6000 字 + 500 角色，
    /// 保存事务内的单章提及重算必须 < 100ms。
    /// `cargo test benchmark -- --ignored --nocapture`
    #[test]
    #[ignore = "性能基准，手动运行"]
    fn mention_benchmark_single_chapter_save_under_100ms() {
        use std::time::Instant;
        let conn = Connection::open_in_memory().unwrap();
        crate::db::migrations::apply(&conn).unwrap();
        conn.execute("INSERT INTO volumes (id, title) VALUES (1, '正文')", [])
            .unwrap();
        seed_characters(&conn, 500);
        // 约 6000 字的一章，穿插约 280 个角色名
        let mut content = String::new();
        let mut i = 0i64;
        while content.chars().count() < 6000 {
            content.push_str(&format!("角色{i:03}走过长街，风起云涌，山河浩荡。"));
            i = (i + 1) % 500;
        }
        conn.execute(
            "INSERT INTO chapters (id, volume_id, title, content, sort_order) VALUES (1,1,'章',?1,0)",
            params![content],
        )
        .unwrap();
        // 预热（构建并缓存匹配器）
        let tx = conn.unchecked_transaction().unwrap();
        update_chapter_mentions(&tx, 1, &content).unwrap();
        tx.commit().unwrap();
        // 计时：缓存命中的保存路径
        let tx = conn.unchecked_transaction().unwrap();
        let t = Instant::now();
        update_chapter_mentions(&tx, 1, &content).unwrap();
        let ms = t.elapsed().as_millis();
        tx.commit().unwrap();
        println!("6000字单章/500角色 保存重算耗时 {ms}ms");
        assert!(ms < 100, "单章保存提及重算应 < 100ms，实际 {ms}ms");
    }

    /// 性能基准 B（压力项）：100 万字全书 + 500 角色的全量重建吞吐上限。
    /// 这是「打开项目兜底重建」量级，不是单次保存；给一个宽松回归上限。
    #[test]
    #[ignore = "性能基准，手动运行"]
    fn mention_benchmark_whole_book_1m_throughput() {
        use std::time::Instant;
        let conn = Connection::open_in_memory().unwrap();
        crate::db::migrations::apply(&conn).unwrap();
        conn.execute("INSERT INTO volumes (id, title) VALUES (1, '正文')", [])
            .unwrap();
        seed_characters(&conn, 500);
        let mut content = String::with_capacity(1_100_000);
        let mut i = 0i64;
        while content.chars().count() < 1_000_000 {
            content.push_str(&format!("角色{i:03}走过长街，风起云涌，山河浩荡。"));
            i = (i + 1) % 500;
        }
        conn.execute(
            "INSERT INTO chapters (id, volume_id, title, content, sort_order) VALUES (1,1,'长章',?1,0)",
            params![content],
        )
        .unwrap();
        rebuild_all_mentions(&conn, None).unwrap(); // 预热编译
        let t = Instant::now();
        rebuild_all_mentions(&conn, None).unwrap();
        let ms = t.elapsed().as_millis();
        println!("100万字全书/500角色 全量重建耗时 {ms}ms");
        assert!(ms < 1000, "100万字全量重建应 < 1000ms，实际 {ms}ms");
    }
}
