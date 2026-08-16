/**
 * runMonitor.test.js — 监控消息构建（纯函数层）
 *
 * 覆盖 runMonitor 的核心展示逻辑（多次返工、最易出错的字段布局）：
 *   buildChanged / buildSweep / buildCloseReport / buildOverview
 * 网络、文件状态、钉钉推送等副作用不在此测（依赖 dry-run 集成验证）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildChanged, buildSweep, buildCloseReport, buildOverview, buildOpportunity, buildOpportunityDigest, resolveFinalAction, opportunityEnvOf, appendNotification, pendingSweepEvents, pruneSweepPushed, opportunityLastPushedAt, groupSweepNotifications } from "../scripts/runMonitor.js";
import { displacementFor4h, buildTargetSummary, executableFvgForMss, isSweepCandidateAt, structureEventForSweep, linkStructureEventsToSweeps } from "../monitor/biasMonitor.js";

test("最终操作服从执行区，并在 1R 临界区保留旧状态", () => {
  assert.equal(resolveFinalAction({ decisionLabel: "WATCH", execution: "WAIT", planR: 4.3 }, { decision: "WATCH" }), "WAIT");
  assert.equal(resolveFinalAction({ decisionLabel: "WATCH", execution: "READY", planR: 0.996 }, { decision: "WAIT" }), "WAIT");
  assert.equal(resolveFinalAction({ decisionLabel: "WATCH", execution: "READY", planR: 1.01 }, { decision: "WATCH" }), "WATCH");
  assert.equal(resolveFinalAction({ decisionLabel: "WATCH", execution: "READY", planR: 1.06 }, { decision: "WAIT" }), "WATCH");
});

test("最终操作只在 planR 边界滞回，不再使用40%/60%区间边界", () => {
  assert.equal(resolveFinalAction({ decisionLabel: "NO TRADE", reason: "Direction correct but reward insufficient (planR < 0.5)", planR: 0.49 }, { decision: "WAIT" }), "WAIT");
  assert.equal(resolveFinalAction({ decisionLabel: "WAIT", planR: 0.51 }, { decision: "NO TRADE" }), "NO TRADE");
  assert.equal(resolveFinalAction({ decisionLabel: "WATCH", execution: "WAIT", planR: 1.2, bias: "BULLISH", rangePosition: 0.41 }, { decision: "WATCH" }), "WAIT");
});

test("扫损去重历史会裁掉过期 key，并可跨 Top30 成员变化保留", () => {
  const now = 10 * 24 * 3600_000;
  const result = pruneSweepPushed({ recent: now - 1000, expired: now - 25 * 3600_000 }, now);
  assert.deepEqual(result, { recent: now - 1000 });
});

test("扫损通知逐事件消费，并兼容旧版去重 key", () => {
  const now = 1_000;
  const events = [
    { key: "1_BSL_PDH_105", legacyKey: "1_BSL", time: 100 },
    { key: "2_BSL_PWH_110", legacyKey: "2_BSL", time: 200 },
  ];
  assert.deepEqual(pendingSweepEvents(events, {}, now).map((x) => x.key), events.map((x) => x.key));
  assert.deepEqual(pendingSweepEvents(events, { "1_BSL": 1 }, now).map((x) => x.key), ["2_BSL_PWH_110"]);
  const upgraded = { key: "1_BSL_PDH_105_ICT_2022_CONFIRMED", legacyKey: "1_BSL", tier: 3, time: 100 };
  assert.deepEqual(pendingSweepEvents([upgraded], { "1_BSL": 1 }, now), [], "旧版已收回（L2）后同池 L3 不再单独推（差异化升级）");
  const downgraded = { key: "1_BSL_PDH_105_RECLAIMED_RAID", baseKey: "1_BSL_PDH_105", legacyKey: "1_BSL", tier: 2, time: 100 };
  assert.deepEqual(pendingSweepEvents([downgraded], { "1_BSL_PDH_105_ICT_2022_CONFIRMED": 1 }, now), []);
  const merged = {
    key: "1_BSL_EXTERNAL_HIGH_105_LIQUIDITY_TAKEN",
    baseKey: "1_BSL_EXTERNAL_HIGH_105",
    sourceBaseKeys: ["1_BSL_EXTERNAL_HIGH_105", "1_BSL_PDH_105"],
    tier: 1,
    time: 1,
  };
  assert.deepEqual(pendingSweepEvents([merged], { "1_BSL_PDH_105_LIQUIDITY_TAKEN": 1 }, 1), []);
  assert.deepEqual(pendingSweepEvents([{ key: "missing_time", tier: 2 }], {}, now), []);
});

test("差异化升级（方案4）：L2 已推后同池 L3 不再单独推，L1→L2 仍允许", () => {
  const now = 10_000;
  const base = { baseKey: "1_BSL_PDH_105", time: 1 };
  const l1 = { key: "1_BSL_PDH_105_LIQUIDITY_TAKEN", tier: 1, ...base };
  const l2 = { key: "1_BSL_PDH_105_RECLAIMED_RAID", tier: 2, ...base };
  const l3 = { key: "1_BSL_PDH_105_ICT_2022_CONFIRMED", tier: 3, ...base };
  // L2 已推 → 同池 L3 被抑制（不再重复推送）
  assert.deepEqual(pendingSweepEvents([l3], { "1_BSL_PDH_105_RECLAIMED_RAID": 123 }, now), []);
  // L1 已推但 L2 未推 → L3 仍允许（未推过收回信息，确认升级有价值）
  assert.deepEqual(pendingSweepEvents([l3], { "1_BSL_PDH_105_LIQUIDITY_TAKEN": 123 }, now), [l3]);
  // L1 已推 → L2 仍允许（拿走→收回语义变化，必须提醒）
  assert.deepEqual(pendingSweepEvents([l2], { "1_BSL_PDH_105_LIQUIDITY_TAKEN": 123 }, now), [l2]);
  // 未推任何级别 → L3 正常推送
  assert.deepEqual(pendingSweepEvents([l3], {}, now), [l3]);
});

test("rangeId key 上线迁移：既有旧 L3 baseKey 可抑制同一历史事件重推", () => {
  const event = {
    tier: 3,
    key: "1_BSL_DR_NEW_PDH_105_ICT_2022_CONFIRMED",
    baseKey: "1_BSL_DR_NEW_PDH_105",
    previousBaseKey: "1_BSL_PDH_105",
    legacyKey: "1_BSL",
    time: 1,
  };
  const pushed = { "1_BSL_PDH_105_ICT_2022_CONFIRMED": 123 };
  assert.deepEqual(pendingSweepEvents([event], pushed, 1), []);
});

test("L1 只补报最近20分钟，L2/L3只在当前4小时检测窗内升级", () => {
  const now = 10_000_000;
  const oldTime = now - 21 * 60_000;
  const l1 = { key: "old_l1", tier: 1, time: oldTime };
  const l2 = { key: "old_l2", tier: 2, time: oldTime };
  assert.deepEqual(pendingSweepEvents([l1, l2], {}, now), [l2]);
  const staleL2 = { key: "stale_l2", tier: 2, time: now - 5 * 3600_000 };
  const staleL3 = { key: "stale_l3", tier: 3, time: now - 24 * 3600_000 };
  assert.deepEqual(pendingSweepEvents([staleL2, staleL3], {}, now), []);
});

test("机会冷却兼容旧版滚动index key，部署后不重推同一FVG", () => {
  const op = {
    key: "RETRACE_BULLISH_BULLISH_FVG_2000_973.57_974",
    type: "RETRACE",
    direction: "BULLISH",
    zone: { bottom: 973.57, top: 974 },
  };
  const pushed = {
    "RETRACE_BULLISH_BULLISH_FVG_982_973.57_974_1786785600000": 12345,
    "RETRACE_BULLISH_BULLISH_FVG_700_970_971_1786780000000": 99999,
  };
  assert.equal(opportunityLastPushedAt(op, pushed), 12345);
  assert.equal(opportunityLastPushedAt({ ...op, key: "direct" }, { direct: 456 }), 456);
});

test("事件候选保留窗口内 SWEPT/BROKEN，供 L1/L2 补报", () => {
  const now = 10_000;
  assert.equal(isSweepCandidateAt({ state: "ACTIVE" }, now, 1000), true);
  assert.equal(isSweepCandidateAt({ state: "SWEPT", sweptAt: 9500 }, now, 1000), true);
  assert.equal(isSweepCandidateAt({ state: "SWEPT", sweptAt: 8000 }, now, 1000), false);
  assert.equal(isSweepCandidateAt({ state: "BROKEN", brokenAt: 9500 }, now, 1000), true);
  assert.equal(isSweepCandidateAt({ state: "BROKEN", brokenAt: 8000 }, now, 1000), false);
});

test("buildSweep: 三级通知分别显示拿流动性、收回与 ICT 2022 确认", () => {
  const common = { symbol: "BTCUSDT", price: 106, cur: baseCur, confidenceScore: 0, newsLine: null };
  const l1 = buildSweep({ ...common, sweep: { tier: 1, stage: "LIQUIDITY_TAKEN", side: "BSL", type: "PDH", level: 105, sweptPrice: 107, close: 106, time: 1, realtime: false } });
  assert.match(l1, /流动性事件 L1/);
  assert.match(l1, /流动性事件 L1（已收盘）/);
  assert.match(l1, /LIQUIDITY_TAKEN/);
  assert.match(l1, /尚未收回/);

  const l2 = buildSweep({ ...common, sweep: { tier: 2, stage: "RECLAIMED_RAID", side: "BSL", type: "PDH", level: 105, sweptPrice: 107, close: 104, time: 1, realtime: false } });
  assert.match(l2, /流动性事件 L2/);
  assert.match(l2, /RECLAIMED_RAID/);

  const event = { type: "MSS", direction: "DOWN", level: 104, confirmed: true, confirmedByDisplacement: true, displacementFvg: { bottom: 103, top: 104 } };
  const l3 = buildSweep({ ...common, sweep: { tier: 3, stage: "ICT_2022_CONFIRMED", side: "BSL", type: "PDH", level: 105, sweptPrice: 107, close: 104, time: 1, realtime: false, confirmationFvg: { bottom: 103, top: 104, executable: true, quality: "STRUCTURE", executionStatus: "OPEN" } }, mss5m: { lastEvent: event } });
  assert.match(l3, /流动性事件 L3/);
  assert.match(l3, /ICT_2022_CONFIRMED/);
  assert.match(l3, /位移主导 MSS · FVG 103-104（结构级 · OPEN）/);
});

test("buildSweep: 同价位多来源合并展示", () => {
  const msg = buildSweep({
    symbol: "COWUSDT",
    price: 0.1532,
    cur: baseCur,
    confidenceScore: 0,
    sweep: {
      tier: 1, stage: "LIQUIDITY_TAKEN", side: "BSL",
      type: "EXTERNAL_HIGH", levelTypes: ["EXTERNAL_HIGH", "PDH", "INTERNAL_HIGH"],
      level: 0.1025, sweptPrice: 0.1026, close: 0.1026, time: 1, realtime: false,
    },
  });
  assert.match(msg, /区间外部高点（ERL） \/ 昨日高点 \/ 内部摆动高点 0\.1025/);
});

test("同一波同方向扫过多个不同价位时只构建一条合并通知", () => {
  const events = [
    { key: "a", tier: 2, stage: "RECLAIMED_RAID", side: "BSL", type: "INTERNAL_HIGH", level: 0.31849, sweptPrice: 0.32253, close: 0.31575, time: 100, closedTime: 300, realtime: false },
    { key: "b", tier: 2, stage: "RECLAIMED_RAID", side: "BSL", type: "INTERNAL_HIGH", level: 0.3161, sweptPrice: 0.31832, close: 0.31575, time: 0, reclaimTime: 100, closedTime: 300, realtime: false },
  ];
  const grouped = groupSweepNotifications(events);
  assert.equal(grouped.length, 1);
  assert.deepEqual(grouped[0].notificationKeys, ["a", "b"]);

  const msg = buildSweep({ symbol: "BTWUSDT", price: 0.31232, cur: baseCur, confidenceScore: 0, sweep: grouped[0] });
  assert.match(msg, /合并 2 个池/);
  assert.match(msg, /0\.31849/);
  assert.match(msg, /0\.3161/);
});

test("同一扫损 K 上单根收回与跨根收回两池 → eventAt 统一（BTW 08/16 同根双推回归）", () => {
  const kTime = Date.UTC(2026, 8 - 1, 16, 12, 15); // 刺破 K 开盘 20:15 北京
  const kClose = kTime + 5 * 60_000 - 1; // 刺破 K 收盘 20:19:59
  const nextOpen = kTime + 5 * 60_000; // 收回 K 开盘 20:20
  const events = [
    // 单根收回：closedTime = 刺破 K 收盘
    { key: "a", tier: 2, stage: "RECLAIMED_RAID", side: "BSL", type: "INTERNAL_HIGH", level: 0.32542, sweptPrice: 0.32838, close: 0.32499, time: kTime, closedTime: kClose, realtime: false },
    // 跨根收回：reclaimTime 为收回 K 开盘；closedTime 也统一为刺破 K 收盘（sweep.js 修复后）
    { key: "b", tier: 2, stage: "RECLAIMED_RAID", side: "BSL", type: "INTERNAL_HIGH", level: 0.32474, sweptPrice: 0.32838, close: 0.32247, time: kTime, reclaimTime: nextOpen, closedTime: kClose, realtime: false },
  ];
  const grouped = groupSweepNotifications(events);
  assert.equal(grouped.length, 1, "同扫损 K 的单根+跨根事件应合并为一条通知");
  assert.deepEqual(grouped[0].notificationKeys, ["a", "b"]);
});

test("扫损消息只关联扫损后、反转方向一致的 MSS", () => {
  const identity = { originRangeId: "DR_RUN", rangeId: "DR_RUN", tradingDayId: "2026-08-16" };
  const sweep = { side: "SSL", closedTime: 200, ...identity };
  const events = [
    { type: "MSS", direction: "UP", confirmed: true, time: 100, ...identity },
    { type: "MSS", direction: "DOWN", confirmed: true, time: 250, ...identity },
    { type: "BOS", direction: "UP", confirmed: true, time: 260, ...identity },
    { type: "MSS", direction: "UP", confirmed: true, time: 270, ...identity },
  ];
  assert.equal(structureEventForSweep(events, sweep)?.time, 270);
});

test("一次 MSS 只确认它之前最近的一组 sweep，不复用到更早的独立 raid", () => {
  const identity = { originRangeId: "DR_RUN", rangeId: "DR_RUN", tradingDayId: "2026-08-16" };
  const oldSweep = { tier: 2, side: "BSL", closedTime: 100, ...identity };
  const recentA = { tier: 2, side: "BSL", closedTime: 200, ...identity };
  const recentB = { tier: 2, side: "BSL", closedTime: 200, ...identity };
  const mss = { type: "MSS", direction: "DOWN", confirmed: true, time: 300, ...identity };
  const links = linkStructureEventsToSweeps([mss], [oldSweep, recentA, recentB], 1000);

  assert.equal(links.has(oldSweep), false);
  assert.equal(links.get(recentA), mss);
  assert.equal(links.get(recentB), mss);
});

test("超过 sweep→MSS 因果窗口的结构转移不得把旧 sweep 升级为 L3", () => {
  const sweep = { tier: 2, side: "SSL", closedTime: 100 };
  const late = { type: "MSS", direction: "UP", confirmed: true, time: 201 };
  assert.equal(structureEventForSweep([late], sweep, 100), null);
  assert.equal(linkStructureEventsToSweeps([late], [sweep], 100).size, 0);
});

test("L3绑定本次MSS位移产生的ICT有效FVG，不受ATR执行宽度影响", () => {
  const identity = { originRangeId: "DR_RUN", rangeId: "DR_RUN", tradingDayId: "2026-08-16", displacementId: "DISP_RUN" };
  const event = { confirmedByDisplacement: true, displacementConfirmationIndex: 7, displacementFvg: { bottom: 0.03982, top: 0.04001 }, ...identity };
  const valid = { index: 7, bottom: 0.03982, top: 0.04001, ictValid: true, executable: false, executionQuality: "THIN", quality: "STRUCTURE", ...identity };
  const filled = { ...valid, ictValid: false, executionStatus: "FILLED" };
  assert.equal(executableFvgForMss([filled, valid], event), valid);
  assert.equal(executableFvgForMss([filled], event), null);
});

test("P0: overview 嵌套状态展开为 5m 机会扫描所需环境", () => {
  const sweep = { side: "SSL", time: 1 };
  const liquiditySequences = [{ id: "LIQSEQ_SSL_1", status: "ICT_CONFIRMED" }];
  const env = opportunityEnvOf({
    symbol: "BTCUSDT", price: 100, structureStatus: "VALID", sweep, sweeps: [sweep], liquiditySequences,
    cur: { bias: "BULLISH", confidence: "HIGH", quality: "HIGH", decision: "WATCH" },
  });
  assert.equal(env.bias, "BULLISH");
  assert.equal(env.confidence, "HIGH");
  assert.equal(env.quality, "HIGH");
  assert.equal(env.decision, "WATCH");
  assert.equal(env.price, 100);
  assert.equal(env.structureStatus, "VALID");
  assert.equal(env.sweep, sweep);
  assert.deepEqual(env.sweeps, [sweep]);
  assert.equal(env.liquiditySequences, liquiditySequences);
});

test("目标摘要优先显示价格先遇到的流动性，再显示远端 HTF Draw", () => {
  const targets = buildTargetSummary(
    { primary: { type: "PWH", price: 1483 }, alternatives: [{ type: "PDH", price: 1287.53 }] },
    "BULLISH", 1279.39, { price: 1232.13 },
  );
  assert.equal(targets.first.type, "PDH");
  assert.equal(targets.remote.type, "PWH");
  assert.ok(targets.first.planR < 0.2);
  assert.ok(targets.remote.planR > 4);
});

const baseCur = { bias: "NEUTRAL", confidence: "LOW", decision: "WAIT", quality: "LOW", planR: null, scenario: "RANGE" };
const basePrev = { bias: "BULLISH", confidence: "LOW", decision: "WAIT", quality: "LOW", planR: null, scenario: "RANGE" };

test("buildChanged: bias 翻转 + 结构失效 MSS（C1 schema）— ⚠️ 头、旧→新、MSS 结构行、价格", () => {
  const msg = buildChanged({
    symbol: "BTCUSDT", price: 108, reason: [],
    changes: ["bias"], prev: basePrev, cur: baseCur,
    confidenceScore: 0, structureStatus: "INVALIDATED",
    invalidation: { type: "BREAK_PROTECTED_LOW", price: 108.5 },
    mss: { type: "MSS", direction: "DOWN", level: 108.5, price: 108, confirmed: true, structureFrom: "BULLISH", structureTo: "NEUTRAL", time: "08/05 20:00" },
  });
  assert.match(msg, /\*\*⚠️ BTCUSDT 4H Bias 变化\*\*/);
  assert.match(msg, /🟢 BULLISH → ⚪ NEUTRAL/);
  assert.match(msg, /\*\*结构事件: STRUCTURE_BREAK\*\*（向下跌破 108.5，原 BULLISH 结构失效）/);
  assert.match(msg, /触发: 08\/05 20:00 · 价格 108/);
  assert.match(msg, /操作: WAIT/);
  assert.match(msg, /价格: 108/);
});

