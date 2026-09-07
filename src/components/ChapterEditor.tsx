/**
 * 中间编辑器（文档第十三、十四节）：纯文本写作模式。
 * - 章节标题行内编辑
 * - 自动保存（500ms 防抖 + 5 分钟快照，见 useAutoSave）
 * - Ctrl+S 手动保存并快照
 * - Tab 插入全角缩进，中文写作友好
 * - 字体 / 字号 / 行距可调（护眼优化）
 * - 一键复制本章正文（段首缩进 / 无缩进），贴文平台专用
 * - 专注模式（0.7.1 重做）：打字机滚动 + 当前段高亮、其余淡化
 *   （textarea 文字透明，底层镜像层负责渲染与光标定位测量）
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { writeText as writeClipboard } from '@tauri-apps/plugin-clipboard-manager';
import { useAppStore } from '../store/appStore';
import { useEditorStore } from '../store/editorStore';
import { useAutoSave } from '../hooks/useAutoSave';
import { countParagraphs, countText, fmt, readingMinutes } from '../utils/text';
import { IconCopyChapter } from './icons';

/** 写入剪贴板；非 Tauri 环境（浏览器预览）回退到 Web Clipboard API */
async function copyToClipboard(text: string): Promise<void> {
  try {
    await writeClipboard(text);
  } catch {
    await navigator.clipboard.writeText(text);
  }
}

/** 光标在垂直视口中的停留位置（越靠上阅读视线越稳） */
const CARET_Y_RATIO = 0.42;

