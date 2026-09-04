//! 真实样例文件的端到端识别验证。
//!
//! 样例位于 `scripts/testdata/`：
//! - `示例小说-十章.txt`  UTF-8 中文小说（开篇 + 十章）
//! - `sample-novel.docx`  由 gen-testdata.ps1 生成（居中+加粗标题）
//!
//! 该测试验证「读取 → 规则引擎 → 切块」完整链路，
//! 与用户在 UI 中导入同一文件的结果一致。

use crate::import::docx;
use crate::import::txt;

fn testdata_dir() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../scripts/testdata")
}

fn find_ext(ext: &str) -> Option<std::path::PathBuf> {
    let dir = testdata_dir();
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return None;
    };
    entries
        .flatten()
        .find(|e| e.path().extension().and_then(|x| x.to_str()) == Some(ext))
        .map(|e| e.path())
}

#[test]
fn real_txt_sample_detects_ten_chapters_plus_leading() {
    let Some(path) = find_ext("txt") else {
        return; // 样例文件不存在时跳过（非开发环境）
    };
    let paras = txt::read_txt(&path).unwrap();
    let blocks = crate::import::detector::detect(&paras);

    // 开篇块 + 十章
    assert_eq!(blocks.len(), 11, "应为开篇 + 10 章，实际 {blocks:?}",);
    assert_eq!(blocks[0].title, "开篇");
    assert_eq!(blocks[1].title, "第一章 山雨欲来");
    assert_eq!(blocks[10].title, "第十章 下山");
    // 中文章节高置信度
    assert!(blocks[1].confidence >= 0.99);
}

#[test]
fn real_docx_sample_detects_ten_chapters_plus_leading() {
    let Some(path) = find_ext("docx") else {
        return;
    };
    let paras = docx::parse_docx(&path).unwrap();
    assert!(!paras.is_empty());

    let blocks = crate::import::detector::detect(&paras);
    assert_eq!(blocks.len(), 11, "应为开篇 + 10 章，实际 {blocks:?}",);
    assert_eq!(blocks[1].title, "第一章 山雨欲来");
    // DOCX 标题带格式加成，应为满分
    assert!((blocks[1].confidence - 1.0).abs() < 1e-5);

    // 组装（不排除任何块）应得到 11 个章节
    let entries = crate::import::detector::assemble(&paras, &blocks, &[], &[]);
    assert_eq!(entries.len(), 11);
    assert!(entries[1].1.contains("青云山巅"));
}
