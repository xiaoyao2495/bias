/**
 * dealingRangeLifecycle.js — 为滚动计算的 Dealing Range 增加稳定身份与生命周期。
 *
 * computeDealingRange 每轮都会给出“当前候选区间”；本模块决定候选是否真的可以替换
 * 上轮 ACTIVE 区间，防止新 swing/窗口滚动使 ERL、Sweep key 与因果链身份漂移。
 */

import { computeDealingRange, computeLocationContext, isImpulseDealingRange } from "./dealingRange.js";
import { findDisplacements } from "./displacement.js";
import { detectStructureEvents } from "./mss.js";
import { analyzeSwings } from "./swing.js";
import { buildStructure } from "./structure.js";

function directionOf(range) {
  if (range?.rangeType === "IMPULSE_BULLISH") return "BULLISH";
  if (range?.rangeType === "IMPULSE_BEARISH") return "BEARISH";
  return "NEUTRAL";
}

function priceKey(value) {
  return Number.isFinite(Number(value)) ? String(Number(value)) : "-";
}

function endpointKey(time, index) {
  return Number.isFinite(Number(time)) ? Number(time) : `IDX${index ?? "-"}`;
}

/** ID 不使用滚动数组 index；有时间时由两端形成 K 时间与原始价格构成。 */
export function dealingRangeId(range) {
  if (!range || !Number.isFinite(Number(range.high)) || !Number.isFinite(Number(range.low))) return null;
  return [
    "DR",
    directionOf(range),
    endpointKey(range.lowTime, range.lowIndex), priceKey(range.low),
    endpointKey(range.highTime, range.highIndex), priceKey(range.high),
  ].join("_");
}

function candleConfirmedAt(candles, index, time) {
  const confirmation = index != null ? candles?.[index + 2] : null;
  const source = index != null ? candles?.[index] : null;
  return confirmation?.closeTime ?? confirmation?.time ?? source?.closeTime ?? source?.time ?? time ?? null;
}

function withLifecycle(range, candles, price, selectedAt, extra = {}) {
  const high = Number(range.high);
  const low = Number(range.low);
  const equilibrium = (high + low) / 2;
  const current = Number(price);
  const hasPrice = Number.isFinite(current);
  const location = !hasPrice ? "UNKNOWN" : current > equilibrium ? "PREMIUM" : current < equilibrium ? "DISCOUNT" : "AT_EQ";
  const position = high > low && hasPrice ? (current - low) / (high - low) : null;
  const direction = directionOf(range);
  const context = computeLocationContext({ high, low }, { direction }, current, equilibrium);
  const highConfirmedAt = range.highConfirmedAt ?? candleConfirmedAt(candles, range.highIndex, range.highTime);
  const lowConfirmedAt = range.lowConfirmedAt ?? candleConfirmedAt(candles, range.lowIndex, range.lowTime);
  const confirmedAt = Math.max(Number(highConfirmedAt) || 0, Number(lowConfirmedAt) || 0) || selectedAt || null;
  return {
    ...range,
    high,
    low,
    equilibrium,
    location,
    position,
    context,
    direction,
    rangeId: range.rangeId || dealingRangeId(range),
    lifecycleStatus: "ACTIVE",
    // Range 的客观生效点取端点都已确认的时刻，不能取服务本轮轮询时间。
    // 否则冷启动越晚，Range 前已经发生的有效事件越多地被误判为“早于 Range”。
    selectedAt: range.selectedAt ?? confirmedAt ?? selectedAt,
    confirmedAt: range.confirmedAt ?? confirmedAt,
    highConfirmedAt,
    lowConfirmedAt,
    version: Number(range.version) || 1,
    tradable: true,
    ...extra,
  };
}

/** 普通最近高低点只保留给审计/画图，不产生交易位置或稳定 Range 身份。 */
function observationOnly(range, reason = "RECENT_OBSERVATION_ONLY") {
  if (!range) return range;
  return {
    ...range,
    rangeId: null,
    lifecycleStatus: "OBSERVATION",
    tradable: false,
    location: "UNKNOWN",
    context: "UNKNOWN",
    position: null,
    observationReason: reason,
  };
}

function rebindIndexes(range, candles) {
  const find = (time, fallback) => {
    if (time != null) {
      const index = (candles || []).findIndex((k) => k.time === time);
      if (index >= 0) return index;
    }
    return Number.isInteger(fallback) && candles?.[fallback] ? fallback : null;
  };
  return {
    ...range,
    highIndex: find(range.highTime, range.highIndex),
    lowIndex: find(range.lowTime, range.lowIndex),
  };
}

