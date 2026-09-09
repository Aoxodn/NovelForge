import { describe, it, expect, beforeEach, vi } from 'vitest';

// mock 后端 API 与 appStore，单测只验证保存队列逻辑（审查 P0-1）
vi.mock('../api', () => ({
  saveChapter: vi.fn(),
  getChapter: vi.fn(),
  setChapterStatus: vi.fn(),
}));
vi.mock('../store/appStore', () => ({
  useAppStore: {
    getState: () => ({
      showToast: vi.fn(),
      setTodayWords: vi.fn(),
      refreshTree: vi.fn(),
    }),
  },
}));

import * as api from '../api';
import { useEditorStore as store } from '../store/editorStore';

const saveChapter = api.saveChapter as unknown as ReturnType<typeof vi.fn>;
const getChapter = api.getChapter as unknown as ReturnType<typeof vi.fn>;

/** 可控的 deferred promise */
function deferred() {
  let resolve!: (v: unknown) => void;
  let reject!: (e: unknown) => void;
  const p = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { p, resolve, reject };
}

const okSave = { savedAt: 't', wordCount: 1, charCount: 1, snapshotCreated: false, todayWords: 0 };

beforeEach(() => {
  vi.clearAllMocks();
  store.getState().clear();
  // 准备一个已加载、有未保存修改的章节
  store.setState({ chapterId: 1, volumeId: 1, title: '标题', content: 'a', dirty: true });
});

describe('editorStore 串行保存队列（审查 P0-1）', () => {
  it('保存期间继续输入，第一轮结束后用最新内容再存一次', async () => {
    const d1 = deferred();
    const d2 = deferred();
    saveChapter.mockReturnValueOnce(d1.p).mockReturnValueOnce(d2.p);

    // 第一次保存（在途）
    const p1 = store.getState().save(false);
    expect(store.getState().saving).toBe(true);

    // 保存期间用户继续输入 → 登记待追存
    store.getState().setContent('ab');
    expect(store.getState().savePending).toBe(true);

    // 第一轮结束（其结果已被后续输入覆盖，dirty 保留）
    d1.resolve(okSave);
    // 推进微任务队列，让串行循环发起第二轮
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // 应当已经发起第二轮，且内容是最新的 'ab'
    expect(saveChapter).toHaveBeenCalledTimes(2);
    expect(saveChapter.mock.calls[1][2]).toBe('ab');

    d2.resolve(okSave);
    await p1;
    expect(store.getState().saving).toBe(false);
    expect(store.getState().dirty).toBe(false);
  });

  it('保存失败必须 reject 且保留 dirty，不丢字', async () => {
    const d = deferred();
    saveChapter.mockReturnValue(d.p);
    const p = store.getState().save(false);
    d.reject(new Error('disk full'));
    await expect(p).rejects.toBeTruthy();
    expect(store.getState().saving).toBe(false);
    expect(store.getState().dirty).toBe(true);
    expect(store.getState().saveError).toContain('disk full');
  });

  it('无修改时 save 返回 noop，不发起请求', async () => {
    store.setState({ dirty: false });
    const r = await store.getState().save(false);
    expect(r).toBe('noop');
    expect(saveChapter).not.toHaveBeenCalled();
  });
});

describe('loadChapter 切章保护（审查 P0-1）', () => {
  it('切章前保存失败则中止切换，不加载目标章', async () => {
    store.setState({ dirty: true, content: '未保存' });
    saveChapter.mockRejectedValueOnce(new Error('locked'));
    const ok = await store.getState().loadChapter(2);
    expect(ok).toBe(false);
    expect(getChapter).not.toHaveBeenCalled();
    // 仍停留在原章
    expect(store.getState().chapterId).toBe(1);
  });

  it('skipPreSave=true 时丢弃内存旧内容直接以库为准（恢复历史版本）', async () => {
    store.setState({ dirty: true, content: '内存旧内容' });
    getChapter.mockResolvedValueOnce({
      id: 3,
      volumeId: 1,
      title: '三',
      content: '库内版本',
      status: 0,
      wordCount: 4,
      charCount: 4,
      updatedAt: 't',
    });
    const ok = await store.getState().loadChapter(3, true);
    expect(ok).toBe(true);
    expect(saveChapter).not.toHaveBeenCalled();
    expect(store.getState().content).toBe('库内版本');
  });
});
