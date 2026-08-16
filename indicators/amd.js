/**
 * amd.js — 按同一交易日证据顺序标注 Accumulation / Manipulation / Distribution。
 *
 * 这里不再使用 ER、ATR 或固定 24h 窗口定义 AMD。课程语义依赖顺序：
 *   已完成的 Session Range → raid/sweep → displacement MSS → 同一位移 FVG。
 * AMD 只验证日内交付阶段，不生成 HTF Bias。
 */
import { liquidityEventConfirmedAt, LIQUIDITY_SEQUENCE_STATUS } from "./liquiditySequence.js";
import { resolveInstrumentProfile, tradingDayIdAt } from "./instrumentProfile.js";
import { marketNow } from "../utils/marketClock.js";
import { sameCausalIdentity } from "./causalIdentity.js";

const STOP_POOL_TYPES = new Set([
  "PDH", "PDL", "PWH", "PWL", "EQH", "EQL",
  "PRE_MARKET_HIGH", "PRE_MARKET_LOW", "ASIA_HIGH", "ASIA_LOW",
  "EXTERNAL_HIGH", "EXTERNAL_LOW", "INTERNAL_HIGH", "INTERNAL_LOW",
]);

function expectedBias(side) {
  return side === "SSL" ? "BULLISH" : side === "BSL" ? "BEARISH" : "NEUTRAL";
}

function stableSweepKey(sweep) {
  return sweep?.baseKey || sweep?.key || `${sweep?.type || "LEVEL"}_${sweep?.level ?? "-"}`;
}

function sameSweep(a, b) {
  return a === b || (!!a && !!b && stableSweepKey(a) === stableSweepKey(b));
}

function eventDay(sweep, profile) {
  return sweep?.tradingDayId || tradingDayIdAt(liquidityEventConfirmedAt(sweep), profile);
}

function relevantSweep(sweep, sessionRange, profile, dayId) {
  if (!sweep || (sweep.tier ?? 2) < 2 || sweep.reclaimed === false) return false;
  if (!STOP_POOL_TYPES.has(sweep.type)) return false;
  const confirmedAt = Number(liquidityEventConfirmedAt(sweep));
  if (!Number.isFinite(confirmedAt) || confirmedAt < Number(sessionRange.activeFrom)) return false;
  return eventDay(sweep, profile) === dayId;
}

/**
 * @param {Object} p
 * @param {Object} [p.profile] resolveInstrumentProfile 输出
 * @param {Object|null} p.sessionRange 已完成的 PRE_MARKET / ASIA range
 * @param {Array} [p.sweeps] 本轮独立 raid 事件
 * @param {Object|null} [p.sweep] 兼容旧调用的最近 raid
 * @param {Array} [p.liquiditySequences] Sweep→MSS→FVG 因果链
 * @param {string} [p.bias] 已确认 HTF/4H 有效方向；AMD 不得反过来生成它
 * @param {number} [p.now]
 */
export function computeAmdStage({
  profile = resolveInstrumentProfile("BTCUSDT"),
  sessionRange = null,
  sweeps = [],
  sweep = null,
  liquiditySequences = [],
  bias = "NEUTRAL",
  now = marketNow(),
} = {}) {
  const tradingDayId = tradingDayIdAt(now, profile);
  const base = {
    direction: "NEUTRAL",
    evidenceTime: null,
    tradingDayId,
    profileKind: profile.kind,
    sessionModel: profile.sessionModel,
    sessionRangeId: sessionRange?.id || (sessionRange ? `${sessionRange.name}_${sessionRange.tradingDayId}` : null),
    liquiditySequenceId: null,
  };

  if (!sessionRange?.completed || !sessionRange.activeFrom || sessionRange.tradingDayId !== tradingDayId
    || sessionRange.name !== profile.accumulationSession) {
    return { ...base, stage: "UNSET", reason: "当日形成流动性的 Session Range 尚未完成" };
  }

  const pool = [...(sweeps || []), ...(sweep ? [sweep] : [])]
    .filter((item, index, list) => list.findIndex((other) => sameSweep(item, other)) === index)
    .filter((item) => relevantSweep(item, sessionRange, profile, tradingDayId))
    .sort((a, b) => Number(liquidityEventConfirmedAt(a)) - Number(liquidityEventConfirmedAt(b)));

  if (!pool.length) {
    return {
      ...base,
      stage: "ACCUMULATION",
      evidenceTime: sessionRange.activeFrom,
      reason: `${sessionRange.name} 区间已形成，等待流动性 raid`,
    };
  }

  const manipulation = pool.at(-1);
  const direction = expectedBias(manipulation.side);
  const sequence = [...(liquiditySequences || [])]
    .filter((item) => item?.status === LIQUIDITY_SEQUENCE_STATUS.ICT_CONFIRMED)
    .filter((item) => item?.primarySweep && sameSweep(item.primarySweep, manipulation))
    .filter((item) => item.tradingDayId === tradingDayId && sameCausalIdentity(item, manipulation))
    .sort((a, b) => Number(b.confirmedAt) - Number(a.confirmedAt))[0] || null;

  if (sequence && (bias === direction || bias === "NEUTRAL" || !bias)) {
    return {
      ...base,
      stage: "DISTRIBUTION",
      direction,
      evidenceTime: sequence.mssAt ?? sequence.confirmedAt,
      liquiditySequenceId: sequence.id,
      reason: `当日 raid → 位移 MSS → FVG 已确认，向${direction === "BULLISH" ? "上" : "下"}交付`,
    };
  }

  const mismatch = sequence && bias !== "NEUTRAL" && bias !== direction;
  return {
    ...base,
    stage: "MANIPULATION",
    direction,
    evidenceTime: liquidityEventConfirmedAt(manipulation),
    reason: mismatch
      ? `raid 后虽有反向交付，但与已确认 Bias ${bias} 冲突`
      : `已扫${manipulation.side === "BSL" ? "上方" : "下方"}流动性，等待位移 MSS 与 FVG`,
  };
}