/** 旧区间的结构失效只使用已收盘价格；实时 wick 不切 Range。 */
export function isDealingRangeInvalidated(range, confirmedClose) {
  if (!range || !Number.isFinite(Number(confirmedClose))) return false;
  const direction = range.direction || directionOf(range);
  if (direction === "BULLISH") return Number(confirmedClose) < Number(range.low);
  if (direction === "BEARISH") return Number(confirmedClose) > Number(range.high);
  return Number(confirmedClose) < Number(range.low) || Number(confirmedClose) > Number(range.high);
}

/** 新推动必须有同方向、发生在候选腿内的 displacement 结构事件。 */
function confirmedImpulseEvent(range, structureEvents = []) {
  const direction = directionOf(range);
  if (direction === "NEUTRAL") return null;
  const from = Math.min(Number(range.lowIndex), Number(range.highIndex));
  const to = Math.max(Number(range.lowIndex), Number(range.highIndex));
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
  const expected = direction === "BULLISH" ? "UP" : "DOWN";
  return (structureEvents || []).find((event) => {
    const index = Number(event.displacementIndex ?? event.atIndex);
    return event?.confirmed === true
      && event.confirmedByDisplacement === true
      && event.direction === expected
      && Number.isFinite(index) && index >= from && index <= to;
  }) || null;
}

export function isConfirmedImpulseCandidate(range, structureEvents = []) {
  return !!confirmedImpulseEvent(range, structureEvents);
}

function eventConfirmedAt(event, candles) {
  const direct = Number(event?.time ?? event?.confirmedAt);
  if (Number.isFinite(direct)) return direct;
  const index = Number(event?.displacementIndex ?? event?.atIndex);
  const candle = Number.isInteger(index) ? candles?.[index] : null;
  const time = Number(candle?.closeTime ?? candle?.time);
  return Number.isFinite(time) ? time : null;
}

function isNewExpansion(candidate, prior) {
  const direction = directionOf(candidate);
  if (direction === "BULLISH") return Number(candidate.high) > Number(prior.high);
  if (direction === "BEARISH") return Number(candidate.low) < Number(prior.low);
  return false;
}

/**
 * @returns {{range:Object, transition:Object}}
 * transition.changed=false 表示继续沿用同一个 Range；reason 可直接写审计日志。
 */
