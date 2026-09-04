//! 章节标题识别规则引擎（文档第十八至二十节）。
//!
//! 多级规则（基础置信度从高到低）：
//!
//! | 级别 | 规则 | 基础分 | 强规则 |
//! |------|------|--------|--------|
//! | L1 | 中文「第X章 / 第X回 / 第X节」 | 0.99 | 是 |
//! | L2 | 英文「Chapter N」 | 0.95 | 是 |
//! | L5 | DOCX 标题样式（Heading/标题N） | 0.90 | 是 |
//! | L3 | 数字「1. / 2、 / 01.」 | 0.80 | 否 |
//! | L6 | DOCX 格式特征（居中+加粗/大字号） | 0.70 | 否 |
//! | L7 | 纯数字+空格标题「3394 鬼煞」 | 0.60 | 否 |
//! | L4 | 中文数字「一、二、」 | 0.55 | 否 |
//!
//! 加成（文档第十九、二十节）：
//! - 居中 +0.05 / 加粗 +0.03 / 字号 ≥ 14pt +0.05
//! - 编号整体单调递增（允许缺失）+0.05
//! - L7 链支撑：与相邻编号候选构成递增关系 +0.30
//!   （网文导出常见「3394 鬼煞」「0746 我打你有意见不」格式，
//!   编号递增是比文本模式更可靠的判据）
//!
//! 惩罚：
//! - 弱规则且与上一候选间正文 < 40 字 ×0.5（避免把列表项 / 序号段落误判为章节）
//! - L7 孤立出现（无相邻编号呼应）×0.5 → 被阈值过滤
//!
//! 最终 < 0.45 的候选丢弃；置信度 < 0.6 在预览中标记 ⚠ 需用户确认。

use crate::import::ImportedParagraph;
use regex::Regex;
use std::sync::LazyLock;

/// 检测出的章节块（段落区间）
#[derive(Debug)]
pub struct ChapterBlock {
    pub title: String,
    /// 起始段落索引（含标题段自身）
    pub start: usize,
    /// 结束段落索引（不含）
    pub end: usize,
    /// start 是否为标题段（开篇/整份导入块无标题段）
    pub title_included: bool,
    pub confidence: f32,
    pub rule: String,
}

struct Candidate {
    para: usize,
    title: String,
    score: f32,
    rule: &'static str,
    /// 从标题中提取的编号（用于连续性验证）
    number: Option<i64>,
    /// 强规则（L1/L2/L5）：不受「间隔正文过短」惩罚
    strong: bool,
    /// L7 链支撑：与相邻编号候选构成递增关系，
    /// 豁免间隔惩罚（编号递增是比间隔更强的章节信号）
    chain_supported: bool,
}

// 正则说明：
// - 行首允许半角/全角空白
// - L1 编号支持阿拉伯与中文数字（「第 100 章」「第一百章」）
// - 标题长度限制，防止长正文行误判
static RE_ZH: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"^[ \t\u{3000}]*第\s*([0-9]{1,7}|[零〇一二两三四五六七八九十百千万]{1,12})\s*[章节回]\s*\S{0,40}$",
    )
    .unwrap()
});
static RE_EN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)^[ \t\u{3000}]*chapter\s*([0-9]{1,5})\b.{0,60}$").unwrap()
});
static RE_NUM: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^[ \t\u{3000}]*([0-9]{1,4})[.、．:：]\s*\S.{0,40}$").unwrap()
});
// L7：纯数字编号 + 空格 + 标题（网文下载常见，如「3394 鬼煞」「0746 我打你有意见不」）。
// 数字至少 2 位：单数字+空格（如「3 个人」）误判率过高，不做支持。
static RE_NUM_SPACE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^[ \t\u{3000}]*([0-9]{2,7})[ \t\u{3000}]+\S.{0,39}$").unwrap()
});
static RE_CN_NUM: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^[ \t\u{3000}]*([零〇一二两三四五六七八九十]{1,6})[、.．]\s*\S.{0,40}$").unwrap()
});

