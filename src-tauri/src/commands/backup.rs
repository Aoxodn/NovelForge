//! 备份系统（文档第六十五、六十六节）：
//!
//! - 手动备份：VACUUM INTO 生成干净单文件 `.novelbackup`（SQLite 官方推荐方式，
//!   自动合并 WAL 日志，比直接复制 db 文件安全）
//! - 自动备份：同一命令 auto=true，静默执行，保留最近 MAX_AUTO_BACKUPS 个
//! - 恢复：校验备份文件 → 关闭当前连接 → 备份现状 → 覆盖 → 重开项目
//!
//! 备份存放于项目目录 `backups/`，文件名 `auto|manual_日期_时间.novelbackup`。

use crate::commands::AppState;
use crate::db;
use crate::error::{AppError, Result};
use crate::models::{BackupInfo, ProjectTree};
use rusqlite::Connection;
use std::path::{Path, PathBuf};
use tauri::State;

/// 自动备份保留数量
const MAX_AUTO_BACKUPS: usize = 20;

/// 当前本地时间字符串（文件名安全格式）
fn timestamp_now() -> String {
    // SQLite 的 localtime 与系统时区一致，保持同一风格
    let conn = Connection::open_in_memory().unwrap();
    conn.query_row(
        "SELECT strftime('%Y-%m-%d_%H%M%S', 'now', 'localtime')",
        [],
        |r| r.get::<_, String>(0),
    )
    .unwrap_or_default()
}

/// 执行备份。auto=true 时静默并清理旧自动备份。
#[tauri::command]
pub fn backup_project(state: State<'_, AppState>, auto: bool) -> Result<String> {
    state.with_project(|pdb| {
        let backups_dir = pdb.dir.join("backups");
        std::fs::create_dir_all(&backups_dir)?;

        let kind = if auto { "auto" } else { "manual" };
        let file_name = format!("{kind}_{}.novelbackup", timestamp_now());
        let dest = backups_dir.join(&file_name);

        // VACUUM INTO：生成紧凑、完整、无 WAL 依赖的库副本。
        // 路径中的单引号需转义（SQL 字符串字面量）。
        let escaped = dest.to_string_lossy().replace('\'', "''");
        pdb.conn
            .execute_batch(&format!("VACUUM INTO '{escaped}'"))
            .map_err(|e| AppError::Msg(format!("备份失败：{e}")))?;

        // 自动备份滚动清理：保留最近 N 个 auto_*
        if auto {
            cleanup_auto_backups(&backups_dir)?;
        }
        Ok(file_name)
    })
}

fn cleanup_auto_backups(dir: &Path) -> Result<()> {
    let mut autos: Vec<PathBuf> = std::fs::read_dir(dir)?
        .flatten()
        .map(|e| e.path())
        .filter(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .map_or(false, |n| n.starts_with("auto_") && n.ends_with(".novelbackup"))
        })
        .collect();
    if autos.len() > MAX_AUTO_BACKUPS {
        // 按文件名排序即按时间排序（时间戳格式保证字典序 = 时间序）
        autos.sort();
        let excess = autos.len() - MAX_AUTO_BACKUPS;
        for p in &autos[..excess] {
            let _ = std::fs::remove_file(p);
        }
    }
    Ok(())
}

/// 列出项目现有备份
#[tauri::command]
pub fn list_backups(state: State<'_, AppState>) -> Result<Vec<BackupInfo>> {
    state.with_project(|pdb| {
        let dir = pdb.dir.join("backups");
        if !dir.exists() {
            return Ok(vec![]);
        }
        let mut list: Vec<BackupInfo> = std::fs::read_dir(&dir)?
            .flatten()
            .filter_map(|e| {
                let path = e.path();
                let name = path.file_name()?.to_str()?.to_string();
                if !name.ends_with(".novelbackup") {
                    return None;
                }
                let size = e.metadata().ok()?.len();
                let (kind, time) = if let Some(t) = name.strip_prefix("auto_") {
                    ("自动", t.trim_end_matches(".novelbackup"))
                } else if let Some(t) = name.strip_prefix("manual_") {
                    ("手动", t.trim_end_matches(".novelbackup"))
                } else {
                    ("手动", name.trim_end_matches(".novelbackup"))
                };
                let time = time.replace('_', " ");
                Some(BackupInfo {
                    file_name: name,
                    kind: kind.into(),
                    time,
                    size,
                })
            })
            .collect();
        // 新的在前
        list.sort_by(|a, b| b.file_name.cmp(&a.file_name));
        Ok(list)
    })
}

/// 校验备份文件是合法的 NovelForge 项目库
fn validate_backup(path: &Path) -> Result<()> {
    if !path.exists() {
        return Err(AppError::Msg("备份文件不存在".into()));
    }
    let conn = Connection::open(path)
        .map_err(|_| AppError::Msg("备份文件不是有效的数据库".into()))?;
    let n: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name IN ('project_info','chapters')",
            [],
            |r| r.get(0),
        )
        .map_err(|_| AppError::Msg("备份文件不是有效的 NovelForge 备份".into()))?;
    if n < 2 {
        return Err(AppError::Msg("备份文件缺少核心数据表".into()));
    }
    Ok(())
}

/// 从备份恢复项目。
/// 流程：校验 → 关闭当前连接 → 当前库另存 pre-restore 备份 →
///       清除 WAL 残留 → 复制备份 → 重新打开项目。
#[tauri::command]
pub fn restore_backup(state: State<'_, AppState>, backup_file: String) -> Result<ProjectTree> {
    // 只允许恢复 backups 目录内的文件（防路径注入）
    if backup_file.contains("..") || backup_file.contains('/') || backup_file.contains('\\') {
        return Err(AppError::Msg("非法的备份文件名".into()));
    }

    let (project_dir, db_path, backup_path) = {
        // 取走连接即关闭（释放文件句柄），后续重开
        match state.take_current_project() {
            Some((dir, _conn)) => {
                let db_path = dir.join("database").join("novel.db");
                let backup_path = dir.join("backups").join(&backup_file);
                (dir, db_path, backup_path)
            }
            None => return Err(AppError::Msg("当前没有打开的项目".into())),
        }
    };

    validate_backup(&backup_path)?;

    // 2) 恢复前把当前数据另存（任何恢复操作都可反悔）
    let pre_restore = project_dir
        .join("backups")
        .join(format!("manual_pre-restore_{}.novelbackup", timestamp_now()));
    std::fs::create_dir_all(project_dir.join("backups"))?;
    std::fs::copy(&db_path, &pre_restore)
        .map_err(|e| AppError::Msg(format!("恢复前备份失败：{e}（已中止恢复）")))?;

    // 3) 清除 WAL/SHM 残留（残留文件会让新库读到旧数据甚至损坏）
    let _ = std::fs::remove_file(db_path.with_extension("db-wal"));
    let _ = std::fs::remove_file(db_path.with_extension("db-shm"));

    // 4) 备份覆盖项目库
    std::fs::copy(&backup_path, &db_path)
        .map_err(|e| AppError::Msg(format!("恢复失败：{e}")))?;

    // 5) 重新打开项目
    let conn = db::open_project_db(&db_path)?;
    state.set_current_project(project_dir, conn)
}
