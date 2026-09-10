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
mod mention_index;
mod models;
mod names;
mod names_dict;
mod names_person;
mod services;
mod char_stopwords;
mod text;

use commands::AppState;
use tauri::Manager;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .setup(|app| {
            // 跨平台：仅 Windows 使用自定义无边框标题栏；macOS / Linux 恢复原生装饰，
            // 否则自定义的 Windows 风格控件在其它平台无法正常拖拽 / 关闭（审查跨平台项）。
            #[cfg(not(target_os = "windows"))]
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.set_decorations(true);
            }
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
            commands::project::get_current_project_tree,
            commands::project::close_project,
            commands::project::update_project_outline,
            commands::project::update_project_info,
            commands::project::rename_project_by_path,
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
            commands::chapter::move_chapter,
            commands::chapter::list_chapter_versions,
            commands::chapter::restore_chapter_version,
            commands::chapter::emergency_dump_text,
            // 导入（阶段 3）
            commands::import::import_analyze_file,
            commands::import::import_confirm,
            commands::import::import_cancel,
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
            commands::cards::reorder_characters,
            commands::cards::get_character_heat,
            commands::cards::list_locations,
            commands::cards::add_location,
            commands::cards::update_location,
            commands::cards::delete_location,
            commands::cards::get_chapter_presence,
            commands::cards::get_alias_conflicts,
            commands::cards::rebuild_mentions,
            // 码字统计 / 随机取名（阶段 6）
            commands::stats::get_writing_stats,
            commands::names::generate_names,
            commands::names::list_name_genres,
            // 故事地图 / 全书总览 / 章节发展图（V7：可视化写小说，节点 = 卷）
            commands::story_graph::list_story_graph,
            commands::story_graph::get_volume_detail,
            commands::story_graph::get_chapter_story_context,
            commands::story_graph::list_foreshadows,
            commands::story_graph::create_story_arc,
            commands::story_graph::update_story_arc,
            commands::story_graph::delete_story_arc,
            commands::story_graph::list_story_arcs,
            commands::story_graph::move_story_node,
            commands::story_graph::auto_layout_story_map,
            commands::story_graph::create_story_edge,
            commands::story_graph::update_story_edge,
            commands::story_graph::set_story_edge_bend,
            commands::story_graph::set_foreshadow_status,
            commands::story_graph::delete_story_edge,
            commands::story_graph::get_foreshadow_threshold,
            commands::story_graph::set_foreshadow_threshold,
            // 人物关系 / 出场统计（v0.9.13 广义人物关系体系）
            commands::relations::list_character_relations,
            commands::relations::list_all_character_relations,
            commands::relations::create_character_relation,
            commands::relations::update_character_relation,
            commands::relations::delete_character_relation,
            commands::relations::list_character_volume_presence,
            commands::relations::list_volume_character_mentions,
            // L2 卷内画布（v0.9.13 可编辑化：章节坐标 / 小节 / 章间连线）
            commands::chapter_canvas::move_chapter_node,
            commands::chapter_canvas::move_chapter_nodes,
            commands::chapter_canvas::create_chapter_edge,
            commands::chapter_canvas::update_chapter_edge,
            commands::chapter_canvas::delete_chapter_edge,
            commands::chapter_canvas::set_chapter_edge_bend,
            commands::chapter_canvas::create_chapter_group,
            commands::chapter_canvas::rename_chapter_group,
            commands::chapter_canvas::delete_chapter_group,
            commands::chapter_canvas::set_chapter_group,
            commands::chapter_canvas::create_group_edge,
            commands::chapter_canvas::update_group_edge,
            commands::chapter_canvas::delete_group_edge,
            commands::chapter_canvas::set_group_edge_bend,
            // 人物图谱（v0.9.13 可编辑人物层）
            commands::canvas_chars::move_character_node,
            commands::canvas_chars::remove_character_from_canvas,
            commands::canvas_chars::set_char_volume_pos,
            commands::canvas_chars::remove_character_from_volume,
            commands::canvas_chars::create_character_binding,
            commands::canvas_chars::delete_character_binding,
            commands::canvas_chars::list_character_bindings,
            commands::canvas_chars::list_char_volume_pos,
            // 场景级写作板（审查新增功能）
            commands::scenes::list_scenes,
            commands::scenes::create_scene,
            commands::scenes::update_scene,
            commands::scenes::delete_scene,
            commands::scenes::reorder_scenes,
            commands::scenes::compose_scenes_to_chapter,
            // 人物弧光追踪
            commands::arcs::list_arcs,
            commands::arcs::create_arc,
            commands::arcs::update_arc,
            commands::arcs::delete_arc,
            commands::arcs::reorder_arcs,
            // 安全重命名 / 连续性检查 / 修订工作台
            commands::review::preview_rename_character,
            commands::review::apply_rename_character,
            commands::review::scan_continuity,
            commands::review::list_continuity,
            commands::review::set_continuity_status,
            commands::review::analyze_revision,
            commands::review::preview_cross_replace,
            commands::review::apply_cross_replace,
            // 路线图 P0–P2
            commands::roadmap::list_foreshadow_ledger,
            commands::roadmap::create_foreshadow,
            commands::roadmap::update_foreshadow,
            commands::roadmap::delete_foreshadow,
            commands::roadmap::foreshadows_for_chapter,
            commands::roadmap::get_chapter_arcs,
            commands::roadmap::set_chapter_arcs,
            commands::roadmap::list_roadmap_chapters,
            commands::roadmap::get_story_timeline,
            commands::roadmap::update_chapter_roadmap,
            commands::roadmap::get_board,
            commands::roadmap::list_state_snapshots,
            commands::roadmap::upsert_state_snapshot,
            commands::roadmap::delete_state_snapshot,
            commands::roadmap::get_pov_dashboard,
            commands::roadmap::list_lore_entries,
            commands::roadmap::create_lore_entry,
            commands::roadmap::update_lore_entry,
            commands::roadmap::delete_lore_entry,
            commands::roadmap::link_lore_to_chapter,
            commands::roadmap::unlink_lore_from_chapter,
            commands::roadmap::lore_for_chapter,
            commands::roadmap::list_address_forms,
            commands::roadmap::upsert_address_form,
            commands::roadmap::delete_address_form,
            commands::roadmap::scan_address_drift,
            commands::roadmap::batch_create_characters,
            commands::roadmap::get_style_fingerprint,
            commands::roadmap::create_structure_snapshot,
            commands::roadmap::list_structure_snapshots,
            commands::roadmap::get_structure_snapshot,
            commands::roadmap::delete_structure_snapshot,
            commands::roadmap::set_tension_points,
        ])
        .run(tauri::generate_context!())
        .expect("NovelForge 启动失败");
}
