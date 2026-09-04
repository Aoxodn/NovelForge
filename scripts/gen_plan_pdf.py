# -*- coding: utf-8 -*-
"""NovelForge 项目计划书生成器"""
import os, datetime

from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import mm
from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER, TA_JUSTIFY, TA_LEFT
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Spacer, PageBreak, Table,
    TableStyle, KeepTogether, ListFlowable, ListItem,
)
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont

# ---------- 中文字体注册：依次尝试系统常见 CJK 字体 ----------
FONT_CANDIDATES = [
    r"C:\Windows\Fonts\msyh.ttc",        # 微软雅黑
    r"C:\Windows\Fonts\msyh.ttf",
    r"C:\Windows\Fonts\simhei.ttf",       # 黑体
    r"C:\Windows\Fonts\simsun.ttc",       # 宋体
    r"C:\Windows\Fonts\simsun.ttf",
    "/System/Library/Fonts/PingFang.ttc",
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/truetype/wqy/wqy-microhei.ttc",
]
CN = None
for p in FONT_CANDIDATES:
    if os.path.exists(p):
        try:
            pdfmetrics.registerFont(TTFont("CN", p))
            CN = "CN"
            break
        except Exception:
            continue
if CN is None:
    raise RuntimeError("未找到系统中文字体，无法生成中文 PDF")

OUT = r"d:\项目\Projects\NovelForge\NovelForge_项目计划书_v1.0.pdf"

# ---------- 样式 ----------
styles = getSampleStyleSheet()
sTitle = ParagraphStyle("T", fontName=CN, fontSize=24, leading=32, alignment=TA_CENTER, textColor=colors.HexColor("#1f2e2e"), spaceAfter=6)
sSubtitle = ParagraphStyle("S", fontName=CN, fontSize=12, leading=18, alignment=TA_CENTER, textColor=colors.HexColor("#666"), spaceAfter=28)
sH1 = ParagraphStyle("H1", fontName=CN, fontSize=18, leading=26, textColor=colors.HexColor("#2a4a6b"), spaceBefore=16, spaceAfter=10, borderWidth=0, borderPadding=0)
sH2 = ParagraphStyle("H2", fontName=CN, fontSize=14, leading=22, textColor=colors.HexColor("#3D5A80"), spaceBefore=12, spaceAfter=6)
sH3 = ParagraphStyle("H3", fontName=CN, fontSize=12, leading=18, textColor=colors.HexColor("#A66A2E"), spaceBefore=8, spaceAfter=4)
sBody = ParagraphStyle("B", fontName=CN, fontSize=10.5, leading=18, alignment=TA_JUSTIFY, firstLineIndent=21, spaceAfter=4)
sBodyNoIndent = ParagraphStyle("BN", fontName=CN, fontSize=10.5, leading=18, alignment=TA_LEFT, spaceAfter=3)
sBullet = ParagraphStyle("BL", fontName=CN, fontSize=10.5, leading=17, leftIndent=16, bulletIndent=4, spaceAfter=2)
sCaption = ParagraphStyle("C", fontName=CN, fontSize=9, leading=13, textColor=colors.HexColor("#555"), alignment=TA_CENTER, spaceAfter=6)
sFooter = ParagraphStyle("F", fontName=CN, fontSize=8, textColor=colors.grey)

INK = colors.HexColor("#26221B")
ACCENT = colors.HexColor("#3D5A80")
BRONZE = colors.HexColor("#A66A2E")
PAPER = colors.HexColor("#FAF8F4")
RULE_COLOR = colors.HexColor("#E2DCCC")

# ---------- 文档页眉页脚 ----------
def on_page(canvas, doc):
    canvas.saveState()
    canvas.setFillColor(PAPER)
    canvas.rect(0, 0, A4[0], A4[1], fill=1, stroke=0)
    # 顶部装饰线
    canvas.setStrokeColor(ACCENT)
    canvas.setLineWidth(1.2)
    canvas.line(20*mm, A4[1]-18*mm, A4[0]-20*mm, A4[1]-18*mm)
    canvas.setStrokeColor(BRONZE)
    canvas.setLineWidth(0.6)
    canvas.line(20*mm, A4[1]-19.2*mm, A4[0]-20*mm, A4[1]-19.2*mm)
    # 页眉
    canvas.setFont(CN, 8)
    canvas.setFillColor(colors.HexColor("#6F675A"))
    canvas.drawString(20*mm, A4[1]-16*mm, "NovelForge · 项目计划书")
    canvas.drawRightString(A4[0]-20*mm, A4[1]-16*mm, f"Version 1.0  ·  {datetime.date.today().isoformat()}")
    # 页码
    canvas.drawCentredString(A4[0]/2, 14*mm, f"— 第 {doc.page} 页 —")
    # 底部细线
    canvas.setStrokeColor(RULE_COLOR)
    canvas.setLineWidth(0.4)
    canvas.line(20*mm, 20*mm, A4[0]-20*mm, 20*mm)
    canvas.restoreState()