export function resolveDealingRangeLifecycle({
  candidate,
  prior = null,
  candles = [],
  structureEvents = [],
  price = null,
  confirmedClose = null,
  selectedAt = null,
} = {}) {
  // 升级迁移：旧 state 可能已经把 RECENT 持久化为 ACTIVE。它不是课程意义上的推动
  // 区间，必须在读取时直接丢弃，不能继续向 ERL、Sweep 或 CHAIN 传播 rangeId。
  const eligiblePrior = isImpulseDealingRange(prior) ? prior : null;

  if (candidate?.rangeType === "RECENT") {
    if (!eligiblePrior) {
      const observation = observationOnly(candidate);
      return {
        range: observation,
        transition: {
          changed: false,
          reason: "RECENT_OBSERVATION_ONLY",
          observationId: dealingRangeId(candidate),
          ...(prior?.rangeId ? { discardedLegacyRangeId: prior.rangeId } : {}),
        },
      };
    }
    // 已有确认推动区间时，RECENT 只能作为候选观察，不能替换它。仍用已收盘价检查
    // 旧区间是否失效，确保生命周期不会因忽略候选而停止推进。
    const rebound = rebindIndexes(eligiblePrior, candles);
    const invalidated = eligiblePrior.lifecycleStatus === "INVALIDATED" || isDealingRangeInvalidated(eligiblePrior, confirmedClose);
    return {
      range: withLifecycle(rebound, candles, price, selectedAt, invalidated
        ? { lifecycleStatus: "INVALIDATED", invalidatedAt: eligiblePrior.invalidatedAt ?? selectedAt }
        : {}),
      transition: {
        changed: false,
        statusChanged: invalidated && eligiblePrior.lifecycleStatus !== "INVALIDATED",
        reason: invalidated ? "RANGE_INVALIDATED_WAITING_REPLACEMENT" : "RECENT_CANDIDATE_IGNORED",
        rangeId: eligiblePrior.rangeId,
        observationId: dealingRangeId(candidate),
      },
    };
  }

  prior = eligiblePrior;
  if (!candidate || candidate.rangeType === "NONE" || !Number.isFinite(Number(candidate.high)) || !Number.isFinite(Number(candidate.low))) {
    if (!prior) return { range: candidate, transition: { changed: false, reason: "NO_RANGE" } };
    const rebound = rebindIndexes(prior, candles);
    const invalidated = prior.lifecycleStatus === "INVALIDATED" || isDealingRangeInvalidated(prior, confirmedClose);
    return {
      range: withLifecycle(rebound, candles, price, selectedAt, invalidated ? { lifecycleStatus: "INVALIDATED", invalidatedAt: prior.invalidatedAt ?? selectedAt } : {}),
      transition: { changed: false, statusChanged: invalidated && prior.lifecycleStatus !== "INVALIDATED", reason: invalidated ? "RANGE_INVALIDATED_WAITING_REPLACEMENT" : "CANDIDATE_UNAVAILABLE", rangeId: prior.rangeId },
    };
  }

  const candidateRange = withLifecycle(candidate, candles, price, selectedAt);
  if (!prior?.rangeId) {
    return { range: candidateRange, transition: { changed: true, reason: "INITIAL_RANGE", to: candidateRange.rangeId } };
  }

  const reboundPrior = withLifecycle(rebindIndexes(prior, candles), candles, price, selectedAt);
  const invalidated = prior.lifecycleStatus === "INVALIDATED" || isDealingRangeInvalidated(reboundPrior, confirmedClose);
  if (candidateRange.rangeId === reboundPrior.rangeId) {
    if (invalidated) {
      return {
        range: { ...candidateRange, selectedAt: reboundPrior.selectedAt, version: reboundPrior.version, lifecycleStatus: "INVALIDATED", invalidatedAt: prior.invalidatedAt ?? selectedAt, transitionReason: "RANGE_INVALIDATED_WAITING_REPLACEMENT" },
        transition: { changed: false, statusChanged: prior.lifecycleStatus !== "INVALIDATED", reason: "RANGE_INVALIDATED_WAITING_REPLACEMENT", rangeId: reboundPrior.rangeId },
      };
    }
    return {
      range: { ...candidateRange, selectedAt: reboundPrior.selectedAt, version: reboundPrior.version, transitionReason: "SAME_RANGE" },
      transition: { changed: false, reason: "SAME_RANGE", rangeId: reboundPrior.rangeId },
    };
  }

  const impulseEvent = confirmedImpulseEvent(candidateRange, structureEvents);
  const confirmedImpulse = !!impulseEvent;
  const candidateNewer = Number(candidateRange.confirmedAt) > Number(reboundPrior.confirmedAt || 0);
  const replacesFallback = reboundPrior.direction === "NEUTRAL" && confirmedImpulse && candidateNewer;
  const confirmedExpansion = confirmedImpulse && candidateNewer && isNewExpansion(candidateRange, reboundPrior);
  const confirmedReversal = confirmedImpulse && candidateNewer
    && candidateRange.direction !== reboundPrior.direction && candidateRange.direction !== "NEUTRAL";
  const invalidatedReplacement = invalidated && confirmedImpulse && candidateNewer;
  const shouldSwitch = invalidatedReplacement || replacesFallback || confirmedExpansion || confirmedReversal;

  if (!shouldSwitch) {
    if (invalidated) {
      return {
        range: {
          ...reboundPrior,
          lifecycleStatus: "INVALIDATED",
          invalidatedAt: prior.invalidatedAt ?? selectedAt,
          transitionReason: "RANGE_INVALIDATED_WAITING_CONFIRMED_REPLACEMENT",
        },
        transition: {
          changed: false,
          statusChanged: prior.lifecycleStatus !== "INVALIDATED",
          reason: "RANGE_INVALIDATED_WAITING_CONFIRMED_REPLACEMENT",
          rangeId: reboundPrior.rangeId,
          rejectedCandidateId: candidateRange.rangeId,
        },
      };
    }
    return {
      range: { ...reboundPrior, transitionReason: confirmedImpulse ? "UNCONFIRMED_REPLACEMENT" : "CANDIDATE_NOT_DISPLACEMENT_CONFIRMED" },
      transition: {
        changed: false,
        reason: confirmedImpulse ? "UNCONFIRMED_REPLACEMENT" : "CANDIDATE_NOT_DISPLACEMENT_CONFIRMED",
        rangeId: reboundPrior.rangeId,
        rejectedCandidateId: candidateRange.rangeId,
      },
    };
  }

  const reason = invalidatedReplacement ? "PRIOR_INVALIDATED_CONFIRMED_REPLACEMENT" : replacesFallback ? "CONFIRMED_IMPULSE_REPLACES_FALLBACK"
    : confirmedReversal ? "CONFIRMED_REVERSAL" : "CONFIRMED_EXPANSION";
  const next = {
    ...candidateRange,
    selectedAt: Math.max(
      Number(candidateRange.confirmedAt) || 0,
      Number(eventConfirmedAt(impulseEvent, candles)) || 0,
    ) || candidateRange.selectedAt,
    version: reboundPrior.version + 1,
    previousRangeId: reboundPrior.rangeId,
    transitionReason: reason,
  };
  return {
    range: next,
    transition: { changed: true, reason, from: reboundPrior.rangeId, to: next.rangeId },
  };
}

