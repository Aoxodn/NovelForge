//! 应用级全局数据库：最近项目、应用设置。
//! 存放于系统应用数据目录（Windows: %APPDATA%/NovelForge）。

use crate::error::Result;
use rusqlite::Connection;
use std::path::Path;

pub fn open_global_db(data_dir: &Path) -> Result<Connection> {
    std::fs::create_dir_all(data_dir)?;
    let conn = Connection::open(data_dir.join("app.db"))?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS recent_projects (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            name            TEXT NOT NULL,
            path            TEXT NOT NULL UNIQUE,
            last_opened_at  TEXT NOT NULL DEFAULT (datetime('now','localtime'))
        );

        CREATE TABLE IF NOT EXISTS app_settings (
            key   TEXT PRIMARY KEY,
            value TEXT
        );
        ",
    )?;
    Ok(conn)
}
