---
feature: roadmap-p0-p2
status: delivered
updated: 2026-09-10
branch: feature/roadmap-p0-p2
commits: 1ec2193..a7386e3
---

# NovelForge 路线图功能包（P0–P2）

## Report

**What was built** — 一次落地 13 项新能力（P0 伏笔工作台 / 故事时间轴 / 全局剧情线过滤 / 人物状态账本 / 大纲分屏；P1 POV 仪表盘 / 设定词条 / 进度看板 / 称谓一致性 / 龙套批量铸造；P2 张力曲线 / 文风指纹 / 结构快照）。V19 迁移补齐 `foreshadows`、`chapter_arc_members`、章级时间/POV/看板字段、状态快照、词条库、称谓表与结构快照表；后端 `commands/roadmap.rs` 提供 32 个纯本地命令；前端扩展 viewMode、全局线过滤、分屏左栏与工具弹窗。评审 critical（称谓扫描 UTF-8 切片 panic）与 major（称谓 upsert 重复、时间轴写风暴、线归属入口缺失）已修复。

**Verification** — `cargo test --lib` 111 passed（含 5 条 roadmap 单测）；`npx tsc --noEmit` 通过；`npm test -- --run` 47 passed。评审后未重跑重型套件（改动集中在 roadmap 模块与前端工具页）。

**Journey log**
1. 分支上已有半成品 V19/models，从半成品续写而不是重开分支。
2. 大文件 write 因 JSON 截断失败，改为分段 write + edit。
3. Tauri 命令内中文片段截取必须用 char_indices，禁止字节切片。
4. 线过滤要有「写路径」：分屏与时间轴都提供章节→剧情线归属，否则过滤器永远为空。
5. 表单字段用 onBlur 提交，避免每键一次 IPC。

## [S1] Problem

三线伪群像写作中，伏笔散落在画布边、叙事时与发表序混用、线过滤缺失、人物知情状态无账本、写作时对照大纲不便；POV 轮转、设定检索、进度看板、称谓一致性、龙套铸造、张力/文风/结构快照均为空白。

## [S2] Design

### 数据层（migration V19）

- `foreshadows`：一等伏笔实体（类型/埋设/预期/回收/状态/剧情线/角色关联）
- `chapter_arc_members`：章节 × 剧情线多对多，`is_primary` 主线
- chapters 扩展：`story_time` / `story_order` / `timeline_group` / `pov_character_id` / `target_words` / `tension` / `board_lane`
- `character_state_snapshots`：人物状态切片（地点/存亡/阵营/知情）
- `lore_entries` + `lore_chapter_links`：设定词条库
- `address_forms`：称谓规范表（同 to+form upsert）
- `structure_snapshots`：结构 JSON 快照

### 后端命令模块 `commands/roadmap.rs`

统一导出全部新命令。伏笔跨度按全书章序估算，阈值沿用 settings 键 `foreshadow_overdue_threshold`（默认 10）。称谓扫描用字符边界截取片段。

### 前端

- 全局 `activeArcId` 线过滤 + `viewMode` 扩展（timeline / board / lore / foreshadow / pov / address / style）
- 分屏左栏 `SplitOutlinePane`（细纲 / 场景 / 伏笔 / 剧情线勾选；Ctrl+\）
- 工具弹窗：人物状态账本、龙套批量铸造
- 时间轴卡：故事时间（onBlur）、张力 1–5、剧情线下拉
- 顶栏：视图切换扩展、剧情线下拉、分屏开关、更多菜单入口

### 纯本地约束

不调用云端与 LLM；统计与规则扫描全部确定性。

## [S3] Out of Scope

- 云同步 / 协作 / AI 生成正文
- 自动语义实体识别
- 富文本编辑器升级
- 伏笔边与旧 `story_edges` 自动合并迁移（台账独立演进）

## Tasks

- [x] T1: V19 迁移 + models — acceptance: 打开旧库自动升到 v19 (covers: S2)
- [x] T2: roadmap.rs 命令 + lib 注册 — acceptance: cargo check 通过 (covers: S2; depends: T1)
- [x] T3: 前端 types/api/store — acceptance: typecheck 通过 (covers: S2)
- [x] T4: P0 UI（分屏/伏笔/线过滤/时间轴/状态账本）— acceptance: 可交互 (covers: S2; depends: T3)
- [x] T5: P1 UI（POV/设定/看板/称谓/龙套）— acceptance: 可交互 (covers: S2; depends: T3)
- [x] T6: P2 UI（张力/文风/结构快照）— acceptance: 可交互 (covers: S2; depends: T3)
- [x] T7: 测试与验证 — acceptance: vitest + cargo test 通过 (covers: S2)
