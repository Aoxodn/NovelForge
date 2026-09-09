//! 故事图命令（V7，设计文档 V1.1）：节点 = 卷（故事阶段）。
//!
//! 口径约定：
//! - **节点 = 卷**：`volumes` 即节点表（id / 标题 / sort_order=阶段序 / summary=细纲 /
//!   map_x / map_y）。章节唯一归属 `chapters.volume_id`，目录树 / 导出 / 统计天然兼容。
//! - **连线引用卷**：`story_edges.from_node / to_node → volumes.id`；
//!   伏笔边（edge_type=4）可带章级锚点 `from_chapter_id / to_chapter_id`
//!   （NULL = 卷级伏笔）。同卷伏笔（from==to）合法，普通边禁止自环。
//! - **全局章节序**：`ORDER BY volumes.sort_order, chapters.sort_order, chapters.id`，
//!   跨度 / 超期预警一律用全局序（与导出排序一致）。
//! - 画布坐标归一化 0..1 存 `volumes.map_x / map_y`，视口变化不失效。
//! - 回收站章节（deleted_at 非 NULL）不参与章节计数与全局序；
//!   伏笔的章级锚点指向回收站章节时保留并在总览中标注。
//! - 顺序边是派生数据：`auto_layout_story_map` 整体删除重建；
//!   因果 / 分支 / 汇合 / 伏笔边是手工数据，不受自动布局影响。

use crate::commands::AppState;
use crate::error::{AppError, Result};
use crate::models::{
    CharacterBinding, CharacterCanvasPos, ChapterEdge, ChapterGroup, ChapterStoryContext,
    ForeshadowBrief, ForeshadowView, GroupEdge, StoryArc, StoryEdge, StoryGraph, StoryNode,
    VolumeChapterBrief, VolumeDetail, VolumeEdgeBrief,
};
use rusqlite::{params, Connection, Row};
use std::collections::HashMap;
use tauri::State;
use crate::services::layout::compute_layout;

/// 伏笔超期默认阈值（章）
const DEFAULT_OVERDUE_THRESHOLD: i64 = 10;
/// 超期阈值在 settings 表中的键
const OVERDUE_THRESHOLD_KEY: &str = "foreshadow_overdue_threshold";

// ---------- 查询辅助 ----------

/// 全量加载卷节点（含章节统计）。卷即节点，无回收站概念。
fn load_nodes(conn: &Connection) -> Result<Vec<StoryNode>> {
    let mut stmt = conn.prepare(
        "SELECT v.id, v.title, v.sort_order, v.summary, v.node_type, v.map_x, v.map_y,
                (SELECT COUNT(*) FROM chapters c
                  WHERE c.volume_id = v.id AND c.deleted_at IS NULL),
                (SELECT COUNT(*) FROM chapters c
                  WHERE c.volume_id = v.id AND c.deleted_at IS NULL AND c.status = 1),
                (SELECT COALESCE(SUM(c.word_count), 0) FROM chapters c
                  WHERE c.volume_id = v.id AND c.deleted_at IS NULL)
         FROM volumes v
         ORDER BY v.sort_order, v.id",
    )?;
    let nodes = stmt
        .query_map([], row_to_node)?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(nodes)
}

fn row_to_node(row: &Row) -> rusqlite::Result<StoryNode> {
    Ok(StoryNode {
        id: row.get(0)?,
        title: row.get(1)?,
        sort_order: row.get(2)?,
        summary: row.get(3)?,
        node_type: row.get(4)?,
        map_x: row.get(5)?,
        map_y: row.get(6)?,
        chapter_count: row.get(7)?,
        done_chapters: row.get(8)?,
        word_count: row.get(9)?,
    })
}

fn fetch_node(conn: &Connection, id: i64) -> Result<StoryNode> {
    conn.query_row(
        "SELECT v.id, v.title, v.sort_order, v.summary, v.node_type, v.map_x, v.map_y,
                (SELECT COUNT(*) FROM chapters c
                  WHERE c.volume_id = v.id AND c.deleted_at IS NULL),
                (SELECT COUNT(*) FROM chapters c
                  WHERE c.volume_id = v.id AND c.deleted_at IS NULL AND c.status = 1),
                (SELECT COALESCE(SUM(c.word_count), 0) FROM chapters c
                  WHERE c.volume_id = v.id AND c.deleted_at IS NULL)
         FROM volumes v WHERE v.id = ?1",
        params![id],
        row_to_node,
    )
    .map_err(|_| AppError::Msg("卷不存在".into()))
}