export function ChapterEditor() {
  const editorSettings = useAppStore((s) => s.editorSettings);
  const focusMode = useAppStore((s) => s.focusMode);
  const tree = useAppStore((s) => s.tree)!;
  const selectedChapterId = useAppStore((s) => s.selectedChapterId);

  const chapterId = useEditorStore((s) => s.chapterId);
  const title = useEditorStore((s) => s.title);
  const content = useEditorStore((s) => s.content);
  const dirty = useEditorStore((s) => s.dirty);
  const saving = useEditorStore((s) => s.saving);
  const saveError = useEditorStore((s) => s.saveError);
  const setTitle = useEditorStore((s) => s.setTitle);
  const setContent = useEditorStore((s) => s.setContent);
  const save = useEditorStore((s) => s.save);

  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const mirrorRef = useRef<HTMLDivElement>(null);
  const copyWrapRef = useRef<HTMLDivElement>(null);
  const [copyMenuOpen, setCopyMenuOpen] = useState(false);
  const [caret, setCaret] = useState(0);

  useAutoSave();

  /** 复制本章正文到剪贴板：indent=true 时每段前置两个全角空格（贴文标准排版） */
  const copyChapter = async (indent: boolean) => {
    setCopyMenuOpen(false);
    const text = content
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
      .map((l) => (indent ? `　　${l}` : l))
      .join('\n');
    if (!text) {
      useAppStore.getState().showToast('本章还没有正文可复制');
      return;
    }
    try {
      await copyToClipboard(text);
      useAppStore.getState().showToast(`已复制本章正文（${indent ? '段首缩进' : '无缩进'}）`);
    } catch {
      useAppStore.getState().showToast('复制失败，请重试', 'error');
    }
  };

  // 点击菜单外任意处关闭复制菜单
  useEffect(() => {
    if (!copyMenuOpen) return;
    const h = (e: MouseEvent) => {
      if (!copyWrapRef.current?.contains(e.target as Node)) setCopyMenuOpen(false);
    };
    window.addEventListener('mousedown', h);
    return () => window.removeEventListener('mousedown', h);
  }, [copyMenuOpen]);

  // 切换章节时滚动条回到顶部（DOM 复用会保留上一章的滚动位置）
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
    setCaret(0);
  }, [chapterId]);

  // 实时统计：输入即算（口径与 Rust 一致），保存后由后端权威字数校准
  const stats = useMemo(() => {
    const { words } = countText(content);
    return {
      words,
      paragraphs: countParagraphs(content),
      minutes: readingMinutes(words),
    };
  }, [content]);

  // 当前章所在卷名
  const volumeTitle = useMemo(() => {
    const v = tree.volumes.find((x) => x.id === useEditorStore.getState().volumeId);
    return v?.title ?? '';
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chapterId, tree]);

  // ---------- 专注模式：镜像层 ----------

  // 按光标位置切分段落：返回每段的起止与激活段下标
  const { paras, activeIdx, caretOff } = useMemo(() => {
    const list = content.split('\n');
    let acc = 0;
    let idx = list.length - 1;
    let off = list[list.length - 1]?.length ?? 0;
    for (let i = 0; i < list.length; i++) {
      const start = acc;
      const end = acc + list[i].length;
      if (caret >= start && caret <= end) {
        idx = i;
        off = caret - start;
        break;
      }
      acc = end + 1; // +1 为换行符
    }
    return { paras: list, activeIdx: idx, caretOff: off };
  }, [content, caret]);

  // 镜像层内容：激活段高亮、其余淡化，光标处插入探针（用于测量垂直位置）
  const mirrorNodes = useMemo(() => {
    const nodes: React.ReactNode[] = [];
    for (let i = 0; i < paras.length; i++) {
      if (i === activeIdx) {
        nodes.push(
          <mark key={i} className="para-active">
            {paras[i].slice(0, caretOff)}
            <span className="caret-probe" />
            {paras[i].slice(caretOff)}
          </mark>,
        );
      } else {
        nodes.push(
          <span key={i} className="para-dim">
            {paras[i]}
          </span>,
        );
      }
      if (i < paras.length - 1) nodes.push('\n');
    }
    return nodes;
  }, [paras, activeIdx, caretOff]);

  // 打字机滚动：把探针行固定在视口 42% 高度处；滚动时同步镜像层位移。
  // 注意：正文滚动发生在 textarea 内部（编辑器页高 100%），镜像层必须跟随其 scrollTop。
  const syncMirror = () => {
    if (!focusMode) return;
    const mirror = mirrorRef.current;
    const ta = textareaRef.current;
    if (!mirror || !ta) return;
    const inner = mirror.firstElementChild as HTMLElement | null;
    if (inner) inner.style.transform = `translateY(${-ta.scrollTop}px)`;
  };

  useLayoutEffect(() => {
    if (!focusMode) return;
    const ta = textareaRef.current;
    const mirror = mirrorRef.current;
    if (!ta || !mirror) return;
    syncMirror();
    const probe = mirror.querySelector<HTMLElement>('.caret-probe');
    if (probe) {
      const target = Math.max(
        0,
        Math.min(
          probe.offsetTop - ta.clientHeight * CARET_Y_RATIO,
          ta.scrollHeight - ta.clientHeight,
        ),
      );
      if (Math.abs(ta.scrollTop - target) > 2) ta.scrollTop = target;
    }
  }, [content, caret, focusMode, editorSettings, chapterId]);

  if (chapterId === null || selectedChapterId === null) {
    return (
      <section className="editor">
        <div className="editor-empty">
          <div className="editor-empty-icon">✍</div>
          <p>{tree.chapters.length === 0 ? '从左侧或 Ctrl+N 新建第一章，开始创作' : '在左侧目录中选择一章开始写作'}</p>
        </div>
      </section>
    );
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Ctrl+S：手动保存并创建快照
    if (e.ctrlKey && e.key.toLowerCase() === 's') {
      e.preventDefault();
      void save(true);
      return;
    }
    // Tab：插入两个全角空格（中文段首缩进习惯）
    if (e.key === 'Tab') {
      e.preventDefault();
      const el = e.currentTarget;
      const start = el.selectionStart;
      const end = el.selectionEnd;
      const next = content.slice(0, start) + '　　' + content.slice(end);
      setContent(next);
      // 下一帧恢复光标位置
      requestAnimationFrame(() => {
        el.selectionStart = el.selectionEnd = start + 2;
        setCaret(start + 2);
      });
    }
  };

  const fontStyles = {
    fontFamily: editorSettings.fontFamily,
    fontSize: editorSettings.fontSize,
    lineHeight: editorSettings.lineHeight,
  };

  return (
    <section className="editor">
      <div className="editor-header">
        <input
          className="editor-title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="章节标题"
          spellCheck={false}
        />
        <div className="editor-header-meta">
          {volumeTitle && <span className="editor-volume">{volumeTitle}</span>}
          <span className={`save-state${saveError ? ' error' : ''}`}>
            {saveError
              ? `保存失败：${saveError}`
              : saving
                ? '保存中…'
                : dirty
                  ? '未保存（自动保存中）'
                  : '已保存'}
          </span>
          <div className="copy-menu-wrap" ref={copyWrapRef}>
            <button
              className="btn btn-mini btn-ghost"
              onClick={() => setCopyMenuOpen((v) => !v)}
              title="复制本章正文到剪贴板（贴文用）"
            >
              <IconCopyChapter /> 复制本章
            </button>
            {copyMenuOpen && (
              <div className="copy-menu">
                <button className="menu-item" onClick={() => void copyChapter(true)}>
                  段首缩进（贴文标准）
                </button>
                <button className="menu-item" onClick={() => void copyChapter(false)}>
                  无缩进（原文）
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="editor-scroll" ref={scrollRef}>
        <div className="editor-page">
          <div className={`editor-text-wrap${focusMode ? ' focus' : ''}`}>
            {focusMode && (
              <div className="editor-mirror" ref={mirrorRef} aria-hidden style={fontStyles}>
                <div className="editor-mirror-inner">{mirrorNodes}</div>
              </div>
            )}
            <textarea
              ref={textareaRef}
              className="editor-textarea"
              onScroll={syncMirror}
              value={content}
              onChange={(e) => {
                setContent(e.target.value);
                setCaret(e.target.selectionStart);
              }}
              onKeyDown={onKeyDown}
              onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
              onClick={(e) => setCaret(e.currentTarget.selectionStart)}
              onKeyUp={(e) => setCaret(e.currentTarget.selectionStart)}
              spellCheck={false}
              placeholder="落笔即焚稿，写下第一行……"
              style={fontStyles}
            />
          </div>
        </div>
      </div>

      <div className="editor-statsbar">
        <span>{fmt(stats.words)} 字</span>
        <span>{stats.paragraphs} 段</span>
        <span>约 {stats.minutes} 分钟阅读</span>
      </div>
    </section>
  );
}
