//! NovelForge 小说工坊 —— 应用入口。
//!
//! 模块划分：
//! - `commands`  Tauri 命令（前端唯一入口）
//! - `db`        数据库层（项目库 / 全局库 / 迁移）
//! - `import`    TXT/DOCX 智能导入与章节识别规则引擎（阶段 3）
//! - `models`    数据结构
//! - `text`      文本统计工具
//! - `matching`  精确匹配计数（人物/地点卡统计引擎，阶段 6）
//! - `names`     随机取名生成器（阶段 6）
//!
//! 阶段 6 改道说明：阶段 5 的自动实体识别（无语义理解，精度不可达）
//! 已废弃，改为「作者手动建卡 + 精确匹配统计」；新增码字统计与版本快照。

mod commands;
mod db;
mod error;
mod import;
mod matching;
mod models;
mod names;
mod text;

use commands::AppState;
use tauri::Manager;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .setup(|app| {
            // 初始化全局数据库（%APPDATA%/NovelForge/app.db）
            let data_dir = app.path().app_data_dir()?;
            let global = db::global::open_global_db(&data_dir)
                .map_err(|e| format!("初始化应用数据失败：{e}"))?;
            app.manage(AppState::new(global));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // 项目
            commands::project::create_project,
            commands::project::open_project,
            commands::project::close_project,
            commands::project::update_project_outline,
            commands::project::list_recent_projects,
            commands::project::remove_recent_project,
            // 卷
            commands::volume::create_volume,
            commands::volume::rename_volume,
            commands::volume::set_volume_summary,
            commands::volume::delete_volume,
            commands::volume::move_volume,
            // 章节
            commands::chapter::create_chapter,
            commands::chapter::get_chapter,
            commands::chapter::save_chapter,
            commands::chapter::rename_chapter,
            commands::chapter::set_chapter_status,
            commands::chapter::set_chapter_outline,
            commands::chapter::delete_chapter,
            // 回收站
            commands::chapter::list_deleted_chapters,
            commands::chapter::restore_chapter,
            commands::chapter::purge_chapter,
            // 批量整理
            commands::chapter::reverse_volume_chapters,
            commands::chapter::format_all_chapters,
            commands::chapter::move_chapter,
            commands::chapter::list_chapter_versions,
            commands::chapter::restore_chapter_version,
            // 导入（阶段 3）
            commands::import::import_analyze_file,
            commands::import::import_confirm,
            // 导出 / 搜索 / 备份（阶段 4）
            commands::export::export_novel,
            commands::search::search_project,
            commands::backup::backup_project,
            commands::backup::list_backups,
            commands::backup::restore_backup,
            // 人物 / 地点卡：手动建卡 + 精确匹配统计（阶段 6）
            commands::cards::list_characters,
            commands::cards::add_character,
            commands::cards::update_character,
            commands::cards::delete_character,
            commands::cards::get_character_heat,
            commands::cards::list_locations,
            commands::cards::add_location,
            commands::cards::update_location,
            commands::cards::delete_location,
            commands::cards::get_chapter_presence,
            commands::cards::rebuild_mentions,
            // 码字统计 / 随机取名（阶段 6）
            commands::stats::get_writing_stats,
            commands::names::generate_names,
            // 故事地图 / 全书总览 / 章节发展图（V6：可视化写小说）
            commands::story_graph::list_story_graph,
            commands::story_graph::get_chapter_story_context,
            commands::story_graph::list_foreshadows,
            commands::story_graph::create_story_arc,
            commands::story_graph::update_story_arc,
            commands::story_graph::delete_story_arc,
            commands::story_graph::list_story_arcs,
            commands::story_graph::set_node_arc,
            commands::story_graph::move_story_node,
            commands::story_graph::create_planning_node,
            commands::story_graph::remove_story_node,
            commands::story_graph::auto_layout_story_map,
            commands::story_graph::create_story_edge,
            commands::story_graph::update_story_edge,
            commands::story_graph::set_foreshadow_status,
            commands::story_graph::delete_story_edge,
            commands::story_graph::get_foreshadow_threshold,
            commands::story_graph::set_foreshadow_threshold,
        ])
        .run(tauri::generate_context!())
        .expect("NovelForge 启动失败");
}
