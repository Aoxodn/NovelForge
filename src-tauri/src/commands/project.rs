//! 项目级命令：创建 / 打开 / 关闭 / 最近项目列表。

use crate::commands::AppState;
use crate::db;
use crate::error::{AppError, Result};
use crate::models::{ProjectTree, RecentProject};
use rusqlite::params;
use tauri::State;

/// 去除文件名非法字符（Windows 保留字符）
fn sanitize_dir_name(name: &str) -> String {
    name.chars()
        .map(|c| match c {
            '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            c => c,
        })
        .collect::<String>()
        .trim()
        .to_string()
}

/// 创建新小说项目。
///
/// 目录结构（文档第八节）：
/// ```text
/// <parent_dir>/<书名>/
/// ├── project.novel      项目标识文件
/// ├── database/novel.db  核心 SQLite 数据库
/// ├── chapters/          （预留：章节附件）
/// ├── assets/            （预留：图片 / 封面）
/// ├── exports/           （预留：导出产物）
/// └── backups/           （预留：备份）
/// ```
#[tauri::command]
pub fn create_project(
    state: State<'_, AppState>,
    name: String,
    author: String,
    description: String,
    parent_dir: String,
) -> Result<ProjectTree> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err(AppError::Msg("书名不能为空".into()));
    }
    let dir_name = sanitize_dir_name(&name);
    if dir_name.is_empty() {
        return Err(AppError::Msg("书名不能只包含特殊字符".into()));
    }

    let project_dir = std::path::Path::new(&parent_dir).join(&dir_name);
    if project_dir.exists() {
        return Err(AppError::Msg(format!(
            "目录已存在：{}",
            project_dir.display()
        )));
    }

    // 建立项目目录骨架
    for sub in ["database", "chapters", "assets", "exports", "backups"] {
        std::fs::create_dir_all(project_dir.join(sub))?;
    }

    // 写入项目标识文件
    let marker = serde_json::json!({
        "format": "novelforge-project",
        "version": 1,
        "name": name,
        "createdAt": chrono_now_string(),
    });
    std::fs::write(
        project_dir.join("project.novel"),
        serde_json::to_string_pretty(&marker)?,
    )?;

    // 打开数据库（自动建表）并写入项目信息
    let conn = db::open_project_db(&project_dir.join("database").join("novel.db"))?;
    conn.execute(
        "INSERT INTO project_info (id, name, author, description) VALUES (1, ?1, ?2, ?3)",
        params![name, author.trim(), description.trim()],
    )?;
    // 创建默认卷，保证「小说 → 卷 → 章节」结构统一，用户可直接开写
    conn.execute(
        "INSERT INTO volumes (title, sort_order) VALUES ('正文', 0)",
        [],
    )?;

    state.set_current_project(project_dir.clone(), conn)
}

fn chrono_now_string() -> String {
    // 使用本地时间，与数据库 datetime('now','localtime') 风格一致
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format!("{}", now)
}

/// 打开已有项目。`path` 可以是项目目录，也可以直接选择 project.novel 文件。
#[tauri::command]
pub fn open_project(state: State<'_, AppState>, path: String) -> Result<ProjectTree> {
    let path = std::path::PathBuf::from(path);
    if !path.exists() {
        return Err(AppError::Msg(format!("路径不存在：{}", path.display())));
    }

    let project_dir = if path.is_file() {
        path.parent()
            .ok_or_else(|| AppError::Msg("无效的路径".into()))?
            .to_path_buf()
    } else {
        path
    };

    // 校验标识文件
    db::project::read_project_marker(&project_dir)?;

    let db_path = project_dir.join("database").join("novel.db");
    if !db_path.exists() {
        return Err(AppError::Msg(format!(
            "项目数据库缺失：{}",
            db_path.display()
        )));
    }

    let conn = db::open_project_db(&db_path)?;
    // 打开时校验项目信息完整
    let count: i64 = conn.query_row("SELECT COUNT(*) FROM project_info", [], |r| r.get(0))?;
    if count == 0 {
        return Err(AppError::Msg("项目数据库缺少项目信息（可能已损坏）".into()));
    }

    state.set_current_project(project_dir, conn)
}

/// 关闭当前项目，回到首页
#[tauri::command]
pub fn close_project(state: State<'_, AppState>) -> Result<()> {
    state.close_current_project();
    Ok(())
}

/// 最近打开的项目列表
#[tauri::command]
pub fn list_recent_projects(state: State<'_, AppState>) -> Result<Vec<RecentProject>> {
    state.with_global(|conn| {
        let mut stmt = conn.prepare(
            "SELECT name, path, last_opened_at
             FROM recent_projects
             ORDER BY last_opened_at DESC
             LIMIT 20",
        )?;
        let list = stmt
            .query_map([], |row| {
                Ok(RecentProject {
                    name: row.get(0)?,
                    path: row.get(1)?,
                    last_opened_at: row.get(2)?,
                })
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(list)
    })
}

/// 从最近列表中移除一条记录（不删除项目文件）
#[tauri::command]
pub fn remove_recent_project(state: State<'_, AppState>, path: String) -> Result<()> {
    state.with_global(|conn| {
        conn.execute("DELETE FROM recent_projects WHERE path = ?1", params![path])?;
        Ok(())
    })
}
