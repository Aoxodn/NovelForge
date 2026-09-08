//! 随机取名生成器（阶段 6，0.7.0 扩展）：人名 / 门派 / 地点 / 功法 / 装备 / 丹药 / 动物 / 植物。
//!
//! 纯本地组合生成：确定性随机（xorshift），无任何智能成分。
//! 中文人名词典迁移至 [`crate::names_person`]（开源 MIT 词库二次整理，
//! 姓 / 男字 / 女字 / 中间虚字规模大幅扩充）；非人名（组合类）词典按题材拆分至
//! [`crate::names_dict`]，每题材 7 类「前缀 + 后缀」，按题材审美逐批建设。

use crate::names_person::{
    COMPOUND_SURNAMES, FEMALE_CHARS, MALE_CHARS, MIDDLE_CHARS, SURNAMES,
};

/// 日式姓氏（汉字写法）
const JP_SURNAMES: &[&str] = &[
    "佐藤", "铃木", "高桥", "田中", "伊藤", "渡边", "山本", "中村", "小林", "加藤", "吉田",
    "山田", "佐佐木", "山口", "松本", "井上", "木村", "斋藤", "清水", "山崎", "森", "池田",
    "桥本", "阿部", "石川",
];

/// 日式男名
const JP_MALE_GIVEN: &[&str] = &[
    "健太", "翔太", "大辅", "悠斗", "阳翔", "莲", "凑", "苍", "树", "刚", "直树", "健一",
    "亮", "达也", "修二", "拓海", "圭介", "诚", "哲也", "骏",
];

/// 日式女名
const JP_FEMALE_GIVEN: &[&str] = &[
    "樱", "美咲", "结衣", "葵", "花音", "千夏", "明日香", "理惠", "彩", "爱", "舞", "优花",
    "绫乃", "千代", "初音", "静流", "里奈", "真由", "绘里", "凉子",
];

/// 欧美姓（音译）
const WEST_SURNAMES: &[&str] = &[
    "史密斯", "约翰逊", "布朗", "威廉姆斯", "琼斯", "米勒", "戴维斯", "威尔逊", "安德森",
    "泰勒", "摩尔", "克拉克", "刘易斯", "沃克", "霍尔", "艾伦", "杨", "赖特", "斯科特", "格林",
];

/// 欧美男名（音译）
const WEST_MALE_GIVEN: &[&str] = &[
    "亚历山大", "威廉", "杰克", "奥利弗", "卢卡斯", "亨利", "查理", "丹尼尔", "迈克尔",
    "瑞恩", "亚当", "尼克", "莱昂", "马克斯", "奥斯卡", "雨果", "亚瑟", "菲利克斯",
];

/// 欧美女名（音译）
const WEST_FEMALE_GIVEN: &[&str] = &[
    "艾米丽", "奥利维亚", "艾玛", "夏洛特", "索菲亚", "艾娃", "莉莉", "格蕾丝", "克洛伊",
    "佐伊", "露娜", "艾拉", "蕾娜", "塞琳娜", "薇拉", "伊莎贝尔", "娜塔莉", "露西",
];


/// 取名参数（与前端筛选面板一一对应）
#[derive(Debug, Clone, Default)]
pub struct NameOptions {
    /// person / place / sect / technique / item / pill / beast / plant
    pub kind: String,
    /// 题材（组合类使用）：xuanhuan 等，缺省 = xuanhuan；
    /// 未建设题材的组合类生成返回空（前端置灰入口）
    pub genre: Option<String>,
    /// person：male / female / any
    pub gender: Option<String>,
    /// person：cn / jp / west
    pub country: Option<String>,
    /// person·cn：single / compound / any
    pub surname_type: Option<String>,
    /// person：指定姓氏（可选）
    pub surname: Option<String>,
    /// person：指定名字（可选）
    pub given: Option<String>,
}

/// xorshift64 随机数（种子：系统时间纳秒）。避免引入 rand 依赖。
struct Rng(u64);

impl Rng {
    fn new() -> Self {
        let seed = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos() as u64)
            .unwrap_or(0x9E3779B97F4A7C15);
        // 保证非零
        Self(seed | 1)
    }

    fn next(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        self.0 = x;
        x
    }

    /// [0, n) 均匀取值
    fn pick<'a, T>(&mut self, xs: &'a [T]) -> &'a T {
        &xs[(self.next() % xs.len() as u64) as usize]
    }

    /// 概率 p（0..1）为真
    fn chance(&mut self, p: f64) -> bool {
        (self.next() % 1000) < (p * 1000.0) as u64
    }
}

