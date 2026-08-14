/**
 * opportunity.test.js — 5m 机会扫描器（纯函数层）
 *
 * 覆盖 scanOpportunities 两类信号：
 *   RETRACE — 价格回踩同向 5m FVG
 *   CHAIN   — 扫损(SSL) → 5m MSS 向上 → 回踩多头 FVG（完整链条）
 * 结构证据（BOS/MSS）不直接产生入场。
 * 环境过滤：NEUTRAL bias 不出机会。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  scanOpportunities,
  computeM5Context,
  detectKeyPositionMss,
  isRecentKeyMss,
  assessKeyMssChase,
} from "../monitor/opportunity.js";

const NOW = Date.now();
// 前置 15 根 flat K 使数据量 ≥ 20（scanOpportunities 的最低防御），同时
// 保证 BOS/MSS 事件与末根价格都在 60 分钟有效窗口内（T0 需足够早）
const PADS = 15;
const T0 = NOW - 30 * 5 * 60_000;

/** rows: [open, high, low, close] → 5m K 线（前置 PADS 根 flat K，全部已收盘） */
function mkCandles(rows) {
  const padded = [...Array.from({ length: PADS }, () => [100, 100, 100, 100]), ...rows];
  return padded.map(([o, h, l, c], i) => ({
    time: T0 + i * 300_000,
    open: o,
    high: h,
    low: l,
    close: c,
    closeTime: T0 + (i + 1) * 300_000,
  }));
}

const baseEnv = (over) => ({
  bias: "BULLISH",
  price: 0,
  confidence: "HIGH",
  quality: "HIGH",
  decision: "WATCH",
  ictSession: { name: "NEW_YORK" },
  structureStatus: "VALID",
  sweep: null,
  ...over,
});

test("P1-3 RETRACE：回踩 5m FVG 后收阳站回中点 → 出现确认机会", () => {
  // 三根 K 形成 bullish FVG [100,102]（idx0.high=100 < idx2.low=102），随后价格回踩到区间内
  const m5 = mkCandles([
    [100, 100, 100, 100], // idx0 FVG 起点，high=100
    [101, 101, 101, 101], // idx1 中间 K
    [102, 102, 102, 102], // idx2 low=102 > 100 → bullish FVG [100,102]
    [101.5, 103, 101, 102], // low=101 不形成新 FVG
    [101, 101.5, 100.8, 101], // 仅回踩，尚未确认
    [101, 102.2, 100.9, 102.1], // 收阳站回中点 101，确认
  ]);
  const env = baseEnv({ price: 102.1 });
  const opps = scanOpportunities({ symbol: "BTCUSDT", env, m5 });
  const retrace = opps.find((o) => o.type === "RETRACE");
  assert.ok(retrace, "应出现 RETRACE 机会");
  assert.equal(retrace.direction, "BULLISH");
  assert.equal(retrace.entry, 100); // 多头顺位端 = FVG bottom
  assert.deepEqual(retrace.trade, {
    entry: 102.1, stop: 100, stopSource: "EXECUTION_ZONE", target: null, planR: null,
  });
  assert.equal(retrace.confirmation.type, "RECLAIM_CLOSE");
  assert.ok(retrace.score >= 60, `score ${retrace.score} 应达推送门槛`);
});

