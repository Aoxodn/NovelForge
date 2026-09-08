# -*- coding: utf-8 -*-
"""从两个 MIT 词库仓库构建人名词典与仙侠题材词典。

来源（均 MIT 许可，词表二次整理去重）：
- hythl0day/random_chinese_fantasy_names  → 仙侠 JSON 词库 + 人名字库
- demigodliu/random-chinese-name (rcn)    → 人名字库 + 各类名词字库

产出：
- src-tauri/src/names_person.rs        人名词典（姓 / 男字 / 女字 / 中间字）
- src-tauri/src/names_dict/xianxia.rs  仙侠修真题材 7 类前缀/后缀
"""
import json
import os
import re
import sys

TMP = os.path.join(os.environ["TEMP"], "namegen-refs")
X = os.path.join(TMP, "xianxia", "www", "random_names", "data")   # xianxia JSON
R = os.path.join(TMP, "rcn", "src", "configs")                    # rcn TS
OUT_PERSON = os.path.join(os.path.dirname(__file__), "..", "src-tauri", "src", "names_person.rs")
OUT_XIANXIA = os.path.join(os.path.dirname(__file__), "..", "src-tauri", "src", "names_dict", "xianxia.rs")


def jload(*parts):
    return json.load(open(os.path.join(X, *parts), encoding="utf-8"))


def parse_ts_consts(path):
    """解析 TS 文件里所有 export const 数组（支持单双引号）。"""
    t = open(path, encoding="utf-8").read()
    out = {}
    for m in re.finditer(r"export const (\w+)[^=]*=\s*\[([^\]]*)\]", t, re.S):
        name, body = m.group(1), m.group(2)
        words = re.findall(r"['\"]([^'\"]+)['\"]", body)
        if words:
            out[name] = words
    return out


def dedup(seq):
    seen, res = set(), []
    for w in seq:
        if w and w not in seen:
            seen.add(w)
            res.append(w)
    return res


def fmt_rust(words, per_line=10):
    lines = []
    for i in range(0, len(words), per_line):
        chunk = ", ".join(f'"{w}"' for w in words[i:i + per_line])
        lines.append(f"    {chunk},")
    return "\n".join(lines)


def const_block(doc, name, words):
    return f"/// {doc}（{len(words)}）\npub const {name}: &[&str] = &[\n{fmt_rust(words)}\n];\n"


# ---------------- 人名词典 ----------------

# 现有 names.rs 内嵌词表（保留在最前，保证风格连续）
cur = {
    "surname": "林 苏 沈 叶 萧 楚 秦 顾 陆 江 陈 李 张 王 周 许 方 白 韩 唐 宋 袁 谢 姜 范 石 夏 钟 任 杜 孟 龙 段 雷 乔 贺 文 兰 殷 安 颜 温 季 鲁 葛 聂 柳 岳 梅 莫 蓝 燕 阮 黎 盛 岑 宫 宁 欧 冷".split(),
    "compound": "司马 上官 欧阳 夏侯 诸葛 东方 皇甫 尉迟 公孙 轩辕 令狐 宇文 长孙 慕容 司徒 南宫 百里 呼延".split(),
    "male": list("玄墨尘风云辰寒凌霄峰岳炎雷皓宇毅锋影夜苍战武杰鸿龙虎麟鹏羽铭泽渊瀚松柏煜烨磊涛宁远航舟昊晟睿哲彦彬仁义信勇天行野阔彰朔"),
    "female": list("婉瑶琳瑜璇琪玉玲珊锦绣绫雪霜露雨霞月星芳菲薇莲荷菊梅兰竹桃樱棠梓柔娴雅静淑慧敏颖灵倩妍嫣馨韵音琴诗梦影衣烟凝璃莺雁蝶蕊"),
}

family = jload("name", "family.json")
male_x = jload("name", "male.json")
female_x = jload("name", "female.json")
middle_x = jload("name", "middle.json")

human = parse_ts_consts(os.path.join(R, "human.ts"))
print("rcn human consts:", {k: len(v) for k, v in human.items()})

rcn_single = human.get("SingleSurname", [])
rcn_compound = human.get("CompoundSurname", [])
rcn_male = [w for w in human.get("MaleName", []) if len(w) == 1]
rcn_female = [w for w in human.get("FemaleName", []) if len(w) == 1]
# 兜底：常量名可能有出入
for k, v in human.items():
    kl = k.lower()
    if not rcn_female and ("female" in kl or "girl" in kl or "woman" in kl):
        rcn_female = [w for w in v if len(w) == 1]
    if not rcn_male and ("male" in kl or "boy" in kl or "man" in kl):
        rcn_male = [w for w in v if len(w) == 1]

