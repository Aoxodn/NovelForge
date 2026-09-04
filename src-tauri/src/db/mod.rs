//! 数据库访问层。
//!
//! 架构说明：
//! - 每个小说项目拥有独立的 SQLite 库（`<项目目录>/database/novel.db`），
//!   章节作为独立数据行存储，绝不把整本小说塞进单个 JSON。
//! - 全局库（`%APPDATA%/NovelForge/app.db`）只保存最近项目与应用设置。
//! - 连接统一采用 WAL 模式：写入快、崩溃后可自动恢复。
//!
//! 扩展预留（后续阶段通过新增迁移加入，不影响现有数据）：
//! - 第二阶段导入/拆章：无需新表，章节识别结果在导入流程内完成落库
//! - 人物/地点/时间线/事件：characters、locations、events、timeline 表
//! - 大纲系统：outline_nodes 表
//! - 增量分析缓存：analysis_results 表（配合 chapters.content_hash 做增量分析）

pub mod global;
pub mod migrations;
pub mod project;

use crate::error::Result;
use rusqlite::Connection;
use std::path::Path;

/// 打开（或创建）项目数据库并应用迁移
pub fn open_project_db(db_path: &Path) -> Result<Connection> {
    if let Some(parent) = db_path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let conn = Connection::open(db_path)?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    // NORMAL：WAL 模式下的性能与安全平衡点
    conn.pragma_update(None, "synchronous", "NORMAL")?;
    migrations::apply(&conn)?;
    Ok(conn)
}