/// 生成一个中文人名：复姓 15% 概率；双字名 60% 概率
fn cn_person_name(rng: &mut Rng, opts: &NameOptions, chars: &[&str]) -> String {
    let surname = match opts.surname.as_deref() {
        Some(s) if !s.trim().is_empty() => s.trim().to_string(),
        _ => match opts.surname_type.as_deref() {
            Some("single") => rng.pick(SURNAMES).to_string(),
            Some("compound") => rng.pick(COMPOUND_SURNAMES).to_string(),
            _ => {
                if rng.chance(0.15) {
                    rng.pick(COMPOUND_SURNAMES).to_string()
                } else {
                    rng.pick(SURNAMES).to_string()
                }
            }
        },
    };
    let mut name = surname;
    match opts.given.as_deref() {
        Some(g) if !g.trim().is_empty() => name.push_str(g.trim()),
        _ => {
            if rng.chance(0.18) {
                // 三字名点缀：中间虚字 + 名字（如「林之南」）
                name.push_str(rng.pick(MIDDLE_CHARS));
                name.push_str(rng.pick(chars));
            } else {
                name.push_str(rng.pick(chars));
                if rng.chance(0.6) {
                    // 双字名：第二字与第一字不同
                    let first = name.chars().last().map(|c| c.to_string());
                    let mut second = rng.pick(chars);
                    while Some((*second).to_string()) == first {
                        second = rng.pick(chars);
                    }
                    name.push_str(second);
                }
            }
        }
    }
    name
}

/// 生成一个人名（按国家路由）
fn person_name(rng: &mut Rng, opts: &NameOptions) -> String {
    let gender = opts.gender.as_deref().unwrap_or("any");
    match opts.country.as_deref() {
        Some("jp") => {
            let surname = match opts.surname.as_deref() {
                Some(s) if !s.trim().is_empty() => s.trim().to_string(),
                _ => rng.pick(JP_SURNAMES).to_string(),
            };
            let given = match opts.given.as_deref() {
                Some(g) if !g.trim().is_empty() => g.trim().to_string(),
                _ => {
                    if gender == "female" {
                        rng.pick(JP_FEMALE_GIVEN).to_string()
                    } else if gender == "male" {
                        rng.pick(JP_MALE_GIVEN).to_string()
                    } else if rng.chance(0.5) {
                        rng.pick(JP_MALE_GIVEN).to_string()
                    } else {
                        rng.pick(JP_FEMALE_GIVEN).to_string()
                    }
                }
            };
            format!("{surname}{given}")
        }
        Some("west") => {
            let surname = match opts.surname.as_deref() {
                Some(s) if !s.trim().is_empty() => s.trim().to_string(),
                _ => rng.pick(WEST_SURNAMES).to_string(),
            };
            let given = match opts.given.as_deref() {
                Some(g) if !g.trim().is_empty() => g.trim().to_string(),
                _ => {
                    if gender == "female" {
                        rng.pick(WEST_FEMALE_GIVEN).to_string()
                    } else if gender == "male" {
                        rng.pick(WEST_MALE_GIVEN).to_string()
                    } else if rng.chance(0.5) {
                        rng.pick(WEST_MALE_GIVEN).to_string()
                    } else {
                        rng.pick(WEST_FEMALE_GIVEN).to_string()
                    }
                }
            };
            format!("{given}·{surname}")
        }
        _ => {
            let chars = if gender == "female" {
                FEMALE_CHARS
            } else if gender == "male" {
                MALE_CHARS
            } else if rng.chance(0.5) {
                MALE_CHARS
            } else {
                FEMALE_CHARS
            };
            cn_person_name(rng, opts, chars)
        }
    }
}

/// 组合名：前缀 + 后缀
fn combo(rng: &mut Rng, prefix: &[&str], suffix: &[&str]) -> String {
    format!("{}{}", rng.pick(prefix), rng.pick(suffix))
}

