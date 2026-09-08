# -*- coding: utf-8 -*-
"""列出词典中同题材前缀跨类型重复词的具体位置（array → 行内容片段）。"""
import os
import re

DICT_DIR = os.path.join(os.path.dirname(__file__), "..", "src-tauri", "src", "names_dict")
KINDS = ["PLACE", "SECT", "TECH", "ITEM", "PILL", "BEAST", "PLANT"]

for fn in sorted(os.listdir(DICT_DIR)):
    if not fn.endswith(".rs"):
        continue
    src = open(os.path.join(DICT_DIR, fn), encoding="utf-8").read()
    arrs = {}
    for m in re.finditer(r"pub const (\w+): &\[&str\] = &\[(.*?)\];", src, re.S):
        arrs[m.group(1)] = re.findall(r'"([^"]+)"', m.group(2))
    seen = {}
    for k in KINDS:
        for w in arrs.get(f"{k}_PREFIX", []):
            seen.setdefault(w, []).append(k)
    dups = {w: ks for w, ks in seen.items() if len(ks) > 1}
    if dups:
        print(f"--- {fn[:-3]} ---")
        for w, ks in dups.items():
            print(f"  {w}: {ks}")
