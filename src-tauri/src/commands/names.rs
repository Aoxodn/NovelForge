//! 随机取名命令（阶段 6）：薄封装，生成逻辑见 [`crate::names`]。

use crate::error::{AppError, Result};
use crate::names;

/// 批量生成名字。kind: male / female / sect / place；count 1-50。
#[tauri::command]
pub fn generate_names(kind: String, count: Option<usize>) -> Result<Vec<String>> {
    const KINDS: &[&str] = &["male", "female", "sect", "place"];
    if !KINDS.contains(&kind.as_str()) {
        return Err(AppError::Msg(format!(
            "未知的取名类型「{kind}」（可选：男名 male / 女名 female / 门派 sect / 地点 place）"
        )));
    }
    Ok(names::generate(&kind, count.unwrap_or(10)))
}
