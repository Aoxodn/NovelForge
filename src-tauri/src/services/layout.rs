//! 卷级故事图谱的泳道式分层布局（纯函数，不碰 DB / Tauri）。
//!
//! 从 commands::story_graph 抽出的领域算法层（审查 P2-2 分层）：
//! command 只负责取数与落库，布局拓扑计算全部收敛在此。

use crate::models::{StoryArc, StoryEdge, StoryNode};
use std::collections::{HashMap, HashSet, VecDeque};

/// 沿 顺序/因果 结构边找最长路径（按阶段序近似拓扑序做 DP，平局按阶段序），
/// 用作无主线弧时的主线兜底。入边邻接需预先过滤为 顺序/因果 边。
pub(crate) fn longest_structural_path(sorted: &[&StoryNode], in_adj: &HashMap<i64, Vec<i64>>) -> Vec<i64> {
    let mut dp_len: HashMap<i64, usize> = HashMap::new();
    let mut dp_prev: HashMap<i64, i64> = HashMap::new();
    for nd in sorted {
        let mut len = 1usize;
        let mut prev: Option<i64> = None;
        if let Some(ins) = in_adj.get(&nd.id) {
            for p in ins {
                if let Some(l) = dp_len.get(p) {
                    if l + 1 > len {
                        len = l + 1;
                        prev = Some(*p);
                    }
                }
            }
        }
        dp_len.insert(nd.id, len);
        if let Some(p) = prev {
            dp_prev.insert(nd.id, p);
        }
    }
    let mut end = sorted[0].id;
    for nd in sorted {
        if dp_len.get(&nd.id) > dp_len.get(&end) {
            end = nd.id;
        }
    }
    let mut chain = Vec::new();
    let mut cur = end;
    loop {
        chain.push(cur);
        match dp_prev.get(&cur) {
            Some(p) if *p != cur => cur = *p,
            _ => break,
        }
    }
    chain.reverse();
    chain
}

/// 分层布局结果（纯计算，不碰 DB）
pub(crate) struct LaneLayout {
    /// 卷 id → 泳道（0=主线，负=上方支线，正=下方暗线/未连接）
    pub(crate) lane: HashMap<i64, i32>,
    /// 卷 id → 列（主线按阶段序；非主线 = 上游父列最大值 + 1）
    pub(crate) col: HashMap<i64, i64>,
    /// 重建的顺序边 (from, to)——仅主线相邻
    pub(crate) seq_pairs: Vec<(i64, i64)>,
}

