import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeBias } from "../engine/analyzeBias.js";
import { analyzeReplayPoint, buildReplayInput, sliceClosedWindow } from "../engine/replayPipeline.js";
import { resolveInstrumentProfile } from "../indicators/instrumentProfile.js";
import { scanHistory } from "../scanner/historicalScanner.js";

const M5 = 5 * 60_000;
const H1 = 60 * 60_000;
const H4 = 4 * H1;

function candle(time, duration, base, extra = {}) {
  return {
    time,
    closeTime: time + duration,
    open: base,
    high: base + 2,
    low: base - 2,
    close: base + 0.5,
    volume: 1,
    quoteVol: 100,
    ...extra,
  };
}

function baseHistory(start = Date.UTC(2026, 7, 1)) {
  const h4 = Array.from({ length: 100 }, (_, i) => candle(start + i * H4, H4, 100 + Math.sin(i / 2) * 10));
  const m5 = Array.from({ length: 100 * 48 }, (_, i) => candle(start + i * M5, M5, 100 + Math.sin(i / 20) * 3));
  const h1 = Array.from({ length: 100 * 4 }, (_, i) => candle(start + i * H1, H1, 100 + Math.sin(i / 4) * 5));
  const daily = Array.from({ length: 20 }, (_, i) => candle(start + i * 24 * H1, 24 * H1, 100 + i));
  const weekly = Array.from({ length: 4 }, (_, i) => candle(start + i * 7 * 24 * H1, 7 * 24 * H1, 100 + i * 5));
  return { h4, m5, h1, daily, weekly };
}

function usSession(startUtc, base, count = 78) {
  return Array.from({ length: count }, (_, i) => candle(startUtc + i * M5, M5, base + i * 0.01));
}

test("sliceClosedWindow：二分截断只返回 cutoff 前已收盘 K，并执行尾部窗口限制", () => {
  const rows = Array.from({ length: 10 }, (_, i) => candle(i * 1000, 1000, i));
  const sliced = sliceClosedWindow(rows, 6500, 3);
  assert.deepEqual(sliced.map((x) => x.closeTime), [4000, 5000, 6000]);
});

test("统一 cutoff：价格取最后已收盘 5m，结构价取最后已收盘 4H，未来 K 全部排除", () => {
  const history = baseHistory();
  const cutoff = history.h4[70].closeTime + 2 * M5;
  const prepared = buildReplayInput({ symbol: "BTCUSDT", cutoff, history });
  assert.equal(prepared.input.candles.at(-1).closeTime, history.h4[70].closeTime);
  assert.equal(prepared.structurePrice, history.h4[70].close);
  assert.equal(prepared.price, prepared.input.m5.at(-1).close);
  assert.ok(prepared.input.m5.every((k) => k.closeTime <= prepared.analysisTime));
  assert.ok(prepared.input.h1.every((k) => k.closeTime <= prepared.analysisTime));
  assert.ok(prepared.input.daily.every((k) => k.closeTime <= prepared.analysisTime));
  assert.ok(prepared.input.weekly.every((k) => k.closeTime <= prepared.analysisTime));
});

test("未来函数不变量：cutoff 后加入任意极值 K，不改变回放分析结果", () => {
  const history = baseHistory();
  const cutoff = history.h4[70].closeTime;
  const before = analyzeReplayPoint({ symbol: "BTCUSDT", cutoff, history });
  const poisonFuture = (rows) => rows.map((k) => k.closeTime > cutoff
    ? { ...k, open: 999_999, high: 1_000_001, low: 999_998, close: 1_000_000 }
    : k);
  const future = {
    h4: poisonFuture(history.h4),
    m5: poisonFuture(history.m5),
    h1: poisonFuture(history.h1),
    daily: poisonFuture(history.daily),
    weekly: poisonFuture(history.weekly),
  };
  const after = analyzeReplayPoint({ symbol: "BTCUSDT", cutoff, history: future });
  assert.deepEqual(after.result.structure, before.result.structure);
  assert.deepEqual(after.result.liquidity, before.result.liquidity);
  assert.deepEqual(after.result.bias, before.result.bias);
});