test("buildChanged: 非 bias 变化 — ℹ️ 头、信心度/操作 旧→新、原因、机会质量", () => {
  const msg = buildChanged({
    symbol: "ETHUSDT", price: 3500, reason: "信心度提升：HTF 对齐 + 折价区",
    changes: ["confidence", "decision"],
    prev: { ...basePrev, bias: "BULLISH" },
    cur: { bias: "BULLISH", confidence: "MEDIUM", decision: "WATCH_FOR_ENTRY", quality: "MEDIUM", planR: 1.2, scenario: "TREND_CONTINUATION" },
    confidenceScore: 52, structureStatus: "VALID", invalidation: null, mss: null,
  });
  assert.match(msg, /\*\*ℹ️ ETHUSDT 4H Bias 更新\*\*/);
  // ℹ️ 更新也带背景：当前 Bias + 结构状态（bias 未变，无 旧→新 对比）
  assert.match(msg, /🟢 BULLISH/);
  assert.match(msg, /结构: VALID（新多头结构形成（HH\+HL））/);
  assert.match(msg, /模型信心: LOW → MEDIUM · 共振评分 52/);
  assert.match(msg, /操作: WAIT → WATCH_FOR_ENTRY/);
  assert.match(msg, /机会质量: MEDIUM/);
  assert.match(msg, /原因: 信心度提升/);
  assert.match(msg, /价格: 3500/);
});

