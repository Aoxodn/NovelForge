/**
 * 右侧信息面板：
 * - 项目统计卡（含全书大纲入口）
 * - 当前章节信息卡（字数 / 段落 / 阅读时长 / 状态）
 * - 本章纲要卡（章纲 + 作者笔记，防抖自动保存）
 * - 本章出场卡（阶段 6：人物 / 地点精确匹配，随保存刷新）
 * - 本章发展卡（V6：故事图单章上下文——上下游 / 伏笔 / 弧线）
 * - 版本历史卡（chapter_versions 快照浏览与恢复）
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import * as api from '../api';
import { useAppStore } from '../store/appStore';
import { useEditorStore } from '../store/editorStore';
import { useCountUp } from '../hooks/useCountUp';
import type { ChapterPresenceView, ChapterStoryContext, ChapterVersionMeta } from '../types/models';
import { fmt } from '../utils/text';
import { countParagraphs, readingMinutes } from '../utils/text';
import { IconClock, IconRefresh } from './icons';
import { OutlineModal } from './OutlineModal';

type OutlineSaveState = 'idle' | 'saving' | 'saved' | 'error';

/** 连线类型名（本章发展卡 / 图例共用口径） */
const edgeTypeName = (t: number) =>
  ['顺序', '因果', '分支', '汇合', '伏笔'][t] ?? '连线';

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
  const [storyCtx, setStoryCtx] = useState<ChapterStoryContext | null>(null);
  const [showProjectOutline, setShowProjectOutline] = useState(false);
  const focusMapNode = useAppStore((s) => s.focusMapNode);

  // ---------- 本章纲要：切换章节载入，输入后 600ms 防抖自动保存 ----------
  const [chSummary, setChSummary] = useState('');
  const [chNotes, setChNotes] = useState('');
  const [loadedId, setLoadedId] = useState<number | null>(null);
  const [outlineState, setOutlineState] = useState<OutlineSaveState>('idle');
  const chDirtyRef = useRef(false);

  useEffect(() => {
    if (chapterId === null) {
      setLoadedId(null);
      return;
    }
    let cancelled = false;
    api
      .getChapter(chapterId)
      .then((c) => {
        if (cancelled) return;
        setChSummary(c.summary);
        setChNotes(c.notes);
        setLoadedId(chapterId);
        chDirtyRef.current = false;
        setOutlineState('idle');
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [chapterId]);

  useEffect(() => {
    if (chapterId === null || chapterId !== loadedId || !chDirtyRef.current) return;
    const t = setTimeout(async () => {
      setOutlineState('saving');
      try {
        await api.setChapterOutline(chapterId, chSummary, chNotes);
        chDirtyRef.current = false;
        setOutlineState('saved');
      } catch {
        setOutlineState('error');
      }
    }, 600);
    return () => clearTimeout(t);
  }, [chSummary, chNotes, chapterId, loadedId]);

  const editChSummary = (v: string) => {
    chDirtyRef.current = true;
    setChSummary(v);
    setOutlineState('idle');
  };
  const editChNotes = (v: string) => {
    chDirtyRef.current = true;
    setChNotes(v);
    setOutlineState('idle');
  };

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

  // ---------- 本章发展：单章故事上下文（上游 / 下游 / 伏笔 / 弧线） ----------
  const refreshStoryCtx = useCallback(async () => {
    if (chapterId === null) {
      setStoryCtx(null);
      return;
    }
    try {
      setStoryCtx(await api.getChapterStoryContext(chapterId));
    } catch {
      setStoryCtx(null);
    }
  }, [chapterId]);

  useEffect(() => {
    void refreshStoryCtx();
  }, [refreshStoryCtx, lastSavedAt]);

  // 地图 / 总览改动 → 同步刷新本章发展
  useEffect(() => {
    const h = () => void refreshStoryCtx();
    window.addEventListener('nf:story-updated', h);
    return () => window.removeEventListener('nf:story-updated', h);
  }, [refreshStoryCtx]);

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
        {/* 全书大纲：预览两行 + 编辑入口 */}
        <button
          className="info-outline"
          title="编辑全书大纲"
          onClick={() => setShowProjectOutline(true)}
        >
          <span className="outline-label">全书大纲</span>
          <span className={`info-outline-text${tree.info.outline ? '' : ' empty'}`}>
            {tree.info.outline || '尚未填写，点击规划主线、设定与梗概…'}
          </span>
        </button>
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
            <h3>
              本章纲要
              <span className={`outline-save-state${outlineState === 'error' ? ' error' : ''}`}>
                {outlineState === 'saving'
                  ? '保存中…'
                  : outlineState === 'saved'
                    ? '已保存'
                    : outlineState === 'error'
                      ? '保存失败'
                      : ''}
              </span>
            </h3>
            <span className="outline-label">纲要（这一章写什么）</span>
            <textarea
              className="input textarea outline-input"
              value={chSummary}
              onChange={(e) => editChSummary(e.target.value)}
              placeholder="本章目标、关键冲突、结尾钩子…"
            />
            <span className="outline-label">作者笔记（不参与导出）</span>
            <textarea
              className="input textarea outline-input"
              value={chNotes}
              onChange={(e) => editChNotes(e.target.value)}
              placeholder="待改、伏笔提醒、灵感…"
            />
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

          <div className="info-card">
            <h3>本章发展</h3>
            {storyCtx === null ||
            (storyCtx.upstream.length === 0 &&
              storyCtx.downstream.length === 0 &&
              storyCtx.planted.length === 0 &&
              storyCtx.resolved.length === 0 &&
              storyCtx.arc === null) ? (
              <p className="info-empty">
                本章尚未纳入故事地图。在顶栏「故事地图」中建立连接后，这里会显示它的来龙去脉。
              </p>
            ) : (
              <div className="story-ctx">
                {storyCtx.arc && (
                  <div className="story-ctx-arc">
                    <i
                      className="arc-swatch"
                      style={{ background: storyCtx.arc.color || 'var(--accent)' }}
                    />
                    所属剧情线：{storyCtx.arc.title}
                  </div>
                )}

                {(storyCtx.upstream.length > 0 || storyCtx.downstream.length > 0) && (
                  <div className="story-ctx-flow">
                    {storyCtx.upstream.slice(0, 4).map((u) => (
                      <button
                        key={u.edgeId}
                        className="story-ctx-node"
                        title={`${edgeTypeName(u.edgeType)}${u.label ? `：${u.label}` : ''}\n点击在地图中定位`}
                        onClick={() => focusMapNode(u.node.id)}
                      >
                        <em>{edgeTypeName(u.edgeType)}</em>
                        {u.node.title}
                      </button>
                    ))}
                    {storyCtx.upstream.length > 0 && <span className="story-ctx-arrow">←</span>}
                    <span className="story-ctx-node story-ctx-center">本章</span>
                    {storyCtx.downstream.length > 0 && <span className="story-ctx-arrow">→</span>}
                    {storyCtx.downstream.slice(0, 4).map((d) => (
                      <button
                        key={d.edgeId}
                        className="story-ctx-node"
                        title={`${edgeTypeName(d.edgeType)}${d.label ? `：${d.label}` : ''}\n点击在地图中定位`}
                        onClick={() => focusMapNode(d.node.id)}
                      >
                        <em>{edgeTypeName(d.edgeType)}</em>
                        {d.node.title}
                      </button>
                    ))}
                  </div>
                )}

                {storyCtx.planted.map((f) => (
                  <div key={f.edgeId} className="fs-brief">
                    <span
                      className={`fs-badge${f.status === 1 ? ' done' : f.overdue ? ' warn' : ''}`}
                      title={f.status === 1 ? '已回收' : f.overdue ? '未回收 · 超期' : '未回收'}
                    >
                      {f.status === 1 ? '✓' : '埋'}
                    </span>
                    <button className="link-btn" title={f.label} onClick={() => focusMapNode(f.otherNode.id)}>
                      {f.label || '（未命名伏笔）'}
                    </button>
                    <span className="story-ctx-more">
                      {f.span > 0 ? `${f.span} 章` : ''}
                      {f.overdue && f.status !== 1 ? ' ⚠' : ''}
                    </span>
                  </div>
                ))}
                {storyCtx.resolved.map((f) => (
                  <div key={f.edgeId} className="fs-brief">
                    <span className="fs-badge done" title="本章回收">✓</span>
                    <button className="link-btn" title={f.label} onClick={() => focusMapNode(f.otherNode.id)}>
                      {f.label || '（未命名伏笔）'}
                    </button>
                    <span className="story-ctx-more">
                      {f.span > 0 ? `${f.span} 章前埋设` : '前章埋设'}
                    </span>
                  </div>
                ))}

                {/* 回收建议：非阻塞轻提示（回收端已完稿且仍活跃） */}
                {storyCtx.planted
                  .filter((f) => f.canResolve)
                  .slice(0, 1)
                  .map((f) => (
                    <div key={`hint-${f.edgeId}`} className="fs-resolve-hint">
                      <span title="回收章已完稿，可标记伏笔为已回收">
                        「{f.label || '伏笔'}」回收章已完稿
                      </span>
                      <button
                        className="btn btn-mini"
                        onClick={async () => {
                          try {
                            await api.setForeshadowStatus(f.edgeId, 1);
                            await refreshStoryCtx();
                            window.dispatchEvent(new Event('nf:story-updated'));
                            showToast('已标记为已回收');
                          } catch (e) {
                            showToast(String(e), 'error');
                          }
                        }}
                      >
                        标记回收
                      </button>
                    </div>
                  ))}
              </div>
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

      {showProjectOutline && (
        <OutlineModal
          title="全书大纲"
          hint="主线 / 设定 / 梗概"
          initial={tree.info.outline}
          onClose={() => setShowProjectOutline(false)}
          onSave={async (text) => {
            try {
              await api.updateProjectOutline(text);
              await refreshTree();
              showToast('全书大纲已保存');
            } catch (e) {
              showToast(String(e), 'error');
            }
          }}
        />
      )}
    </aside>
  );
}
