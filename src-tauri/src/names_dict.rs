//! 命名题材词典：按题材分模块，每题材 7 类（地名/势力/功法/装备/丹药/动物/灵植）。
//!
//! 每类 = 前缀数组 + 后缀数组，生成时随机组合。数量硬指标：
//! 核心题材 前缀 ≥100 / 后缀 ≥50；扩展题材 前缀 ≥60 / 后缀 ≥30；
//! 丹药后缀放宽（核心 ≥30 / 扩展 ≥20）。

pub(crate) mod daomu;
pub(crate) mod dushi;
pub(crate) mod guyan;
pub(crate) mod honghuang;
pub(crate) mod junshi;
pub(crate) mod kehuan;
pub(crate) mod kesulu;
pub(crate) mod lingyi;
pub(crate) mod lishi;
pub(crate) mod meishi;
pub(crate) mod moshi;
pub(crate) mod saibo;
pub(crate) mod shangzhan;
pub(crate) mod taikong;
pub(crate) mod tiyu;
pub(crate) mod wuxia;
pub(crate) mod wuxian;
pub(crate) mod xianxia;
pub(crate) mod xiaoyuan;
pub(crate) mod xihuan;
pub(crate) mod xuanyi;
pub(crate) mod youxi;
pub(crate) mod zhengqi;
pub(crate) mod zhongtian;
pub(crate) mod xuanhuan;

/// 题材元信息：前端下拉渲染用。ready=false 的题材词典未建设，前端置灰。
pub struct GenreInfo {
    pub key: &'static str,
    pub label: &'static str,
    pub core: bool,
    pub ready: bool,
}

/// 25 题材清单（★核心 6 + ☆扩展 19）。
pub const GENRES: &[GenreInfo] = &[
    GenreInfo { key: "xuanhuan", label: "玄幻 / 东方玄幻", core: true, ready: true },
    GenreInfo { key: "xianxia", label: "仙侠修真", core: true, ready: true },
    GenreInfo { key: "dushi", label: "都市异能", core: true, ready: true },
    GenreInfo { key: "kehuan", label: "科幻星际", core: true, ready: true },
    GenreInfo { key: "xihuan", label: "西幻奇幻", core: true, ready: true },
    GenreInfo { key: "moshi", label: "末世废土", core: true, ready: true },
    GenreInfo { key: "wuxia", label: "武侠", core: false, ready: true },
    GenreInfo { key: "saibo", label: "赛博朋克", core: false, ready: true },
    GenreInfo { key: "zhengqi", label: "蒸汽朋克", core: false, ready: true },
    GenreInfo { key: "kesulu", label: "克苏鲁诡秘", core: false, ready: true },
    GenreInfo { key: "lishi", label: "历史架空", core: false, ready: true },
    GenreInfo { key: "junshi", label: "军事战争", core: false, ready: true },
    GenreInfo { key: "xuanyi", label: "悬疑推理", core: false, ready: true },
    GenreInfo { key: "lingyi", label: "灵异恐怖", core: false, ready: true },
    GenreInfo { key: "daomu", label: "盗墓探险", core: false, ready: true },
    GenreInfo { key: "youxi", label: "游戏电竞", core: false, ready: true },
    GenreInfo { key: "wuxian", label: "无限流副本", core: false, ready: true },
    GenreInfo { key: "zhongtian", label: "种田经营", core: false, ready: true },
    GenreInfo { key: "shangzhan", label: "商战职场", core: false, ready: true },
    GenreInfo { key: "xiaoyuan", label: "校园", core: false, ready: true },
    GenreInfo { key: "guyan", label: "古言言情", core: false, ready: true },
    GenreInfo { key: "tiyu", label: "体育竞技", core: false, ready: true },
    GenreInfo { key: "meishi", label: "美食", core: false, ready: true },
    GenreInfo { key: "honghuang", label: "洪荒封神", core: false, ready: true },
    GenreInfo { key: "taikong", label: "星际太空歌剧", core: false, ready: true },
];

/// 题材是否已建设词典（前端置灰依据，避免把玄幻词套进都市/科幻）。
pub fn genre_ready(genre: &str) -> bool {
    GENRES.iter().any(|g| g.key == genre && g.ready)
}

/// 按 (题材, 类型) 取词典对；未建设题材或未知类型返回 None。
pub fn lookup(genre: &str, kind: &str) -> Option<(&'static [&'static str], &'static [&'static str])> {
    macro_rules! kinds {
        ($m:ident) => {
            Some(match kind {
                "place" => ($m::PLACE_PREFIX, $m::PLACE_SUFFIX),
                "sect" => ($m::SECT_PREFIX, $m::SECT_SUFFIX),
                "technique" => ($m::TECH_PREFIX, $m::TECH_SUFFIX),
                "item" => ($m::ITEM_PREFIX, $m::ITEM_SUFFIX),
                "pill" => ($m::PILL_PREFIX, $m::PILL_SUFFIX),
                "beast" => ($m::BEAST_PREFIX, $m::BEAST_SUFFIX),
                "plant" => ($m::PLANT_PREFIX, $m::PLANT_SUFFIX),
                _ => return None,
            })
        };
    }
    match genre {
        "xuanhuan" => kinds!(xuanhuan),
        "xianxia" => kinds!(xianxia),
        "dushi" => kinds!(dushi),
        "kehuan" => kinds!(kehuan),
        "xihuan" => kinds!(xihuan),
        "moshi" => kinds!(moshi),
        "wuxia" => kinds!(wuxia),
        "saibo" => kinds!(saibo),
        "zhengqi" => kinds!(zhengqi),
        "kesulu" => kinds!(kesulu),
        "lishi" => kinds!(lishi),
        "junshi" => kinds!(junshi),
        "xuanyi" => kinds!(xuanyi),
        "lingyi" => kinds!(lingyi),
        "daomu" => kinds!(daomu),
        "youxi" => kinds!(youxi),
        "wuxian" => kinds!(wuxian),
        "zhongtian" => kinds!(zhongtian),
        "shangzhan" => kinds!(shangzhan),
        "xiaoyuan" => kinds!(xiaoyuan),
        "guyan" => kinds!(guyan),
        "tiyu" => kinds!(tiyu),
        "meishi" => kinds!(meishi),
        "honghuang" => kinds!(honghuang),
        "taikong" => kinds!(taikong),
        _ => None,
    }
}
