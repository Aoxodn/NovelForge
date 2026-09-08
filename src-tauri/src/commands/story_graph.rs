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
use std::collections::{HashMap, HashSet, VecDeque};
use tauri::State;

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
                map_x.clamp(-0.5, 1.5),
                map_y.clamp(-0.5, 1.5),
                volume_id
            ],
        )?;
        if n == 0 {
            return Err(AppError::Msg("卷不存在".into()));
        }
        Ok(())
    })
}

/// 沿 顺序/因果 结构边找最长路径（按阶段序近似拓扑序做 DP，平局按阶段序），
/// 用作无主线弧时的主线兜底。入边邻接需预先过滤为 顺序/因果 边。
fn longest_structural_path(sorted: &[&StoryNode], in_adj: &HashMap<i64, Vec<i64>>) -> Vec<i64> {
    let mut dp_len: HashMap<i64, usize> = HashMap::new();
    let mut dp_prev: HashMap<i64, i64> = HashMap::new();
    for nd in sorted {
        let mut len = 1usize;
        let mut prev: Option<i64> = None;
        if let Some(ins) = in_adj.get(&nd.id) {
            for p in ins {
                if let Some(l) = dp_len.get(p) {
                    if l + 1 > len {
                        len = l + 1;
                        prev = Some(*p);
                    }
                }
            }
        }
        dp_len.insert(nd.id, len);
        if let Some(p) = prev {
            dp_prev.insert(nd.id, p);
        }
    }
    let mut end = sorted[0].id;
    for nd in sorted {
        if dp_len.get(&nd.id) > dp_len.get(&end) {
            end = nd.id;
        }
    }
    let mut chain = Vec::new();
    let mut cur = end;
    loop {
        chain.push(cur);
        match dp_prev.get(&cur) {
            Some(p) if *p != cur => cur = *p,
            _ => break,
        }
    }
    chain.reverse();
    chain
}

/// 分层布局结果（纯计算，不碰 DB）
struct LaneLayout {
    /// 卷 id → 泳道（0=主线，负=上方支线，正=下方暗线/未连接）
    lane: HashMap<i64, i32>,
    /// 卷 id → 列（主线按阶段序；非主线 = 上游父列最大值 + 1）
    col: HashMap<i64, i64>,
    /// 重建的顺序边 (from, to)——仅主线相邻
    seq_pairs: Vec<(i64, i64)>,
}

