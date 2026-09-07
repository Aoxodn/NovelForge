//! 随机取名命令（阶段 6，0.7.0 扩展）：薄封装，生成逻辑见 [`crate::names`]。

use crate::error::{AppError, Result};
use crate::names::{self, NameOptions};

/// 批量生成名字。count 1-50。
///
/// kind: person / place / sect / technique / item / pill / beast / plant；
/// 其余参数仅 person 使用（国家 / 性别 / 姓数 / 指定姓氏与名字）。
#[tauri::command]
pub fn generate_names(
    kind: String,
    count: Option<usize>,
    gender: Option<String>,
    country: Option<String>,
    surname_type: Option<String>,
    surname: Option<String>,
    given: Option<String>,
) -> Result<Vec<String>> {
    const KINDS: &[&str] = &[
        "person", "place", "sect", "technique", "item", "pill", "beast", "plant",
    ];
    if !KINDS.contains(&kind.as_str()) {
        return Err(AppError::Msg(format!(
            "未知的取名类型「{kind}」（可选：person / place / sect / technique / item / pill / beast / plant）"
        )));
    }
    Ok(names::generate(
        &NameOptions {
            kind,
            gender,
            country,
            surname_type,
            surname,
            given,
        },
        count.unwrap_or(10),
    ))
}