test("appendNotification: 追加存档 + 超 24h 清空重写", () => {
  const file = join(tmpdir(), `notify-test-${Date.now()}-${Math.random()}.jsonl`);
  try {
    appendNotification("消息1", "t1", file);
    appendNotification("消息2", "t2", file);
    const lines = readFileSync(file, "utf8").trim().split("\n");
    assert.equal(lines.length, 2, "两条消息都应追加");
    assert.match(lines[0], /"title":"t1".*"text":"消息1"/);
    // 模拟过期：文件 mtime 拨到 25h 前 → 下次写入应清空重写
    const past = new Date(Date.now() - 25 * 3600_000);
    utimesSync(file, past, past);
    appendNotification("消息3", "t3", file);
    const after = readFileSync(file, "utf8").trim().split("\n");
    assert.equal(after.length, 1, "过期文件应先清空再写，只保留新消息");
    assert.match(after[0], /"text":"消息3"/);
  } finally {
    rmSync(file, { force: true });
  }
});

test("buildChanged: Scenario 值 + 原因英译中（ETHUSDT 08-06 通知场景）", () => {
  const msg = buildChanged({
    symbol: "ETHUSDT", price: 1910.86, reason: "Enough upside room with acceptable direction probability",
    changes: ["confidence", "decision"],
    prev: { ...basePrev, bias: "BULLISH" },
    cur: { bias: "BULLISH", confidence: "MEDIUM", decision: "WATCH", quality: "HIGH", planR: 1.26, scenario: "BULLISH_REVERSAL_ATTEMPT", session: { start: 20, end: 24, ratio: 28.6 } },
    confidenceScore: 45, structureStatus: "VALID", invalidation: null, mss: null,
  });
  assert.match(msg, /市场背景: 4H 正在转多，但大周期仍偏空/);
  assert.match(msg, /原因: 方向概率可接受且上方空间充足/);
  assert.match(msg, /活跃成交量: 活跃窗口 20:00-24:00（占比 28.6%）/);
});

