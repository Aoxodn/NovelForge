//! 数据模型：与前端 TypeScript 类型一一对应（serde camelCase 序列化）。

use serde::{Deserialize, Serialize};

/// 项目元信息（项目库 project_info 表，单行）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectInfo {
    pub name: String,
    pub author: String,
    pub description: String,
    pub created_at: String,
    pub updated_at: String,
}

/// 卷（列表视图，含聚合统计）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Volume {
    pub id: i64,
    pub title: String,
    pub sort_order: i32,
    pub summary: String,
    pub chapter_count: i64,
    pub word_count: i64,
    pub updated_at: String,
}

/// 章节元数据（目录树用，不含正文，保证大项目下列表加载轻量）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChapterMeta {
    pub id: i64,
    pub volume_id: i64,
    pub title: String,
    pub word_count: i64,
    pub sort_order: i32,
    pub status: i32,
    pub updated_at: String,
}

/// 章节完整数据（编辑器加载/保存用）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChapterDetail {
    pub id: i64,
    pub volume_id: i64,
    pub title: String,
    pub content: String,
    pub word_count: i64,
    pub char_count: i64,
    pub status: i32,
    pub summary: String,
    pub notes: String,
    pub updated_at: String,
}

/// 项目统计
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectStats {
    pub total_word_count: i64,
    pub total_char_count: i64,
    pub volume_count: i64,
    pub chapter_count: i64,
}

/// 打开项目后一次性下发的完整目录树
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectTree {
    pub info: ProjectInfo,
    pub project_path: String,
    pub volumes: Vec<Volume>,
    pub chapters: Vec<ChapterMeta>,
    pub stats: ProjectStats,
}

/// 最近打开的项目（存于全局库）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentProject {
    pub name: String,
    pub path: String,
    pub last_opened_at: String,
}

/// 保存章节的结果
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveResult {
    pub word_count: i64,
    pub char_count: i64,
    pub saved_at: String,
    pub snapshot_created: bool,
    /// 保存后当日累计码字（状态栏「今日 +N」）
    pub today_words: i64,
}

/// 章节历史版本元数据
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChapterVersionMeta {
    pub id: i64,
    pub chapter_id: i64,
    pub title: String,
    pub word_count: i64,
    pub version_type: i32,
    pub created_at: String,
}

// ========== 导入系统（阶段 3） ==========

/// 导入预览中的单章信息
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewChapter {
    /// 块索引（用户调整边界时引用）
    pub index: usize,
    pub title: String,
    /// 0..1，< 0.6 时前端标记 ⚠ 需确认
    pub confidence: f32,
    /// 命中的识别规则名称（如「中文章节」）
    pub rule: String,
    pub word_count: i64,
    /// 正文前 120 字预览
    pub preview: String,
    /// 重复检测：正文与库中已有章节 / 本文件更早的块完全相同
    /// （值为重复来源的描述，前端默认排除该块）
    pub duplicate_of: Option<String>,
}

/// 文档分析结果（未落库，等待用户确认）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportAnalysis {
    /// 分析会话 id（confirm 时回传）
    pub id: String,
    pub file_name: String,
    pub total_word_count: i64,
    /// 非空段落数
    pub paragraphs: i64,
    pub chapters: Vec<PreviewChapter>,
}

/// 导入落库结果
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    pub volume_id: i64,
    pub chapter_count: i64,
    pub word_count: i64,
}

// ========== 导出系统（阶段 4） ==========

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportResult {
    pub path: String,
    pub chapter_count: i64,
    pub word_count: i64,
}

// ========== 搜索系统（阶段 4） ==========

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub chapter_id: i64,
    pub chapter_title: String,
    pub volume_title: String,
    /// 匹配前文（含省略号）
    pub snippet_before: String,
    /// 匹配词本体（前端 <mark> 高亮）
    pub snippet_match: String,
    /// 匹配后文（含省略号）
    pub snippet_after: String,
    /// 本章匹配数（"3" / "20+"）
    pub match_count: String,
}

// ========== 备份系统（阶段 4） ==========

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupInfo {
    pub file_name: String,
    /// "自动" | "手动"
    pub kind: String,
    pub time: String,
    pub size: u64,
}

// ========== 人物 / 地点卡（阶段 6：手动建卡 + 精确匹配统计） ==========

/// 人物档案（含跨章聚合统计）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CharacterProfile {
    pub id: i64,
    pub name: String,
    pub aliases: Vec<String>,
    pub role: String,
    pub notes: String,
    /// 全书总出现次数（名字+别名精确匹配）
    pub total_mentions: i64,
    /// 出现过的章节数
    pub chapter_count: i64,
    pub first_chapter_id: Option<i64>,
    pub first_chapter_title: Option<String>,
    pub last_chapter_id: Option<i64>,
    pub last_chapter_title: Option<String>,
}

/// 人物出现热度（文档三十一节）：按全书章节顺序的出现次数序列
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CharacterHeat {
    pub character_id: i64,
    pub name: String,
    /// 与全书章节顺序对齐的出现次数（0 = 该章未出现）
    pub per_chapter: Vec<i64>,
    /// 尾部连续未出现的章数（断档预警）
    pub absent_streak: i64,
}

/// 地点档案
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocationProfile {
    pub id: i64,
    pub name: String,
    pub notes: String,
    pub total_mentions: i64,
    pub chapter_count: i64,
    pub first_chapter_title: Option<String>,
    pub last_chapter_title: Option<String>,
}

/// 章内实体出现（InfoPanel 本章出场卡）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EntityMentionView {
    pub id: i64,
    pub name: String,
    pub mention_count: i64,
}

/// 单章出场视图（本章出现的人物 / 地点，精确匹配实时计算）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChapterPresenceView {
    pub chapter_id: i64,
    /// 按出现次数降序
    pub characters: Vec<EntityMentionView>,
    pub locations: Vec<EntityMentionView>,
}

// ========== 码字统计（阶段 6） ==========

/// 单日码字记录
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DailyWords {
    /// YYYY-MM-DD（本地时区）
    pub date: String,
    pub words: i64,
}

/// 码字统计仪表盘数据
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WritingStats {
    /// 今日净增字数
    pub today_words: i64,
    /// 连续写作天数（今天无记录时从昨天起算）
    pub streak: i64,
    /// 有写作记录的总天数
    pub active_days: i64,
    /// 单日最高字数
    pub best_day_words: i64,
    pub best_day: Option<String>,
    /// 近 60 天记录（只含有记录的日子，前端补零）
    pub daily: Vec<DailyWords>,
    /// 全书当前总字数 / 章节数
    pub total_words: i64,
    pub chapter_count: i64,
}
