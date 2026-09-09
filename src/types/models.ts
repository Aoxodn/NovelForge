/**
 * 前端数据类型：与 Rust 侧 `src-tauri/src/models.rs` 一一对应（camelCase）。
 */

export interface ProjectInfo {
  name: string;
  author: string;
  description: string;
  /** 全书大纲：主线 / 设定 / 梗概 */
  outline: string;
  createdAt: string;
  updatedAt: string;
}

export interface Volume {
  id: number;
  title: string;
  sortOrder: number;
  summary: string;
  chapterCount: number;
  wordCount: number;
  updatedAt: string;
}

export interface ChapterMeta {
  id: number;
  volumeId: number;
  title: string;
  wordCount: number;
  sortOrder: number;
  /** 0=草稿 1=完稿 */
  status: number;
  updatedAt: string;
}

export interface ChapterDetail {
  id: number;
  volumeId: number;
  title: string;
  content: string;
  wordCount: number;
  charCount: number;
  status: number;
  summary: string;
  notes: string;
  updatedAt: string;
}

export interface ProjectStats {
  totalWordCount: number;
  totalCharCount: number;
  volumeCount: number;
  chapterCount: number;
}

export interface ProjectTree {
  info: ProjectInfo;
  projectPath: string;
  volumes: Volume[];
  chapters: ChapterMeta[];
  stats: ProjectStats;
}

export interface RecentProject {
  name: string;
  path: string;
  lastOpenedAt: string;
}

export interface SaveResult {
  wordCount: number;
  charCount: number;
  savedAt: string;
  snapshotCreated: boolean;
  /** 保存后当日累计码字（状态栏「今日 +N」） */
  todayWords: number;
}

export interface ChapterVersionMeta {
  id: number;
  chapterId: number;
  title: string;
  wordCount: number;
  /** 0=自动快照 1=手动快照 2=恢复前备份 */
  versionType: number;
  createdAt: string;
}

export type Theme = 'light' | 'dark' | 'sepia';

// ========== 导入系统（阶段 3） ==========

export interface PreviewChapter {
  /** 块索引（调整边界时引用） */
  index: number;
  title: string;
  /** 0..1，< 0.6 显示 ⚠ 需确认 */
  confidence: number;
  rule: string;
  wordCount: number;
  preview: string;
  /** 正文与库中已有章节 / 本文件更早块完全相同（前端默认排除） */
  duplicateOf: string | null;
}

export interface ImportAnalysis {
  id: string;
  fileName: string;
  totalWordCount: number;
  paragraphs: number;
  chapters: PreviewChapter[];
}

export interface ImportResult {
  volumeId: number;
  chapterCount: number;
  wordCount: number;
}

// ========== 导出 / 搜索 / 备份（阶段 4） ==========

export interface ExportResult {
  path: string;
  chapterCount: number;
  wordCount: number;
}

export interface SearchHit {
  chapterId: number;
  chapterTitle: string;
  volumeTitle: string;
  snippetBefore: string;
  snippetMatch: string;
  snippetAfter: string;
  matchCount: string;
}

export interface BackupInfo {
  fileName: string;
  kind: string;
  time: string;
  size: number;
}

export type ExportFormat = 'txt' | 'docx' | 'md';
export type ExportScope = 'all' | 'volume' | 'chapter';

// ========== 人物 / 地点卡（阶段 6：手动建卡 + 精确匹配统计） ==========

export interface CharacterProfile {
  id: number;
  name: string;
  aliases: string[];
  role: string;
  notes: string;
  /** 全书总出现次数（名字+别名精确匹配） */
  totalMentions: number;
  /** 出现过的章节数 */
  chapterCount: number;
  firstChapterId: number | null;
  firstChapterTitle: string | null;
  lastChapterId: number | null;
  lastChapterTitle: string | null;
  /** L1 全书人物图谱坐标（null = 自动布局在轨迹带上） */
  mapX: number | null;
  mapY: number | null;
  /** 单字人名误判排除词（如「简」→「简单/简历/简介…」），多字名为空 */
  excludeWords: string[];
  /** 阵营 / 势力（审查 UX-3） */
  faction: string;
  /** 存亡：null 未知 / true 存活 / false 死亡 */
  alive: boolean | null;
  /** 重要度 0 龙套 / 1 次要 / 2 配角 / 3 核心 */
  importance: number;
  /** 是否 POV 视角人物 */
  isPov: boolean;
  /** 自由标签 */
  tags: string[];
  /** 自定义字段（键值对，作者按需扩展） */
  customFields: Record<string, string>;
  /** 自定义排序序号（0 = 未设置） */
  sortOrder: number;
}

