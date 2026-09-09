//! 数据模型：与前端 TypeScript 类型一一对应（serde camelCase 序列化）。

use serde::{Deserialize, Serialize};

/// 项目元信息（项目库 project_info 表，单行）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectInfo {
    pub name: String,
    pub author: String,
    pub description: String,
    /// 全书大纲：主线 / 设定 / 梗概（V4 迁移新增）
    pub outline: String,
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

/// 回收站章节条目
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeletedChapter {
    pub id: i64,
    pub volume_id: i64,
    pub volume_title: String,
    pub title: String,
    pub word_count: i64,
    pub deleted_at: String,
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
    /// L1 全书人物图谱坐标（NULL = 自动布局在轨迹带上）
    pub map_x: Option<f64>,
    pub map_y: Option<f64>,
    /// 单字人名误判排除词（如「简」→「简单/简历/简介…」），多字名为空
    pub exclude_words: Vec<String>,
    /// 阵营 / 势力（审查 UX-3 群像管理）
    pub faction: String,
    /// 存亡：NULL 未知 / 1 存活 / 0 死亡（连续性检查器据此判定「死者再现」）
    pub alive: Option<i64>,
    /// 重要度 0 龙套 / 1 次要 / 2 配角 / 3 核心主角
    pub importance: i64,
    /// 是否 POV 视角人物
    pub is_pov: bool,
    /// 自由标签
    pub tags: Vec<String>,
    /// 自定义字段（键值对，作者按需扩展，不预设固定结构）
    pub custom_fields: serde_json::Value,
    /// 自定义排序序号（作者手动拖拽排序，0 = 未设置）
    pub sort_order: i64,
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
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DailyWords {
    /// YYYY-MM-DD（本地时区）
    pub date: String,
    pub words: i64,
}

/// 码字统计仪表盘数据
#[derive(Debug, Clone, Serialize, Deserialize)]
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

// ========== 故事地图 / 可视化写小说（V7：节点 = 卷 / 故事阶段，设计文档 V1.1） ==========

/// 剧情线（主线 / 支线 / 暗线）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoryArc {
    pub id: i64,
    pub title: String,
    /// 0=主线 1=支线 2=暗线
    pub kind: i32,
    /// 泳道 / 连线着色（空 = 前端按 id 取调色板）
    pub color: String,
    pub summary: String,
}

/// 故事图节点 = 卷（故事阶段）：卷名 / 阶段序号 / 章节统计 / 细纲 / 画布坐标
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoryNode {
    /// 卷 id
    pub id: i64,
    pub title: String,
    /// 阶段序号（= volumes.sort_order，0 起）
    pub sort_order: i64,
    /// 卷细纲（volumes.summary）
    pub summary: String,
    /// 本卷章节数（不含回收站）
    pub chapter_count: i64,
    /// 已完稿章数（完成度 = done / total，派生展示不落库）
    pub done_chapters: i64,
    pub word_count: i64,
    /// 0=常规 1=支线卷 2=番外（预留）
    pub node_type: i32,
    /// 画布坐标，归一化 0..1；NULL = 未排布（自动布局可覆盖）
    pub map_x: Option<f64>,
    pub map_y: Option<f64>,
}

/// 连线（0=顺序 1=因果 2=分支 3=汇合 4=伏笔回收）。
/// from/to 指向卷；伏笔边可带章级锚点（NULL = 卷级伏笔）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoryEdge {
    pub id: i64,
    pub from_node: i64,
    pub to_node: i64,
    pub edge_type: i32,
    pub arc_id: Option<i64>,
    /// 伏笔埋设章（仅 edge_type=4；NULL = 卷级）
    pub from_chapter_id: Option<i64>,
    /// 伏笔回收章（仅 edge_type=4；NULL = 卷级）
    pub to_chapter_id: Option<i64>,
    /// 因果说明 / 伏笔内容
    pub label: String,
    /// 伏笔：0=活跃 1=已回收 2=失效；其余类型固定 0
    pub status: i32,
    /// 手动弧度：相对类型泳道基准的垂直偏移（世界像素，拖弯落库）
    pub bend: f64,
}

/// 故事图全量（打开地图 / 总览时一次拉取）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoryGraph {
    pub nodes: Vec<StoryNode>,
    pub edges: Vec<StoryEdge>,
    pub arcs: Vec<StoryArc>,
}

/// 伏笔总览行
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ForeshadowView {
    pub id: i64,
    pub label: String,
    /// 0=活跃 1=已回收 2=失效
    pub status: i32,
    /// 埋设卷 id
    pub from_node: i64,
    /// 埋设位置描述：「第2卷」或「第2卷·第15章 玉佩现世」
    pub from_desc: String,
    pub to_node: i64,
    /// 回收位置描述
    pub to_desc: String,
    /// 章级锚点（跳转正文用；卷级为 NULL）
    pub from_chapter_id: Option<i64>,
    pub to_chapter_id: Option<i64>,
    /// 跨度（章序差；卷级伏笔按「埋卷末章 → 收卷首章」保守估算）
    pub span: i64,
    /// 跨度超过阈值（settings 表，默认 10 章）
    pub overdue: bool,
    pub arc_id: Option<i64>,
    /// 章级锚点在回收站（软删除）
    pub from_trashed: bool,
    pub to_trashed: bool,
}

/// 卷内章节卡片（卷内视图 / 章节发展图）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VolumeChapterBrief {
    pub id: i64,
    pub title: String,
    /// 0=草稿 1=完稿
    pub status: i32,
    pub word_count: i64,
    pub summary: String,
    pub notes: String,
    pub sort_order: i32,
    /// 全局章节序（0 起，卷序+章序）
    pub global_order: i64,
    /// 所属小节（章节群；NULL = 未分组）
    pub group_id: Option<i64>,
    /// L2 画布坐标（归一化 0..1；NULL = 未排布，由布局算法派生）
    pub map_x: Option<f64>,
    pub map_y: Option<f64>,
}