fn load_edges(conn: &Connection) -> Result<Vec<StoryEdge>> {
    let mut stmt = conn.prepare(
        "SELECT id, from_node, to_node, edge_type, arc_id,
                from_chapter_id, to_chapter_id, label, status, bend
         FROM story_edges ORDER BY id",
    )?;
    let edges = stmt
        .query_map([], |row| {
            Ok(StoryEdge {
                id: row.get(0)?,
                from_node: row.get(1)?,
                to_node: row.get(2)?,
                edge_type: row.get(3)?,
                arc_id: row.get(4)?,
                from_chapter_id: row.get(5)?,
                to_chapter_id: row.get(6)?,
                label: row.get(7)?,
                status: row.get(8)?,
                bend: row.get(9)?,
            })
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(edges)
}

fn fetch_edge(conn: &Connection, id: i64) -> Result<StoryEdge> {
    conn.query_row(
        "SELECT id, from_node, to_node, edge_type, arc_id,
                from_chapter_id, to_chapter_id, label, status, bend
         FROM story_edges WHERE id = ?1",
        params![id],
        |row| {
            Ok(StoryEdge {
                id: row.get(0)?,
                from_node: row.get(1)?,
                to_node: row.get(2)?,
                edge_type: row.get(3)?,
                arc_id: row.get(4)?,
                from_chapter_id: row.get(5)?,
                to_chapter_id: row.get(6)?,
                label: row.get(7)?,
                status: row.get(8)?,
                bend: row.get(9)?,
            })
        },
    )
    .map_err(|_| AppError::Msg("连线不存在".into()))
}

fn load_arcs(conn: &Connection) -> Result<Vec<StoryArc>> {
    let mut stmt = conn.prepare("SELECT id, title, kind, color, summary FROM story_arcs ORDER BY kind, id")?;
    let arcs = stmt
        .query_map([], |row| {
            Ok(StoryArc {
                id: row.get(0)?,
                title: row.get(1)?,
                kind: row.get(2)?,
                color: row.get(3)?,
                summary: row.get(4)?,
            })
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(arcs)
}

fn fetch_arc(conn: &Connection, id: i64) -> Result<StoryArc> {
    conn.query_row(
        "SELECT id, title, kind, color, summary FROM story_arcs WHERE id = ?1",
        params![id],
        |row| {
            Ok(StoryArc {
                id: row.get(0)?,
                title: row.get(1)?,
                kind: row.get(2)?,
                color: row.get(3)?,
                summary: row.get(4)?,
            })
        },
    )
    .map_err(|_| AppError::Msg("剧情线不存在".into()))
}

/// 伏笔超期阈值（settings 表可配，缺省 10 章）
fn overdue_threshold(conn: &Connection) -> i64 {
    let v: Option<String> = conn
        .query_row(
            "SELECT value FROM settings WHERE key = ?1",
            params![OVERDUE_THRESHOLD_KEY],
            |r| r.get(0),
        )
        .ok();
    v.and_then(|s| s.parse::<i64>().ok())
        .unwrap_or(DEFAULT_OVERDUE_THRESHOLD)
        .clamp(1, 500)
}

/// 存活章节索引：chapter_id → (全局序, volume_id, 标题, 状态)
fn alive_chapter_index(conn: &Connection) -> Result<HashMap<i64, (i64, i64, String, i32)>> {
    let mut stmt = conn.prepare(
        "SELECT c.id, c.volume_id, c.title, c.status,
                ROW_NUMBER() OVER (ORDER BY v.sort_order, c.sort_order, c.id) - 1
         FROM chapters c JOIN volumes v ON v.id = c.volume_id
         WHERE c.deleted_at IS NULL
         ORDER BY v.sort_order, c.sort_order, c.id",
    )?;
    let rows = stmt.query_map(
        [],
        |r| -> rusqlite::Result<(i64, (i64, i64, String, i32))> {
            Ok((
                r.get(0)?,
                (r.get(4)?, r.get(1)?, r.get(2)?, r.get(3)?),
            ))
        },
    )?;
    let mut map = HashMap::new();
    for row in rows {
        let (id, v) = row?;
        map.insert(id, v);
    }
    Ok(map)
}

/// 每卷的（首章全局序, 末章全局序），用于卷级伏笔的保守跨度估算
fn volume_bounds(conn: &Connection) -> Result<HashMap<i64, (i64, i64)>> {
    let mut stmt = conn.prepare(
        "SELECT volume_id, MIN(ord), MAX(ord) FROM (
             SELECT c.volume_id,
                    ROW_NUMBER() OVER (ORDER BY v.sort_order, c.sort_order, c.id) - 1 AS ord
             FROM chapters c JOIN volumes v ON v.id = c.volume_id
             WHERE c.deleted_at IS NULL
         ) GROUP BY volume_id",
    )?;
    let map = stmt
        .query_map([], |r| {
            Ok((r.get::<_, i64>(0)?, (r.get::<_, i64>(1)?, r.get::<_, i64>(2)?)))
        })?
        .filter_map(|r| r.ok())
        .collect();
    Ok(map)
}

/// 位置描述：「第2卷」或「第2卷·第15章 玉佩现世」。
/// chapter 为 Some（章级锚点存活）时展开章级；章在回收站时标注。
fn pos_desc(
    vol_no: i64,
    vol_title: &str,
    chapter: Option<(i64, i64, String, i32)>, // (order, volume_id, title, status)
    trashed_title: Option<&str>,
) -> String {
    match chapter {
        Some((order, _, title, _)) => {
            format!("第{}卷·第{}章 {}", vol_no, order + 1, title)
        }
        None => match trashed_title {
            Some(t) => format!("第{}卷·「{t}」（回收站）", vol_no),
            None => format!("第{}卷 {}", vol_no, vol_title),
        },
    }
}

/// 伏笔跨度：章级锚点用其全局序；卷级锚点保守取「埋卷末章 → 收卷首章」。
/// 任一端无法定序（如空卷）时返回 0（不参与超期判断）。
fn foreshadow_span(
    edge: &StoryEdge,
    chapter_idx: &HashMap<i64, (i64, i64, String, i32)>,
    bounds: &HashMap<i64, (i64, i64)>,
) -> i64 {
    let from_order = match edge.from_chapter_id.and_then(|id| chapter_idx.get(&id)) {
        Some((order, _, _, _)) => Some(*order),
        None => bounds.get(&edge.from_node).map(|b| b.1), // 埋设卷末章
    };
    let to_order = match edge.to_chapter_id.and_then(|id| chapter_idx.get(&id)) {
        Some((order, _, _, _)) => Some(*order),
        None => bounds.get(&edge.to_node).map(|b| b.0), // 回收卷首章
    };
    match (from_order, to_order) {
        (Some(f), Some(t)) => (t - f).abs(),
        _ => 0,
    }
}

// ---------- 故事图读取 ----------

/// 全量拉取故事图（卷节点 / 连线 / 弧线）。
/// 删除卷时边随 ON DELETE CASCADE 清理，不存在悬空连线。
#[tauri::command]
pub fn list_story_graph(state: State<'_, AppState>) -> Result<StoryGraph> {
    state.with_project(|db| {
        Ok(StoryGraph {
            nodes: load_nodes(&db.conn)?,
            edges: load_edges(&db.conn)?,
            arcs: load_arcs(&db.conn)?,
        })
    })
}

/// 卷内视图（L2）：卷节点 + 本卷章节（含小节归属 / 画布坐标）+ 小节 + 章间连线
#[tauri::command]
pub fn get_volume_detail(
    state: State<'_, AppState>,
    volume_id: i64,
) -> Result<VolumeDetail> {
    state.with_project(|db| {
        let node = fetch_node(&db.conn, volume_id)?;
        let mut stmt = db.conn.prepare(
            "SELECT c.id, c.title, c.status, c.word_count, c.summary, c.notes, c.sort_order,
                    c.group_id, c.map_x, c.map_y,
                    ROW_NUMBER() OVER (ORDER BY v.sort_order, c.sort_order, c.id) - 1
             FROM chapters c JOIN volumes v ON v.id = c.volume_id
             WHERE c.volume_id = ?1 AND c.deleted_at IS NULL
             ORDER BY v.sort_order, c.sort_order, c.id",
        )?;
        let chapters: Vec<VolumeChapterBrief> = stmt
            .query_map(params![volume_id], |r| {
                Ok(VolumeChapterBrief {
                    id: r.get(0)?,
                    title: r.get(1)?,
                    status: r.get(2)?,
                    word_count: r.get(3)?,
                    summary: r.get(4)?,
                    notes: r.get(5)?,
                    sort_order: r.get(6)?,
                    group_id: r.get(7)?,
                    map_x: r.get(8)?,
                    map_y: r.get(9)?,
                    global_order: r.get(10)?,
                })
            })?
            .filter_map(|r| r.ok())
            .collect();
        let mut gstmt = db.conn.prepare(
            "SELECT id, volume_id, title, sort_order FROM chapter_groups
             WHERE volume_id = ?1 ORDER BY sort_order, id",
        )?;
        let groups = gstmt
            .query_map(params![volume_id], |r| {
                Ok(ChapterGroup {
                    id: r.get(0)?,
                    volume_id: r.get(1)?,
                    title: r.get(2)?,
                    sort_order: r.get(3)?,
                })
            })?
            .filter_map(|r| r.ok())
            .collect();
        let mut estmt = db.conn.prepare(
            "SELECT ce.id, ce.from_chapter, ce.to_chapter, ce.edge_type, ce.label, ce.status, ce.bend
             FROM chapter_edges ce
             JOIN chapters cf ON cf.id = ce.from_chapter
             WHERE cf.volume_id = ?1 AND cf.deleted_at IS NULL
             ORDER BY ce.id",
        )?;
        let chapter_edges = estmt
            .query_map(params![volume_id], |r| {
                Ok(ChapterEdge {
                    id: r.get(0)?,
                    from_chapter: r.get(1)?,
                    to_chapter: r.get(2)?,
                    edge_type: r.get(3)?,
                    label: r.get(4)?,
                    status: r.get(5)?,
                    bend: r.get(6)?,
                })
            })?
            .filter_map(|r| r.ok())
            .collect();
        let mut gestmt = db.conn.prepare(
            "SELECT id, volume_id, from_group, to_group, to_chapter, edge_type, label, status, bend
             FROM group_edges WHERE volume_id = ?1 ORDER BY id",
        )?;
        let group_edges = gestmt
            .query_map(params![volume_id], |r| {
                Ok(GroupEdge {
                    id: r.get(0)?,
                    volume_id: r.get(1)?,
                    from_group: r.get(2)?,
                    to_group: r.get(3)?,
                    to_chapter: r.get(4)?,
                    edge_type: r.get(5)?,
                    label: r.get(6)?,
                    status: r.get(7)?,
                    bend: r.get(8)?,
                })
            })?
            .filter_map(|r| r.ok())
            .collect();
        let mut cstmt = db.conn.prepare(
            "SELECT p.character_id, p.map_x, p.map_y
             FROM char_volume_pos p
             JOIN characters c ON c.id = p.character_id
             WHERE p.volume_id = ?1",
        )?;
        let char_positions = cstmt
            .query_map(params![volume_id], |r| {
                Ok(CharacterCanvasPos {
                    character_id: r.get(0)?,
                    map_x: r.get(1)?,
                    map_y: r.get(2)?,
                })
            })?
            .filter_map(|r| r.ok())
            .collect();
        let mut bstmt = db.conn.prepare(
            "SELECT b.id, b.character_id, b.volume_id, b.chapter_id
             FROM character_bindings b
             LEFT JOIN chapters c ON c.id = b.chapter_id
             WHERE b.volume_id = ?1
                OR (b.chapter_id IS NOT NULL AND c.volume_id = ?1 AND c.deleted_at IS NULL)
             ORDER BY b.id",
        )?;
        let bindings = bstmt
            .query_map(params![volume_id], |r| {
                Ok(CharacterBinding {
                    id: r.get(0)?,
                    character_id: r.get(1)?,
                    volume_id: r.get(2)?,
                    chapter_id: r.get(3)?,
                })
            })?
            .filter_map(|r| r.ok())
            .collect();
        Ok(VolumeDetail {
            node,
            chapters,
            groups,
            chapter_edges,
            group_edges,
            char_positions,
            bindings,
        })
    })
}

/// 单章故事上下文（右栏「本章发展」卡：卷来龙去脉 + 卷内前后章 + 伏笔债）
#[tauri::command]
pub fn get_chapter_story_context(
    state: State<'_, AppState>,
    chapter_id: i64,
) -> Result<ChapterStoryContext> {
    state.with_project(|db| {
        let conn = &db.conn;
        let chapter_idx = alive_chapter_index(conn)?;
        let (_, volume_id, _, _) = *chapter_idx
            .get(&chapter_id)
            .ok_or_else(|| AppError::Msg("章节不在故事图中（可能已删除或进入回收站）".into()))?;
        let volume = fetch_node(conn, volume_id)?;
        let threshold = overdue_threshold(conn);
        let edges = load_edges(conn)?;
        let bounds = volume_bounds(conn)?;
        let nodes = load_nodes(conn)?;
        let node_by_id: HashMap<i64, StoryNode> =
            nodes.into_iter().map(|n| (n.id, n)).collect();
        // 回收站章节标题（章级锚点指向回收站时标注）
        let mut trashed: HashMap<i64, String> = HashMap::new();
        {
            let mut stmt =
                conn.prepare("SELECT id, title FROM chapters WHERE deleted_at IS NOT NULL")?;
            let rows = stmt.query_map([], |r| {
                Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?))
            })?;
            for r in rows {
                let (id, title) = r?;
                trashed.insert(id, title);
            }
        }

        // ---- 卷的入边 / 出边（上游 / 下游卷） ----
        let mut in_edges: Vec<VolumeEdgeBrief> = Vec::new();
        let mut out_edges: Vec<VolumeEdgeBrief> = Vec::new();
        for e in &edges {
            let vol = |id: i64| node_by_id.get(&id).cloned();
            if e.to_node == volume_id {
                if let Some(v) = vol(e.from_node) {
                    in_edges.push(VolumeEdgeBrief {
                        edge_id: e.id,
                        edge_type: e.edge_type,
                        label: e.label.clone(),
                        volume: v,
                    });
                }
            }
            if e.from_node == volume_id {
                if let Some(v) = vol(e.to_node) {
                    out_edges.push(VolumeEdgeBrief {
                        edge_id: e.id,
                        edge_type: e.edge_type,
                        label: e.label.clone(),
                        volume: v,
                    });
                }
            }
        }
        in_edges.sort_by_key(|b| b.volume.sort_order);
        out_edges.sort_by_key(|b| b.volume.sort_order);

        // ---- 卷内前后章（各 ≤4） ----
        let volume_chapters: Vec<(i64, VolumeChapterBrief)> = {
            let mut stmt = conn.prepare(
                "SELECT c.id, c.title, c.status, c.word_count, c.summary, c.notes,
                        ROW_NUMBER() OVER (ORDER BY v.sort_order, c.sort_order, c.id) - 1
                 FROM chapters c JOIN volumes v ON v.id = c.volume_id
                 WHERE c.volume_id = ?1 AND c.deleted_at IS NULL
                 ORDER BY v.sort_order, c.sort_order, c.id",
            )?;
            let list = stmt
                .query_map(params![volume_id], |r| {
                    Ok((
                        r.get::<_, i64>(0)?,
                        VolumeChapterBrief {
                            id: r.get(0)?,
                            title: r.get(1)?,
                            status: r.get(2)?,
                            word_count: r.get(3)?,
                            summary: r.get(4)?,
                            notes: r.get(5)?,
                            sort_order: 0,
                            global_order: r.get(6)?,
                            group_id: None,
                            map_x: None,
                            map_y: None,
                        },
                    ))
                })?
                .filter_map(|r| r.ok())
                .collect();
            list
        };
        let cur_pos = volume_chapters
            .iter()
            .position(|(id, _)| *id == chapter_id)
            .unwrap_or(0);
        let prev_chapters: Vec<VolumeChapterBrief> = volume_chapters
            [cur_pos.saturating_sub(4)..cur_pos]
            .iter()
            .map(|(_, c)| c.clone())
            .collect();
        let next_chapters: Vec<VolumeChapterBrief> = volume_chapters
            [cur_pos + 1..(cur_pos + 5).min(volume_chapters.len())]
            .iter()
            .map(|(_, c)| c.clone())
            .collect();

        // ---- 伏笔：本章埋设 / 本章回收 / 所属卷级 ----
        let mut planted: Vec<ForeshadowBrief> = Vec::new();
        let mut resolved: Vec<ForeshadowBrief> = Vec::new();
        let mut volume_fs: Vec<ForeshadowBrief> = Vec::new();

        let desc_of = |vol_id: i64, chapter_anchor: Option<i64>| -> (String, Option<i64>, i64) {
            // 返回 (位置描述, 对端章级锚点, 对端卷 id)
            let vn = node_by_id.get(&vol_id).map(|n| n.sort_order + 1).unwrap_or(0);
            let vt = node_by_id.get(&vol_id).map(|n| n.title.as_str()).unwrap_or("?");
            match chapter_anchor {
                Some(cid) => {
                    let desc = if let Some(c) = chapter_idx.get(&cid).cloned() {
                        pos_desc(vn, vt, Some(c), None)
                    } else if let Some(t) = trashed.get(&cid) {
                        pos_desc(vn, vt, None, Some(t))
                    } else {
                        pos_desc(vn, vt, None, None)
                    };
                    (desc, Some(cid), vol_id)
                }
                None => (pos_desc(vn, vt, None, None), None, vol_id),
            }
        };

        for e in &edges {
            if e.edge_type != 4 {
                continue;
            }
            let span = foreshadow_span(e, &chapter_idx, &bounds);
            let overdue = span > threshold;

            if e.from_chapter_id == Some(chapter_id) {
                // 本章埋设 → 对端 = 回收位置
                let (desc, other_ch, other_vol) = desc_of(e.to_node, e.to_chapter_id);
                // 回收端已完稿？章级锚点看该章；卷级看回收卷任一章完稿
                let resolve_done = match e.to_chapter_id {
                    Some(cid) => chapter_idx.get(&cid).map(|(_, _, _, s)| *s == 1).unwrap_or(false),
                    None => node_by_id.get(&e.to_node).map(|n| n.done_chapters > 0).unwrap_or(false),
                };
                planted.push(ForeshadowBrief {
                    edge_id: e.id,
                    label: e.label.clone(),
                    status: e.status,
                    other_desc: desc,
                    other_chapter_id: other_ch,
                    other_volume_id: other_vol,
                    span,
                    overdue,
                    can_resolve: e.status == 0 && resolve_done,
                });
            } else if e.to_chapter_id == Some(chapter_id) {
                // 本章回收 → 对端 = 埋设位置
                let (desc, other_ch, other_vol) = desc_of(e.from_node, e.from_chapter_id);
                resolved.push(ForeshadowBrief {
                    edge_id: e.id,
                    label: e.label.clone(),
                    status: e.status,
                    other_desc: desc,
                    other_chapter_id: other_ch,
                    other_volume_id: other_vol,
                    span,
                    overdue,
                    can_resolve: false,
                });
            } else if (e.from_node == volume_id && e.from_chapter_id.is_none())
                || (e.to_node == volume_id && e.to_chapter_id.is_none())
            {
                // 所属卷的卷级伏笔：本卷端无章锚点
                let from_is_self = e.from_node == volume_id && e.from_chapter_id.is_none();
                let (other_vol_id, other_anchor) = if from_is_self {
                    (e.to_node, e.to_chapter_id)
                } else {
                    (e.from_node, e.from_chapter_id)
                };
                let (desc, other_ch, other_vol) = desc_of(other_vol_id, other_anchor);
                volume_fs.push(ForeshadowBrief {
                    edge_id: e.id,
                    label: e.label.clone(),
                    status: e.status,
                    other_desc: desc,
                    other_chapter_id: other_ch,
                    other_volume_id: other_vol,
                    span,
                    overdue,
                    can_resolve: false,
                });
            }
        }
        planted.sort_by_key(|f| f.span);
        resolved.sort_by_key(|f| f.span);
        volume_fs.sort_by_key(|f| f.span);

        Ok(ChapterStoryContext {
            chapter_id,
            volume,
            volume_in_edges: in_edges,
            volume_out_edges: out_edges,
            prev_chapters,
            next_chapters,
            planted,
            resolved,
            volume_foreshadows: volume_fs,
        })
    })
}

/// 伏笔总览：全部伏笔连线（卷级 + 章级锚点）+ 跨度 + 超期标记
#[tauri::command]
pub fn list_foreshadows(state: State<'_, AppState>) -> Result<Vec<ForeshadowView>> {
    state.with_project(|db| {
        let conn = &db.conn;
        let threshold = overdue_threshold(conn);
        let nodes = load_nodes(conn)?;
        let node_by_id: HashMap<i64, &StoryNode> = nodes.iter().map(|n| (n.id, n)).collect();
        let chapter_idx = alive_chapter_index(conn)?;
        let bounds = volume_bounds(conn)?;
        let mut trashed: HashMap<i64, String> = HashMap::new();
        {
            let mut stmt =
                conn.prepare("SELECT id, title FROM chapters WHERE deleted_at IS NOT NULL")?;
            let rows = stmt.query_map([], |r| {
                Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?))
            })?;
            for r in rows {
                let (id, title) = r?;
                trashed.insert(id, title);
            }
        }

        let edges = load_edges(conn)?;
        let mut out: Vec<ForeshadowView> = Vec::new();
        for e in edges.iter().filter(|e| e.edge_type == 4) {
            let side = |vol_id: i64, chapter_anchor: Option<i64>| -> (String, bool) {
                let Some(node) = node_by_id.get(&vol_id) else {
                    return (String::new(), false); // 卷已被删除（边也该被级联清理，兜底）
                };
                let vn = node.sort_order + 1;
                let vt = node.title.as_str();
                match chapter_anchor {
                    Some(cid) => {
                        if let Some(c) = chapter_idx.get(&cid).cloned() {
                            (pos_desc(vn, vt, Some(c), None), false)
                        } else if let Some(t) = trashed.get(&cid) {
                            (pos_desc(vn, vt, None, Some(t)), true)
                        } else {
                            (pos_desc(vn, vt, None, None), false)
                        }
                    }
                    None => (pos_desc(vn, vt, None, None), false),
                }
            };
            let (from_desc, from_trashed) = side(e.from_node, e.from_chapter_id);
            let (to_desc, to_trashed) = side(e.to_node, e.to_chapter_id);
            if from_desc.is_empty() || to_desc.is_empty() {
                continue; // 兜底：卷缺失的悬空边跳过
            }
            let span = foreshadow_span(e, &chapter_idx, &bounds);
            out.push(ForeshadowView {
                id: e.id,
                label: e.label.clone(),
                status: e.status,
                from_node: e.from_node,
                from_desc,
                to_node: e.to_node,
                to_desc,
                from_chapter_id: e.from_chapter_id,
                to_chapter_id: e.to_chapter_id,
                span,
                overdue: span > threshold,
                arc_id: e.arc_id,
                from_trashed,
                to_trashed,
            });
        }
        out.sort_by_key(|f| {
            let from_order = f
                .from_chapter_id
                .and_then(|cid| chapter_idx.get(&cid).map(|(o, ..)| *o))
                .or_else(|| bounds.get(&f.from_node).map(|b| b.0))
                .unwrap_or(i64::MAX);
            (from_order, f.id)
        });
        Ok(out)
    })
}

