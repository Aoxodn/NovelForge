# Report Plan

## Meta
- **Type**: 功能规划文档（Feature Plan）
- **Topic**: NovelForge 离线小说创作软件 40 项功能清单——难度、优先级与技术方案，与 PRD V1.0（82 节）逐项对齐
- **Audience**: 产品/开发决策者（用户本人），用于排期与可行性判断
- **Language**: 中文

## Design System
- Palette: 纸墨编辑风 — bg #FAF8F4 / bg2 #F1EDE4 / ink #26221B / muted #6F675A / rule #E2DCCC / accent #3D5A80（靛蓝）/ accent2 #A66A2E（青铜）
- Fonts: Lora（标题，衬线，文学感）+ WorkSans（正文）+ DMMono（代码/依赖名）；CJK 回退系统字体
- Layout: 居中单栏 max-width 960px，编辑风刊头，章节大间距
- Components: h2 底部细规则线 + 节号；徽章胶囊（难度/优先级/竞争力）；表格仅行线 + 强表头下划线；引用块左侧 4px accent2
- Personality: 像一份装帧考究的技术蓝皮书——纸感、墨色、青铜点缀

## Structure
1. 这份文档怎么用（与 PRD 的关系、三个回答）
2. 评估口径（难度四级 / 优先级 / 竞争力标记；"零极高"结论）
3. 功能全景（40 项主表 + 模块×优先级堆叠图 + 阶段×难度图）
4. V1.0 核心写作闭环（16 项；四大硬骨头深挖）
5. V1.5 结构化数据系统（14 项；四大硬骨头深挖）
6. V2.0 深度分析与差异化（10 项；四大硬骨头深挖）
7. 差异化功能的技术内幕（8 项独有；竞品对照表 + Mermaid 数据流水线）
8. 技术依赖与风险（Rust 依赖表 + 五大风险）
9. 路线图与验收（7 阶段映射 + PRD 验收标准）

## Visuals
| Visual | Type | Tool | Purpose |
|--------|------|------|---------|
| 模块×优先级 | 堆叠柱状图 | ECharts | 功能密度与阶段分布 |
| 阶段×难度 | 分组柱状图 | ECharts | "每阶段四个硬骨头" |
| 数据流水线 | 流程图 | Mermaid | 实体→关联分析→差异化功能 |

## Key Facts（与表数据严格一致）
- 40 项功能：P0 16 / P1 14 / P2 10
- 难度：低 8 / 中 20 / 高 12；高难度恰好每阶段 4 项
- 独有竞争力 ● 共 8 项，全部在结构分析侧
- 引用来源：novelWriter / manuskript / bibisco / AI_NovelGenerator 仓库
