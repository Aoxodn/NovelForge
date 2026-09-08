//! 精确匹配引擎（阶段 6 改道版）。
//!
//! 阶段 5 的规则识别引擎（无 AI 语义理解）在真实语料上精度不可达，
//! 已废弃。现在的口径：作者手动维护人物/地点卡（名字 + 别名），
//! 引擎只做「精确字符串匹配」计数——确定性、零误判、零确认流程。
//!
//! 实现：把 名字+别名 转义后按长度降序拼成正则交替式，
//! leftmost-first 语义保证「苏婉清」优先于「苏婉」命中且不重叠计数。

use regex::Regex;

/// 统计 patterns 在 content 中的不重叠出现次数。
/// patterns 为空或 content 为空时恒为 0（不构建正则）。
pub fn count_occurrences(content: &str, patterns: &[String]) -> usize {
    let mut pats: Vec<&str> = patterns
        .iter()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .collect();
    if pats.is_empty() || content.is_empty() {
        return 0;
    }
    // 最长优先：同一起点优先命中长词（「苏婉清」先于「苏婉」）
    pats.sort_by_key(|p| std::cmp::Reverse(p.chars().count()));
    pats.dedup();
    let alt = pats
        .iter()
        .map(|p| regex::escape(p))
        .collect::<Vec<_>>()
        .join("|");
    let Ok(re) = Regex::new(&alt) else { return 0 };
    re.find_iter(content).count()
}

/// 先从正文中剔除误判词，再统计 patterns 的不重叠出现次数。
///
/// 用于单字人名：人物叫「简」时，正文里的「简单」「简历」会被误识为人名提及。
/// 先把这些误判词替换为等长空格（不改变其他字符位置），再数「简」的次数。
/// 多字名（≥2字）无需调用此函数，精确匹配已零误判。
///
/// exclude_words 为空时退化为普通 [`count_occurrences`]。
pub fn count_occurrences_with_exclusions(
    content: &str,
    patterns: &[String],
    exclude_words: &[String],
) -> usize {
    if exclude_words.is_empty() {
        return count_occurrences(content, patterns);
    }
    // 等长替换：保持字符位置不变，避免影响其他匹配
    let mut cleaned: String = content.to_string();
    for w in exclude_words {
        let w = w.trim();
        if w.is_empty() {
            continue;
        }
        // 按字符数生成等长空格（中文等宽）
        let pad: String = w.chars().map(|_| ' ').collect();
        cleaned = cleaned.replace(w, &pad);
    }
    count_occurrences(&cleaned, patterns)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pats(xs: &[&str]) -> Vec<String> {
        xs.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn exact_name_counted() {
        let c = "林默走进山门。林默抬头看天。";
        assert_eq!(count_occurrences(c, &pats(&["林默"])), 2);
    }

    #[test]
    fn aliases_merged_into_owner() {
        let c = "林默走进山门。默儿跟在后面。林师兄回头一笑。";
        assert_eq!(count_occurrences(c, &pats(&["林默", "默儿", "林师兄"])), 3);
    }

    #[test]
    fn longest_pattern_wins_no_overlap() {
        // 「苏婉清」是独立人物时，不应被「苏婉」吞掉；
        // 同卡内别名含长短关系时不重叠计数
        let c = "苏婉清来了。苏婉清走了。";
        assert_eq!(count_occurrences(c, &pats(&["苏婉", "苏婉清"])), 2);
    }

    #[test]
    fn absent_name_is_zero() {
        let c = "风起了，雪落了。";
        assert_eq!(count_occurrences(c, &pats(&["林默"])), 0);
    }

    #[test]
    fn empty_patterns_or_content() {
        assert_eq!(count_occurrences("任何文本", &[]), 0);
        assert_eq!(count_occurrences("", &pats(&["林默"])), 0);
        assert_eq!(count_occurrences("任何文本", &pats(&["", "  "])), 0);
    }

    #[test]
    fn regex_metachars_escaped() {
        let c = "他练成了 C++ 心法，又读了《史记.列传》。"
            ;
        assert_eq!(count_occurrences(c, &pats(&["C++", "史记.列传"])), 2);
    }

    #[test]
    fn single_char_name_excludes_false_positives() {
        // 人物叫「简」，正文里「简单」「简历」不应算人名提及
        let c = "简走进房间。这道题很简单。简看了看简历。简笑了。";
        assert_eq!(
            count_occurrences_with_exclusions(c, &pats(&["简"]), &pats(&["简单", "简历"])),
            3 // 简走进 / 简看了 / 简笑了
        );
    }

    #[test]
    fn empty_exclusions_falls_back_to_normal() {
        let c = "林默来了。林默走了。";
        assert_eq!(count_occurrences_with_exclusions(c, &pats(&["林默"]), &[]), 2);
    }

    #[test]
    fn exclusion_preserves_other_names() {
        // 排除「简单」不应影响「林默」的计数
        let c = "简单来说，林默和简一起走了。";
        assert_eq!(
            count_occurrences_with_exclusions(c, &pats(&["简", "林默"]), &pats(&["简单"])),
            2 // 林默 + 简（一起走了的简）
        );
    }
}
