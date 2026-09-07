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
  /** 0=正文 1=事件 2=转折 3=支线 4=结局（V6：规划节点标注） */
  nodeType: number;
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

/** 人名筛选参数 */
export interface NameParams {
  gender?: 'male' | 'female' | 'any';
  country?: 'cn' | 'jp' | 'west';
  surnameType?: 'single' | 'compound' | 'any';
  surname?: string;
  given?: string;
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

// ========== 故事地图 / 可视化写小说（V6） ==========

/** 节点类型：0=正文 1=事件 2=转折 3=支线 4=结局 */
export type StoryNodeType = 0 | 1 | 2 | 3 | 4;

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

/** 故事图节点 = 章节元数据 + 画布坐标 + 节点类型 + 弧线归属 */
export interface StoryNode {
  id: number;
  volumeId: number;
  volumeTitle: string;
  title: string;
  summary: string;
  wordCount: number;
  status: number;
  nodeType: number;
  /** 画布坐标，归一化 0..1；null = 未排布 */
  mapX: number | null;
  mapY: number | null;
  arcId: number | null;
  /** 全局章节序（0 起，卷序+章序；跨章计算统一口径） */
  globalOrder: number;
}

/** 连线 */
export interface StoryEdge {
  id: number;
  fromNode: number;
  toNode: number;
  edgeType: number;
  arcId: number | null;
  /** 因果说明 / 伏笔内容 */
  label: string;
  /** 伏笔：0=活跃 1=已回收 2=失效 */
  status: number;
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
  fromTitle: string;
  toNode: number;
  toTitle: string;
  /** 跨度 = 全局章节序差（>= 0） */
  span: number;
  /** 超过阈值（settings，默认 10 章） */
  overdue: boolean;
  arcId: number | null;
  fromTrashed: boolean;
  toTrashed: boolean;
}

/** 相邻节点（本章发展的上 / 下游项） */
export interface StoryNeighbor {
  edgeId: number;
  edgeType: number;
  label: string;
  node: StoryNode;
}

/** 本章伏笔（发展图卡片用） */
export interface ForeshadowBrief {
  edgeId: number;
  label: string;
  status: number;
  /** 对端章节（埋设视角 = 回收章；回收视角 = 埋设章） */
  otherNode: StoryNode;
  span: number;
  overdue: boolean;
  /** 本章埋设 + 回收端已完稿 + 仍活跃 → 显示「标记已回收」轻提示 */
  canResolve: boolean;
}

/** 单章故事上下文（右栏「本章发展」卡） */
export interface ChapterStoryContext {
  chapterId: number;
  arc: StoryArc | null;
  upstream: StoryNeighbor[];
  downstream: StoryNeighbor[];
  planted: ForeshadowBrief[];
  resolved: ForeshadowBrief[];
}