/// 批次生成入口。count 1-50，批内去重。
pub fn generate(opts: &NameOptions, count: usize) -> Vec<String> {
    let count = count.clamp(1, 50);
    let mut rng = Rng::new();
    let mut out: Vec<String> = Vec::with_capacity(count);
    let mut guard = 0; // 去重重试上限，防止词典过小死循环
    // 组合类词典按题材路由；未建设题材返回空（不把玄幻词套进其他题材）
    let genre = opts.genre.as_deref().unwrap_or("xuanhuan");
    let dict = crate::names_dict::lookup(genre, &opts.kind);
    while out.len() < count && guard < count * 20 {
        guard += 1;
        let name = match opts.kind.as_str() {
            "person" => person_name(&mut rng, opts),
            _ => match dict {
                Some((prefix, suffix)) => combo(&mut rng, prefix, suffix),
                None => break,
            },
        };
        if !out.contains(&name) {
            out.push(name);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn opts(kind: &str) -> NameOptions {
        NameOptions {
            kind: kind.into(),
            ..Default::default()
        }
    }

    #[test]
    fn generates_requested_count_without_duplicates() {
        for kind in [
            "person", "place", "sect", "technique", "item", "pill", "beast", "plant",
        ] {
            let names = generate(&opts(kind), 10);
            assert_eq!(names.len(), 10, "{kind} 应生成 10 个：{names:?}");
            let dedup: std::collections::HashSet<_> = names.iter().collect();
            assert_eq!(dedup.len(), names.len(), "{kind} 批内不应重复：{names:?}");
            assert!(names.iter().all(|n| !n.is_empty()));
        }
    }

    #[test]
    fn cn_person_names_start_with_surname() {
        for name in generate(&opts("person"), 30) {
            let hit = SURNAMES
                .iter()
                .chain(COMPOUND_SURNAMES.iter())
                .any(|s| name.starts_with(s));
            assert!(hit, "「{name}」应以姓氏开头");
            let len = name.chars().count();
            assert!((2..=4).contains(&len), "「{name}」长度 {len} 应在 2-4");
        }
    }

    #[test]
    fn person_honors_filters() {
        // 复姓限定
        let mut o = opts("person");
        o.surname_type = Some("compound".into());
        for name in generate(&o, 10) {
            assert!(
                COMPOUND_SURNAMES.iter().any(|s| name.starts_with(s)),
                "「{name}」应为复姓"
            );
        }
        // 指定姓氏 + 名字：完全固定，去重后仅 1 个
        let mut o = opts("person");
        o.surname = Some("慕".into());
        o.given = Some("长歌".into());
        assert_eq!(generate(&o, 5), vec!["慕长歌"]);
        // 欧美：名·姓
        let mut o = opts("person");
        o.country = Some("west".into());
        for name in generate(&o, 10) {
            assert!(name.contains('·'), "欧美名「{name}」应为「名·姓」格式");
        }
        // 日式：姓氏开头且在词典中
        let mut o = opts("person");
        o.country = Some("jp".into());
        for name in generate(&o, 10) {
            assert!(
                JP_SURNAMES.iter().any(|s| name.starts_with(s)),
                "日式名「{name}」应以日式姓氏开头"
            );
        }
    }

    #[test]
    fn sect_and_place_have_suffix() {
        use crate::names_dict::xuanhuan as xh;
        for name in generate(&opts("sect"), 30) {
            assert!(
                xh::SECT_SUFFIX.iter().any(|s| name.ends_with(s)),
                "门派「{name}」缺后缀"
            );
        }
        for name in generate(&opts("place"), 30) {
            assert!(
                xh::PLACE_SUFFIX.iter().any(|s| name.ends_with(s)),
                "地点「{name}」缺后缀"
            );
        }
    }

    #[test]
    fn new_kinds_have_suffix() {
        use crate::names_dict::xuanhuan as xh;
        for name in generate(&opts("technique"), 20) {
            assert!(xh::TECH_SUFFIX.iter().any(|s| name.ends_with(s)), "功法「{name}」");
        }
        for name in generate(&opts("item"), 20) {
            assert!(xh::ITEM_SUFFIX.iter().any(|s| name.ends_with(s)), "装备「{name}」");
        }
        for name in generate(&opts("pill"), 20) {
            assert!(xh::PILL_SUFFIX.iter().any(|s| name.ends_with(s)), "丹药「{name}」");
        }
        for name in generate(&opts("beast"), 20) {
            assert!(xh::BEAST_SUFFIX.iter().any(|s| name.ends_with(s)), "动物「{name}」");
        }
        for name in generate(&opts("plant"), 20) {
            assert!(xh::PLANT_SUFFIX.iter().any(|s| name.ends_with(s)), "灵植「{name}」");
        }
    }

    #[test]
    fn combo_honors_genre() {
        // 缺省题材 = 玄幻：正常生成
        assert_eq!(generate(&opts("place"), 10).len(), 10);
        // 显式玄幻
        let mut o = opts("place");
        o.genre = Some("xuanhuan".into());
        assert_eq!(generate(&o, 10).len(), 10);
        // 未建设题材：返回空（不把玄幻词套进其他题材）
        let mut o = opts("place");
        o.genre = Some("nonexistent".into());
        assert!(generate(&o, 10).is_empty());
        // 人名不受题材影响
        let mut o = opts("person");
        o.genre = Some("nonexistent".into());
        assert_eq!(generate(&o, 10).len(), 10);
    }

    #[test]
    fn unknown_kind_is_empty() {
        assert!(generate(&opts("unknown"), 5).is_empty());
    }

    #[test]
    fn count_clamped() {
        assert_eq!(generate(&opts("person"), 0).len(), 1);
        assert!(generate(&opts("person"), 999).len() <= 50);
    }
}
