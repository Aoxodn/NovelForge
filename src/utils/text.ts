/**
 * 前端字数统计 —— 与 Rust 侧 `src-tauri/src/text.rs` 保持同一口径：
 * 汉字每字计 1，连续字母/数字串计 1，标点空白不计字数但计字符数。
 * 仅用于输入时的实时显示；入库字数以 Rust 实现为准。
 */

const HAN_RE = /[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/;
const WORD_RE = /[a-zA-Z0-9]/;

export function countText(text: string): { words: number; chars: number } {
  let words = 0;
  let chars = 0;
  let inWord = false;
  for (const ch of text) {
    chars++;
    if (HAN_RE.test(ch)) {
      words++;
      inWord = false;
    } else if (WORD_RE.test(ch)) {
      if (!inWord) {
        words++;
        inWord = true;
      }
    } else {
      inWord = false;
    }
  }
  return { words, chars };
}

/** 非空段落数 */
export function countParagraphs(text: string): number {
  return text.split(/\n+/).filter((s) => s.trim().length > 0).length;
}

/** 预计阅读时长（分钟），按中文 400 字/分钟 */
export function readingMinutes(words: number): number {
  if (words <= 0) return 0;
  return Math.max(1, Math.round(words / 400));
}

/** 千分位格式化 */
export function fmt(n: number): string {
  return n.toLocaleString('zh-CN');
}
