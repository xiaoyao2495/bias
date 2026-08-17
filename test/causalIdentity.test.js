import { test } from "node:test";
import assert from "node:assert/strict";
import {
  bindStructureEventIdentity,
  rangeForEvent,
  sameCausalIdentity,
} from "../indicators/causalIdentity.js";
import { annotateFvgQuality, annotatePDArray, findFvgs, rankPDArray } from "../indicators/pdArray.js";
import { detectSweepEvents } from "../indicators/sweep.js";

const H4 = 4 * 3600_000;
const T0 = Date.UTC(2026, 7, 16);

function candle(i, { low = 105, high = 110, close = 108 } = {}) {
  return { time: T0 + i * H4, closeTime: T0 + (i + 1) * H4 - 1, open: 107, high, low, close };
}

const oldRange = {
  rangeId: "DR_OLD", version: 2, lifecycleStatus: "ACTIVE",
  lowIndex: 1, highIndex: 4, lowTime: candle(1).time, highTime: candle(4).time,
  confirmedAt: candle(6).closeTime, selectedAt: candle(6).closeTime,
};
const newRange = {
  rangeId: "DR_NEW", version: 3, lifecycleStatus: "ACTIVE",
  lowIndex: 7, highIndex: 10, lowTime: candle(7).time, highTime: candle(10).time,
  confirmedAt: candle(12).closeTime, selectedAt: candle(12).closeTime,
};

test("不可变身份：已绑定旧 Range 的事件不会被当前新 Range 改名", () => {
  const event = { type: "MSS", direction: "UP", confirmed: true, time: candle(8).closeTime, displacementIndex: 8, originRangeId: "DR_OLD", rangeId: "DR_OLD" };
  const bound = bindStructureEventIdentity(event, { candles: Array.from({ length: 14 }, (_, i) => candle(i)), currentRange: newRange, priorRange: oldRange, timeframe: "4h" });
  assert.equal(bound.originRangeId, "DR_OLD");
  assert.equal(bound.rangeId, "DR_OLD");
});

test("来源区间：只有自身 origin leg 或激活后的事件可绑定，早于新区间的旧事件保持未绑定", () => {
  const inLeg = { time: candle(8).closeTime, displacementIndex: 8 };
  assert.equal(rangeForEvent(inLeg, { currentRange: newRange })?.rangeId, "DR_NEW");
  const historical = { time: candle(3).closeTime, displacementIndex: 3 };
  assert.equal(rangeForEvent(historical, { currentRange: newRange }), null);
});

test("稳定事件/位移 ID 不依赖滚动窗口 index", () => {
  const rows = Array.from({ length: 8 }, (_, i) => candle(i));
  const first = bindStructureEventIdentity({ type: "MSS", direction: "UP", confirmed: true, level: 109, time: rows[5].closeTime, displacementIndex: 5 }, { candles: rows, currentRange: oldRange, timeframe: "4h" });
  const shifted = bindStructureEventIdentity({ type: "MSS", direction: "UP", confirmed: true, level: 109, time: rows[5].closeTime, displacementIndex: 4 }, { candles: rows.slice(1), currentRange: oldRange, timeframe: "4h" });
  assert.equal(first.id, shifted.id);
  assert.equal(first.displacementId, shifted.displacementId);
});

test("严格因果相等：缺身份、跨交易日、错位移均不得匹配", () => {
  const base = { originRangeId: "DR_A", tradingDayId: "2026-08-16", displacementId: "D1" };
  assert.equal(sameCausalIdentity(base, { ...base }), true);
  assert.equal(sameCausalIdentity({}, base), false);
  assert.equal(sameCausalIdentity(base, { ...base, tradingDayId: "2026-08-17" }), false);
  assert.equal(sameCausalIdentity(base, { ...base, displacementId: "D2" }, { requireDisplacement: true }), false);
});

test("Sweep 不得被后来激活的 Range 追溯改名", () => {
  const rows = [
    { time: T0, closeTime: T0 + 299_999, open: 104, high: 104, low: 103, close: 103.5 },
    { time: T0 + 300_000, closeTime: T0 + 599_999, open: 104, high: 106, low: 103, close: 104 },
  ];
  const before = detectSweepEvents(rows, [{ type: "PDH", price: 105, rangeId: "DR_LATE", rangeActiveFrom: T0 + 900_000 }], [], null)[0];
  assert.equal(before.originRangeId, undefined);
  const active = detectSweepEvents(rows, [{ type: "PDH", price: 105, rangeId: "DR_ACTIVE", rangeActiveFrom: T0 }], [], null)[0];
  assert.equal(active.originRangeId, "DR_ACTIVE");
  // 方案B：key 只含 扫损K+侧+价位+stage，不含 range/type——Range 是否激活、何时激活都不改变 key
  assert.match(before.key, /_105_RECLAIMED_RAID$/);
  assert.equal(active.key, before.key);
});

