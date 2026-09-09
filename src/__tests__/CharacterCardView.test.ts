// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CharacterProfile } from '../types/models';

vi.mock('../api', () => ({
  listCharacters: vi.fn(),
  addCharacter: vi.fn(),
  deleteCharacter: vi.fn(),
  updateCharacter: vi.fn(),
  getAliasConflicts: vi.fn().mockResolvedValue([]),
  listAllCharacterRelations: vi.fn().mockResolvedValue([]),
  getCharacterHeat: vi
    .fn()
    .mockResolvedValue({ perChapter: [], absentStreak: 0 }),
}));
vi.mock('../components/tools/RenameCharacterModal', () => ({
  RenameCharacterModal: () => null,
}));
vi.mock('../components/tools/CharacterArcModal', () => ({
  CharacterArcModal: () => null,
}));
import * as api from '../api';
import { CharacterCardView } from '../components/CharacterCardView';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root;
let container: HTMLDivElement;
let cards: CharacterProfile[];
const card = (id: number, name: string): CharacterProfile => ({
  id,
  name,
  aliases: [],
  role: '配角',
  notes: '',
  faction: '',
  alive: null,
  importance: 1,
  isPov: false,
  tags: [],
  customFields: {},
  totalMentions: 0,
  chapterCount: 0,
  firstChapterId: null,
  firstChapterTitle: null,
  lastChapterId: null,
  lastChapterTitle: null,
  mapX: null,
  mapY: null,
  excludeWords: [],
  sortOrder: 0,
});
async function click(text: string) {
  const button = [...container.querySelectorAll('button')].find(
    (b) => b.textContent?.trim() === text,
  );
  expect(button, `button: ${text}`).toBeTruthy();
  await act(async () => button!.click());
}
async function input(label: string, value: string) {
  const el = container.querySelector<HTMLInputElement>(
    `input[aria-label="${label}"]`,
  )!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )!.set!.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
  HTMLElement.prototype.scrollTo = vi.fn();
  cards = [card(1, '新角色')];
  vi.mocked(api.listCharacters).mockImplementation(async () =>
    structuredClone(cards),
  );
  vi.mocked(api.addCharacter).mockImplementation(async (name) => {
    if (cards.some((c) => c.name === name)) throw new Error('角色已存在');
    const created = card(cards.length + 1, name);
    cards.push(created);
    return structuredClone(created);
  });
  vi.mocked(api.updateCharacter).mockImplementation(async (id, patch) => {
    const c = cards.find((c) => c.id === id);
    if (!c) throw new Error('not found');
    Object.assign(c, patch);
  });
  vi.mocked(api.deleteCharacter).mockImplementation(async (id) => {
    cards = cards.filter((c) => c.id !== id);
  });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
const mount = () =>
  act(async () => root.render(createElement(CharacterCardView)));

describe('character workspace', () => {
  it('creates a second and third card, clearing search/filter and selecting the new name', async () => {
    await mount();
    await click('主角');
    await input('搜索角色', '不匹配');
    await click('+ 新建角色');
    expect(cards.map((c) => c.name)).toEqual(['新角色', '新角色 2']);
    expect(
      container.querySelector<HTMLInputElement>('[aria-label="角色姓名"]')!
        .value,
    ).toBe('新角色 2');
    expect(
      container.querySelector<HTMLInputElement>('[aria-label="搜索角色"]')!
        .value,
    ).toBe('');
    expect(document.activeElement?.getAttribute('aria-label')).toBe('角色姓名');
    await click('+ 新建角色');
    expect(cards.map((c) => c.name)).toEqual([
      '新角色',
      '新角色 2',
      '新角色 3',
    ]);
  });

  it('shows creation errors instead of silently ignoring a rejected command', async () => {
    await mount();
    vi.mocked(api.addCharacter).mockRejectedValueOnce(
      new Error('磁盘空间不足'),
    );
    await click('+ 新建角色');
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      '磁盘空间不足',
    );
    expect(cards).toHaveLength(1);
  });

  it('coalesces rapid create clicks while a request is pending', async () => {
    await mount();
    const button = [...container.querySelectorAll('button')].find(
      (b) => b.textContent === '+ 新建角色',
    )!;
    await act(async () => {
      button.click();
      button.click();
      button.click();
    });
    expect(api.addCharacter).toHaveBeenCalledTimes(1);
    expect(cards).toHaveLength(2);
  });

  it('shows an empty-name error and keeps the draft without switching', async () => {
    await mount();
    await input('角色姓名', '   ');
    await click('+ 新建角色');
    expect(api.updateCharacter).not.toHaveBeenCalled();
    expect(api.addCharacter).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      '请填写角色姓名',
    );
  });

  it('does not silently overwrite duplicate custom fields', async () => {
    await mount();
    await click('+ 添加');
    await input('自定义字段 1 名称', '武器');
    await input('自定义字段 1 内容', '剑');
    await click('+ 添加');
    await input('自定义字段 2 名称', '武器');
    await input('自定义字段 2 内容', '弓');
    await click('保存');
    expect(api.updateCharacter).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      '重名',
    );
  });

  it('allows retrying a failed initial load', async () => {
    vi.mocked(api.listCharacters).mockRejectedValueOnce(new Error('读取失败'));
    await mount();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      '读取失败',
    );
    await click('重新加载');
    expect(
      container.querySelector<HTMLInputElement>('[aria-label="角色姓名"]')!
        .value,
    ).toBe('新角色');
  });

  it('blocks switching and creating when current draft cannot save, then supports retry', async () => {
    cards.push(card(2, '林舟'));
    await mount();
    await input('角色姓名', '未保存的名字');
    vi.mocked(api.updateCharacter).mockRejectedValue(new Error('locked'));
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[title="林舟"]')!.click(),
    );
    expect(
      container.querySelector<HTMLInputElement>('[aria-label="角色姓名"]')!
        .value,
    ).toBe('未保存的名字');
    await click('+ 新建角色');
    expect(api.addCharacter).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'locked',
    );
    vi.mocked(api.updateCharacter).mockResolvedValue(undefined);
    await click('重试');
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[title="林舟"]')!.click(),
    );
    expect(
      container.querySelector<HTMLInputElement>('[aria-label="角色姓名"]')!
        .value,
    ).toBe('林舟');
  });

  it('deleting a saved card does not attempt to save the deleted entity on switch', async () => {
    cards.push(card(2, '林舟'));
    vi.stubGlobal('confirm', () => true);
    await mount();
    await input('角色姓名', '更新名字');
    await click('删除角色');
    expect(api.updateCharacter).toHaveBeenCalledTimes(1);
    expect(api.deleteCharacter).toHaveBeenCalledWith(1);
    expect(
      container.querySelector<HTMLInputElement>('[aria-label="角色姓名"]')!
        .value,
    ).toBe('林舟');
  });

  it('resets relationship target when selecting another character', async () => {
    cards.push(card(2, '林舟'));
    await mount();
    await click('出场与关系');
    const target =
      container.querySelector<HTMLSelectElement>('.rel-add select')!;
    await act(async () => {
      target.value = '2';
      target.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[title="林舟"]')!.click(),
    );
    expect(
      container.querySelector<HTMLSelectElement>('.rel-add select')!.value,
    ).toBe('');
  });
});
