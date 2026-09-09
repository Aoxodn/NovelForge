//! 智能导入模块（文档第十六至二十四节）：
//!
//! ```text
//! TXT / DOCX / MD 读取 → 章节识别规则引擎 → 预览确认 → 事务落库
//! ```
//!
//! 设计要点：
//! - 分析（重 IO/正则计算）在 spawn_blocking 后台线程执行，不阻塞 UI
//! - 分析结果缓存在 Rust 侧（ImportCache），确认时只需回传
//!   「会话 id + 被取消的边界」，避免大文本经前端往返传输
//! - 用户确认前不写任何数据（预览-确认-落库三段式）

pub mod detector;
pub mod docx;
pub mod txt;

#[cfg(test)]
mod sample_test;

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Instant;

/// 从文档解析出的段落。
/// TXT/MD 只有文本；DOCX 额外携带格式特征，供章节识别置信度加成。
#[derive(Clone)]
pub struct ImportedParagraph {
    pub text: String,
    /// 是否加粗（段落内任一 run 加粗即视为加粗）
    pub bold: bool,
    /// 是否居中对齐
    pub centered: bool,
    /// 是否应用了 Word 标题样式（Heading / 标题N / Title）
    pub heading: bool,
    /// 最大字号（pt），仅 DOCX
    pub font_size: Option<f32>,
}

/// 一次导入分析的结果缓存（commit 成功后才消费删除）
#[derive(Clone)]
pub struct CachedAnalysis {
    pub file_name: String,
    pub paras: Vec<ImportedParagraph>,
    pub blocks: Vec<detector::ChapterBlock>,
    pub created: Instant,
}

/// 分析会话缓存：容量与时效双重限制，防止大文本长期滞留内存。
pub struct ImportCache {
    map: Mutex<HashMap<String, CachedAnalysis>>,
}

const MAX_ENTRIES: usize = 8;
const MAX_AGE_SECS: u64 = 30 * 60;

impl Default for ImportCache {
    fn default() -> Self {
        Self::new()
    }
}

impl ImportCache {
    pub fn new() -> Self {
        Self {
            map: Mutex::new(HashMap::new()),
        }
    }

    pub fn insert(&self, id: String, entry: CachedAnalysis) {
        let mut m = self.map.lock().unwrap();
        // 先清理过期会话
        m.retain(|_, v| v.created.elapsed().as_secs() < MAX_AGE_SECS);
        // 容量满时淘汰最旧
        if m.len() >= MAX_ENTRIES {
            if let Some(oldest) = m.iter().min_by_key(|(_, v)| v.created).map(|(k, _)| k.clone()) {
                m.remove(&oldest);
            }
        }
        m.insert(id, entry);
    }

    pub fn remove(&self, id: &str) -> Option<CachedAnalysis> {
        self.map.lock().unwrap().remove(id)
    }

    /// 取一份缓存克隆而不移除（用于先校验 / 落库成功后再 remove）
    pub fn get_clone(&self, id: &str) -> Option<CachedAnalysis> {
        self.map.lock().unwrap().get(id).cloned()
    }

    /// 取消导入：显式释放该会话缓存（审查 P1-7）
    pub fn cancel(&self, id: &str) -> bool {
        self.map.lock().unwrap().remove(id).is_some()
    }
}
