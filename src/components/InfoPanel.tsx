/**
 * 右侧信息面板：
 * - 项目统计卡
 * - 当前章节信息卡（字数 / 段落 / 阅读时长 / 状态）
 * - 本章出场卡（阶段 6：人物 / 地点精确匹配，随保存刷新）
 * - 版本历史卡（chapter_versions 快照浏览与恢复）
 */
import { useCallback, useEffect, useState } from 'react';
import * as api from '../api';
import { useAppStore } from '../store/appStore';
import { useEditorStore } from '../store/editorStore';
import { useCountUp } from '../hooks/useCountUp';
import type { ChapterPresenceView, ChapterVersionMeta } from '../types/models';
import { fmt } from '../utils/text';
import { countParagraphs, readingMinutes } from '../utils/text';
import { IconClock, IconRefresh } from './icons';

export function InfoPanel() {
  const tree = useAppStore((s) => s.tree)!;
  const selectedChapterId = useAppStore((s) => s.selectedChapterId);
  const showToast = useAppStore((s) => s.showToast);
  const refreshTree = useAppStore((s) => s.refreshTree);

  const chapterId = useEditorStore((s) => s.chapterId);
  const content = useEditorStore((s) => s.content);
  const status = useEditorStore((s) => s.status);
  const setStatus = useEditorStore((s) => s.setStatus);
  const lastSavedAt = useEditorStore((s) => s.lastSavedAt);
  const wordCount = useEditorStore((s) => s.wordCount);

  const [versions, setVersions] = useState<ChapterVersionMeta[]>([]);
  const [restoring, setRestoring] = useState(false);
  const [presence, setPresence] = useState<ChapterPresenceView | null>(null);

  const refreshVersions = useCallback(async () => {
    if (chapterId === null) {
      setVersions([]);
      return;
    }
    try {
      setVersions(await api.listChapterVersions(chapterId));
    } catch {
      setVersions([]);
    }
  }, [chapterId]);

  const refreshPresence = useCallback(async () => {
    if (chapterId === null) {
      setPresence(null);
      return;
    }
    try {
      setPresence(await api.getChapterPresence(chapterId));
    } catch {
      setPresence(null);
    }
  }, [chapterId]);

  useEffect(() => {
    void refreshVersions();
  }, [refreshVersions, chapterId, lastSavedAt]);

  // 卡片变更（建卡 / 重建统计）后刷新本章出场
  useEffect(() => {
    const h = () => void refreshPresence();
    window.addEventListener('nf:cards-updated', h);
    return () => window.removeEventListener('nf:cards-updated', h);
  }, [refreshPresence]);

  useEffect(() => {
    void refreshPresence();
  }, [refreshPresence, lastSavedAt]);

  const restore = async (versionId: number) => {
    if (chapterId === null || restoring) return;
    const ok = window.confirm('恢复到该历史版本？\n\n当前内容会先自动备份为一条新版本记录。');
    if (!ok) return;
    setRestoring(true);
    try {
      await api.restoreChapterVersion(chapterId, versionId);
      await useEditorStore.getState().loadChapter(chapterId);
      await refreshVersions();
      await refreshTree();
      showToast('已恢复到历史版本');
    } catch (e) {
      showToast(String(e), 'error');
    } finally {
      setRestoring(false);
    }
  };

  const live = {
    paragraphs: countParagraphs(content),
    minutes: readingMinutes(wordCount),
  };
  // 字数滚动：保存后从旧值平滑滚到新值（微反馈）
  const animatedWords = useCountUp(wordCount);

  return (
    <aside className="info-panel">
      <div className="info-card">
        <h3>项目</h3>
        <div className="info-title">《{tree.info.name}》</div>
        {tree.info.author && <div className="info-sub">{tree.info.author}</div>}
        <div className="info-grid">
          <div className="info-item">
            <span className="info-num">{fmt(tree.stats.totalWordCount)}</span>
            <span className="info-label">总字数</span>
          </div>
          <div className="info-item">
            <span className="info-num">{tree.stats.volumeCount}</span>
            <span className="info-label">卷</span>
          </div>
          <div className="info-item">
            <span className="info-num">{tree.stats.chapterCount}</span>
            <span className="info-label">章节</span>
          </div>
        </div>
      </div>

      {chapterId !== null && selectedChapterId !== null && (
        <>
          <div className="info-card">
            <h3>当前章节</h3>
            <div className="info-row">
              <span>字数</span>
              <b>{fmt(animatedWords)}</b>
            </div>
            <div className="info-row">
              <span>段落</span>
              <b>{live.paragraphs}</b>
            </div>
            <div className="info-row">
              <span>预计阅读</span>
              <b>约 {live.minutes} 分钟</b>
            </div>
            <div className="info-row">
              <span>状态</span>
              <select
                className="select"
                value={status}
                onChange={(e) => void setStatus(Number(e.target.value))}
              >
                <option value={0}>草稿</option>
                <option value={1}>完稿</option>
              </select>
            </div>
            {lastSavedAt && (
              <div className="info-row">
                <span>最近保存</span>
                <b>{lastSavedAt}</b>
              </div>
            )}
          </div>

          <div className="info-card">
            <h3>本章出场</h3>
            {presence === null ||
            (presence.characters.length === 0 && presence.locations.length === 0) ? (
              <p className="info-empty">
                本章暂无已建卡的人物 / 地点出场。在顶栏「人物地点」中建卡后自动统计。
              </p>
            ) : (
              <>
                {presence.characters.length > 0 && (
                  <div className="chapter-entity-line">
                    {presence.characters.map((c) => (
                      <span
                        key={c.id}
                        className="chip chip-mini chapter-entity-chip"
                        title={`${c.name}：本章出现 ${c.mentionCount} 次`}
                      >
                        {c.name}
                        <em>{c.mentionCount}</em>
                      </span>
                    ))}
                  </div>
                )}
                {presence.locations.length > 0 && (
                  <div className="chapter-entity-line">
                    {presence.locations.map((l) => (
                      <span
                        key={l.id}
                        className="chip chip-mini chip-place"
                        title={`${l.name}：本章出现 ${l.mentionCount} 次`}
                      >
                        {l.name}
                        <em>{l.mentionCount}</em>
                      </span>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>

          <div className="info-card grow">
            <h3>
              版本快照
              <button className="icon-btn" title="刷新" onClick={() => void refreshVersions()}>
                <IconRefresh />
              </button>
            </h3>
            {versions.length === 0 ? (
              <p className="info-empty">
                暂无快照。写作中每 5 分钟自动创建，Ctrl+S 也会保存快照。
              </p>
            ) : (
              <ul className="version-list">
                {versions.map((v) => (
                  <li key={v.id} className="version-item">
                    <IconClock />
                    <div className="version-main">
                      <span className="version-time">{v.createdAt}</span>
                      <span className="version-words">
                        {fmt(v.wordCount)} 字
                        {v.versionType === 2 && ' · 恢复前备份'}
                      </span>
                    </div>
                    <button
                      className="btn btn-mini"
                      disabled={restoring}
                      onClick={() => void restore(v.id)}
                    >
                      恢复
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}
    </aside>
  );
}
