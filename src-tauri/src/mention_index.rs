//! 全局提及匹配器（审查 P1-4 / P1-5）。
//!
//! 旧实现为每个人物 / 地点独立编译正则、独立扫描，导致：
//!   1. 跨角色重复计数——同时存在「苏婉」「苏婉清」时，「苏婉清」被两人各计一次；
//!   2. 每次保存为每个实体重新编译正则，角色越多保存越慢。
//!
//! 本模块把**同一类**全部实体的匹配词拼成一条正则交替式，按词长降序排列，
//! 利用正则 leftmost-longest 语义让每个命中区间只归属唯一一个实体，
//! 从根上消除跨角色双计数；一次扫描得到全部实体计数。
//!
//! 编译结果按「实体词指纹」进程级缓存：只有当某个角色改名 / 改别名 / 改排除词
//! 后指纹变化才重新编译，普通正文保存直接复用，保存复杂度与角色数解耦。

use regex::Regex;
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

/// 一个实体的匹配信息：id + 全部匹配词（名字/别名）+ 误判排除词
#[derive(Clone)]
pub struct EntityPatterns {
    pub id: i64,
    pub patterns: Vec<String>,
    pub excludes: Vec<String>,
}

/// 单类实体（人物 或 地点）的全局匹配器
pub struct MentionMatcher {
    /// 无任何实体词时为 None（count 直接返回空）
    regex: Option<Regex>,
    /// 命中文本 → 唯一归属实体 id
    text_to_id: HashMap<String, i64>,
    /// 全局并集的误判排除词（等长抹空格，主要服务单字名）
    excludes: Vec<String>,
    /// 同一称谓被多个实体声明：(称谓, 先到 id, 后到 id)，供冲突检测 UI 使用
    pub conflicts: Vec<(String, i64, i64)>,
}

impl MentionMatcher {
    /// 由全部实体构建。patterns 会 trim、去空、按词长降序确定优先级。
    pub fn build(entities: &[EntityPatterns]) -> Self {
        let mut text_to_id: HashMap<String, i64> = HashMap::new();
        let mut conflicts: Vec<(String, i64, i64)> = Vec::new();
        let mut excludes: Vec<String> = Vec::new();

        // 先按 id 排序，保证同一称谓冲突时归属确定（id 小者），结果可复现
        let mut ordered: Vec<&EntityPatterns> = entities.iter().collect();
        ordered.sort_by_key(|e| e.id);

        for e in ordered {
            for w in &e.excludes {
                let w = w.trim();
                if !w.is_empty() {
                    excludes.push(w.to_string());
                }
            }
            for p in &e.patterns {
                let p = p.trim();
                if p.is_empty() {
                    continue;
                }
                match text_to_id.get(p) {
                    Some(&other) if other != e.id => {
                        // 共享称谓：先注册者保留归属，登记冲突让用户裁决
                        if !conflicts.iter().any(|(t, a, b)| t == p && *a == other && *b == e.id) {
                            conflicts.push((p.to_string(), other, e.id));
                        }
                    }
                    _ => {
                        text_to_id.entry(p.to_string()).or_insert(e.id);
                    }
                }
            }
        }

        // 词长降序 → 同一起点长词优先（苏婉清 先于 苏婉）；等长按字典序保证确定性
        let mut texts: Vec<&str> = text_to_id.keys().map(String::as_str).collect();
        texts.sort_by(|a, b| {
            b.chars()
                .count()
                .cmp(&a.chars().count())
                .then_with(|| a.cmp(b))
        });
        texts.dedup();

        let regex = if texts.is_empty() {
            None
        } else {
            let alt = texts
                .iter()
                .map(|t| regex::escape(t))
                .collect::<Vec<_>>()
                .join("|");
            Regex::new(&alt).ok()
        };

        excludes.sort();
        excludes.dedup();

        Self {
            regex,
            text_to_id,
            excludes,
            conflicts,
        }
    }

