import { describe, it, expect } from 'vitest';
import { normalizeError, NfError } from '../api/client';

describe('normalizeError 结构化错误归一化（审查 P2-3）', () => {
  it('解析后端 {code,message,retryable} 对象', () => {
    const e = normalizeError({
      code: 'db',
      message: '数据库错误: database is locked',
      retryable: true,
    });
    expect(e).toBeInstanceOf(NfError);
    expect(e.code).toBe('db');
    expect(e.retryable).toBe(true);
    // String(e) 必须直接得到可读文案，兼容旧的 String(e) 调用
    expect(String(e)).toBe('数据库错误: database is locked');
  });

  it('字符串 / 其它值兜底为 unknown', () => {
    const e = normalizeError('boom');
    expect(e.code).toBe('unknown');
    expect(e.retryable).toBe(false);
    expect(String(e)).toBe('boom');
  });

  it('已是 NfError 时原样返回', () => {
    const e = new NfError('x', 'business', false);
    expect(normalizeError(e)).toBe(e);
  });
});