test("CHAIN：SSL 扫损 → 5m MSS 向上 → 回踩位移腿 FVG（完整 ICT 链条）", () => {
  // 先 BEARISH 结构（HH→LL→LH→LL），idx6 收盘 103 突破 lastHigh 102 → MSS UP（位移腿）
  // 位移腿自身形成 FVG [102,103]（idx6 low 103 > idx4 high 102，位移 K 自身确认）；
  // P1：CHAIN 执行区必须由位移腿产生 → 随后价格回踩到该 FVG [102,103] 内（未跌穿 bottom）
  const m5 = mkCandles([
    [100, 100, 100, 100],
    [100, 105, 100, 105], // swing high 105 → HH
    [104, 104, 98, 100], // swing low 98 → LL
    [100, 100, 99, 100],
    [100, 102, 99, 101], // swing high 102 → LH（MSS 参照）
    [98, 99, 97, 98], // swing low 97 → LL
    [102, 103, 103, 103], // 位移 MSS UP：实体 1、突破 102、FVG [102,103]（位移 K 自身确认）
    [102.6, 102.8, 102.6, 102.6], // 回踩，尚未确认
    [102.5, 103.2, 102.4, 103.1], // 收阳站回 FVG 中点，确认
  ]);
  const sweep = { side: "SSL", key: "t0_SSL", level: 99, sweptPrice: 97, close: 102.6, time: T0 };
  const env = baseEnv({ price: 103.1, sweep });
  const opps = scanOpportunities({ symbol: "BTCUSDT", env, m5 });
  const chain = opps.find((o) => o.type === "CHAIN");
  assert.ok(chain, "应出现 CHAIN 机会");
  assert.equal(chain.direction, "BULLISH");
  assert.ok(chain.zone && chain.zone.type === "FVG", "CHAIN 应带执行区");
  assert.equal(chain.zone.index, 21, "CHAIN 执行区应精确对应位移腿 FVG（index=21）");
  assert.ok(chain.trigger.includes("MSS"), `trigger 应含 MSS：${chain.trigger}`);
  assert.equal(chain.trade.stop, 97, "完整 CHAIN 应用扫损极值作为 5m 失效位");
  assert.equal(chain.trade.stopSource, "SWEEP_EXTREME");
  assert.ok(chain.score >= 60, `score ${chain.score} 应达推送门槛`);
});

test("P1: CHAIN 要求 MSS 位移确认 —— 贴线（非位移）MSS 不触发 CHAIN", () => {
  // 与 CHAIN 用例同结构，但 idx6 改为小实体贴线突破（close 102.2 刚过 lastHigh 102，
  // 实体 0.7 < 1.5×avg）→ MSS 无位移确认 → 完整链条不成立
  const m5 = mkCandles([
    [100, 100, 100, 100],
    [100, 105, 100, 105], // swing high 105 → HH
    [104, 104, 98, 100], // swing low 98 → LL
    [100, 100, 99, 100],
    [100, 102, 99, 101], // swing high 102 → LH（MSS 参照）
    [98, 99, 97, 98], // swing low 97 → LL
    [101.5, 103, 101.5, 102.2], // 贴线 MSS UP：实体 0.7，收盘 102.2 > lastHigh 102（不构成位移）
    [101, 101, 100, 100], // FVG 起点 high=101
    [100, 100, 99, 99],
    [102, 102, 102, 102], // bullish FVG [101,102]
    [101.5, 102, 101.5, 101.8], // 回踩到 FVG 内，price=101.8
  ]);
  const sweep = { side: "SSL", key: "t0_SSL", level: 99, sweptPrice: 97, close: 101.8, time: T0 };
  const env = baseEnv({ price: 101.8, sweep });
  const opps = scanOpportunities({ symbol: "BTCUSDT", env, m5 });
  assert.ok(!opps.find((o) => o.type === "CHAIN"), "贴线（非位移）MSS 不应触发 CHAIN");
});

test("关键位置 MSS：4H执行区内扫高后普通5m MSS向下 → 保留为WATCH，不要求FVG", () => {
  const base = Date.now() - 45 * 60_000;
  const candles = [
    [100, 101, 99, 100], [100, 102, 99.5, 101], [101, 101.5, 99.8, 100.5],
    [100.5, 103, 100, 102], [102, 104, 101, 103],
    [103, 105, 102, 103.5], // 扫过前6根最高 104，收回其下
    [103.5, 104, 99, 99.5], // 普通 MSS DOWN 确认
  ].map(([open, high, low, close], i) => ({ time: base + i * 300_000, closeTime: base + (i + 1) * 300_000, open, high, low, close }));
  const event = { type: "MSS", direction: "DOWN", level: 100, price: 99.5, confirmed: true, confirmedByDisplacement: false, time: candles[6].closeTime };
  const env = baseEnv({
    bias: "BEARISH", decision: "WAIT", directionDecision: "WATCH", price: 99.5,
    executionZones: [{ type: "BEARISH_OB", top: 106, bottom: 102 }],
    targets: { first: { type: "PDL", price: 95 } },
  });
  const op = detectKeyPositionMss({ env, ctx: { candles, events: [event] }, bias: "BEARISH" });
  assert.ok(op, "关键4H执行区内的扫高+普通MSS应保留");
  assert.equal(op.type, "KEY_MSS");
  assert.equal(op.displacementConfirmed, false);
  assert.equal(op.localSweep.sweptPrice, 105);
});