doc = SimpleDocTemplate(
    OUT, pagesize=A4,
    leftMargin=22*mm, rightMargin=22*mm, topMargin=26*mm, bottomMargin=26*mm,
    title="NovelForge 项目计划书",
    author="NovelForge Team",
)

def P(txt, style=sBody):
    return Paragraph(txt, style)

def B(text):
    return Paragraph(f"• {text}", sBullet)

def H1(n, t):
    return P(f"<b>第 {n} 章　{t}</b>", sH1)

def H2(n, t):
    return P(f"<b>{n}　{t}</b>", sH2)

def H3(t):
    return P(f"<b>{t}</b>", sH3)

def HRULE():
    t = Table([[""]], colWidths=[doc.width])
    t.setStyle(TableStyle([("LINEBELOW", (0,0), (-1,0), 0.4, RULE_COLOR), ("TOPPADDING",(0,0),(-1,-1),0), ("BOTTOMPADDING",(0,0),(-1,-1),4)]))
    return t

def mk_table(data, header=True, widths=None):
    if widths is None:
        widths = [doc.width / len(data[0])] * len(data[0])
    t = Table(data, colWidths=widths, repeatRows=1 if header else 0)
    style = [
        ("FONTNAME", (0,0), (-1,-1), CN),
        ("FONTSIZE", (0,0), (-1,-1), 9.5),
        ("VALIGN", (0,0), (-1,-1), "MIDDLE"),
        ("LEFTPADDING", (0,0), (-1,-1), 5),
        ("RIGHTPADDING", (0,0), (-1,-1), 5),
        ("TOPPADDING", (0,0), (-1,-1), 5),
        ("BOTTOMPADDING", (0,0), (-1,-1), 5),
        ("LINEBELOW", (0,0), (-1,-1), 0.3, RULE_COLOR),
    ]
    if header:
        style += [
            ("BACKGROUND", (0,0), (-1,0), colors.HexColor("#E8EEF6")),
            ("TEXTCOLOR", (0,0), (-1,0), ACCENT),
            ("FONTNAME", (0,0), (-1,0), CN),
            ("LINEBELOW", (0,0), (-1,0), 1.2, ACCENT),
        ]
    # 斑马纹
    for i in range(1, len(data)):
        if i % 2 == 0:
            style.append(("BACKGROUND", (0,i), (-1,i), colors.HexColor("#FBF9F4")))
    t.setStyle(TableStyle(style))
    return t

story = []

# ==================== 封面 ====================
story.append(Spacer(1, 40*mm))
story.append(P("NovelForge", sTitle))
story.append(P("小说工坊", ParagraphStyle("tt", fontName=CN, fontSize=30, leading=40, alignment=TA_CENTER, textColor=ACCENT)))
story.append(Spacer(1, 8*mm))
story.append(HRULE())
story.append(Spacer(1, 4*mm))
story.append(P("—— 本地优先、零 AI 依赖的中文长篇小说创作平台 ——", sSubtitle))
story.append(Spacer(1, 18*mm))

meta_data = [
    ["项目名称", "NovelForge（小说工坊）"],
    ["版本号", "v1.0 · 阶段 6 进行中"],
    ["文档类型", "详细项目计划书"],
    ["编写日期", datetime.date.today().isoformat()],
    ["技术栈", "Tauri 2 · Rust（后端，SQLite 内嵌）+ React 19 + TypeScript（前端）"],
    ["部署形态", "纯本地 Windows 桌面软件（NSIS 安装包，无网络依赖）"],
    ["核心设计原则", "没有 AI，软件的价值 = 确定性计算 + 信息管理"],
]
story.append(mk_table([["项  目", "内  容"]] + meta_data, widths=[35*mm, 120*mm]))
story.append(PageBreak())

