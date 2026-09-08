# -*- coding: utf-8 -*-
"""修复词典重复词：按替换表在指定常量数组内替换首个匹配；并校正文档注释词数。"""
import os
import re

DICT_DIR = os.path.join(os.path.dirname(__file__), "..", "src-tauri", "src", "names_dict")

# (文件, 常量, 旧词, 新词) —— 同题材 7 类前缀不得跨类型重复，替换后出现方
FIXES = [
    ("dushi", "BEAST_PREFIX", "4号", "D-9"),

    ("kehuan", "TECH_PREFIX", "同步", "耦合"),
    ("kehuan", "PLACE_PREFIX", "真空", "低压"),
    ("kehuan", "SECT_PREFIX", "真空", "高维"),
    ("kehuan", "SECT_PREFIX", "前沿", "尖峰"),
    ("kehuan", "PLACE_PREFIX", "重构", "翻建"),
    ("kehuan", "SECT_PREFIX", "曲率", "超弦"),
    ("kehuan", "PLACE_PREFIX", "5号", "4带"),
    ("kehuan", "ITEM_PREFIX", "突击", "突袭"),
    ("kehuan", "SECT_PREFIX", "虚拟", "全息"),
    ("kehuan", "BEAST_PREFIX", "外骨", "几丁"),
    ("kehuan", "TECH_PREFIX", "神经", "突触"),
    ("kehuan", "SECT_PREFIX", "基因", "种质"),
    ("kehuan", "PLANT_PREFIX", "螺旋", "旋叶"),
    ("kehuan", "PILL_PREFIX", "植入", "埋植"),
    ("kehuan", "PILL_PREFIX", "悬浮", "絮凝"),
    ("kehuan", "PLANT_PREFIX", "耐压", "深根"),
    ("kehuan", "PLANT_PREFIX", "荧蓝", "靛蓝"),
    ("kehuan", "BEAST_PREFIX", "9号", "E-8"),
    ("kehuan", "PLANT_PREFIX", "初号", "母株"),
    ("kehuan", "PLANT_PREFIX", "辐射", "隐头"),
    ("kehuan", "PLANT_PREFIX", "样本", "选株"),

    ("moshi", "PLACE_PREFIX", "带刺", "棘网"),
    ("moshi", "PLACE_PREFIX", "9号", "4区"),
    ("moshi", "PLACE_PREFIX", "5号", "12区"),
    ("moshi", "ITEM_PREFIX", "9号", "8号"),
    ("moshi", "SECT_PREFIX", "共生", "抱薪"),
    ("moshi", "SECT_PREFIX", "0号", "丙队"),
    ("moshi", "BEAST_PREFIX", "畸变", "异生"),
    ("moshi", "ITEM_PREFIX", "贴身", "贴体"),
    ("moshi", "TECH_PREFIX", "观察", "目视"),
    ("moshi", "ITEM_PREFIX", "负重", "载重"),
    ("moshi", "BEAST_PREFIX", "夜视", "暗行"),
    ("moshi", "BEAST_PREFIX", "7号", "R-3"),
    ("moshi", "BEAST_PREFIX", "B级", "C级"),
    ("moshi", "BEAST_PREFIX", "A级", "S级"),
    ("moshi", "BEAST_PREFIX", "M型", "N型"),
    ("moshi", "PLANT_PREFIX", "7号", "8号"),
    ("moshi", "PLANT_PREFIX", "初代", "原种"),
    ("moshi", "PLANT_PREFIX", "二代", "F系"),
    ("moshi", "SECT_SUFFIX", "收容所", "庇护所"),

    ("xihuan", "BEAST_PREFIX", "暗影", "荫翳"),
    ("xihuan", "SECT_PREFIX", "圣光", "辉光"),
    ("xihuan", "SECT_PREFIX", "晨曦", "拂晓"),
    ("xihuan", "BEAST_PREFIX", "金黄", "琥珀"),
    ("xihuan", "BEAST_PREFIX", "翡翠", "青碧"),
    ("xihuan", "SECT_PREFIX", "玛瑙", "月石"),
    ("xihuan", "SECT_PREFIX", "珍珠", "贝母"),
    ("xihuan", "BEAST_PREFIX", "风暴", "狂飙"),
    ("xihuan", "ITEM_PREFIX", "烈焰", "炽焰"),
    ("xihuan", "BEAST_PREFIX", "烈焰", "灼炎"),
    ("xihuan", "SECT_PREFIX", "雄狮", "猛狮"),
    ("xihuan", "ITEM_PREFIX", "失落", "蒙尘"),
    ("xihuan", "ITEM_PREFIX", "祝圣", "开光"),
    ("xihuan", "PLANT_PREFIX", "精灵", "花灵"),
    ("xihuan", "ITEM_PREFIX", "矮人", "符铸"),
    ("xihuan", "ITEM_PREFIX", "地精", "机簧"),
    ("xihuan", "ITEM_PREFIX", "巨魔", "巨怪"),
    ("xihuan", "ITEM_PREFIX", "雷霆", "贯雷"),
    ("xihuan", "PLANT_PREFIX", "初生", "新萌"),
    ("xihuan", "ITEM_PREFIX", "白银", "纹银"),
    ("xihuan", "ITEM_PREFIX", "黄金", "赤金"),
    ("xihuan", "ITEM_PREFIX", "忏悔", "苦修"),
    ("xihuan", "BEAST_PREFIX", "虚空", "虚渺"),
    ("xihuan", "PILL_PREFIX", "贤者", "圣愚"),
    ("xihuan", "TECH_PREFIX", "占卜", "卜筮"),
    ("xihuan", "TECH_PREFIX", "召唤", "唤物"),
    ("xihuan", "PLANT_PREFIX", "藤蔓", "蔓藤"),
    ("xihuan", "PLANT_PREFIX", "古树", "老树"),
    ("xihuan", "PILL_PREFIX", "庇佑", "庇护"),
    ("xihuan", "PILL_PREFIX", "祝福", "蒙福"),
    ("xihuan", "ITEM_PREFIX", "驱邪", "退魔"),
    ("xihuan", "ITEM_PREFIX", "史诗", "罕世"),
    ("xihuan", "ITEM_PREFIX", "传说", "奇珍"),
    ("xihuan", "ITEM_PREFIX", "神话", "神工"),
    ("xihuan", "BEAST_PREFIX", "青铜", "古铜"),
    ("xihuan", "BEAST_PREFIX", "剧毒", "淬毒"),
    ("xihuan", "BEAST_PREFIX", "獠牙", "巨牙"),
    ("xihuan", "PILL_PREFIX", "幸运", "福运"),
    ("xihuan", "PLANT_PREFIX", "抗毒", "拔毒"),
    ("xihuan", "PLANT_PREFIX", "致幻", "魇惑"),
    ("xihuan", "BEAST_PREFIX", "猩红", "赤红"),
    ("xihuan", "BEAST_PREFIX", "下位", "幼生"),
    ("xihuan", "BEAST_PREFIX", "上位", "成体"),
]

def apply_fix(src, const, old, new):
    """在指定 const 数组块内替换首个 "old"。"""
    m = re.search(rf"(pub const {const}: &\[&str\] = &\[)(.*?)(\];)", src, re.S)
    if not m:
        return src, False
    body = m.group(2)
    token = f'"{old}"'
    if token not in body:
        return src, False
    body = body.replace(token, f'"{new}"', 1)
    return src[:m.start(2)] + body + src[m.end(2):], True

# 分组应用
by_file = {}
for f, c, o, n in FIXES:
    by_file.setdefault(f, []).append((c, o, n))

for fname, fixes in by_file.items():
    path = os.path.join(DICT_DIR, fname + ".rs")
    src = open(path, encoding="utf-8").read()
    for c, o, n in fixes:
        src, ok_ = apply_fix(src, c, o, n)
        if not ok_:
            print(f"WARN {fname}.{c}: 未找到 {o}")
    open(path, "w", encoding="utf-8").write(src)
    print(f"{fname}: 应用 {len(fixes)} 处替换")
print("完成")
