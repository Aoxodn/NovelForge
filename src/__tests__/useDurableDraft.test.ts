// @vitest-environment jsdom
import { act, createElement, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useDurableDraft, type DurableDraft } from '../hooks/useDurableDraft';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root;
let draft: DurableDraft<{ notes: string }>;
let save: ReturnType<
  typeof vi.fn<(id: number, value: { notes: string }) => Promise<void>>
>;

function Harness({ id }: { id: number }) {
  draft = useDurableDraft(id, { notes: `角色 ${id}` }, save, 800);
  useEffect(() => draft.reset({ notes: `角色 ${id}` }), [id]);
  return null;
}
async function select(id: number) {
  await act(async () => root.render(createElement(Harness, { id })));
}
function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
beforeEach(() => {
  vi.useFakeTimers();
  save = vi.fn().mockResolvedValue(undefined);
  root = createRoot(document.createElement('div'));
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.useRealTimers();
});

describe('useDurableDraft entity isolation', () => {
  it('does not save untouched cards when switching or unmounting', async () => {
    await select(1);
    await select(2);
    expect(save).not.toHaveBeenCalled();
  });

  it('flush joins autosave and drains edits made during the first request', async () => {
    const first = deferred();
    save.mockReturnValueOnce(first.promise);
    await select(1);
    await act(async () => draft.setDraft({ notes: 'first' }));
    await act(async () => vi.advanceTimersByTimeAsync(800));
    expect(save).toHaveBeenCalledTimes(1);
    let flushing!: Promise<boolean>;
    await act(async () => {
      draft.setDraft({ notes: 'latest' });
      flushing = draft.flush();
    });
    expect(save).toHaveBeenCalledTimes(1);
    await act(async () => {
      first.resolve();
      await flushing;
    });
    expect(save.mock.calls).toEqual([
      [1, { notes: 'first' }],
      [1, { notes: 'latest' }],
    ]);
    expect(draft.dirty).toBe(false);
  });

  it('late save of A cannot save B draft under A id or mark B clean', async () => {
    const first = deferred();
    save.mockReturnValueOnce(first.promise);
    await select(1);
    await act(async () => draft.setDraft({ notes: 'A draft' }));
    await act(async () => vi.advanceTimersByTimeAsync(800));
    await select(2);
    await act(async () => draft.setDraft({ notes: 'B draft' }));
    await act(async () => first.resolve());
    expect(save.mock.calls).toEqual([[1, { notes: 'A draft' }]]);
    expect(draft.draft.notes).toBe('B draft');
    expect(draft.dirty).toBe(true);
    await act(async () => {
      await draft.flush();
    });
    expect(save.mock.calls[1]).toEqual([2, { notes: 'B draft' }]);
  });

  it('retains failed drafts on revisit instead of resetting to database data', async () => {
    const first = deferred();
    save.mockReturnValueOnce(first.promise);
    await select(1);
    await act(async () => draft.setDraft({ notes: '保留我' }));
    await select(2);
    await act(async () => first.reject(new Error('disk full')));
    expect(draft.error).toBe(null);
    await select(1);
    expect(draft.draft.notes).toBe('保留我');
    expect(draft.error).toContain('disk full');
    expect(draft.dirty).toBe(true);
    await act(async () => {
      expect(await draft.retry()).toBe(true);
    });
    expect(draft.error).toBe(null);
  });

  it('flush returns false on failure and keeps the current content for retry', async () => {
    save.mockRejectedValueOnce(new Error('locked'));
    await select(1);
    await act(async () => draft.setDraft({ notes: 'unsaved' }));
    await act(async () => {
      expect(await draft.flush()).toBe(false);
    });
    expect(draft.dirty).toBe(true);
    expect(draft.error).toContain('locked');
    await act(async () => vi.advanceTimersByTimeAsync(5000));
    expect(save).toHaveBeenCalledTimes(1);
    await act(async () => {
      await draft.retry();
    });
    expect(draft.dirty).toBe(false);
  });
});
