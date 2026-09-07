//! 项目数据库迁移系统。
//!
//! 基于 `PRAGMA user_version` 的顺序迁移：已应用的迁移不会重复执行，
//! 新版本软件打开旧项目时自动补齐缺失的表结构，保证向前兼容。

use crate::error::Result;
use rusqlite::Connection;

/// 迁移列表：(版本号, SQL)。新增功能时只追加，不修改历史迁移。
const MIGRATIONS: &[(i64, &str)] = &[(
    1,
    // V1：基础写作结构
    "
    CREATE TABLE IF NOT EXISTS project_info (
        id           INTEGER PRIMARY KEY CHECK (id = 1),  -- 单行表
        name         TEXT NOT NULL,
        author       TEXT NOT NULL DEFAULT '',
        description  TEXT NOT NULL DEFAULT '',
        created_at   TEXT NOT NULL DEFAULT (datetime('now','localtime')),
        updated_at   TEXT NOT NULL DEFAULT (datetime('now','localtime')),
        schema_version INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS volumes (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        title      TEXT NOT NULL,
        summary    TEXT NOT NULL DEFAULT '',
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );

    -- 章节是独立数据对象：支持移动 / 复制 / 删除 / 合并 / 拆分 / 排序 / 版本恢复
    CREATE TABLE IF NOT EXISTS chapters (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        volume_id    INTEGER NOT NULL REFERENCES volumes(id) ON DELETE CASCADE,
        title        TEXT NOT NULL,
        content      TEXT NOT NULL DEFAULT '',
        word_count   INTEGER NOT NULL DEFAULT 0,
        char_count   INTEGER NOT NULL DEFAULT 0,
        sort_order   INTEGER NOT NULL DEFAULT 0,
        status       INTEGER NOT NULL DEFAULT 0,      -- 0=草稿 1=完稿
        summary      TEXT NOT NULL DEFAULT '',        -- 章节梗概（供后续分析）
        notes        TEXT NOT NULL DEFAULT '',        -- 作者笔记（导出投稿模式可剔除）
        content_hash TEXT NOT NULL DEFAULT '',        -- 增量分析预留：内容未变则跳过重分析
        created_at   TEXT NOT NULL DEFAULT (datetime('now','localtime')),
        updated_at   TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );
    CREATE INDEX IF NOT EXISTS idx_chapters_volume ON chapters(volume_id, sort_order);

    -- 章节历史版本（自动快照 / 手动快照），支撑崩溃恢复与版本管理
    CREATE TABLE IF NOT EXISTS chapter_versions (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        chapter_id   INTEGER NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
        title        TEXT NOT NULL,
        content      TEXT NOT NULL,
        word_count   INTEGER NOT NULL DEFAULT 0,
        version_type INTEGER NOT NULL DEFAULT 0,      -- 0=自动快照 1=手动快照 2=恢复前备份
        created_at   TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );
    CREATE INDEX IF NOT EXISTS idx_versions_chapter ON chapter_versions(chapter_id, created_at);

    -- 项目级设置（编辑器偏好、分析开关等，后续阶段使用）
    CREATE TABLE IF NOT EXISTS settings (
        key   TEXT PRIMARY KEY,
        value TEXT
    );
    ",
),
(
    2,
    // V2：实体识别与分析缓存（阶段 5：人物 / 地点 / 时间 / 事件）
    "
    -- 人物库：识别出的候选由用户确认（文档二十八、二十九节）
    CREATE TABLE IF NOT EXISTS characters (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        name       TEXT NOT NULL UNIQUE,
        aliases    TEXT NOT NULL DEFAULT '[]',   -- JSON 数组（别名 / 称谓）
        status     INTEGER NOT NULL DEFAULT 0,   -- 0=候选 1=已确认 2=已忽略
        role       TEXT NOT NULL DEFAULT '',     -- 主角 / 配角 …（手动标注）
        notes      TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );

    -- 地点库（文档三十二节）
    CREATE TABLE IF NOT EXISTS locations (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        name       TEXT NOT NULL UNIQUE,
        status     INTEGER NOT NULL DEFAULT 0,   -- 0=候选 1=已确认 2=已忽略
        notes      TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );

    -- 人物 × 章节出现记录（热度统计 / 断档预警的数据源，文档三十一节）
    CREATE TABLE IF NOT EXISTS character_mentions (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        character_id   INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
        chapter_id     INTEGER NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
        mention_count  INTEGER NOT NULL DEFAULT 0,
        first_position INTEGER NOT NULL DEFAULT 0,
        UNIQUE(character_id, chapter_id)
    );
    CREATE INDEX IF NOT EXISTS idx_char_mentions_chapter ON character_mentions(chapter_id);

    -- 地点 × 章节出现记录
    CREATE TABLE IF NOT EXISTS location_mentions (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        location_id   INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        chapter_id    INTEGER NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
        mention_count INTEGER NOT NULL DEFAULT 0,
        UNIQUE(location_id, chapter_id)
    );
    CREATE INDEX IF NOT EXISTS idx_loc_mentions_chapter ON location_mentions(chapter_id);

    -- 事件（文档三十三节：关键词 + 句式，不追求语义理解）
    CREATE TABLE IF NOT EXISTS events (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        chapter_id  INTEGER NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
        event_type  INTEGER NOT NULL,            -- 0=战斗 1=进入 2=离开 3=死亡 4=突破 5=获得 6=失去 7=相遇 8=分离
        subject     TEXT NOT NULL DEFAULT '',    -- 事件主体（就近人物）
        description TEXT NOT NULL DEFAULT '',    -- 命中句片段（截断）
        position    INTEGER NOT NULL DEFAULT 0,  -- 章内字符偏移（跳转定位用）
        created_at  TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );
    CREATE INDEX IF NOT EXISTS idx_events_chapter ON events(chapter_id, position);

    -- 时间标记（文档三十四节：时间表达式 → 小说时间线）
    CREATE TABLE IF NOT EXISTS timeline_markers (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        chapter_id  INTEGER NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
        expression  TEXT NOT NULL,               -- 原文表达式「三日后」
        position    INTEGER NOT NULL DEFAULT 0,
        created_at  TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );
    CREATE INDEX IF NOT EXISTS idx_timeline_chapter ON timeline_markers(chapter_id, position);

    -- 增量分析缓存：章节内容指纹未变则跳过重分析（文档六十二节）
    CREATE TABLE IF NOT EXISTS analysis_cache (
        chapter_id   INTEGER PRIMARY KEY REFERENCES chapters(id) ON DELETE CASCADE,
        content_hash TEXT NOT NULL,
        analyzed_at  TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );
    ",
),
(
    3,
    // V3：阶段 6 改道——砍掉自动识别（无语义理解精度不可达），人物/地点
    // 改为作者手动建卡 + 精确匹配统计；新增码字统计表。
    "
    -- 识别时代的候选/忽略实体是未确认的噪声数据，直接清除
    DELETE FROM character_mentions WHERE character_id IN (SELECT id FROM characters WHERE status != 1);
    DELETE FROM location_mentions WHERE location_id IN (SELECT id FROM locations WHERE status != 1);
    DELETE FROM characters WHERE status != 1;
    DELETE FROM locations WHERE status != 1;
    -- 提及计数口径切换为精确匹配（名字+别名），旧计数由打开项目时全量重建
    DELETE FROM character_mentions;
    DELETE FROM location_mentions;
    -- 自动识别的派生表废弃（事件/时间线/分析缓存）
    DROP TABLE IF EXISTS events;
    DROP TABLE IF EXISTS timeline_markers;
    DROP TABLE IF EXISTS analysis_cache;
    -- 码字统计：按自然日记录净增字数与保存次数（只计正增长，删改不扣减）
    CREATE TABLE IF NOT EXISTS writing_daily (
        date  TEXT PRIMARY KEY,                    -- YYYY-MM-DD（本地时区）
        words INTEGER NOT NULL DEFAULT 0,          -- 当日净增正文字数
        saves INTEGER NOT NULL DEFAULT 0           -- 保存次数
    );
    ",
),
(
    4,
    // V4：大纲系统——全书大纲（主线 / 设定 / 梗概）。
    // 卷大纲（volumes.summary）与章纲（chapters.summary / notes）V1 已有，无需改动。
    "
    ALTER TABLE project_info ADD COLUMN outline TEXT NOT NULL DEFAULT '';
    ",
),
(
    5,
    // V5：回收站——章节软删除（deleted_at 为 NULL 即正常章节）。
    // 删除章节先入回收站，7 天后打开回收站时自动彻底清除。
    "
    ALTER TABLE chapters ADD COLUMN deleted_at TEXT;
    ",
),
(
    6,
    // V6：可视化写小说——故事地图 / 剧情线 / 伏笔（设计文档 V1.1）。
    // 节点 = 章节（不建独立 node 表）；坐标归一化 0..1；弧线单归属挂章节，
    // 边级 arc_id 负责单条连线（伏笔）归类。回收站章节在图中隐藏，
    // 彻底删除时关联边随 ON DELETE CASCADE 自动清理。
    "
    -- ① 剧情线（总览泳道 / 伏笔归类的载体）：先建被引用表，再对 chapters 做 ALTER
    CREATE TABLE IF NOT EXISTS story_arcs (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        title      TEXT NOT NULL,
        kind       INTEGER NOT NULL DEFAULT 0,   -- 0=主线 1=支线 2=暗线
        color      TEXT NOT NULL DEFAULT '',     -- 泳道/节点着色（前端可覆写）
        summary    TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );

    -- ② 章节扩展：节点类型、画布坐标、弧线归属（均不影响现有读写路径）
    ALTER TABLE chapters ADD COLUMN node_type INTEGER NOT NULL DEFAULT 0;  -- 0=章节 1=事件 2=转折 3=支线 4=结局
    ALTER TABLE chapters ADD COLUMN map_x REAL;  -- 归一化 0..1；NULL = 未排布
    ALTER TABLE chapters ADD COLUMN map_y REAL;
    ALTER TABLE chapters ADD COLUMN arc_id INTEGER REFERENCES story_arcs(id) ON DELETE SET NULL;
    CREATE INDEX IF NOT EXISTS idx_chapters_arc ON chapters(arc_id);

    -- ③ 连线（0=顺序 1=因果 2=分支 3=汇合 4=伏笔回收）
    --    顺序边是派生数据（自动布局整体重建），不加唯一约束——
    --    同对章节间埋多条伏笔是合理场景
    CREATE TABLE IF NOT EXISTS story_edges (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        from_node  INTEGER NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
        to_node    INTEGER NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
        edge_type  INTEGER NOT NULL,
        arc_id     INTEGER REFERENCES story_arcs(id) ON DELETE SET NULL,
        label      TEXT NOT NULL DEFAULT '',     -- 因果说明 / 伏笔内容
        status     INTEGER NOT NULL DEFAULT 0,   -- 伏笔：0=活跃 1=已回收 2=失效；其余类型固定 0
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
        CHECK (from_node != to_node)
    );
    CREATE INDEX IF NOT EXISTS idx_edges_from ON story_edges(from_node);
    CREATE INDEX IF NOT EXISTS idx_edges_to   ON story_edges(to_node);
    CREATE INDEX IF NOT EXISTS idx_edges_arc  ON story_edges(arc_id);
    ",
)];

/// 应用所有未执行的迁移
pub fn apply(conn: &Connection) -> Result<()> {
    let current: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;

    for (version, sql) in MIGRATIONS {
        if *version > current {
            // 单个迁移在事务内执行，失败即回滚
            conn.execute_batch(&format!("BEGIN;\n{sql}\nPRAGMA user_version = {version};\nCOMMIT;"))?;
        }
    }
    Ok(())
}