/** 人物群像扩展字段（更新时按需传入） */
export interface CharacterMeta {
  faction?: string;
  alive?: boolean | null;
  importance?: number;
  isPov?: boolean;
  tags?: string[];
  customFields?: Record<string, string>;
}

/** 人物出现热度：perChapter 与全书章节顺序对齐 */
export interface CharacterHeat {
  characterId: number;
  name: string;
  perChapter: number[];
  /** 尾部连续未出现章数（断档预警） */
  absentStreak: number;
}

export interface LocationProfile {
  id: number;
  name: string;
  notes: string;
  totalMentions: number;
  chapterCount: number;
  firstChapterTitle: string | null;
  lastChapterTitle: string | null;
}

export interface EntityMentionView {
  id: number;
  name: string;
  mentionCount: number;
}

/** 单章出场视图（本章出现的人物 / 地点，精确匹配实时计算） */
export interface ChapterPresenceView {
  chapterId: number;
  characters: EntityMentionView[];
  locations: EntityMentionView[];
}

// ========== 码字统计（阶段 6） ==========

export interface DailyWords {
  /** YYYY-MM-DD（本地时区） */
  date: string;
  words: number;
}

export interface WritingStats {
  todayWords: number;
  /** 连续写作天数（今天无记录时从昨天起算） */
  streak: number;
  activeDays: number;
  bestDayWords: number;
  bestDay: string | null;
  /** 近 60 天记录（只含有记录的日子，前端补零） */
  daily: DailyWords[];
  totalWords: number;
  chapterCount: number;
}

/** 随机取名类型 */
export type NameKind =
  | 'person'
  | 'place'
  | 'sect'
  | 'technique'
  | 'item'
  | 'pill'
  | 'beast'
  | 'plant';

/** 取名筛选参数（genre 仅组合类使用；其余仅人名） */
export interface NameParams {
  genre?: string;
  gender?: 'male' | 'female' | 'any';
  country?: 'cn' | 'jp' | 'west';
  surnameType?: 'single' | 'compound' | 'any';
  surname?: string;
  given?: string;
}

/** 命名题材元信息（后端 list_name_genres 返回） */
export interface NameGenre {
  key: string;
  label: string;
  /** 核心题材（词量翻倍） */
  core: boolean;
  /** 词典是否已建设（false = 置灰不可选） */
  ready: boolean;
}

/** 回收站章节条目 */
export interface DeletedChapter {
  id: number;
  volumeId: number;
  volumeTitle: string;
  title: string;
  wordCount: number;
  deletedAt: string;
}

// ========== 故事地图 / 可视化写小说（V7：节点 = 卷 / 故事阶段） ==========

/** 连线类型：0=顺序 1=因果 2=分支 3=汇合 4=伏笔回收 */
export type StoryEdgeType = 0 | 1 | 2 | 3 | 4;

/** 伏笔状态：0=活跃 1=已回收 2=失效 */
export type ForeshadowStatus = 0 | 1 | 2;

/** 剧情线（主线 / 支线 / 暗线） */
export interface StoryArc {
  id: number;
  title: string;
  /** 0=主线 1=支线 2=暗线 */
  kind: number;
  color: string;
  summary: string;
}

/** 故事图节点 = 卷（故事阶段）：卷名 / 阶段序号 / 章节统计 / 细纲 / 画布坐标 */
export interface StoryNode {
  /** 卷 id */
  id: number;
  title: string;
  /** 阶段序号（= 卷 sortOrder，0 起） */
  sortOrder: number;
  /** 卷细纲 */
  summary: string;
  chapterCount: number;
  /** 已完稿章数（完成度 = done / total） */
  doneChapters: number;
  wordCount: number;
  /** 0=常规 1=支线卷 2=番外（预留） */
  nodeType: number;
  /** 画布坐标，归一化 0..1；null = 未排布 */
  mapX: number | null;
  mapY: number | null;
}

