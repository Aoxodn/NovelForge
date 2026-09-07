/**
 * 后端 API 层：与 Rust commands 一一对应的类型安全封装。
 */
import { cmd } from './client';
import type {
  BackupInfo,
  ChapterDetail,
  ChapterPresenceView,
  ChapterVersionMeta,
  CharacterHeat,
  CharacterProfile,
  ExportResult,
  ImportAnalysis,
  ImportResult,
  LocationProfile,
  NameKind,
  ProjectTree,
  RecentProject,
  SaveResult,
  SearchHit,
  Volume,
  WritingStats,
  DeletedChapter,
  NameParams,
  ChapterStoryContext,
  ForeshadowView,
  StoryArc,
  StoryEdge,
  StoryGraph,
} from '../types/models';

// ---------- 项目 ----------

export const createProject = (opts: {
  name: string;
  author: string;
  description: string;
  parentDir: string;
}) =>
  cmd<ProjectTree>('create_project', {
    name: opts.name,
    author: opts.author,
    description: opts.description,
    parentDir: opts.parentDir,
  });

export const openProject = (path: string) =>
  cmd<ProjectTree>('open_project', { path });

export const closeProject = () => cmd<void>('close_project');

export const updateProjectOutline = (outline: string) =>
  cmd<void>('update_project_outline', { outline });

export const listRecentProjects = () =>
  cmd<RecentProject[]>('list_recent_projects');

export const removeRecentProject = (path: string) =>
  cmd<void>('remove_recent_project', { path });

// ---------- 卷 ----------

export const createVolume = (title: string) =>
  cmd<Volume>('create_volume', { title });

export const renameVolume = (volumeId: number, title: string) =>
  cmd<void>('rename_volume', { volumeId, title });

export const setVolumeSummary = (volumeId: number, summary: string) =>
  cmd<void>('set_volume_summary', { volumeId, summary });

export const deleteVolume = (volumeId: number) =>
  cmd<void>('delete_volume', { volumeId });

export const moveVolume = (volumeId: number, targetIndex: number) =>
  cmd<void>('move_volume', { volumeId, targetIndex });

// ---------- 章节 ----------

export const createChapter = (volumeId: number, title?: string) =>
  cmd<ChapterDetail>('create_chapter', { volumeId, title: title ?? null });

export const getChapter = (chapterId: number) =>
  cmd<ChapterDetail>('get_chapter', { chapterId });

export const saveChapter = (
  chapterId: number,
  title: string,
  content: string,
  snapshot: boolean,
) =>
  cmd<SaveResult>('save_chapter', { chapterId, title, content, snapshot });

export const renameChapter = (chapterId: number, title: string) =>
  cmd<void>('rename_chapter', { chapterId, title });

export const setChapterStatus = (chapterId: number, status: number) =>
  cmd<void>('set_chapter_status', { chapterId, status });

/** 保存章纲与作者笔记（不触碰正文） */
export const setChapterOutline = (chapterId: number, summary: string, notes: string) =>
  cmd<void>('set_chapter_outline', { chapterId, summary, notes });

export const deleteChapter = (chapterId: number) =>
  cmd<void>('delete_chapter', { chapterId });

export const moveChapter = (
  chapterId: number,
  targetVolumeId: number,
  targetIndex: number,
) =>
  cmd<void>('move_chapter', { chapterId, targetVolumeId, targetIndex });

export const listChapterVersions = (chapterId: number) =>
  cmd<ChapterVersionMeta[]>('list_chapter_versions', { chapterId });

export const restoreChapterVersion = (chapterId: number, versionId: number) =>
  cmd<ChapterDetail>('restore_chapter_version', { chapterId, versionId });

// ---------- 导入（阶段 3） ----------

/** 分析导入文件：后台读取 + 章节识别，返回预览（不落库） */
export const importAnalyzeFile = (path: string) =>
  cmd<ImportAnalysis>('import_analyze_file', { path });

/** 确认导入：按调整后的边界事务落库
 *  - excluded：用户取消的误判边界，正文并入前一章
 *  - discarded：重复内容块，正文直接丢弃 */