test("FVG 生命周期时间戳单向记录 first touch → CE → fill", () => {
  const rows = [
    candle(0, { low: 98, high: 100, close: 99 }),
    candle(1, { low: 101, high: 102, close: 101.5 }),
    candle(2, { low: 104, high: 105, close: 104.5 }),
    candle(3, { low: 103, high: 106, close: 104 }),
    candle(4, { low: 101.5, high: 104, close: 103 }),
    candle(5, { low: 99.5, high: 103, close: 102 }),
  ];
  const fvg = { type: "BULLISH_FVG", direction: "BULLISH", bottom: 100, top: 104, index: 2, originRangeId: "DR_A", rangeId: "DR_A", executable: true };
  const out = annotatePDArray({ fvg: [fvg], ob: [] }, { rangeId: "DR_A", equilibrium: 110 }, rows, { requireRangeIdentity: true }).fvg[0];
  assert.equal(out.firstTouchAt, rows[3].closeTime);
  assert.equal(out.ceReachedAt, rows[4].closeTime);
  assert.equal(out.filledAt, rows[5].closeTime);
  assert.equal(out.status, "FILLED");
});

test("当前 Range 只执行同源 PD Array；旧源和无源对象均不可排名", () => {
  const range = { rangeId: "DR_CURRENT", equilibrium: 110, low: 90, high: 130 };
  const rows = [candle(0), candle(1), candle(2)];
  const item = { type: "BULLISH_FVG", direction: "BULLISH", bottom: 100, top: 104, index: 2, executable: true, originRangeId: "DR_OLD", rangeId: "DR_OLD" };
  const stale = annotatePDArray({ fvg: [item], ob: [] }, range, rows, { requireRangeIdentity: true }).fvg[0];
  assert.equal(stale.provenanceStatus, "STALE_RANGE");
  assert.equal(stale.executable, false);
  assert.equal(rankPDArray({ bias: "BULLISH", range, pdArray: { fvg: [stale], ob: [] } }).primary, null);
});

test("RAW FVG 在形成时冻结 ACTIVE Range 身份，不再被严格执行层误删", () => {
  const rows = [
    candle(0, { high: 100, low: 98, close: 99 }),
    candle(1, { high: 103, low: 101, close: 102 }),
    candle(2, { high: 106, low: 104, close: 105 }),
  ];
  const range = { ...oldRange, selectedAt: rows[0].closeTime, confirmedAt: rows[0].closeTime };
  const raw = annotatePDArray({ fvg: findFvgs(rows), ob: [] }, range, rows).fvg;
  const identified = annotateFvgQuality(raw, rows, { currentRange: range, timeframe: "4h" });
  const strict = annotatePDArray({ fvg: identified, ob: [] }, range, rows, { requireRangeIdentity: true }).fvg[0];
  assert.equal(strict.quality, "RAW");
  assert.equal(strict.originRangeId, range.rangeId);
  assert.notEqual(strict.rejectionReason, "RANGE_IDENTITY_MISMATCH");
});

test("Range 激活前形成的 RAW FVG 保持未绑定，不能被当前 Range 追溯改名", () => {
  const rows = [
    candle(0, { high: 100, low: 98, close: 99 }),
    candle(1, { high: 103, low: 101, close: 102 }),
    candle(2, { high: 106, low: 104, close: 105 }),
  ];
  const laterRange = { ...oldRange, selectedAt: candle(4).closeTime, confirmedAt: candle(4).closeTime };
  const raw = annotatePDArray({ fvg: findFvgs(rows), ob: [] }, laterRange, rows).fvg;
  const identified = annotateFvgQuality(raw, rows, { currentRange: laterRange, timeframe: "4h" });
  assert.equal(identified[0].originRangeId, null);
});

test("随机前缀回放：FVG 状态只允许向前升级，首次时间戳不得漂移", () => {
  const rank = { OPEN: 0, TOUCHED: 1, CE_REACHED: 2, FILLED: 3 };
  let seed = 0x20220816;
  const random = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const rows = [candle(0), candle(1), candle(2)];
  const fvg = { type: "BULLISH_FVG", direction: "BULLISH", bottom: 100, top: 104, index: 2 };
  let priorRank = 0;
  let firstTouch = null;
  for (let i = 3; i < 503; i++) {
    const low = 98 + random() * 10;
    rows.push(candle(i, { low, high: low + 3, close: low + 2 }));
    const state = annotatePDArray({ fvg: [fvg], ob: [] }, null, rows).fvg[0];
    assert.ok(rank[state.status] >= priorRank);
    priorRank = rank[state.status];
    if (firstTouch == null && state.firstTouchAt != null) firstTouch = state.firstTouchAt;
    if (firstTouch != null) assert.equal(state.firstTouchAt, firstTouch);
  }
});
