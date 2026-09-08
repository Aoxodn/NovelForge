//! 导出系统（文档第四十七、四十八节）：
//!
//! 支持格式：
//! - TXT：UTF-8（带 BOM，兼容旧版 Windows 记事本 / 部分投稿平台）
//! - Markdown：# 书名 / ## 卷名 / ### 章节标题
//! - DOCX：内存生成最小合法 OOXML 包（标题居中加粗、正文首行缩进）
//!
//! 支持范围：全部 / 指定卷 / 指定章节。
//! PDF 涉及排版引擎与中文字体嵌入，按文档精神留待后续版本。

use crate::commands::AppState;
use crate::error::{AppError, Result};
use crate::models::ExportResult;
use rusqlite::params;
use std::io::Write;
use std::path::Path;
use tauri::State;

/// 从数据库读取的待导出章节
struct ExportChapter {
    volume_title: String,
    title: String,
    content: String,
}

/// XML 文本转义（DOCX 生成用）
fn xml_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for ch in s.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            c => out.push(c),
        }
    }
    out
}

/// 生成 DOCX 段落 XML。
/// style: title=居中+加粗+大字号 / subtitle=居中+加粗 / body=首行缩进两字符
fn docx_paragraph(text: &str, style: &str) -> String {
    let escaped = xml_escape(text);
    match style {
        "title" => format!(
            r#"<w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:rPr><w:b/><w:sz w:val="44"/></w:rPr><w:t xml:space="preserve">{escaped}</w:t></w:r></w:p>"#
        ),
        "subtitle" => format!(
            r#"<w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:rPr><w:b/><w:sz w:val="32"/></w:rPr><w:t xml:space="preserve">{escaped}</w:t></w:r></w:p>"#
        ),
        // 正文：首行缩进 2 字符（firstLineChars 单位为 1/100 字符）
        _ => format!(
            r#"<w:p><w:pPr><w:ind w:firstLineChars="200" w:firstLine="420"/></w:pPr><w:r><w:t xml:space="preserve">{escaped}</w:t></w:r></w:p>"#
        ),
    }
}

/// 组装 DOCX 字节流（最小合法 OOXML：[Content_Types].xml + _rels/.rels + word/document.xml）
fn build_docx(book: &str, author: &str, chapters: &[ExportChapter]) -> Vec<u8> {
    let mut body = String::new();
    body.push_str(&docx_paragraph(book, "title"));
    if !author.is_empty() {
        body.push_str(&docx_paragraph(&format!("作者：{author}"), "subtitle"));
    }

    let mut last_volume: Option<&str> = None;
    for ch in chapters {
        if last_volume != Some(ch.volume_title.as_str()) {
            body.push_str(&docx_paragraph(&ch.volume_title, "subtitle"));
            last_volume = Some(ch.volume_title.as_str());
        }
        body.push_str(&docx_paragraph(&ch.title, "subtitle"));
        for line in ch.content.split('\n') {
            if !line.trim().is_empty() {
                body.push_str(&docx_paragraph(line, "body"));
            }
        }
    }

    let document = format!(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>{body}</w:body></w:document>"#
    );

    let content_types = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>"#;

    let rels = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>"#;

    let mut w = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    let opts = zip::write::SimpleFileOptions::default();
    for (name, data) in [
        ("[Content_Types].xml", content_types),
        ("_rels/.rels", rels),
        ("word/document.xml", &document),
    ] {
        w.start_file(name, opts).unwrap();
        w.write_all(data.as_bytes()).unwrap();
    }
    w.finish().unwrap().into_inner()
}

/// 组装 TXT 全文
fn build_txt(book: &str, author: &str, chapters: &[ExportChapter]) -> String {
    let mut out = String::new();
    out.push_str(&format!("《{book}》\n"));
    if !author.is_empty() {
        out.push_str(&format!("作者：{author}\n"));
    }
    out.push_str("\n");

    let mut last_volume: Option<&str> = None;
    for ch in chapters {
        if last_volume != Some(ch.volume_title.as_str()) {
            out.push_str(&format!("\n══════ {} ══════\n\n", ch.volume_title));
            last_volume = Some(ch.volume_title.as_str());
        }
        out.push_str(&ch.title);
        out.push_str("\n\n");
        out.push_str(&ch.content);
        out.push_str("\n\n\n");
    }
    out
}

/// 组装 Markdown 全文
fn build_md(book: &str, author: &str, chapters: &[ExportChapter]) -> String {
    let mut out = String::new();
    out.push_str(&format!("# {book}\n\n"));
    if !author.is_empty() {
        out.push_str(&format!("> 作者：{author}\n\n"));
    }

    let mut last_volume: Option<&str> = None;
    for ch in chapters {
        if last_volume != Some(ch.volume_title.as_str()) {
            out.push_str(&format!("\n## {}\n\n", ch.volume_title));
            last_volume = Some(ch.volume_title.as_str());
        }
        out.push_str(&format!("### {}\n\n", ch.title));
        out.push_str(&ch.content);
        out.push_str("\n\n");
    }
    out
}