test("关键位置 MSS：没有触及4H同向执行区 → 不提示", () => {
  const base = Date.now() - 40 * 60_000;
  const candles = [
    [100, 101, 99, 100], [100, 102, 99, 101], [101, 103, 100, 102],
    [102, 104, 101, 103], [103, 105, 102, 103.5], [103.5, 104, 99, 99.5],
  ].map(([open, high, low, close], i) => ({ time: base + i * 300_000, closeTime: base + (i + 1) * 300_000, open, high, low, close }));
  const event = { type: "MSS", direction: "DOWN", level: 100, price: 99.5, confirmed: true, confirmedByDisplacement: false, time: candles.at(-1).closeTime };
  const env = baseEnv({ bias: "BEARISH", executionZones: [{ type: "BEARISH_OB", top: 120, bottom: 115 }] });
  assert.equal(detectKeyPositionMss({ env, ctx: { candles, events: [event] }, bias: "BEARISH" }), null);
});

test("关键位置 MSS 时效：只接受最近 45 分钟（约 9 根已收盘 5m），陈旧事件不补发", () => {
  const now = Date.now();
  const candles = Array.from({ length: 6 }, (_, i) => ({ time: now - (6 - i) * 300_000, closeTime: now - (5 - i) * 300_000 }));
  assert.equal(isRecentKeyMss({ time: candles[0].closeTime }, candles, now), true, "45min 窗口内（即使后面已有 5 根）仍有效");
  assert.equal(isRecentKeyMss({ time: now - 50 * 60_000 }, candles, now), false, "超过 45 分钟窗口 → 过期，不补发");
});

test("关键位置 MSS 追价：已运行超过0.5R或当前剩余空间不足1R均过滤", () => {
  const trade = { entry: 64039.4, stop: 64450, target: 63211.6 };
  const stale = assessKeyMssChase({ trade, currentPrice: 63475.5, direction: "BEARISH" });
  assert.equal(stale.eligible, false);
  assert.equal(stale.reason, "MOVED_TOO_FAR");
  assert.ok(stale.progressR > 1.3);
  assert.ok(stale.remainingR < 0.3);

  const fresh = assessKeyMssChase({ trade, currentPrice: 63980, direction: "BEARISH" });
  assert.equal(fresh.eligible, true);
  assert.ok(fresh.progressR < 0.5);
  assert.ok(fresh.remainingR > 1);

  const littleSpace = assessKeyMssChase({ trade: { entry: 100, stop: 102, target: 99 }, currentPrice: 100, direction: "BEARISH" });
  assert.equal(littleSpace.eligible, false);
  assert.equal(littleSpace.reason, "INSUFFICIENT_REMAINING_R");
});

test("P1: CHAIN 的 MSS 位移在事件根即可确认（第三根位移 FVG）→ 触发 CHAIN", () => {
  // 与 CHAIN 用例同结构，但 idx6 改为第三根位移（low=103 > idx4.high=102 → FVG 由位移 K 自身确认，
  // confirmationIndex = 位移 K 自身）→ MSS UP 位移确认成立 → CHAIN 触发
  const m5 = mkCandles([
    [100, 100, 100, 100],
    [100, 105, 100, 105], // swing high 105 → HH
    [104, 104, 98, 100], // swing low 98 → LL
    [100, 100, 99, 100],
    [100, 102, 99, 101], // swing high 102 → LH（MSS 参照）
    [98, 99, 97, 98], // swing low 97 → LL
    [102, 103, 103, 103], // 位移 MSS UP：实体 1、突破 102、FVG [102,103]（分支 1，自身确认）
    [102.6, 102.8, 102.6, 102.6], // 回踩，尚未确认
    [102.5, 103.2, 102.4, 103.1], // 5m 收阳站回中点确认
  ]);
  const sweep = { side: "SSL", key: "t0_SSL", level: 99, sweptPrice: 97, close: 102.6, time: T0 };
  const env = baseEnv({ price: 103.1, sweep });
  const opps = scanOpportunities({ symbol: "BTCUSDT", env, m5 });
  const chain = opps.find((o) => o.type === "CHAIN");
  assert.ok(chain, "位移确认的 MSS 应触发 CHAIN");
  assert.match(chain.trigger, /位移确认/);
});

