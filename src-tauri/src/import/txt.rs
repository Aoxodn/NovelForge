//! TXT / MD 读取：编码自动检测（文档第十六节）。
//!
//! 检测顺序：UTF-8 BOM → UTF-16 BOM → UTF-8 严格校验 → GBK。
//! 国内写作软件导出的 TXT 常见 GBK 编码，必须支持。

use crate::error::{AppError, Result};
use crate::import::ImportedParagraph;
use std::path::Path;

pub fn read_txt(path: &Path) -> Result<Vec<ImportedParagraph>> {
    let data = std::fs::read(path).map_err(|e| AppError::Msg(format!("无法读取文件：{e}")))?;
    let text = decode(&data);
    // 按行切段（保留行首全角缩进，仅去行尾空白）
    Ok(text
        .lines()
        .map(|line| ImportedParagraph {
            text: line.trim_end().to_string(),
            bold: false,
            centered: false,
            heading: false,
            font_size: None,
        })
        .collect())
}

/// 字节流 → 字符串，自动识别编码
fn decode(data: &[u8]) -> String {
    if data.starts_with(&[0xEF, 0xBB, 0xBF]) {
        return String::from_utf8_lossy(&data[3..]).into_owned();
    }
    if data.starts_with(&[0xFF, 0xFE]) {
        let (cow, _, _) = encoding_rs::UTF_16LE.decode(&data[2..]);
        return cow.into_owned();
    }
    if data.starts_with(&[0xFE, 0xFF]) {
        let (cow, _, _) = encoding_rs::UTF_16BE.decode(&data[2..]);
        return cow.into_owned();
    }
    if let Ok(s) = std::str::from_utf8(data) {
        return s.to_string();
    }
    // 兜底按 GBK 解码（非法字节替换为 U+FFFD，尽量还原）
    let (cow, _, _) = encoding_rs::GBK.decode(data);
    cow.into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decode_utf8_and_gbk() {
        let utf8 = "第一章 少年".as_bytes().to_vec();
        assert_eq!(decode(&utf8), "第一章 少年");

        // "第一章" 的 GBK 编码
        let (gbk_bytes, _, had_errors) = encoding_rs::GBK.encode("第一章 GBK测试");
        assert!(!had_errors);
        assert_eq!(decode(&gbk_bytes), "第一章 GBK测试");
    }

    #[test]
    fn decode_with_bom() {
        let mut v = vec![0xEF, 0xBB, 0xBF];
        v.extend_from_slice("带BOM的文本".as_bytes());
        assert_eq!(decode(&v), "带BOM的文本");
    }
}
