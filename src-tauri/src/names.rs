//! 随机取名生成器（阶段 6，0.7.0 扩展）：人名 / 门派 / 地点 / 功法 / 装备 / 丹药 / 动物 / 植物。
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

/// 功法前缀
const TECH_PREFIX: &[&str] = &[
    "乾元", "太虚", "九阳", "焚天", "青莲", "紫霞", "玄冰", "赤炎", "狂龙", "伏魔", "镇岳",
    "御风", "裂空", "破军", "星陨", "万剑", "天罡", "北斗", "无量", "混元", "大衍", "太上",
    "噬魂", "灭世", "不朽", "涅槃", "真武", "化蝶", "听涛", "望月", "落英", "惊鸿",
];

/// 功法后缀
const TECH_SUFFIX: &[&str] = &[
    "诀", "典", "经", "功", "术", "剑法", "刀法", "枪法", "掌法", "拳法", "指法", "身法",
    "步法", "心法", "真解", "神通",
];

/// 装备前缀
const ITEM_PREFIX: &[&str] = &[
    "寒星", "赤霄", "湛卢", "龙渊", "凤鸣", "裂天", "碎星", "逐日", "追魂", "镇魂", "玄铁",
    "紫金", "碧血", "霜华", "炎阳", "碧落", "星辉", "月华", "曜日", "幽冥", "断水", "惊鲵",
];

/// 装备后缀
const ITEM_SUFFIX: &[&str] = &[
    "剑", "刀", "枪", "戟", "弓", "鞭", "锏", "斧", "扇", "鼎", "钟", "塔", "印", "镜", "笛",
    "琴", "珠", "环", "镯", "甲", "盔", "靴", "戒", "壶", "幡",
];

/// 丹药前缀
const PILL_PREFIX: &[&str] = &[
    "回春", "聚气", "破境", "洗髓", "凝神", "清心", "筑基", "金元", "九转", "大还", "小还",
    "生肌", "止血", "避毒", "驱寒", "祛火", "安神", "培元", "天元", "造化", "万象", "夺魄",
];

/// 丹药后缀
const PILL_SUFFIX: &[&str] = &["丹", "丸", "散", "膏"];

/// 动物（生灵）前缀
const BEAST_PREFIX: &[&str] = &[
    "赤焰", "玄冰", "紫雷", "青风", "金瞳", "银月", "血牙", "墨鳞", "狂沙", "碧水", "幽冥",
    "圣光", "暗影", "雷霆", "烈焰", "寒霜", "吞天", "逐云", "踏雪", "衔烛",
];

/// 动物（生灵）后缀
const BEAST_SUFFIX: &[&str] = &[
    "虎", "豹", "鹰", "蛇", "狼", "狮", "鹤", "雕", "蛟", "麟", "凤", "龟", "猿", "貂", "马",
    "熊", "隼", "蟒", "鸦", "狐",
];

/// 灵植前缀
const PLANT_PREFIX: &[&str] = &[
    "紫金", "雪玉", "龙血", "凤尾", "九叶", "千年", "万年", "百年", "冰心", "火莲", "碧灵",
    "赤芝", "金须", "墨玉", "凝露", "映月",
];

/// 灵植后缀
const PLANT_SUFFIX: &[&str] = &[
    "草", "花", "参", "果", "藤", "竹", "莲", "芝", "叶", "树", "菊", "兰", "蕨", "蔓",
];

/// 取名参数（与前端筛选面板一一对应）
#[derive(Debug, Clone, Default)]
pub struct NameOptions {
    /// person / place / sect / technique / item / pill / beast / plant
    pub kind: String,
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
    while out.len() < count && guard < count * 20 {
        guard += 1;
        let name = match opts.kind.as_str() {
            "person" => person_name(&mut rng, opts),
            "place" => combo(&mut rng, PLACE_PREFIX, PLACE_SUFFIX),
            "sect" => combo(&mut rng, SECT_PREFIX, SECT_SUFFIX),
            "technique" => combo(&mut rng, TECH_PREFIX, TECH_SUFFIX),
            "item" => combo(&mut rng, ITEM_PREFIX, ITEM_SUFFIX),
            "pill" => combo(&mut rng, PILL_PREFIX, PILL_SUFFIX),
            "beast" => combo(&mut rng, BEAST_PREFIX, BEAST_SUFFIX),
            "plant" => combo(&mut rng, PLANT_PREFIX, PLANT_SUFFIX),
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
        for name in generate(&opts("sect"), 30) {
            assert!(
                SECT_SUFFIX.iter().any(|s| name.ends_with(s)),
                "门派「{name}」缺后缀"
            );
        }
        for name in generate(&opts("place"), 30) {
            assert!(
                PLACE_SUFFIX.iter().any(|s| name.ends_with(s)),
                "地点「{name}」缺后缀"
            );
        }
    }

    #[test]
    fn new_kinds_have_suffix() {
        for name in generate(&opts("technique"), 20) {
            assert!(TECH_SUFFIX.iter().any(|s| name.ends_with(s)), "功法「{name}」");
        }
        for name in generate(&opts("item"), 20) {
            assert!(ITEM_SUFFIX.iter().any(|s| name.ends_with(s)), "装备「{name}」");
        }
        for name in generate(&opts("pill"), 20) {
            assert!(PILL_SUFFIX.iter().any(|s| name.ends_with(s)), "丹药「{name}」");
        }
        for name in generate(&opts("beast"), 20) {
            assert!(BEAST_SUFFIX.iter().any(|s| name.ends_with(s)), "动物「{name}」");
        }
        for name in generate(&opts("plant"), 20) {
            assert!(PLANT_SUFFIX.iter().any(|s| name.ends_with(s)), "灵植「{name}」");
        }
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
