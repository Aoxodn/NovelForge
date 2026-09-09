/**
 * 全文搜索面板（文档第四十二节）：
 * 输入防抖 350ms → 后台线程全书扫描 → 结果列表（章节 + 高亮片段）
 * → 点击跳转章节。支持普通文本 / 正则两种模式。
 */
import { useEffect, useRef, useState } from 'react';
import * as api from '../api';
import { useAppStore } from '../store/appStore';
import { useEditorStore } from '../store/editorStore';
import type { SearchHit } from '../types/models';
import { IconSearch } from './icons';
import { RequestSeq } from '../utils/RequestSeq';

export function SearchPanel({ onClose }: { onClose: () => void }) {
  const showToast = useAppStore((s) => s.showToast);
  const selectChapter = useAppStore((s) => s.selectChapter);

  const [query, setQuery] = useState('');
  const [useRegex, setUseRegex] = useState(false);
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [searching, setSearching] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  // 请求序号：丢弃迟到的旧查询结果，避免后发先至覆盖新结果（审查 P1-6）
  const reqSeq = useRef(new RequestSeq());

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // 防抖搜索
  useEffect(() => {
    const q = query.trim();
    if (!q) {
      reqSeq.current.invalidate();
      setHits(null);
      setSearching(false);
      return;
    }
    setSearching(true);
    const mySeq = reqSeq.current.next();
    const timer = setTimeout(async () => {
      try {
        const res = await api.searchProject(q, useRegex);
        if (!reqSeq.current.isLatest(mySeq)) return; // 只接受最新请求
        setHits(res);
      } catch (e) {
        if (!reqSeq.current.isLatest(mySeq)) return;
        showToast(String(e), 'error');
        setHits([]);
      } finally {
        if (reqSeq.current.isLatest(mySeq)) setSearching(false);
      }
    }, 350);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, useRegex]);

  const jumpTo = async (chapterId: number) => {
    const ok = await useEditorStore.getState().loadChapter(chapterId);
    if (!ok) return;
    selectChapter(chapterId);
    onClose();
  };

  return (
    <div className="search-panel">
      <div className="search-box">
        <IconSearch size={15} />
        <input
          ref={inputRef}
          className="search-input"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') onClose();
            if (e.key === 'Enter' && hits && hits.length > 0) {
              jumpTo(hits[0].chapterId);
            }
          }}
          placeholder="搜索全书内容…（Enter 跳到第一个结果）"
          spellCheck={false}
        />
        <button
          className={`chip chip-mini${useRegex ? ' active' : ''}`}
          onClick={() => setUseRegex(!useRegex)}
          title="切换正则模式"
        >
          .*
        </button>
        <button className="icon-btn" onClick={onClose} title="关闭 (Esc)">
          ✕
        </button>
      </div>

      <div className="search-results">
        {searching && <div className="search-empty">搜索中…</div>}
        {!searching && hits !== null && hits.length === 0 && (
          <div className="search-empty">没有找到「{query.trim()}」</div>
        )}
        {!searching &&
          hits?.map((h) => (
            <button key={h.chapterId} className="search-hit" onClick={() => jumpTo(h.chapterId)}>
              <div className="search-hit-meta">
                <span className="search-hit-title">{h.chapterTitle}</span>
                <span className="search-hit-volume">{h.volumeTitle}</span>
                <span className="search-hit-count">{h.matchCount} 处</span>
              </div>
              <div className="search-hit-snippet">
                {h.snippetBefore}
                <mark>{h.snippetMatch}</mark>
                {h.snippetAfter}
              </div>
            </button>
          ))}
        {!searching && hits !== null && hits.length >= 300 && (
          <div className="search-truncated">结果过多，仅显示前 300 个章节</div>
        )}
      </div>
    </div>
  );
}
