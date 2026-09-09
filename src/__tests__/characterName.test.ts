import { describe, expect, it } from 'vitest';
import { nextCharacterName } from '../utils/characterName';

describe('blank character names', () => {
  it('creates multiple cards without renaming existing ones', () => {
    const cards: { name: string }[] = [];
    for (let i = 0; i < 100; i++)
      cards.push({ name: nextCharacterName(cards) });
    expect(new Set(cards.map((c) => c.name)).size).toBe(100);
    expect(cards[0].name).toBe('新角色');
    expect(cards[1].name).toBe('新角色 2');
  });
  it('uses the first available name, respecting user-entered numbered names', () => {
    expect(
      nextCharacterName([
        { name: '新角色' },
        { name: '新角色 2' },
        { name: '新角色 4' },
      ]),
    ).toBe('新角色 3');
  });
});