# ==================== 1. 项目概述 ====================
story.append(H1("一", "项目概述"))
story.append(H2("1.1", "项目背景"))
story.append(P("目前市面上的中文小说写作工具可分为三类：一是以《墨刀》《有道云》为代表的云笔记类工具，胜在方便但缺少小说特有的章节/分卷结构，更缺少导入、导出、备份等出版级能力；二是以《笔趣阁》《起点作家助手》为代表的平台自带编辑器，其数据归平台所有、作者无法迁移；三是以 Manuskript、novelWriter、bibisco 为代表的开源桌面软件，功能完整但不贴近中文写作习惯（中文标题识别、中文分词友好度、GB18030 编码兼容、卷章结构匹配网文连载模式）。"))
story.append(P("NovelForge 正是针对以上缺口诞生：以 Rust 内嵌 SQLite 为核心数据层，保证单章独立存储、崩溃可恢复；以 React 19 构建三栏式（目录树 + 编辑器 + 信息面板）中文写作界面；严格遵守本地优先原则，不接入任何 AI 服务，所有功能依靠确定性计算与信息管理实现。"))

story.append(H2("1.2", "项目定位与目标用户"))
story.append(B("核心用户：网文作者（起点/番茄/飞卢平台长篇连载作者，50 万字以上量级）"))
story.append(B("次级用户：传统文学小说作者、编剧、剧本创作者"))
story.append(B("用户核心痛点：丢稿怕、防盗 TXT 导入乱、章节管理混乱、每天日更没动力、人物登场乱忘、平台机审卡敏感词"))

story.append(H2("1.3", "差异化价值主张"))
story.append(P("NovelForge 与同类产品相比的四大差异化：", sBodyNoIndent))
story.append(B('<b>极致离线安全：</b>数据库 SQLite 内嵌；项目文件 = 一个可拷贝目录；无账户、无云、无分析上传；30 分钟自动 ZIP 备份 + 章节级 50 版本回滚，从根子上解决丢稿焦虑。'))
story.append(B('<b>中文导入天花板：</b>实测《捡漏》26MB GB18030 文件 4553 章秒级拆分；支持防盗填充自动检测与剔除（同段占位内容重复 456 次时精准识别）、TXT/DOCX 双格式、用户可视预览+边界调整。'))
story.append(B('<b>零噪声信息管理：</b>放弃阶段 5 中「自动识别人物」的识别流程（真实网文上人物候选高达 2374 条，确认流程不可扩展），改道为「作者手动建卡 + 引擎精确匹配统计」的模式——名字+别名计数 100% 精确，零确认负担。'))
story.append(B('<b>作者感知强的日常：</b>码字统计仪表盘（今日字数、连续写作天数、近 60 天柱状图、最佳日、活跃天数），精准戳中网文作者「日更 4000、全勤奖就是钱」的刚需。'))

story.append(PageBreak())

# ==================== 2. 功能范围 ====================
story.append(H1("二", "功能范围与阶段规划"))
story.append(H2("2.1", "阶段路线图（已完成 5/6）"))
phases = [
    ["阶段 1", "项目骨架 + 编辑器", "新建/打开项目、目录树、三栏布局、自动保存 500ms 防抖", "已完成"],
    ["阶段 2", "卷章管理", "新建/重命名/移动/删除/分卷、状态标记、字数统计、排序", "已完成"],
    ["阶段 3", "导入系统", "TXT / DOCX 导入、GB18030 兼容、防盗填充检测、章节边界调整 UI", "已完成"],
    ["阶段 4", "导出 + 搜索 + 备份", "TXT/DOCX/MD 三格式导出、全文检索（含片段高亮）、ZIP 自动备份 + 恢复", "已完成"],
    ["阶段 5", "实体识别（已改道）", "自动人物/地点识别已废弃；改道手动建卡+精确匹配统计；安装包 NSIS 已发布", "已完成 (改道)"],
    ["阶段 6", "码字统计 + 手动人物卡", "日码字统计与仪表盘、连续打卡、人物/地点手动 CRUD、精确提及计数与热度条、本章出场卡", "进行中"],
    ["阶段 7", "校对与发布", "敏感词扫描、错别字检查、重复口头禅检测、完本进度与导出增强", "待启动"],
]
story.append(mk_table(
    [["阶段", "主题", "核心交付", "状态"]] + phases,
    widths=[18*mm, 36*mm, 80*mm, 20*mm],
))

