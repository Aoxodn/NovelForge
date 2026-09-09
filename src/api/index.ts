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
  CharacterMeta,
  CharacterProfile,
  ExportResult,
  ImportAnalysis,
  ImportResult,
  LocationProfile,
  NameKind,
  NameGenre,
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
  VolumeDetail,
  CharacterRelation,
  CharacterVolumePresence,
  ChapterEdge,
  ChapterGroup,
  GroupEdge,
  CharacterBinding,
  CharacterCanvasPos,
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

/** 只读刷新当前项目树（复用现有连接，不重开数据库） */
export const getCurrentProjectTree = () => cmd<ProjectTree>('get_current_project_tree');

export const closeProject = () => cmd<void>('close_project');

export const updateProjectOutline = (outline: string) =>
  cmd<void>('update_project_outline', { outline });

export const updateProjectInfo = (patch: { name?: string; author?: string; description?: string }) =>
  cmd<ProjectTree>('update_project_info', {
    name: patch.name ?? null,
    author: patch.author ?? null,
    description: patch.description ?? null,
  });

export const listRecentProjects = () =>
  cmd<RecentProject[]>('list_recent_projects');

export const removeRecentProject = (path: string) =>
  cmd<void>('remove_recent_project', { path });

// ---------- 卷 ----------

export const createVolume = (title: string, mapX?: number, mapY?: number) =>
  cmd<Volume>('create_volume', { title, mapX: mapX ?? null, mapY: mapY ?? null });

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

/** 紧急导出未保存正文到指定文件（保存失败抢救用） */
export const emergencyDumpText = (path: string, title: string, content: string) =>
  cmd<void>('emergency_dump_text', { path, title, content });

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

/** 取消导入：释放后端分析缓存（大文本不再滞留内存） */
export const importCancel = (analysisId: string) =>
  cmd<void>('import_cancel', { analysisId });

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
  excludeWords?: string[],
  meta?: CharacterMeta,
) =>
  cmd<CharacterProfile>('add_character', {
    name,
    aliases: aliases ?? null,
    role: role ?? null,
    notes: notes ?? null,
    excludeWords: excludeWords ?? null,
    meta: meta ?? null,
  });

export const updateCharacter = (
  characterId: number,
  patch: {
    name?: string;
    aliases?: string[];
    role?: string;
    notes?: string;
    excludeWords?: string[];
    meta?: CharacterMeta;
  },
) =>
  cmd<void>('update_character', {
    characterId,
    name: patch.name ?? null,
    aliases: patch.aliases ?? null,
    role: patch.role ?? null,
    notes: patch.notes ?? null,
    excludeWords: patch.excludeWords ?? null,
    meta: patch.meta ?? null,
  });

export const deleteCharacter = (characterId: number) =>
  cmd<void>('delete_character', { characterId });

/** 批量更新人物自定义排序（[(id, sortOrder), ...]，单事务） */
export const reorderCharacters = (orders: [number, number][]) =>
  cmd<void>('reorder_characters', { orders });

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

/** 别名 / 称谓冲突：同一称谓被多张人物卡声明，需作者裁决归属 */
export interface AliasConflict {
  label: string;
  characterIds: number[];
  characterNames: string[];
}
/** 检测全书人物重名 / 共享别名冲突 */
export const getAliasConflicts = () => cmd<AliasConflict[]>('get_alias_conflicts');

// ---------- 码字统计 / 随机取名（阶段 6） ----------

export const getWritingStats = () => cmd<WritingStats>('get_writing_stats');

export const generateNames = (kind: NameKind, count?: number, params?: NameParams) =>
  cmd<string[]>('generate_names', {
    kind,
    count: count ?? null,
    genre: params?.genre ?? null,
    gender: params?.gender ?? null,
    country: params?.country ?? null,
    surnameType: params?.surnameType ?? null,
    surname: params?.surname ?? null,
    given: params?.given ?? null,
  });

export const listNameGenres = () => cmd<NameGenre[]>('list_name_genres');

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

// ---------- 故事地图 / 全书总览 / 章节发展图（V7：可视化写小说，节点 = 卷） ----------

/** 全量拉取故事图（卷节点 / 连线 / 弧线） */
export const listStoryGraph = () => cmd<StoryGraph>('list_story_graph');

/** 卷内视图：卷节点 + 本卷章节列表 */
export const getVolumeDetail = (volumeId: number) =>
  cmd<VolumeDetail>('get_volume_detail', { volumeId });

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

/** 删除剧情线（连线不受影响，归属自动清空） */
export const deleteStoryArc = (arcId: number) =>
  cmd<void>('delete_story_arc', { arcId });

export const listStoryArcs = () => cmd<StoryArc[]>('list_story_arcs');