/** 连线（两端 = 卷；伏笔可带章级锚点） */
export interface StoryEdge {
  id: number;
  fromNode: number;
  toNode: number;
  edgeType: number;
  arcId: number | null;
  /** 伏笔埋设章（仅 edgeType=4；null = 卷级） */
  fromChapterId: number | null;
  /** 伏笔回收章（仅 edgeType=4；null = 卷级） */
  toChapterId: number | null;
  /** 因果说明 / 伏笔内容 */
  label: string;
  /** 伏笔：0=活跃 1=已回收 2=失效 */
  status: number;
  /** 手动弧度：相对类型泳道基准的垂直偏移（世界像素） */
  bend: number;
}

/** 故事图全量 */
export interface StoryGraph {
  nodes: StoryNode[];
  edges: StoryEdge[];
  arcs: StoryArc[];
}

/** 伏笔总览行 */
export interface ForeshadowView {
  id: number;
  label: string;
  status: number;
  fromNode: number;
  /** 埋设位置描述：「第2卷」或「第2卷·第15章 玉佩现世」 */
  fromDesc: string;
  toNode: number;
  toDesc: string;
  fromChapterId: number | null;
  toChapterId: number | null;
  /** 跨度 = 章序差（卷级按保守估算） */
  span: number;
  /** 超过阈值（settings，默认 10 章） */
  overdue: boolean;
  arcId: number | null;
  fromTrashed: boolean;
  toTrashed: boolean;
}

/** 卷内章节卡片 */
export interface VolumeChapterBrief {
  id: number;
  title: string;
  status: number;
  wordCount: number;
  summary: string;
  notes: string;
  sortOrder: number;
  /** 全局章节序（0 起，卷序+章序） */
  globalOrder: number;
  /** 所属小节（章节群）；null = 未分组 */
  groupId: number | null;
  /** L2 画布坐标（归一化 0..1；null = 未排布，由布局算法派生） */
  mapX: number | null;
  mapY: number | null;
}

/** 小节（章节群）：同卷若干章节的分组，画布上渲染为组框 */
export interface ChapterGroup {
  id: number;
  volumeId: number;
  title: string;
  sortOrder: number;
}

/** 章间连线（L2 卷内画布，0顺序..6闪回与卷级边同枚举） */
export interface ChapterEdge {
  id: number;
  fromChapter: number;
  toChapter: number;
  edgeType: number;
  label: string;
  /** 伏笔：0=活跃 1=已回收 2=失效 */
  status: number;
  /** 手动弧度（世界像素） */
  bend: number;
}

/** 小节连线（组框拖出：小节→小节 / 小节→章节，目标二选一） */
export interface GroupEdge {
  id: number;
  volumeId: number;
  fromGroup: number;
  toGroup: number | null;
  toChapter: number | null;
  edgeType: number;
  label: string;
  /** 伏笔：0=活跃 1=已回收 2=失效 */
  status: number;
  bend: number;
}

/** 人物手动绑定（人物→卷 / 人物→章，二选一） */
export interface CharacterBinding {
  id: number;
  characterId: number;
  volumeId: number | null;
  chapterId: number | null;
}

/** L2 卷内人物画布坐标 */
export interface CharacterCanvasPos {
  characterId: number;
  mapX: number;
  mapY: number;
}

/** 卷内视图（L2）：卷节点 + 本卷章节 + 小节 + 连线 + 人物坐标 / 绑定 */
export interface VolumeDetail {
  node: StoryNode;
  chapters: VolumeChapterBrief[];
  groups: ChapterGroup[];
  chapterEdges: ChapterEdge[];
  groupEdges: GroupEdge[];
  charPositions: CharacterCanvasPos[];
  bindings: CharacterBinding[];
}

/** 卷级相邻（本章发展卡：所属卷的上 / 下游卷） */
export interface VolumeEdgeBrief {
  edgeId: number;
  edgeType: number;
  label: string;
  volume: StoryNode;
}

