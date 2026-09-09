//! 导入命令：分析（不落库）→ 前端预览 → 确认落库。
//!
//! 数据流（文档第二十一节）：
//! ```text
//! import_analyze_file(path)
//!   → 后台线程读取 + 规则引擎识别
//!   → 返回章节列表（标题/置信度/字数/预览），结果缓存在 Rust 侧
//!   → 前端展示预览，用户可取消/恢复章节边界
//! import_confirm(analysis_id, excluded, 目标卷)
//!   → 事务批量写入 chapters
//! ```

use crate::commands::AppState;
use crate::error::{AppError, Result};
use crate::import::{self, detector, CachedAnalysis, ImportedParagraph};
use crate::models::{ImportAnalysis, ImportResult, PreviewChapter};
use crate::text;
use rusqlite::params;
use std::sync::atomic::{AtomicU64, Ordering};
use tauri::State;

/// 单文件大小上限（超过则提示拆分）
const MAX_FILE_SIZE: u64 = 200 * 1024 * 1024;

/// 生成分析会话 id（时间戳 + 进程内计数器，无需额外依赖）
fn new_analysis_id() -> String {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    let ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    format!("{ms}-{n}")
}

/// 分析导入文件：读取 → 章节识别 → 重复检测 → 返回预览（不写库）。
/// 重 IO 与正则计算在后台线程执行，避免阻塞 UI（文档第六十节）。
#[tauri::command]
pub async fn import_analyze_file(
    state: State<'_, AppState>,
    path: String,
) -> Result<ImportAnalysis> {
    let p = path.clone();
    let paras = tauri::async_runtime::spawn_blocking(move || -> Result<Vec<ImportedParagraph>> {
        let pb = std::path::PathBuf::from(&p);
        let meta =
            std::fs::metadata(&pb).map_err(|_| AppError::Msg(format!("文件不存在：{p}")))?;
        if meta.len() > MAX_FILE_SIZE {
            return Err(AppError::Msg(
                "文件过大（超过 200MB），请先拆分为多个文件再导入".into(),
            ));
        }
        let ext = pb
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        match ext.as_str() {
            "docx" => import::docx::parse_docx(&pb),
            "txt" | "md" | "markdown" => import::txt::read_txt(&pb),
            other => Err(AppError::Msg(format!(
                "暂不支持的格式：.{other}（当前支持 txt / docx / md）"
            ))),
        }
    })
    .await
    .map_err(|e| AppError::Msg(format!("导入分析任务失败：{e}")))??;

    if paras.iter().all(|p| p.text.trim().is_empty()) {
        return Err(AppError::Msg("文件内容为空".into()));
    }

    let file_name = std::path::Path::new(&path)
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "导入".into());

    // 规则引擎切块
    let mut blocks = detector::detect(&paras);
    // 无结构的整份导入块：标题用文件名
    if blocks.len() == 1 && blocks[0].title.is_empty() {
        blocks[0].title = file_name.clone();
    }

    // 重复检测：库中已有章节 + 本文件内部，双重比对
    let duplicates = {
        // 现有章节指纹索引（导入是一次性操作，全书扫描在毫秒级）
        let existing = state.with_project(|db| -> Result<Vec<(String, String)>> {
            let mut stmt = db
                .conn
                .prepare("SELECT title, content FROM chapters WHERE deleted_at IS NULL")?;
            let mut rows = stmt.query([])?;
            let mut out = Vec::new();
            while let Some(r) = rows.next()? {
                out.push((r.get(0)?, r.get(1)?));
            }
            Ok(out)
        })?;
        let existing_idx = FpIndex::from_contents(existing);
        mark_duplicates(&paras, &blocks, &existing_idx)
    };

    // 组装预览
    let mut chapters = Vec::with_capacity(blocks.len());
    let mut total_word_count: i64 = 0;
    for (i, b) in blocks.iter().enumerate() {
        let full_text: String = paras[b.start..b.end]
            .iter()
            .map(|p| p.text.as_str())
            .collect::<Vec<_>>()
            .join("\n");
        let stats = text::count_text(&full_text);
        total_word_count += stats.words;

        // 预览文本：正文（不含标题行）前 120 字
        let body_start = if b.title_included { b.start + 1 } else { b.start };
        let preview: String = paras[body_start..b.end]
            .iter()
            .map(|p| p.text.trim())
            .filter(|t| !t.is_empty())
            .collect::<Vec<_>>()
            .join("　");
        let preview: String = preview.chars().take(120).collect();

        chapters.push(PreviewChapter {
            index: i,
            title: b.title.clone(),
            confidence: (b.confidence * 100.0).round() / 100.0,
            rule: b.rule.clone(),
            word_count: stats.words,
            preview,
            duplicate_of: duplicates.get(&i).cloned(),
        });
    }

    let paragraphs = paras.iter().filter(|p| !p.text.trim().is_empty()).count() as i64;

    // 缓存分析结果（confirm 时消费）
    let id = new_analysis_id();
    state.import_cache.insert(
        id.clone(),
        CachedAnalysis {
            file_name: file_name.clone(),
            paras,
            blocks,
            created: std::time::Instant::now(),
        },
    );

    Ok(ImportAnalysis {
        id,
        file_name,
        total_word_count,
        paragraphs,
        chapters,
    })
}