test("P1: 位移腿 FVG 已填平 → 旧 FVG 不能拼成 CHAIN（只能回踩，不报链条）", () => {
  // 位移 MSS 腿 FVG [102,103] 随即被 idx7 大跌跌穿（FILLED，collectZones 无条件排除）；
  // 随后 idx8-9 形成的旧 FVG [101,102] 虽在价格区间内，但不是位移腿产生
  // → linkedToMss 匹配失败 → 不报 CHAIN（RETRACE 仍正常）
  const m5 = mkCandles([
    [100, 100, 100, 100],
    [100, 105, 100, 105], // swing high 105 → HH
    [104, 104, 98, 100], // swing low 98 → LL
    [100, 100, 99, 100],
    [100, 102, 99, 101], // swing high 102 → LH（MSS 参照）
    [98, 99, 97, 98], // swing low 97 → LL
    [102, 103, 103, 103], // 位移 MSS UP：FVG [102,103]
    [100, 100, 99, 99], // 大跌：low 99 跌穿 FVG bottom 102 → [102,103] 被填平（FILLED）
    [101, 101, 100, 100], // 旧 FVG 起点 high=101
    [102, 102, 102, 102], // low=102 > 101 → 旧 FVG [101,102]
    [101.5, 102, 100.8, 101.8], // 深回踩：low 100.8 插到 [100,102] 中点 101 以下（V2.7 深触碰要求）
    [101.6, 102.3, 101.5, 102.1], // 收阳确认普通 RETRACE
  ]);
  const sweep = { side: "SSL", key: "t0_SSL", level: 99, sweptPrice: 97, close: 101.8, time: T0 };
  const env = baseEnv({ price: 102.1, sweep });
  const opps = scanOpportunities({ symbol: "BTCUSDT", env, m5 });
  assert.ok(!opps.find((o) => o.type === "CHAIN"), "旧 FVG 不得拼成完整 CHAIN");
  assert.ok(opps.find((o) => o.type === "RETRACE"), "普通回踩机会不受影响");
});

test("P1-3：只有触碰执行区、没有收盘收回或同向结构确认 → 不生成机会", () => {
  const m5 = mkCandles([
    [100, 100, 100, 100],
    [101, 101, 101, 101],
    [102, 102, 102, 102], // bullish FVG [100,102]
    [101.8, 102, 100.8, 101], // 进入区间但收阴，未确认
  ]);
  const opps = scanOpportunities({ symbol: "BTCUSDT", env: baseEnv({ price: 101 }), m5 });
  assert.deepEqual(opps, []);
});

test("环境过滤：4H decision NO_TRADE → 无机会（决策层拦截，避免两层信号矛盾）", () => {
  // 即使 CHAIN 评分可凑够 60 分（confidence LOW 0 + quality HIGH + 活跃窗口 + VALID + CHAIN 25 + zone 5），
  // 决策层 NO_TRADE 也必须直接拦截
  const m5 = mkCandles([
    [100, 100, 100, 100],
    [100, 105, 100, 105],
    [104, 104, 98, 100],
    [100, 100, 99, 100],
    [100, 102, 99, 101],
    [98, 99, 97, 98],
    [100, 103, 100, 103], // MSS UP
    [101, 101, 100, 100],
    [100, 100, 99, 99],
    [102, 102, 102, 102], // bullish FVG [101,102]
    [101.5, 102, 101.5, 101.8], // 回踩到 FVG 内
  ]);
  const sweep = { side: "SSL", key: "t0_SSL", level: 99, sweptPrice: 97, close: 101.8, time: T0 };
  const env = baseEnv({ price: 101.8, sweep, confidence: "LOW", decision: "NO_TRADE", decisionLabel: "NO TRADE" });
  const opps = scanOpportunities({ symbol: "BTCUSDT", env, m5 });
  assert.deepEqual(opps, [], "decision NO_TRADE 时机会层必须返回空");
});