/// 导出命令。
/// format: "txt" | "docx" | "md"；scope: "all" | "volume" | "chapter"
#[tauri::command]
pub fn export_novel(
    state: State<'_, AppState>,
    format: String,
    scope: String,
    volume_id: Option<i64>,
    chapter_id: Option<i64>,
    output_path: String,
) -> Result<ExportResult> {
    state.with_project(|db| {
        // 1) 按范围查询章节（卷序 + 章序全局排序；回收站章节不进成稿）
        let (sql, binds): (&str, Vec<i64>) = match scope.as_str() {
            "volume" => {
                let v = volume_id
                    .ok_or_else(|| AppError::Msg("导出范围缺少卷参数".into()))?;
                (
                    "SELECT v.title, c.title, c.content
                     FROM chapters c JOIN volumes v ON c.volume_id = v.id
                     WHERE c.volume_id = ?1 AND c.deleted_at IS NULL
                     ORDER BY v.sort_order, c.sort_order, c.id",
                    vec![v],
                )
            }
            "chapter" => {
                let c = chapter_id
                    .ok_or_else(|| AppError::Msg("导出范围缺少章节参数".into()))?;
                (
                    "SELECT v.title, c.title, c.content
                     FROM chapters c JOIN volumes v ON c.volume_id = v.id
                     WHERE c.id = ?1 AND c.deleted_at IS NULL",
                    vec![c],
                )
            }
            _ => (
                "SELECT v.title, c.title, c.content
                 FROM chapters c JOIN volumes v ON c.volume_id = v.id
                 WHERE c.deleted_at IS NULL
                 ORDER BY v.sort_order, c.sort_order, c.id",
                vec![],
            ),
        };

        let mut stmt = db.conn.prepare(sql)?;
        let mut rows = match binds.len() {
            1 => stmt.query(params![binds[0]])?,
            _ => stmt.query([])?,
        };

        let mut chapters = Vec::new();
        while let Some(row) = rows.next()? {
            chapters.push(ExportChapter {
                volume_title: row.get(0)?,
                title: row.get(1)?,
                content: row.get(2)?,
            });
        }
        drop(rows);
        drop(stmt);

        if chapters.is_empty() {
            return Err(AppError::Msg("所选范围内没有可导出的章节".into()));
        }

        // 2) 项目信息
        let (book, author): (String, String) = db.conn.query_row(
            "SELECT name, author FROM project_info WHERE id = 1",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;

        let total_words: i64 = chapters
            .iter()
            .map(|c| crate::text::count_text(&c.content).words)
            .sum();

        // 3) 生成并写文件
        let out_path = Path::new(&output_path);
        if let Some(parent) = out_path.parent() {
            std::fs::create_dir_all(parent)?;
        }

        match format.as_str() {
            "txt" => {
                // 带 BOM 的 UTF-8：最大化旧软件兼容性
                let mut bytes = vec![0xEF, 0xBB, 0xBF];
                bytes.extend_from_slice(build_txt(&book, &author, &chapters).as_bytes());
                std::fs::write(out_path, bytes)?;
            }
            "md" => {
                std::fs::write(out_path, build_md(&book, &author, &chapters))?;
            }
            "docx" => {
                std::fs::write(out_path, build_docx(&book, &author, &chapters))?;
            }
            other => return Err(AppError::Msg(format!("不支持的导出格式：{other}"))),
        }

        Ok(ExportResult {
            path: output_path,
            chapter_count: chapters.len() as i64,
            word_count: total_words,
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn docx_roundtrip() {
        // 生成的 DOCX 必须能被我们自己的解析器读回（验证结构合法性）
        let chapters = vec![
            ExportChapter {
                volume_title: "第一卷".into(),
                title: "第一章 <开端>".into(),
                content: "林默说：\"你好 & 再见。\"\n第二段内容。".into(),
            },
            ExportChapter {
                volume_title: "第一卷".into(),
                title: "第二章 转折".into(),
                content: "本章内容。".into(),
            },
        ];
        let bytes = build_docx("测试书", "测试者", &chapters);

        let tmp = std::env::temp_dir().join(format!(
            "novelforge-export-test-{}.docx",
            std::process::id()
        ));
        std::fs::write(&tmp, &bytes).unwrap();
        let paras = crate::import::docx::parse_docx(&tmp).unwrap();
        let _ = std::fs::remove_file(&tmp);

        // 书名 / 作者 / 卷名 / 两个标题 / 3 个正文段
        assert_eq!(paras[0].text, "测试书");
        assert!(paras[0].centered && paras[0].bold);
        assert_eq!(paras[1].text, "作者：测试者");
        assert_eq!(paras[2].text, "第一卷");
        assert_eq!(paras[3].text, "第一章 <开端>"); // XML 转义往返无损
        assert_eq!(paras[4].text, "林默说：\"你好 & 再见。\"");
        assert_eq!(paras[6].text, "第二章 转折");
    }

    #[test]
    fn txt_and_md_content() {
        let chapters = vec![ExportChapter {
            volume_title: "正文".into(),
            title: "第一章 开始".into(),
            content: "第一段。\n第二段。".into(),
        }];
        let txt = build_txt("书名", "作者甲", &chapters);
        assert!(txt.contains("《书名》"));
        assert!(txt.contains("作者：作者甲"));
        assert!(txt.contains("══════ 正文 ══════"));
        assert!(txt.contains("第一章 开始"));

        let md = build_md("书名", "", &chapters);
        assert!(md.contains("# 书名"));
        assert!(md.contains("## 正文"));
        assert!(md.contains("### 第一章 开始"));
        assert!(!md.contains("作者：")); // 空作者不输出
    }
}
