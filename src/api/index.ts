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

export const listRecentProjects = () =>
  cmd<RecentProject[]>('list_recent_projects');

export const removeRecentProject = (path: string) =>
  cmd<void>('remove_recent_project', { path });

// ---------- 卷 ----------

export const createVolume = (title: string) =>
  cmd<Volume>('create_volume', { title });

export const renameVolume = (volumeId: number, title: string) =>
  cmd<void>('rename_volume', { volumeId, title });

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

export const generateNames = (kind: NameKind, count?: number) =>
  cmd<string[]>('generate_names', { kind, count: count ?? null });