/** 本章相关伏笔（发展图卡片用） */
export interface ForeshadowBrief {
  edgeId: number;
  label: string;
  status: number;
  /** 对端位置描述（埋设视角 = 回收位置；回收视角 = 埋设位置） */
  otherDesc: string;
  /** 对端章级锚点（null = 卷级，跳地图） */
  otherChapterId: number | null;
  /** 对端卷 id（跳地图定位用） */
  otherVolumeId: number;
  /** 跨度（章序差，>= 0） */
  span: number;
  overdue: boolean;
  /** 本章埋设 + 回收端已完稿 + 仍活跃 → 显示「标记已回收」轻提示 */
  canResolve: boolean;
}

/** 单章故事上下文（右栏「本章发展」卡） */
export interface ChapterStoryContext {
  chapterId: number;
  /** 本章所属卷 */
  volume: StoryNode;
  /** 所属卷的入边（上游卷） */
  volumeInEdges: VolumeEdgeBrief[];
  /** 所属卷的出边（下游卷） */
  volumeOutEdges: VolumeEdgeBrief[];
  /** 卷内前章（≤4） */
  prevChapters: VolumeChapterBrief[];
  /** 卷内后章（≤4） */
  nextChapters: VolumeChapterBrief[];
  /** 本章埋设的伏笔（章级锚点 = 本章） */
  planted: ForeshadowBrief[];
  /** 本章回收的伏笔 */
  resolved: ForeshadowBrief[];
  /** 所属卷的卷级伏笔 */
  volumeForeshadows: ForeshadowBrief[];
}

// ========== 人物关系 / 分形画布（v0.9.13） ==========

/** 人物关系大类：1血缘 2情感 3社会 4阵营 5叙事（色 / 线型由大类定） */
export type RelationCategory = 1 | 2 | 3 | 4 | 5;

/** 人物关系（character_relations 表） */
export interface CharacterRelation {
  id: number;
  fromChar: number;
  toChar: number;
  relCategory: RelationCategory;
  /** 子类型名（自由文本，如「母女」「师徒」） */
  relType: string;
  /** 自定义补充说明 */
  label: string;
  /** 0双向 1单向(from→to) */
  direction: number;
  /** null = 跨卷关系（L1 / 所有 L2 显示）；具体卷 = 仅该卷 L2 显示 */
  volumeId: number | null;
  createdAt: string;
}

/** 人物 × 卷出场统计（character_mentions 按卷聚合，画布人物层数据源） */
export interface CharacterVolumePresence {
  characterId: number;
  name: string;
  role: string;
  volumeId: number;
  mentionCount: number;
}

/** 通用画布节点类型 */
export type CanvasNodeType = 'volume' | 'chapter' | 'character' | 'scene';

/** 通用画布节点（渲染内核只认 type / 坐标 / data，不认识领域语义） */
export interface CanvasNode {
  id: number;
  type: CanvasNodeType;
  /** 世界像素坐标（左上角） */
  x: number;
  y: number;
  /** 尺寸（character 圆形节点用 data.r） */
  w: number;
  h: number;
  /** 标题、字数、角色、颜色等渲染载荷 */
  data: Record<string, unknown>;
}

/** 通用画布边 kind：plot 剧情（章/卷→章/卷）· character 人物关系 · appearance 出场 */
export type CanvasEdgeKind = 'plot' | 'character' | 'appearance';

/** 通用画布边 */
export interface CanvasEdge {
  id: number;
  from: number;
  to: number;
  kind: CanvasEdgeKind;
  /** 剧情：0顺序 1因果 2分支 3汇合 4伏笔 5平行 6闪回；人物：关系大类 */
  edgeType: number;
  label: string;
  color?: string;
  /** 伏笔：0活跃 1已回收 2失效 */
  status?: number;
  /** 0双向 1单向（人物关系边） */
  direction?: number;
  /** 手动弧度：相对泳道基准的垂直偏移（世界像素，剧情边可拖弯落库） */
  bend?: number;
}

/** 画布层级：L1 全书 / L2 卷内 / L3 章节（L3 本次预留） */
export type CanvasLevel =
  | { kind: 'L1' }
  | { kind: 'L2'; volumeId: number }
  | { kind: 'L3'; chapterId: number };

/** 层级导航栈帧（返回时恢复视图与选中） */
export interface LevelFrame {
  level: CanvasLevel;
  view: { x: number; y: number; k: number };
  selectedId: number | null;
  layoutStrategy: string;
}
