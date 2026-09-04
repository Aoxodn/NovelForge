import { invoke } from '@tauri-apps/api/core';

/**
 * Tauri command 调用封装。
 * 所有后端交互必须经过此层，组件不得直接 invoke ——
 * 保证「UI 与数据访问」分离，便于后续替换/测试。
 */
export async function cmd<T>(name: string, args?: Record<string, unknown>): Promise<T> {
  return invoke<T>(name, args);
}