/// 小节（章节群）：同卷若干章节的分组，画布上渲染为组框
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChapterGroup {
    pub id: i64,
    pub volume_id: i64,
    pub title: String,
    pub sort_order: i32,
}

/// 小节连线（组框拖出：小节→小节 / 小节→章节，目标二选一）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupEdge {
    pub id: i64,
    pub volume_id: i64,
    pub from_group: i64,
    pub to_group: Option<i64>,
    pub to_chapter: Option<i64>,
    pub edge_type: i32,
    pub label: String,
    /// 伏笔：0=活跃 1=已回收 2=失效
    pub status: i32,
    pub bend: f64,
}

/// 章间连线（L2 卷内画布，0顺序..6闪回与卷级边同枚举）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChapterEdge {
    pub id: i64,
    pub from_chapter: i64,
    pub to_chapter: i64,
    pub edge_type: i32,
    pub label: String,
    /// 伏笔：0=活跃 1=已回收 2=失效；其余固定 0
    pub status: i32,
    /// 手动弧度（世界像素）
    pub bend: f64,
}

/// 卷内视图（L2）：卷节点 + 本卷章节 + 小节 + 章间连线 + 小节连线
/// + 人物画布坐标 / 人物绑定（可编辑人物层）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VolumeDetail {
    pub node: StoryNode,
    pub chapters: Vec<VolumeChapterBrief>,
    pub groups: Vec<ChapterGroup>,
    pub chapter_edges: Vec<ChapterEdge>,
    pub group_edges: Vec<GroupEdge>,
    pub char_positions: Vec<CharacterCanvasPos>,
    pub bindings: Vec<CharacterBinding>,
}

/// 卷级相邻（章节发展图：本章所属卷的上 / 下游卷）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VolumeEdgeBrief {
    pub edge_id: i64,
    pub edge_type: i32,
    pub label: String,
    pub volume: StoryNode,
}

/// 本章相关伏笔（章节发展图卡片用）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ForeshadowBrief {
    pub edge_id: i64,
    pub label: String,
    /// 0=活跃 1=已回收 2=失效
    pub status: i32,
    /// 对端位置描述（埋设视角 = 回收位置；回收视角 = 埋设位置）
    pub other_desc: String,
    /// 对端章级锚点（NULL = 卷级，跳地图）
    pub other_chapter_id: Option<i64>,
    /// 对端卷 id（跳地图定位用）
    pub other_volume_id: i64,
    /// 跨度（章序差，>= 0）
    pub span: i64,
    pub overdue: bool,
    /// 本章埋设 + 回收端已完稿 + 仍活跃 → 前端出「标记已回收」轻提示
    pub can_resolve: bool,
}

/// 单章故事上下文（右栏「本章发展」卡，设计文档 §3.5）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChapterStoryContext {
    pub chapter_id: i64,
    /// 本章所属卷（卷节点，含细纲）
    pub volume: StoryNode,
    /// 所属卷的入边（上游卷）
    pub volume_in_edges: Vec<VolumeEdgeBrief>,
    /// 所属卷的出边（下游卷）
    pub volume_out_edges: Vec<VolumeEdgeBrief>,
    /// 卷内前章（各 ≤4，按卷内顺序）
    pub prev_chapters: Vec<VolumeChapterBrief>,
    /// 卷内后章（各 ≤4）
    pub next_chapters: Vec<VolumeChapterBrief>,
    /// 本章埋设的伏笔（章级锚点 = 本章）
    pub planted: Vec<ForeshadowBrief>,
    /// 本章回收的伏笔
    pub resolved: Vec<ForeshadowBrief>,
    /// 所属卷的卷级伏笔（活跃 / 已回收，两端卷锚点至少一端为本卷）
    pub volume_foreshadows: Vec<ForeshadowBrief>,
}

/// 命名题材元信息（前端题材下拉：未建设题材置灰）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NameGenre {
    pub key: String,
    pub label: String,
    /// 核心题材（词量翻倍）
    pub core: bool,
    /// 词典是否已建设（false = 前端置灰，不可选）
    pub ready: bool,
}

/// 人物关系（v0.9.13 广义人物关系体系，character_relations 表）。
/// 五大类定色定线型，rel_type 自由文本定标签，direction 定箭头。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CharacterRelation {
    pub id: i64,
    pub from_char: i64,
    pub to_char: i64,
    /// 1血缘 2情感 3社会 4阵营 5叙事
    pub rel_category: i32,
    /// 子类型名（自由文本，如「母女」「师徒」）
    pub rel_type: String,
    /// 自定义补充说明
    pub label: String,
    /// 0双向 1单向(from→to)
    pub direction: i32,
    /// NULL = 跨卷关系（L1 / 所有 L2 显示）；具体卷 = 仅该卷 L2 显示
    pub volume_id: Option<i64>,
    pub created_at: String,
}

/// 人物 × 卷出场统计（画布人物层数据源：character_mentions 按卷聚合）。
/// 纯渲染派生数据，不落库。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CharacterVolumePresence {
    pub character_id: i64,
    pub name: String,
    pub role: String,
    pub volume_id: i64,
    pub mention_count: i64,
}

/// 人物手动绑定（人物→卷 / 人物→章，二选一）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CharacterBinding {
    pub id: i64,
    pub character_id: i64,
    pub volume_id: Option<i64>,
    pub chapter_id: Option<i64>,
}

/// L2 卷内人物画布坐标
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CharacterCanvasPos {
    pub character_id: i64,
    pub map_x: f64,
    pub map_y: f64,
}