story.append(H2("2.2", "已实现功能清单（截至阶段 5）"))
features_done = [
    ["项目骨架", "create_project / open_project / close_project / 最近项目 20 条", "9 commands"],
    ["编辑器", "行内标题编辑、500ms 防抖 + 5min 快照 + Ctrl+S 快照、Tab 全角缩进、实时字数/段落/阅读时长", "2 hooks + 14 UI 组件"],
    ["卷章管理", "create/rename/move/delete/set_status 全部事务化；跨卷移动 sort_order 重排", "9 SQL 事务"],
    ["导入系统", "TXT + DOCX；7 条识别规则 + 中文边界；重复内容四重指纹；预览确认 UX", "5 Rust files · 84 tests pass"],
    ["导出系统", "TXT / DOCX / MD；范围（全书/卷/单章）；DOCX 含自动目录", "3 writers"],
    ["全文搜索", "SQL LIKE + 正则；前后文片段 + 命中数 badge", "1 command"],
    ["备份系统", "30 分钟自动 ZIP + 手动备份 + 列表 + 恢复前自动冲刷", "backup.rs"],
    ["版本快照", "chapter_versions 每章最多 50 条；恢复前自动备份当前版", "InfoPanel 快照卡"],
    ["主题系统", "深色 / 浅色 / 护眼三主题循环切换 + 字体字号行距", "SettingsModal"],
]
story.append(mk_table(
    [["模块", "已实现能力", "代码位置"]] + features_done,
    widths=[24*mm, 96*mm, 35*mm],
))

story.append(H2("2.3", "阶段 6 本轮交付（进行中）"))
story.append(H3("A. 码字统计仪表盘（新增）"))
story.append(B("writing_daily 表（YYYY-MM-DD 主键）：保存章节时正增长记账（删除不扣减）"))
story.append(B("今日 +N 字数实时刷新（StatusBar 右侧同步显示）"))
story.append(B("连续写作天数 streak（今天未写则从昨天起算）"))
story.append(B("活跃天数、单日最高字数字 + 近 60 天柱状图"))
story.append(B("全书当前总字数 / 章节数一览"))
story.append(H3("B. 人物 / 地点卡改造（替换阶段 5 鸡肋识别）"))
story.append(B("DB 迁移 v3：清除 status!=1 的候选/忽略实体；废弃 events / timeline_markers / analysis_cache 三表"))
story.append(B("新增 matching.rs 精确匹配引擎：名字+别名构建正则交替式，最长优先不重叠计数"))
story.append(B("人物 CRUD：手动新建、重命名、别名管理、角色定位、备注、删除"))
story.append(B("人物统计：总出场、出场章节、首现章、最近章、断档预警、全书热度条（per_chapter 对齐）"))
story.append(B("地点 CRUD + 同样精确匹配统计"))
story.append(B("本章出场卡（InfoPanel 替换分析卡）：当前章节中已建卡的人物/地点及出现次数"))

story.append(PageBreak())

# ==================== 3. 技术架构 ====================
story.append(H1("三", "技术架构设计"))
story.append(H2("3.1", "整体架构图（文字版）"))
story.append(P("前端（React 19 + TypeScript + Vite + Zustand）通过 Tauri 2 IPC 通道调用后端 commands；后端（Rust + Tauri 2）分为 commands 编排层、db 迁移/连接层、import/analysis/text 纯函数层；数据层由内嵌 SQLite（WAL + 外键 + NORMAL 同步级别）承载，<项目目录>/database/novel.db 为单项目库，%APPDATA%/NovelForge/app.db 为全局库（最近项目）。", sBodyNoIndent))

story.append(H2("3.2", "技术栈选型与理由"))
tech = [
    ["Tauri 2", "桌面壳", "Electron 的 1/10 体积（3.5MB vs 120MB+）；Rust 内存安全；原生菜单/窗口/文件对话框"],
    ["Rust + rusqlite (bundled)", "数据层", "SQLite 编译进二进制，用户无需安装任何数据库；事务保证保存/备份/导入原子性"],
    ["React 19 + TypeScript 5.6", "UI", "生态成熟；tsc --noEmit 构建前类型检查，降低 runtime 错误"],
    ["Zustand 5", "状态管理", "相比 Redux 体积小、样板少；两个 store 分工：appStore（项目级） + editorStore（编辑器）"],
    ["regex 1.13", "导入识别 / 精确匹配", "Rust 生态最成熟正则，支持 Unicode 文本处理，不回溯性能高"],
    ["quick-xml + encoding_rs", "DOCX 导入 / 编码", "DOCX 的 word/document.xml 解析；TXT 的 GB18030 解码（实测 26MB 文件）"],
    ["zip 8.6 (deflate)", "备份压缩 / DOCX", "默认功能裁剪干净，仅启用放气压缩，无多余依赖"],
    ["NSIS", "Windows 安装包", "Tauri 自带 bundle；已实测发布 NovelForge_0.1.0_x64-setup.exe"],
]
story.append(mk_table(
    [["技术", "角色", "选型理由"]] + tech,
    widths=[36*mm, 20*mm, 99*mm],
))

