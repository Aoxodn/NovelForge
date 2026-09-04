//! 中文字数统计。
//!
//! 口径与主流写作平台一致：
//! - 每个汉字计 1 字
//! - 连续的英文字母 / 数字串计 1 字（如 "abc"、"2026"）
//! - 标点、空白不计入字数，但计入"字符数"
//!
//! 前端 `src/utils/text.ts` 中有同口径实现，用于输入时实时显示；
//! 持久化到数据库的字数以本文件的 Rust 实现为准。

pub struct TextStats {
    pub words: i64,
    pub chars: i64,
}

/// 判断是否为汉字（CJK 统一表意文字，含扩展 A / 兼容表意）
fn is_han(ch: char) -> bool {
    matches!(
        ch as u32,
        0x4E00..=0x9FFF | 0x3400..=0x4DBF | 0xF900..=0xFAFF
    )
}

/// 统计字数与字符数
pub fn count_text(text: &str) -> TextStats {
    let mut words: i64 = 0;
    let mut chars: i64 = 0;
    let mut in_word = false; // 是否处于连续字母数字串中

    for ch in text.chars() {
        chars += 1;
        if is_han(ch) {
            words += 1;
            in_word = false;
        } else if ch.is_ascii_alphanumeric() {
            if !in_word {
                words += 1;
                in_word = true;
            }
        } else {
            in_word = false;
        }
    }

    TextStats { words, chars }
}

/// 内容指纹（FNV-1a 64 位，规范化：忽略所有空白字符）。
///
/// 用途：
/// 1. 导入重复检测——同一内容以不同标题重复导入时指纹相同
///   （忽略空白使得「排版差异」不算内容差异）
/// 2. chapters.content_hash——增量分析预留：内容未变则跳过重分析
///
/// FNV-1a 非密码学哈希，但对本场景（碰撞只导致多查一次内容）足够，
/// 且纯标准库实现、无新依赖。
pub fn content_fingerprint(s: &str) -> u64 {
    const FNV_OFFSET: u64 = 0xcbf29ce484222325;
    const FNV_PRIME: u64 = 0x100000001b3;
    let mut hash = FNV_OFFSET;
    let mut buf = [0u8; 4];
    for c in s.chars() {
        // char::is_whitespace 按 Unicode White_Space 属性，含全角空格 U+3000
        if c.is_whitespace() {
            continue;
        }
        let encoded = c.encode_utf8(&mut buf);
        for b in encoded.as_bytes() {
            hash ^= *b as u64;
            hash = hash.wrapping_mul(FNV_PRIME);
        }
    }
    hash
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_count() {
        let s = "林默 walked 2026 年。";
        let t = count_text(s);
        // 林、默、walked、2026、年 = 5 字；标点与空格不计
        assert_eq!(t.words, 5);
        assert_eq!(t.chars, s.chars().count() as i64);
    }

    #[test]
    fn fingerprint_ignores_whitespace() {
        // 空白差异（换行 / 空格 / 全角空格）不改变指纹
        assert_eq!(
            content_fingerprint("林默\n\n 苏婉　来了"),
            content_fingerprint("林默苏婉来了")
        );
        assert_ne!(content_fingerprint("林默"), content_fingerprint("苏婉"));
        assert_ne!(
            content_fingerprint("第一段。第二段。"),
            content_fingerprint("第一段。第三段。")
        );
        // 空内容指纹一致且稳定
        assert_eq!(content_fingerprint(""), content_fingerprint(" \n　"));
    }
}