/** 保存节点画布坐标（拖拽松手落库，归一化） */
export const moveStoryNode = (volumeId: number, mapX: number, mapY: number) =>
  cmd<void>('move_story_node', { volumeId, mapX, mapY });

/** 自动布局：按剧情线分层泳道重排并落库；返回节点数 */
export const autoLayoutStoryMap = () => cmd<number>('auto_layout_story_map');

/** 建连线（两端 = 卷）。伏笔（edgeType=4）可带章级锚点，null = 卷级 */
export const createStoryEdge = (opts: {
  fromNode: number;
  toNode: number;
  edgeType: number;
  arcId: number | null;
  fromChapterId: number | null;
  toChapterId: number | null;
  label: string;
}) =>
  cmd<StoryEdge>('create_story_edge', {
    fromNode: opts.fromNode,
    toNode: opts.toNode,
    edgeType: opts.edgeType,
    arcId: opts.arcId,
    fromChapterId: opts.fromChapterId,
    toChapterId: opts.toChapterId,
    label: opts.label,
  });

/** 编辑连线（label / 所属弧线） */
export const updateStoryEdge = (
  edgeId: number,
  label: string,
  arcId: number | null,
) => cmd<void>('update_story_edge', { edgeId, label, arcId });

/** 保存连线手动弧度（拖弯落库，世界像素 ±400） */
export const setStoryEdgeBend = (edgeId: number, bend: number) =>
  cmd<void>('set_story_edge_bend', { edgeId, bend });

/** 伏笔状态：0=活跃 1=已回收 2=失效 */
export const setForeshadowStatus = (edgeId: number, status: number) =>
  cmd<void>('set_foreshadow_status', { edgeId, status });

export const deleteStoryEdge = (edgeId: number) =>
  cmd<void>('delete_story_edge', { edgeId });

export const getForeshadowThreshold = () =>
  cmd<number>('get_foreshadow_threshold');

export const setForeshadowThreshold = (threshold: number) =>
  cmd<void>('set_foreshadow_threshold', { threshold });

// ---------- 人物关系 / 出场统计（v0.9.13 广义人物关系体系） ----------

/** 人物关系列表（画布隔离口径）。不传 = 仅跨卷（L1）；传卷 id = 仅该卷（L2） */
export const listCharacterRelations = (volumeId?: number) =>
  cmd<CharacterRelation[]>('list_character_relations', { volumeId: volumeId ?? null });

/** 全部人物关系（跨卷 + 各卷），仅供人物卡管理视图 */
export const listAllCharacterRelations = () =>
  cmd<CharacterRelation[]>('list_all_character_relations');

export const createCharacterRelation = (opts: {
  fromChar: number;
  toChar: number;
  relCategory: number;
  relType: string;
  label: string;
  direction: number;
  volumeId: number | null;
}) =>
  cmd<CharacterRelation>('create_character_relation', {
    fromChar: opts.fromChar,
    toChar: opts.toChar,
    relCategory: opts.relCategory,
    relType: opts.relType,
    label: opts.label,
    direction: opts.direction,
    volumeId: opts.volumeId,
  });

export const updateCharacterRelation = (
  relationId: number,
  opts: {
    relCategory: number;
    relType: string;
    label: string;
    direction: number;
    volumeId: number | null;
  },
) =>
  cmd<void>('update_character_relation', {
    relationId,
    relCategory: opts.relCategory,
    relType: opts.relType,
    label: opts.label,
    direction: opts.direction,
    volumeId: opts.volumeId,
  });

export const deleteCharacterRelation = (relationId: number) =>
  cmd<void>('delete_character_relation', { relationId });

/** 人物 × 卷出场统计（画布人物层数据源，character_mentions 按卷聚合） */
export const listCharacterVolumePresence = () =>
  cmd<CharacterVolumePresence[]>('list_character_volume_presence');

/** 卷内按章的人物提及（L2 人物节点定位数据源） */
export const listVolumeCharacterMentions = (volumeId: number) =>
  cmd<{ chapterId: number; characterId: number; mentionCount: number }[]>(
    'list_volume_character_mentions',
    { volumeId },
  );

// ---------- L2 卷内画布（v0.9.13 可编辑化：章节坐标 / 小节 / 章间连线） ----------

/** 保存章节画布坐标（拖动松手落库，归一化） */
export const moveChapterNode = (chapterId: number, mapX: number, mapY: number) =>
  cmd<void>('move_chapter_node', { chapterId, mapX, mapY });

/** 批量保存章节画布坐标（小节 / 多选整体拖动，单事务） */
export const moveChapterNodes = (
  positions: { chapterId: number; mapX: number; mapY: number }[],
) => cmd<number>('move_chapter_nodes', { positions });