// ---------- 剧情线 ----------

#[tauri::command]
pub fn list_story_arcs(state: State<'_, AppState>) -> Result<Vec<StoryArc>> {
    state.with_project(|db| load_arcs(&db.conn))
}

#[tauri::command]
pub fn create_story_arc(
    state: State<'_, AppState>,
    title: String,
    kind: i32,
    color: String,
) -> Result<StoryArc> {
    let title = title.trim().to_string();
    if title.is_empty() {
        return Err(AppError::Msg("剧情线名称不能为空".into()));
    }
    if !(0..=2).contains(&kind) {
        return Err(AppError::Msg("无效的剧情线类型".into()));
    }
    state.with_project(|db| {
        db.conn.execute(
            "INSERT INTO story_arcs (title, kind, color) VALUES (?1, ?2, ?3)",
            params![title, kind, color.trim()],
        )?;
        fetch_arc(&db.conn, db.conn.last_insert_rowid())
    })
}

#[tauri::command]
pub fn update_story_arc(
    state: State<'_, AppState>,
    arc_id: i64,
    title: String,
    kind: i32,
    color: String,
    summary: String,
) -> Result<()> {
    let title = title.trim().to_string();
    if title.is_empty() {
        return Err(AppError::Msg("剧情线名称不能为空".into()));
    }
    if !(0..=2).contains(&kind) {
        return Err(AppError::Msg("无效的剧情线类型".into()));
    }
    state.with_project(|db| {
        let n = db.conn.execute(
            "UPDATE story_arcs SET title = ?1, kind = ?2, color = ?3, summary = ?4,
                 updated_at = datetime('now','localtime')
             WHERE id = ?5",
            params![title, kind, color.trim(), summary, arc_id],
        )?;
        if n == 0 {
            return Err(AppError::Msg("剧情线不存在".into()));
        }
        Ok(())
    })
}