story.append(H2("3.3", "数据库 Schema 全景（v3 迁移后）"))
schema = [
    ["project_info", "单行表", "项目名/作者/简介/创建更新时间/schema_version"],
    ["volumes", "卷", "标题/简介/排序/更新时间"],
    ["chapters", "章节（核心）", "所属卷/标题/正文/字数/字数字符数/状态/梗概/笔记/内容指纹（FNV-1a）"],
    ["chapter_versions", "章节历史快照", "每章最多 50 条；自动/手动/恢复前备份三类型"],
    ["characters", "人物卡", "名字 UNIQUE/别名 JSON/角色定位/备注（全部手动，无 status 列）"],
    ["locations", "地点卡", "名字 UNIQUE/备注"],
    ["character_mentions", "人物 × 章节", "精确匹配计数，Upsert 增量更新；作为热度条/首末章/断档统计数据源"],
    ["location_mentions", "地点 × 章节", "同理（精确匹配）"],
    ["writing_daily", "码字统计", "日期主键/当日净增正字数/保存次数；统计仪表盘唯一数据源"],
    ["settings", "KV 设置", "编辑器偏好等（阶段 4 已预留）"],
]
story.append(mk_table(
    [["表名", "用途", "关键字段"]] + schema,
    widths=[36*mm, 30*mm, 89*mm],
))
story.append(P("迁移策略：PRAGMA user_version 顺序迁移，新增功能仅追加 (version, SQL) 对，不修改历史；新版本软件打开旧项目自动补齐。", sBodyNoIndent))

story.append(H2("3.4", "核心数据流"))
story.append(H3("自动保存流"))
story.append(P("用户输入 → editorStore.setContent（dirty=true）→ useAutoSave 500ms 防抖 → save(false) 走 tauri IPC → save_chapter 事务：更新正文 + 字数 + 指纹 + 写作日记账；若 snapshot=true（5 分钟周期或 Ctrl+S），还额外 INSERT chapter_versions + 清理超出 50 条的旧版；前端回调刷新字数、今日字数、树统计。", sBodyNoIndent))
story.append(H3("导入流"))
story.append(P("importAnalyzeFile 读取 TXT/DOCX → 编码检测（encoding_rs）→ 7 规则切章 → 四重指纹去重（完全相同/内容指纹/首末段指纹/整章 hash）→ 返回 ImportAnalysis（章节预览 + confidence + duplicate_of 来源）→ 用户调整 excluded/discarded → importConfirm 事务一次性落库 chapters/volumes 并返回 ImportResult。", sBodyNoIndent))
story.append(H3("精确匹配计数流"))
story.append(P("作者在 AnalysisModal 新建人物卡（名字+别名）→ matching.rs 构建「名字|别名1|别名2…」正则（最长优先、元字符转义）→ 遍历全书章节统计提及数 → 写入 character_mentions（Upsert） → get_characters 聚合出首末章/总出场/章节数/断档。", sBodyNoIndent))

story.append(PageBreak())

# ==================== 4. 详细阶段 6 实施 ====================
story.append(H1("四", "阶段 6 详细实施方案"))
story.append(H2("4.1", "后端改造清单（Rust）"))
rs = [
    ["1", "migrations.rs 追加 v3", "writing_daily 表、清候选数据、DROP 派生三表", "新增 ~40 行"],
    ["2", "matching.rs（新增）", "精确匹配正则计数 + 8 单测（别名合并/长词优先/元字符转义）", "~90 行 · 8 tests"],
    ["3", "models.rs 重构", "CharacterProfile/CharacterHeat/LocationProfile 去掉 status；新增 ChapterPresenceView / DailyWords / WritingStats；SaveResult 加 today_words 字段", "改 ~200 行"],
    ["4", "chapter.rs save_chapter", "保存时计算 (new_words - old_words).max(0)，UPSERT writing_daily 当日；返回 today_words", "改 ~20 行"],
    ["5", "analysis.rs 重构", "删 analyze_project / set_character_status / set_location_status / get_chapter_analysis / get_book_analysis；重写 get_characters / get_character_heat / get_locations / add_character / update_character / delete_character 走精确匹配；新增 rebuild_mentions / refresh_chapter_mentions / add_location / update_location / delete_location / get_chapter_presence / get_writing_stats", "改 ~800 行"],
    ["6", "lib.rs 命令注册", "移除旧命令，注册新命令", "改 ~20 行"],
    ["7", "db/mod.rs 注释", "修正 V3 以后结构说明", "改 ~5 行"],
]
story.append(mk_table(
    [["#", "模块", "改动要点", "规模"]] + rs,
    widths=[10*mm, 30*mm, 90*mm, 25*mm],
))

