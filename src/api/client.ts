import { invoke } from '@tauri-apps/api/core';

/**
 * Tauri command 调用封装。
 * 所有后端交互必须经过此层，组件不得直接 invoke ——
 * 保证「UI 与数据访问」分离，便于后续替换/测试。
 *
 * 后端 AppError 序列化为结构化对象 { code, message, retryable }（审查 P2-3）；
 * 这里统一归一化为 NfError（仍是 Error 子类，String(e) 直接得到可读 message，
 * 旧代码无需改动），并额外携带 code / retryable 供需要区分处理的调用方使用。
 */
export class NfError extends Error {
  code: string;
  retryable: boolean;
  constructor(message: string, code: string, retryable: boolean) {
    super(message);
    this.name = 'NfError';
    this.code = code;
    this.retryable = retryable;
  }
  // 让 String(e) / 模板字符串直接得到可读文案，而不是 "NfError: xxx"
  override toString(): string {
    return this.message;
  }
}

/** 把任意后端拒绝值归一化为 Error：结构化对象取 message，其余走 String */
export function normalizeError(e: unknown): NfError {
  if (e instanceof NfError) return e;
  if (e && typeof e === 'object') {
    const obj = e as Record<string, unknown>;
    if (typeof obj.message === 'string') {
      return new NfError(
        obj.message,
        typeof obj.code === 'string' ? obj.code : 'unknown',
        obj.retryable === true,
      );
    }
  }
  return new NfError(String(e ?? '未知错误'), 'unknown', false);
}

export async function cmd<T>(name: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(name, args);
  } catch (e) {
    throw normalizeError(e);
  }
}
