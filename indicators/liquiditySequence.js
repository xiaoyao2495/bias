/**
 * liquiditySequence.js — 统一 Sweep/Raid → MSS → Displacement/FVG 因果链。
 *
 * 统一的是匹配算法，时间窗口由调用周期传入：5m 当前使用 12 根，4H 使用 3 根。
 * 每条 MSS 只能认领它之前最近的一组同向 raid；同一确认时刻、同侧的多个流动性池
 * 属于同一 raid leg，可以共享一条 MSS。
 *
 * 关键约束：第一条方向匹配的 MSS 会锁定 raid。若它没有位移确认，后续更漂亮的位移
 * MSS 也不能回头升级该 raid，避免事后挑选证据拼接因果链。
 */

export const LIQUIDITY_SEQUENCE_STATUS = Object.freeze({
  RAID: "RAID",
  STRUCTURE_BREAK: "STRUCTURE_BREAK",
  DISPLACEMENT_CONFIRMED: "DISPLACEMENT_CONFIRMED",
  ICT_CONFIRMED: "ICT_CONFIRMED",
});

export const LIQUIDITY_SEQUENCE_POLICIES = Object.freeze({
  "5m": Object.freeze({ timeframeMs: 5 * 60_000, maxBars: 12 }),
  "4h": Object.freeze({ timeframeMs: 4 * 3600_000, maxBars: 3 }),
});

import { causalRangeId, sameCausalIdentity } from "./causalIdentity.js";

/** Raid 只有在收回/收盘确认后才开始等待 MSS。 */
export function liquidityEventConfirmedAt(sweep) {
  return sweep?.closedTime ?? sweep?.reclaimTime ?? sweep?.time ?? null;
}

function expectedDirectionForSide(side) {
  if (side === "SSL") return "UP";
  if (side === "BSL") return "DOWN";
  return null;
}

function stableSweepKey(sweep) {
  return sweep?.baseKey || sweep?.key || `${sweep?.type || "LEVEL"}_${sweep?.level ?? "-"}`;
}

function sequenceId(side, confirmedAt, sweeps, rangeId, tradingDayId) {
  const keys = sweeps.map(stableSweepKey).sort().join("+");
  return `LIQSEQ_${tradingDayId || "NO_DAY"}_${rangeId || "NO_RANGE"}_${side}_${confirmedAt}_${keys}`;
}

function raidExtreme(side, sweeps) {
  const prices = sweeps.map((s) => Number(s?.sweptPrice)).filter(Number.isFinite);
  if (!prices.length) return null;
  return side === "SSL" ? Math.min(...prices) : Math.max(...prices);
}

/**
 * 构建不可跳跃、不可复用的流动性因果链。
 *
 * @param {Object} p
 * @param {Array} p.sweeps L2+ raid；L1（tier < 2 / reclaimed=false）会被排除
 * @param {Array} p.structureEvents scanStructureEvents 输出
 * @param {number} p.timeframeMs 周期毫秒数
 * @param {number} p.maxBars 最大因果距离（根数）
 * @param {(event:Object, sequence:Object)=>Object|null} [p.confirmationZoneForMss]
 *   可选：精确返回该 MSS 位移腿当前仍具 ICT 有效性的 FVG。存在时状态升级为 ICT_CONFIRMED。
 *   ATR/tick 等交易执行门槛不得在此否定课程因果链。
 * @returns {{sequences:Array, bySweep:Map}}
 */
