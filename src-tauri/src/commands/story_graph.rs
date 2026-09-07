//! 故事图命令：故事地图 / 剧情线 / 伏笔（V6，设计文档 V1.1）。
//!
//! 口径约定：
//! - **全局章节序**：`ORDER BY volumes.sort_order, chapters.sort_order, chapters.id`。
//!   `chapters.sort_order` 是卷内序号，跨卷计算（超期预警 / 跨度）一律用全局序，
//!   禁止直接相减——与导出排序口径一致。
//! - 画布坐标归一化 0..1，存 `chapters.map_x / map_y`，视口变化不失效。
//! - 回收站章节（deleted_at 非 NULL）在图与总览中隐藏；边保留，
//!   彻底删除时随 `ON DELETE CASCADE` 自动清理。
//! - 顺序边是派生数据：`auto_layout_story_map` 整体删除重建，天然无重复；
//!   因果 / 分支 / 汇合 / 伏笔边是手工数据，不受自动布局影响。

use crate::commands::{chapter, AppState};
use crate::error::{AppError, Result};
use crate::models::{
    ChapterDetail, ChapterStoryContext, ForeshadowBrief, ForeshadowView, StoryArc, StoryEdge,
    StoryGraph, StoryNeighbor, StoryNode,
};
use rusqlite::{params, Connection, Row};
use std::collections::{HashMap, HashSet};
use tauri::State;

/// 伏笔超期默认阈值（章）
const DEFAULT_OVERDUE_THRESHOLD: i64 = 10;
/// 超期阈值在 settings 表中的键
const OVERDUE_THRESHOLD_KEY: &str = "foreshadow_overdue_threshold";

// ---------- 查询辅助 ----------

/// 全量加载图节点（含全局章节序）。回收站章节不出现。
fn load_nodes(conn: &Connection) -> Result<Vec<StoryNode>> {
    let mut stmt = conn.prepare(
        "SELECT c.id, c.volume_id, v.title, c.title, c.summary, c.word_count, c.status,
                c.node_type, c.map_x, c.map_y, c.arc_id,
                ROW_NUMBER() OVER (ORDER BY v.sort_order, c.sort_order, c.id) - 1
         FROM chapters c JOIN volumes v ON v.id = c.volume_id
         WHERE c.deleted_at IS NULL
         ORDER BY v.sort_order, c.sort_order, c.id",
    )?;
    let nodes = stmt
        .query_map([], row_to_node)?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(nodes)
}

fn row_to_node(row: &Row) -> rusqlite::Result<StoryNode> {
    Ok(StoryNode {
        id: row.get(0)?,
        volume_id: row.get(1)?,
        volume_title: row.get(2)?,
        title: row.get(3)?,
        summary: row.get(4)?,
        word_count: row.get(5)?,
        status: row.get(6)?,
        node_type: row.get(7)?,
        map_x: row.get(8)?,
        map_y: row.get(9)?,
        arc_id: row.get(10)?,
        global_order: row.get(11)?,
    })
}

fn load_edges(conn: &Connection) -> Result<Vec<StoryEdge>> {
    let mut stmt = conn.prepare(
        "SELECT id, from_node, to_node, edge_type, arc_id, label, status
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
                label: row.get(5)?,
                status: row.get(6)?,
            })
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(edges)
}

