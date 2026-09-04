/**
 * 写作会话统计（阶段 6）：状态栏实时数据 + 摸鱼提醒。
 *
 * 口径说明：
 * - 会话字数：本次打开项目以来的净增字数（正增长累计，删改不扣减）
 * - 写作时长：累计「活跃」秒数（停顿超过 IDLE_LIMIT 秒不计入）
 * - 速度：会话字数 / 活跃分钟 × 60（字/时）
 * - 空闲：距上次输入的秒数
 * - 摸鱼提醒：空闲超过设定分钟数时提醒一次（恢复写作后重置）
 *
 * 全部为前端实时估算（输入即更新），权威字数仍以 Rust 落库值为准。
 */
import { useEffect, useRef, useState } from 'react';
import { useAppStore } from '../store/appStore';
import { useEditorStore } from '../store/editorStore';
import { countText } from '../utils/text';

/** 停顿超过该秒数视为「不在写」，时长暂停累计 */
const IDLE_LIMIT_S = 60;

export interface WritingSession {
  sessionWords: number;
  activeSeconds: number;
  idleSeconds: number;
  /** 字 / 时 */
  speed: number;
}

export function useWritingSession(): WritingSession {
  const content = useEditorStore((s) => s.content);
  const chapterId = useEditorStore((s) => s.chapterId);
  const idleReminderMin = useAppStore((s) => s.writerSettings.idleReminderMin);

  const [tick, setTick] = useState(0);
  const lastInputAt = useRef(Date.now());
  const activeSeconds = useRef(0);
  const sessionWords = useRef(0);
  const lastWordCount = useRef<number | null>(null);
  const idleReminded = useRef(false);

  // 输入事件：更新最后活跃时间 + 累计会话净增字数
  useEffect(() => {
    lastInputAt.current = Date.now();
    idleReminded.current = false;
    // 以编辑器实时字数差估算净增（口径与 Rust 一致，跨章切换时重置基准）
    const words = countText(content).words;
    if (lastWordCount.current !== null && chapterId !== null) {
      const delta = words - lastWordCount.current;
      if (delta > 0) sessionWords.current += delta;
    }
    lastWordCount.current = words;
  }, [content, chapterId]);

  // 切章 / 关项目时重置会话基准（时长与空闲保留——人没离开键盘）
  useEffect(() => {
    lastWordCount.current = null;
  }, [chapterId]);

  // 秒级心跳：活跃时长累计 + 空闲检测 + 摸鱼提醒
  useEffect(() => {
    const timer = setInterval(() => {
      const idleS = (Date.now() - lastInputAt.current) / 1000;
      if (idleS < IDLE_LIMIT_S && chapterId !== null) {
        activeSeconds.current += 1;
      }
      if (
        idleReminderMin > 0 &&
        chapterId !== null &&
        !idleReminded.current &&
        idleS >= idleReminderMin * 60
      ) {
        idleReminded.current = true;
        useAppStore
          .getState()
          .showToast(`已经 ${idleReminderMin} 分钟没动笔了，起来继续写吧`, 'info');
      }
      setTick((t) => t + 1);
    }, 1000);
    return () => clearInterval(timer);
  }, [idleReminderMin, chapterId]);

  // tick 驱动重渲染，读取 ref 中的累计值
  void tick;
  const idleSeconds = Math.floor((Date.now() - lastInputAt.current) / 1000);
  const activeMinutes = activeSeconds.current / 60;
  const speed =
    activeMinutes >= 1 ? Math.round(sessionWords.current / activeMinutes) : 0;

  return {
    sessionWords: sessionWords.current,
    activeSeconds: activeSeconds.current,
    idleSeconds,
    speed,
  };
}

/** 秒 → "H:MM:SS" */
export function fmtDuration(totalSeconds: number): string {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}
