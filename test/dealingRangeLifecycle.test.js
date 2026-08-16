import { test } from "node:test";
import assert from "node:assert/strict";
import {
  dealingRangeId,
  isConfirmedImpulseCandidate,
  rebuildDealingRangeLifecycle,
  resolveDealingRangeLifecycle,
} from "../indicators/dealingRangeLifecycle.js";
import { rangeForEvent } from "../indicators/causalIdentity.js";

const H4 = 4 * 3600_000;
const T0 = Date.now() - 20 * H4;
const candles = Array.from({ length: 12 }, (_, i) => ({
  time: T0 + i * H4,
  closeTime: T0 + (i + 1) * H4,
  open: 110,
  high: 115,
  low: 105,
  close: 110,
}));

function candidate({ low = 100, high = 120, lowIndex = 1, highIndex = 3, type = "IMPULSE_BULLISH" } = {}) {
  return {
    low,
    high,
    lowIndex,
    highIndex,
    lowTime: candles[lowIndex].time,
    highTime: candles[highIndex].time,
    rangeType: type,
    startReason: "test start",
    endReason: "test end",
  };
}

function lifecycleCandles(count = 72) {
  const start = Date.now() - (count + 4) * H4;
  return Array.from({ length: count }, (_, i) => {
    const close = 100 + Math.sin(i * Math.PI / 6) * 10 + i * 0.35;
    const open = close - 0.2;
    return {
      time: start + i * H4,
      closeTime: start + (i + 1) * H4,
      open,
      high: close + 0.8,
      low: open - 0.8,
      close,
    };
  });
}

test("Range ID 使用端点时间和价格，滚动窗口 index 改变后身份不漂移", () => {
  const a = candidate();
  const shifted = { ...a, lowIndex: 51, highIndex: 53 };
  assert.equal(dealingRangeId(a), dealingRangeId(shifted));
});

test("首次初始化后，相同 Range 恢复 selectedAt/version 并重绑当前窗口 index", () => {
  const first = resolveDealingRangeLifecycle({ candidate: candidate(), candles, price: 110, selectedAt: T0 + 8 * H4 });
  assert.equal(first.transition.reason, "INITIAL_RANGE");
  assert.equal(first.range.confirmedAt, T0 + 6 * H4);
  assert.equal(first.range.selectedAt, first.range.confirmedAt, "生效时间应由 K 线确认，而非 8H 的轮询时间");
  const shiftedCandles = candles.slice(1);
  const sameCandidate = { ...candidate(), lowIndex: 0, highIndex: 2 };
  const restored = resolveDealingRangeLifecycle({
    candidate: sameCandidate,
    prior: first.range,
    candles: shiftedCandles,
    price: 111,
    confirmedClose: 111,
    selectedAt: T0 + 9 * H4,
  });
  assert.equal(restored.transition.reason, "SAME_RANGE");
  assert.equal(restored.range.rangeId, first.range.rangeId);
  assert.equal(restored.range.selectedAt, first.range.selectedAt);
  assert.equal(restored.range.lowIndex, 0);
  assert.equal(restored.range.highIndex, 2);
});

test("冷启动晚于 Range 确认时，确认后且轮询前的事件仍属于该 Range", () => {
  const out = resolveDealingRangeLifecycle({
    candidate: candidate(), candles, price: 110, selectedAt: T0 + 10 * H4,
  });
  const event = { time: T0 + 7 * H4 };
  assert.equal(rangeForEvent(event, { currentRange: out.range, allowOriginLeg: false })?.rangeId, out.range.rangeId);
});

test("未由 displacement 结构事件确认的新候选不得替换 ACTIVE Range", () => {
  const prior = resolveDealingRangeLifecycle({ candidate: candidate(), candles, price: 110, selectedAt: T0 + 6 * H4 }).range;
  const drifted = candidate({ low: 105, high: 125, lowIndex: 4, highIndex: 7 });
  const out = resolveDealingRangeLifecycle({
    candidate: drifted,
    prior,
    candles,
    price: 118,
    confirmedClose: 118,
    selectedAt: T0 + 11 * H4,
  });
  assert.equal(out.range.rangeId, prior.rangeId);
  assert.equal(out.transition.reason, "CANDIDATE_NOT_DISPLACEMENT_CONFIRMED");
  assert.equal(out.transition.rejectedCandidateId, dealingRangeId(drifted));
});

test("RECENT 只保留观察候选，不获得 rangeId 或交易位置", () => {
  const recent = candidate({ type: "RECENT" });
  const out = resolveDealingRangeLifecycle({ candidate: recent, candles, price: 110, selectedAt: T0 + 8 * H4 });
  assert.equal(out.range.rangeType, "RECENT");
  assert.equal(out.range.rangeId, null);
  assert.equal(out.range.lifecycleStatus, "OBSERVATION");
  assert.equal(out.range.tradable, false);
  assert.equal(out.range.location, "UNKNOWN");
  assert.equal(out.transition.reason, "RECENT_OBSERVATION_ONLY");
});

