import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildLiquiditySequences,
  LIQUIDITY_SEQUENCE_STATUS,
  liquidityEventConfirmedAt,
} from "../indicators/liquiditySequence.js";

const M5 = 5 * 60_000;
const H4 = 4 * 3600_000;
const RANGE = "DR_TEST";
const DAY = "2026-08-16";

const sweepIdentity = (item) => Object.assign(item, {
  originRangeId: item.originRangeId ?? item.rangeId ?? RANGE,
  rangeId: item.rangeId ?? RANGE,
  tradingDayId: item.tradingDayId ?? DAY,
});
const eventIdentity = (item) => Object.assign(item, {
  originRangeId: item.originRangeId ?? item.rangeId ?? RANGE,
  rangeId: item.rangeId ?? RANGE,
  tradingDayId: item.tradingDayId ?? DAY,
  displacementId: item.displacementId ?? (item.confirmedByDisplacement ? `DISP_${item.time}` : null),
});

function build(sweeps, events, opt = {}) {
  const callback = opt.confirmationZoneForMss;
  return buildLiquiditySequences({
    sweeps: sweeps.map(sweepIdentity),
    structureEvents: events.map(eventIdentity),
    timeframeMs: M5,
    maxBars: 12,
    ...opt,
    ...(callback ? { confirmationZoneForMss: (event, sequence) => {
      const fvg = callback(event, sequence);
      return fvg ? { ...fvg, originRangeId: event.originRangeId, rangeId: event.rangeId, tradingDayId: event.tradingDayId, displacementId: event.displacementId } : null;
    } } : {}),
  });
}

test("统一时间：closedTime 优先于 reclaimTime 和扫损 K 开盘时间", () => {
  assert.equal(liquidityEventConfirmedAt({ time: 1, reclaimTime: 2, closedTime: 3 }), 3);
  assert.equal(liquidityEventConfirmedAt({ time: 1, reclaimTime: 2 }), 2);
});

test("一条 MSS 只认领最近 raid，同确认时刻的多个池共享因果链", () => {
  const oldSweep = { tier: 2, side: "BSL", closedTime: 100, key: "old" };
  const recentA = { tier: 2, side: "BSL", closedTime: 200, key: "a" };
  const recentB = { tier: 2, side: "BSL", closedTime: 200, key: "b" };
  const mss = { type: "MSS", direction: "DOWN", confirmed: true, time: 300 };
  const { sequences, bySweep } = build([oldSweep, recentA, recentB], [mss]);

  assert.equal(bySweep.get(oldSweep).firstMss, null);
  assert.equal(bySweep.get(recentA), bySweep.get(recentB));
  assert.equal(bySweep.get(recentA).firstMss, mss);
  assert.equal(sequences.length, 2);
});

test("第一条普通结构收破锁定 raid，不跳过它选择后面的位移 MSS", () => {
  const sweep = { tier: 2, side: "SSL", closedTime: 100, key: "raid" };
  const ordinary = { type: "MSS", direction: "UP", confirmed: true, confirmedByDisplacement: false, time: 200 };
  const displaced = { type: "MSS", direction: "UP", confirmed: true, confirmedByDisplacement: true, time: 300 };
  const { sequences } = build([sweep], [ordinary, displaced], {
    confirmationZoneForMss: () => ({ type: "FVG" }),
  });

  assert.equal(sequences[0].firstMss, ordinary);
  assert.equal(sequences[0].status, LIQUIDITY_SEQUENCE_STATUS.STRUCTURE_BREAK);
  assert.equal(sequences[0].confirmationFvg, null);
});

test("只有第一条因果 MSS 带位移且存在精确 ICT FVG 才升级 ICT_CONFIRMED", () => {
  const sweep = { tier: 2, side: "SSL", closedTime: 100, key: "raid", sweptPrice: 90 };
  const mss = { type: "MSS", direction: "UP", confirmed: true, confirmedByDisplacement: true, time: 200 };
  const fvg = { type: "FVG", executable: true };
  const { sequences } = build([sweep], [mss], { confirmationZoneForMss: () => fvg });

  assert.equal(sequences[0].status, LIQUIDITY_SEQUENCE_STATUS.ICT_CONFIRMED);
  assert.equal(sequences[0].confirmationFvg.type, fvg.type);
  assert.equal(sequences[0].confirmationFvg.displacementId, mss.displacementId);
  assert.equal(sequences[0].sweptPrice, 90);
});