    /// 对单章正文计数：返回 entity_id → 次数（每个文本区间只计一次，唯一归属）
    pub fn count(&self, content: &str) -> HashMap<i64, i64> {
        let mut out: HashMap<i64, i64> = HashMap::new();
        for (_, _, id) in self.spans(content) {
            *out.entry(id).or_insert(0) += 1;
        }
        out
    }

    /// 返回全部命中的字节区间与唯一归属实体 id（leftmost-longest）。
    /// 与 count 不同，这里**不做等长空格替换**（CJK 替换会改变字节偏移），
    /// 而是先找出排除词区间，再丢弃与之重叠的命中，保证区间可用于切片 / 替换。
    pub fn spans(&self, content: &str) -> Vec<(usize, usize, i64)> {
        let mut out = Vec::new();
        let Some(regex) = self.regex.as_ref() else {
            return out;
        };
        if content.is_empty() || self.text_to_id.is_empty() {
            return out;
        }
        // 排除词字节区间
        let mut ex_ranges: Vec<(usize, usize)> = Vec::new();
        for w in &self.excludes {
            if w.is_empty() {
                continue;
            }
            let mut start = 0;
            while let Some(rel) = content[start..].find(w.as_str()) {
                let s = start + rel;
                let e = s + w.len();
                ex_ranges.push((s, e));
                start = e.max(start + 1);
            }
        }
        for m in regex.find_iter(content) {
            let (s, e) = (m.start(), m.end());
            // 落在排除词内的命中跳过
            if ex_ranges.iter().any(|(a, b)| s < *b && *a < e) {
                continue;
            }
            if let Some(&id) = self.text_to_id.get(m.as_str()) {
                out.push((s, e, id));
            }
        }
        out
    }

}

/// 把误判词替换成等长空格（保持其它字符位置不变）
#[allow(dead_code)]
fn blank_excludes(content: &str, excludes: &[String]) -> String {
    let mut s = content.to_string();
    for w in excludes {
        let pad: String = w.chars().map(|_| ' ').collect();
        if s.contains(w.as_str()) {
            s = s.replace(w.as_str(), &pad);
        }
    }
    s
}

// ---------- 进程级缓存：人物 + 地点两个匹配器，按实体词指纹复用 ----------

use std::sync::Arc;

struct MatcherCache {
    signature: u64,
    chars: Arc<MentionMatcher>,
    locs: Arc<MentionMatcher>,
}

static CACHE: OnceLock<Mutex<Option<MatcherCache>>> = OnceLock::new();

fn cache_cell() -> &'static Mutex<Option<MatcherCache>> {
    CACHE.get_or_init(|| Mutex::new(None))
}

/// FNV-1a 指纹：把全部实体词纳入，任一改名 / 别名 / 排除词变化都会改变
fn signature_of(chars: &[EntityPatterns], locs: &[EntityPatterns]) -> u64 {
    let mut h: u64 = 0xcbf29ce484222325;
    let feed = |s: &str, h: &mut u64| {
        for b in s.bytes() {
            *h ^= b as u64;
            *h = h.wrapping_mul(0x100000001b3);
        }
        *h ^= 0xff; // 分隔符，避免相邻词拼接碰撞
        *h = h.wrapping_mul(0x100000001b3);
    };
    for e in chars.iter().chain(locs.iter()) {
        feed(&e.id.to_string(), &mut h);
        for p in &e.patterns {
            feed(p, &mut h);
        }
        for x in &e.excludes {
            feed(x, &mut h);
        }
    }
    h
}

/// 计数句柄：自持一份 Arc 匹配器，正确性不依赖全局缓存
/// （并行测试 / 缓存被其它项目改写时仍能正确计数）。
pub struct MentionMatcherHandle {
    matcher: Arc<MentionMatcher>,
}

impl MentionMatcherHandle {
    pub fn count(&self, content: &str) -> HashMap<i64, i64> {
        self.matcher.count(content)
    }
}

