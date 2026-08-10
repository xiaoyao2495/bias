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
    [102.6, 102.8, 102.6, 102.6], // 回踩到位移腿 FVG [102,103] 内，price=102.6
  ]);
  const sweep = { side: "SSL", key: "t0_SSL", level: 99, sweptPrice: 97, close: 102.6, time: T0 };
  const env = baseEnv({ price: 102.6, sweep });
  const opps = scanOpportunities({ symbol: "BTCUSDT", env, m5 });
  const chain = opps.find((o) => o.type === "CHAIN");
  assert.ok(chain, "应出现 CHAIN 机会");
  assert.equal(chain.direction, "BULLISH");
  assert.ok(chain.zone && chain.zone.type === "FVG", "CHAIN 应带执行区");
  assert.equal(chain.zone.index, 21, "CHAIN 执行区应精确对应位移腿 FVG（index=21）");
  assert.ok(chain.trigger.includes("MSS"), `trigger 应含 MSS：${chain.trigger}`);
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
    [102.6, 102.8, 102.6, 102.6], // 回踩到位移腿 FVG [102,103] 内，price=102.6
  ]);
  const sweep = { side: "SSL", key: "t0_SSL", level: 99, sweptPrice: 97, close: 102.6, time: T0 };
  const env = baseEnv({ price: 102.6, sweep });
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
    [101.5, 102, 101.5, 101.8], // 回踩到旧 FVG [101,102] 内，price=101.8
  ]);
  const sweep = { side: "SSL", key: "t0_SSL", level: 99, sweptPrice: 97, close: 101.8, time: T0 };
  const env = baseEnv({ price: 101.8, sweep });
  const opps = scanOpportunities({ symbol: "BTCUSDT", env, m5 });
  assert.ok(!opps.find((o) => o.type === "CHAIN"), "旧 FVG 不得拼成完整 CHAIN");
  assert.ok(opps.find((o) => o.type === "RETRACE"), "普通回踩机会不受影响");
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