/// 行尾为对话 / 疑问 / 断句标点：几乎不可能是章节标题。
///
/// 真实误判案例（用户反馈）：
/// ```text
/// 一、跟过去看看，看那人是否离开了或者里面到底有什么！
/// 二、把这个出口封死，我们回去叫人！"
/// ```
/// 这类「中文数字 + 顿号」开头的对白分条行极易命中 L4 规则，
/// 必须靠结尾标点拒绝——章节标题极少以 ！？。” 等收尾。
/// 仅应用于弱规则（L3/L4/L7）；强规则（第X章 / Chapter N / DOCX 标题样式）
/// 有明确章节标记词，豁免此检查。
fn ends_like_dialogue(text: &str) -> bool {
    let Some(last) = text.chars().last() else {
        return false;
    };
    matches!(
        last,
        '！' | '？' | '!' | '?'
            | '。' | '，' | '；' | ',' | ';'
            | '…'
            | '”' | '"' | '’' | '\''
            | '」' | '』'
            | '）' | ')'
    )
}

/// 中文数字 → 数值（支持到万位，如「一百零三」「两千零一十」）
fn cn_num_to_int(s: &str) -> Option<i64> {
    // 注意：不能用 '一'..='九' 这类 Unicode 范围匹配，
    // '两'(U+4E24)、'万'(U+4E07) 等字恰好落在该区间内，必须显式枚举。
    fn digit(ch: char) -> Option<i64> {
        match ch {
            '一' => Some(1),
            '二' | '两' => Some(2),
            '三' => Some(3),
            '四' => Some(4),
            '五' => Some(5),
            '六' => Some(6),
            '七' => Some(7),
            '八' => Some(8),
            '九' => Some(9),
            _ => None,
        }
    }

    let mut total: i64 = 0; // 万位以上累积
    let mut section: i64 = 0; // 当前万段内累积
    let mut num: i64 = 0; // 当前数字
    for ch in s.chars() {
        if let Some(d) = digit(ch) {
            num = d;
        } else {
            match ch {
                '零' | '〇' => num = 0,
                '十' | '百' | '千' => {
                    let unit = match ch {
                        '十' => 10,
                        '百' => 100,
                        _ => 1000,
                    };
                    if num == 0 {
                        num = 1; // 「十」= 10
                    }
                    section += num * unit;
                    num = 0;
                }
                '万' => {
                    section += num;
                    total += section * 10_000;
                    section = 0;
                    num = 0;
                }
                _ => return None,
            }
        }
    }
    Some(total + section + num)
}