/// 锚点长度（非空白字符）：首尾各取这么长的内容做指纹。
/// 120 字足以容纳一段正文，不同章节首/尾 120 字完全相同几乎必为重复。
const ANCHOR_CHARS: usize = 120;

/// 启用锚点检测的最小正文长度（非空白字符）。
/// 更短的块（占位章 / 超短过渡章）锚点稳定性差，只用整块指纹。
const MIN_ANCHOR_LEN: usize = 200;

/// 章节指纹索引（四重）：整块 / 首锚 / 尾锚 / 段落重叠。
///
/// 为什么需要四重（用户反馈：长文档末尾 25% 多发「标题不同但内容重复」）：
/// 1. 网文源文件的重复段常与原始段落边界不一致——防盗重发会增删段落、
///    切分文件会把前一章尾巴带进下一份的开头。整块指纹此时必然失配，
///    而首锚命中 = 开头相同的部分重复，尾锚命中 = 携带了他章结尾的拼接块。
/// 2. 更恶劣的「防盗填充」：源文件后半部分整章被替换为同一段占位内容
///    （章节号递增、正文几乎完全相同，仅首尾一两行有差异），
///    三种指纹全部失配，但段落集合重叠 ≥80%。
///    实测样例：《捡漏》26MB 文件中同一段占位内容重复 456 次。
#[derive(Default)]
struct FpIndex {
    full: std::collections::HashMap<u64, String>,
    head: std::collections::HashMap<u64, String>,
    tail: std::collections::HashMap<u64, String>,
    // 段落重叠倒排索引：段落指纹 → 包含它的章节序号列表。
    // 倒排而非逐对求交：4500 章 × 每章 ~60 段的逐对比较是亿级运算，
    // 倒排只需按查询段落取 postings 计数，复杂度 O(查询段数 × 平均 postings)。
    postings: std::collections::HashMap<u64, Vec<u32>>,
    /// 每章的有效段落数（与 postings 的章节序号对齐）
    para_counts: Vec<usize>,
    /// 每章标题（与 para_counts 对齐）
    titles: Vec<String>,
}

impl FpIndex {
    fn from_contents(items: impl IntoIterator<Item = (String, String)>) -> Self {
        let mut idx = FpIndex::default();
        for (title, content) in items {
            idx.insert(&title, &content);
        }
        idx
    }