export const importConfirm = (opts: {
  analysisId: string;
  excluded: number[];
  discarded: number[];
  volumeId: number | null;
  newVolumeTitle: string | null;
}) =>
  cmd<ImportResult>('import_confirm', {
    analysisId: opts.analysisId,
    excluded: opts.excluded,
    discarded: opts.discarded,
    volumeId: opts.volumeId,
    newVolumeTitle: opts.newVolumeTitle,
  });

// ---------- 导出（阶段 4） ----------

export const exportNovel = (opts: {
  format: 'txt' | 'docx' | 'md';
  scope: 'all' | 'volume' | 'chapter';
  volumeId: number | null;
  chapterId: number | null;
  outputPath: string;
}) =>
  cmd<ExportResult>('export_novel', {
    format: opts.format,
    scope: opts.scope,
    volumeId: opts.volumeId,
    chapterId: opts.chapterId,
    outputPath: opts.outputPath,
  });

// ---------- 搜索（阶段 4） ----------

export const searchProject = (query: string, useRegex: boolean) =>
  cmd<SearchHit[]>('search_project', { query, useRegex });

// ---------- 备份（阶段 4） ----------

export const backupProject = (auto: boolean) =>
  cmd<string>('backup_project', { auto });

export const listBackups = () => cmd<BackupInfo[]>('list_backups');

export const restoreBackup = (backupFile: string) =>
  cmd<ProjectTree>('restore_backup', { backupFile });

// ---------- 人物 / 地点卡（阶段 6：手动建卡 + 精确匹配统计） ----------

export const listCharacters = () => cmd<CharacterProfile[]>('list_characters');

export const addCharacter = (
  name: string,
  aliases?: string[],
  role?: string,
  notes?: string,
) =>
  cmd<CharacterProfile>('add_character', {
    name,
    aliases: aliases ?? null,
    role: role ?? null,
    notes: notes ?? null,
  });

export const updateCharacter = (
  characterId: number,
  patch: {
    name?: string;
    aliases?: string[];
    role?: string;
    notes?: string;
  },
) =>
  cmd<void>('update_character', {
    characterId,
    name: patch.name ?? null,
    aliases: patch.aliases ?? null,
    role: patch.role ?? null,
    notes: patch.notes ?? null,
  });

export const deleteCharacter = (characterId: number) =>
  cmd<void>('delete_character', { characterId });

/** 人物热度：按全书章节顺序的出现次数 + 断档预警 */
export const getCharacterHeat = (characterId: number) =>
  cmd<CharacterHeat>('get_character_heat', { characterId });

export const listLocations = () => cmd<LocationProfile[]>('list_locations');

export const addLocation = (name: string, notes?: string) =>
  cmd<LocationProfile>('add_location', { name, notes: notes ?? null });

export const updateLocation = (
  locationId: number,
  patch: { name?: string; notes?: string },
) =>
  cmd<void>('update_location', {
    locationId,
    name: patch.name ?? null,
    notes: patch.notes ?? null,
  });

export const deleteLocation = (locationId: number) =>
  cmd<void>('delete_location', { locationId });

/** 本章出场（实时精确匹配当前正文） */
export const getChapterPresence = (chapterId: number) =>
  cmd<ChapterPresenceView>('get_chapter_presence', { chapterId });

/** 全量重建提及统计（打开项目后自动调用，后台线程执行） */
export const rebuildMentions = () => cmd<number>('rebuild_mentions');

// ---------- 码字统计 / 随机取名（阶段 6） ----------

export const getWritingStats = () => cmd<WritingStats>('get_writing_stats');

export const generateNames = (kind: NameKind, count?: number, params?: NameParams) =>
  cmd<string[]>('generate_names', {
    kind,
    count: count ?? null,
    gender: params?.gender ?? null,
    country: params?.country ?? null,
    surnameType: params?.surnameType ?? null,
    surname: params?.surname ?? null,
    given: params?.given ?? null,
  });

// ---------- 回收站 ----------

export const listDeletedChapters = () => cmd<DeletedChapter[]>('list_deleted_chapters');

export const restoreChapter = (chapterId: number) =>
  cmd<void>('restore_chapter', { chapterId });

export const purgeChapter = (chapterId: number) =>
  cmd<void>('purge_chapter', { chapterId });

