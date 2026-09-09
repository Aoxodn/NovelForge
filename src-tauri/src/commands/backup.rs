//! 备份系统（文档第六十五、六十六节）：
//!
//! - 手动备份：VACUUM INTO 生成干净单文件 `.novelbackup`（SQLite 官方推荐方式，
//!   自动合并 WAL 日志，比直接复制 db 文件安全）
//! - 自动备份：同一命令 auto=true，静默执行，保留最近 MAX_AUTO_BACKUPS 个
//! - 恢复：保持连接先校验与快照 → 临时文件交换 → 故障可回滚 → 重开项目
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
                .is_some_and(|n| n.starts_with("auto_") && n.ends_with(".novelbackup"))
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

/// 校验备份文件是合法、完整的 NovelForge 项目库（含完整性检查）
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
    integrity_check(&conn)?;
    Ok(())
}

/// SQLite 完整性检查：PRAGMA integrity_check 首行必须是 ok
fn integrity_check(conn: &Connection) -> Result<()> {
    let result: String = conn
        .query_row("PRAGMA integrity_check", [], |r| r.get(0))
        .map_err(|e| AppError::Msg(format!("完整性检查失败：{e}")))?;
    if result == "ok" {
        Ok(())
    } else {
        Err(AppError::Msg(format!("数据库完整性校验未通过：{result}")))
    }
}

/// 从备份恢复项目（故障原子，审查 P0-4）。
///
/// 顺序保证任何一步失败都不会留下半写数据库或失去当前连接：
/// 1. 保持当前连接时：校验备份 + integrity_check，并用 VACUUM INTO 落一份恢复前快照；
/// 2. 复制备份到同目录临时文件并再次 integrity_check；
/// 3. 取走（关闭）当前连接，清理 WAL；
/// 4. 原库改名 rollback，临时库改名 novel.db；
/// 5. 重开项目；任一步失败都用 rollback 还原并重开，实在无法还原才报错且保留文件。
#[tauri::command]
pub fn restore_backup(state: State<'_, AppState>, backup_file: String) -> Result<ProjectTree> {
    // 只允许恢复 backups 目录内的文件（防路径注入）
    if backup_file.contains("..") || backup_file.contains('/') || backup_file.contains('\\') {
        return Err(AppError::Msg("非法的备份文件名".into()));
    }

    // ---- 阶段 1：连接仍在，先做所有校验与恢复前快照 ----
    let (project_dir, db_path, backup_path) = {
        let pdb = state
            .with_project(|p| Ok(p.dir.clone()))
            .map_err(|_| AppError::Msg("当前没有打开的项目".into()))?;
        let db_path = pdb.join("database").join("novel.db");
        let backup_path = pdb.join("backups").join(&backup_file);
        let pre_restore = pdb
            .join("backups")
            .join(format!("manual_pre-restore_{}.novelbackup", timestamp_now()));
        std::fs::create_dir_all(pdb.join("backups"))?;

        // 1a. 校验目标备份（含完整性检查），失败直接中止，连接不受影响
        validate_backup(&backup_path)?;

        // 1b. 用 VACUUM INTO 落当前库的干净快照（自动合并 WAL，比复制主库文件可靠）
        state.with_project(|p| {
            let escaped = pre_restore.to_string_lossy().replace('\'', "''");
            p.conn
                .execute_batch(&format!("VACUUM INTO '{escaped}'"))
                .map_err(|e| AppError::Msg(format!("恢复前备份失败：{e}（已中止恢复）")))?;
            Ok(())
        })?;

        (pdb, db_path, backup_path)
    };

    // ---- 阶段 2：复制到同目录临时文件并校验落盘内容 ----
    let tmp_path = db_path.with_file_name("novel.db.restore-tmp");
    let _ = std::fs::remove_file(&tmp_path);
    std::fs::copy(&backup_path, &tmp_path)
        .map_err(|e| AppError::Msg(format!("写入临时库失败：{e}（已中止恢复，当前库未改动）")))?;
    {
        let tmp_conn = Connection::open(&tmp_path).map_err(|e| {
            let _ = std::fs::remove_file(&tmp_path);
            AppError::Msg(format!("临时库无法打开：{e}（已中止恢复）"))
        })?;
        if let Err(e) = integrity_check(&tmp_conn) {
            drop(tmp_conn);
            let _ = std::fs::remove_file(&tmp_path);
            return Err(e);
        }
    }

    // ---- 阶段 3：取走连接（关闭句柄），清理 WAL ----
    if state.take_current_project().is_none() {
        let _ = std::fs::remove_file(&tmp_path);
        return Err(AppError::Msg("当前项目连接已丢失，已中止恢复".into()));
    }
    let _ = std::fs::remove_file(db_path.with_extension("db-wal"));
    let _ = std::fs::remove_file(db_path.with_extension("db-shm"));

    // ---- 阶段 4：原库改名 rollback，临时库改名正式库 ----
    let rollback_path = db_path.with_file_name("novel.db.rollback");
    let _ = std::fs::remove_file(&rollback_path);
    if std::fs::rename(&db_path, &rollback_path).is_err() {
        return Err(reopen_or_report(
            &state,
            &project_dir,
            &db_path,
            &rollback_path,
            &tmp_path,
            "原库改名失败，已中止恢复".to_string(),
        ));
    }
    if let Err(e) = std::fs::rename(&tmp_path, &db_path) {
        // 临时库转正失败：立即把 rollback 改回原名
        let _ = std::fs::rename(&rollback_path, &db_path);
        return Err(reopen_or_report(
            &state,
            &project_dir,
            &db_path,
            &rollback_path,
            &tmp_path,
            format!("新库落位失败：{e}，已尝试还原原库"),
        ));
    }

    // ---- 阶段 5：重开项目；失败则回滚到原库 ----
    match db::open_project_db(&db_path) {
        Ok(conn) => {
            // 恢复成功：清理 rollback（pre-restore 快照仍保留，可反悔）
            let _ = std::fs::remove_file(&rollback_path);
            state.set_current_project(project_dir, conn)
        }
        Err(e) => {
            // 新库打不开：还原 rollback
            let _ = std::fs::remove_file(&db_path);
            let _ = std::fs::rename(&rollback_path, &db_path);
            Err(reopen_or_report(
                &state,
                &project_dir,
                &db_path,
                &rollback_path,
                &tmp_path,
                format!("恢复后的数据库无法打开，已还原原库：{e}"),
            ))
        }
    }
}

/// 恢复流程异常后的统一收尾：尽力重新打开原库；原库也无法打开时返回错误并保留现场文件。
fn reopen_or_report(
    state: &AppState,
    project_dir: &Path,
    db_path: &Path,
    rollback_path: &Path,
    tmp_path: &Path,
    message: String,
) -> AppError {
    let _ = std::fs::remove_file(tmp_path);
    // 若 rollback 仍在（说明没改回），尝试改回
    if rollback_path.exists() && !db_path.exists() {
        let _ = std::fs::rename(rollback_path, db_path);
    }
    match db::open_project_db(db_path) {
        Ok(conn) => match state.set_current_project(project_dir.to_path_buf(), conn) {
            Ok(_tree) => AppError::Msg(message),
            Err(_) => AppError::Msg(format!(
                "{message}；且原库重新装载失败，项目文件仍保留在原目录"
            )),
        },
        Err(open_err) => AppError::Msg(format!(
            "{message}；原库重开也失败：{open_err}。数据库文件保留在 {}",
            db_path.display()
        )),
    }
}