surnames = dedup(cur["surname"] + [w for w in family if len(w) == 1] + rcn_single)
compounds = dedup(cur["compound"] + rcn_compound + [w for w in family if len(w) > 1])
male_chars = dedup(cur["male"] + [w for w in male_x if len(w) == 1] + rcn_male)
female_chars = dedup(cur["female"] + [w for w in female_x if len(w) == 1] + rcn_female)
middle_chars = dedup([w for w in middle_x if len(w) == 1])

person_rs = """//! 人名词典（中文名）：姓氏 / 男名用字 / 女名用字 / 中间虚字。
//!
//! 词库来源（MIT 许可，二次整理去重，另含 NovelForge 原始内嵌词表）：
//! - hythl0day/random_chinese_fantasy_names（family / male / female / middle）
//! - demigodliu/random-chinese-name（SingleSurname / CompoundSurname / MaleName / FemaleName）

"""
person_rs += const_block("单姓（真实百家姓 + 网文高频）", "SURNAMES", surnames)
person_rs += "\n"
person_rs += const_block("复姓", "COMPOUND_SURNAMES", compounds)
person_rs += "\n"
person_rs += const_block("男名用字（硬朗 / 气象 / 志向）", "MALE_CHARS", male_chars)
person_rs += "\n"
person_rs += const_block("女名用字（灵秀 / 草木 / 珠玉）", "FEMALE_CHARS", female_chars)
person_rs += "\n"
person_rs += const_block("中间虚字（之 / 亦 / 其 / 如——三字名点缀）", "MIDDLE_CHARS", middle_chars)

open(OUT_PERSON, "w", encoding="utf-8").write(person_rs)
print(f"names_person.rs: 姓{surnames.length if False else len(surnames)} 复姓{len(compounds)} 男字{len(male_chars)} 女字{len(female_chars)} 中间字{len(middle_chars)}")

# ---------------- 仙侠题材词典 ----------------

common = jload("shared", "common.json")
strange = jload("shared", "strange.json") if os.path.exists(os.path.join(X, "shared", "strange.json")) else jload("creature", "strange.json")
spirit = jload("shared", "spirit.json")
color1 = jload("shared", "color.json")
dao1 = jload("dao", "dao.json")            # 单字道号池
place1 = jload("place", "place.json")      # 单字地名池

location = jload("place", "location.json")
continent = jload("place", "continent.json")
zone_dict = jload("place", "zone.json")
zone = zone_dict["land"] + zone_dict["water"] + zone_dict["void"]
place_postfix = jload("place", "postfix.json")

clan = jload("organization", "clan.json")
nation = jload("organization", "nation.json")

skill = jload("skill", "skill.json")
book = jload("book", "book.json")

talisman_dict = jload("talisman", "talisman.json")
talisman_suffix = dedup(sum(talisman_dict.values(), []))

creature_dict = jload("creature", "creature.json")
creature_plant = creature_dict.get("plant", [])
beast_suffix = dedup(sum((v for k, v in creature_dict.items() if k != "plant"), []))

alchemy = jload("alchemy", "alchemy.json")

cprefix = jload("creature", "prefix.json")

# rcn 各类名词字库（后缀补充）
rcn_cfg = {f: parse_ts_consts(os.path.join(R, f + ".ts")) for f in
           ["place", "organize", "elixir", "plant", "weapon", "animal"]}
def rcn_nouns(f):
    for k, v in rcn_cfg[f].items():
        if k != "adjective":
            return v
    return []
rcn_place_n, rcn_org_n = rcn_nouns("place"), rcn_nouns("organize")
rcn_elixir_n, rcn_plant_n = rcn_nouns("elixir"), rcn_nouns("plant")
rcn_weapon_n = rcn_nouns("weapon")

# ---- 前缀池（全 2 字词；common 的 place 组是真实门派名，剔除）----
pool = {}
for g in ["dao", "element", "creature", "thing", "color", "adj", "gesture", "action", "number"]:
    pool[g] = [w for w in common[g] if len(w) >= 2]
pool["strange"] = [w for w in strange if len(w) >= 2]

def take(key, n):
    out = pool[key][:n]
    pool[key] = pool[key][n:]
    return out

used = set()

def alloc(segs):
    """从多段词池顺序取词凑足，保证 7 类前缀零重复。"""
    res = []
    for words in segs:
        for w in words:
            if w not in used:
                used.add(w)
                res.append(w)
    return res

place_prefix = alloc([pool["thing"], pool["color"], pool["element"], take("strange", 16)])
sect_prefix = alloc([pool["dao"], pool["adj"], pool["gesture"], take("strange", 12)])
tech_prefix = alloc([take("action", 72), take("number", 40)])
item_prefix = alloc([pool["creature"], take("strange", 62), take("number", 10)])[:110]
pill_prefix = alloc([take("action", 98), take("number", 10)])[:108]
beast_prefix = alloc([dao1[:70], spirit, color1, cprefix, place1[:14]])[:110]
plant_prefix = alloc([place1[14:60], take("strange", 44), dao1[92:103]])

