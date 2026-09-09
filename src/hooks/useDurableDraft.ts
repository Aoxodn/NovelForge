/**
 * useDurableDraft —— 可靠草稿自动保存 Hook（审查 P0-2）。
 *
 * 解决三类问题：
 *   1. 切换实体时旧实体的防抖定时器被 cleanup 取消、编辑状态被覆盖 → 丢草稿；
 *   2. 保存进行中又产生修改，最后几次输入留在内存；
 *   3. 保存异常被静默吞掉，用户无感知。
 *
 * 机制：
 *   - 以「实体 ID + 修订」为单位，切换 ID 前先 flush 上一实体的待存草稿；
 *   - 串行保存循环：保存期间若有新修改（pending），完成后立即再存最新快照；
 *   - 卸载前 flush；
 *   - 保存失败保留 dirty 并暴露持久 error（调用方显示固定错误条，非 3 秒 Toast）。
 */
import { useCallback, useEffect, useRef, useState } from 'react';

export interface DurableDraft<T extends object> {
  draft: T;
  /** 局部更新或函数式更新，会标记 dirty；保存中调用会登记 pending 追存 */
  setDraft: (patch: Partial<T> | ((prev: T) => T)) => void;
  dirty: boolean;
  saving: boolean;
  /** 最近一次保存错误（持久，成功或 reset 后清空） */
  error: string | null;
  /** 立即保存；成功 true，失败 false */
  flush: () => Promise<boolean>;
  /** 用外部权威数据重置（加载实体后调用） */
  reset: (value: T) => void;
  /** 失败后重试 */
  retry: () => Promise<boolean>;
}

/** 串行追存的安全阀，防止极端连续输入下无限循环 */
const MAX_LOOPS = 20;

export function useDurableDraft<T extends object>(
  entityId: number | null,
  initial: T,
  saveFn: (id: number, draft: T) => Promise<unknown>,
  debounceMs = 800,
): DurableDraft<T> {
  const [draft, setDraftState] = useState<T>(initial);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 始终最新的引用，避免闭包读到旧值
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const idRef = useRef(entityId);
  const saveRef = useRef(saveFn);
  saveRef.current = saveFn;
  const dirtyRef = useRef(false);
  const savingRef = useRef(false);
  const pendingRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimer = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  /** 串行保存：保存期间有新改动则追存一轮 */
  const persist = useCallback(async (id: number, value: T): Promise<boolean> => {
    let current = value;
    for (let loop = 0; loop < MAX_LOOPS; loop++) {
      savingRef.current = true;
      setSaving(true);
      setError(null);
      try {
        await saveRef.current(id, current);
      } catch (e) {
        savingRef.current = false;
        setSaving(false);
        setError(String(e));
        dirtyRef.current = true;
        setDirty(true);
        return false;
      }
      if (pendingRef.current) {
        pendingRef.current = false;
        current = draftRef.current;
        continue;
      }
      savingRef.current = false;
      setSaving(false);
      dirtyRef.current = false;
      setDirty(false);
      return true;
    }
    savingRef.current = false;
    setSaving(false);
    return true;
  }, []);

  const flush = useCallback(async () => {
    clearTimer();
    const id = idRef.current;
    if (id === null) return true;
    if (!dirtyRef.current && !pendingRef.current && !savingRef.current) return true;
    return persist(id, draftRef.current);
  }, [clearTimer, persist]);

  // 切换实体：先 flush 上一实体，再装载新实体
  useEffect(() => {
    const prevId = idRef.current;
    if (prevId !== null && prevId !== entityId) {
      clearTimer();
      // 用上一实体 id 保存其最后草稿（draftRef 此刻仍是旧实体内容）
      void persist(prevId, draftRef.current);
    }
    idRef.current = entityId;
    draftRef.current = initial;
    setDraftState(initial);
    dirtyRef.current = false;
    pendingRef.current = false;
    setDirty(false);
    setError(null);
    clearTimer();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entityId]);

  // 防抖自动保存
  useEffect(() => {
    if (!dirty || entityId === null) return;
    timerRef.current = setTimeout(() => {
      void persist(entityId, draftRef.current);
    }, debounceMs);
    return clearTimer;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, dirty, entityId, debounceMs, clearTimer, persist]);

  // 卸载前尽力 flush
  useEffect(() => {
    return () => {
      clearTimer();
      const id = idRef.current;
      if (id !== null && (dirtyRef.current || pendingRef.current)) {
        void saveRef.current(id, draftRef.current);
      }
    };
  }, [clearTimer]);

  const setDraft = useCallback((patch: Partial<T> | ((prev: T) => T)) => {
    setDraftState((prev) => {
      const next =
        typeof patch === 'function' ? (patch as (p: T) => T)(prev) : { ...prev, ...patch };
      draftRef.current = next;
      if (savingRef.current) pendingRef.current = true;
      dirtyRef.current = true;
      setDirty(true);
      return next;
    });
  }, []);

  const reset = useCallback(
    (value: T) => {
      clearTimer();
      draftRef.current = value;
      setDraftState(value);
      dirtyRef.current = false;
      pendingRef.current = false;
      setDirty(false);
      setError(null);
    },
    [clearTimer],
  );

  const retry = useCallback(() => flush(), [flush]);

  return { draft, setDraft, dirty, saving, error, flush, reset, retry };
}
