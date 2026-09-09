//! DOCX 解析（文档第十九节）：
//!
//! DOCX 本质是 ZIP 包，正文位于 word/document.xml（OOXML）。
//! 不只提取纯文本，同时读取结构特征：
//! - 段落对齐（w:jc = center → 居中）
//! - 段落样式（w:pStyle = HeadingN / 标题N / Title）
//! - 字号（w:sz，半点单位 → pt）
//! - 加粗（w:b，注意常以空标签 <w:b/> 出现）
//!
//! 这些特征用于章节标题识别的置信度加成：
//! 「24 号 + 加粗 + 居中」的段落明显比正文更可能是章节标题。

use crate::error::{AppError, Result};
use crate::import::ImportedParagraph;
use quick_xml::events::Event;
use quick_xml::Reader;
use std::io::Read;
use std::path::Path;

pub fn parse_docx(path: &Path) -> Result<Vec<ImportedParagraph>> {
    let file =
        std::fs::File::open(path).map_err(|e| AppError::Msg(format!("无法打开 DOCX：{e}")))?;
    let mut zip = zip::ZipArchive::new(file)
        .map_err(|e| AppError::Msg(format!("无效的 DOCX 文件：{e}")))?;
    let mut entry = zip
        .by_name("word/document.xml")
        .map_err(|_| AppError::Msg("DOCX 结构异常：缺少 word/document.xml".into()))?;
    let mut xml = Vec::new();
    entry
        .read_to_end(&mut xml)
        .map_err(|e| AppError::Msg(format!("读取 DOCX 内容失败：{e}")))?;

    parse_document_xml(&xml)
}

fn parse_document_xml(xml: &[u8]) -> Result<Vec<ImportedParagraph>> {
    // document.xml 规范要求 UTF-8 编码，直接按字符串解析
    let s = std::str::from_utf8(xml)
        .map_err(|_| AppError::Msg("document.xml 不是有效的 UTF-8 编码".into()))?;
    let mut reader = Reader::from_str(s);
    reader.config_mut().trim_text(false);

    let mut paras = Vec::new();
    // 当前段落累积状态
    let mut in_para = false;
    let mut text = String::new();
    let mut centered = false;
    let mut bold = false;
    let mut heading = false;
    let mut max_font: Option<f32> = None;

    loop {
        match reader.read_event() {
            Ok(Event::Start(e)) => {
                match e.name().local_name().as_ref() {
                    "p" => {
                        // 新段落开始：重置累积状态
                        in_para = true;
                        text.clear();
                        centered = false;
                        bold = false;
                        heading = false;
                        max_font = None;
                    }
                    "b" => bold = true,
                    _ => handle_attrs(&e, &mut centered, &mut heading, &mut max_font),
                }
            }
            Ok(Event::Empty(e)) => {
                match e.name().local_name().as_ref() {
                    // <w:b/> 加粗常以空标签出现
                    "b" => bold = true,
                    "br" => {
                        if in_para {
                            text.push('\n');
                        }
                    }
                    // w:jc / w:pStyle / w:sz 也常以空标签形式出现（带属性）
                    _ => handle_attrs(&e, &mut centered, &mut heading, &mut max_font),
                }
            }
            Ok(Event::Text(t)) => {
                // quick-xml 0.42：纯文本段（实体引用已拆分为 GeneralRef 事件）
                if in_para {
                    text.push_str(&t);
                }
            }
            Ok(Event::GeneralRef(r)) => {
                // 实体引用（&amp; / &#x4E2D; 等）还原为字符
                if in_para {
                    text.push_str(&resolve_entity(&r));
                }
            }
            Ok(Event::CData(t)) => {
                if in_para {
                    text.push_str(&t);
                }
            }
            Ok(Event::End(e)) => {
                if e.name().local_name().as_ref() == "p" {
                    in_para = false;
                    paras.push(ImportedParagraph {
                        text: text.clone(),
                        bold,
                        centered,
                        heading,
                        font_size: max_font,
                    });
                }
            }
            Ok(Event::Eof) => break,
            Err(e) => return Err(AppError::Msg(format!("DOCX 解析失败：{e}"))),
            _ => {}
        }
    }
    Ok(paras)
}