export function buildLiquiditySequences({
  sweeps = [],
  structureEvents = [],
  timeframeMs,
  maxBars,
  confirmationZoneForMss = null,
} = {}) {
  const frame = Number(timeframeMs);
  const bars = Number(maxBars);
  if (!(frame > 0) || !(bars >= 0)) throw new TypeError("timeframeMs and maxBars must be valid numbers");
  const maxDelayMs = frame * bars;

  const groups = [];
  for (const sweep of sweeps || []) {
    if (sweep?.reclaimed === false || (sweep?.tier ?? 2) < 2) continue;
    const confirmedAt = Number(liquidityEventConfirmedAt(sweep));
    if (!Number.isFinite(confirmedAt)) continue;
    const rangeId = causalRangeId(sweep);
    const tradingDayId = sweep.tradingDayId ?? null;
    let group = groups.find((item) => item.side === sweep.side && item.confirmedAt === confirmedAt
      && item.rangeId === rangeId && item.tradingDayId === tradingDayId);
    if (!group) {
      group = { side: sweep.side, confirmedAt, rangeId, tradingDayId, sweeps: [], claimed: false };
      groups.push(group);
    }
    group.sweeps.push(sweep);
  }

  const sequences = groups
    .filter((group) => expectedDirectionForSide(group.side))
    .map((group) => ({
      id: sequenceId(group.side, group.confirmedAt, group.sweeps, group.rangeId, group.tradingDayId),
      side: group.side,
      direction: expectedDirectionForSide(group.side),
      rangeId: group.rangeId,
      originRangeId: group.rangeId,
      tradingDayId: group.tradingDayId,
      identityComplete: !!group.rangeId && !!group.tradingDayId,
      sweeps: group.sweeps,
      primarySweep: group.sweeps[group.sweeps.length - 1],
      sweptAt: Math.min(...group.sweeps.map((s) => Number(s.time ?? group.confirmedAt))),
      confirmedAt: group.confirmedAt,
      sweptPrice: raidExtreme(group.side, group.sweeps),
      firstMss: null,
      mss: null,
      mssAt: null,
      confirmationFvg: null,
      status: LIQUIDITY_SEQUENCE_STATUS.RAID,
      _group: group,
    }))
    .sort((a, b) => a.confirmedAt - b.confirmedAt);

  const confirmedMss = [...(structureEvents || [])]
    .filter((event) => event?.type === "MSS" && event.confirmed && Number.isFinite(Number(event.time)))
    .sort((a, b) => Number(a.time) - Number(b.time));

  for (const event of confirmedMss) {
    const expectedSide = event.direction === "UP" ? "SSL" : event.direction === "DOWN" ? "BSL" : null;
    if (!expectedSide) continue;
    const sequence = sequences
      .filter((item) => !item._group.claimed
        && item.side === expectedSide
        && sameCausalIdentity(item, event)
        && item.confirmedAt <= Number(event.time)
        && Number(event.time) - item.confirmedAt <= maxDelayMs)
      .sort((a, b) => b.confirmedAt - a.confirmedAt)[0];
    if (!sequence) continue;

    sequence._group.claimed = true;
    sequence.firstMss = event;
    sequence.mss = event; // 兼容调用方更简短的字段名；始终与 firstMss 相同
    sequence.mssAt = Number(event.time);
    sequence.status = event.confirmedByDisplacement
      ? LIQUIDITY_SEQUENCE_STATUS.DISPLACEMENT_CONFIRMED
      : LIQUIDITY_SEQUENCE_STATUS.STRUCTURE_BREAK;
    sequence.structureEventType = event.semanticType || (event.confirmedByDisplacement ? "MSS" : "STRUCTURE_BREAK");

    if (event.confirmedByDisplacement && typeof confirmationZoneForMss === "function") {
      const fvg = confirmationZoneForMss(event, sequence) || null;
      if (fvg && sameCausalIdentity(event, fvg, { requireDisplacement: true })) {
        sequence.confirmationFvg = fvg;
        sequence.status = LIQUIDITY_SEQUENCE_STATUS.ICT_CONFIRMED;
      }
    }
  }

  const bySweep = new Map();
  for (const sequence of sequences) {
    delete sequence._group;
    for (const sweep of sequence.sweeps) bySweep.set(sweep, sequence);
  }
  return { sequences, bySweep };
}