/// 泳道式分层布局（纯函数）：按 剧情线 / 结构连线 计算每个卷的 (泳道, 列)。
///
/// **幂等性**：顺序边（type=0）是自动布局的派生输出，不作为布局输入——
/// 否则上一次自动布局重建的顺序边会反馈进下一次的主线识别，
/// 造成「每点一次排一个样」的不稳定。
///
/// 结构层次规则（设计文档 V1.2，用户口径）：
/// - **主线识别**：主线弧（kind=0）的卷 → 泳道 0；无主线弧时取最长「因果」链；
///   再兜底全部卷按阶段序（剔除分支边目标——它们作为子流程挂靠，不占主线行）。
///   主线 X 按阶段序等距推进。
/// - **泳道分配**：支线弧（kind=1）逐条排上方泳道（-1, -2, …）；暗线弧（kind=2）
///   逐条排下方泳道（+1, +2, …）；无弧线的卷沿连线按边类型挂靠（BFS）——
///   分支边两端（子节点 / 分支源 / 汇合源）上浮一格，伏笔回收方下沉一格，
///   因果边两端同泳道。
/// - **列位**：非主线列 = 上游父列最大值 + 1（从分叉点向右外扩），
///   同泳道同列自动右移避让；无入边的上游卷（支线源头）对齐其下游目标列。
/// - **孤立卷停泊**：与任何手工边都不相连的卷，统一排到主线下方的
///   「未连接」泳道（按阶段序排开）——不再被塞进主线行、也不再为它们
///   编造顺序连线（此前「同泳道相邻」重建把互无关联的卷串成假主线）。
/// - **顺序边重建**：仅主线相邻；因果 / 分支 / 汇合 / 伏笔边是手工数据，
///   本函数不碰。
///
/// 层次感来自数据：若全部卷是主线且无分支弧，排出来是一条线——那是正确表达。
fn compute_layout(nodes: &[StoryNode], arcs: &[StoryArc], edges: &[StoryEdge]) -> LaneLayout {
    let mut sorted: Vec<&StoryNode> = nodes.iter().collect();
    sorted.sort_by(|a, b| (a.sort_order, a.id).cmp(&(b.sort_order, b.id)));

    // 布局输入 = 手工结构边（因果/分支/汇合/伏笔）；顺序边是派生输出，剔除
    let edges: Vec<StoryEdge> = edges
        .iter()
        .filter(|e| e.edge_type != 0)
        .cloned()
        .collect();
    let edges = &edges[..];

    // ---- 结构邻接：全部边参与泳道挂靠与列位（伏笔「埋→收」也是结构依赖）；
    //      主线 DP 只用因果边（顺序边已被剔除；分支边会让最长链走进支线）；
    //      BFS 挂靠需边类型（分支边子节点上浮一格，workflow 树状展开） ----
    let mut out_adj: HashMap<i64, Vec<i64>> = HashMap::new();
    let mut out_adj_typed: HashMap<i64, Vec<(i64, i32)>> = HashMap::new();
    let mut in_adj: HashMap<i64, Vec<i64>> = HashMap::new();
    let mut in_adj_typed: HashMap<i64, Vec<(i64, i32)>> = HashMap::new();
    let mut in_adj_seq: HashMap<i64, Vec<i64>> = HashMap::new();
    for e in edges {
        out_adj.entry(e.from_node).or_default().push(e.to_node);
        out_adj_typed
            .entry(e.from_node)
            .or_default()
            .push((e.to_node, e.edge_type));
        in_adj.entry(e.to_node).or_default().push(e.from_node);
        in_adj_typed
            .entry(e.to_node)
            .or_default()
            .push((e.from_node, e.edge_type));
        if e.edge_type == 1 {
            in_adj_seq.entry(e.to_node).or_default().push(e.from_node);
        }
    }

    // ---- 卷所属弧线（边的 arc_id → 归属；同卷多弧取第一个，主线弧优先占据，
    //      避免支线伏笔边把主线卷拉离主线泳道） ----
    let arc_kind: HashMap<i64, i32> = arcs.iter().map(|a| (a.id, a.kind)).collect();
    let mut node_arc: HashMap<i64, i64> = HashMap::new();
    let claim = |e: &StoryEdge, node_arc: &mut HashMap<i64, i64>, mainline_only: bool| {
        if let Some(aid) = e.arc_id {
            let is_main = arc_kind.get(&aid) == Some(&0);
            if is_main == mainline_only {
                node_arc.entry(e.from_node).or_insert(aid);
                node_arc.entry(e.to_node).or_insert(aid);
            }
        }
    };
    for e in edges {
        claim(e, &mut node_arc, true);
    }
    for e in edges {
        claim(e, &mut node_arc, false);
    }

    // ---- ① 主线链：主线弧的卷（按阶段序）→ 最长顺序/因果链 → 全部卷 ----
    // 注意：只认「明确归属主线弧」的卷；无弧线时全部卷视为无主线归属，
    // 走最长链识别（否则任何无弧线图都会被当成一条主线，分支无从展开）
    let mut main_chain: Vec<i64> = sorted
        .iter()
        .filter(|nd| {
            node_arc
                .get(&nd.id)
                .and_then(|a| arc_kind.get(a))
                .copied()
                == Some(0)
        })
        .map(|nd| nd.id)
        .collect();
    if main_chain.len() < 2 {
        main_chain = longest_structural_path(&sorted, &in_adj_seq);
    }
    if main_chain.len() < 2 {
        // 兜底：全部卷按阶段序，剔除「分支边目标」——
        // 它们将作为子流程挂靠（父卷右上），不该占主线行（否则有分支边仍排成一条线）
        let branch_targets: HashSet<i64> = edges
            .iter()
            .filter(|e| e.edge_type == 2)
            .map(|e| e.to_node)
            .collect();
        main_chain = sorted
            .iter()
            .map(|nd| nd.id)
            .filter(|id| !branch_targets.contains(id))
            .collect();
        if main_chain.len() < 2 {
            main_chain = sorted.iter().map(|nd| nd.id).collect();
        }
    }

    // ---- ② 泳道分配 ----
    let mut lane: HashMap<i64, i32> = HashMap::new();
    for id in &main_chain {
        lane.insert(*id, 0);
    }
    // 弧线泳道：支线向上（-1,-2,…）、暗线向下（+1,+2,…），按弧 id 稳定
    let mut up = 0i32;
    let mut down = 0i32;
    let mut arc_lanes: HashMap<i64, i32> = HashMap::new();
    for a in arcs.iter().filter(|a| a.kind != 0) {
        if a.kind == 1 {
            up -= 1;
            arc_lanes.insert(a.id, up);
        } else {
            down += 1;
            arc_lanes.insert(a.id, down);
        }
    }
    for nd in &sorted {
        if lane.contains_key(&nd.id) {
            continue;
        }
        if let Some(aid) = node_arc.get(&nd.id) {
            if let Some(l) = arc_lanes.get(aid) {
                lane.insert(nd.id, *l);
            }
        }
    }
    // 剩余卷：BFS 沿边挂靠最近邻泳道，按边类型决定泳道偏移——
    //   · 正向分支边（type=2）的子节点上浮一格（workflow 树状展开：
    //     分叉卷出现在父卷右上，而不是挤进主线行尾）；
    //   · 正向伏笔边（type=4）的回收方下沉一格（伏笔跨泳道：埋设→回收，
    //     回收方属暗线侧，与设计稿「暗线向下」一致）；
    //   · 反向挂靠时，分支源 / 汇合源是支线侧，同样上浮一格——
    //     否则支线侧节点会贴上主线行、被顺延到行尾，看起来像主线的一部分；
    //   · 因果边的另一端与本卷同泳道（同一条故事流）。
    // 队列按（阶段序, id）确定性入队——HashMap 迭代顺序随机，
    // 会造成同一份数据每次自动布局结果不同
    let mut queue: VecDeque<i64> = sorted
        .iter()
        .filter(|nd| lane.contains_key(&nd.id))
        .map(|nd| nd.id)
        .collect();
    let mut placed: HashSet<i64> = lane.keys().copied().collect();
    while let Some(u) = queue.pop_front() {
        let lu = lane[&u];
        for (v, t) in out_adj_typed.get(&u).into_iter().flatten() {
            if placed.insert(*v) {
                let child_lane = match *t {
                    2 => lu - 1, // 分支：支线向上
                    4 => lu + 1, // 伏笔回收：暗线向下
                    _ => lu,
                };
                lane.insert(*v, child_lane);
                queue.push_back(*v);
            }
        }
        for (v, t) in in_adj_typed.get(&u).into_iter().flatten() {
            if placed.insert(*v) {
                let parent_lane = match *t {
                    2 | 3 => lu - 1, // 分支源 / 汇合源：支线侧上浮
                    _ => lu,         // 因果源 / 伏笔埋设方：同泳道
                };
                lane.insert(*v, parent_lane);
                queue.push_back(*v);
            }
        }
    }
    // （孤立卷不在此时分配泳道——列位算完后统一停泊到「未连接」泳道）

    // ---- ③ 列位：主线按序；非主线 = 上游父列最大值 + 1，同泳道同列右移避让 ----
    let mut col: HashMap<i64, i64> = HashMap::new();
    for (i, id) in main_chain.iter().enumerate() {
        col.insert(*id, i as i64);
    }
    let mut col_used: HashMap<i32, HashSet<i64>> = HashMap::new();
    for (id, l) in &lane {
        if let Some(c) = col.get(id) {
            col_used.entry(*l).or_default().insert(*c);
        }
    }
    loop {
        let mut changed = false;
        for nd in &sorted {
            if col.contains_key(&nd.id) {
                continue;
            }
            let mut pc: Option<i64> = None;
            if let Some(ps) = in_adj.get(&nd.id) {
                for p in ps {
                    if let Some(c) = col.get(p) {
                        pc = Some(pc.map_or(*c, |m: i64| m.max(*c)));
                    }
                }
            }
            if let Some(c0) = pc {
                let mut c = c0 + 1;
                let used = col_used.entry(lane[&nd.id]).or_default();
                while used.contains(&c) {
                    c += 1;
                }
                used.insert(c);
                col.insert(nd.id, c);
                changed = true;
            }
        }
        if !changed {
            break;
        }
    }
    // 已挂靠但无入边的上游卷（列仍空）：优先对齐其下游目标列——
    // 支线源头正好悬在汇入点上方，而不是被甩到全局最右；
    // 无下游目标时才顺延到全局最右
    let mut next_col = col.values().max().map_or(0, |m| m + 1);
    for nd in &sorted {
        if col.contains_key(&nd.id) || !lane.contains_key(&nd.id) {
            continue;
        }
        let child_col = out_adj
            .get(&nd.id)
            .into_iter()
            .flatten()
            .filter_map(|t| col.get(t))
            .min()
            .copied();
        let mut c = match child_col {
            Some(c) => c,
            None => {
                let c = next_col;
                next_col += 1;
                c
            }
        };
        let used = col_used.entry(lane[&nd.id]).or_default();
        while used.contains(&c) {
            c += 1;
        }
        used.insert(c);
        col.insert(nd.id, c);
    }

    // ---- 孤立卷停泊：与任何手工边都不相连的卷 → 主线下方「未连接」泳道 ----
    // 不占主线行、不编造顺序边——此前它们被塞进主线行尾并串上顺序箭头，
    // 制造出一条数据里并不存在的故事流
    let park_lane = lane.values().copied().max().unwrap_or(0) + 1;
    let mut park_col = 0i64;
    for nd in &sorted {
        if lane.contains_key(&nd.id) {
            continue;
        }
        lane.insert(nd.id, park_lane);
        let used = col_used.entry(park_lane).or_default();
        while used.contains(&park_col) {
            park_col += 1;
        }
        used.insert(park_col);
        col.insert(nd.id, park_col);
        park_col += 1;
    }

    // ---- ④ 顺序边重建：仅主线相邻 ----
    // 不再做「同泳道按列相邻」——那会为同泳道里互无关联的卷编造顺序关系
    let mut pairs: Vec<(i64, i64)> = Vec::new();
    for w in main_chain.windows(2) {
        pairs.push((w[0], w[1]));
    }
    pairs.sort();
    pairs.dedup();
    let seq_pairs: Vec<(i64, i64)> = pairs.into_iter().filter(|(a, b)| a != b).collect();

    LaneLayout {
        lane,
        col,
        seq_pairs,
    }
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

        // 坐标（workflow 紧凑网格，归一化 0..1 落库）：
        // 固定列距 / 行距（世界像素 280 / 170，与前端 WORLD_W=1600 / WORLD_H=1000 对齐），
        // 以世界中心对称展开——不再按节点数摊满世界宽度（那样少节点时间距被拉到
        // 350px+，fitView 只能缩到 ~70%，节点又小又稀疏）。
        const COL_STEP: f64 = 280.0 / 1600.0; // 列间距（含节点宽 212 + 68 间隙）
        const ROW_STEP: f64 = 170.0 / 1000.0; // 泳道间距（含节点高 92 + 78 间隙）
        let max_col = layout.col.values().max().copied().unwrap_or(0);

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
            let x = (0.5 + (layout.col[&nd.id] as f64 - max_col as f64 / 2.0) * COL_STEP)
                .clamp(0.02, 0.98);
            let y = (0.5 + layout.lane[&nd.id] as f64 * ROW_STEP).clamp(0.03, 0.97);
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
        let alive: i64 = db.conn.query_row(
            "SELECT COUNT(*) FROM volumes WHERE id IN (?1, ?2)",
            params![from_node, to_node],
            |r| r.get(0),
        )?;
        if alive < 2 {
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
        assert!(l.col[&5] >= l.col[&1] + 1, "伏笔回收卷应在埋设卷右侧");
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
        assert!(l.col[&5] >= l.col[&1] + 1, "回收卷在埋设卷右侧");
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
}