function confirmedPivotAt(candles, index, left = 2, right = 2) {
  if (index < left || index + right >= candles.length) return null;
  const c = candles[index];
  let isHigh = true;
  let isLow = true;
  for (let i = index - left; i <= index + right; i++) {
    if (i === index) continue;
    if (candles[i].high >= c.high) isHigh = false;
    if (candles[i].low <= c.low) isLow = false;
    if (!isHigh && !isLow) break;
  }
  if (isHigh) return { type: "HIGH", price: c.high, index, time: c.time };
  if (isLow) return { type: "LOW", price: c.low, index, time: c.time };
  return null;
}

function appendAlternatingSwing(swings, swing) {
  if (!swing) return;
  const last = swings.at(-1);
  if (!last || last.type !== swing.type) {
    swings.push(swing);
    return;
  }
  if ((swing.type === "HIGH" && swing.price > last.price) || (swing.type === "LOW" && swing.price < last.price)) {
    swings[swings.length - 1] = swing;
  }
}

function eventKey(event) {
  return [event.type, event.direction, event.displacementIndex ?? event.atIndex, Number(event.level)].join("|");
}

/**
 * 从冷历史逐根重建 Range 状态。每根 4H 收盘时只确认 index-2 的 pivot；结构事件也只在
 * 当根可见数据上检测。rangesByIndex[i] 表示第 i 根处理完成后的持久化状态。
 */
export function rebuildDealingRangeLifecycle({ candles = [], startIndex = 0, endIndex = null, initialRange = null } = {}) {
  if (!candles.length) return { range: initialRange, rangesByIndex: [], transitions: [], structureEvents: [], stepsProcessed: 0 };
  const end = Math.min(candles.length - 1, endIndex == null ? candles.length - 1 : Math.max(-1, Number(endIndex)));
  const start = Math.max(0, Math.min(end + 1, Number(startIndex) || 0));
  if (end < 0) return { range: initialRange, rangesByIndex: [], transitions: [], structureEvents: [], stepsProcessed: 0 };
  const visibleHistory = candles.slice(0, end + 1);
  const displacements = findDisplacements(visibleHistory);
  const displacementMap = new Map(displacements.map((d) => [d.index, {
    index: d.index,
    dir: d.direction,
    confirmationIndex: d.confirmationIndex,
    close: d.close,
    fvg: d.fvg,
  }]));
  const swings = [];
  const structureEvents = [];
  const seenEvents = new Set();
  const rangesByIndex = [];
  const transitions = [];
  let prior = initialRange;

  for (let i = 0; i <= end; i++) {
    const prefix = visibleHistory.slice(0, i + 1);
    appendAlternatingSwing(swings, confirmedPivotAt(visibleHistory, i - 2));
    const structure = buildStructure(analyzeSwings(swings));
    const detected = detectStructureEvents(visibleHistory, {
      left: 2,
      right: 2,
      precomputedStructure: structure,
      displacementMap,
      endIndex: i,
    });
    for (const event of detected.events || []) {
      if (!event.confirmed) continue;
      const atIndex = event.atIndex ?? i;
      const normalized = { ...event, atIndex, time: visibleHistory[atIndex]?.closeTime ?? visibleHistory[i].closeTime };
      const key = eventKey(normalized);
      if (!seenEvents.has(key)) {
        seenEvents.add(key);
        structureEvents.push(normalized);
      }
    }

    if (i < start) {
      rangesByIndex[i] = prior;
      continue;
    }

    const candidate = computeDealingRange(swings, structure, visibleHistory[i].close, null);
    const resolved = resolveDealingRangeLifecycle({
      candidate,
      prior,
      candles: prefix,
      structureEvents,
      price: visibleHistory[i].close,
      confirmedClose: visibleHistory[i].close,
      selectedAt: visibleHistory[i].closeTime,
    });
    prior = resolved.range?.rangeId ? resolved.range : prior;
    rangesByIndex[i] = prior;
    if (resolved.transition?.changed || resolved.transition?.statusChanged) {
      transitions.push({ index: i, time: visibleHistory[i].closeTime, ...resolved.transition });
    }
  }
  return { range: prior, rangesByIndex, transitions, structureEvents, stepsProcessed: Math.max(0, end - start + 1) };
}