test("buildChanged: 等效回撤点 — planR<1 且 riskLine 已知时给出可执行回撤价", () => {
  const msg = buildChanged({
    symbol: "DRAMUSDT", price: 57.18, reason: "方向可接受但第一目标结构空间有限，等待更好位置",
    changes: ["confidence"],
    prev: { ...basePrev, bias: "BULLISH" },
    cur: { bias: "BULLISH", confidence: "HIGH", decision: "WAIT", quality: "LOW", planR: 0.33, riskLine: 53.94, targets: { first: { type: "PDH", price: 58.25, planR: 0.33 }, remote: null }, scenario: "BULLISH_CONTINUATION" },
    confidenceScore: 75, structureStatus: "VALID", invalidation: null, mss: null,
  });
  // 1R 等效回撤价 = (58.25 + 53.94) / 2 = 56.095；多头区间 (riskLine, 现价) 内 → 显示
  assert.match(msg, /第一目标: 昨日高点 58.25（0\.33R）/, "planR 展示照旧");
  assert.match(msg, /回撤到 56\.095 可达 1R/, "给出可执行回撤点，不再只报空间不足");
});

test("buildChanged: 止损参考 — riskLine 与 4H MSS/深层保护位不同时标注来源", () => {
  const msg = buildChanged({
    symbol: "SKHYUSDT", price: 164.91, reason: "Enough upside room with acceptable direction probability",
    changes: ["confidence", "decision"],
    prev: { ...basePrev, bias: "BULLISH" },
    cur: { bias: "BULLISH", confidence: "HIGH", decision: "WATCH", quality: "HIGH", planR: 2.34, riskLine: 162.78, targets: { first: { type: "PDH", price: 168.65, planR: 2.34 }, remote: null }, scenario: "BULLISH_CONTINUATION" },
    confidenceScore: 75, structureStatus: "VALID", invalidation: null,
    mssInvalidation: { type: "BREAK_LAST_LOW", price: 151.16 },
    structureProtection: { type: "BREAK_PROTECTED_LOW", price: 134.01 },
  });
  // riskLine 162.78 ≠ MSS 151.16 ≠ 深层保护 134.01 → 标注 1h 止损参考
  assert.match(msg, /4H MSS确认位: 151\.16（收盘跌破才确认结构转移）/, "4H MSS 位照旧展示");
  assert.match(msg, /止损参考: 最近1H摆动 162\.78（planR 风险基准）/);
  assert.match(msg, /第一目标: 昨日高点 168\.65（2\.34R）/);
});

test("buildSweep: SSL 已收盘确认 — 侧/位/价/回收/背景字段齐全", () => {
  const msg = buildSweep({
    symbol: "SPCXUSDT", price: 111.56,
    sweep: { side: "SSL", type: "EQL", level: 111.01, sweptPrice: 110.67, close: 111.56, time: 111111, key: "k", realtime: false, closedTime: 111222, levelTime: 111000 },
    cur: baseCur, confidenceScore: 0, mss5m: null,
  });
  assert.match(msg, /\*\*⚡ SPCXUSDT 流动性扫损（已确认）\*\*/);
  assert.match(msg, /下方卖方流动性（SSL）被扫：跌破 等低点 111.01（低 110.67）后收回，收 111.56/);
  // 被扫流动性位的形成时间（EQH/EQL=触点 4H K，显示日期+时间）+ 扫损 K 时段（5m 整刻度）
  assert.match(msg, /流动性位形成: \d{2}\/\d{2} \d{2}:\d{2}（4H K）/);
  assert.match(msg, /扫损 K: \d{2}\/\d{2} \d{2}:\d{2} - \d{2}:\d{2}（已收盘确认）/, "已确认扫损应显示 5m K 时段（开盘-收盘整刻度），便于对照图表定位");
  assert.match(msg, /市场背景:/);
  assert.match(msg, /Bias: ⚪ NEUTRAL/);
  assert.match(msg, /市场背景: 方向不明确，价格处于震荡/);
  assert.match(msg, /模型信心: LOW · 共振评分 0/);
  assert.match(msg, /操作: WAIT/);
});

test("buildSweep: 带 5m 结构事件标注（C3）— 扫损消息展示 5m MSS/BOS", () => {
  const msg = buildSweep({
    symbol: "SPCXUSDT", price: 111.56,
    sweep: { side: "SSL", type: "EQL", level: 111.01, sweptPrice: 110.67, close: 111.56, time: 111111, key: "k", realtime: false, closedTime: 111222 },
    cur: baseCur, confidenceScore: 0,
    mss5m: { direction: "BULLISH", lastEvent: { type: "MSS", direction: "UP", level: 111.22, confirmed: true } },
  });
  assert.match(msg, /5m 结构: MSS UP @ 111.22（已确认）/);
});

test("buildSweep: BSL 实时 — 刺破上方流动性且现价收回", () => {
  const msg = buildSweep({
    symbol: "BTCUSDT", price: 104,
    sweep: { side: "BSL", type: "PDH", level: 105, sweptPrice: 106, close: 104, time: 1, key: "k", realtime: true, levelTime: 5 },
    cur: baseCur, confidenceScore: 0, mss5m: null,
  });
  assert.match(msg, /\*\*⚡ BTCUSDT 流动性扫损（实时）\*\*/);
  assert.match(msg, /上方买方流动性（BSL）被扫：刺破 昨日高点 105（高 106）后收回，收 104/);
  // PDH/PDL/PWH/PWL 是日/周 K → 只显示日期
  assert.match(msg, /流动性位形成: \d{2}\/\d{2}（日\/周 K）/);
});

