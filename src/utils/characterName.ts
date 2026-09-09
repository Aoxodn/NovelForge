/** Keep blank cards unique without renaming existing characters. */
export function nextCharacterName(
  characters: ReadonlyArray<{ name: string }>,
): string {
  const names = new Set(characters.map((c) => c.name));
  if (!names.has('新角色')) return '新角色';
  let suffix = 2;
  while (names.has(`新角色 ${suffix}`)) suffix += 1;
  return `新角色 ${suffix}`;
}