/// 泳道式分层布局（纯函数）：按 剧情线 / 结构连线 计算每个卷的 (泳道, 列)。
///
/// **幂等性**：顺序边（type=0）是自动布局的派生输出，不作为布局输入——
/// 否则上一次自动布局重建的顺序边会反馈进下一次的主线识别，
/// 造成「每点一次排一个样」的不稳定。
///
/// 结构层次规则（设计文档 V1.2，用户口径）：
/// - **主线识别**：主线弧（kind=0）的卷 → 泳道 0；无主线弧时取最长「因果」链；
///   再兜底全部卷按阶段序（剔除分支边目标——它们作为子流程挂靠，不占主线行）。
///   主线 X 按阶段序等距推进。
/// - **泳道分配**：支线弧（kind=1）逐条排上方泳道（-1, -2, …）；暗线弧（kind=2）
///   逐条排下方泳道（+1, +2, …）；无弧线的卷沿连线按边类型挂靠（BFS）——
///   分支边两端（子节点 / 分支源 / 汇合源）上浮一格，伏笔回收方下沉一格，
///   因果边两端同泳道。
/// - **列位**：非主线列 = 上游父列最大值 + 1（从分叉点向右外扩），
///   同泳道同列自动右移避让；无入边的上游卷（支线源头）对齐其下游目标列。
/// - **孤立卷停泊**：与任何手工边都不相连的卷，统一排到主线下方的
///   「未连接」泳道（按阶段序排开）——不再被塞进主线行、也不再为它们
///   编造顺序连线（此前「同泳道相邻」重建把互无关联的卷串成假主线）。
/// - **顺序边重建**：仅主线相邻；因果 / 分支 / 汇合 / 伏笔边是手工数据，
///   本函数不碰。
///
/// 层次感来自数据：若全部卷是主线且无分支弧，排出来是一条线——那是正确表达。
pub(crate) fn compute_layout(nodes: &[StoryNode], arcs: &[StoryArc], edges: &[StoryEdge]) -> LaneLayout {
    let mut sorted: Vec<&StoryNode> = nodes.iter().collect();
    sorted.sort_by_key(|a| (a.sort_order, a.id));

    // 布局输入 = 手工结构边（因果/分支/汇合/伏笔）；顺序边是派生输出，剔除
    let edges: Vec<StoryEdge> = edges
        .iter()
        .filter(|e| e.edge_type != 0)
        .cloned()
        .collect();
    let edges = &edges[..];

    // ---- 结构邻接：全部边参与泳道挂靠与列位（伏笔「埋→收」也是结构依赖）；
    //      主线 DP 只用因果边（顺序边已被剔除；分支边会让最长链走进支线）；
    //      BFS 挂靠需边类型（分支边子节点上浮一格，workflow 树状展开） ----
    let mut out_adj: HashMap<i64, Vec<i64>> = HashMap::new();
    let mut out_adj_typed: HashMap<i64, Vec<(i64, i32)>> = HashMap::new();
    let mut in_adj: HashMap<i64, Vec<i64>> = HashMap::new();
    let mut in_adj_typed: HashMap<i64, Vec<(i64, i32)>> = HashMap::new();
    let mut in_adj_seq: HashMap<i64, Vec<i64>> = HashMap::new();
    for e in edges {
        out_adj.entry(e.from_node).or_default().push(e.to_node);
        out_adj_typed
            .entry(e.from_node)
            .or_default()
            .push((e.to_node, e.edge_type));
        in_adj.entry(e.to_node).or_default().push(e.from_node);
        in_adj_typed
            .entry(e.to_node)
            .or_default()
            .push((e.from_node, e.edge_type));
        if e.edge_type == 1 {
            in_adj_seq.entry(e.to_node).or_default().push(e.from_node);
        }
    }

    // ---- 卷所属弧线（边的 arc_id → 归属；同卷多弧取第一个，主线弧优先占据，
    //      避免支线伏笔边把主线卷拉离主线泳道） ----
    let arc_kind: HashMap<i64, i32> = arcs.iter().map(|a| (a.id, a.kind)).collect();
    let mut node_arc: HashMap<i64, i64> = HashMap::new();
    let claim = |e: &StoryEdge, node_arc: &mut HashMap<i64, i64>, mainline_only: bool| {
        if let Some(aid) = e.arc_id {
            let is_main = arc_kind.get(&aid) == Some(&0);
            if is_main == mainline_only {
                node_arc.entry(e.from_node).or_insert(aid);
                node_arc.entry(e.to_node).or_insert(aid);
            }
        }
    };
    for e in edges {
        claim(e, &mut node_arc, true);
    }
    for e in edges {
        claim(e, &mut node_arc, false);
    }

    // ---- ① 主线链：主线弧的卷（按阶段序）→ 最长顺序/因果链 → 全部卷 ----
    // 注意：只认「明确归属主线弧」的卷；无弧线时全部卷视为无主线归属，
    // 走最长链识别（否则任何无弧线图都会被当成一条主线，分支无从展开）
    let mut main_chain: Vec<i64> = sorted
        .iter()
        .filter(|nd| {
            node_arc
                .get(&nd.id)
                .and_then(|a| arc_kind.get(a))
                .copied()
                == Some(0)
        })
        .map(|nd| nd.id)
        .collect();
    if main_chain.len() < 2 {
        main_chain = longest_structural_path(&sorted, &in_adj_seq);
    }
    if main_chain.len() < 2 {
        // 兜底：全部卷按阶段序，剔除「分支边目标」——
        // 它们将作为子流程挂靠（父卷右上），不该占主线行（否则有分支边仍排成一条线）
        let branch_targets: HashSet<i64> = edges
            .iter()
            .filter(|e| e.edge_type == 2)
            .map(|e| e.to_node)
            .collect();
        main_chain = sorted
            .iter()
            .map(|nd| nd.id)
            .filter(|id| !branch_targets.contains(id))
            .collect();
        if main_chain.len() < 2 {
            main_chain = sorted.iter().map(|nd| nd.id).collect();
        }
    }

    // ---- ② 泳道分配 ----
    let mut lane: HashMap<i64, i32> = HashMap::new();
    for id in &main_chain {
        lane.insert(*id, 0);
    }
    // 弧线泳道：支线向上（-1,-2,…）、暗线向下（+1,+2,…），按弧 id 稳定
    let mut up = 0i32;
    let mut down = 0i32;
    let mut arc_lanes: HashMap<i64, i32> = HashMap::new();
    for a in arcs.iter().filter(|a| a.kind != 0) {
        if a.kind == 1 {
            up -= 1;
            arc_lanes.insert(a.id, up);
        } else {
            down += 1;
            arc_lanes.insert(a.id, down);
        }
    }
    for nd in &sorted {
        if lane.contains_key(&nd.id) {
            continue;
        }
        if let Some(aid) = node_arc.get(&nd.id) {
            if let Some(l) = arc_lanes.get(aid) {
                lane.insert(nd.id, *l);
            }
        }
    }
    // 剩余卷：BFS 沿边挂靠最近邻泳道，按边类型决定泳道偏移——
    //   · 正向分支边（type=2）的子节点上浮一格（workflow 树状展开：
    //     分叉卷出现在父卷右上，而不是挤进主线行尾）；
    //   · 正向伏笔边（type=4）的回收方下沉一格（伏笔跨泳道：埋设→回收，
    //     回收方属暗线侧，与设计稿「暗线向下」一致）；
    //   · 反向挂靠时，分支源 / 汇合源是支线侧，同样上浮一格——
    //     否则支线侧节点会贴上主线行、被顺延到行尾，看起来像主线的一部分；
    //   · 因果边的另一端与本卷同泳道（同一条故事流）。
    // 队列按（阶段序, id）确定性入队——HashMap 迭代顺序随机，
    // 会造成同一份数据每次自动布局结果不同
    let mut queue: VecDeque<i64> = sorted
        .iter()
        .filter(|nd| lane.contains_key(&nd.id))
        .map(|nd| nd.id)
        .collect();
    let mut placed: HashSet<i64> = lane.keys().copied().collect();
    while let Some(u) = queue.pop_front() {
        let lu = lane[&u];
        for (v, t) in out_adj_typed.get(&u).into_iter().flatten() {
            if placed.insert(*v) {
                let child_lane = match *t {
                    2 => lu - 1, // 分支：支线向上
                    4 => lu + 1, // 伏笔回收：暗线向下
                    _ => lu,
                };
                lane.insert(*v, child_lane);
                queue.push_back(*v);
            }
        }
        for (v, t) in in_adj_typed.get(&u).into_iter().flatten() {
            if placed.insert(*v) {
                let parent_lane = match *t {
                    2 | 3 => lu - 1, // 分支源 / 汇合源：支线侧上浮
                    _ => lu,         // 因果源 / 伏笔埋设方：同泳道
                };
                lane.insert(*v, parent_lane);
                queue.push_back(*v);
            }
        }
    }
    // （孤立卷不在此时分配泳道——列位算完后统一停泊到「未连接」泳道）

    // ---- ③ 列位：主线按序；非主线 = 上游父列最大值 + 1，同泳道同列右移避让 ----
    let mut col: HashMap<i64, i64> = HashMap::new();
    for (i, id) in main_chain.iter().enumerate() {
        col.insert(*id, i as i64);
    }
    let mut col_used: HashMap<i32, HashSet<i64>> = HashMap::new();
    for (id, l) in &lane {
        if let Some(c) = col.get(id) {
            col_used.entry(*l).or_default().insert(*c);
        }
    }
    loop {
        let mut changed = false;
        for nd in &sorted {
            if col.contains_key(&nd.id) {
                continue;
            }
            let mut pc: Option<i64> = None;
            if let Some(ps) = in_adj.get(&nd.id) {
                for p in ps {
                    if let Some(c) = col.get(p) {
                        pc = Some(pc.map_or(*c, |m: i64| m.max(*c)));
                    }
                }
            }
            if let Some(c0) = pc {
                let mut c = c0 + 1;
                let used = col_used.entry(lane[&nd.id]).or_default();
                while used.contains(&c) {
                    c += 1;
                }
                used.insert(c);
                col.insert(nd.id, c);
                changed = true;
            }
        }
        if !changed {
            break;
        }
    }
    // 已挂靠但无入边的上游卷（列仍空）：优先对齐其下游目标列——
    // 支线源头正好悬在汇入点上方，而不是被甩到全局最右；
    // 无下游目标时才顺延到全局最右
    let mut next_col = col.values().max().map_or(0, |m| m + 1);
    for nd in &sorted {
        if col.contains_key(&nd.id) || !lane.contains_key(&nd.id) {
            continue;
        }
        let child_col = out_adj
            .get(&nd.id)
            .into_iter()
            .flatten()
            .filter_map(|t| col.get(t))
            .min()
            .copied();
        let mut c = match child_col {
            Some(c) => c,
            None => {
                let c = next_col;
                next_col += 1;
                c
            }
        };
        let used = col_used.entry(lane[&nd.id]).or_default();
        while used.contains(&c) {
            c += 1;
        }
        used.insert(c);
        col.insert(nd.id, c);
    }

    // ---- 孤立卷停泊：与任何手工边都不相连的卷 → 主线下方「未连接」泳道 ----
    // 不占主线行、不编造顺序边——此前它们被塞进主线行尾并串上顺序箭头，
    // 制造出一条数据里并不存在的故事流
    let park_lane = lane.values().copied().max().unwrap_or(0) + 1;
    let mut park_col = 0i64;
    for nd in &sorted {
        if lane.contains_key(&nd.id) {
            continue;
        }
        lane.insert(nd.id, park_lane);
        let used = col_used.entry(park_lane).or_default();
        while used.contains(&park_col) {
            park_col += 1;
        }
        used.insert(park_col);
        col.insert(nd.id, park_col);
        park_col += 1;
    }

    // ---- ④ 顺序边重建：仅主线相邻 ----
    // 不再做「同泳道按列相邻」——那会为同泳道里互无关联的卷编造顺序关系
    let mut pairs: Vec<(i64, i64)> = Vec::new();
    for w in main_chain.windows(2) {
        pairs.push((w[0], w[1]));
    }
    pairs.sort();
    pairs.dedup();
    let seq_pairs: Vec<(i64, i64)> = pairs.into_iter().filter(|(a, b)| a != b).collect();

    LaneLayout {
        lane,
        col,
        seq_pairs,
    }
}