test("buildSweep: 股票关联盘前区间流动性位（PRE_MARKET）— 显示明确来源与形成时间", () => {
  const msg = buildSweep({
    symbol: "MUUSDT", price: 0.0401,
    sweep: { side: "SSL", type: "PRE_MARKET_LOW", level: 0.04, sweptPrice: 0.0399, close: 0.0401, time: 111111, key: "k", realtime: false, closedTime: 111222, levelTime: 1754604000000, levelDate: "2026-08-07" },
    cur: baseCur, confidenceScore: 0, mss5m: null,
  });
  assert.match(msg, /盘前低点/);
  assert.match(msg, /流动性位形成: \d{2}\/\d{2} \d{2}:\d{2}/);
});

test("buildSweep: 纽约盘前区间位无 highTime/lowTime（旧数据）→ 回退只显日期", () => {
  const msg = buildSweep({
    symbol: "MUUSDT", price: 0.0401,
    sweep: { side: "SSL", type: "PRE_MARKET_LOW", level: 0.04, sweptPrice: 0.0399, close: 0.0401, time: 111111, key: "k", realtime: false, closedTime: 111222, levelDate: "2026-08-07" },
    cur: baseCur, confidenceScore: 0, mss5m: null,
  });
  assert.match(msg, /盘前低点/);
  assert.match(msg, /流动性位形成: 08\/07/);
});

test("buildSweep: Crypto Asia Range 使用独立中文标签", () => {
  const msg = buildSweep({
    symbol: "BTCUSDT", price: 64010,
    sweep: { side: "SSL", type: "ASIA_LOW", level: 64000, sweptPrice: 63980, close: 64010, time: 111111, key: "asia", realtime: false, closedTime: 111222, levelTime: 1754604000000 },
    cur: baseCur, confidenceScore: 0, mss5m: null,
  });
  assert.match(msg, /亚洲时段低点/);
});

test("buildSweep: 内部摆动位（INTERNAL_LOW，1H swing 低点）— 显示中文标签+形成时间（1H K）", () => {
  const msg = buildSweep({
    symbol: "BTCUSDT", price: 64200,
    sweep: { side: "SSL", type: "INTERNAL_LOW", level: 64100, sweptPrice: 64080, close: 64250, time: 111111, key: "k", realtime: false, closedTime: 111222, levelTime: 1754604000000 },
    cur: baseCur, confidenceScore: 0, mss5m: null,
  });
  assert.match(msg, /跌破 内部摆动低点 64100/);
  assert.match(msg, /流动性位形成: \d{2}\/\d{2} \d{2}:\d{2}（1H K）/, "内部摆动位是 1H swing，应标注 1H K 形成时间");
});

test("buildSweep: 内部摆动位（INTERNAL_HIGH，1H swing 高点）— BSL 侧同样显示", () => {
  const msg = buildSweep({
    symbol: "BTCUSDT", price: 65200,
    sweep: { side: "BSL", type: "INTERNAL_HIGH", level: 65500, sweptPrice: 65550, close: 65100, time: 222222, key: "k", realtime: true },
    cur: baseCur, confidenceScore: 0, mss5m: null,
  });
  assert.match(msg, /刺破 内部摆动高点 65500/);
  assert.match(msg, /\*\*⚡ BTCUSDT 流动性扫损（实时）\*\*/);
});

test("buildSweep: 跨根收回分别展示刺破 K 与收回 K", () => {
  const raid = Date.parse("2026-08-15T01:00:00Z");
  const msg = buildSweep({
    symbol: "BTCUSDT", price: 100,
    sweep: { side: "BSL", type: "EQH", level: 101, sweptPrice: 102, close: 100, time: raid, reclaimTime: raid + 300_000, key: "k", realtime: false },
    cur: baseCur, confidenceScore: 0, mss5m: null,
  });
  assert.match(msg, /刺破 K: .* → 收回 K: .*（跨根确认）/);
});

test("buildCloseReport: 收上/收下幅度 + 位移标注（含 BOS/FVG 证据）+ 推动区间审计行", () => {
  const msg = buildCloseReport([
    { symbol: "BTCUSDT", last4h: { open: 100, close: 101.2 }, displacement: { direction: "UP", ratio: 2, quality: "HIGH", structureBreak: { type: "BOS", direction: "UP", level: 101.5 }, fvg: { top: 101.5, bottom: 99.9 } }, cur: { bias: "BULLISH", confidence: "MEDIUM" }, confidenceScore: 52, range: { rangeType: "IMPULSE_BULLISH", low: 100, high: 101.5, startReason: "回撤低点(HL)", endReason: "结构推进高点(HH)" }, amd: { stage: "DISTRIBUTION", direction: "BULLISH", reason: "5m位移 2× 推动" } },
    { symbol: "ETHUSDT", last4h: { open: 100, close: 99.5 }, displacement: null, cur: { bias: "BEARISH", confidence: "LOW" }, confidenceScore: 10 },
  ]);
  assert.match(msg, /\*\*4H 收盘报告\*\*/);
  assert.match(msg, /\*\*普通状态\*\*/);
  assert.match(msg, /\*\*BTCUSDT\*\* 收上 \+1.20%/);
  assert.match(msg, /模型信心 MEDIUM · 共振评分 52 · 当前风险 中/);
  assert.match(msg, /收盘重新跌回BOS下方，向上推动失败/);
  assert.match(msg, /推动区间: 多头推动（回撤低点\(HL\) 100 → 结构推进高点\(HH\) 101\.5）/);
  assert.match(msg, /位移 2\.0x（高质量）/);
  assert.match(msg, /阶段: 分发\(多头\) · 5m位移 2× 推动/);
  assert.match(msg, /\*\*ETHUSDT\*\* -0.50% · 🔴 空头 · 风险低 · WAIT/);
});

test("buildCloseReport: 位移方向与收线方向相反 → 直白显示推动失败，不再误称背离", () => {
  const msg = buildCloseReport([
    { symbol: "SPCXUSDT", last4h: { open: 137, close: 136.5 }, displacement: { direction: "UP", ratio: 2.4, structureBreak: { type: "BOS", direction: "UP", level: 138 }, fvg: { top: 136.8, bottom: 136.5 } }, cur: { bias: "BULLISH", confidence: "MEDIUM" }, confidenceScore: 65 },
  ]);
  assert.match(msg, /收下 -0.36%/);
  assert.match(msg, /短线行为: 5m向上位移 2.4x（收盘重新跌回BOS下方，向上推动失败；5m BOS 138，5m FVG 136.5-136.8）/);
  assert.ok(!msg.includes("背离"));
});