/** 建章间连线（同卷）。伏笔（edgeType=4）label 必填 */
export const createChapterEdge = (opts: {
  fromChapter: number;
  toChapter: number;
  edgeType: number;
  label: string;
}) =>
  cmd<ChapterEdge>('create_chapter_edge', {
    fromChapter: opts.fromChapter,
    toChapter: opts.toChapter,
    edgeType: opts.edgeType,
    label: opts.label,
  });

/** 编辑章间连线（label；伏笔可流转 status） */
export const updateChapterEdge = (edgeId: number, label: string, status: number) =>
  cmd<void>('update_chapter_edge', { edgeId, label, status });

export const deleteChapterEdge = (edgeId: number) =>
  cmd<void>('delete_chapter_edge', { edgeId });

/** 保存章间连线手动弧度（拖弯落库） */
export const setChapterEdgeBend = (edgeId: number, bend: number) =>
  cmd<void>('set_chapter_edge_bend', { edgeId, bend });

export const createChapterGroup = (volumeId: number, title: string) =>
  cmd<ChapterGroup>('create_chapter_group', { volumeId, title });

export const renameChapterGroup = (groupId: number, title: string) =>
  cmd<void>('rename_chapter_group', { groupId, title });

/** 删除小节（章节保留，仅解除分组） */
export const deleteChapterGroup = (groupId: number) =>
  cmd<void>('delete_chapter_group', { groupId });

/** 章节加入 / 移出小节（groupId = null 移出） */
export const setChapterGroup = (chapterId: number, groupId: number | null) =>
  cmd<void>('set_chapter_group', { chapterId, groupId });

/** 建小节连线（组框拖出：目标小节 / 目标章节二选一）。伏笔 label 必填 */
export const createGroupEdge = (opts: {
  volumeId: number;
  fromGroup: number;
  toGroup: number | null;
  toChapter: number | null;
  edgeType: number;
  label: string;
}) =>
  cmd<GroupEdge>('create_group_edge', {
    volumeId: opts.volumeId,
    fromGroup: opts.fromGroup,
    toGroup: opts.toGroup,
    toChapter: opts.toChapter,
    edgeType: opts.edgeType,
    label: opts.label,
  });

/** 编辑小节连线（label；伏笔可流转 status） */
export const updateGroupEdge = (edgeId: number, label: string, status: number) =>
  cmd<void>('update_group_edge', { edgeId, label, status });

export const deleteGroupEdge = (edgeId: number) =>
  cmd<void>('delete_group_edge', { edgeId });

/** 保存小节连线手动弧度（拖弯落库） */
export const setGroupEdgeBend = (edgeId: number, bend: number) =>
  cmd<void>('set_group_edge_bend', { edgeId, bend });

// ---------- 人物图谱（v0.9.13 可编辑人物层） ----------

/** 保存 L1 全书人物图谱坐标（拖动落库，归一化） */
export const moveCharacterNode = (characterId: number, mapX: number, mapY: number) =>
  cmd<void>('move_character_node', { characterId, mapX, mapY });

/** 从 L1 全书画布移除人物（清坐标，不删卡） */
export const removeCharacterFromCanvas = (characterId: number) =>
  cmd<void>('remove_character_from_canvas', { characterId });

/** 保存 L2 卷内人物节点坐标（upsert） */
export const setCharVolumePos = (characterId: number, volumeId: number, mapX: number, mapY: number) =>
  cmd<void>('set_char_volume_pos', { characterId, volumeId, mapX, mapY });

/** 从 L2 卷内画布移除人物 */
export const removeCharacterFromVolume = (characterId: number, volumeId: number) =>
  cmd<void>('remove_character_from_volume', { characterId, volumeId });

/** 手动绑定人物→卷 / 人物→章（重复绑定报「已绑定」） */
export const createCharacterBinding = (opts: {
  characterId: number;
  volumeId: number | null;
  chapterId: number | null;
}) =>
  cmd<CharacterBinding>('create_character_binding', {
    characterId: opts.characterId,
    volumeId: opts.volumeId,
    chapterId: opts.chapterId,
  });

/** 解除绑定 */
export const deleteCharacterBinding = (bindingId: number) =>
  cmd<void>('delete_character_binding', { bindingId });

/** 全部人物→卷绑定（L1 关联线） */
export const listCharacterBindings = () =>
  cmd<CharacterBinding[]>('list_character_bindings');

/** L2 卷内人物画布坐标 */
export const listCharVolumePos = (volumeId: number) =>
  cmd<CharacterCanvasPos[]>('list_char_volume_pos', { volumeId });


// ================= 审查新增功能：场景板 / 人物弧光 / 安全改名 / 连续性 / 修订 =================