test("股票回放使用现金时段 PDH，不使用永续原生 24h 日线极值", () => {
  const profile = resolveInstrumentProfile("MUUSDT");
  const base = baseHistory(Date.UTC(2026, 6, 20));
  const monday = usSession(Date.UTC(2026, 7, 3, 13, 30), 100);
  const tuesday = usSession(Date.UTC(2026, 7, 4, 13, 30), 110);
  const wednesday = usSession(Date.UTC(2026, 7, 5, 13, 30), 120, 6);
  const cutoff = wednesday.at(-1).closeTime;
  const history = {
    ...base,
    m5: [...monday, ...tuesday, ...wednesday],
    daily: [{ time: Date.UTC(2026, 7, 4), closeTime: Date.UTC(2026, 7, 5), open: 100, high: 999, low: 1, close: 100 }],
    weekly: [],
  };
  const point = analyzeReplayPoint({ symbol: "MUUSDT", cutoff, history, instrumentProfile: profile });
  const pdh = point.result.liquidity.buySide.find((x) => x.type === "PDH");
  assert.equal(point.result.liquidity.htfLiquiditySource, "REGULAR_SESSION");
  assert.ok(pdh);
  assert.notEqual(pdh.price, 999);
  assert.equal(pdh.source, "REGULAR_SESSION");
  assert.equal(point.marketDayId, "2026-08-05");
});

test("实盘/回放共用输入不变量：同一 prepared input 的核心输出完全一致", () => {
  const history = baseHistory();
  const cutoff = history.h4[80].closeTime;
  const prepared = buildReplayInput({ symbol: "BTCUSDT", cutoff, history });
  const direct = analyzeBias(prepared.input);
  const replay = analyzeReplayPoint({ symbol: "BTCUSDT", cutoff, history }).result;
  assert.deepEqual(replay, direct);
});

test("Case Replay 冷启动重建与持久化 priorRange 恢复结果一致", () => {
  const history = baseHistory(Date.UTC(2026, 6, 1));
  const cutoff = history.h4[80].closeTime;
  const cold = analyzeReplayPoint({ symbol: "BTCUSDT", cutoff, history });
  const restored = analyzeReplayPoint({
    symbol: "BTCUSDT",
    cutoff,
    history,
    priorRange: cold.priorRange,
    rebuildRangeState: false,
  });
  assert.deepEqual(restored.result.location, cold.result.location);
  assert.deepEqual(restored.result.rangeTransition, cold.result.rangeTransition);
  assert.deepEqual(restored.result.bias, cold.result.bias);
});

test("Historical Scanner 注入市场画像并保存市场日、ICT 日和 HTF 来源", async () => {
  const history = baseHistory();
  const profile = resolveInstrumentProfile("BTCUSDT");
  const startTime = history.h4[70].time;
  const endTime = history.h4[90].closeTime;
  const { samples, meta } = await scanHistory({
    symbol: "BTCUSDT",
    startTime,
    endTime,
    step: 6,
    windows: [1],
    history: { ...history, instrumentProfile: profile },
    instrumentProfile: profile,
  });
  assert.ok(samples.length > 0);
  assert.equal(meta.sessionModel, "CRYPTO_24X7");
  assert.equal(meta.htfLiquiditySource, "EXCHANGE_UTC");
  assert.ok(samples.every((s) => s.marketDayId && s.ictTradingDayId));
  assert.ok(samples.every((s) => s.htfLiquiditySource === "EXCHANGE_UTC"));
});

test("Historical Scanner 的 step 只影响抽样，不影响逐根推进的 Range 状态", async () => {
  const history = baseHistory(Date.UTC(2026, 6, 1));
  const profile = resolveInstrumentProfile("BTCUSDT");
  const options = {
    symbol: "BTCUSDT",
    startTime: history.h4[80].time,
    endTime: history.h4[96].closeTime,
    windows: [1],
    history: { ...history, instrumentProfile: profile },
    instrumentProfile: profile,
  };
  const everyBar = await scanHistory({ ...options, step: 1 });
  const sparse = await scanHistory({ ...options, step: 6 });
  const byTime = new Map(everyBar.samples.map((sample) => [sample.time, sample]));

  assert.ok(sparse.samples.length > 0);
  for (const sample of sparse.samples) {
    const dense = byTime.get(sample.time);
    assert.ok(dense, `缺少逐根样本 ${sample.time}`);
    assert.equal(sample.rangeId, dense.rangeId);
    assert.equal(sample.rangeVersion, dense.rangeVersion);
    assert.equal(sample.rangeStatus, dense.rangeStatus);
    assert.equal(sample.rangeTransition, dense.rangeTransition);
  }
});