place_suffix = dedup(location + continent + zone + place_postfix + rcn_place_n)[:55]
sect_suffix = dedup(clan + nation + rcn_org_n)[:52]
tech_suffix = dedup(skill + book + [
    "剑法", "刀法", "拳法", "掌法", "指法", "剑诀", "秘录", "奥义",
])[:50]
item_suffix = dedup(talisman_suffix + rcn_weapon_n)[:55]
pill_suffix = dedup(alchemy + rcn_elixir_n + [
    "灵丹", "仙丹", "神丹", "宝丹", "液", "浆", "醴", "霜",
    "丸剂", "散剂", "汤剂", "膏方", "药引", "灵丸", "丹方", "云膏", "琼露", "凝膏",
])[:32]
beast_suffix = dedup(beast_suffix)[:55]
plant_prefix = dedup(plant_prefix + [
    "凝露", "承露", "含烟", "滴翠", "覆霜", "垂珠", "缀星", "拈花",
])
plant_suffix = dedup(creature_plant + rcn_plant_n + [
    "苗", "穗", "实", "荚", "种", "仁", "米", "禾", "黍", "谷",
    "稻", "麦", "豆", "瓜", "蔓", "枝", "梢", "丛", "簇", "蕙",
    "芷", "蘅", "芜", "荇", "蓼", "菱", "芡", "茭", "芦",
])[:50]

xx_rs = """//! 题材：仙侠修真（核心题材）
//! 审美：仙山福地 / 剑修道统 / 渡劫飞升。前缀重意象、后缀能成词。
//!
//! 词库来源（MIT 许可，二次整理去重）：
//! - hythl0day/random_chinese_fantasy_names
//! - demigodliu/random-chinese-name

"""
xx_rs += const_block("地名前缀：仙境意象 / 天象元素", "PLACE_PREFIX", place_prefix) + "\n"
xx_rs += const_block("地名后缀：行政区划 / 山川形胜", "PLACE_SUFFIX", place_suffix) + "\n"
xx_rs += const_block("势力前缀：道意门风 / 山海古称", "SECT_PREFIX", sect_prefix) + "\n"
xx_rs += const_block("势力后缀：宗门建制", "SECT_SUFFIX", sect_suffix) + "\n"
xx_rs += const_block("功法前缀：修行次第 / 道法数理", "TECH_PREFIX", tech_prefix) + "\n"
xx_rs += const_block("功法后缀：功法典籍体制", "TECH_SUFFIX", tech_suffix) + "\n"
xx_rs += const_block("装备前缀：灵物意象 / 山海古兽", "ITEM_PREFIX", item_prefix) + "\n"
xx_rs += const_block("装备后缀：法宝形制", "ITEM_SUFFIX", item_suffix) + "\n"
xx_rs += const_block("丹药前缀：炼养次第", "PILL_PREFIX", pill_prefix) + "\n"
xx_rs += const_block("丹药后缀：丹散丸剂", "PILL_SUFFIX", pill_suffix) + "\n"
xx_rs += const_block("动物前缀：单字道韵 / 灵性色彩", "BEAST_PREFIX", beast_prefix) + "\n"
xx_rs += const_block("动物后缀：鳞羽虫豸", "BEAST_SUFFIX", beast_suffix) + "\n"
xx_rs += const_block("灵植前缀：山水古意", "PLANT_PREFIX", plant_prefix) + "\n"
xx_rs += const_block("灵植后缀：草木菌芝", "PLANT_SUFFIX", plant_suffix)

open(OUT_XIANXIA, "w", encoding="utf-8").write(xx_rs)

print("\n仙侠词典规模：")
for name, arr in [("PLACE_P", place_prefix), ("PLACE_S", place_suffix), ("SECT_P", sect_prefix),
                  ("SECT_S", sect_suffix), ("TECH_P", tech_prefix), ("TECH_S", tech_suffix),
                  ("ITEM_P", item_prefix), ("ITEM_S", item_suffix), ("PILL_P", pill_prefix),
                  ("PILL_S", pill_suffix), ("BEAST_P", beast_prefix), ("BEAST_S", beast_suffix),
                  ("PLANT_P", plant_prefix), ("PLANT_S", plant_suffix)]:
    flag = ""
    kind = name.split("_")[1]
    if kind == "P":
        if len(arr) < 100:
            flag = "  ← 低于100，需补齐"
    else:
        need = 30 if name == "PILL_S" else 50
        if len(arr) < need:
            flag = f"  ← 低于{need}，需补齐"
    print(f"  {name}: {len(arr)}{flag}")