story.append(H2("4.2", "前端改造清单（React + TS）"))
fe = [
    ["1", "api/index.ts", "去 analyzeProject / setCharacterStatus / setLocationStatus / getBookAnalysis / getChapterAnalysis；新增 addLocation / updateLocation / deleteLocation / getChapterPresence / getWritingStats / refreshMentions", "改 ~60 行"],
    ["2", "types/models.ts", "同步 models.rs 类型（删 status；新增 DailyWords、WritingStats、ChapterPresenceView）", "改 ~80 行"],
    ["3", "editorStore.save", "返回 today_words 同步写入状态", "改 ~5 行"],
    ["4", "AnalysisModal.tsx", "重构为「人物/地点」两 Tab；删候选/忽略/重新分析 UI；改成纯手动 CRUD + 统计展示 + 热度条 + 断档预警", "重写 ~650 行"],
    ["5", "StatsModal.tsx（新增）", "码字统计仪表盘：今日/连击/活跃/最佳日 + 60 天柱状图（纯 CSS 绘制，无 echarts 依赖）", "新增 ~250 行"],
    ["6", "TopBar.tsx", "新增统计入口（柱状图图标）；旧的人物库按钮保留（指向 AnalysisModal）", "改 ~10 行"],
    ["7", "StatusBar.tsx", "右侧显示「今日 +XXXX 字」（从 editorStore.today_words 读）", "改 ~10 行"],
    ["8", "InfoPanel.tsx", "「本章分析卡」→「本章出场卡」，显示已建卡人物/地点出现次数；去掉时间线/事件", "改 ~100 行"],
    ["9", "ProjectView.tsx", "删除打开项目时自动 analyze_project 调用（该命令已移除）", "删 ~10 行"],
    ["10", "icons.tsx", "新增 IconChart 柱状图 icon", "加 ~15 行"],
    ["11", "global.css", "StatsModal/出场卡相关样式（.stats-hero / .stats-bar-row / .presence-chip）", "加 ~80 行"],
]
story.append(mk_table(
    [["#", "文件", "改动要点", "规模"]] + fe,
    widths=[10*mm, 32*mm, 85*mm, 28*mm],
))

story.append(H2("4.3", "测试计划"))
story.append(H3("Rust 单元测试"))
story.append(B("matching.rs：8 个已写（见上文）"))
story.append(B("db/migrations：V1→V3 升级（空库新建 + 含候选脏数据的 V2 库升级，检查候选被清、writing_daily 表存在）"))
story.append(B("analysis.rs rebuild_mentions：建卡后已知输入的章节内容，验证计数精确"))
story.append(B("chapter.rs save_chapter：正增长计入 writing_daily，零增长与负增长不扣减"))
story.append(H3("前端构建"))
story.append(B("tsc --noEmit（vite build 前执行）"))
story.append(B("cargo test（预期 ≥ 84 passed）"))

story.append(PageBreak())

# ==================== 5. UI/UX 设计 ====================
story.append(H1("五", "UI / UX 设计概述"))
story.append(H2("5.1", "设计风格延续"))
story.append(P("沿用已确认的「简约高级 + 纸墨编辑风」主题：背景 #FAF8F4（米纸）、边框 #E2DCCC（浅灰线）、主色 #3D5A80（靛蓝）、点缀色 #A66A2E（青铜）；字体为系统中文（微软雅黑/PingFang）回退机制，编辑器支持字体/字号/行距独立设置，内置 3 主题循环（深色/浅色/护眼）。"))

story.append(H2("5.2", "阶段 6 新增界面"))
ui = [
    ["码字统计弹窗 (StatsModal)", "仪表盘布局：顶部四张英雄卡（今日 / 连击 / 活跃 / 最佳日）；中部 60 天柱状图（CSS div 绘制，每根柱子悬停显示 tooltip）；底部全书快照（字数/章节/已写 30% 进度条）", "800×600 Modal"],
    ["人物卡 Tab (AnalysisModal)", "无候选/忽略分组；直接是单列表（按总出场降序）；每行名字+角色 badge+别名 chips+统计行+热度条 strip；右上「新建人物」按钮；操作列 = 定位 / 别名 / 备注 / 删除 四个操作", "800 Modal"],
    ["地点卡 Tab (AnalysisModal)", "同人物卡简化版；无别名/定位，只有名字、备注、统计、删除", "800 Modal"],
    ["本章出场卡 (InfoPanel)", "两个 chips 区域：人物 chips（「金锋 ×47」）+ 地点 chips，点击可跳转到对应卡编辑（预留）", "右侧 InfoPanel"],
    ["StatusBar 今日字数", "在「全书 XXX 字」前增加「今日 +1280 字」青铜色 badge，保存后平滑滚动数字", "底部 StatusBar"],
    ["TopBar 统计入口", "新增柱状图 icon 按钮（IconChart），位于人物库旁，点击打开 StatsModal", "顶部 TopBar"],
]
story.append(mk_table(
    [["界面", "描述", "位置"]] + ui,
    widths=[36*mm, 90*mm, 30*mm],
))

