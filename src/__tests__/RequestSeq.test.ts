import { describe, it, expect } from 'vitest';
import { RequestSeq } from '../utils/RequestSeq';

describe('RequestSeq 迟到响应丢弃（审查 P1-6）', () => {
  it('后发请求作废旧请求', () => {
    const seq = new RequestSeq();
    const first = seq.next();
    const second = seq.next();
    expect(seq.isLatest(first)).toBe(false);
    expect(seq.isLatest(second)).toBe(true);
  });

  it('三个并发请求只有最后一个被采纳', () => {
    const seq = new RequestSeq();
    const a = seq.next();
    const b = seq.next();
    const c = seq.next();
    expect([seq.isLatest(a), seq.isLatest(b), seq.isLatest(c)]).toEqual([
      false,
      false,
      true,
    ]);
  });

  it('invalidate 让在途请求全部过期', () => {
    const seq = new RequestSeq();
    const a = seq.next();
    seq.invalidate();
    expect(seq.isLatest(a)).toBe(false);
  });
});
