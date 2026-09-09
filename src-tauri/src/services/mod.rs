//! 领域服务层：纯计算 / 算法，不碰 DB 与 Tauri（审查 P2-2 分层）。
//! command 层只做输入转换与编排，SQL 收敛在 repositories、算法收敛在 services。

pub mod layout;
