//! 项目级命令：创建 / 打开 / 关闭 / 最近项目列表。

use crate::commands::AppState;
use crate::db;
use crate::error::{AppError, Result};
use crate::models::{ProjectTree, RecentProject};
use rusqlite::params;
use tauri::State;

/// Windows 保留设备名（不区分大小写、忽略扩展名），跨平台一律禁止作为目录名
const RESERVED_STEMS: &[&str] = &[
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
    "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

/// 去除文件名非法字符（Windows 保留字符；这些字符在 macOS/Linux 也不建议出现，
/// 统一替换以保证项目目录可在三平台之间复制——审查跨平台项）。
fn sanitize_dir_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| match c {
            '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|' | '\0' => '_',
            // 控制字符同样不可作为跨平台文件名
            c if c.is_control() => '_',
            c => c,
        })
        .collect::<String>()
        .trim()
        // Windows 不允许目录名以空格或句点结尾
        .trim_end_matches([' ', '.'])
        .to_string();
    cleaned
}

/// 校验清洗后的目录名是否可用（保留设备名 / 全点 / 过长等），不可用返回原因。
fn validate_dir_name(dir: &str) -> std::result::Result<(), String> {
    if dir.is_empty() {
        return Err("书名不能只包含特殊字符".into());
    }
    let stem = dir.split('.').next().unwrap_or("").to_ascii_uppercase();
    if RESERVED_STEMS.contains(&stem.as_str()) {
        return Err(format!("「{dir}」是系统保留名称，请换一个书名"));
    }
    if dir.bytes().all(|b| b == b'.' || b == b' ') {
        return Err("书名不能全是句点或空格".into());
    }
    // 跨平台单段文件名上限取 255 字节的保守值
    if dir.len() > 200 {
        return Err("书名过长，请精简后再创建".into());
    }
    Ok(())
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
    validate_dir_name(&dir_name).map_err(AppError::Msg)?;

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

/// 只读获取当前项目目录树（复用现有连接，不重新打开数据库、不更换当前项目）。
/// 保存后静默刷新用，避免 open_project 重开库与 close/切换项目之间的竞态（审查 P0-3）。
#[tauri::command]
pub fn get_current_project_tree(state: State<'_, AppState>) -> Result<ProjectTree> {
    state.current_project_tree()
}

/// 保存全书大纲（主线 / 设定 / 梗概，存 project_info.outline）
#[tauri::command]
pub fn update_project_outline(state: State<'_, AppState>, outline: String) -> Result<()> {
    state.with_project(|db| {
        db.conn.execute(
            "UPDATE project_info SET outline = ?1, updated_at = datetime('now','localtime') WHERE id = 1",
            params![outline],
        )?;
        Ok(())
    })
}

/// 更新项目信息：书名 / 作者 / 简介。
///
/// 同步更新三处：project_info 表、project.novel 标识文件、全局 recent_projects 表。
/// 不改动项目目录名（目录名在创建时确定，避免移动文件带来的风险）。
#[tauri::command]
pub fn update_project_info(
    state: State<'_, AppState>,
    name: Option<String>,
    author: Option<String>,
    description: Option<String>,
) -> Result<ProjectTree> {
    let name = name.map(|s| s.trim().to_string());
    if let Some(ref n) = name {
        if n.is_empty() {
            return Err(AppError::Msg("书名不能为空".into()));
        }
    }

    let tree = state.with_project(|db| {
        // 组装动态 UPDATE
        let mut sets: Vec<String> = Vec::new();
        let mut values: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
        if let Some(ref n) = name {
            sets.push("name = ?".into());
            values.push(Box::new(n.clone()));
        }
        if let Some(ref a) = author {
            sets.push("author = ?".into());
            values.push(Box::new(a.trim().to_string()));
        }
        if let Some(ref d) = description {
            sets.push("description = ?".into());
            values.push(Box::new(d.trim().to_string()));
        }
        if sets.is_empty() {
            return db::project::build_project_tree(&db.conn, &db.dir);
        }
        sets.push("updated_at = datetime('now','localtime')".into());
        let sql = format!(
            "UPDATE project_info SET {} WHERE id = 1",
            sets.join(", ")
        );
        db.conn.execute(&sql, rusqlite::params_from_iter(values.iter()))?;

        // 同步更新 project.novel 标识文件中的 name
        if name.is_some() {
            let marker_path = db.dir.join("project.novel");
            if let Ok(content) = std::fs::read_to_string(&marker_path) {
                if let Ok(mut marker) = serde_json::from_str::<serde_json::Value>(&content) {
                    if let Some(obj) = marker.as_object_mut() {
                        obj.insert("name".into(), serde_json::Value::String(name.clone().unwrap()));
                        if let Ok(written) = serde_json::to_string_pretty(&marker) {
                            let _ = std::fs::write(&marker_path, written);
                        }
                    }
                }
            }
        }

        db::project::build_project_tree(&db.conn, &db.dir)
    })?;

    // 同步更新全局 recent_projects 表中的书名（按项目目录匹配）
    if let Some(ref n) = name {
        let project_dir = state.with_project(|db| Ok(db.dir.clone()))?;
        let path_str = project_dir.to_string_lossy().to_string();
        let _ = state.with_global(|conn| {
            conn.execute(
                "UPDATE recent_projects SET name = ?1 WHERE path = ?2",
                params![n, path_str],
            )?;
            Ok(())
        });
    }

    Ok(tree)
}

/// 按路径重命名未打开的项目（书架页使用）。
/// 同步更新三处：项目库 project_info 表、project.novel 标识文件、全局 recent_projects 表。
/// 不改动项目目录名。
#[tauri::command]
pub fn rename_project_by_path(
    state: State<'_, AppState>,
    path: String,
    name: String,
) -> Result<()> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err(AppError::Msg("书名不能为空".into()));
    }

    let project_dir = std::path::PathBuf::from(&path);
    let db_path = project_dir.join("database").join("novel.db");
    if !db_path.exists() {
        return Err(AppError::Msg(format!(
            "项目数据库缺失：{}",
            db_path.display()
        )));
    }

    // 打开项目库，更新 project_info
    let conn = db::open_project_db(&db_path)?;
    conn.execute(
        "UPDATE project_info SET name = ?1, updated_at = datetime('now','localtime') WHERE id = 1",
        params![name],
    )?;
    drop(conn);

    // 同步更新 project.novel 标识文件
    let marker_path = project_dir.join("project.novel");
    if let Ok(content) = std::fs::read_to_string(&marker_path) {
        if let Ok(mut marker) = serde_json::from_str::<serde_json::Value>(&content) {
            if let Some(obj) = marker.as_object_mut() {
                obj.insert("name".into(), serde_json::Value::String(name.clone()));
                if let Ok(written) = serde_json::to_string_pretty(&marker) {
                    let _ = std::fs::write(&marker_path, written);
                }
            }
        }
    }

    // 同步更新全局 recent_projects
    let path_str = project_dir.to_string_lossy().to_string();
    let _ = state.with_global(|gconn| {
        gconn.execute(
            "UPDATE recent_projects SET name = ?1 WHERE path = ?2",
            params![name, path_str],
        )?;
        Ok(())
    });

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


#[cfg(test)]
mod tests {
    use super::{sanitize_dir_name, validate_dir_name};

    #[test]
    fn reserved_device_names_rejected() {
        for bad in ["CON", "con", "PRN.txt", "aux", "NUL ", "COM1", "lpt9"] {
            let d = sanitize_dir_name(bad);
            assert!(validate_dir_name(&d).is_err(), "应拒绝保留名: {bad}");
        }
        // 普通书名不受影响
        let d = sanitize_dir_name("正常书名");
        assert!(validate_dir_name(&d).is_ok());
    }

    #[test]
    fn illegal_chars_replaced_and_trailing_trimmed() {
        assert_eq!(sanitize_dir_name("a/b:c?"), "a_b_c_");
        let d = sanitize_dir_name("书名...   ");
        assert!(!d.ends_with('.'));
        assert!(!d.ends_with(' '));
        assert!(validate_dir_name(&d).is_ok());
    }

    #[test]
    fn all_dots_rejected() {
        assert!(validate_dir_name("...").is_err());
    }
}