    fn insert(&mut self, title: &str, content: &str) {
        self.full
            .entry(text::content_fingerprint(content))
            .or_insert_with(|| title.to_string());
        if let Some((h, t)) = anchor_fingerprints(content) {
            self.head.entry(h).or_insert_with(|| title.to_string());
            self.tail.entry(t).or_insert_with(|| title.to_string());
        }
        // 段落集合索引（短章不建：锚点逻辑已覆盖，且短段落集合噪声大）
        let para_fps = paragraph_fingerprints(content);
        if para_fps.len() >= MIN_OVERLAP_PARAS {
            let ch_idx = self.para_counts.len() as u32;
            for fp in &para_fps {
                self.postings.entry(*fp).or_default().push(ch_idx);
            }
            self.para_counts.push(para_fps.len());
            self.titles.push(title.to_string());
        }
    }

    /// 查找内容对应的已索引章节标题（整块 → 首锚 → 尾锚）
    fn lookup(&self, content: &str) -> Option<&str> {
        let fp = text::content_fingerprint(content);
        if let Some(t) = self.full.get(&fp) {
            return Some(t);
        }
        if let Some((h, t)) = anchor_fingerprints(content) {
            if let Some(title) = self.head.get(&h) {
                return Some(title);
            }
            if let Some(title) = self.tail.get(&t) {
                return Some(title);
            }
        }
        None
    }

    /// 段落重叠检测：与已索引章节共享 ≥80% 有效段落即判重复。
    /// 返回重叠度最高的章节标题。
    fn lookup_overlap(&self, para_fps: &std::collections::HashSet<u64>) -> Option<&str> {
        if para_fps.len() < MIN_OVERLAP_PARAS {
            return None;
        }
        // 倒排计数：每个已索引章节与查询共享多少段落
        let mut shared: std::collections::HashMap<u32, usize> = std::collections::HashMap::new();
        for fp in para_fps {
            if let Some(list) = self.postings.get(fp) {
                for &idx in list {
                    *shared.entry(idx).or_default() += 1;
                }
            }
        }
        let mut best: Option<(f32, u32)> = None;
        for (idx, n_shared) in shared {
            let denom = self.para_counts[idx as usize].max(para_fps.len()) as f32;
            let ratio = n_shared as f32 / denom;
            if ratio >= 0.8 && best.is_none_or(|(br, _)| ratio > br) {
                best = Some((ratio, idx));
            }
        }
        best.map(|(_, idx)| self.titles[idx as usize].as_str())
    }
}

/// 规范化内容 → (首锚指纹, 尾锚指纹)；正文过短返回 None。
/// 指纹本身忽略空白，这里先过滤空白再取锚，保证锚点是「实打实的 120 字」。
fn anchor_fingerprints(content: &str) -> Option<(u64, u64)> {
    let normalized: String = content.chars().filter(|c| !c.is_whitespace()).collect();
    let n = normalized.chars().count();
    if n < MIN_ANCHOR_LEN {
        return None;
    }
    let head: String = normalized.chars().take(ANCHOR_CHARS).collect();
    let tail: String = normalized.chars().skip(n - ANCHOR_CHARS).collect();
    Some((
        text::content_fingerprint(&head),
        text::content_fingerprint(&tail),
    ))
}

/// 启用段落重叠检测的最少有效段落数。
/// 防盗填充章通常有数十段；短章段落太少，重叠比值不稳定。
const MIN_OVERLAP_PARAS: usize = 8;

/// 正文 → 有效段落指纹集合。
/// 「有效」= 非空白字符 ≥ 10：短句（「好。」「嗯。」）在任意章节都常见，
/// 纳入会稀释重叠信号；长段落才是内容指纹的载体。
fn paragraph_fingerprints(content: &str) -> std::collections::HashSet<u64> {
    content
        .split('\n')
        .map(str::trim)
        .filter(|l| l.chars().filter(|c| !c.is_whitespace()).count() >= 10)
        .map(text::content_fingerprint)
        .collect()
}