test("V2.6 门禁：最终操作 WAIT 但方向标签 WATCH（planR≥1）→ 有效回踩生成 RETRACE", () => {
  const m5 = mkCandles([
    [100, 100, 100, 100],
    [101, 101, 101, 101],
    [102, 102, 102, 102],
    [101.5, 103, 101, 102],
    [101, 101.5, 100.8, 101],
    [101, 102.2, 100.9, 102.1], // 收阳站回中点 → 确认
  ]);
  const opps = scanOpportunities({
    symbol: "BTCUSDT",
    env: baseEnv({ price: 102.1, decision: "WAIT", decisionLabel: "WATCH" }),
    m5,
  });
  const retrace = opps.find((o) => o.type === "RETRACE");
  assert.ok(retrace, "directionDecision/decisionLabel 为 WATCH 时，最终操作 WAIT 也应报 RETRACE（位置由回踩确认把关）");
  assert.ok(retrace.score >= 60, `score ${retrace.score} 应达推送门槛`);
});

test("P0.5：最终操作 WAIT 且方向标签非 WATCH → 无机会", () => {
  const m5 = mkCandles([
    [100, 100, 100, 100],
    [101, 101, 101, 101],
    [102, 102, 102, 102],
    [101.5, 103, 101, 102],
    [101, 101.5, 100.8, 101],
  ]);
  const opps = scanOpportunities({
    symbol: "BTCUSDT",
    env: baseEnv({ price: 101, decision: "WAIT", decisionLabel: "WAIT" }),
    m5,
  });
  assert.deepEqual(opps, []);
});

test("环境过滤：4H bias NEUTRAL → 无机会", () => {
  const m5 = mkCandles([
    [100, 100, 100, 100],
    [101, 101, 101, 101],
    [102, 102, 102, 102],
    [101.5, 103, 101.5, 102],
    [101, 101.5, 100.8, 101],
  ]);
  const opps = scanOpportunities({ symbol: "BTCUSDT", env: baseEnv({ bias: "NEUTRAL", price: 101 }), m5 });
  assert.deepEqual(opps, []);
});

test("环境过滤：confidence LOW 且无 ICT Session → 评分不足不出机会（避免噪声）", () => {
  const m5 = mkCandles([
    [100, 100, 100, 100],
    [101, 101, 101, 101],
    [102, 102, 102, 102],
    [101.5, 103, 101.5, 102],
    [101, 101.5, 100.8, 101],
  ]);
  const env = baseEnv({ price: 101, confidence: "LOW", quality: "LOW", ictSession: null });
  const opps = scanOpportunities({ symbol: "BTCUSDT", env, m5 });
  assert.equal(opps.length, 0, "LOW 环境 + 弱信号不应报机会");
});

test("computeM5Context：5m 结构图景（swing 方向 + MSS/BOS 历史 + 执行区）", () => {
  const m5 = mkCandles([
    [100, 100, 100, 100],
    [100, 105, 100, 105],
    [104, 104, 98, 100],
    [100, 100, 99, 100],
    [100, 102, 99, 101],
    [98, 99, 97, 98],
    [100, 103, 100, 103], // MSS UP
  ]);
  const ctx = computeM5Context(m5, 103);
  assert.equal(ctx.direction, "BEARISH"); // HH→LL→LH→LL 为 BEARISH 结构（MSS 前）
  assert.ok(ctx.events.some((e) => e.type === "MSS" && e.direction === "UP"), "应检测到 MSS UP");
  assert.ok(Array.isArray(ctx.pd.fvg));
  assert.ok(Array.isArray(ctx.pd.ob));
});