test("buildCloseReport: 异动合约（|幅度|≥5%）置顶加 ⚡，按幅度降序", () => {
  const msg = buildCloseReport([
    { symbol: "BTCUSDT", last4h: { open: 100, close: 101 }, cur: { bias: "BULLISH", confidence: "MEDIUM" }, confidenceScore: 50 },
    { symbol: "BICOUSDT", last4h: { open: 1, close: 0.685 }, cur: { bias: "NEUTRAL", confidence: "LOW" }, confidenceScore: 0 },
    { symbol: "BLUAIUSDT", last4h: { open: 1, close: 0.869 }, cur: { bias: "NEUTRAL", confidence: "LOW" }, confidenceScore: 0 },
  ]);
  assert.match(msg, /⚡ \*\*BICOUSDT\*\* 收下 -31.50%/);
  assert.ok(msg.indexOf("⚡ **BICOUSDT**") < msg.indexOf("⚡ **BLUAIUSDT**"), "异动按幅度降序（-31.5% 在 -13.1% 前）");
  assert.ok(msg.indexOf("⚡ **BLUAIUSDT**") < msg.indexOf("**BTCUSDT**"), "异动在普通合约前");
});

test("buildCloseReport: FVG 极窄（1 tick 级）→ 只显示单值", () => {
  const msg = buildCloseReport([
    { symbol: "BICOUSDT", last4h: { open: 1, close: 1.05 }, displacement: { direction: "UP", ratio: 4.3, structureBreak: { type: "BOS", direction: "UP", level: 0.054 }, fvg: { top: 0.054, bottom: 0.054 } }, cur: { bias: "NEUTRAL", confidence: "LOW" }, confidenceScore: 0 },
  ]);
  assert.match(msg, /FVG 0\.054/);
  assert.ok(!msg.includes("FVG 0.054-0.054"), "极窄缺口不应显示区间");
});

test("buildCloseReport: 无合约处于活跃窗口 → 头部省略统计；有 → 显示", () => {
  const none = buildCloseReport([
    { symbol: "BTCUSDT", last4h: { open: 100, close: 101 }, cur: { bias: "BULLISH", confidence: "MEDIUM" }, confidenceScore: 50 },
  ]);
  assert.match(none, /\*\*4H 收盘报告\*\*（北京/);
  assert.ok(!none.includes("本时段"), "0 个活跃窗口时省略统计");
  const some = buildCloseReport([
    { symbol: "BTCUSDT", last4h: { open: 100, close: 101 }, cur: { bias: "BULLISH", confidence: "MEDIUM", session: { start: 20, end: 24, ratio: 23.4 } }, confidenceScore: 50 },
  ]);
  assert.match(some, /本时段 1\/1 合约处于活跃窗口/);
});

test("buildCloseReport: 有效方向中性时展示4H结构与日线冲突原因", () => {
  const msg = buildCloseReport([
    {
      symbol: "BTCUSDT",
      last4h: { open: 64000, close: 63920 },
      cur: {
        bias: "NEUTRAL", structureBias: "BULLISH", narrativeBias: "BEARISH",
        confidence: "LOW", decision: "WAIT", htfContext: { confirmedDirection: "BEARISH", confirmedTimeframe: "1D" },
      },
      htfContext: { confirmedDirection: "BEARISH", confirmedTimeframe: "1D" },
      structureStatus: "VALID",
      confidenceScore: 0,
    },
  ]);
  assert.match(msg, /方向: ⚪ 中性 · 模型信心 LOW · 共振评分 0 · 当前风险 高/);
  assert.match(msg, /建议操作: WAIT/);
  assert.match(msg, /环境: 4H多头结构有效 · 日线偏空/);
  assert.match(msg, /4H 与大周期方向冲突，反转证据不足，暂时保持中性/);
});

test("buildCloseReport: 静默中性合约合并显示", () => {
  const msg = buildCloseReport([
    { symbol: "CLUUSDT", last4h: { open: 80, close: 80.2 }, cur: { bias: "NEUTRAL", structureBias: "NEUTRAL", confidence: "LOW" }, confidenceScore: 0 },
    { symbol: "SPCXUSDT", last4h: { open: 137, close: 137.1 }, cur: { bias: "NEUTRAL", structureBias: "NEUTRAL", confidence: "LOW" }, confidenceScore: 0 },
  ]);
  assert.match(msg, /中性无事件 2/);
  assert.match(msg, /中性无事件: CLUUSDT、SPCXUSDT/);
});

test("displacementFor4h: 只取本根4H内的5m位移，排除边界外事件", () => {
  const ds = [
    { time: 999, direction: "DOWN", ratio: 3 },
    { time: 1100, direction: "UP", ratio: 1.5, structureBreak: { level: 101 }, fvg: { top: 102, bottom: 101 } },
    { time: 1900, direction: "DOWN", ratio: 2.1, structureBreak: { level: 99 }, fvg: { top: 99, bottom: 98 } },
    { time: 2001, direction: "UP", ratio: 4 },
  ];
  const d = displacementFor4h(ds, { time: 1000, closeTime: 2000 });
  assert.equal(d.time, 1900);
  assert.equal(d.direction, "DOWN");
  assert.equal(d.count, 2);
  assert.equal(d.upCount, 1);
  assert.equal(d.downCount, 1);
  assert.equal(d.dominantDirection, "NEUTRAL");
});

test("buildCloseReport: 接近保护位时保留模型分数，但报告建议降为 WAIT", () => {
  const msg = buildCloseReport([
    {
      symbol: "XRPUSDT", last4h: { open: 1, close: 1.02 },
      cur: { bias: "BEARISH", structureBias: "BEARISH", confidence: "HIGH", decision: "WATCH" },
      confidenceScore: 90, structureStatus: "VALID", invalidation: { price: 1.04 },
    },
  ]);
  assert.match(msg, /模型信心 HIGH · 共振评分 90 · 当前风险 高/);
  assert.match(msg, /建议操作: WAIT（模型 WATCH）/);
  assert.match(msg, /空头尚未失效，但接近保护位，不适合继续追空/);
});

test("buildCloseReport: 多次位移按方向计数并标注主导方向", () => {
  const msg = buildCloseReport([
    {
      symbol: "CYSUSDT", last4h: { open: 1.2, close: 1.1 },
      cur: { bias: "BULLISH", structureBias: "BULLISH", confidence: "MEDIUM", decision: "WATCH" }, confidenceScore: 55,
      displacement: {
        direction: "DOWN", ratio: 3.9, count: 6, upCount: 2, downCount: 4, dominantDirection: "DOWN",
        structureBreak: { level: 1.117 }, fvg: { top: 1.125, bottom: 1.102 },
      },
    },
  ]);
  assert.match(msg, /本4H位移 向上2次\/向下4次，主导向下/);
});

test("buildOverview: 首轮全览字段布局（Scenario · 模型信心/共振评分 · 机会质量 · 操作）", () => {
  const msg = buildOverview([
    { symbol: "BTCUSDT", cur: { bias: "BULLISH", scenario: "BULLISH_CONTINUATION", confidence: "MEDIUM", quality: "MEDIUM", planR: 1.2, decision: "WATCH_FOR_ENTRY" }, confidenceScore: 52 },
  ]);
  assert.match(msg, /\*\*4H Bias Monitor\*\*/);
  assert.match(msg, /\*\*BTCUSDT\*\* 🟢 BULLISH/);
  assert.match(msg, /市场背景: 4H 与大周期一致向上 · 模型信心: MEDIUM · 共振评分 52 · 机会质量: MEDIUM \(1.20\) · 操作: WATCH_FOR_ENTRY/);
});

