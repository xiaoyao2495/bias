/**
 * opportunity.test.js — 5m 机会扫描器（纯函数层）
 *
 * 覆盖 scanOpportunities 三类信号：
 *   RETRACE — 价格回踩同向 5m FVG
 *   BOS     — 最近 5m 收盘确认顺势突破
 *   CHAIN   — 扫损(SSL) → 5m MSS 向上 → 回踩多头 FVG（完整链条）
 * 环境过滤：NEUTRAL bias 不出机会。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { scanOpportunities, computeM5Context } from "../monitor/opportunity.js";

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
  session: { start: 20, end: 24, ratio: 20 },
  structureStatus: "VALID",
  sweep: null,
  ...over,
});

test("RETRACE：价格回踩同向 5m FVG → 出现回踩机会（顺位端为入场参考）", () => {
  // 三根 K 形成 bullish FVG [100,102]（idx0.high=100 < idx2.low=102），随后价格回踩到区间内
  const m5 = mkCandles([
    [100, 100, 100, 100], // idx0 FVG 起点，high=100
    [101, 101, 101, 101], // idx1 中间 K
    [102, 102, 102, 102], // idx2 low=102 > 100 → bullish FVG [100,102]
    [101.5, 103, 101, 102], // low=101 不形成新 FVG
    [101, 101.5, 100.8, 101], // 回踩到 FVG 内，price=101
  ]);
  const env = baseEnv({ price: 101 });
  const opps = scanOpportunities({ symbol: "BTCUSDT", env, m5 });
  const retrace = opps.find((o) => o.type === "RETRACE");
  assert.ok(retrace, "应出现 RETRACE 机会");
  assert.equal(retrace.direction, "BULLISH");
  assert.equal(retrace.entry, 100); // 多头顺位端 = FVG bottom
  assert.ok(retrace.score >= 60, `score ${retrace.score} 应达推送门槛`);
});

test("BOS：最近 5m 收盘确认向上突破 → 出现突破机会（NEUTRAL 结构首突也认）", () => {
  // idx1 形成 swing high 110，idx4 收盘 111 越过 → BOS UP（收盘确认）
  const m5 = mkCandles([
    [100, 100, 100, 100],
    [100, 110, 100, 110], // swing high 110（邻居 100 / 108）
    [105, 108, 105, 107],
    [106, 109, 106, 108],
    [108, 111, 108, 111], // close 111 > 110 → BOS UP
  ]);
  const env = baseEnv({ price: 111 });
  const opps = scanOpportunities({ symbol: "BTCUSDT", env, m5 });
  const bos = opps.find((o) => o.type === "BOS");
  assert.ok(bos, "应出现 BOS 机会");
  assert.equal(bos.direction, "BULLISH");
  assert.equal(bos.entry, 110); // 突破位 = 最近 swing high
  assert.ok(bos.score >= 60, `score ${bos.score} 应达推送门槛`);
});

test("CHAIN：SSL 扫损 → 5m MSS 向上 → 回踩多头 FVG（完整 ICT 链条）", () => {
  // 先 BEARISH 结构（HH→LL→LH→LL），idx6 收盘 103 突破 lastHigh 102 → MSS UP
  // 随后 idx7-9 形成 bullish FVG [101,102]，idx10 价格回踩到区间内
  const m5 = mkCandles([
    [100, 100, 100, 100],
    [100, 105, 100, 105], // swing high 105 → HH
    [104, 104, 98, 100], // swing low 98 → LL
    [100, 100, 99, 100], // low 99 > 98，确认 idx2 是 swing low
    [100, 102, 99, 101], // swing high 102 → LH（102 < 105）
    [98, 99, 97, 98], // swing low 97 → LL（97 < 98）
    [100, 103, 100, 103], // close 103 > lastHigh 102 → MSS UP（收盘确认）
    [101, 101, 100, 100], // FVG 起点 high=101
    [100, 100, 99, 99],
    [102, 102, 102, 102], // low=102 > 101 → bullish FVG [101,102]
    [101.5, 102, 101.5, 101.8], // 回踩到 FVG 内，price=101.8
  ]);
  const sweep = { side: "SSL", key: "t0_SSL", level: 99, sweptPrice: 97, close: 101.8, time: T0 };
  const env = baseEnv({ price: 101.8, sweep });
  const opps = scanOpportunities({ symbol: "BTCUSDT", env, m5 });
  const chain = opps.find((o) => o.type === "CHAIN");
  assert.ok(chain, "应出现 CHAIN 机会");
  assert.equal(chain.direction, "BULLISH");
  assert.ok(chain.zone && chain.zone.type === "FVG", "CHAIN 应带执行区");
  assert.ok(chain.trigger.includes("MSS"), `trigger 应含 MSS：${chain.trigger}`);
  assert.ok(chain.score >= 60, `score ${chain.score} 应达推送门槛`);
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

test("环境过滤：confidence LOW 且无活跃窗口 → 评分不足不出机会（避免噪声）", () => {
  const m5 = mkCandles([
    [100, 100, 100, 100],
    [101, 101, 101, 101],
    [102, 102, 102, 102],
    [101.5, 103, 101.5, 102],
    [101, 101.5, 100.8, 101],
  ]);
  const env = baseEnv({ price: 101, confidence: "LOW", quality: "LOW", session: null });
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