/// 取得（必要时构建并缓存）人物 / 地点匹配器。
/// 实体词指纹与缓存一致时直接复用已编译的 Arc（零编译）；
/// 否则重新构建并回写缓存。返回的句柄自持 Arc，调用期间始终有效。
pub fn matchers_for(
    chars: Vec<EntityPatterns>,
    locs: Vec<EntityPatterns>,
) -> (MentionMatcherHandle, MentionMatcherHandle) {
    let sig = signature_of(&chars, &locs);
    let mut guard = cache_cell().lock().unwrap_or_else(|p| p.into_inner());
    let (cm, lm) = match guard.as_ref() {
        Some(c) if c.signature == sig => (Arc::clone(&c.chars), Arc::clone(&c.locs)),
        _ => {
            let cm = Arc::new(MentionMatcher::build(&chars));
            let lm = Arc::new(MentionMatcher::build(&locs));
            *guard = Some(MatcherCache {
                signature: sig,
                chars: Arc::clone(&cm),
                locs: Arc::clone(&lm),
            });
            (cm, lm)
        }
    };
    drop(guard);
    (MentionMatcherHandle { matcher: cm }, MentionMatcherHandle { matcher: lm })
}

/// 实体词发生变化（增删改人物 / 地点）时主动作废缓存
pub fn invalidate_cache() {
    if let Some(cell) = CACHE.get() {
        let mut g = cell.lock().unwrap_or_else(|p| p.into_inner());
        *g = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ep(id: i64, pats: &[&str], exc: &[&str]) -> EntityPatterns {
        EntityPatterns {
            id,
            patterns: pats.iter().map(|s| s.to_string()).collect(),
            excludes: exc.iter().map(|s| s.to_string()).collect(),
        }
    }

    #[test]
    fn nested_names_counted_once_longest_wins() {
        // 苏婉(id1) 与 苏婉清(id2) 同时存在：「苏婉清」只能归 id2，不能再给 id1
        let m = MentionMatcher::build(&[ep(1, &["苏婉"], &[]), ep(2, &["苏婉清"], &[])]);
        let r = m.count("苏婉清来了，苏婉走了。");
        assert_eq!(r.get(&2).copied().unwrap_or(0), 1, "苏婉清归 id2");
        assert_eq!(r.get(&1).copied().unwrap_or(0), 1, "独立的苏婉归 id1");
    }

    #[test]
    fn alias_belongs_to_single_owner() {
        let m = MentionMatcher::build(&[ep(1, &["林默", "默儿"], &[])]);
        let r = m.count("林默和默儿");
        assert_eq!(r.get(&1).copied().unwrap_or(0), 2);
    }

    #[test]
    fn shared_alias_conflict_recorded() {
        let m = MentionMatcher::build(&[ep(1, &["阿七"], &[]), ep(2, &["阿七"], &[])]);
        assert_eq!(m.conflicts.len(), 1, "共享称谓应登记冲突");
        // 归属确定且唯一（id 小者）
        let r = m.count("阿七");
        assert_eq!(r.values().sum::<i64>(), 1);
    }

    #[test]
    fn single_char_exclusion_still_works_globally() {
        let m = MentionMatcher::build(&[ep(1, &["简"], &["简单", "简历"])]);
        let r = m.count("简走进来，这很简单，简看简历，简笑了。");
        assert_eq!(r.get(&1).copied().unwrap_or(0), 3);
    }

    #[test]
    fn cache_reuses_when_unchanged() {
        let chars = vec![ep(1, &["林默"], &[])];
        let locs = vec![ep(9, &["青云宗"], &[])];
        let (c1, l1) = matchers_for(chars.clone(), locs.clone());
        assert_eq!(c1.count("林默在青云宗").get(&1).copied().unwrap_or(0), 1);
        let (c2, l2) = matchers_for(chars, locs);
        // 实体未变时复用同一编译产物（Arc 指针相同），零重新编译
        assert!(Arc::ptr_eq(&c1.matcher, &c2.matcher), "应复用缓存匹配器");
        assert!(Arc::ptr_eq(&l1.matcher, &l2.matcher));
        assert_eq!(l1.count("林默在青云宗").get(&9).copied().unwrap_or(0), 1);
    }
}
