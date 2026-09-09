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
),
(
    7,
    // V7：可视化模块 V1.1 修订——节点模型从「章节」切换为「卷 / 故事阶段」。
    //   ① volumes 成为画布节点：加归一化坐标与节点类型；
    //   ② story_edges 重建为卷级引用，伏笔边额外带可空章级锚点
    //      （旧 V6 章节边按 chapters.volume_id 转换；伏笔边保留原章为锚点；
    //        同卷非伏笔边丢弃，同卷伏笔边保留——CHECK 放行 edge_type=4 自环）；
    //   ③ V1.0 章节级画布字段废弃（坐标 / 弧线归属 / 规划节点类型）。
    "
    -- ① 卷扩展：画布坐标（归一化 0..1）+ 节点类型（0=常规 1=支线卷 2=番外，预留）
    ALTER TABLE volumes ADD COLUMN map_x REAL;
    ALTER TABLE volumes ADD COLUMN map_y REAL;
    ALTER TABLE volumes ADD COLUMN node_type INTEGER NOT NULL DEFAULT 0;

    -- ② 连线重建：from/to 指向卷；伏笔可锚定到具体章节（NULL = 卷级）
    CREATE TABLE IF NOT EXISTS story_edges_v7 (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        from_node        INTEGER NOT NULL REFERENCES volumes(id) ON DELETE CASCADE,
        to_node          INTEGER NOT NULL REFERENCES volumes(id) ON DELETE CASCADE,
        edge_type        INTEGER NOT NULL,       -- 0=顺序 1=因果 2=分支 3=汇合 4=伏笔回收
        arc_id           INTEGER REFERENCES story_arcs(id) ON DELETE SET NULL,
        from_chapter_id  INTEGER REFERENCES chapters(id) ON DELETE SET NULL,  -- 伏笔埋设章（可空=卷级）
        to_chapter_id    INTEGER REFERENCES chapters(id) ON DELETE SET NULL,  -- 伏笔回收章（可空=卷级）
        label            TEXT NOT NULL DEFAULT '',
        status           INTEGER NOT NULL DEFAULT 0, -- 伏笔：0=活跃 1=已回收 2=失效
        sort_order       INTEGER NOT NULL DEFAULT 0,
        created_at       TEXT NOT NULL DEFAULT (datetime('now','localtime')),
        updated_at       TEXT NOT NULL DEFAULT (datetime('now','localtime')),
        CHECK (from_node != to_node OR edge_type = 4)
    );
    -- 数据转换：章节边 → 卷边；伏笔边（type=4）把原章节 id 存入章级锚点；
    -- 同卷的普通边（顺序/因果/分支/汇合）在卷粒度下无意义，直接丢弃
    INSERT INTO story_edges_v7 (from_node, to_node, edge_type, arc_id,
                                from_chapter_id, to_chapter_id, label, status,
                                sort_order, created_at, updated_at)
    SELECT cf.volume_id, ct.volume_id, e.edge_type, e.arc_id,
           CASE WHEN e.edge_type = 4 THEN e.from_node ELSE NULL END,
           CASE WHEN e.edge_type = 4 THEN e.to_node   ELSE NULL END,
           e.label, e.status, e.sort_order, e.created_at, e.updated_at
    FROM story_edges e
    JOIN chapters cf ON cf.id = e.from_node
    JOIN chapters ct ON ct.id = e.to_node
    WHERE e.edge_type = 4 OR cf.volume_id != ct.volume_id;
    DROP TABLE story_edges;
    ALTER TABLE story_edges_v7 RENAME TO story_edges;
    CREATE INDEX IF NOT EXISTS idx_edges_from ON story_edges(from_node);
    CREATE INDEX IF NOT EXISTS idx_edges_to   ON story_edges(to_node);
    CREATE INDEX IF NOT EXISTS idx_edges_arc  ON story_edges(arc_id);

    -- ③ V1.0 章节级数据清理：空规划节点（无正文且无纲要）删除；
    --    带纲要的保留为普通章节；坐标 / 弧线归属列废弃
    DELETE FROM chapters WHERE node_type != 0 AND content = '' AND summary = '' AND notes = '';
    UPDATE chapters SET node_type = 0 WHERE node_type != 0;
    DROP INDEX IF EXISTS idx_chapters_arc;
    ALTER TABLE chapters DROP COLUMN map_x;
    ALTER TABLE chapters DROP COLUMN map_y;
    ALTER TABLE chapters DROP COLUMN arc_id;
    ALTER TABLE chapters DROP COLUMN node_type;
",
),
(
    8,
    // V8：广义人物关系体系（v0.9.13）。
    //   五大类（1血缘 2情感 3社会 4阵营 5叙事）+ 自由文本子类型；
    //   volume_id = NULL 表示跨卷关系（L1 / 所有 L2 显示），
    //   volume_id = 具体卷时仅该卷 L2 显示。人物删除时关系级联清理。
    //   卷删除时 volume_id 置 NULL（关系退化为跨卷关系而非消失）。
    //   另：story_edges.edge_type 新增 5=平行叙事 6=闪回/插叙（纯枚举扩展，
    //   无结构变更，现有 CHECK 只约束自环）。
    "
    CREATE TABLE IF NOT EXISTS character_relations (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        from_char    INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
        to_char      INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
        rel_category INTEGER NOT NULL,           -- 1血缘 2情感 3社会 4阵营 5叙事
        rel_type     TEXT NOT NULL DEFAULT '',   -- 子类型名，如「母女」「师徒」
        label        TEXT NOT NULL DEFAULT '',   -- 自定义补充说明
        direction    INTEGER NOT NULL DEFAULT 0, -- 0双向 1单向(from→to)
        volume_id    INTEGER REFERENCES volumes(id) ON DELETE SET NULL,
        created_at   TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );
    CREATE INDEX IF NOT EXISTS idx_rel_from   ON character_relations(from_char);
    CREATE INDEX IF NOT EXISTS idx_rel_to     ON character_relations(to_char);
    CREATE INDEX IF NOT EXISTS idx_rel_volume ON character_relations(volume_id);
    ",
),
(
    9,
    // V9：连线手动弧度（v0.9.13 画布交互补充）。
    // bend = 相对「类型泳道」基准位置的垂直偏移（世界像素，有符号），
    // 用户在画布上拖动连线中点调节，0 = 纯类型泳道弧度。
    "
    ALTER TABLE story_edges ADD COLUMN bend REAL NOT NULL DEFAULT 0;
    ",
),
(
    10,
    // V10：L2 卷内画布可编辑化——章节节点坐标 / 小节（章节群）/ 章间连线。
    //   ① chapters.map_x / map_y：L2 画布章节坐标（归一化 0..1，V7 曾废弃
    //      章节级坐标，本次卷内画布升级为可编辑后重新启用并落库）；
    //   ② chapter_groups：小节 = 同卷若干章节的分组（组框渲染、整体拖动）；
    //   ③ chapter_edges：章间连线（0顺序..6闪回 与卷级边同枚举），
    //      仅限同卷章节；bend 手动弧度与卷级边同口径。
    "
    ALTER TABLE chapters ADD COLUMN map_x REAL;
    ALTER TABLE chapters ADD COLUMN map_y REAL;

    CREATE TABLE IF NOT EXISTS chapter_groups (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        volume_id  INTEGER NOT NULL REFERENCES volumes(id) ON DELETE CASCADE,
        title      TEXT NOT NULL,
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );
    CREATE INDEX IF NOT EXISTS idx_chgroups_volume ON chapter_groups(volume_id);
    ALTER TABLE chapters ADD COLUMN group_id INTEGER REFERENCES chapter_groups(id) ON DELETE SET NULL;
    CREATE INDEX IF NOT EXISTS idx_chapters_group ON chapters(group_id);

    CREATE TABLE IF NOT EXISTS chapter_edges (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        from_chapter INTEGER NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
        to_chapter   INTEGER NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
        edge_type    INTEGER NOT NULL,           -- 0顺序..6闪回（与 story_edges 同枚举）
        label        TEXT NOT NULL DEFAULT '',   -- 因果说明 / 伏笔内容
        status       INTEGER NOT NULL DEFAULT 0, -- 伏笔：0活跃 1已回收 2失效
        bend         REAL NOT NULL DEFAULT 0,    -- 手动弧度（世界像素）
        created_at   TEXT NOT NULL DEFAULT (datetime('now','localtime')),
        CHECK (from_chapter != to_chapter)
    );
    CREATE INDEX IF NOT EXISTS idx_cedges_from ON chapter_edges(from_chapter);
    CREATE INDEX IF NOT EXISTS idx_cedges_to   ON chapter_edges(to_chapter);
    ",
),
(
    11,
    // V11：小节连线（组框圆点拖出）。from_group 指向源小节；
    // 目标二选一：to_group（小节→小节）或 to_chapter（小节→章节）。
    // 小节删除时连线随 FK CASCADE 清理。
    "
    CREATE TABLE IF NOT EXISTS group_edges (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        volume_id  INTEGER NOT NULL REFERENCES volumes(id) ON DELETE CASCADE,
        from_group INTEGER NOT NULL REFERENCES chapter_groups(id) ON DELETE CASCADE,
        to_group   INTEGER REFERENCES chapter_groups(id) ON DELETE CASCADE,
        to_chapter INTEGER REFERENCES chapters(id) ON DELETE CASCADE,
        edge_type  INTEGER NOT NULL,           -- 0顺序..6闪回（与章间边同枚举）
        label      TEXT NOT NULL DEFAULT '',
        status     INTEGER NOT NULL DEFAULT 0, -- 伏笔：0活跃 1已回收 2失效
        bend       REAL NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
        CHECK ((to_group IS NULL) != (to_chapter IS NULL))
    );
    CREATE INDEX IF NOT EXISTS idx_gedges_volume ON group_edges(volume_id);
    CREATE INDEX IF NOT EXISTS idx_gedges_from   ON group_edges(from_group);
    CREATE INDEX IF NOT EXISTS idx_gedges_to     ON group_edges(to_group);
    ",
),
(
    12,
    // V12：人物层可编辑化——主动人物图谱。
    //   ① characters.map_x / map_y：L1 全书人物图谱坐标（手动拖动落库；
    //      NULL = 自动布局在出场轨迹带上）；
    //   ② char_volume_pos：L2 卷内人物节点坐标（每卷独立，提及堆叠兜底）；
    //   ③ character_bindings：手动绑定人物→卷 / 人物→章（正文没提及也能挂，
    //      二选一；目标删除时绑定级联清理）。
    "
    ALTER TABLE characters ADD COLUMN map_x REAL;
    ALTER TABLE characters ADD COLUMN map_y REAL;

    CREATE TABLE IF NOT EXISTS char_volume_pos (
        character_id INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
        volume_id    INTEGER NOT NULL REFERENCES volumes(id) ON DELETE CASCADE,
        map_x        REAL NOT NULL,
        map_y        REAL NOT NULL,
        PRIMARY KEY (character_id, volume_id)
    );

    CREATE TABLE IF NOT EXISTS character_bindings (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        character_id INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
        volume_id    INTEGER REFERENCES volumes(id) ON DELETE CASCADE,
        chapter_id   INTEGER REFERENCES chapters(id) ON DELETE CASCADE,
        created_at   TEXT NOT NULL DEFAULT (datetime('now','localtime')),
        CHECK ((volume_id IS NULL) != (chapter_id IS NULL))
    );
    CREATE INDEX IF NOT EXISTS idx_charbind_char   ON character_bindings(character_id);
    CREATE INDEX IF NOT EXISTS idx_charbind_volume ON character_bindings(volume_id);
    CREATE INDEX IF NOT EXISTS idx_charbind_chapter ON character_bindings(chapter_id);
    ",
),
(
    13,
    // V13：单字人名误判词排除。
    //   characters.exclude_words：JSON 数组，存该人物的误判词。
    //   提及统计时先从正文剔除这些词，再数名字出现次数。
    "
    ALTER TABLE characters ADD COLUMN exclude_words TEXT NOT NULL DEFAULT '[]';
    ",
),
(
    14,
    // V14（审查 P1-1 / P2-2）：
    //   ① 补齐外键级联扫描所需索引；
    //   ② 用触发器在数据库层兜底「章间连线两端同卷」「章节与小节同卷」
    //      「伏笔章级锚点属于对应卷」，防止未来其他命令写入非法数据。
    "
    -- ① 缺失索引：伏笔锚点 / 组边到章 / 卷内人物坐标按卷查询
    CREATE INDEX IF NOT EXISTS idx_edges_from_ch ON story_edges(from_chapter_id);
    CREATE INDEX IF NOT EXISTS idx_edges_to_ch   ON story_edges(to_chapter_id);
    CREATE INDEX IF NOT EXISTS idx_gedges_to_ch  ON group_edges(to_chapter);
    CREATE INDEX IF NOT EXISTS idx_charvolpos_vol ON char_volume_pos(volume_id);

    -- ② 章间连线：两端必须都是未删章节且同卷
    DROP TRIGGER IF EXISTS trg_chedge_ins;
    CREATE TRIGGER trg_chedge_ins BEFORE INSERT ON chapter_edges
    WHEN NOT EXISTS (
        SELECT 1 FROM chapters a JOIN chapters b
        WHERE a.id = NEW.from_chapter AND b.id = NEW.to_chapter
          AND a.deleted_at IS NULL AND b.deleted_at IS NULL
          AND a.volume_id = b.volume_id
    )
    BEGIN
        SELECT RAISE(ABORT, '章间连线两端必须是同卷且存在的章节');
    END;

    DROP TRIGGER IF EXISTS trg_chedge_upd;
    CREATE TRIGGER trg_chedge_upd BEFORE UPDATE ON chapter_edges
    WHEN NOT EXISTS (
        SELECT 1 FROM chapters a JOIN chapters b
        WHERE a.id = NEW.from_chapter AND b.id = NEW.to_chapter
          AND a.deleted_at IS NULL AND b.deleted_at IS NULL
          AND a.volume_id = b.volume_id
    )
    BEGIN
        SELECT RAISE(ABORT, '章间连线两端必须是同卷且存在的章节');
    END;

    -- 章节归入小节：小节必须与章节同卷
    DROP TRIGGER IF EXISTS trg_ch_group_ins;
    CREATE TRIGGER trg_ch_group_ins BEFORE INSERT ON chapters
    WHEN NEW.group_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM chapter_groups g
        WHERE g.id = NEW.group_id AND g.volume_id = NEW.volume_id
    )
    BEGIN
        SELECT RAISE(ABORT, '小节必须与章节属于同一卷');
    END;

    DROP TRIGGER IF EXISTS trg_ch_group_upd;
    CREATE TRIGGER trg_ch_group_upd BEFORE UPDATE OF group_id, volume_id ON chapters
    WHEN NEW.group_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM chapter_groups g
        WHERE g.id = NEW.group_id AND g.volume_id = NEW.volume_id
    )
    BEGIN
        SELECT RAISE(ABORT, '小节必须与章节属于同一卷');
    END;

    -- 伏笔章级锚点：埋设章必须属于 from_node 卷，回收章必须属于 to_node 卷
    DROP TRIGGER IF EXISTS trg_edge_anchor_ins;
    CREATE TRIGGER trg_edge_anchor_ins BEFORE INSERT ON story_edges
    WHEN (NEW.from_chapter_id IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM chapters c WHERE c.id = NEW.from_chapter_id AND c.volume_id = NEW.from_node))
       OR (NEW.to_chapter_id IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM chapters c WHERE c.id = NEW.to_chapter_id AND c.volume_id = NEW.to_node))
    BEGIN
        SELECT RAISE(ABORT, '伏笔章级锚点必须属于对应卷');
    END;

    DROP TRIGGER IF EXISTS trg_edge_anchor_upd;
    CREATE TRIGGER trg_edge_anchor_upd BEFORE UPDATE ON story_edges
    WHEN (NEW.from_chapter_id IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM chapters c WHERE c.id = NEW.from_chapter_id AND c.volume_id = NEW.from_node))
       OR (NEW.to_chapter_id IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM chapters c WHERE c.id = NEW.to_chapter_id AND c.volume_id = NEW.to_node))
    BEGIN
        SELECT RAISE(ABORT, '伏笔章级锚点必须属于对应卷');
    END;
    ",
),
(
    15,
    // V15（审查 P1-3 / P1-5）：提及统计增量索引状态。
    //   记录每章上次纳入统计时的内容指纹；rebuild 只处理指纹过期 / 缺失的章，
    //   打开项目不再无条件全书重扫。章节彻底删除时由外键级联清掉对应行。
    "
    CREATE TABLE IF NOT EXISTS mention_index_state (
        chapter_id   INTEGER PRIMARY KEY REFERENCES chapters(id) ON DELETE CASCADE,
        content_hash TEXT NOT NULL DEFAULT ''
    );
    ",
),
(
    // V16（审查 UX-3）：群像角色管理扩展字段。
    //   faction 阵营；alive 存亡（NULL 未知 / 1 存活 / 0 死亡）；
    //   importance 重要度 0 龙套..3 核心；is_pov 是否 POV 视角人物；
    //   tags 标签 JSON 数组；custom_fields 自定义字段 JSON（键值对，不预设结构）。
    16,
    "
    ALTER TABLE characters ADD COLUMN faction TEXT NOT NULL DEFAULT '';
    ALTER TABLE characters ADD COLUMN alive INTEGER;
    ALTER TABLE characters ADD COLUMN importance INTEGER NOT NULL DEFAULT 1;
    ALTER TABLE characters ADD COLUMN is_pov INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE characters ADD COLUMN tags TEXT NOT NULL DEFAULT '[]';
    ALTER TABLE characters ADD COLUMN custom_fields TEXT NOT NULL DEFAULT '{}';
    ",
),
(
    // V17（审查新增功能）：场景级写作板、人物弧光追踪、连续性检查队列。
    //   scenes 章下场景；character_arcs 按章记录欲望-选择-代价-状态变化；
    //   continuity_issues 确定性规则扫描出的问题，带用户确认 / 忽略状态。
    17,
    "
    CREATE TABLE IF NOT EXISTS scenes (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        chapter_id   INTEGER NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
        sort_order   INTEGER NOT NULL DEFAULT 0,
        pov          TEXT NOT NULL DEFAULT '',     -- 视角人物
        time_of_scene TEXT NOT NULL DEFAULT '',    -- 时间
        place        TEXT NOT NULL DEFAULT '',     -- 地点
        goal         TEXT NOT NULL DEFAULT '',     -- 目标
        conflict     TEXT NOT NULL DEFAULT '',     -- 冲突
        result       TEXT NOT NULL DEFAULT '',     -- 结果
        target_words INTEGER NOT NULL DEFAULT 0,   -- 目标字数
        content      TEXT NOT NULL DEFAULT '',     -- 场景正文 / 草稿
        created_at   TEXT NOT NULL DEFAULT (datetime('now','localtime')),
        updated_at   TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );
    CREATE INDEX IF NOT EXISTS idx_scenes_chapter ON scenes(chapter_id, sort_order);

    CREATE TABLE IF NOT EXISTS character_arcs (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        character_id  INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
        chapter_id    INTEGER REFERENCES chapters(id) ON DELETE SET NULL,
        sort_order    INTEGER NOT NULL DEFAULT 0,
        desire        TEXT NOT NULL DEFAULT '',    -- 欲望（想要什么）
        choice        TEXT NOT NULL DEFAULT '',    -- 选择（做了什么）
        cost          TEXT NOT NULL DEFAULT '',    -- 代价（失去什么）
        state_change  TEXT NOT NULL DEFAULT '',    -- 状态变化（成为什么）
        note          TEXT NOT NULL DEFAULT '',
        created_at    TEXT NOT NULL DEFAULT (datetime('now','localtime')),
        updated_at    TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );
    CREATE INDEX IF NOT EXISTS idx_arcs_character ON character_arcs(character_id, sort_order);

    CREATE TABLE IF NOT EXISTS continuity_issues (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        kind        TEXT NOT NULL,                 -- dead_reappear / foreshadow_overdue / long_absence / pov_jump / time_note
        fingerprint TEXT NOT NULL DEFAULT '',      -- 去重指纹：同问题不重复入库
        title       TEXT NOT NULL DEFAULT '',
        detail      TEXT NOT NULL DEFAULT '',
        chapter_id  INTEGER REFERENCES chapters(id) ON DELETE SET NULL,
        ref_id      INTEGER,                       -- 关联角色 / 边 id（可空）
        status      INTEGER NOT NULL DEFAULT 0,   -- 0=待处理 1=已忽略 2=已解决
        created_at  TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_continuity_fp ON continuity_issues(fingerprint);
    "),
    // V18（人物列表自定义排序）：characters 增加 sort_order，作者可手动拖拽排序。
    (
        18,
        "
    ALTER TABLE characters ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;
    CREATE INDEX IF NOT EXISTS idx_characters_sort ON characters(sort_order);
    ",
    )
];

/// 应用所有未执行的迁移
pub fn apply(conn: &Connection) -> Result<()> {
    let current: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;

    for (version, sql) in MIGRATIONS {
        if *version > current {
            // 单个迁移在事务内执行，失败即回滚
            conn.execute_batch(&format!("BEGIN;\n{sql}\nPRAGMA user_version = {version};\nCOMMIT;"))?;
        }
    }

    // 权威版本源只有 PRAGMA user_version；project_info.schema_version 仅作可读镜像，
    // 迁移完成后对齐，避免两处版本号长期不一致（审查 P2-2）。
    let final_version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    let _ = conn.execute(
        "UPDATE project_info SET schema_version = ?1 WHERE id = 1 AND schema_version <> ?1",
        rusqlite::params![final_version],
    );
    Ok(())
}
