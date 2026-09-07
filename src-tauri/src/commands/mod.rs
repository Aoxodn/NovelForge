//! Tauri 命令层：前端 ↔ 后端的唯一入口。
//!
//! 分层约定：
//! - `commands/*` 只做参数校验与流程编排，SQL 细节委托 db 层 / 内联私有函数
//! - `db/*` 负责连接与迁移
//! - `models` 定义数据结构
//!
//! 性能说明：当前命令均为轻量 SQLite 操作，同步执行即可；
//! 后续阶段的长文本分析（人物识别/全文统计）必须使用
//! `tauri::async_runtime::spawn_blocking` 在后台线程执行，避免阻塞 UI。

pub mod backup;
pub mod cards;
pub mod chapter;
pub mod export;
pub mod import;
pub mod names;
pub mod project;
pub mod search;
pub mod stats;
pub mod story_graph;
pub mod volume;

use crate::db;
use crate::error::{AppError, Result};
use crate::import::ImportCache;
use crate::models::ProjectTree;
use rusqlite::Connection;
use std::path::PathBuf;
use std::sync::Mutex;

/// 当前打开的项目数据库句柄
pub struct ProjectDb {
    /// 项目根目录（含 project.novel）。后续阶段备份 / 导出 / 导入功能使用
    #[allow(dead_code)]
    pub dir: PathBuf,
    pub conn: Connection,
}

/// 全局应用状态（Tauri managed state）
pub struct AppState {
    /// 全局库：最近项目 / 应用设置
    global: Mutex<Connection>,
    /// 当前打开的项目库；同一时间只打开一个项目
    project: Mutex<Option<ProjectDb>>,
    /// 导入分析会话缓存（analyze → confirm 之间持有）
    pub import_cache: ImportCache,
}

impl AppState {
    pub fn new(global: Connection) -> Self {
        Self {
            global: Mutex::new(global),
            project: Mutex::new(None),
            import_cache: ImportCache::new(),
        }
    }

    /// 装入项目连接，登记最近项目，返回完整目录树
    pub fn set_current_project(&self, dir: PathBuf, conn: Connection) -> Result<ProjectTree> {
        let tree = db::project::build_project_tree(&conn, &dir)?;
        {
            let global = self.global.lock().unwrap();
            db::project::touch_recent_project(
                &global,
                &tree.info.name,
                &dir.to_string_lossy(),
            )?;
        }
        *self.project.lock().unwrap() = Some(ProjectDb { dir, conn });
        Ok(tree)
    }

    /// 在当前项目上执行操作；未打开项目时返回友好错误
    pub fn with_project<T>(&self, f: impl FnOnce(&ProjectDb) -> Result<T>) -> Result<T> {
        let guard = self.project.lock().unwrap();
        match guard.as_ref() {
            Some(db) => f(db),
            None => Err(AppError::Msg("当前没有打开的项目".into())),
        }
    }

    /// 关闭当前项目（不删除任何数据）
    pub fn close_current_project(&self) {
        *self.project.lock().unwrap() = None;
    }

    /// 取走当前项目连接并关闭（备份恢复用，需要独占文件句柄）
    pub fn take_current_project(&self) -> Option<(PathBuf, Connection)> {
        self.project
            .lock()
            .unwrap()
            .take()
            .map(|p| (p.dir, p.conn))
    }

    /// 访问全局库
    pub fn with_global<T>(&self, f: impl FnOnce(&Connection) -> Result<T>) -> Result<T> {
        let guard = self.global.lock().unwrap();
        f(&guard)
    }
}
