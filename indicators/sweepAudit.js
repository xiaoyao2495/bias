/**
 * sweepAudit.js — 解释本轮为什么通报/为什么没有通报。
 * 只读诊断，不改变 Sweep/MSS/FVG 判定。
 */

export const SWEEP_AUDIT_REASON = Object.freeze({
  DATA_UNAVAILABLE: "DATA_UNAVAILABLE",
  NO_ELIGIBLE_LIQUIDITY: "NO_ELIGIBLE_LIQUIDITY",
  NO_PIERCE: "NO_PIERCE",
  PIERCE_NOT_NEW: "PIERCE_NOT_NEW_OR_LEVEL_CONSUMED",
  WAITING_RECLAIM: "L1_WAITING_RECLAIM",
  WAITING_STRUCTURE: "L2_WAITING_STRUCTURE_BREAK",
  NO_DISPLACEMENT: "STRUCTURE_BREAK_NO_DISPLACEMENT",
  NO_ICT_FVG: "DISPLACEMENT_NO_ICT_VALID_FVG",
  NO_EXECUTABLE_FVG: "DISPLACEMENT_NO_ICT_VALID_FVG", // 兼容旧调用方字段名
  NO_CONFIRMED_RANGE: "NO_CONFIRMED_DEALING_RANGE",
  NO_RANGE_AT_EVENT: "NO_CONFIRMED_RANGE_AT_EVENT",
  MARKET_CLOSED: "OUTSIDE_UNDERLYING_MARKET_SESSION",
  PIPELINE_ERROR: "LIQUIDITY_SEQUENCE_PIPELINE_ERROR",
  ICT_CONFIRMED: "L3_ICT_CONFIRMED",
});

function confirmedAt(k) {
  return k?.closeTime ?? k?.time;
}

function wasPierced(level, isBuy, candles) {
  const activeFrom = level?.activeFrom ?? level?.time ?? -Infinity;
  return (candles || []).some((k) => confirmedAt(k) > activeFrom
    && (isBuy ? k.high > level.price : k.low < level.price));
}

function countBy(items, keyOf) {
  const out = {};
  for (const item of items || []) {
    const key = keyOf(item) || "UNKNOWN";
    out[key] = (out[key] || 0) + 1;
  }
  return out;
}

export function buildSweepAudit({
  h5m = [],
  buyLevels = [],
  sellLevels = [],
  sweeps = [],
  sequences = [],
  now = Date.now(),
  window = 48,
  rangeId = null,
  dealingRangeReady = true,
  pipelineError = null,
  eventTimeAllowed = null,
} = {}) {
  const closed = (h5m || []).filter((k) => confirmedAt(k) <= now);
  const rawRecent = closed.slice(-window);
  const recent = eventTimeAllowed
    ? rawRecent.filter((k) => eventTimeAllowed(k.time))
    : rawRecent;
  const eligible = [...(buyLevels || []), ...(sellLevels || [])];
  const piercedPools = buyLevels.filter((level) => wasPierced(level, true, recent)).length
    + sellLevels.filter((level) => wasPierced(level, false, recent)).length;
  const tierCounts = { L1: 0, L2: 0, L3: 0 };
  for (const event of sweeps || []) {
    const tier = Math.max(1, Math.min(3, Number(event.tier) || 2));
    tierCounts[`L${tier}`]++;
  }
  const sequenceCounts = countBy(sequences, (item) => item.status);
  const latestSequence = [...(sequences || [])].sort((a, b) => Number(b.confirmedAt) - Number(a.confirmedAt))[0] || null;
  const latestL2 = [...(sweeps || [])]
    .filter((event) => Number(event.tier) === 2)
    .sort((a, b) => Number(b.closedTime ?? b.reclaimTime ?? b.time) - Number(a.closedTime ?? a.reclaimTime ?? a.time))[0] || null;
  const latestL2RangeId = latestL2?.originRangeId ?? latestL2?.rangeId ?? null;

  let reason;
  if (pipelineError) reason = SWEEP_AUDIT_REASON.PIPELINE_ERROR;
  else if (!h5m.length) reason = SWEEP_AUDIT_REASON.DATA_UNAVAILABLE;
  else if (eventTimeAllowed && !recent.length) reason = SWEEP_AUDIT_REASON.MARKET_CLOSED;
  else if (!eligible.length) reason = SWEEP_AUDIT_REASON.NO_ELIGIBLE_LIQUIDITY;
  else if (tierCounts.L3) reason = SWEEP_AUDIT_REASON.ICT_CONFIRMED;
  else if (tierCounts.L2) {
    if (!dealingRangeReady) reason = SWEEP_AUDIT_REASON.NO_CONFIRMED_RANGE;
    else if (!latestL2RangeId) reason = SWEEP_AUDIT_REASON.NO_RANGE_AT_EVENT;
    else if (!latestSequence?.firstMss) reason = SWEEP_AUDIT_REASON.WAITING_STRUCTURE;
    else if (!latestSequence.firstMss.confirmedByDisplacement) reason = SWEEP_AUDIT_REASON.NO_DISPLACEMENT;
    else reason = SWEEP_AUDIT_REASON.NO_ICT_FVG;
  } else if (tierCounts.L1) reason = SWEEP_AUDIT_REASON.WAITING_RECLAIM;
  else if (piercedPools) reason = SWEEP_AUDIT_REASON.PIERCE_NOT_NEW;
  else reason = SWEEP_AUDIT_REASON.NO_PIERCE;

  return {
    at: now,
    rangeId,
    dealingRangeReady,
    recentBars: recent.length,
    rawRecentBars: rawRecent.length,
    eligiblePools: eligible.length,
    buyPools: buyLevels.length,
    sellPools: sellLevels.length,
    poolStates: countBy(eligible, (level) => level.state || "UNMARKED"),
    piercedPools,
    eventCounts: tierCounts,
    sequenceCounts,
    marketReason: reason,
    pipelineError,
    notification: { pendingCount: null, reason: "NOT_EVALUATED" },
  };
}

/** 通知去重/时效过滤在检测之后发生，因此单独补充通知层决定。 */
export function attachSweepNotificationAudit(audit, sweeps, pending, now = Date.now()) {
  const all = sweeps || [];
  const ready = pending || [];
  let reason = "NO_MARKET_EVENT";
  if (ready.length) reason = "READY_TO_NOTIFY";
  else if (all.length) {
    const maxEventAge = 4 * 3600_000 + 10 * 60_000;
    const allExpired = all.every((event) => {
      const age = now - Number(event.closedTime ?? event.reclaimTime ?? event.time);
      return Number.isFinite(age) && age > maxEventAge;
    });
    const hasFreshL1 = all.some((event) => (event.tier ?? 2) !== 1
      || now - Number(event.closedTime ?? event.reclaimTime ?? event.time) <= 20 * 60_000);
    reason = allExpired ? "EVENT_EXPIRED" : hasFreshL1 ? "DEDUPED_OR_ALREADY_NOTIFIED" : "L1_EXPIRED";
  }
  return {
    ...(audit || {}),
    notification: { pendingCount: ready.length, reason },
  };
}

export function formatSweepAudit(audit) {
  if (!audit) return "audit unavailable";
  const e = audit.eventCounts || {};
  return `range=${audit.rangeId || "-"} pools=${audit.eligiblePools || 0} pierced=${audit.piercedPools || 0}`
    + ` events=L1:${e.L1 || 0}/L2:${e.L2 || 0}/L3:${e.L3 || 0}`
    + ` market=${audit.marketReason || "-"} notify=${audit.notification?.reason || "-"}`;
}
