//! 随机取名命令（阶段 6，0.7.0 扩展）：薄封装，生成逻辑见 [`crate::names`]。

use crate::error::{AppError, Result};
use crate::names::{self, NameOptions};

/// 批量生成名字。count 1-50。
///
/// kind: person / place / sect / technique / item / pill / beast / plant；
/// genre 仅组合类使用（题材词典键，缺省玄幻；未建设题材返回空列表）；
/// 其余参数仅 person 使用（国家 / 性别 / 姓数 / 指定姓氏与名字）。
#[tauri::command]
pub fn generate_names(
    kind: String,
    count: Option<usize>,
    genre: Option<String>,
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
    if kind != "person" {
        let g = genre.as_deref().unwrap_or("xuanhuan");
        if !crate::names_dict::genre_ready(g) {
            return Err(AppError::Msg(format!(
                "题材「{g}」的命名词典尚未建设，敬请期待"
            )));
        }
    }
    Ok(names::generate(
        &NameOptions {
            kind,
            genre,
            gender,
            country,
            surname_type,
            surname,
            given,
        },
        count.unwrap_or(10),
    ))
}

/// 题材清单（含词典建设状态）：前端渲染题材下拉 / 置灰未建设题材。
#[tauri::command]
pub fn list_name_genres() -> Vec<crate::models::NameGenre> {
    crate::names_dict::GENRES
        .iter()
        .map(|g| crate::models::NameGenre {
            key: g.key.into(),
            label: g.label.into(),
            core: g.core,
            ready: g.ready,
        })
        .collect()
}