fn load_arcs(conn: &Connection) -> Result<Vec<StoryArc>> {
    let mut stmt = conn.prepare(
        "SELECT id, title, kind, color, summary FROM story_arcs ORDER BY kind, id",
    )?;
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

fn fetch_edge(conn: &Connection, id: i64) -> Result<StoryEdge> {
    conn.query_row(
        "SELECT id, from_node, to_node, edge_type, arc_id, label, status
         FROM story_edges WHERE id = ?1",
        params![id],
        |row| {
            Ok(StoryEdge {
                id: row.get(0)?,
                from_node: row.get(1)?,
                to_node: row.get(2)?,
                edge_type: row.get(3)?,
                arc_id: row.get(4)?,
                label: row.get(5)?,
                status: row.get(6)?,
            })
        },
    )
    .map_err(|_| AppError::Msg("连线不存在".into()))
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

// ---------- 故事图读取 ----------

/// 全量拉取故事图（节点 / 连线 / 弧线）。
/// 两端章节在回收站的边被过滤，避免指向不可见节点的悬空连线。
#[tauri::command]
pub fn list_story_graph(state: State<'_, AppState>) -> Result<StoryGraph> {
    state.with_project(|db| {
        let nodes = load_nodes(&db.conn)?;
        let arcs = load_arcs(&db.conn)?;
        let edges = load_edges(&db.conn)?;
        let alive: HashSet<i64> = nodes.iter().map(|n| n.id).collect();
        let edges: Vec<StoryEdge> = edges
            .into_iter()
            .filter(|e| alive.contains(&e.from_node) && alive.contains(&e.to_node))
            .collect();
        Ok(StoryGraph {
            nodes,
            edges,
            arcs,
        })
    })
}

/// 单章故事上下文（右栏「本章发展」卡：来龙去脉 + 伏笔债）
#[tauri::command]
pub fn get_chapter_story_context(
    state: State<'_, AppState>,
    chapter_id: i64,
) -> Result<ChapterStoryContext> {
    state.with_project(|db| {
        let nodes = load_nodes(&db.conn)?;
        let by_id: HashMap<i64, StoryNode> =
            nodes.iter().map(|n| (n.id, n.clone())).collect();
        let current = by_id
            .get(&chapter_id)
            .ok_or_else(|| AppError::Msg("章节不在故事图中（可能已删除）".into()))?
            .clone();
        let arc = match current.arc_id {
            Some(aid) => Some(fetch_arc(&db.conn, aid)?),
            None => None,
        };
        let threshold = overdue_threshold(&db.conn);
        let edges = load_edges(&db.conn)?;
        let alive: HashSet<i64> = by_id.keys().copied().collect();

        let mut upstream: Vec<StoryNeighbor> = Vec::new();
        let mut downstream: Vec<StoryNeighbor> = Vec::new();
        let mut planted: Vec<ForeshadowBrief> = Vec::new();
        let mut resolved: Vec<ForeshadowBrief> = Vec::new();

        for e in &edges {
            if !alive.contains(&e.from_node) || !alive.contains(&e.to_node) {
                continue;
            }
            if e.to_node == chapter_id {
                upstream.push(StoryNeighbor {
                    edge_id: e.id,
                    edge_type: e.edge_type,
                    label: e.label.clone(),
                    node: by_id[&e.from_node].clone(),
                });
            }
            if e.from_node == chapter_id {
                downstream.push(StoryNeighbor {
                    edge_id: e.id,
                    edge_type: e.edge_type,
                    label: e.label.clone(),
                    node: by_id[&e.to_node].clone(),
                });
            }
            if e.edge_type == 4 && (e.from_node == chapter_id || e.to_node == chapter_id) {
                let planted_here = e.from_node == chapter_id;
                let other_id = if planted_here { e.to_node } else { e.from_node };
                let other = by_id[&other_id].clone();
                let span = (other.global_order - current.global_order).abs();
                let brief = ForeshadowBrief {
                    edge_id: e.id,
                    label: e.label.clone(),
                    status: e.status,
                    other_node: other,
                    span,
                    overdue: span > threshold,
                    // 本章埋设 + 回收端已完稿 + 仍活跃 → 「标记已回收」轻提示
                    can_resolve: planted_here && e.status == 0 && by_id[&other_id].status == 1,
                };
                if planted_here {
                    planted.push(brief);
                } else {
                    resolved.push(brief);
                }
            }
        }
        // 按对端全局章节序排列，阅读顺序自然
        upstream.sort_by_key(|n| n.node.global_order);
        downstream.sort_by_key(|n| n.node.global_order);
        planted.sort_by_key(|f| f.other_node.global_order);
        resolved.sort_by_key(|f| f.other_node.global_order);

        Ok(ChapterStoryContext {
            chapter_id,
            arc,
            upstream,
            downstream,
            planted,
            resolved,
        })
    })
}

/// 伏笔总览：全部伏笔连线 + 跨度 + 超期标记。
/// 含回收站章节的伏笔（fromTrashed / toTrashed 标注），跨度按全局章节序差计算。
#[tauri::command]
pub fn list_foreshadows(state: State<'_, AppState>) -> Result<Vec<ForeshadowView>> {
    state.with_project(|db| {
        let threshold = overdue_threshold(&db.conn);
        let nodes = load_nodes(&db.conn)?;
        let by_id: HashMap<i64, &StoryNode> = nodes.iter().map(|n| (n.id, n)).collect();
        // 回收站章节不在 nodes 中，但边要展示（前端标注「在回收站」）
        let mut trashed: HashMap<i64, String> = HashMap::new();
        {
            let mut stmt =
                db.conn.prepare("SELECT id, title FROM chapters WHERE deleted_at IS NOT NULL")?;
            let rows = stmt.query_map([], |r| {
                Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?))
            })?;
            for r in rows {
                let (id, title) = r?;
                trashed.insert(id, title);
            }
        }

        let edges = load_edges(&db.conn)?;
        let mut out: Vec<ForeshadowView> = Vec::new();
        for e in edges.iter().filter(|e| e.edge_type == 4) {
            let from = by_id.get(&e.from_node);
            let to = by_id.get(&e.to_node);
            let from_trashed = from.is_none();
            let to_trashed = to.is_none();
            let from_title = from
                .map(|n| n.title.as_str())
                .or_else(|| trashed.get(&e.from_node).map(|s| s.as_str()));
            let to_title = to
                .map(|n| n.title.as_str())
                .or_else(|| trashed.get(&e.to_node).map(|s| s.as_str()));
            // 两端都彻底删除的边已被 CASCADE 清理；取不到标题则跳过兜底
            let (Some(ft), Some(tt)) = (from_title, to_title) else {
                continue;
            };
            let span = match (from, to) {
                (Some(f), Some(t)) => (t.global_order - f.global_order).abs(),
                // 一端在回收站无法计算跨度，不参与超期判断
                _ => 0,
            };
            out.push(ForeshadowView {
                id: e.id,
                label: e.label.clone(),
                status: e.status,
                from_node: e.from_node,
                from_title: ft.to_string(),
                to_node: e.to_node,
                to_title: tt.to_string(),
                span,
                overdue: span > threshold,
                arc_id: e.arc_id,
                from_trashed,
                to_trashed,
            });
        }
        out.sort_by_key(|f| {
            let from_order = by_id
                .get(&f.from_node)
                .map(|n| n.global_order)
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

/// 删除剧情线。chapters.arc_id / story_edges.arc_id 由 ON DELETE SET NULL 自动清空，
/// 章节与连线本身不受影响。
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

/// 设置节点弧线归属（泳道分行 / 节点着色的直接依据）。
/// arc_id = NULL 表示移出所有剧情线（进「未分类」泳道）。
#[tauri::command]
pub fn set_node_arc(
    state: State<'_, AppState>,
    chapter_id: i64,
    arc_id: Option<i64>,
) -> Result<()> {
    state.with_project(|db| {
        if let Some(aid) = arc_id {
            let ok: i64 = db.conn.query_row(
                "SELECT COUNT(*) FROM story_arcs WHERE id = ?1",
                params![aid],
                |r| r.get(0),
            )?;
            if ok == 0 {
                return Err(AppError::Msg("剧情线不存在".into()));
            }
        }
        let n = db.conn.execute(
            "UPDATE chapters SET arc_id = ?1, updated_at = datetime('now','localtime')
             WHERE id = ?2 AND deleted_at IS NULL",
            params![arc_id, chapter_id],
        )?;
        if n == 0 {
            return Err(AppError::Msg("章节不存在（可能已删除）".into()));
        }
        Ok(())
    })
}

// ---------- 节点（坐标 / 规划节点） ----------

/// 保存画布坐标（拖拽防抖落库）。归一化 0..1，越界值夹紧。
#[tauri::command]
pub fn move_story_node(
    state: State<'_, AppState>,
    chapter_id: i64,
    map_x: f64,
    map_y: f64,
) -> Result<()> {
    state.with_project(|db| {
        let n = db.conn.execute(
            "UPDATE chapters SET map_x = ?1, map_y = ?2 WHERE id = ?3",
            params![map_x.clamp(0.0, 1.0), map_y.clamp(0.0, 1.0), chapter_id],
        )?;
        if n == 0 {
            return Err(AppError::Msg("章节不存在".into()));
        }
        Ok(())
    })
}

/// 新建规划节点 = 空章节 + node_type 标注（1=事件 2=转折 3=支线 4=结局），
/// 落指定卷末尾。画布上它是大纲卡片，不参与导出（node_type = 0 过滤）。
#[tauri::command]
pub fn create_planning_node(
    state: State<'_, AppState>,
    volume_id: i64,
    title: String,
    node_type: i32,
) -> Result<ChapterDetail> {
    if !(1..=4).contains(&node_type) {
        return Err(AppError::Msg("无效的规划节点类型".into()));
    }
    state.with_project(|db| {
        let exists: i64 = db.conn.query_row(
            "SELECT COUNT(*) FROM volumes WHERE id = ?1",
            params![volume_id],
            |r| r.get(0),
        )?;
        if exists == 0 {
            return Err(AppError::Msg("目标卷不存在".into()));
        }

        let title = {
            let t = title.trim().to_string();
            if t.is_empty() {
                let total: i64 = db.conn.query_row(
                    "SELECT COUNT(*) FROM chapters WHERE deleted_at IS NULL",
                    [],
                    |r| r.get(0),
                )?;
                format!("第{}章", total + 1)
            } else {
                t
            }
        };
        let next: i32 = db.conn.query_row(
            "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM chapters
             WHERE volume_id = ?1 AND deleted_at IS NULL",
            params![volume_id],
            |r| r.get(0),
        )?;

        let tx = db.conn.unchecked_transaction()?;
        tx.execute(
            "INSERT INTO chapters (volume_id, title, sort_order, node_type)
             VALUES (?1, ?2, ?3, ?4)",
            params![volume_id, title, next, node_type],
        )?;
        let id = tx.last_insert_rowid();
        tx.commit()?;
        chapter::fetch_chapter_detail(&db.conn, id)
    })
}

/// 画布移除节点：清坐标 + 删关联边，章节本身保留在目录树
/// （删除正文仍走目录树 → 回收站，防止误删）。
#[tauri::command]
pub fn remove_story_node(state: State<'_, AppState>, chapter_id: i64) -> Result<()> {
    state.with_project(|db| {
        let tx = db.conn.unchecked_transaction()?;
        tx.execute(
            "DELETE FROM story_edges WHERE from_node = ?1 OR to_node = ?2",
            params![chapter_id, chapter_id],
        )?;
        tx.execute(
            "UPDATE chapters SET map_x = NULL, map_y = NULL,
                 updated_at = datetime('now','localtime')
             WHERE id = ?1",
            params![chapter_id],
        )?;
        tx.commit()?;
        Ok(())
    })
}

/// 自动布局：按全局章节序蛇形铺排全部节点坐标，并整体重建顺序边。
/// 重建前由前端弹确认（会覆盖手动拖拽的位置）。返回参与布局的节点数。
#[tauri::command]
pub fn auto_layout_story_map(state: State<'_, AppState>) -> Result<usize> {
    state.with_project(|db| {
        let nodes = load_nodes(&db.conn)?;
        let n = nodes.len();
        if n == 0 {
            return Ok(0);
        }

        // 蛇形网格：每行 10 个，偶数行左→右、奇数行右→左，
        // 顺序连线始终连向空间上的相邻节点
        const COLS: usize = 10;
        let rows = (n + COLS - 1) / COLS;
        let col_span = if COLS > 1 { 0.88 / (COLS - 1) as f64 } else { 0.0 };
        let row_span = if rows > 1 { 0.84 / (rows - 1) as f64 } else { 0.0 };
        let coords: Vec<(f64, f64)> = nodes
            .iter()
            .enumerate()
            .map(|(i, _)| {
                let row = i / COLS;
                let col = i % COLS;
                let col = if row % 2 == 1 { COLS - 1 - col } else { col };
                (
                    0.06 + col as f64 * col_span,
                    0.08 + row as f64 * row_span,
                )
            })
            .collect();

        let tx = db.conn.unchecked_transaction()?;
        tx.execute("DELETE FROM story_edges WHERE edge_type = 0", [])?;
        for (i, node) in nodes.iter().enumerate() {
            let (x, y) = coords[i];
            tx.execute(
                "UPDATE chapters SET map_x = ?1, map_y = ?2 WHERE id = ?3",
                params![x, y, node.id],
            )?;
            if i + 1 < n {
                tx.execute(
                    "INSERT INTO story_edges (from_node, to_node, edge_type)
                     VALUES (?1, ?2, 0)",
                    params![node.id, nodes[i + 1].id],
                )?;
            }
        }
        tx.commit()?;
        Ok(n)
    })
}

// ---------- 连线 ----------

/// 建连线。伏笔（edge_type=4）必须填 label；顺序边同方向只允许一条。
#[tauri::command]
pub fn create_story_edge(
    state: State<'_, AppState>,
    from_node: i64,
    to_node: i64,
    edge_type: i32,
    arc_id: Option<i64>,
    label: String,
) -> Result<StoryEdge> {
    if !(0..=4).contains(&edge_type) {
        return Err(AppError::Msg("无效的连线类型".into()));
    }
    if from_node == to_node {
        return Err(AppError::Msg("连线两端不能是同一章节".into()));
    }
    let label = label.trim().to_string();
    if edge_type == 4 && label.is_empty() {
        return Err(AppError::Msg("伏笔连线需要填写伏笔内容".into()));
    }

    state.with_project(|db| {
        let alive: i64 = db.conn.query_row(
            "SELECT COUNT(*) FROM chapters
             WHERE id IN (?1, ?2) AND deleted_at IS NULL",
            params![from_node, to_node],
            |r| r.get(0),
        )?;
        if alive < 2 {
            return Err(AppError::Msg("章节不存在（或已在回收站）".into()));
        }
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
                return Err(AppError::Msg("这两章之间已有顺序连线".into()));
            }
        }
        db.conn.execute(
            "INSERT INTO story_edges (from_node, to_node, edge_type, arc_id, label)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![from_node, to_node, edge_type, arc_id, label],
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