/// 对单个段落做规则分类
fn classify(p: &ImportedParagraph, idx: usize) -> Option<Candidate> {
    let text = p.text.trim();
    let len = text.chars().count();
    // 标题段不可能太长
    if len == 0 || len > 60 {
        return None;
    }

    let (mut score, rule, number, strong): (f32, &'static str, Option<i64>, bool);

    if let Some(m) = RE_ZH.captures(text) {
        let num_str = m.get(1).unwrap().as_str();
        let n = num_str
            .parse::<i64>()
            .ok()
            .or_else(|| cn_num_to_int(num_str));
        score = 0.99;
        rule = "中文章节";
        number = n;
        strong = true;
    } else if let Some(m) = RE_EN.captures(text) {
        let n = m.get(1).unwrap().as_str().parse::<i64>().ok();
        score = 0.95;
        rule = "英文 Chapter";
        number = n;
        strong = true;
    } else if p.heading {
        score = 0.90;
        rule = "文档标题样式";
        number = None;
        strong = true;
    } else if let Some(m) = RE_NUM.captures(text) {
        // L3 弱规则：对白分条行拒绝
        if ends_like_dialogue(text) {
            return None;
        }
        let n = m.get(1).unwrap().as_str().parse::<i64>().ok();
        score = 0.80;
        rule = "数字编号";
        number = n;
        strong = false;
    } else if let Some(m) = RE_NUM_SPACE.captures(text) {
        // L7 弱规则：对白分条行拒绝
        if ends_like_dialogue(text) {
            return None;
        }
        // 前导零也按数值解析（「0746」→ 746），用于连续性比较
        let n = m.get(1).unwrap().as_str().parse::<i64>().ok();
        score = 0.60;
        rule = "纯数字标题";
        number = n;
        strong = false;
    } else if let Some(m) = RE_CN_NUM.captures(text) {
        // L4 弱规则：对白分条行拒绝（最高频误判来源）
        if ends_like_dialogue(text) {
            return None;
        }
        let n = cn_num_to_int(m.get(1).unwrap().as_str());
        score = 0.55;
        rule = "中文数字";
        number = n;
        strong = false;
    } else if p.centered && (p.bold || p.font_size.map_or(false, |s| s >= 14.0)) {
        score = 0.70;
        rule = "居中加粗标题";
        number = None;
        strong = false;
    } else {
        return None;
    }

    // DOCX 结构加成
    if p.centered {
        score += 0.05;
    }
    if p.bold {
        score += 0.03;
    }
    if p.font_size.map_or(false, |s| s >= 14.0) {
        score += 0.05;
    }
    if score > 1.0 {
        score = 1.0;
    }

    Some(Candidate {
        para: idx,
        title: text.to_string(),
        score,
        rule,
        number,
        strong,
        chain_supported: false,
    })
}

/// 整份无结构时的兜底块（标题由命令层用文件名填充）
fn whole_file_block(paras: &[ImportedParagraph]) -> Vec<ChapterBlock> {
    vec![ChapterBlock {
        title: String::new(),
        start: 0,
        end: paras.len(),
        title_included: false,
        confidence: 1.0,
        rule: "整份导入".into(),
    }]
}

/// 主入口：段落序列 → 章节块列表
pub fn detect(paras: &[ImportedParagraph]) -> Vec<ChapterBlock> {
    let mut cands: Vec<Candidate> = paras
        .iter()
        .enumerate()
        .filter_map(|(i, p)| classify(p, i))
        .collect();

    if cands.is_empty() {
        return whole_file_block(paras);
    }

    // 1) 连续性加成：所有带编号候选整体单调递增（允许跳号）
    let numbered: Vec<i64> = cands.iter().filter_map(|c| c.number).collect();
    if numbered.len() >= 2 && numbered.windows(2).all(|w| w[1] > w[0]) {
        for c in cands.iter_mut() {
            if c.number.is_some() {
                c.score = (c.score + 0.05).min(1.0);
            }
        }
    }

    // 2) L7 链支撑判定：纯数字标题（「3394 鬼煞」）单独出现时误判率高，
    //    必须与相邻编号候选构成递增关系才可信：
    //    - 有支撑：+0.30（编号递增是强章节信号）
    //    - 孤立：  ×0.5 → 落到阈值下被过滤
    for i in 0..cands.len() {
        if cands[i].rule != "纯数字标题" {
            continue;
        }
        let Some(n) = cands[i].number else {
            continue;
        };
        // 前面 / 后面最近的带编号候选
        let prev = cands[..i]
            .iter()
            .rev()
            .find_map(|c| c.number)
            .map_or(false, |p| p < n);
        let next = cands[i + 1..]
            .iter()
            .find_map(|c| c.number)
            .map_or(false, |x| x > n);
        if prev || next {
            cands[i].score = (cands[i].score + 0.30).min(1.0);
            cands[i].chain_supported = true;
        } else {
            cands[i].score *= 0.5;
        }
    }

    // 3) 间隔惩罚：弱规则且与上一候选间正文过少（典型误判：目录、列表项）。
    //    在连续性加成之后应用——紧邻是更强的「非章节」信号，可否决加成；
    //    链支撑的 L7 例外：其编号递增已证明章节属性。
    for w in 1..cands.len() {
        if !cands[w].strong && !cands[w].chain_supported {
            let between: usize = paras[cands[w - 1].para + 1..cands[w].para]
                .iter()
                .map(|p| p.text.chars().count())
                .sum();
            if between < 40 {
                cands[w].score *= 0.5;
            }
        }
    }

    // 4) 阈值过滤
    cands.retain(|c| c.score >= 0.45);
    if cands.is_empty() {
        return whole_file_block(paras);
    }

    // 5) 切块：候选 → [start, end) 区间；首个候选前的内容作为「开篇」块
    let mut blocks = Vec::new();
    for (i, c) in cands.iter().enumerate() {
        if i == 0 && c.para > 0 {
            let has_content = paras[..c.para].iter().any(|p| !p.text.trim().is_empty());
            if has_content {
                blocks.push(ChapterBlock {
                    title: "开篇".into(),
                    start: 0,
                    end: c.para,
                    title_included: false,
                    confidence: 1.0,
                    rule: "文件开头".into(),
                });
            }
        }
        let end = cands
            .get(i + 1)
            .map(|n| n.para)
            .unwrap_or(paras.len());
        blocks.push(ChapterBlock {
            title: c.title.clone(),
            start: c.para,
            end,
            title_included: true,
            confidence: c.score,
            rule: c.rule.into(),
        });
    }
    blocks
}

/// 按用户调整组装最终章节。
///
/// 两类被排除的块语义不同（用户反馈：重复内容并入前一章导致
/// 「标题不同但内容重复」——长文档末尾的重复章尤其多发）：
/// - `excluded`：用户手动取消的误判边界，正文**并入前一章**（智能合并）；
/// - `discarded`：内容重复的块（与库中已有 / 本文件更早章节相同），
///   正文**直接丢弃**——它已存在于库中，再并入邻章就是重复内容。
pub fn assemble(
    paras: &[ImportedParagraph],
    blocks: &[ChapterBlock],
    excluded: &[usize],
    discarded: &[usize],
) -> Vec<(String, String)> {
    let mut result: Vec<(String, String)> = Vec::new();
    let mut carry = String::new(); // 被取消块暂存的正文

    for (i, b) in blocks.iter().enumerate() {
        // 重复块：内容已在库中，直接跳过（不 carry，不并入前一章）
        if discarded.contains(&i) {
            continue;
        }

        let body_start = if b.title_included { b.start + 1 } else { b.start };
        let content = paras[body_start..b.end]
            .iter()
            .map(|p| p.text.trim_end())
            .filter(|t| !t.trim().is_empty())
            .map(|t| t.to_string())
            .collect::<Vec<_>>()
            .join("\n");

        if excluded.contains(&i) {
            if !content.is_empty() {
                carry.push_str(&content);
                carry.push('\n');
            }
            continue;
        }

        let mut body = String::new();
        if !carry.is_empty() {
            body.push_str(carry.trim_end());
            body.push('\n');
            carry.clear();
        }
        body.push_str(&content);
        result.push((b.title.clone(), body));
    }

    // 尾部残留（最后一块被取消）：追加到最后一章
    if !carry.is_empty() {
        match result.last_mut() {
            Some(last) => {
                last.1.push('\n');
                last.1.push_str(carry.trim_end());
            }
            None => result.push(("未命名".into(), carry.trim_end().to_string())),
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn para(text: &str) -> ImportedParagraph {
        ImportedParagraph {
            text: text.into(),
            bold: false,
            centered: false,
            heading: false,
            font_size: None,
        }
    }

    fn filler(n: usize) -> Vec<ImportedParagraph> {
        (0..n).map(|_| para("这是用来拉开章节间距的正文内容，长度需要超过四十个字符以上才行，所以多写一些。")).collect()
    }

    #[test]
    fn cn_num_conversion() {
        assert_eq!(cn_num_to_int("二十三"), Some(23));
        assert_eq!(cn_num_to_int("一百零三"), Some(103));
        assert_eq!(cn_num_to_int("十"), Some(10));
        assert_eq!(cn_num_to_int("一万二千"), Some(12000));
        assert_eq!(cn_num_to_int("两"), Some(2));
        assert_eq!(cn_num_to_int("九千九百九十九"), Some(9999));
    }

    #[test]
    fn detect_zh_chapters() {
        let mut paras = vec![para("第一章 少年")];
        paras.extend(filler(5));
        paras.push(para("第二章 入城"));
        paras.extend(filler(5));
        paras.push(para("第一百零三章 风雨"));
        paras.extend(filler(5));

        let blocks = detect(&paras);
        assert_eq!(blocks.len(), 3);
        assert_eq!(blocks[0].title, "第一章 少年");
        assert_eq!(blocks[2].title, "第一百零三章 风雨");
        assert!(blocks[0].confidence >= 0.99);
        assert!(blocks[0].title_included);
    }

    #[test]
    fn detect_with_spaces_in_title() {
        let mut paras = vec![para("第 100 章 大结局")];
        paras.extend(filler(5));
        let blocks = detect(&paras);
        assert_eq!(blocks.len(), 1);
        assert_eq!(blocks[0].title, "第 100 章 大结局");
    }

    #[test]
    fn detect_leading_block() {
        let mut paras = vec![para("楔子：天下大势，分久必合。")];
        paras.extend(filler(3));
        paras.push(para("第一章"));
        paras.extend(filler(3));
        let blocks = detect(&paras);
        assert_eq!(blocks.len(), 2);
        assert_eq!(blocks[0].title, "开篇");
        assert!(!blocks[0].title_included);
        assert_eq!(blocks[0].end, 4);
    }

    #[test]
    fn closeness_penalty_filters_list_items() {
        // 两个紧邻的数字标题（间隔正文为 0）→ 后者被惩罚至阈值下
        let paras = vec![para("1. 甲项"), para("2. 乙项")];
        let blocks = detect(&paras);
        assert_eq!(blocks.len(), 1);
    }

    #[test]
    fn continuity_bonus_applied() {
        let mut paras = Vec::new();
        for i in 1..=3 {
            paras.push(para(&format!("第{i}章 标题")));
            paras.extend(filler(3));
        }
        let blocks = detect(&paras);
        assert_eq!(blocks.len(), 3);
        // 0.99 + 0.05 = 1.0（连续编号加成）
        assert!((blocks[0].confidence - 1.0).abs() < 1e-5);
    }

    #[test]
    fn english_chapter_format() {
        let mut paras = vec![para("Chapter 1 The Beginning")];
        paras.extend(filler(5));
        paras.push(para("CHAPTER 02"));
        paras.extend(filler(5));
        let blocks = detect(&paras);
        assert_eq!(blocks.len(), 2);
        assert_eq!(blocks[0].rule, "英文 Chapter");
    }

    #[test]
    fn no_structure_whole_file() {
        let paras = vec![para("就是一段普通文本。"), para("没有任何章节结构。")];
        let blocks = detect(&paras);
        assert_eq!(blocks.len(), 1);
        assert_eq!(blocks[0].rule, "整份导入");
        assert_eq!(blocks[0].end, 2);
    }

    #[test]
    fn docx_format_signal() {
        // 居中 + 加粗 + 16pt，无文本规则命中 → L6 格式特征
        let mut paras = Vec::new();
        for i in 0..3 {
            paras.push(ImportedParagraph {
                text: format!("序之{i}"),
                bold: true,
                centered: true,
                heading: false,
                font_size: Some(16.0),
            });
            paras.extend(filler(3));
        }
        let blocks = detect(&paras);
        assert_eq!(blocks.len(), 3);
        // 0.70 + 0.05(居中) + 0.03(加粗) + 0.05(字号) = 0.83
        assert!((blocks[0].confidence - 0.83).abs() < 1e-5);
    }

    #[test]
    fn assemble_merges_excluded_block() {
        let mut paras = vec![para("第一章"), para("内容A")];
        paras.extend(filler(3));
        paras.push(para("第二章"));
        paras.push(para("内容B"));

        let blocks = detect(&paras);
        let out = assemble(&paras, &blocks, &[1], &[]); // 取消第二章（边界合并）
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].0, "第一章");
        assert!(out[0].1.contains("内容A"));
        assert!(out[0].1.contains("内容B"));
        assert!(!out[0].1.contains("第二章")); // 被合并块的标题行被丢弃
    }

    #[test]
    fn assemble_excluded_leading_carries_forward() {
        let paras = vec![para("楔子内容"), para("第一章"), para("正文一")];
        let blocks = detect(&paras);
        let out = assemble(&paras, &blocks, &[0], &[]); // 取消开篇块
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].0, "第一章");
        assert!(out[0].1.starts_with("楔子内容"));
    }

    #[test]
    fn assemble_discarded_block_dropped_not_merged() {
        // 用户反馈场景：文档末尾的重复章被标记排除后，
        // 其正文不应并入前一章（否则前一章内容 = 自身 + 重复章 = 内容重复）
        let mut paras = vec![para("第99章 新篇"), para("全新正文，从未出现过。")];
        paras.extend(filler(3));
        paras.push(para("第100章 重复章")); // 标题不同
        paras.push(para("全新正文，从未出现过。")); // 正文与第99章相同

        let blocks = detect(&paras);
        assert_eq!(blocks.len(), 2);
        // 第 1 块（重复章）被丢弃而非合并
        let out = assemble(&paras, &blocks, &[], &[1]);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].0, "第99章 新篇");
        // 正文只出现一次（重复内容未拼入）
        assert_eq!(out[0].1.matches("全新正文，从未出现过。").count(), 1);
        assert!(!out[0].1.contains("第100章"));
    }

    #[test]
    fn assemble_discarded_leading_not_carried() {
        // 首块被丢弃时，其正文不得顺延拼进下一章
        let paras = vec![para("重复的开篇内容。"), para("第一章"), para("正文一")];
        let blocks = detect(&paras);
        let out = assemble(&paras, &blocks, &[], &[0]);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].0, "第一章");
        assert!(!out[0].1.contains("重复的开篇内容"));
    }

    // ========== L7：纯数字 + 空格 + 标题（「3394 鬼煞」格式） ==========

    #[test]
    fn pure_number_titles_with_chain() {
        // 网文下载常见：编号 + 空格 + 标题，编号递增
        let mut paras = Vec::new();
        for (n, t) in [
            (3392, "旧地重游"),
            (3393, "暗流涌动"),
            (3394, "鬼煞"),
            (3395, "破阵"),
        ] {
            paras.push(para(&format!("{n} {t}")));
            paras.extend(filler(3));
        }
        let blocks = detect(&paras);
        assert_eq!(blocks.len(), 4, "四行递增编号应全部识别");
        assert_eq!(blocks[2].title, "3394 鬼煞");
        assert_eq!(blocks[2].rule, "纯数字标题");
        // 链支撑 + 整体递增：0.60 + 0.05 + 0.30 = 0.95
        assert!((blocks[2].confidence - 0.95).abs() < 1e-5);
    }

    #[test]
    fn pure_number_titles_with_leading_zeros() {
        // 前导零编号（「0746 我打你有意见不」），按数值比较连续性
        let mut paras = Vec::new();
        for (n, t) in [(744, "风起"), (745, "云涌"), (746, "我打你有意见不")] {
            paras.push(para(&format!("{n:04} {t}")));
            paras.extend(filler(3));
        }
        let blocks = detect(&paras);
        assert_eq!(blocks.len(), 3);
        assert_eq!(blocks[2].title, "0746 我打你有意见不");
    }

    #[test]
    fn isolated_pure_number_title_filtered() {
        // 孤立的「数字 空格 文本」行（如正文中的年份/数量描述）不应识别为章节
        let paras = vec![
            para("故事发生在很久以前。"),
            para("2026 年春天，少年背起行囊。"),
            para("他走了很远很远的路，见识了许多人和事。"),
            para("山里有 3000 斤铁矿，据说价值连城。"),
            para("但这些都不重要，重要的是他终于回来了。"),
        ];
        let blocks = detect(&paras);
        assert_eq!(blocks.len(), 1);
        assert_eq!(blocks[0].rule, "整份导入");
    }

    #[test]
    fn pure_number_title_short_gap_with_chain() {
        // 链支撑的 L7 即使与上一候选间隔正文少（目录式排版）也不被间隔惩罚误杀。
        // 场景：章节号连续但正文极短的文档（每章仅一两行）。
        let paras = vec![
            para("1001 开端"),
            para("寥寥数语。"),
            para("1002 转折"),
            para("又是一句。"),
            para("1003 结局"),
            para("终。"),
        ];
        let blocks = detect(&paras);
        assert_eq!(blocks.len(), 3, "编号递增链不应被间隔惩罚过滤");
        assert_eq!(blocks[2].title, "1003 结局");
    }

    #[test]
    fn mixed_number_title_formats() {
        // 「第X章」与「纯数字」混排：整体编号递增时都应保留
        let mut paras = vec![para("第3393章 山雨")];
        paras.extend(filler(3));
        paras.push(para("3394 鬼煞"));
        paras.extend(filler(3));
        let blocks = detect(&paras);
        assert_eq!(blocks.len(), 2);
        assert_eq!(blocks[1].title, "3394 鬼煞");
        assert!(blocks[1].confidence >= 0.90); // 0.60+0.05+0.30
    }

    // ========== 对白分条行误判拒绝（用户反馈的真实案例） ==========

    #[test]
    fn dialogue_lines_not_detected_as_chapters() {
        // 用户反馈：对白以「一、二、」分条，不是章节标题
        let paras = vec![
            para("有人压低声音说了一句。"),
            para("一、跟过去看看，看那人是否离开了或者里面到底有什么！"),
            para("二、把这个出口封死，我们回去叫人！"),
            para("众人商议已定，各自散去准备，夜色渐深，风声更紧了。"),
        ];
        let blocks = detect(&paras);
        assert_eq!(blocks.len(), 1);
        assert_eq!(blocks[0].rule, "整份导入");
    }

    #[test]
    fn dialogue_variants_all_rejected() {
        // 各种对话/断句结尾的「数字、」行都应拒绝
        let lines = [
            "三、你觉得他说的是真的吗？",
            "四、我听不太明白……",
            "五、就这么定了。",
            "六、小心背后！",
            "1. 先去探路！",
            "2. 你说什么？！",
        ];
        for line in lines {
            assert!(
                classify(&para(line), 0).is_none(),
                "应拒绝对白行：{line}"
            );
        }
    }

    #[test]
    fn normal_cn_number_title_still_works() {
        // 正常的中文数字标题（无对话标点结尾）不受影响
        let mut paras = vec![para("一、初入江湖")];
        paras.extend(filler(3));
        paras.push(para("二、风波再起"));
        paras.extend(filler(3));
        let blocks = detect(&paras);
        assert_eq!(blocks.len(), 2);
        assert_eq!(blocks[1].title, "二、风波再起");
    }

    #[test]
    fn strong_rule_allows_exclamation() {
        // 强规则（第X章）豁免对话检查：带感叹号的标题仍识别
        let mut paras = vec![para("第十二章 大战起！")];
        paras.extend(filler(3));
        let blocks = detect(&paras);
        assert_eq!(blocks.len(), 1);
        assert_eq!(blocks[0].title, "第十二章 大战起！");
    }
}
