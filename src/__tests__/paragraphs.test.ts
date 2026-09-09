import { describe, it, expect } from 'vitest';
import { splitActiveParagraph } from '../utils/paragraphs';

describe('splitActiveParagraph 专注模式段落定位（审查 UX-1）', () => {
  it('光标在第二段时激活下标为 1，而非视觉行', () => {
    const content = '第一段\n第二段内容\n第三段';
    // 光标落在「第二段内容」的第 3 个字：第一段 3 字 + 换行 = 4，再加 3 = 7
    const r = splitActiveParagraph(content, 7);
    expect(r.activeIdx).toBe(1);
    expect(r.caretOff).toBe(3);
    expect(r.paras).toHaveLength(3);
  });

  it('一段超长中文（自动折行但无换行符）仍是同一段', () => {
    const long = '中'.repeat(500);
    const content = `首段\n${long}`;
    // 光标在长段末尾，不应被识别成多段
    const r = splitActiveParagraph(content, content.length);
    expect(r.paras).toHaveLength(2);
    expect(r.activeIdx).toBe(1);
    expect(r.caretOff).toBe(500);
  });

  it('空内容安全返回单段', () => {
    const r = splitActiveParagraph('', 0);
    expect(r.paras).toEqual(['']);
    expect(r.activeIdx).toBe(0);
    expect(r.caretOff).toBe(0);
  });

  it('光标恰在换行符边界归属下一段起点', () => {
    const r = splitActiveParagraph('ab\ncd', 3);
    expect(r.activeIdx).toBe(1);
    expect(r.caretOff).toBe(0);
  });
});
