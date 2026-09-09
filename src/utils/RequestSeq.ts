/**
 * 请求序号器：丢弃迟到的旧响应（审查 P1-6）。
 *
 * 典型用法（搜索 / 任何「后发先至」的异步请求）：
 *   const seq = new RequestSeq();
 *   const mine = seq.next();
 *   const res = await fetch();
 *   if (!seq.isLatest(mine)) return; // 已有更新的请求，本次结果过期
 *   render(res);
 */
export class RequestSeq {
  private current = 0;

  /** 发起一次新请求，返回其序号（同时作废旧请求） */
  next(): number {
    this.current += 1;
    return this.current;
  }

  /** 不作废、仅作废当前在途请求（输入清空等场景） */
  invalidate(): void {
    this.current += 1;
  }

  /** 该序号是否仍是最新请求 */
  isLatest(seq: number): boolean {
    return seq === this.current;
  }
}
