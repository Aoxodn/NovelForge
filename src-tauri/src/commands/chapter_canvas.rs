//! L2 卷内画布命令（v0.9.13 可编辑化）：章节坐标 / 小节（章节群）/ 章间连线。
//!
//! - 章节坐标归一化 0..1 存 `chapters.map_x / map_y`，自由拖动松手落库；
//!   布局策略切换 / 自动布局时整卷重排并落库
//! - 小节 = `chapter_groups` + `chapters.group_id`；删组不删章（FK 置 NULL），
//!   组框位置是组内成员的外包络，随成员拖动而变，无独立坐标字段
//! - 章间连线 = `chapter_edges`，仅限同卷章节；枚举与卷级 story_edges 一致
//!   （0顺序..6闪回），伏笔 label 必填、可流转状态，bend 手动弧度同口径

use crate::commands::AppState;
use crate::error::{AppError, Result};
use crate::models::{ChapterEdge, ChapterGroup, GroupEdge};
use rusqlite::{params, Connection};
use tauri::State;

// ---------- 章节节点坐标 ----------

/// 保存章节画布坐标（拖动松手落库）。归一化，夹紧 -0.5..1.5 防止拖丢。
#[tauri::command]
pub fn move_chapter_node(
    state: State<'_, AppState>,
    chapter_id: i64,
    map_x: f64,
    map_y: f64,
) -> Result<()> {
    state.with_project(|db| {
        let n = db.conn.execute(
            "UPDATE chapters SET map_x = ?1, map_y = ?2,
                 updated_at = datetime('now','localtime')
             WHERE id = ?3 AND deleted_at IS NULL",
            params![map_x.clamp(-0.5, 1.5), map_y.clamp(-0.5, 1.5), chapter_id],
        )?;
        if n == 0 {
            return Err(AppError::Msg("章节不存在".into()));
        }
        Ok(())
    })
}

/// 单个节点的画布坐标（批量移动用）
#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NodePosition {
    pub chapter_id: i64,
    pub map_x: f64,
    pub map_y: f64,
}

/// 批量保存章节画布坐标（小节整体拖动 / 多选拖动）。
/// 单事务一次提交，避免逐章 IPC 失败留下半移动状态（审查 P2-1）。
#[tauri::command]
pub fn move_chapter_nodes(
    state: State<'_, AppState>,
    positions: Vec<NodePosition>,
) -> Result<usize> {
    if positions.is_empty() {
        return Ok(0);
    }
    state.with_project(|db| {
        let tx = db.conn.unchecked_transaction()?;
        {
            let mut stmt = tx.prepare(
                "UPDATE chapters SET map_x = ?1, map_y = ?2,
                     updated_at = datetime('now','localtime')
                 WHERE id = ?3 AND deleted_at IS NULL",
            )?;
            for p in &positions {
                stmt.execute(params![
                    p.map_x.clamp(-0.5, 1.5),
                    p.map_y.clamp(-0.5, 1.5),
                    p.chapter_id
                ])?;
            }
        }
        tx.commit()?;
        Ok(positions.len())
    })
}

// ---------- 章间连线 ----------

const EDGE_TYPE_RANGE: std::ops::RangeInclusive<i32> = 0..=6;

fn fetch_chapter_edge(conn: &Connection, id: i64) -> Result<ChapterEdge> {
    conn.query_row(
        "SELECT id, from_chapter, to_chapter, edge_type, label, status, bend
         FROM chapter_edges WHERE id = ?1",
        params![id],
        |r| {
            Ok(ChapterEdge {
                id: r.get(0)?,
                from_chapter: r.get(1)?,
                to_chapter: r.get(2)?,
                edge_type: r.get(3)?,
                label: r.get(4)?,
                status: r.get(5)?,
                bend: r.get(6)?,
            })
        },
    )
    .map_err(|_| AppError::Msg("章间连线不存在".into()))
}

