/**
 * 中间编辑器（文档第十三、十四节）：纯文本写作模式。
 * - 章节标题行内编辑
 * - 自动保存（500ms 防抖 + 5 分钟快照，见 useAutoSave）
 * - Ctrl+S 手动保存并快照
 * - Tab 插入全角缩进，中文写作友好
 * - 字体 / 字号 / 行距可调（护眼优化）
 */
import { useEffect, useMemo, useRef } from 'react';
import { useAppStore } from '../store/appStore';
import { useEditorStore } from '../store/editorStore';
import { useAutoSave } from '../hooks/useAutoSave';
import { countParagraphs, countText, fmt, readingMinutes } from '../utils/text';

export function ChapterEditor() {
  const editorSettings = useAppStore((s) => s.editorSettings);
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

  useAutoSave();

  // 切换章节时滚动条回到顶部（DOM 复用会保留上一章的滚动位置）
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
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
      });
    }
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
        </div>
      </div>

      <div className="editor-scroll" ref={scrollRef}>
        <div className="editor-page">
          <textarea
            className="editor-textarea"
            value={content}
            onChange={(e) => setContent(e.target.value)}
            onKeyDown={onKeyDown}
            spellCheck={false}
            placeholder="落笔即焚稿，写下第一行……"
            style={{
              fontFamily: editorSettings.fontFamily,
              fontSize: editorSettings.fontSize,
              lineHeight: editorSettings.lineHeight,
            }}
          />
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