/// 删除剧情线。story_edges.arc_id 由 ON DELETE SET NULL 自动清空，连线本身不受影响。
#[tauri::command]
pub fn delete_story_arc(state: State<'_, AppState>, arc_id: i64) -> Result<()> {
    state.with_project(|db| {
        let n = db
            .conn
            .execute("DELETE FROM story_arcs WHERE id = ?1", params![arc_id])?;
        if n == 0 {
            return Err(AppError::Msg("剧情线不存在".into()));
        }
        Ok(())
    })
}

// ---------- 节点（卷） ----------

/// 保存节点画布坐标（拖拽松手落库）。归一化 0..1，越界值夹紧，
/// 不再强制 0..1：自由画布允许拖出可视区，夹紧到 -0.5..1.5 防止彻底丢失。
#[tauri::command]
pub fn move_story_node(
    state: State<'_, AppState>,
    volume_id: i64,
    map_x: f64,
    map_y: f64,
) -> Result<()> {
    state.with_project(|db| {
        let n = db.conn.execute(
            "UPDATE volumes SET map_x = ?1, map_y = ?2,
                 updated_at = datetime('now','localtime')
             WHERE id = ?3",
            params![
                // 画布按内容动态扩展，放宽到足够大的世界坐标范围（仅挡 NaN/异常值），
                // 与自动布局「不 clamp、fitView 缩放」保持一致（审查 P1-2）
                map_x.clamp(-5.0, 6.0),
                map_y.clamp(-5.0, 6.0),
                volume_id
            ],
        )?;
        if n == 0 {
            return Err(AppError::Msg("卷不存在".into()));
        }
        Ok(())
    })
}


