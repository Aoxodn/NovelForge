# -*- coding: utf-8 -*-
"""校验 names_dict 词典：数量达标 / 数组内去重 / 同题材前缀跨类型去重 / 文档注释计数准确。"""
import os
import re
import sys

DICT_DIR = os.path.join(os.path.dirname(__file__), "..", "src-tauri", "src", "names_dict")
KINDS = ["PLACE", "SECT", "TECH", "ITEM", "PILL", "BEAST", "PLANT"]
CORE = {"xuanhuan", "xianxia", "dushi", "kehuan", "xihuan", "moshi"}

ok = True
total_p = total_s = 0
for fn in sorted(os.listdir(DICT_DIR)):
    if not fn.endswith(".rs"):
        continue
    key = fn[:-3]
    src = open(os.path.join(DICT_DIR, fn), encoding="utf-8").read()
    arrs, doc_counts = {}, {}
    for m in re.finditer(r"///[^\n]*?[（(](\d+)[）)][^\n]*\r?\npub const (\w+): &\[&str\] = &\[(.*?)\];", src, re.S):
        doc_counts[m.group(2)] = int(m.group(1))
        arrs[m.group(2)] = re.findall(r'"([^"]+)"', m.group(3))
    issues = []
    prefixes = []
    for k in KINDS:
        p, s = arrs.get(f"{k}_PREFIX"), arrs.get(f"{k}_SUFFIX")
        if p is None or s is None:
            issues.append(f"缺少 {k} 数组")
            continue
        total_p += len(p)
        total_s += len(s)
        mn_p, mn_s = (100, 50) if key in CORE else (60, 30)
        mn_pill_s = 30 if key in CORE else 20
        if len(p) < mn_p:
            issues.append(f"{k}_P={len(p)} < {mn_p}")
        if len(s) < (mn_pill_s if k == "PILL" else mn_s):
            issues.append(f"{k}_S={len(s)} < 最小值")
        if len(set(p)) != len(p):
            dup = [w for w in p if p.count(w) > 1]
            issues.append(f"{k}_P 重复: {set(dup)}")
        if len(set(s)) != len(s):
            dup = [w for w in s if s.count(w) > 1]
            issues.append(f"{k}_S 重复: {set(dup)}")
        prefixes.append((k, p))
        dc = doc_counts.get(f"{k}_PREFIX")
        if dc is not None and dc != len(p):
            issues.append(f"{k}_P 注释数{dc}≠实际{len(p)}")
        dc = doc_counts.get(f"{k}_SUFFIX")
        if dc is not None and dc != len(s):
            issues.append(f"{k}_S 注释数{dc}≠实际{len(s)}")
    # 同题材前缀跨类型重复
    seen = {}
    for k, p in prefixes:
        for w in p:
            if w in seen:
                issues.append(f"前缀跨类型重复: {w} ({seen[w]}/{k})")
            else:
                seen[w] = k
    status = "OK " if not issues else "!! "
    if issues:
        ok = False
    print(f"{status}{key}: 前缀{sum(len(p) for _, p in prefixes)} 后缀{sum(len(arrs.get(f'{k}_SUFFIX', [])) for k in KINDS)}"
          + ("  " + "; ".join(issues) if issues else ""))

print(f"\n合计: 前缀{total_p} 后缀{total_s}（指标: ≥12000 / ≥5000）")
sys.exit(0 if ok else 1)