test("升级迁移：旧 state 中误持久化的 RECENT Range 会被丢弃", () => {
  const recent = candidate({ type: "RECENT" });
  const legacy = { ...recent, rangeId: "DR_LEGACY_RECENT", lifecycleStatus: "ACTIVE", version: 9 };
  const out = resolveDealingRangeLifecycle({ candidate: recent, prior: legacy, candles, price: 110 });
  assert.equal(out.range.rangeId, null);
  assert.equal(out.range.lifecycleStatus, "OBSERVATION");
  assert.equal(out.transition.discardedLegacyRangeId, "DR_LEGACY_RECENT");
});

test("RECENT 候选不能替换已有推动区间", () => {
  const prior = resolveDealingRangeLifecycle({ candidate: candidate(), candles, price: 110 }).range;
  const out = resolveDealingRangeLifecycle({
    candidate: candidate({ low: 106, high: 119, lowIndex: 5, highIndex: 8, type: "RECENT" }),
    prior,
    candles,
    price: 112,
    confirmedClose: 112,
  });
  assert.equal(out.range.rangeId, prior.rangeId);
  assert.equal(out.range.rangeType, "IMPULSE_BULLISH");
  assert.equal(out.transition.reason, "RECENT_CANDIDATE_IGNORED");
});

test("新扩张只有在候选腿内存在同方向 displacement 结构事件时切换", () => {
  const prior = resolveDealingRangeLifecycle({ candidate: candidate(), candles, price: 110, selectedAt: T0 + 6 * H4 }).range;
  const expansion = candidate({ low: 105, high: 130, lowIndex: 4, highIndex: 8 });
  const event = { type: "BOS", direction: "UP", confirmed: true, confirmedByDisplacement: true, displacementIndex: 7 };
  assert.equal(isConfirmedImpulseCandidate(expansion, [event]), true);
  const out = resolveDealingRangeLifecycle({
    candidate: expansion,
    prior,
    candles,
    structureEvents: [event],
    price: 125,
    confirmedClose: 125,
    selectedAt: T0 + 12 * H4,
  });
  assert.equal(out.transition.reason, "CONFIRMED_EXPANSION");
  assert.equal(out.range.previousRangeId, prior.rangeId);
  assert.equal(out.range.version, 2);
  assert.notEqual(out.range.rangeId, prior.rangeId);
});

test("旧区间失效后必须等待位移确认的新候选，普通候选不能接管", () => {
  const prior = resolveDealingRangeLifecycle({ candidate: candidate(), candles, price: 110, selectedAt: T0 + 6 * H4 }).range;
  const waiting = resolveDealingRangeLifecycle({
    candidate: candidate(), prior, candles, price: 98, confirmedClose: 98, selectedAt: T0 + 10 * H4,
  });
  assert.equal(waiting.range.rangeId, prior.rangeId);
  assert.equal(waiting.range.lifecycleStatus, "INVALIDATED");
  assert.equal(waiting.transition.reason, "RANGE_INVALIDATED_WAITING_REPLACEMENT");

  const replacement = candidate({ low: 90, high: 115, lowIndex: 5, highIndex: 9, type: "IMPULSE_BEARISH" });
  const unconfirmed = resolveDealingRangeLifecycle({
    candidate: replacement,
    prior: waiting.range,
    candles,
    price: 95,
    confirmedClose: 95,
    selectedAt: T0 + 12 * H4,
  });
  assert.equal(unconfirmed.range.rangeId, prior.rangeId);
  assert.equal(unconfirmed.range.lifecycleStatus, "INVALIDATED");
  assert.equal(unconfirmed.transition.reason, "RANGE_INVALIDATED_WAITING_CONFIRMED_REPLACEMENT");

  const event = { type: "MSS", direction: "DOWN", confirmed: true, confirmedByDisplacement: true, displacementIndex: 8 };
  const switched = resolveDealingRangeLifecycle({
    candidate: replacement,
    prior: unconfirmed.range,
    candles,
    structureEvents: [event],
    price: 95,
    confirmedClose: 95,
    selectedAt: T0 + 12 * H4,
  });
  assert.equal(switched.transition.reason, "PRIOR_INVALIDATED_CONFIRMED_REPLACEMENT");
  assert.equal(switched.range.lifecycleStatus, "ACTIVE");
  assert.equal(switched.range.previousRangeId, prior.rangeId);
});

test("逐根冷重建与中途持久化恢复得到相同 Range 状态", () => {
  const rows = lifecycleCandles();
  const split = 39;
  const full = rebuildDealingRangeLifecycle({ candles: rows });
  const first = rebuildDealingRangeLifecycle({ candles: rows, endIndex: split });
  const resumed = rebuildDealingRangeLifecycle({
    candles: rows,
    startIndex: split + 1,
    initialRange: first.range,
  });

  assert.ok(full.range?.rangeId);
  assert.ok(first.range?.rangeId);
  assert.equal(resumed.range.rangeId, full.range.rangeId);
  assert.equal(resumed.range.version, full.range.version);
  assert.equal(resumed.range.lifecycleStatus, full.range.lifecycleStatus);
  assert.equal(resumed.range.selectedAt, full.range.selectedAt);
});
