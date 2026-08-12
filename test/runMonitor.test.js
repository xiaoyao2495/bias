/**
 * runMonitor.test.js — 监控消息构建（纯函数层）
 *
 * 覆盖 runMonitor 的核心展示逻辑（多次返工、最易出错的字段布局）：
 *   buildChanged / buildSweep / buildCloseReport / buildOverview
 * 网络、文件状态、钉钉推送等副作用不在此测（依赖 dry-run 集成验证）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildChanged, buildSweep, buildCloseReport, buildOverview, buildOpportunity, buildOpportunityDigest, resolveFinalAction, opportunityEnvOf } from "../scripts/runMonitor.js";
import { displacementFor4h, buildTargetSummary } from "../monitor/biasMonitor.js";

test("最终操作服从执行区，并在 1R 临界区保留旧状态", () => {
  assert.equal(resolveFinalAction({ decisionLabel: "WATCH", execution: "WAIT", planR: 4.3 }, { decision: "WATCH" }), "WAIT");
  assert.equal(resolveFinalAction({ decisionLabel: "WATCH", execution: "READY", planR: 0.996 }, { decision: "WAIT" }), "WAIT");
  assert.equal(resolveFinalAction({ decisionLabel: "WATCH", execution: "READY", planR: 1.01 }, { decision: "WATCH" }), "WATCH");
  assert.equal(resolveFinalAction({ decisionLabel: "WATCH", execution: "READY", planR: 1.06 }, { decision: "WAIT" }), "WATCH");
});

test("P0: overview 嵌套状态展开为 5m 机会扫描所需环境", () => {
  const sweep = { side: "SSL", time: 1 };
  const env = opportunityEnvOf({
    symbol: "BTCUSDT", price: 100, structureStatus: "VALID", sweep,
    cur: { bias: "BULLISH", confidence: "HIGH", quality: "HIGH", decision: "WATCH" },
  });
  assert.equal(env.bias, "BULLISH");
  assert.equal(env.confidence, "HIGH");
  assert.equal(env.quality, "HIGH");
  assert.equal(env.decision, "WATCH");
  assert.equal(env.price, 100);
  assert.equal(env.structureStatus, "VALID");
  assert.equal(env.sweep, sweep);
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
  assert.match(msg, /\*\*结构事件: MSS\*\*（向下跌破 108.5，原 BULLISH 结构失效）/);
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
  assert.match(msg, /信心度: LOW → MEDIUM 52/);
  assert.match(msg, /操作: WAIT → WATCH_FOR_ENTRY/);
  assert.match(msg, /机会质量: MEDIUM \(第一目标结构空间比 1.20\)/);
  assert.match(msg, /原因: 信心度提升/);
  assert.match(msg, /价格: 3500/);
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
  assert.match(msg, /Session: 活跃窗口 20:00-24:00（占比 28.6%）/);
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
  assert.match(msg, /信心度: LOW 0/);
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

test("buildSweep: 16:00-21:00 区间流动性位（PRE_MARKET）— 只显形成时间，不标时段名", () => {
  const msg = buildSweep({
    symbol: "BICOUSDT", price: 0.0401,
    sweep: { side: "SSL", type: "PRE_MARKET_LOW", level: 0.04, sweptPrice: 0.0399, close: 0.0401, time: 111111, key: "k", realtime: false, closedTime: 111222, levelTime: 1754604000000, levelDate: "2026-08-07" },
    cur: baseCur, confidenceScore: 0, mss5m: null,
  });
  // 虚拟币无盘前概念：只显示形成极值的那根 1H K 时间（日期+小时分钟），不带"盘前"字样
  assert.match(msg, /流动性位形成: \d{2}\/\d{2} \d{2}:\d{2}/);
  assert.ok(!msg.includes("盘前"), "虚拟币消息不应出现盘前字样");
});

test("buildSweep: 16:00-21:00 区间位无 highTime/lowTime（旧数据）→ 回退只显日期", () => {
  const msg = buildSweep({
    symbol: "BICOUSDT", price: 0.0401,
    sweep: { side: "SSL", type: "PRE_MARKET_LOW", level: 0.04, sweptPrice: 0.0399, close: 0.0401, time: 111111, key: "k", realtime: false, closedTime: 111222, levelDate: "2026-08-07" },
    cur: baseCur, confidenceScore: 0, mss5m: null,
  });
  assert.match(msg, /流动性位形成: 08\/07/);
  assert.ok(!msg.includes("盘前"), "虚拟币消息不应出现盘前字样");
});

test("buildCloseReport: 收上/收下幅度 + 位移标注（含 BOS/FVG 证据）", () => {
  const msg = buildCloseReport([
    { symbol: "BTCUSDT", last4h: { open: 100, close: 101.2 }, displacement: { direction: "UP", ratio: 2, structureBreak: { type: "BOS", direction: "UP", level: 101.5 }, fvg: { top: 101.5, bottom: 99.9 } }, cur: { bias: "BULLISH", confidence: "MEDIUM" }, confidenceScore: 52 },
    { symbol: "ETHUSDT", last4h: { open: 100, close: 99.5 }, displacement: null, cur: { bias: "BEARISH", confidence: "LOW" }, confidenceScore: 10 },
  ]);
  assert.match(msg, /\*\*4H 收盘报告\*\*/);
  assert.match(msg, /\*\*普通状态\*\*/);
  assert.match(msg, /\*\*BTCUSDT\*\* 收上 \+1.20%/);
  assert.match(msg, /模型信心 MEDIUM 52 · 当前风险 中/);
  assert.match(msg, /收盘重新跌回BOS下方，向上推动失败/);
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
  assert.match(msg, /方向: ⚪ 中性 · 模型信心 LOW 0 · 当前风险 高/);
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
  assert.match(msg, /模型信心 HIGH 90 · 当前风险 高/);
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