test("buildChanged: 有效且距离较近的多头 Breaker → 显示角色反转与消耗状态", () => {
  const msg = buildChanged({
    symbol: "ETHUSDT", price: 1910.86, reason: [],
    changes: ["confidence"],
    prev: { ...basePrev, bias: "BULLISH" },
    cur: {
      bias: "BULLISH", confidence: "MEDIUM", decision: "WATCH", quality: "HIGH", planR: 1.26, scenario: "BULLISH_REVERSAL_ATTEMPT",
      ob: { type: "BULLISH_BREAKER", direction: "BULLISH", kind: "BREAKER", state: "MITIGATED", high: 1850, low: 1830, status: "MITIGATED", location: "DISCOUNT" },
    },
    confidenceScore: 45, structureStatus: "VALID", invalidation: null, mss: null,
  });
  assert.match(msg, /下方支撑: 失败空头 OB 反转为多头 Breaker（已浅回踩）/);
});

test("buildChanged: 已填补或距现价过远的 Breaker 不再显示成当前支撑阻力", () => {
  const common = {
    symbol: "SNDKUSDT", price: 1279.39, reason: "Enough upside room with acceptable direction probability",
    changes: ["confidence"], prev: { ...basePrev, bias: "BULLISH" }, confidenceScore: 65,
    structureStatus: "VALID", invalidation: null, mss: null,
  };
  const filled = buildChanged({
    ...common,
    cur: { bias: "BULLISH", confidence: "MEDIUM", decision: "WAIT", quality: "LOW", planR: 0.17, scenario: "BULLISH_CONTINUATION", ob: { type: "BEARISH_OB", kind: "BREAKER", state: "USED", high: 1300, low: 1290, status: "FILLED" } },
  });
  const far = buildChanged({
    ...common,
    cur: { bias: "BULLISH", confidence: "MEDIUM", decision: "WAIT", quality: "LOW", planR: 0.17, scenario: "BULLISH_CONTINUATION", ob: { type: "BEARISH_OB", kind: "BREAKER", state: "USED", high: 1861.47, low: 1852.87, status: "OPEN" } },
  });
  assert.ok(!filled.includes("上方阻力:"));
  assert.ok(!far.includes("上方阻力:"));
});

test("buildChanged: 多头 Bias 的上方结构级空头 OB → 标注阻力、消耗和反向关系", () => {
  const msg = buildChanged({
    symbol: "BTCUSDT", price: 100, reason: "Direction probability too low",
    changes: ["confidence"],
    prev: { ...basePrev, bias: "BULLISH", confidence: "MEDIUM" },
    cur: {
      bias: "BULLISH", confidence: "LOW", decision: "NO_TRADE", quality: "LOW", planR: 0.36, scenario: "BULLISH_REVERSAL_ATTEMPT",
      ob: { type: "BEARISH_OB", direction: "BEARISH", kind: "STANDARD", state: "MITIGATED", high: 105, low: 102, status: "MITIGATED", location: "PREMIUM" },
    },
    confidenceScore: 25, structureStatus: "VALID", invalidation: null, mss: null,
  });
  assert.match(msg, /上方阻力: 结构下破位移产生的空头 OB（已浅回踩；与当前多头方向相反）/);
});

test("buildChanged: 价格正处于未回踩空头 OB 内 → 显示当前阻力", () => {
  const msg = buildChanged({
    symbol: "BTCUSDT", price: 103, reason: "Direction probability too low",
    changes: ["confidence"],
    prev: { ...basePrev, bias: "BULLISH", confidence: "MEDIUM" },
    cur: {
      bias: "BULLISH", confidence: "LOW", decision: "NO_TRADE", quality: "LOW", planR: 0.36, scenario: "BULLISH_REVERSAL_ATTEMPT",
      ob: { type: "BEARISH_OB", direction: "BEARISH", kind: "STANDARD", state: "FRESH", high: 105, low: 102, status: "FRESH", location: "PREMIUM" },
    },
    confidenceScore: 25, structureStatus: "VALID", invalidation: null, mss: null,
  });
  assert.match(msg, /当前阻力: 结构下破位移产生的空头 OB（尚未回踩；与当前多头方向相反）/);
});

test("buildChanged: 已失效 OB → 不显示辅助行", () => {
  const msg = buildChanged({
    symbol: "ETHUSDT", price: 1910.86, reason: [],
    changes: ["confidence"],
    prev: { ...basePrev, bias: "BULLISH" },
    cur: {
      bias: "BULLISH", confidence: "MEDIUM", decision: "WATCH", quality: "HIGH", planR: 1.26, scenario: "BULLISH_REVERSAL_ATTEMPT",
      ob: { type: "BULLISH_OB", direction: "BULLISH", kind: "STANDARD", state: "INVALIDATED", high: 101.5, low: 98, status: "INVALIDATED", location: "DISCOUNT" },
    },
    confidenceScore: 45, structureStatus: "VALID", invalidation: null, mss: null,
  });
  assert.ok(!msg.includes("支撑:"));
  assert.ok(!msg.includes("阻力:"));
});

test("buildOpportunity: 🎯 5m 机会单条消息（环境 + 观察位 + 触发链）", () => {
  const op = {
    symbol: "MUUSDT", type: "RETRACE", direction: "BULLISH", entry: 880.5,
    zone: { type: "FVG", top: 882.5, bottom: 880.5 },
    confirmation: { type: "RECLAIM_CLOSE", time: Date.parse("2026-08-12T13:35:00Z"), price: 884.1, text: "5m 收阳站回执行区中点确认" },
    trade: { entry: 884.1, stop: 880.5, stopSource: "EXECUTION_ZONE", target: 891.3, planR: 2 },
    trigger: "价格回踩 FVG 880.5-882.5（5 根 5m 前形成，未消耗）", score: 70, key: "k", time: Date.now(),
  };
  const env = { price: 884.1, confidenceScore: 45, cur: { bias: "BULLISH", confidence: "MEDIUM", decision: "WATCH", session: { start: 20, end: 24, ratio: 23.4 } }, amd: { stage: "DISTRIBUTION", direction: "BULLISH", reason: "5m位移 2× 推动" } };
  const msg = buildOpportunity(op, env);
  assert.match(msg, /\*\*🎯 MUUSDT 5m 机会\*\*/);
  assert.match(msg, /🟢 多头（执行区回踩）· 评分 70/);
  assert.match(msg, /观察位: 880\.5 · 现价 884\.1/);
  assert.match(msg, /入场确认: 5m 收阳站回执行区中点确认 · 确认价 884\.1 · 21:35/);
  assert.match(msg, /5m交易计划: 确认价 884\.1 · 失效位 880\.5（5m执行区远端）/);
  assert.match(msg, /第一目标: 891\.3 · 交易 planR 2\.00/);
  assert.match(msg, /环境: 🟢 BULLISH · 模型信心 MEDIUM · 共振评分 45 · 操作 WATCH · 活跃窗口 20:00-24:00（占比 23.4%） · 当前不在 ICT Killzone/);
  assert.match(msg, /阶段: 分发\(多头\) · 5m位移 2× 推动/);
  assert.match(msg, /触发: 价格回踩 FVG 880.5-882.5/);
  // 现价只出现在"观察位"行，不再有独立的尾部价格行（避免重复）
  assert.ok(!/价格: 884\.1/.test(msg), "机会消息不应再重复推送价格行");
});