test("周期窗口按根数配置：5m 第12根允许、第13根拒绝；4H 第3根允许、第4根拒绝", () => {
  const sweep5 = { tier: 2, side: "SSL", closedTime: 1_000, key: "5m" };
  const at12 = { type: "MSS", direction: "UP", confirmed: true, time: 1_000 + 12 * M5 };
  assert.equal(build([sweep5], [at12]).sequences[0].firstMss, at12);
  const at13 = { ...at12, time: 1_000 + 13 * M5 };
  assert.equal(build([sweep5], [at13]).sequences[0].firstMss, null);

  const sweep4 = { tier: 2, side: "BSL", closedTime: 2_000, key: "4h" };
  const at3 = { type: "MSS", direction: "DOWN", confirmed: true, time: 2_000 + 3 * H4 };
  const at4 = { ...at3, time: 2_000 + 4 * H4 };
  assert.equal(buildLiquiditySequences({ sweeps: [sweepIdentity(sweep4)], structureEvents: [eventIdentity(at3)], timeframeMs: H4, maxBars: 3 }).sequences[0].firstMss.time, at3.time);
  assert.equal(buildLiquiditySequences({ sweeps: [sweepIdentity(sweep4)], structureEvents: [eventIdentity(at4)], timeframeMs: H4, maxBars: 3 }).sequences[0].firstMss, null);
});

test("MSS 在 raid 确认前或方向相反时不得匹配，L1 不进入因果链", () => {
  const raid = { tier: 2, side: "SSL", closedTime: 500, key: "raid" };
  const l1 = { tier: 1, side: "SSL", closedTime: 500, key: "l1", reclaimed: false };
  const before = { type: "MSS", direction: "UP", confirmed: true, time: 499 };
  const opposite = { type: "MSS", direction: "DOWN", confirmed: true, time: 600 };
  const { sequences, bySweep } = build([raid, l1], [before, opposite]);
  assert.equal(sequences.length, 1);
  assert.equal(sequences[0].firstMss, null);
  assert.equal(bySweep.has(l1), false);
});

test("rangeId 隔离：旧 Range raid 不得与新 Range MSS 拼接", () => {
  const oldRaid = { tier: 2, side: "SSL", closedTime: 100, key: "old", rangeId: "DR_OLD" };
  const newEvent = { type: "MSS", direction: "UP", confirmed: true, confirmedByDisplacement: true, time: 200, rangeId: "DR_NEW" };
  const mismatch = build([oldRaid], [newEvent]);
  assert.equal(mismatch.sequences[0].firstMss, null);

  const matchingEvent = { ...newEvent, rangeId: "DR_OLD", originRangeId: "DR_OLD" };
  const matching = build([oldRaid], [matchingEvent]);
  assert.equal(matching.sequences[0].firstMss, matchingEvent);
  assert.equal(matching.sequences[0].rangeId, "DR_OLD");
});

test("严格身份：缺少 Range/交易日不能作为通配符，跨交易日也不得拼接", () => {
  const raid = { tier: 2, side: "SSL", closedTime: 100, key: "raid" };
  const mss = { type: "MSS", direction: "UP", confirmed: true, time: 200 };
  const missing = buildLiquiditySequences({ sweeps: [raid], structureEvents: [mss], timeframeMs: M5, maxBars: 12 });
  assert.equal(missing.sequences[0].firstMss, null);

  const crossDay = buildLiquiditySequences({
    sweeps: [sweepIdentity(raid)],
    structureEvents: [eventIdentity({ ...mss, tradingDayId: "2026-08-17" })],
    timeframeMs: M5,
    maxBars: 12,
  });
  assert.equal(crossDay.sequences[0].firstMss, null);
});
