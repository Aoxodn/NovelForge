//! 项目目录树的构建与查询（打开项目 / 刷新树共用）。

use crate::error::{AppError, Result};
use crate::models::{ChapterMeta, ProjectInfo, ProjectStats, ProjectTree, Volume};
use rusqlite::{params, Connection};
use std::path::Path;

/// 读取并校验 project.novel 标识文件，返回项目名
pub fn read_project_marker(project_dir: &Path) -> Result<String> {
    let marker_path = project_dir.join("project.novel");
    let raw = std::fs::read_to_string(&marker_path).map_err(|_| {
        AppError::Msg(format!(
            "所选目录不是有效的 NovelForge 项目（缺少 project.novel）：{}",
            project_dir.display()
        ))
    })?;
    let value: serde_json::Value = serde_json::from_str(&raw)
        .map_err(|_| AppError::Msg("project.novel 标识文件已损坏".into()))?;
    if value.get("format").and_then(|f| f.as_str()) != Some("novelforge-project") {
        return Err(AppError::Msg("project.novel 标识文件格式不正确".into()));
    }
    Ok(value
        .get("name")
        .and_then(|n| n.as_str())
        .unwrap_or("未命名")
        .to_string())
}

/// 一次性构建完整目录树（卷 + 章节元数据 + 统计）
pub fn build_project_tree(conn: &Connection, project_dir: &Path) -> Result<ProjectTree> {
    let info: ProjectInfo = conn
        .query_row(
            "SELECT name, author, description, outline, created_at, updated_at
             FROM project_info WHERE id = 1",
            [],
            |row| {
                Ok(ProjectInfo {
                    name: row.get(0)?,
                    author: row.get(1)?,
                    description: row.get(2)?,
                    outline: row.get(3)?,
                    created_at: row.get(4)?,
                    updated_at: row.get(5)?,
                })
            },
        )
        .map_err(|_| AppError::Msg("项目数据库缺少项目信息（可能已损坏）".into()))?;

    let mut stmt = conn.prepare(
        "SELECT v.id, v.title, v.sort_order, v.summary, v.updated_at,
                (SELECT COUNT(*) FROM chapters c WHERE c.volume_id = v.id AND c.deleted_at IS NULL),
                (SELECT COALESCE(SUM(c.word_count), 0) FROM chapters c WHERE c.volume_id = v.id AND c.deleted_at IS NULL)
         FROM volumes v
         ORDER BY v.sort_order, v.id",
    )?;
    let volumes = stmt
        .query_map([], |row| {
            Ok(Volume {
                id: row.get(0)?,
                title: row.get(1)?,
                sort_order: row.get(2)?,
                summary: row.get(3)?,
                updated_at: row.get(4)?,
                chapter_count: row.get(5)?,
                word_count: row.get(6)?,
            })
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;

    let mut stmt = conn.prepare(
        "SELECT id, volume_id, title, word_count, sort_order, status, node_type, updated_at
         FROM chapters
         WHERE deleted_at IS NULL
         ORDER BY volume_id, sort_order, id",
    )?;
    let chapters = stmt
        .query_map([], |row| {
            Ok(ChapterMeta {
                id: row.get(0)?,
                volume_id: row.get(1)?,
                title: row.get(2)?,
                word_count: row.get(3)?,
                sort_order: row.get(4)?,
                status: row.get(5)?,
                node_type: row.get(6)?,
                updated_at: row.get(7)?,
            })
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;

    let stats = conn.query_row(
        "SELECT COALESCE(SUM(word_count), 0),
                COALESCE(SUM(char_count), 0),
                (SELECT COUNT(*) FROM volumes),
                COUNT(*)
         FROM chapters
         WHERE deleted_at IS NULL",
        [],
        |row| {
            Ok(ProjectStats {
                total_word_count: row.get(0)?,
                total_char_count: row.get(1)?,
                volume_count: row.get(2)?,
                chapter_count: row.get(3)?,
            })
        },
    )?;

    Ok(ProjectTree {
        info,
        project_path: project_dir.to_string_lossy().into_owned(),
        volumes,
        chapters,
        stats,
    })
}

/// 供 commands 层使用的辅助：记录/刷新最近项目
pub fn touch_recent_project(global: &Connection, name: &str, path: &str) -> Result<()> {
    global.execute(
        "INSERT INTO recent_projects (name, path, last_opened_at)
         VALUES (?1, ?2, datetime('now','localtime'))
         ON CONFLICT(path) DO UPDATE SET
            name = ?1, last_opened_at = datetime('now','localtime')",
        params![name, path],
    )?;
    Ok(())
}