test("buildOpportunity: WICK_FILLED 使用回踩拒绝极值文案", () => {
  const op = {
    symbol: "MUUSDT", type: "RETRACE", direction: "BULLISH", entry: 973.57,
    zone: { type: "FVG", top: 974, bottom: 973.57, executionStatus: "WICK_FILLED" },
    confirmation: { time: Date.parse("2026-08-15T11:20:00Z"), price: 973.89, text: "5m 收阳站回执行区中点确认" },
    trade: { entry: 973.89, stop: 973.2, stopSource: "REJECTION_EXTREME", target: 988.27, planR: 20.84 },
    trigger: "价格回踩 FVG 973.57-974（影线填平、收盘未填平）", score: 70,
  };
  const env = { price: 973.89, cur: { bias: "BULLISH", confidence: "HIGH", decision: "WAIT" } };
  const msg = buildOpportunity(op, env);
  assert.match(msg, /失效位 973\.2（回踩拒绝极值）/);
  assert.match(msg, /影线填平、收盘未填平/);
});

test("buildOpportunity: 带执行区（CHAIN 链）— 显示执行区行与 4H 操作", () => {
  const op = {
    symbol: "BTCUSDT", type: "CHAIN", direction: "BEARISH", entry: 101, zone: { type: "FVG", top: 102, bottom: 101 },
    trigger: "扫损BSL → 5m MSS 向下 → 回踩 FVG 101-102", score: 85, key: "k", time: Date.now(),
  };
  const env = { price: 101.5, confidenceScore: 0, cur: { bias: "BEARISH", confidence: "LOW", decision: "NO TRADE", session: null } };
  const msg = buildOpportunity(op, env);
  assert.match(msg, /🔴 空头（扫损→MSS→回踩）· 评分 85/);
  assert.match(msg, /执行区: FVG 101-102/);
  assert.match(msg, /环境: 🔴 BEARISH · 模型信心 LOW · 共振评分 0 · 操作 NO TRADE · 非活跃窗口 · 当前不在 ICT Killzone/);
});

test("buildOpportunity: 关键位置位移MSS明确标注WATCH", () => {
  const op = {
    symbol: "BTCUSDT", type: "KEY_MSS", direction: "BEARISH", entry: 64039.4, score: 70,
    zone: { type: "4H OB", top: 64380, bottom: 64010.4 },
    localSweep: { side: "BSL", level: 64400, sweptPrice: 64450 },
    confirmation: { text: "5m MSS DOWN 收盘确认", price: 64039.4, time: Date.parse("2026-08-12T12:39:59.999Z") },
    trade: { entry: 64039.4, stop: 64450, stopSource: "LOCAL_SWEEP_EXTREME", target: 63211.6, planR: 2.016 },
    displacementConfirmed: true,
    trigger: "4H关键执行区 → 扫BSL → 5m MSS DOWN（位移确认）",
  };
  const env = { price: 64039.4, confidenceScore: 75, cur: { bias: "BEARISH", confidence: "HIGH", decision: "WAIT", session: null } };
  const msg = buildOpportunity(op, env);
  assert.match(msg, /关键位置5m结构确认/);
  assert.match(msg, /扫上方短线流动性 64400（极值 64450）/);
  assert.match(msg, /参考 planR 2\.02/);
  assert.match(msg, /带位移确认.*操作 WATCH/);
});

test("buildOpportunityDigest: 📊 机会榜汇总 Top 列表", () => {
  const list = [
    { symbol: "MUUSDT", type: "RETRACE", direction: "BULLISH", entry: 880.5, score: 70 },
    { symbol: "ETHUSDT", type: "RETRACE", direction: "BEARISH", entry: 3500, score: 65 },
  ];
  const msg = buildOpportunityDigest(list);
  assert.match(msg, /\*\*📊 5m 机会榜\*\*/);
  assert.match(msg, /本时段 2 个合约出现 5m 机会（评分 ≥ 60）：/);
  assert.match(msg, /1\. MUUSDT 🟢 多头 执行区回踩 @ 880\.5（70）/);
  assert.match(msg, /2\. ETHUSDT 🔴 空头 执行区回踩 @ 3500（65）/);
});

test("buildSweep: 消息面窗口标注（股票代币）— 数据前扫损勿当 Judas/结构信号", () => {
  const msg = buildSweep({
    symbol: "MUUSDT", price: 880,
    sweep: { side: "SSL", type: "EQL", level: 875, sweptPrice: 872, close: 880, time: 111111, key: "k", realtime: false },
    cur: baseCur, confidenceScore: 0, mss5m: null,
    newsLine: "未来 8h 有高影响数据 CPI（20:30） —— 数据前波动多为操纵，勿当方向信号",
  });
  assert.match(msg, /⚠️ 消息面: 未来 8h 有高影响数据 CPI（20:30） —— 数据前波动多为操纵，勿当方向信号/);
  // 无 Judas 时只出现消息面标注，不出"开盘假动作"
  assert.ok(!msg.includes("开盘假动作"));
});

test("buildSweep: 无消息面窗口（山寨币 / 无事件）→ 不标注", () => {
  const msg = buildSweep({
    symbol: "DOGEUSDT", price: 0.2,
    sweep: { side: "SSL", type: "EQL", level: 0.19, sweptPrice: 0.188, close: 0.2, time: 111111, key: "k", realtime: false },
    cur: baseCur, confidenceScore: 0, mss5m: null,
  });
  assert.ok(!msg.includes("消息面"));
});

test("buildChanged: bias 翻转 + 消息面窗口标注（BTCUSDT 恒标注）", () => {
  const msg = buildChanged({
    symbol: "BTCUSDT", price: 108, reason: [],
    changes: ["bias"], prev: basePrev, cur: baseCur,
    confidenceScore: 0, structureStatus: "INVALIDATED",
    invalidation: { type: "BREAK_PROTECTED_LOW", price: 108.5 },
    mss: { type: "MSS", direction: "DOWN", level: 108.5, price: 108, confirmed: true, structureFrom: "BULLISH", structureTo: "NEUTRAL", time: "08/05 20:00" },
    newsLine: "未来 8h 有 FOMC利率决议（02:00） —— 数据前波动多为操纵，勿当方向信号",
  });
  assert.match(msg, /⚠️ 消息面: 未来 8h 有 FOMC利率决议（02:00） —— 数据前波动多为操纵，勿当方向信号/);
});