/// 处理带属性的格式标签（w:jc / w:pStyle / w:sz），Start 与 Empty 两种事件共用
fn handle_attrs(
    e: &quick_xml::events::BytesStart,
    centered: &mut bool,
    heading: &mut bool,
    max_font: &mut Option<f32>,
) {
    match e.name().local_name().as_ref() {
        "jc" => {
            if attr_value(e).is_some_and(|v| v == "center") {
                *centered = true;
            }
        }
        "pStyle" => {
            let v = attr_value(e).unwrap_or_default();
            if v.starts_with("Heading")
                || v.starts_with("heading")
                || v.starts_with("标题")
                || v == "Title"
            {
                *heading = true;
            }
        }
        "sz" => {
            // w:sz 单位为半点（half-points）：val="32" → 16pt
            if let Some(v) = attr_value(e).and_then(|s| s.parse::<f32>().ok()) {
                let pt = v / 2.0;
                if max_font.is_none_or(|m| pt > m) {
                    *max_font = Some(pt);
                }
            }
        }
        _ => {}
    }
}

/// XML 实体引用名 → 实际字符。
/// r 为 `&` 与 `;` 之间的内容，如 "amp"、"#x4E2D"。
fn resolve_entity(name: &str) -> String {
    match name {
        "amp" => "&".into(),
        "lt" => "<".into(),
        "gt" => ">".into(),
        "quot" => "\"".into(),
        "apos" => "'".into(),
        _ => {
            // 数字字符引用：十进制 &#NN; / 十六进制 &#xNN;
            let parsed = if let Some(hex) = name
                .strip_prefix("#x")
                .or_else(|| name.strip_prefix("#X"))
            {
                u32::from_str_radix(hex, 16).ok().and_then(char::from_u32)
            } else if let Some(dec) = name.strip_prefix('#') {
                dec.parse::<u32>().ok().and_then(char::from_u32)
            } else {
                None
            };
            parsed.map_or_else(|| format!("&{name};"), |c| c.to_string())
        }
    }
}

/// 读取元素的 val 属性值
fn attr_value(e: &quick_xml::events::BytesStart) -> Option<String> {
    for a in e.attributes().with_checks(false).flatten() {
        if a.key.local_name().as_ref() == "val" {
            return Some(a.value.into_owned());
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    /// 构造最小合法 DOCX 字节流（内存 ZIP，仅 word/document.xml）
    fn build_docx(xml: &str) -> Vec<u8> {
        let mut w = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
        w.start_file("word/document.xml", zip::write::SimpleFileOptions::default())
            .unwrap();
        w.write_all(xml.as_bytes()).unwrap();
        w.finish().unwrap().into_inner()
    }

    #[test]
    fn parse_and_detect_ten_chapters() {
        let mut xml = String::from(
            r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>"#,
        );
        for i in 1..=10 {
            // 标题段：居中 + 加粗 + 16pt（sz=32 半点）
            xml += &format!(
                r#"<w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:rPr><w:b/><w:sz w:val="32"/></w:rPr><w:t>第{idx}章 测试章节</w:t></w:r></w:p>"#,
                idx = i
            );
            for _ in 0..5 {
                xml += r#"<w:p><w:r><w:t>这是正文段落，包含一些用于测试的中文内容。</w:t></w:r></w:p>"#;
            }
        }
        xml += "</w:body></w:document>";

        let bytes = build_docx(&xml);
        // 写入临时文件，走完整 parse_docx 流程（zip 解压 + XML 解析）
        let tmp = std::env::temp_dir().join(format!(
            "novelforge-test-{}-{p}.docx",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
            p = std::process::id()
        ));
        std::fs::write(&tmp, &bytes).unwrap();
        let paras = parse_docx(&tmp).unwrap();
        let _ = std::fs::remove_file(&tmp);

        // 10 标题 + 50 正文
        assert_eq!(paras.len(), 60);
        assert!(paras[0].centered);
        assert!(paras[0].bold);
        assert_eq!(paras[0].font_size, Some(16.0));
        assert!(!paras[1].centered);

        // 章节识别：应恰好 10 章
        let blocks = crate::import::detector::detect(&paras);
        assert_eq!(blocks.len(), 10);
        assert_eq!(blocks[0].title, "第1章 测试章节");
    }

    #[test]
    fn escapes_xml_entities() {
        let xml = r#"<w:document xmlns:w="http://x"><w:body><w:p><w:r><w:t>A &amp; B &lt;tag&gt; &#x4E2D;</w:t></w:r></w:p></w:body></w:document>"#;
        let paras = parse_document_xml(xml.as_bytes()).unwrap();
        assert_eq!(paras[0].text, "A & B <tag> 中");
    }
}