/// 自动布局：泳道式分层布局（替代旧的蛇形网格），坐标归一化 0..1 落库。
///
/// 详见 [`compute_layout`] 的规则说明。顺序边（edge_type=0）为派生数据：
/// 整体删除后按 主线相邻 / 同泳道按列相邻 重建；因果 / 分支 / 汇合 / 伏笔边
/// 是手工数据，本函数不动。返回参与布局的节点数。
#[tauri::command]
pub fn auto_layout_story_map(state: State<'_, AppState>) -> Result<usize> {
    state.with_project(|db| {
        let nodes = load_nodes(&db.conn)?;
        let n = nodes.len();
        if n == 0 {
            return Ok(0);
        }
        let edges = load_edges(&db.conn)?;
        let arcs = load_arcs(&db.conn)?;

        let layout = compute_layout(&nodes, &arcs, &edges);

        // 坐标（固定世界步长，以内容中心对称展开，不做 clamp）：
        // 旧实现固定列距后把坐标夹到 0.02..0.98，卷数一多（约 7+）边缘节点
        // 全被压到同一坐标而重叠。坐标允许落在 0..1 之外，由前端 fitView 按
        // 实际包围盒缩放——少节点保持紧凑，多节点也绝不重叠（审查 P1-2）。
        const COL_STEP: f64 = 280.0 / 1600.0; // 列间距（含节点宽 212 + 68 间隙）
        const ROW_STEP: f64 = 170.0 / 1000.0; // 泳道间距（含节点高 92 + 78 间隙）
        let max_col = layout.col.values().max().copied().unwrap_or(0);
        let lane_vals: Vec<i32> = layout.lane.values().copied().collect();
        let min_lane = lane_vals.iter().copied().min().unwrap_or(0);
        let max_lane = lane_vals.iter().copied().max().unwrap_or(0);
        // 泳道整体相对 0.5 居中（支线可能为负泳道）
        let lane_center = f64::from(min_lane + max_lane) / 2.0;

        let tx = db.conn.unchecked_transaction()?;
        // 重建前先抢救旧顺序边的剧情线归属：用户手工给顺序边染的剧情线颜色，
        // 不能因为自动布局删旧建新就被抹掉（此前重建后 arc_id 一律丢成 NULL）
        let old_seq_arcs: HashMap<(i64, i64), i64> = {
            let mut st = tx.prepare(
                "SELECT from_node, to_node, arc_id FROM story_edges
                 WHERE edge_type = 0 AND arc_id IS NOT NULL",
            )?;
            let rows = st.query_map([], |r| Ok(((r.get(0)?, r.get(1)?), r.get(2)?)))?;
            let mut m = HashMap::new();
            for r in rows {
                let (pair, arc_id) = r?;
                m.insert(pair, arc_id);
            }
            m
        };
        tx.execute("DELETE FROM story_edges WHERE edge_type = 0", [])?;
        for (a, b) in &layout.seq_pairs {
            let arc_id = old_seq_arcs.get(&(*a, *b)).copied();
            tx.execute(
                "INSERT INTO story_edges (from_node, to_node, edge_type, arc_id) VALUES (?1, ?2, 0, ?3)",
                params![a, b, arc_id],
            )?;
        }
        for nd in &nodes {
            let x = 0.5 + (layout.col[&nd.id] as f64 - max_col as f64 / 2.0) * COL_STEP;
            let y = 0.5 + (f64::from(layout.lane[&nd.id]) - lane_center) * ROW_STEP;
            tx.execute(
                "UPDATE volumes SET map_x = ?1, map_y = ?2 WHERE id = ?3",
                params![x, y, nd.id],
            )?;
        }
        tx.commit()?;
        Ok(n)
    })
}

// ---------- 连线 ----------

/// 校验章级锚点：非空时必须是存活章节且属于指定卷
fn validate_anchor(
    conn: &Connection,
    chapter_id: Option<i64>,
    volume_id: i64,
    side: &str,
) -> Result<()> {
    if let Some(cid) = chapter_id {
        let ok: i64 = conn.query_row(
            "SELECT COUNT(*) FROM chapters
             WHERE id = ?1 AND volume_id = ?2 AND deleted_at IS NULL",
            params![cid, volume_id],
            |r| r.get(0),
        )?;
        if ok == 0 {
            return Err(AppError::Msg(format!("{side}锚点章节不存在或不属于该卷")));
        }
    }
    Ok(())
}