/// 重复标记：块正文与库中已有章节 / 本文件更早出现的块重复。
///
/// 判定口径与 assemble 的正文提取一致（不含标题行、忽略空白），
/// 因此「标题不同、正文相同」的重复导入会被准确识别；
/// 标题本身不参与指纹——用户反馈的重复场景正是标题各异。
/// 四重判定：整块 → 首锚/尾锚 → 段落重叠（防盗填充兜底）。
fn mark_duplicates(
    paras: &[ImportedParagraph],
    blocks: &[detector::ChapterBlock],
    existing: &FpIndex,
) -> std::collections::HashMap<usize, String> {
    use std::collections::HashMap;

    let mut result = HashMap::new();
    let mut seen_in_file = FpIndex::default(); // 首个（保留）块的指纹索引

    for (i, b) in blocks.iter().enumerate() {
        let body_start = if b.title_included { b.start + 1 } else { b.start };
        let body: String = paras[body_start..b.end]
            .iter()
            .filter(|p| !p.text.trim().is_empty())
            .map(|p| p.text.trim())
            .collect::<Vec<_>>()
            .join("\n");
        // 空正文块不参与重复判定（如只有标题的占位章节）
        if body.is_empty() {
            continue;
        }

        // 1) 与库中已有章节重复（整块 / 首锚 / 尾锚）
        if let Some(title) = existing.lookup(&body) {
            result.insert(i, format!("已有章节《{title}》"));
            continue;
        }
        // 2) 本文件内部重复（保留首个，后续标记）
        if let Some(first_title) = seen_in_file.lookup(&body) {
            result.insert(i, format!("本文件「{first_title}」"));
            continue;
        }
        // 3) 段落重叠（防盗填充：首尾小改、主体相同，指纹全失配时的兜底）
        let para_fps = paragraph_fingerprints(&body);
        if let Some(title) = existing.lookup_overlap(&para_fps) {
            result.insert(i, format!("已有章节《{title}》"));
            continue;
        }
        if let Some(first_title) = seen_in_file.lookup_overlap(&para_fps) {
            result.insert(i, format!("本文件「{first_title}」"));
            continue;
        }
        seen_in_file.insert(&b.title, &body);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::import::ImportedParagraph;

    fn para(text: &str) -> ImportedParagraph {
        ImportedParagraph {
            text: text.into(),
            bold: false,
            centered: false,
            heading: false,
            font_size: None,
        }
    }

    fn build_doc(titles_bodies: &[(&str, &str)]) -> Vec<ImportedParagraph> {
        // 构造带「第X章」标题的结构化文档
        let mut paras = Vec::new();
        for (i, (title, body)) in titles_bodies.iter().enumerate() {
            paras.push(para(&format!("第{}章 {}", i + 1, title)));
            for line in body.split('\n') {
                if !line.trim().is_empty() {
                    paras.push(para(line));
                }
            }
        }
        paras
    }

    #[test]
    fn duplicates_within_file_detected() {
        // 文件内部：第 2 章与第 1 章正文相同（标题不同）
        let paras = build_doc(&[
            ("开端", "林默走进山门。\n他抬头看天。"),
            ("重启", "林默走进山门。\n他抬头看天。"), // 内容重复
            ("新篇", "苏婉立于崖边。"),
        ]);
        let blocks = detector::detect(&paras);
        assert_eq!(blocks.len(), 3);

        let dups = mark_duplicates(&paras, &blocks, &FpIndex::default());
        assert_eq!(dups.len(), 1);
        assert!(dups[&1].contains("本文件"));
        assert!(dups[&1].contains("第1章"));
    }

    #[test]
    fn duplicates_with_existing_library() {
        let paras = build_doc(&[("山门", "林默走进山门。")]);
        let blocks = detector::detect(&paras);

        // 库中已有完全相同内容的章节（不同标题）
        let existing =
            FpIndex::from_contents([("第七章 旧地".to_string(), "林默走进山门。".to_string())]);
        let dups = mark_duplicates(&paras, &blocks, &existing);
        assert_eq!(dups.len(), 1);
        assert!(dups[&0].contains("已有章节"));
        assert!(dups[&0].contains("旧地"));
    }

    #[test]
    fn whitespace_layout_diff_counts_as_duplicate() {
        // 排版差异（空行 / 缩进）仍判定为重复
        let paras = build_doc(&[
            ("一", "林默走进山门。"),
            ("二", "  林默走进山门。  "), // 前后空白不同
        ]);
        let blocks = detector::detect(&paras);
        let dups = mark_duplicates(&paras, &blocks, &FpIndex::default());
        assert_eq!(dups.len(), 1);
    }

    #[test]
    fn unique_content_not_flagged() {
        let paras = build_doc(&[
            ("一", "林默走进山门。"),
            ("二", "苏婉离开山门。"),
        ]);
        let blocks = detector::detect(&paras);
        assert!(mark_duplicates(&paras, &blocks, &FpIndex::default()).is_empty());
    }

    // ========== 三重指纹：边界偏移 / 部分重复（长文档末尾多发场景） ==========

    /// 生成一段可读的假正文（长度可变，保证 ≥ 锚点要求）
    fn fake_body(seed: &str, paragraphs: usize) -> String {
        (0..paragraphs)
            .map(|i| format!("{seed}的第{i}段：少年背起行囊走出山门，沿着山路向北而行，途经树林与溪流，一路风尘仆仆。"))
            .collect::<Vec<_>>()
            .join("\n")
    }

    #[test]
    fn boundary_shifted_duplicate_detected_by_head_anchor() {
        // 用户反馈场景：重复章与库中已有章「开头相同、边界偏移」——
        // 防盗重发增删了尾部段落，整块指纹失配，但首锚命中
        let lib_body = fake_body("青云", 6); // 库中章节正文
        let paras = build_doc(&[
            (
                "新章",
                // 与库中章开头相同，但尾部多出两段（边界偏移）
                format!("{lib_body}\n{}",
                    fake_body("额外", 2)).as_str(),
            ),
            ("后续", &fake_body("其他", 4)),
        ]);
        let blocks = detector::detect(&paras);
        let existing = FpIndex::from_contents([("第99章 旧文".to_string(), lib_body)]);

        let dups = mark_duplicates(&paras, &blocks, &existing);
        assert_eq!(dups.len(), 1, "边界偏移的重复应被首锚检出：{dups:?}");
        assert!(dups[&0].contains("旧文"));
        // 第二块是全新内容，不误判
        assert!(!dups.contains_key(&1));
    }

    #[test]
    fn tail_carryover_from_split_file_detected() {
        // 分批导入场景：切分文件把库中某章的结尾带进了新文件开头的「开篇」块。
        // 开篇块内容 = 上章尾部 → 整块 / 首锚都不同，但尾锚命中
        let lib_body = fake_body("长章", 8);
        let carry = lib_body.split('\n').skip(2).collect::<Vec<_>>().join("\n"); // 上章后 6 段（≥ 锚点阈值）
        let paras = vec![
            // 开篇块（无标题）：携带上章尾部
            para(&carry),
            // 之后是正常新章
            para("第一章 新篇"),
        ]
        .into_iter()
        .chain(
            fake_body("全新", 5)
                .split('\n')
                .map(para),
        )
        .collect::<Vec<_>>();

        let blocks = detector::detect(&paras);
        assert_eq!(blocks.len(), 2); // 开篇 + 第一章
        assert!(!blocks[0].title_included);

        let existing = FpIndex::from_contents([("第50章 上章".to_string(), lib_body)]);
        let dups = mark_duplicates(&paras, &blocks, &existing);
        // 开篇块被标记为与上章重复（尾锚命中），新章不误判
        assert_eq!(dups.len(), 1, "{dups:?}");
        assert!(dups[&0].contains("上章"), "{dups:?}");
    }

    #[test]
    fn in_file_partial_dup_with_added_tail_detected() {
        // 文件内部：第 2 章复制了第 1 章并在末尾追加「作者的话」——
        // 整块指纹不同（多了作者的话），首锚命中
        let base = fake_body("正文", 5);
        let paras = build_doc(&[
            ("原章", &base),
            ("重发", &format!("{base}\n（本章由作者重新整理发布。）")),
            ("别章", &fake_body("独特", 4)),
        ]);
        let blocks = detector::detect(&paras);
        assert_eq!(blocks.len(), 3);

        let dups = mark_duplicates(&paras, &blocks, &FpIndex::default());
        assert_eq!(dups.len(), 1, "部分重复应被首锚检出：{dups:?}");
        assert!(dups[&1].contains("本文件"), "{dups:?}");
    }

    #[test]
    fn distinct_long_chapters_not_flagged() {
        // 长章节间正常的内容差异（首尾都不同）不误判
        let paras = build_doc(&[
            ("一", &fake_body("山雨", 6)),
            ("二", &fake_body("入门", 6)),
            ("三", &fake_body("比试", 6)),
        ]);
        let blocks = detector::detect(&paras);
        assert_eq!(blocks.len(), 3);
        assert!(mark_duplicates(&paras, &blocks, &FpIndex::default()).is_empty());
    }

    #[test]
    fn short_blocks_below_anchor_threshold_use_full_only() {
        // 短块（< 200 字）不启用锚点：开头相似但内容不同的短章不误判
        let a = "短章开头。他进了城，买了两个包子，吃完就走。";
        let b = "短章开头。他出了城，骑马向北，一路无话。";
        let paras = build_doc(&[("甲", a), ("乙", b)]);
        let blocks = detector::detect(&paras);
        assert!(mark_duplicates(&paras, &blocks, &FpIndex::default()).is_empty());
    }

    // ========== 段落重叠：防盗填充场景（实测：同段占位内容重复 456 次） ==========

    #[test]
    fn filler_chapters_flagged_by_paragraph_overlap() {
        // 防盗填充：两章段落集合几乎相同，仅首行/末行被替换
        // —— 整块/首锚/尾锚指纹全部失配，只有段落重叠能检出
        let filler = fake_body("占位", 9);
        let variant_a = format!("首行不同。{filler}");
        let variant_b = format!("{filler}\n末尾被换成另一句话收束全章。");
        let paras = build_doc(&[("前一章", &variant_a), ("后一章", &variant_b)]);
        let blocks = detector::detect(&paras);
        assert_eq!(blocks.len(), 2);

        let dups = mark_duplicates(&paras, &blocks, &FpIndex::default());
        assert_eq!(dups.len(), 1, "防盗填充变体应被段落重叠检出：{dups:?}");
        assert!(dups[&1].contains("本文件"), "{dups:?}");
    }

    #[test]
    fn filler_chapters_flagged_against_library() {
        // 库中已有该内容（同段落集合、首尾有差异）→ 新导入的填充章标「已有章节」
        let filler = fake_body("占位", 9);
        let lib = format!("{filler}\n这是库里版本的结尾。");
        let existing = FpIndex::from_contents([("第88章 库存".to_string(), lib)]);
        let paras = build_doc(&[("导入章", &format!("开头略改。{filler}"))]);
        let blocks = detector::detect(&paras);

        let dups = mark_duplicates(&paras, &blocks, &existing);
        assert_eq!(dups.len(), 1, "{dups:?}");
        assert!(dups[&0].contains("已有章节"), "{dups:?}");
        assert!(dups[&0].contains("库存"), "{dups:?}");
    }

    #[test]
    fn partial_overlap_below_threshold_not_flagged() {
        // 共享中段一半段落的两个不同章节（同一背景不同剧情）不误判。
        // 注意：首/尾必须不同，否则会被首锚/尾锚先行拦截（那是更强信号）。
        let shared = fake_body("共同背景", 5);
        let head_a = fake_body("甲线开场", 2);
        let tail_a = fake_body("甲线收尾", 2);
        let head_b = fake_body("乙线开场", 2);
        let tail_b = fake_body("乙线收尾", 2);
        let paras = build_doc(&[
            ("甲章", &format!("{head_a}\n{shared}\n{tail_a}")),
            ("乙章", &format!("{head_b}\n{shared}\n{tail_b}")),
        ]);
        let blocks = detector::detect(&paras);
        assert_eq!(blocks.len(), 2);
        // 5/9 共享 ≈ 56% < 80% 阈值
        assert!(mark_duplicates(&paras, &blocks, &FpIndex::default()).is_empty());
    }
}

/// 确认导入：按用户调整后的边界组装章节，事务批量落库。
///
/// 两类排除语义（区分「标题不同但内容重复」与「误判边界合并」）：
/// - `excluded`：用户手动取消的边界，正文并入前一章（智能合并）；
/// - `discarded`：重复内容块，正文直接丢弃——已存在于库中，并入邻章
///   会造成「章节名不同但内容重复」（长文档末尾多发）。
#[tauri::command]
pub fn import_confirm(
    state: State<'_, AppState>,
    analysis_id: String,
    excluded: Vec<usize>,
    discarded: Vec<usize>,
    volume_id: Option<i64>,
    new_volume_title: Option<String>,
) -> Result<ImportResult> {
    // 审查 P1-7：先克隆缓存做校验，不提前消费；任何参数 / 落库失败都保留缓存，
    // 用户无需重新分析。
    let cached = state
        .import_cache
        .get_clone(&analysis_id)
        .ok_or_else(|| AppError::Msg("导入会话已过期或已使用，请重新选择文件".into()))?;

    let n_blocks = cached.blocks.len();
    if excluded.iter().chain(discarded.iter()).any(|&i| i >= n_blocks) {
        return Err(AppError::Msg("导入参数无效（边界索引越界）".into()));
    }
    // 组装章节在事务前完成（纯内存，失败不写库、不消费缓存）
    let entries = detector::assemble(&cached.paras, &cached.blocks, &excluded, &discarded);
    if entries.is_empty() {
        return Err(AppError::Msg("没有可导入的章节".into()));
    }

    let result = state.with_project(|db| {
        // 建卷 + 写章全部放进同一个事务：任何一步失败整体回滚，不留空卷
        let tx = db.conn.unchecked_transaction()?;

        // 1) 确定目标卷（事务内创建）
        let vid = match volume_id {
            Some(v) => {
                let exists: i64 = tx.query_row(
                    "SELECT COUNT(*) FROM volumes WHERE id = ?1",
                    params![v],
                    |r| r.get(0),
                )?;
                if exists == 0 {
                    return Err(AppError::Msg("目标卷不存在".into()));
                }
                v
            }
            None => {
                let title = new_volume_title
                    .map(|t| t.trim().to_string())
                    .filter(|t| !t.is_empty())
                    .unwrap_or_else(|| cached.file_name.clone());
                let next: i32 =
                    tx.query_row("SELECT COALESCE(MAX(sort_order), -1) + 1 FROM volumes", [], |r| {
                        r.get(0)
                    })?;
                tx.execute(
                    "INSERT INTO volumes (title, sort_order) VALUES (?1, ?2)",
                    params![title, next],
                )?;
                tx.last_insert_rowid()
            }
        };

        // 2) 章节起始序号
        let base: i32 = tx.query_row(
            "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM chapters WHERE volume_id = ?1 AND deleted_at IS NULL",
            params![vid],
            |r| r.get(0),
        )?;

        // 3) 批量写入章节
        let mut total_words: i64 = 0;
        for (i, (title, content)) in entries.iter().enumerate() {
            let stats = text::count_text(content);
            total_words += stats.words;
            tx.execute(
                "INSERT INTO chapters (volume_id, title, content, word_count, char_count, sort_order)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![vid, title, content, stats.words, stats.chars, base + i as i32],
            )?;
        }
        tx.commit()?;

        Ok(ImportResult {
            volume_id: vid,
            chapter_count: entries.len() as i64,
            word_count: total_words,
        })
    })?;

    // 仅在提交成功后消费缓存（失败保留，可重试无需重新分析）
    state.import_cache.remove(&analysis_id);
    Ok(result)
}

/// 取消导入：显式释放分析缓存，释放大文本占用的内存（审查 P1-7）
#[tauri::command]
pub fn import_cancel(state: State<'_, AppState>, analysis_id: String) -> Result<()> {
    state.import_cache.cancel(&analysis_id);
    Ok(())
}