story.append(H2("5.3", "交互原则"))
story.append(B("所有破坏性操作（删除人物/恢复历史版本/清空快照）一律二次确认"))
story.append(B("保存反馈：保存中呼吸灯、保存完成 0.8s 绿色闪光、字数滚动动画"))
story.append(B("快捷键一致：Ctrl+N 新章、Ctrl+F 搜索、Ctrl+S 保存+快照、Tab 全角缩进"))
story.append(B("错误友好：所有后端 command 抛错前端以 Toast 展示，不抛弹框打断写作"))

# ==================== 6. 质量保障 ====================
story.append(H1("六", "质量保障与测试策略"))
story.append(H2("6.1", "分层测试金字塔"))
story.append(B("<b>单元层（Rust）：</b>matching.rs 精确匹配 8 项；导入 detector.rs 7 规则 + 重复检测；text.rs 字数统计/FNV 指纹"))
story.append(B("<b>命令层（Rust + SQLite）：</b>migrations.rs 顺序迁移；chapter.rs 保存事务与快照裁剪；backup.rs ZIP 压缩解压往返"))
story.append(B("<b>类型层（TypeScript）：</b>前端所有 API 返回、Model 类型与 Rust serde camelCase 完全对齐；tsc --noEmit 在构建前强制通过"))
story.append(B("<b>集成层（构建验证）：</b>npm run build（tsc + vite）→ cargo test → tauri build（NSIS 安装包）三步 CI"))
story.append(B("<b>手工冒烟：</b>《捡漏》26MB 导入 + 保存一章 + 建 5 人物卡 + 导出 DOCX → 检查 mentions 计数、字数累计、ZIP 备份"))

story.append(H2("6.2", "性能指标（验收阈值）"))
perf = [
    ["项目打开（空项目）", "< 300 ms"],
    ["项目打开（3k 章）", "< 1.5 s"],
    ["保存一章 4k 字", "< 100 ms（无快照），< 200 ms（含快照）"],
    ["《捡漏》26MB 导入预览", "< 5 s"],
    ["导入确认落库（4500 章）", "< 15 s"],
    ["精确匹配全量重建（3k章 × 50 人物）", "< 30 s（后台异步，不阻塞 UI）"],
    ["ZIP 备份（3k 章项目）", "< 5 s"],
    ["安装包体积", "< 10 MB（实测 3.5 MB，达标）"],
]
story.append(mk_table(
    [["场景", "SLA"]] + perf,
    widths=[80*mm, 75*mm],
))

story.append(H2("6.3", "错误处理"))
story.append(P("后端统一 AppError（thiserror 2）：Msg 用户友好文本 + Rusqlite/Sql 原始错误入日志；前端 api/client.ts 所有 invoke 以 Promise.reject 抛出并 Toast 展示；导入/备份等长操作用互斥状态避免重入（analyzing/saving/restoring 布尔）。"))

story.append(PageBreak())

# ==================== 7. 项目里程碑 ====================
story.append(H1("七", "项目里程碑与验收标准"))
ms = [
    ["M1 · DB 迁移 v3 + matching.rs", "迁移执行 + 8 matching 测试全绿；旧库中 status!=1 的人物被正确清理", "阶段 6 第 1 天"],
    ["M2 · 码字统计后端", "save_chapter 返回 today_words；get_writing_stats 输出 6 字段全部正确；Rust 测试覆盖正/零/负增长", "阶段 6 第 1-2 天"],
    ["M3 · 人物卡后端改造", "精确匹配 mentions 重建+增量；add/update/delete/heat 全链路；InfoPanel 本章出场 API", "阶段 6 第 2-3 天"],
    ["M4 · AnalysisModal 重构", "人物/地点两 Tab 纯手动 CRUD；候选/忽略/重新分析 UI 全部移除；断档预警、热度条显示", "阶段 6 第 3-4 天"],
    ["M5 · StatsModal + StatusBar 今日字数", "仪表盘四卡 + 60 天柱状图（无 ECharts 依赖）；状态栏今日字数随保存刷新", "阶段 6 第 4-5 天"],
    ["M6 · InfoPanel 出场卡 + 联调", "本章出场卡替换分析卡；ProjectView 删除自动 analyze_project；整体联调无 TS error", "阶段 6 第 5 天"],
    ["M7 · 发布", "cargo test ≥ 84 passed；tsc --noEmit；tauri build 生成新的 NSIS 安装包", "阶段 6 第 6 天"],
]
story.append(mk_table(
    [["里程碑", "验收标准", "计划时间"]] + ms,
    widths=[40*mm, 85*mm, 30*mm],
))