/// 建连线（两端 = 卷）。伏笔（edge_type=4）必须填 label，可带章级锚点；
/// 同卷伏笔要求两端锚点齐全且为不同章；顺序边同方向只允许一条。
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn create_story_edge(
    state: State<'_, AppState>,
    from_node: i64,
    to_node: i64,
    edge_type: i32,
    arc_id: Option<i64>,
    from_chapter_id: Option<i64>,
    to_chapter_id: Option<i64>,
    label: String,
) -> Result<StoryEdge> {
    if !(0..=6).contains(&edge_type) {
        return Err(AppError::Msg("无效的连线类型".into()));
    }
    let label = label.trim().to_string();
    if edge_type == 4 && label.is_empty() {
        return Err(AppError::Msg("伏笔连线需要填写伏笔内容".into()));
    }
    // 普通边不带章级锚点（伏笔专属能力）
    let (from_chapter_id, to_chapter_id) = if edge_type == 4 {
        (from_chapter_id, to_chapter_id)
    } else {
        (None, None)
    };
    if edge_type != 4 && from_node == to_node {
        return Err(AppError::Msg("连线两端不能是同一卷".into()));
    }
    if edge_type == 4 && from_node == to_node {
        // 同卷伏笔：必须有可区分的章级锚点
        match (from_chapter_id, to_chapter_id) {
            (Some(f), Some(t)) if f != t => {}
            _ => {
                return Err(AppError::Msg(
                    "同卷伏笔需要选择不同的埋设章与回收章".into(),
                ))
            }
        }
    }

    state.with_project(|db| {
        // 分别校验两个端点卷；同卷伏笔时两端相同，IN(?,?) 只会命中一行，
        // 不能用「必须命中 2 行」来判定，否则同卷伏笔会被误判为卷缺失（审查 P1-1）。
        let vol_exists = |id: i64| -> Result<bool> {
            let n: i64 = db.conn.query_row(
                "SELECT COUNT(*) FROM volumes WHERE id = ?1",
                params![id],
                |r| r.get(0),
            )?;
            Ok(n == 1)
        };
        if !vol_exists(from_node)? || !vol_exists(to_node)? {
            return Err(AppError::Msg("卷不存在".into()));
        }
        validate_anchor(&db.conn, from_chapter_id, from_node, "埋设")?;
        validate_anchor(&db.conn, to_chapter_id, to_node, "回收")?;
        if let Some(aid) = arc_id {
            let ok: i64 = db.conn.query_row(
                "SELECT COUNT(*) FROM story_arcs WHERE id = ?1",
                params![aid],
                |r| r.get(0),
            )?;
            if ok == 0 {
                return Err(AppError::Msg("所属剧情线不存在".into()));
            }
        }
        if edge_type == 0 {
            let dup: i64 = db.conn.query_row(
                "SELECT COUNT(*) FROM story_edges
                 WHERE edge_type = 0 AND from_node = ?1 AND to_node = ?2",
                params![from_node, to_node],
                |r| r.get(0),
            )?;
            if dup > 0 {
                return Err(AppError::Msg("这两卷之间已有顺序连线".into()));
            }
        }
        db.conn.execute(
            "INSERT INTO story_edges (from_node, to_node, edge_type, arc_id,
                                      from_chapter_id, to_chapter_id, label)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![from_node, to_node, edge_type, arc_id, from_chapter_id, to_chapter_id, label],
        )?;
        fetch_edge(&db.conn, db.conn.last_insert_rowid())
    })
}

/// 编辑连线：label（因果说明 / 伏笔内容）与所属弧线。
#[tauri::command]
pub fn update_story_edge(
    state: State<'_, AppState>,
    edge_id: i64,
    label: String,
    arc_id: Option<i64>,
) -> Result<()> {
    state.with_project(|db| {
        let n = db.conn.execute(
            "UPDATE story_edges SET label = ?1, arc_id = ?2,
                 updated_at = datetime('now','localtime')
             WHERE id = ?3",
            params![label.trim(), arc_id, edge_id],
        )?;
        if n == 0 {
            return Err(AppError::Msg("连线不存在".into()));
        }
        Ok(())
    })
}

/// 保存连线手动弧度（画布上拖动连线中点松手落库）。
/// bend = 相对类型泳道基准的垂直偏移（世界像素），夹紧 ±400 防止拖飞。
#[tauri::command]
pub fn set_story_edge_bend(state: State<'_, AppState>, edge_id: i64, bend: f64) -> Result<()> {
    state.with_project(|db| {
        let n = db.conn.execute(
            "UPDATE story_edges SET bend = ?1, updated_at = datetime('now','localtime')
             WHERE id = ?2",
            params![bend.clamp(-400.0, 400.0), edge_id],
        )?;
        if n == 0 {
            return Err(AppError::Msg("连线不存在".into()));
        }
        Ok(())
    })
}

/// 伏笔状态流转：0=活跃 1=已回收 2=失效（仅伏笔边有效）
#[tauri::command]
pub fn set_foreshadow_status(state: State<'_, AppState>, edge_id: i64, status: i32) -> Result<()> {
    if !(0..=2).contains(&status) {
        return Err(AppError::Msg("无效的伏笔状态".into()));
    }
    state.with_project(|db| {
        let n = db.conn.execute(
            "UPDATE story_edges SET status = ?1, updated_at = datetime('now','localtime')
             WHERE id = ?2 AND edge_type = 4",
            params![status, edge_id],
        )?;
        if n == 0 {
            return Err(AppError::Msg("伏笔连线不存在".into()));
        }
        Ok(())
    })
}

#[tauri::command]
pub fn delete_story_edge(state: State<'_, AppState>, edge_id: i64) -> Result<()> {
    state.with_project(|db| {
        let n = db
            .conn
            .execute("DELETE FROM story_edges WHERE id = ?1", params![edge_id])?;
        if n == 0 {
            return Err(AppError::Msg("连线不存在".into()));
        }
        Ok(())
    })
}

// ---------- 伏笔阈值 ----------

#[tauri::command]
pub fn get_foreshadow_threshold(state: State<'_, AppState>) -> Result<i64> {
    state.with_project(|db| Ok(overdue_threshold(&db.conn)))
}

