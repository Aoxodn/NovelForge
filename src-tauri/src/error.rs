use serde::Serialize;

/// 全局错误类型。对前端序列化为结构化对象 `{ code, message, retryable }`
/// （审查 P2-3）：前端可据 retryable 决定是否展示「重试」，而不必解析字符串。
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

/// 序列化到前端的结构化错误
#[derive(Serialize)]
struct ErrorPayload {
    /// 机器可读错误码：db / io / json / business
    code: &'static str,
    /// 人类可读信息（与 Display 一致）
    message: String,
    /// 是否值得让用户「重试」（锁竞争 / IO 瞬时错误为 true，参数类业务错误为 false）
    retryable: bool,
}

impl AppError {
    fn code(&self) -> &'static str {
        match self {
            AppError::Db(_) => "db",
            AppError::Io(_) => "io",
            AppError::Json(_) => "json",
            AppError::Msg(_) => "business",
        }
    }

    fn retryable(&self) -> bool {
        match self {
            // SQLite 忙 / 锁是瞬时的，可重试；其它数据库错误不盲目重试
            AppError::Db(rusqlite::Error::SqliteFailure(err, _)) => matches!(
                err.code,
                rusqlite::ErrorCode::DatabaseBusy | rusqlite::ErrorCode::DatabaseLocked
            ),
            AppError::Io(_) => true,
            _ => false,
        }
    }
}

// Tauri 2 要求 command 返回的错误实现 Serialize
impl Serialize for AppError {
    fn serialize<S: serde::Serializer>(
        &self,
        serializer: S,
    ) -> std::result::Result<S::Ok, S::Error> {
        ErrorPayload {
            code: self.code(),
            message: self.to_string(),
            retryable: self.retryable(),
        }
        .serialize(serializer)
    }
}

pub type Result<T> = std::result::Result<T, AppError>;

#[allow(dead_code)]
pub fn msg<T: ToString>(m: T) -> AppError {
    AppError::Msg(m.to_string())
}
