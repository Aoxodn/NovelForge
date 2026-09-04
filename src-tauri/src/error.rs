use serde::Serialize;

/// 全局错误类型：所有 Tauri command 的错误统一序列化为可读字符串传给前端
#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("数据库错误: {0}")]
    Db(#[from] rusqlite::Error),

    #[error("文件系统错误: {0}")]
    Io(#[from] std::io::Error),

    #[error("数据格式错误: {0}")]
    Json(#[from] serde_json::Error),

    #[error("{0}")]
    Msg(String),
}

// Tauri 2 要求 command 返回的错误实现 Serialize
impl Serialize for AppError {
    fn serialize<S: serde::Serializer>(
        &self,
        serializer: S,
    ) -> std::result::Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}

pub type Result<T> = std::result::Result<T, AppError>;

#[allow(dead_code)]
pub fn msg<T: ToString>(m: T) -> AppError {
    AppError::Msg(m.to_string())
}