#[tauri::command]
pub fn set_foreshadow_threshold(state: State<'_, AppState>, threshold: i64) -> Result<()> {
    let t = threshold.clamp(1, 500).to_string();
    state.with_project(|db| {
        db.conn.execute(
            "INSERT INTO settings (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = ?2",
            params![OVERDUE_THRESHOLD_KEY, t],
        )?;
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 章级 / 卷级混合跨度计算的纯逻辑校验（不依赖 DB）
    #[test]
    fn span_mixed_anchors() {
        let mut chapter_idx = HashMap::new();
        // 三卷各 10 章：卷1 = 0..9，卷2 = 10..19，卷3 = 20..29
        for (i, cid) in (1..=30).enumerate() {
            let vol = 100 + (i / 10) as i64;
            chapter_idx.insert(cid as i64, (i as i64, vol, format!("章{i}"), 0));
        }
        let mut bounds = HashMap::new();
        bounds.insert(101, (0, 9));
        bounds.insert(102, (10, 19));
        bounds.insert(103, (20, 29));

        let mk = |from: i64, to: i64, fc: Option<i64>, tc: Option<i64>| StoryEdge {
            id: 1,
            from_node: from,
            to_node: to,
            edge_type: 4,
            arc_id: None,
            from_chapter_id: fc,
            to_chapter_id: tc,
            label: String::new(),
            status: 0,
            bend: 0.0,
        };

        // 章级 → 章级：第 2 章 → 第 25 章 = 23
        let e = mk(101, 103, Some(2), Some(25));
        assert_eq!(foreshadow_span(&e, &chapter_idx, &bounds), 23);
        // 卷级 → 卷级：卷1末章(9) → 卷3首章(20) = 11（保守跨度）
        let e = mk(101, 103, None, None);
        assert_eq!(foreshadow_span(&e, &chapter_idx, &bounds), 11);
        // 章级埋 → 卷级收：章 id=3（全局序 2）→ 卷2首章(10) = 8
        let e = mk(101, 102, Some(3), None);
        assert_eq!(foreshadow_span(&e, &chapter_idx, &bounds), 8);
        // 空卷（无章节）无法定序 → 0
        let mut empty_bounds = HashMap::new();
        empty_bounds.insert(101, (0, 9));
        let e = mk(101, 999, None, None);
        assert_eq!(foreshadow_span(&e, &chapter_idx, &empty_bounds), 0);
    }

    // ---------- compute_layout：分层泳道布局四场景 ----------

    fn nd(id: i64, sort_order: i64, node_type: i32) -> StoryNode {
        StoryNode {
            id,
            title: format!("卷{id}"),
            sort_order,
            summary: String::new(),
            chapter_count: 1,
            done_chapters: 0,
            word_count: 0,
            node_type,
            map_x: None,
            map_y: None,
        }
    }

    fn arc(id: i64, kind: i32) -> StoryArc {
        StoryArc {
            id,
            title: format!("弧{id}"),
            kind,
            color: String::new(),
            summary: String::new(),
        }
    }

    fn edge(id: i64, from: i64, to: i64, et: i32, arc_id: Option<i64>) -> StoryEdge {
        StoryEdge {
            id,
            from_node: from,
            to_node: to,
            edge_type: et,
            arc_id,
            from_chapter_id: None,
            to_chapter_id: None,
            label: String::new(),
            status: 0,
            bend: 0.0,
        }
    }

    /// 场景一：全主线无边——一条线是正确表达（泳道全 0，列 = 阶段序）
    #[test]
    fn layout_all_mainline_is_a_line() {
        let nodes = vec![nd(1, 0, 0), nd(2, 1, 0), nd(3, 2, 0)];
        let l = compute_layout(&nodes, &[], &[]);
        assert_eq!(l.lane, HashMap::from([(1, 0), (2, 0), (3, 0)]));
        assert_eq!(l.col, HashMap::from([(1, 0), (2, 1), (3, 2)]));
        assert!(l.seq_pairs.contains(&(1, 2)));
        assert!(l.seq_pairs.contains(&(2, 3)));
        assert_eq!(l.seq_pairs.len(), 2);
    }

    /// 场景二：主线弧 + 支线弧——支线卷浮上泳道 -1，列 = 上游父列 + 1
    #[test]
    fn layout_branch_arc_goes_up() {
        // 主线弧 A 覆盖 v1→v2→v3；支线弧 B 覆盖 v2→v4
        let nodes = vec![nd(1, 0, 0), nd(2, 1, 0), nd(3, 2, 0), nd(4, 3, 0)];
        let arcs = vec![arc(10, 0), arc(20, 1)];
        let edges = vec![
            edge(1, 1, 2, 0, Some(10)),
            edge(2, 2, 3, 0, Some(10)),
            edge(3, 2, 4, 2, Some(20)), // 分支边，属支线弧
        ];
        let l = compute_layout(&nodes, &arcs, &edges);
        assert_eq!(l.lane[&1], 0);
        assert_eq!(l.lane[&2], 0);
        assert_eq!(l.lane[&3], 0);
        assert_eq!(l.lane[&4], -1, "支线弧卷应浮上泳道 -1");
        assert_eq!(l.col[&4], l.col[&2] + 1, "支线卷列 = 分叉卷列 + 1");
        // 主线相邻顺序边保留；支线泳道单卷无相邻边
        assert!(l.seq_pairs.contains(&(1, 2)));
        assert!(l.seq_pairs.contains(&(2, 3)));
    }

    /// 场景三：无弧线，最长顺序/因果链为主线；分支边子节点上浮一格（workflow 分叉）
    #[test]
    fn layout_no_arcs_longest_chain() {
        // 链 v1→v2→v3（3 节点）比 v2→v4 长 → 主线 = 链，v4 从 v2 分叉上浮
        let nodes = vec![nd(1, 0, 0), nd(2, 1, 0), nd(3, 2, 0), nd(4, 3, 0)];
        let edges = vec![
            edge(1, 1, 2, 1, None), // 因果
            edge(2, 2, 3, 1, None),
            edge(3, 2, 4, 2, None), // 分支
        ];
        let l = compute_layout(&nodes, &[], &edges);
        // v4 由分支边挂靠 → 泳道 -1（父泳道 0 上浮一格），列 = 分叉点 v2 列 + 1
        assert_eq!(l.lane[&4], -1, "分支边子节点应上浮一格（workflow 分叉）");
        assert_eq!(l.col[&4], l.col[&2] + 1, "分叉卷列 = 父卷列 + 1");
        assert_eq!(l.col[&3], 2);
        assert_eq!(l.lane[&3], 0);
    }

    /// 场景四：暗线弧下沉泳道 +1；伏笔边参与列位（回收卷在埋设卷右侧）
    #[test]
    fn layout_dark_arc_sinks_and_foreshadow_drives_col() {
        // 主线弧 A 覆盖 v1→v2（因果边认领）；暗线弧 C 覆盖 v1→v5 的伏笔边
        let nodes = vec![nd(1, 0, 0), nd(2, 1, 0), nd(5, 2, 0)];
        let arcs = vec![arc(10, 0), arc(30, 2)];
        let edges = vec![
            edge(1, 1, 2, 1, Some(10)), // 因果边，属主线弧（顺序边不参与布局）
            edge(2, 1, 5, 4, Some(30)), // 伏笔边，属暗线弧
        ];
        let l = compute_layout(&nodes, &arcs, &edges);
        assert_eq!(l.lane[&5], 1, "暗线弧卷应下沉泳道 +1");
        assert!(l.col[&5] > l.col[&1], "伏笔回收卷应在埋设卷右侧");
    }

    /// 场景五：反馈免疫——自动布局重建的顺序边混入输入不改变布局结果（幂等）。
    /// 此前顺序边反馈进主线识别，连续点「自动布局」每 次结果都不同。
    #[test]
    fn layout_seq_edges_do_not_feed_back() {
        let nodes = vec![nd(1, 0, 0), nd(2, 1, 0), nd(3, 2, 0), nd(4, 3, 0)];
        let hand = vec![
            edge(1, 1, 2, 1, None), // 手工因果
            edge(2, 2, 3, 1, None),
            edge(3, 2, 4, 2, None), // 手工分支
        ];
        let base = compute_layout(&nodes, &[], &hand);
        // 模拟：上一轮自动布局重建出的顺序边（含主线相邻 + 同泳道相邻）混入输入
        let mut with_seq = hand.clone();
        for (i, (a, b)) in base.seq_pairs.iter().enumerate() {
            with_seq.push(edge(100 + i as i64, *a, *b, 0, None));
        }
        let again = compute_layout(&nodes, &[], &with_seq);
        assert_eq!(again.lane, base.lane, "泳道应不受派生顺序边影响");
        assert_eq!(again.col, base.col, "列位应不受派生顺序边影响");
        assert_eq!(again.seq_pairs, base.seq_pairs, "重建顺序边应一致（幂等）");
    }

    /// 场景六：纯线性数据（只有顺序边、无手工结构边）——一条线是正确表达，
    /// 且连续两次自动布局结果完全一致
    #[test]
    fn layout_linear_data_is_stable_line() {
        let nodes = vec![nd(1, 0, 0), nd(2, 1, 0), nd(3, 2, 0), nd(4, 3, 0), nd(5, 4, 0)];
        // 模拟首轮布局后的派生顺序边
        let seq = vec![
            edge(1, 1, 2, 0, None),
            edge(2, 2, 3, 0, None),
            edge(3, 3, 4, 0, None),
            edge(4, 4, 5, 0, None),
        ];
        let a = compute_layout(&nodes, &[], &seq);
        let b = compute_layout(&nodes, &[], &a.seq_pairs.clone().iter()
            .enumerate()
            .map(|(i, (f, t))| edge(100 + i as i64, *f, *t, 0, None))
            .collect::<Vec<_>>());
        assert_eq!(a.lane, b.lane);
        assert_eq!(a.col, b.col);
        assert_eq!(a.seq_pairs, b.seq_pairs);
        assert!(a.lane.values().all(|&l| l == 0), "纯线性数据排一条线");
    }

    /// 场景七：兜底主线剔除分支边目标——v2 分叉出的 v4 不占主线行
    #[test]
    fn layout_fallback_excludes_branch_targets() {
        // 无弧线无因果边，只有一条手工分支边 v2→v4
        let nodes = vec![nd(1, 0, 0), nd(2, 1, 0), nd(3, 2, 0), nd(4, 3, 0)];
        let edges = vec![edge(1, 2, 4, 2, None)];
        let l = compute_layout(&nodes, &[], &edges);
        // 主线 = v1,v2,v3（v4 被剔除）；v4 分支上浮泳道 -1，列 = v2 + 1
        assert_eq!(l.lane[&1], 0);
        assert_eq!(l.lane[&2], 0);
        assert_eq!(l.lane[&3], 0);
        assert_eq!(l.lane[&4], -1, "分支边目标不占主线行");
        assert_eq!(l.col[&4], l.col[&2] + 1);
        assert_eq!(l.col[&3], 2, "主线列按序推进（跳过 v4）");
        // 顺序边重建：主线相邻（不含 v4）
        assert!(l.seq_pairs.contains(&(1, 2)));
        assert!(l.seq_pairs.contains(&(2, 3)));
        assert!(!l.seq_pairs.contains(&(3, 4)), "v4 不在主线，不该有主线相邻边");
    }

    /// 场景八补充：分支边反向（支线源头 → 主线）——源头卷浮上泳道 -1 并对齐汇入点列，
    /// 不再贴上主线行、被顺延到行尾（真实数据：v8 --分支--> v1 --因果--> v10）
    #[test]
    fn layout_branch_source_into_main_floats_up() {
        let nodes = vec![nd(1, 0, 0), nd(6, 1, 0), nd(8, 3, 0), nd(9, 4, 0), nd(10, 5, 0)];
        let edges = vec![
            edge(1, 8, 1, 2, None),  // 分支：v8 → v1（支线汇入主线）
            edge(2, 1, 10, 1, None), // 因果：v1 → v10（主线）
        ];
        let l = compute_layout(&nodes, &[], &edges);
        assert_eq!(l.lane[&1], 0);
        assert_eq!(l.lane[&10], 0, "主线行只有主线卷");
        assert_eq!(l.lane[&8], -1, "分支源是支线侧，应浮上泳道 -1");
        assert_eq!(l.col[&8], l.col[&1], "支线源头对齐汇入点列");
        // 孤立卷 v6、v9 停泊在主线下方，与支线泳道分开
        assert!(l.lane[&6] >= 1 && l.lane[&6] == l.lane[&9]);
        assert!(l.seq_pairs.contains(&(1, 10)));
        assert!(!l.seq_pairs.iter().any(|p| p.0 == 8 || p.1 == 8));
    }

    /// 场景九补充：无弧线时伏笔边的回收方下沉泳道 +1（伏笔跨泳道：暗线向下）
    #[test]
    fn layout_foreshadow_target_sinks_without_arc() {
        let nodes = vec![nd(1, 0, 0), nd(2, 1, 0), nd(5, 2, 0)];
        let edges = vec![
            edge(1, 1, 2, 1, None), // 因果：v1 → v2（主线）
            edge(2, 1, 5, 4, None), // 伏笔：v1 埋设 → v5 回收（无弧线）
        ];
        let l = compute_layout(&nodes, &[], &edges);
        assert_eq!(l.lane[&1], 0);
        assert_eq!(l.lane[&2], 0);
        assert_eq!(l.lane[&5], 1, "伏笔回收方应下沉暗线侧泳道");
        assert!(l.col[&5] > l.col[&1], "回收卷在埋设卷右侧");
    }

    /// 场景八：孤立卷停泊——与任何手工边都不相连的卷排到主线下方独立泳道，
    /// 且不为它们编造顺序边（此前被串进主线行尾形成假故事流）
    #[test]
    fn layout_isolated_volumes_park_below() {
        // 主线 v1→v2（因果）；v5、v6 完全无边（孤立）
        let nodes = vec![nd(1, 0, 0), nd(2, 1, 0), nd(5, 2, 0), nd(6, 3, 0)];
        let edges = vec![edge(1, 1, 2, 1, None)];
        let l = compute_layout(&nodes, &[], &edges);
        assert_eq!(l.lane[&1], 0);
        assert_eq!(l.lane[&2], 0);
        assert!(l.lane[&5] >= 1, "孤立卷应停泊在主线下方独立泳道");
        assert_eq!(l.lane[&5], l.lane[&6], "孤立卷同一停泊泳道");
        assert_eq!(l.col[&5], 0);
        assert_eq!(l.col[&6], 1, "孤立卷按阶段序排开");
        // 顺序边只重建主线相邻：孤立卷不参与、不被串连
        assert!(l.seq_pairs.contains(&(1, 2)));
        assert!(
            !l.seq_pairs.iter().any(|(a, b)| *a == 5 || *b == 5 || *a == 6 || *b == 6),
            "不该为孤立卷编造顺序边"
        );
    }

    /// 场景九：同泳道互无关联的卷不被「同泳道相邻」串连（编造防护）。
    /// 两条独立分支挂在不同列的同泳道，彼此之间不该出现顺序边。
    #[test]
    fn layout_same_lane_unrelated_not_chained() {
        // 主线 v1→v2→v3（因果）；v4、v5 分别从 v1、v2 分支（同泳道 -1）
        let nodes = vec![nd(1, 0, 0), nd(2, 1, 0), nd(3, 2, 0), nd(4, 3, 0), nd(5, 4, 0)];
        let edges = vec![
            edge(1, 1, 2, 1, None),
            edge(2, 2, 3, 1, None),
            edge(3, 1, 4, 2, None), // 分支：v1 → v4
            edge(4, 2, 5, 2, None), // 分支：v2 → v5
        ];
        let l = compute_layout(&nodes, &[], &edges);
        assert_eq!(l.lane[&4], -1);
        assert_eq!(l.lane[&5], -1, "两条分支同泳道");
        // 关键断言：v4 与 v5 之间没有顺序边（它们互无关联）
        assert!(
            !l.seq_pairs.contains(&(4, 5)) && !l.seq_pairs.contains(&(5, 4)),
            "同泳道互无关联的卷不该被串连"
        );
        // 主线相邻保留
        assert!(l.seq_pairs.contains(&(1, 2)));
        assert!(l.seq_pairs.contains(&(2, 3)));
    }

    /// 场景十：20 卷长主线——所有节点的 (列,泳道) 必须两两不同，
    /// 这是「固定步长、不 clamp」后坐标不重叠的前提（审查 P1-2 回归）
    #[test]
    fn layout_many_nodes_have_unique_cells() {
        let nodes: Vec<StoryNode> = (0..20)
            .map(|i| nd(i + 1, i, 0))
            .collect();
        let edges: Vec<StoryEdge> = (0..19)
            .map(|i| edge(i, i + 1, i + 2, 1, None))
            .collect();
        let l = compute_layout(&nodes, &[], &edges);
        let mut cells: std::collections::HashSet<(i64, i32)> = std::collections::HashSet::new();
        for n in &nodes {
            let key = (l.col[&n.id], l.lane[&n.id]);
            assert!(cells.insert(key), "节点 {} 与其他节点落在同一格，会重叠", n.id);
        }
        // 固定步长映射下，不同列得到严格不同的 x（验证不会被 clamp 压到同一值）
        const COL_STEP: f64 = 280.0 / 1600.0;
        let max_col = *l.col.values().max().unwrap() as f64;
        let mut xs: Vec<f64> = l
            .col
            .values()
            .map(|&col| 0.5 + (col as f64 - max_col / 2.0) * COL_STEP)
            .collect();
        xs.sort_by(|a, b| a.partial_cmp(b).unwrap());
        for w in xs.windows(2) {
            assert!((w[1] - w[0]).abs() > 1e-9, "相邻列 x 坐标被压成相同值");
        }
    }
}
