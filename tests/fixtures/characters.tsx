/** Isolated UI fixture. All IPC is in-memory; never opens a user's project. */
import React from 'react';
import { createRoot } from 'react-dom/client';
import { mockIPC } from '@tauri-apps/api/mocks';
import { CharacterCardView } from '../../src/components/CharacterCardView';
import type {
  CharacterProfile,
  CharacterRelation,
} from '../../src/types/models';
import '../../src/styles/global.css';

const params = new URLSearchParams(location.search);
document.documentElement.dataset.theme = params.get('theme') || 'sepia';
const count = Number(params.get('count') ?? 240);
const roles = ['主角', '配角', '反派', '龙套'];
const names = ['沈照夜', '陆行舟', '温知微', '顾长风', '许青禾'];
let characters: CharacterProfile[] = Array.from({ length: count }, (_, i) => ({
  id: i + 1,
  name: names[i] ?? `角色 ${String(i + 1).padStart(3, '0')}`,
  aliases: i === 0 ? ['照夜', '小沈'] : [],
  role: roles[i % 4],
  notes:
    i === 0
      ? '她记得城里每一扇门，却找不到回家的路。\n\n外貌：总穿一件洗得发白的青衫，袖口藏着旧伤。\n性格：不轻易许诺，一旦答应便绝不回头。\n核心欲望：查清父亲失踪的真相。\n内在矛盾：渴望信任，却习惯独自承担。'
      : '',
  faction: i === 0 ? '听雨楼' : '',
  alive: true,
  importance: i === 0 ? 3 : 1,
  isPov: i === 0,
  tags: i === 0 ? ['寻亲', '剑客', '秘密'] : [],
  customFields: {},
  totalMentions: i === 0 ? 128 : i % 10,
  chapterCount: i === 0 ? 12 : 2,
  firstChapterId: 1,
  firstChapterTitle: '第一章 · 雨夜来客',
  lastChapterId: 12,
  lastChapterTitle: '第十二章 · 故人重逢',
  mapX: null,
  mapY: null,
  excludeWords: [],
  sortOrder: 0,
}));
let relations: CharacterRelation[] = [];
let nextId = count + 1;
mockIPC(async (command, payload) => {
  const args = payload as Record<string, any>;
  switch (command) {
    case 'list_characters':
      return structuredClone(characters);
    case 'get_alias_conflicts':
      return [];
    case 'list_all_character_relations':
      return structuredClone(relations);
    case 'get_character_heat':
      return {
        characterId: args.characterId,
        name: '',
        perChapter: [2, 8, 4, 0, 12, 3, 9, 2, 0, 1, 14, 4],
        absentStreak: 0,
      };
    case 'add_character': {
      if (characters.some((c) => c.name === args.name))
        throw new Error('人物已存在');
      const c = {
        ...characters[0],
        id: nextId++,
        name: args.name,
        role: '配角',
        notes: '',
        aliases: [],
        tags: [],
        customFields: {},
        faction: '',
        importance: 1,
        isPov: false,
        totalMentions: 0,
        chapterCount: 0,
      } as CharacterProfile;
      characters.push(c);
      return structuredClone(c);
    }
    case 'update_character': {
      const c = characters.find((c) => c.id === args.characterId);
      if (!c) throw new Error('人物不存在');
      if (
        characters.some(
          (other) => other.id !== c.id && other.name === args.name,
        )
      )
        throw new Error('人物名字已存在');
      Object.assign(
        c,
        {
          name: args.name,
          aliases: args.aliases,
          role: args.role,
          notes: args.notes,
        },
        args.meta,
      );
      return null;
    }
    case 'delete_character':
      characters = characters.filter((c) => c.id !== args.characterId);
      return null;
    case 'create_character_relation':
      relations.push({
        ...args,
        id: relations.length + 1,
        createdAt: '',
      } as CharacterRelation);
      return relations.length;
    case 'delete_character_relation':
      relations = relations.filter((r) => r.id !== args.relationId);
      return null;
    default:
      throw new Error(`Unexpected fixture command: ${command}`);
  }
});

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <div className="project-view">
      <header
        style={{
          flexShrink: 0,
          padding: '14px 24px',
          borderBottom: '1px solid var(--border)',
          background: 'var(--bg-panel)',
          fontWeight: 600,
        }}
      >
        NovelForge{' '}
        <span
          style={{ marginLeft: 36, color: 'var(--text-dim)', fontWeight: 400 }}
        >
          《长夜听雨》 / 角色工作台
        </span>
      </header>
      <div className="story-view">
        <CharacterCardView />
      </div>
      <footer
        style={{
          flexShrink: 0,
          padding: '6px 20px',
          borderTop: '1px solid var(--border)',
          background: 'var(--bg-panel)',
          fontSize: 11,
          color: 'var(--text-dim)',
        }}
      >
        界面回归 · 模拟数据 · 不连接真实项目
      </footer>
    </div>
  </React.StrictMode>,
);