test("buildOverview: 首轮全览字段布局（Scenario · 信心度 · 机会质量 · 操作）", () => {
  const msg = buildOverview([
    { symbol: "BTCUSDT", cur: { bias: "BULLISH", scenario: "BULLISH_CONTINUATION", confidence: "MEDIUM", quality: "MEDIUM", planR: 1.2, decision: "WATCH_FOR_ENTRY" }, confidenceScore: 52 },
  ]);
  assert.match(msg, /\*\*4H Bias Monitor\*\*/);
  assert.match(msg, /\*\*BTCUSDT\*\* 🟢 BULLISH/);
  assert.match(msg, /市场背景: 4H 与大周期一致向上 · 信心度: MEDIUM 52 · 机会质量: MEDIUM \(1.20\) · 操作: WATCH_FOR_ENTRY/);
});

test("buildChanged: 有效且距离较近的下方多头 BREAKER → 显示位置、作用和消耗状态", () => {
  const msg = buildChanged({
    symbol: "ETHUSDT", price: 1910.86, reason: [],
    changes: ["confidence"],
    prev: { ...basePrev, bias: "BULLISH" },
    cur: {
      bias: "BULLISH", confidence: "MEDIUM", decision: "WATCH", quality: "HIGH", planR: 1.26, scenario: "BULLISH_REVERSAL_ATTEMPT",
      ob: { type: "BULLISH_OB", kind: "BREAKER", state: "USED", high: 1850, low: 1830, status: "OPEN", location: "DISCOUNT" },
    },
    confidenceScore: 45, structureStatus: "VALID", invalidation: null, mss: null,
  });
  assert.match(msg, /下方支撑: 多头区域破位后重新收回（已回踩，效力减弱）/);
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

test("buildChanged: 多头 Bias 的上方空头 REJECTION → 标注阻力、效力和反向关系", () => {
  const msg = buildChanged({
    symbol: "BTCUSDT", price: 100, reason: "Direction probability too low",
    changes: ["confidence"],
    prev: { ...basePrev, bias: "BULLISH", confidence: "MEDIUM" },
    cur: {
      bias: "BULLISH", confidence: "LOW", decision: "NO_TRADE", quality: "LOW", planR: 0.36, scenario: "BULLISH_REVERSAL_ATTEMPT",
      ob: { type: "BEARISH_OB", kind: "REJECTION", state: "USED", high: 105, low: 102, status: "OPEN", location: "PREMIUM" },
    },
    confidenceScore: 25, structureStatus: "VALID", invalidation: null, mss: null,
  });
  assert.match(msg, /上方阻力: 空头区域曾压低价格（已回踩，效力减弱；与当前多头方向相反）/);
});

test("buildChanged: 价格正处于未回踩空头 OB 内 → 显示当前阻力", () => {
  const msg = buildChanged({
    symbol: "BTCUSDT", price: 103, reason: "Direction probability too low",
    changes: ["confidence"],
    prev: { ...basePrev, bias: "BULLISH", confidence: "MEDIUM" },
    cur: {
      bias: "BULLISH", confidence: "LOW", decision: "NO_TRADE", quality: "LOW", planR: 0.36, scenario: "BULLISH_REVERSAL_ATTEMPT",
      ob: { type: "BEARISH_OB", kind: "REJECTION", state: "FRESH", high: 105, low: 102, status: "OPEN", location: "PREMIUM" },
    },
    confidenceScore: 25, structureStatus: "VALID", invalidation: null, mss: null,
  });
  assert.match(msg, /当前阻力: 空头区域曾压低价格（尚未回踩，参考价值较高；与当前多头方向相反）/);
});

test("buildChanged: OB STANDARD·USED → 不显示辅助行（避免噪音）", () => {
  const msg = buildChanged({
    symbol: "ETHUSDT", price: 1910.86, reason: [],
    changes: ["confidence"],
    prev: { ...basePrev, bias: "BULLISH" },
    cur: {
      bias: "BULLISH", confidence: "MEDIUM", decision: "WATCH", quality: "HIGH", planR: 1.26, scenario: "BULLISH_REVERSAL_ATTEMPT",
      ob: { type: "BULLISH_OB", kind: "STANDARD", state: "USED", high: 101.5, low: 98, status: "OPEN", location: "DISCOUNT" },
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
  const env = { price: 884.1, confidenceScore: 45, cur: { bias: "BULLISH", confidence: "MEDIUM", decision: "WATCH", session: { start: 20, end: 24, ratio: 23.4 } } };
  const msg = buildOpportunity(op, env);
  assert.match(msg, /\*\*🎯 MUUSDT 5m 机会\*\*/);
  assert.match(msg, /🟢 多头（执行区回踩）· 评分 70/);
  assert.match(msg, /观察位: 880\.5 · 现价 884\.1/);
  assert.match(msg, /入场确认: 5m 收阳站回执行区中点确认 · 确认价 884\.1 · 21:35/);
  assert.match(msg, /5m交易计划: 确认价 884\.1 · 失效位 880\.5（5m执行区远端）/);
  assert.match(msg, /第一目标: 891\.3 · 交易 planR 2\.00/);
  assert.match(msg, /环境: 🟢 BULLISH · 信心度 MEDIUM 45 · 操作 WATCH · 活跃窗口 20:00-24:00（占比 23.4%）/);
  assert.match(msg, /触发: 价格回踩 FVG 880.5-882.5/);
  assert.match(msg, /价格: 884.1/);
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
  assert.match(msg, /环境: 🔴 BEARISH · 信心度 LOW 0 · 操作 NO TRADE · 非活跃窗口/);
});

test("buildOpportunity: 关键位置普通MSS明确标注WATCH且非最高质量", () => {
  const op = {
    symbol: "BTCUSDT", type: "KEY_MSS", direction: "BEARISH", entry: 64039.4, score: 70,
    zone: { type: "4H OB", top: 64380, bottom: 64010.4 },
    localSweep: { side: "BSL", level: 64400, sweptPrice: 64450 },
    confirmation: { text: "5m MSS DOWN 收盘确认", price: 64039.4, time: Date.parse("2026-08-12T12:39:59.999Z") },
    trade: { entry: 64039.4, stop: 64450, stopSource: "LOCAL_SWEEP_EXTREME", target: 63211.6, planR: 2.016 },
    displacementConfirmed: false,
    trigger: "4H关键执行区 → 扫BSL → 5m MSS DOWN（普通确认）",
  };
  const env = { price: 64039.4, confidenceScore: 75, cur: { bias: "BEARISH", confidence: "HIGH", decision: "WAIT", session: null } };
  const msg = buildOpportunity(op, env);
  assert.match(msg, /关键位置5m结构确认/);
  assert.match(msg, /扫上方短线流动性 64400（极值 64450）/);
  assert.match(msg, /参考 planR 2\.02/);
  assert.match(msg, /未形成位移\/FVG，不是最高质量信号.*操作 WATCH/);
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