// ---------- 批量整理 ----------

/** 卷内章节倒序 */
export const reverseVolumeChapters = (volumeId: number) =>
  cmd<void>('reverse_volume_chapters', { volumeId });

/** 全书排版：去段首/行尾空白、删空行；返回被修改章节数 */
export const formatAllChapters = () => cmd<number>('format_all_chapters');

// ---------- 故事地图 / 全书总览 / 章节发展图（V6：可视化写小说） ----------

/** 全量拉取故事图（节点 / 连线 / 弧线） */
export const listStoryGraph = () => cmd<StoryGraph>('list_story_graph');

/** 单章故事上下文（右栏「本章发展」卡） */
export const getChapterStoryContext = (chapterId: number) =>
  cmd<ChapterStoryContext>('get_chapter_story_context', { chapterId });

/** 伏笔总览（含跨度与超期标记） */
export const listForeshadows = () => cmd<ForeshadowView[]>('list_foreshadows');

/** 新建剧情线。kind: 0=主线 1=支线 2=暗线 */
export const createStoryArc = (title: string, kind: number, color = '') =>
  cmd<StoryArc>('create_story_arc', { title, kind, color });

export const updateStoryArc = (
  arcId: number,
  patch: { title: string; kind: number; color: string; summary: string },
) =>
  cmd<void>('update_story_arc', {
    arcId,
    title: patch.title,
    kind: patch.kind,
    color: patch.color,
    summary: patch.summary,
  });

/** 删除剧情线（章节与连线不受影响，归属自动清空） */
export const deleteStoryArc = (arcId: number) =>
  cmd<void>('delete_story_arc', { arcId });

export const listStoryArcs = () => cmd<StoryArc[]>('list_story_arcs');

/** 设置节点弧线归属（null = 移出所有剧情线） */
export const setNodeArc = (chapterId: number, arcId: number | null) =>
  cmd<void>('set_node_arc', { chapterId, arcId });

/** 保存画布坐标（拖拽防抖落库，归一化 0..1） */
export const moveStoryNode = (chapterId: number, mapX: number, mapY: number) =>
  cmd<void>('move_story_node', { chapterId, mapX, mapY });

/** 新建规划节点（空章节 + node_type，1=事件 2=转折 3=支线 4=结局） */
export const createPlanningNode = (
  volumeId: number,
  title: string,
  nodeType: number,
) =>
  cmd<ChapterDetail>('create_planning_node', {
    volumeId,
    title,
    nodeType,
  });

/** 画布移除节点：清坐标 + 删关联边（章节保留在目录树） */
export const removeStoryNode = (chapterId: number) =>
  cmd<void>('remove_story_node', { chapterId });

/** 自动布局：按全局章节序蛇形铺排并重建顺序边；返回节点数 */
export const autoLayoutStoryMap = () => cmd<number>('auto_layout_story_map');

/** 建连线。edgeType: 0=顺序 1=因果 2=分支 3=汇合 4=伏笔回收 */
export const createStoryEdge = (opts: {
  fromNode: number;
  toNode: number;
  edgeType: number;
  arcId: number | null;
  label: string;
}) =>
  cmd<StoryEdge>('create_story_edge', {
    fromNode: opts.fromNode,
    toNode: opts.toNode,
    edgeType: opts.edgeType,
    arcId: opts.arcId,
    label: opts.label,
  });

/** 编辑连线（label / 所属弧线） */
export const updateStoryEdge = (
  edgeId: number,
  label: string,
  arcId: number | null,
) => cmd<void>('update_story_edge', { edgeId, label, arcId });

/** 伏笔状态：0=活跃 1=已回收 2=失效 */
export const setForeshadowStatus = (edgeId: number, status: number) =>
  cmd<void>('set_foreshadow_status', { edgeId, status });

export const deleteStoryEdge = (edgeId: number) =>
  cmd<void>('delete_story_edge', { edgeId });

export const getForeshadowThreshold = () =>
  cmd<number>('get_foreshadow_threshold');

export const setForeshadowThreshold = (threshold: number) =>
  cmd<void>('set_foreshadow_threshold', { threshold });
