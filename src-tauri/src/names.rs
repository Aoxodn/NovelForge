//! 随机取名生成器（阶段 6）：人名 / 门派 / 地点。
//!
//! 纯本地组合生成：词典内嵌、确定性随机（xorshift），无任何智能成分。
//! 词典按网文常见审美精选，避免生僻与歧义字。

/// 单姓（网文高频）
const SURNAMES: &[&str] = &[
    "林", "苏", "沈", "叶", "萧", "楚", "秦", "顾", "陆", "江", "陈", "李", "张", "王", "周",
    "许", "方", "白", "韩", "唐", "宋", "袁", "谢", "姜", "范", "石", "夏", "钟", "任", "杜",
    "孟", "龙", "段", "雷", "乔", "贺", "文", "兰", "殷", "安", "颜", "温", "季", "鲁", "葛",
    "聂", "柳", "岳", "梅", "莫", "蓝", "燕", "阮", "黎", "盛", "岑", "宫", "宁", "欧", "冷",
];

/// 复姓
const COMPOUND_SURNAMES: &[&str] = &[
    "司马", "上官", "欧阳", "夏侯", "诸葛", "东方", "皇甫", "尉迟", "公孙", "轩辕", "令狐",
    "宇文", "长孙", "慕容", "司徒", "南宫", "百里", "呼延",
];

/// 男名用字（硬朗 / 气象 / 志向）
const MALE_CHARS: &[&str] = &[
    "玄", "墨", "尘", "风", "云", "辰", "寒", "凌", "霄", "峰", "岳", "炎", "雷", "皓", "宇",
    "毅", "锋", "影", "夜", "苍", "战", "武", "杰", "鸿", "龙", "虎", "麟", "鹏", "羽", "铭",
    "泽", "渊", "瀚", "松", "柏", "煜", "烨", "磊", "涛", "宁", "远", "航", "舟", "昊", "晟",
    "睿", "哲", "彦", "彬", "仁", "义", "信", "勇", "天", "行", "野", "阔", "彰", "朔",
];

/// 女名用字（灵秀 / 草木 / 珠玉）
const FEMALE_CHARS: &[&str] = &[
    "婉", "瑶", "琳", "瑜", "璇", "琪", "玉", "玲", "珊", "锦", "绣", "绫", "雪", "霜", "露",
    "雨", "霞", "月", "星", "芳", "菲", "薇", "莲", "荷", "菊", "梅", "兰", "竹", "桃", "樱",
    "棠", "梓", "柔", "娴", "雅", "静", "淑", "慧", "敏", "颖", "灵", "倩", "妍", "嫣", "馨",
    "韵", "音", "琴", "诗", "梦", "影", "衣", "烟", "凝", "璃", "莺", "雁", "蝶", "蕊",
];

/// 门派前缀（山川气象 / 道家意象）
const SECT_PREFIX: &[&str] = &[
    "青云", "玄天", "太一", "天剑", "万剑", "凌霄", "九霄", "紫霄", "丹霞", "赤霞", "天机",
    "幽冥", "碧落", "昆仑", "崆峒", "逍遥", "太极", "两仪", "五行", "阴阳", "乾坤", "离火",
    "坎水", "惊雷", "流云", "听雪", "观海", "揽月", "摘星", "焚天", "寒冰", "百花", "千机",
];

/// 门派后缀
const SECT_SUFFIX: &[&str] = &[
    "宗", "门", "派", "教", "宫", "殿", "阁", "楼", "谷", "山庄", "剑派", "道观", "禅院",
    "书院",
];

/// 地点前缀
const PLACE_PREFIX: &[&str] = &[
    "青龙", "白虎", "朱雀", "玄武", "蓬莱", "桃源", "杏花", "桃花", "梅", "竹", "松", "梧桐",
    "芙蓉", "海棠", "碧水", "清泉", "流云", "鸣凤", "栖凤", "卧龙", "藏龙", "伏虎", "饮马",
    "闻鸡", "萤火", "飞虹", "幽兰", "栖霞", "望舒", "听雨", "枕霞", "寒烟", "落星",
];

/// 地点后缀
const PLACE_SUFFIX: &[&str] = &[
    "城", "镇", "村", "寨", "关", "渡", "桥", "河", "江", "湖", "海", "池", "潭", "渊", "泽",
    "岛", "山", "峰", "岭", "丘", "原", "谷", "崖", "林", "园", "庄", "楼", "台", "榭", "坞",
    "驿", "栈", "坊",
];

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

/// 生成一个人名：复姓 15% 概率；双字名 60% 概率
fn person_name(rng: &mut Rng, chars: &[&str]) -> String {
    let surname = if rng.chance(0.15) {
        rng.pick(COMPOUND_SURNAMES)
    } else {
        rng.pick(SURNAMES)
    };
    let mut name = surname.to_string();
    name.push_str(rng.pick(chars));
    if rng.chance(if surname.chars().count() > 1 { 0.3 } else { 0.6 }) {
        // 双字名：第二字与第一字不同
        let first = name.chars().last().map(|c| c.to_string());
        let mut second = rng.pick(chars);
        while Some((*second).to_string()) == first {
            second = rng.pick(chars);
        }
        name.push_str(second);
    }
    name
}

/// 批次生成入口。kind: male / female / sect / place
pub fn generate(kind: &str, count: usize) -> Vec<String> {
    let count = count.clamp(1, 50);
    let mut rng = Rng::new();
    let mut out: Vec<String> = Vec::with_capacity(count);
    let mut guard = 0; // 去重重试上限，防止词典过小死循环
    while out.len() < count && guard < count * 20 {
        guard += 1;
        let name = match kind {
            "male" => person_name(&mut rng, MALE_CHARS),
            "female" => person_name(&mut rng, FEMALE_CHARS),
            "sect" => format!("{}{}", rng.pick(SECT_PREFIX), rng.pick(SECT_SUFFIX)),
            "place" => format!("{}{}", rng.pick(PLACE_PREFIX), rng.pick(PLACE_SUFFIX)),
            _ => break,
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

    #[test]
    fn generates_requested_count_without_duplicates() {
        for kind in ["male", "female", "sect", "place"] {
            let names = generate(kind, 10);
            assert_eq!(names.len(), 10, "{kind} 应生成 10 个：{names:?}");
            let dedup: std::collections::HashSet<_> = names.iter().collect();
            assert_eq!(dedup.len(), names.len(), "{kind} 批内不应重复：{names:?}");
            assert!(names.iter().all(|n| !n.is_empty()));
        }
    }

    #[test]
    fn person_names_start_with_surname() {
        for name in generate("male", 30) {
            let hit = SURNAMES.iter().chain(COMPOUND_SURNAMES.iter()).any(|s| name.starts_with(s));
            assert!(hit, "「{name}」应以姓氏开头");
            let len = name.chars().count();
            assert!((2..=4).contains(&len), "「{name}」长度 {len} 应在 2-4");
        }
    }

    #[test]
    fn sect_and_place_have_suffix() {
        for name in generate("sect", 30) {
            assert!(
                SECT_SUFFIX.iter().any(|s| name.ends_with(s)),
                "门派「{name}」缺后缀"
            );
        }
        for name in generate("place", 30) {
            assert!(
                PLACE_SUFFIX.iter().any(|s| name.ends_with(s)),
                "地点「{name}」缺后缀"
            );
        }
    }

    #[test]
    fn unknown_kind_is_empty() {
        assert!(generate("unknown", 5).is_empty());
    }

    #[test]
    fn count_clamped() {
        assert_eq!(generate("male", 0).len(), 1);
        assert!(generate("male", 999).len() <= 50);
    }
}