/// 校验两章节存活且同卷（章间连线不跨卷；跨卷关系走 L1 卷级边）。
/// 分别查询两个端点，明确断言两行都存在且 volume_id 相同
///（旧实现 GROUP BY 后只读首行，两章分属不同卷时仍会误判通过——审查 P1-1）。
fn validate_same_volume(conn: &Connection, a: i64, b: i64) -> Result<i64> {
    if a == b {
        return Err(AppError::Msg("连线两端不能是同一章".into()));
    }
    let fetch_vol = |id: i64| -> Result<Option<i64>> {
        let vol = conn.query_row(
            "SELECT volume_id FROM chapters WHERE id = ?1 AND deleted_at IS NULL",
            params![id],
            |r| r.get::<_, i64>(0),
        );
        match vol {
            Ok(v) => Ok(Some(v)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(e.into()),
        }
    };
    let va = fetch_vol(a)?
        .ok_or_else(|| AppError::Msg("章节不存在，或两章不在同一卷".into()))?;
    let vb = fetch_vol(b)?
        .ok_or_else(|| AppError::Msg("章节不存在，或两章不在同一卷".into()))?;
    if va != vb {
        return Err(AppError::Msg("两章不在同一卷，不能建立章间连线".into()));
    }
    Ok(va)
}

#[tauri::command]
pub fn create_chapter_edge(
    state: State<'_, AppState>,
    from_chapter: i64,
    to_chapter: i64,
    edge_type: i32,
    label: String,
) -> Result<ChapterEdge> {
    if !EDGE_TYPE_RANGE.contains(&edge_type) {
        return Err(AppError::Msg("无效的连线类型".into()));
    }
    let label = label.trim().to_string();
    if edge_type == 4 && label.is_empty() {
        return Err(AppError::Msg("伏笔连线需要填写伏笔内容".into()));
    }
    state.with_project(|db| {
        validate_same_volume(&db.conn, from_chapter, to_chapter)?;
        db.conn.execute(
            "INSERT INTO chapter_edges (from_chapter, to_chapter, edge_type, label)
             VALUES (?1, ?2, ?3, ?4)",
            params![from_chapter, to_chapter, edge_type, label],
        )?;
        fetch_chapter_edge(&db.conn, db.conn.last_insert_rowid())
    })
}

/// 编辑章间连线：label；伏笔可同时流转状态
#[tauri::command]
pub fn update_chapter_edge(
    state: State<'_, AppState>,
    edge_id: i64,
    label: String,
    status: i32,
) -> Result<()> {
    if !(0..=2).contains(&status) {
        return Err(AppError::Msg("无效的伏笔状态".into()));
    }
    state.with_project(|db| {
        let n = db.conn.execute(
            "UPDATE chapter_edges SET label = ?1, status = ?2 WHERE id = ?3",
            params![label.trim(), status, edge_id],
        )?;
        if n == 0 {
            return Err(AppError::Msg("章间连线不存在".into()));
        }
        Ok(())
    })
}

#[tauri::command]
pub fn delete_chapter_edge(state: State<'_, AppState>, edge_id: i64) -> Result<()> {
    state.with_project(|db| {
        let n = db
            .conn
            .execute("DELETE FROM chapter_edges WHERE id = ?1", params![edge_id])?;
        if n == 0 {
            return Err(AppError::Msg("章间连线不存在".into()));
        }
        Ok(())
    })
}

/// 保存章间连线手动弧度（拖弯落库，±400 夹紧）
#[tauri::command]
pub fn set_chapter_edge_bend(state: State<'_, AppState>, edge_id: i64, bend: f64) -> Result<()> {
    state.with_project(|db| {
        let n = db.conn.execute(
            "UPDATE chapter_edges SET bend = ?1 WHERE id = ?2",
            params![bend.clamp(-400.0, 400.0), edge_id],
        )?;
        if n == 0 {
            return Err(AppError::Msg("章间连线不存在".into()));
        }
        Ok(())
    })
}

// ---------- 小节（章节群） ----------

fn fetch_group(conn: &Connection, id: i64) -> Result<ChapterGroup> {
    conn.query_row(
        "SELECT id, volume_id, title, sort_order FROM chapter_groups WHERE id = ?1",
        params![id],
        |r| {
            Ok(ChapterGroup {
                id: r.get(0)?,
                volume_id: r.get(1)?,
                title: r.get(2)?,
                sort_order: r.get(3)?,
            })
        },
    )
    .map_err(|_| AppError::Msg("小节不存在".into()))
}

#[tauri::command]
pub fn create_chapter_group(
    state: State<'_, AppState>,
    volume_id: i64,
    title: String,
) -> Result<ChapterGroup> {
    let title = title.trim().to_string();
    if title.is_empty() {
        return Err(AppError::Msg("小节名称不能为空".into()));
    }
    state.with_project(|db| {
        let ok: i64 = db.conn.query_row(
            "SELECT COUNT(*) FROM volumes WHERE id = ?1",
            params![volume_id],
            |r| r.get(0),
        )?;
        if ok == 0 {
            return Err(AppError::Msg("卷不存在".into()));
        }
        db.conn.execute(
            "INSERT INTO chapter_groups (volume_id, title, sort_order)
             VALUES (?1, ?2, (SELECT COALESCE(MAX(sort_order), -1) + 1
                              FROM chapter_groups WHERE volume_id = ?1))",
            params![volume_id, title],
        )?;
        fetch_group(&db.conn, db.conn.last_insert_rowid())
    })
}

#[tauri::command]
pub fn rename_chapter_group(state: State<'_, AppState>, group_id: i64, title: String) -> Result<()> {
    let title = title.trim().to_string();
    if title.is_empty() {
        return Err(AppError::Msg("小节名称不能为空".into()));
    }
    state.with_project(|db| {
        let n = db.conn.execute(
            "UPDATE chapter_groups SET title = ?1 WHERE id = ?2",
            params![title, group_id],
        )?;
        if n == 0 {
            return Err(AppError::Msg("小节不存在".into()));
        }
        Ok(())
    })
}

/// 删除小节：仅解除分组（chapters.group_id 由 FK ON DELETE SET NULL 置空），章节不受影响
#[tauri::command]
pub fn delete_chapter_group(state: State<'_, AppState>, group_id: i64) -> Result<()> {
    state.with_project(|db| {
        let n = db.conn.execute(
            "DELETE FROM chapter_groups WHERE id = ?1",
            params![group_id],
        )?;
        if n == 0 {
            return Err(AppError::Msg("小节不存在".into()));
        }
        Ok(())
    })
}

/// 章节加入 / 移出小节（group_id = NULL 移出）
#[tauri::command]
pub fn set_chapter_group(
    state: State<'_, AppState>,
    chapter_id: i64,
    group_id: Option<i64>,
) -> Result<()> {
    state.with_project(|db| {
        if let Some(gid) = group_id {
            // JOIN 校验小节与章节必须同卷（旧实现只验小节存在，跨卷也能加入——审查 P1-1）
            let same: i64 = db.conn.query_row(
                "SELECT COUNT(*) FROM chapter_groups g
                 JOIN chapters c ON c.volume_id = g.volume_id AND c.deleted_at IS NULL
                 WHERE g.id = ?1 AND c.id = ?2",
                params![gid, chapter_id],
                |r| r.get(0),
            )?;
            if same == 0 {
                // 区分小节不存在 / 章节不存在 / 跨卷
                let g: i64 = db.conn.query_row(
                    "SELECT COUNT(*) FROM chapter_groups WHERE id = ?1",
                    params![gid],
                    |r| r.get(0),
                )?;
                let c: i64 = db.conn.query_row(
                    "SELECT COUNT(*) FROM chapters WHERE id = ?1 AND deleted_at IS NULL",
                    params![chapter_id],
                    |r| r.get(0),
                )?;
                return Err(if g == 0 {
                    AppError::Msg("小节不存在".into())
                } else if c == 0 {
                    AppError::Msg("章节不存在".into())
                } else {
                    AppError::Msg("章节与小节不属于同一卷，不能加入".into())
                });
            }
        }
        let n = db.conn.execute(
            "UPDATE chapters SET group_id = ?1 WHERE id = ?2 AND deleted_at IS NULL",
            params![group_id, chapter_id],
        )?;
        if n == 0 {
            return Err(AppError::Msg("章节不存在".into()));
        }
        Ok(())
    })
}

// ---------- 小节连线（组框圆点拖出：小节→小节 / 小节→章节） ----------

fn fetch_group_edge(conn: &Connection, id: i64) -> Result<GroupEdge> {
    conn.query_row(
        "SELECT id, volume_id, from_group, to_group, to_chapter, edge_type, label, status, bend
         FROM group_edges WHERE id = ?1",
        params![id],
        |r| {
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
        },
    )
    .map_err(|_| AppError::Msg("小节连线不存在".into()))
}

#[tauri::command]
pub fn create_group_edge(
    state: State<'_, AppState>,
    volume_id: i64,
    from_group: i64,
    to_group: Option<i64>,
    to_chapter: Option<i64>,
    edge_type: i32,
    label: String,
) -> Result<GroupEdge> {
    if !EDGE_TYPE_RANGE.contains(&edge_type) {
        return Err(AppError::Msg("无效的连线类型".into()));
    }
    let label = label.trim().to_string();
    if edge_type == 4 && label.is_empty() {
        return Err(AppError::Msg("伏笔连线需要填写伏笔内容".into()));
    }
    if (to_group.is_none()) == (to_chapter.is_none()) {
        return Err(AppError::Msg("连线目标必须是一个小节或一个章节".into()));
    }
    state.with_project(|db| {
        // 源 / 目标小节必须同卷且不能自己连自己
        let vid: i64 = db
            .conn
            .query_row(
                "SELECT volume_id FROM chapter_groups WHERE id = ?1",
                params![from_group],
                |r| r.get(0),
            )
            .map_err(|_| AppError::Msg("源小节不存在".into()))?;
        if vid != volume_id {
            return Err(AppError::Msg("源小节不属于该卷".into()));
        }
        if let Some(gid) = to_group {
            if gid == from_group {
                return Err(AppError::Msg("连线两端不能是同一个小节".into()));
            }
            let tvid: i64 = db
                .conn
                .query_row(
                    "SELECT volume_id FROM chapter_groups WHERE id = ?1",
                    params![gid],
                    |r| r.get(0),
                )
                .map_err(|_| AppError::Msg("目标小节不存在".into()))?;
            if tvid != volume_id {
                return Err(AppError::Msg("目标小节不属于该卷".into()));
            }
        }
        if let Some(cid) = to_chapter {
            let ok: i64 = db.conn.query_row(
                "SELECT COUNT(*) FROM chapters WHERE id = ?1 AND volume_id = ?2 AND deleted_at IS NULL",
                params![cid, volume_id],
                |r| r.get(0),
            )?;
            if ok == 0 {
                return Err(AppError::Msg("目标章节不存在或不属于该卷".into()));
            }
        }
        db.conn.execute(
            "INSERT INTO group_edges (volume_id, from_group, to_group, to_chapter, edge_type, label)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![volume_id, from_group, to_group, to_chapter, edge_type, label],
        )?;
        fetch_group_edge(&db.conn, db.conn.last_insert_rowid())
    })
}

#[tauri::command]
pub fn update_group_edge(
    state: State<'_, AppState>,
    edge_id: i64,
    label: String,
    status: i32,
) -> Result<()> {
    if !(0..=2).contains(&status) {
        return Err(AppError::Msg("无效的伏笔状态".into()));
    }
    state.with_project(|db| {
        let n = db.conn.execute(
            "UPDATE group_edges SET label = ?1, status = ?2 WHERE id = ?3",
            params![label.trim(), status, edge_id],
        )?;
        if n == 0 {
            return Err(AppError::Msg("小节连线不存在".into()));
        }
        Ok(())
    })
}

#[tauri::command]
pub fn delete_group_edge(state: State<'_, AppState>, edge_id: i64) -> Result<()> {
    state.with_project(|db| {
        let n = db
            .conn
            .execute("DELETE FROM group_edges WHERE id = ?1", params![edge_id])?;
        if n == 0 {
            return Err(AppError::Msg("小节连线不存在".into()));
        }
        Ok(())
    })
}

#[tauri::command]
pub fn set_group_edge_bend(state: State<'_, AppState>, edge_id: i64, bend: f64) -> Result<()> {
    state.with_project(|db| {
        let n = db.conn.execute(
            "UPDATE group_edges SET bend = ?1 WHERE id = ?2",
            params![bend.clamp(-400.0, 400.0), edge_id],
        )?;
        if n == 0 {
            return Err(AppError::Msg("小节连线不存在".into()));
        }
        Ok(())
    })
}


#[cfg(test)]
mod constraint_tests {
    use super::*;

    /// 内存库：两卷，卷1有章1/2，卷2有章3
    fn fixture() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::migrations::apply(&conn).unwrap();
        conn.execute_batch(
            "INSERT INTO volumes (id,title) VALUES (1,'卷一');
             INSERT INTO volumes (id,title) VALUES (2,'卷二');
             INSERT INTO chapters (id,volume_id,title,sort_order) VALUES (1,1,'一',0);
             INSERT INTO chapters (id,volume_id,title,sort_order) VALUES (2,1,'二',1);
             INSERT INTO chapters (id,volume_id,title,sort_order) VALUES (3,2,'三',0);",
        )
        .unwrap();
        conn
    }

    #[test]
    fn same_volume_ok() {
        let conn = fixture();
        // 同卷两章：通过，返回卷 id
        assert_eq!(validate_same_volume(&conn, 1, 2).unwrap(), 1);
    }

    #[test]
    fn cross_volume_rejected() {
        let conn = fixture();
        // 章1（卷1）与章3（卷2）：旧实现 GROUP BY 读首行会误放行，现在必须拒绝
        assert!(validate_same_volume(&conn, 1, 3).is_err());
        assert!(validate_same_volume(&conn, 3, 2).is_err());
    }

    #[test]
    fn missing_or_same_chapter_rejected() {
        let conn = fixture();
        assert!(validate_same_volume(&conn, 1, 999).is_err()); // 不存在
        assert!(validate_same_volume(&conn, 1, 1).is_err()); // 同一章
    }

    #[test]
    fn trigger_blocks_cross_volume_edge() {
        let conn = fixture();
        // 绕过 Rust 校验直接 INSERT 跨卷边，触发器必须拦截
        assert!(conn
            .execute(
                "INSERT INTO chapter_edges (from_chapter,to_chapter,edge_type) VALUES (1,3,0)",
                []
            )
            .is_err(), "跨卷章间连线必须被触发器拒绝");
        // 同卷边允许
        assert!(conn
            .execute(
                "INSERT INTO chapter_edges (from_chapter,to_chapter,edge_type) VALUES (1,2,0)",
                []
            )
            .is_ok());
    }

    #[test]
    fn trigger_blocks_cross_volume_group() {
        let conn = fixture();
        conn.execute("INSERT INTO chapter_groups (id,volume_id,title) VALUES (10,1,'小节A')", [])
            .unwrap();
        // 卷2 的章3 不能加入卷1 的小节
        assert!(conn
            .execute("UPDATE chapters SET group_id=10 WHERE id=3", [])
            .is_err(), "跨卷加入小节必须被触发器拒绝");
        // 同卷章1 可以
        assert!(conn
            .execute("UPDATE chapters SET group_id=10 WHERE id=1", [])
            .is_ok());
    }
}