export interface Scene {
  id: number;
  chapterId: number;
  sortOrder: number;
  pov: string;
  timeOfScene: string;
  place: string;
  goal: string;
  conflict: string;
  result: string;
  targetWords: number;
  content: string;
}

export const listScenes = (chapterId: number) =>
  cmd<Scene[]>('list_scenes', { chapterId });
export const createScene = (chapterId: number) =>
  cmd<Scene>('create_scene', { chapterId });
export const updateScene = (
  sceneId: number,
  patch: Partial<Pick<Scene, 'pov' | 'timeOfScene' | 'place' | 'goal' | 'conflict' | 'result' | 'targetWords' | 'content'>>,
) =>
  cmd<void>('update_scene', {
    sceneId,
    pov: patch.pov ?? null,
    timeOfScene: patch.timeOfScene ?? null,
    place: patch.place ?? null,
    goal: patch.goal ?? null,
    conflict: patch.conflict ?? null,
    result: patch.result ?? null,
    targetWords: patch.targetWords ?? null,
    content: patch.content ?? null,
  });
export const deleteScene = (sceneId: number) =>
  cmd<void>('delete_scene', { sceneId });
export const reorderScenes = (chapterId: number, orderedIds: number[]) =>
  cmd<void>('reorder_scenes', { chapterId, orderedIds });
export const composeScenesToChapter = (chapterId: number, overwrite: boolean) =>
  cmd<string>('compose_scenes_to_chapter', { chapterId, overwrite });

export interface CharacterArc {
  id: number;
  characterId: number;
  chapterId: number | null;
  sortOrder: number;
  desire: string;
  choice: string;
  cost: string;
  stateChange: string;
  note: string;
  chapterTitle: string | null;
}

export const listArcs = (characterId: number) =>
  cmd<CharacterArc[]>('list_arcs', { characterId });
export const createArc = (characterId: number, chapterId: number | null) =>
  cmd<CharacterArc>('create_arc', { characterId, chapterId });
export const updateArc = (
  arcId: number,
  patch: Partial<Pick<CharacterArc, 'chapterId' | 'desire' | 'choice' | 'cost' | 'stateChange' | 'note'>>,
) =>
  cmd<void>('update_arc', {
    arcId,
    chapterId: patch.chapterId === undefined ? null : patch.chapterId,
    desire: patch.desire ?? null,
    choice: patch.choice ?? null,
    cost: patch.cost ?? null,
    stateChange: patch.stateChange ?? null,
    note: patch.note ?? null,
  });
export const deleteArc = (arcId: number) => cmd<void>('delete_arc', { arcId });
export const reorderArcs = (characterId: number, orderedIds: number[]) =>
  cmd<void>('reorder_arcs', { characterId, orderedIds });

export interface ChapterHit {
  chapterId: number;
  chapterTitle: string;
  count: number;
  snippets: string[];
}

export const previewRenameCharacter = (
  characterId: number,
  excludeQuotes: boolean,
  chapterIds: number[] | null,
) =>
  cmd<ChapterHit[]>('preview_rename_character', {
    characterId,
    excludeQuotes,
    chapterIds,
  });
export const applyRenameCharacter = (
  characterId: number,
  newName: string,
  excludeQuotes: boolean,
  chapterIds: number[] | null,
) =>
  cmd<number>('apply_rename_character', {
    characterId,
    newName,
    excludeQuotes,
    chapterIds,
  });

export interface ContinuityIssue {
  id: number;
  kind: string;
  fingerprint: string;
  title: string;
  detail: string;
  chapterId: number | null;
  refId: number | null;
  status: number;
}

export const scanContinuity = (longAbsence?: number, foreshadowOverdue?: number) =>
  cmd<ContinuityIssue[]>('scan_continuity', {
    longAbsence: longAbsence ?? null,
    foreshadowOverdue: foreshadowOverdue ?? null,
  });
export const listContinuity = () =>
  cmd<ContinuityIssue[]>('list_continuity');
export const setContinuityStatus = (issueId: number, status: number) =>
  cmd<void>('set_continuity_status', { issueId, status });

export interface RevisionHit {
  chapterId: number;
  chapterTitle: string;
  kind: string;
  message: string;
  snippet: string;
}

export const analyzeRevision = (longSentence?: number) =>
  cmd<RevisionHit[]>('analyze_revision', { longSentence: longSentence ?? null });
export const previewCrossReplace = (find: string, chapterIds: number[] | null) =>
  cmd<ChapterHit[]>('preview_cross_replace', { find, chapterIds });
export const applyCrossReplace = (
  find: string,
  replace: string,
  chapterIds: number[] | null,
) =>
  cmd<number>('apply_cross_replace', { find, replace, chapterIds });