story.append(H1("八", "风险与应对"))
risks = [
    ["R1", "精确匹配人名重叠（如「苏婉」误匹配「苏婉清」）", "中", "matching.rs 已按最长优先+不重叠计数解决；单元测试覆盖；极端情况作者可用别名区分别名管理"],
    ["R2", "migration v3 在用户大项目上耗时过长", "低", "所有 DELETE 走索引（status/外键）；SQLite 在 10万行以下为 <1s；且 migration 包在事务中失败即回滚"],
    ["R3", "码字统计负值争议（删改后净增为负，要不要扣？）", "低", "方案：只计正增长（.max(0)）——作者删改视为正常迭代，不惩罚今日码字；文档与代码注释明确口径"],
    ["R4", "NSIS 安装包在升级时覆盖用户数据库", "高", "数据库在 <项目目录>/database/ 下而非 AppData；升级只替换安装目录的 exe；用户项目目录完全独立。NSIS 安装脚本默认不覆盖用户数据目录"],
    ["R5", "60 天柱状图 0 数据时 UX 空洞", "低", "StatsModal 空态引导：「尚未有码字记录，开始写下第一章吧」；今日第一字保存后立即触发刷新"],
]
story.append(mk_table(
    [["编号", "风险描述", "等级", "应对措施"]] + risks,
    widths=[10*mm, 50*mm, 12*mm, 80*mm],
))

# ==================== 9. 团队 ====================
story.append(H1("九", "团队与协作方式"))
story.append(P("本项目当前为单人核心开发 + AI 辅助开发（TRAE Workspace）模式。协作方式：TraeWork 会话作为单一事实来源（SSOT）；每次功能迭代开始前先 review 阶段进度截图确认需求 → 细分任务清单（TodoWrite 工具）→ 先测试后代码 → Rust + TS 双重检查 → 生成安装包；阶段验收通过 TraeWork 分享链接 + 安装包交付。", sBodyNoIndent))

# ==================== 10. 预算 ====================
story.append(H1("十", "预算估算"))
budget = [
    ["开发人力（单人 · 15 天/阶段 × 6 阶段）", "6,000", "参考单价 1000 元/天；实际自开发为零直接成本"],
    ["云基础设施", "0", "纯本地软件，零服务器、零 API、零 CDN"],
    ["AI 辅助开发订阅（TRAE）", "0（自用）/ ~300/月", "TRAE Workspace 专业版"],
    ["代码签名证书（可选，免 SmartScreen）", "~1,500/年", "EV 代码签名；当前阶段暂不需要"],
    ["分发渠道（自建官网/作者分享）", "~200/年", "域名+静态空间；或纯网盘分发，成本 0"],
    ["合计（自开发 + 暂不签名）", "≈ 0 ~ 500", "第一年运行成本极低"],
]
story.append(mk_table(
    [["费用项", "金额（元/年）", "备注"]] + budget,
    widths=[70*mm, 35*mm, 50*mm],
))

# ==================== 11. 结语 ====================
story.append(Spacer(1, 10*mm))
story.append(H1("十一", "结语"))
story.append(P("NovelForge 的核心信念是：<b>好的写作软件应该像一张结实的书桌——不喧宾夺主、不丢稿、不添麻烦，只在作者每天打开它的那几个小时里，可靠地替他管好书、记好字、算好数。</b>"))
story.append(P("阶段 5 的改道（砍掉鸡肋识别）让我们更坚定地回到了这条主线：不做需要语义理解的花哨功能，只把作者真正每天要面对的痛点——导入脏乱、字数记录、人物记混、怕丢稿、全勤奖——用纯粹的确定性计算一件件解决。阶段 6 完成后，NovelForge 将从「能写小说的编辑器」正式升级为「作者每天愿意打开的写作工具」。"))
story.append(Spacer(1, 12*mm))
story.append(HRULE())
story.append(Spacer(1, 3*mm))
story.append(P(f"本计划书由 NovelForge 项目代码与当前进度自动生成 · 生成日期 {datetime.date.today().isoformat()} · NovelForge v1.0", sCaption))

# ============ 构建 PDF ============
doc.build(story, onFirstPage=on_page, onLaterPages=on_page)
print("PDF generated:", OUT)
print("File size (KB):", round(os.path.getsize(OUT)/1024, 1))
