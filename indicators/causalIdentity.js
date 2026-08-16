/**
 * Stable causal provenance shared by Range, liquidity, structure and PD Arrays.
 *
 * A rolling analysis must never relabel an old event with whichever Dealing Range
 * happens to be active now.  Identity is therefore derived only from the range's
 * own origin leg/lifecycle interval and from the candle that formed the event.
 */

import { tradingDayIdAt } from "./instrumentProfile.js";

function finite(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function causalRangeId(value) {
  return value?.originRangeId ?? value?.rangeId ?? null;
}

export function causalTradingDayId(value) {
  return value?.tradingDayId ?? null;
}

export function rangeActivatedAt(range) {
  return finite(range?.selectedAt) ?? finite(range?.confirmedAt);
}

function rangeOriginBounds(range) {
  const a = finite(range?.lowTime);
  const b = finite(range?.highTime);
  if (a == null || b == null) return null;
  return { from: Math.min(a, b), to: Math.max(a, b, finite(range?.confirmedAt) ?? 0) };
}

function rangeOwnsEvent(range, event, { allowOriginLeg = true } = {}) {
  if (!range?.rangeId || range.lifecycleStatus === "OBSERVATION") return false;
  const time = finite(event?.time ?? event?.confirmedAt);
  const index = finite(event?.displacementIndex ?? event?.atIndex ?? event?.index);
  if (allowOriginLeg) {
    const from = Math.min(finite(range?.lowIndex) ?? Infinity, finite(range?.highIndex) ?? Infinity);
    const to = Math.max(finite(range?.lowIndex) ?? -Infinity, finite(range?.highIndex) ?? -Infinity);
    if (index != null && Number.isFinite(from) && Number.isFinite(to) && index >= from && index <= to) return true;
    const bounds = rangeOriginBounds(range);
    if (time != null && bounds && time >= bounds.from && time <= bounds.to) return true;
  }
  const activeAt = rangeActivatedAt(range);
  return time != null && activeAt != null && time >= activeAt;
}

/** Select the causal range without ever using an unconditional "current range" fallback. */
export function rangeForEvent(event, { currentRange = null, priorRange = null, allowOriginLeg = true } = {}) {
  const existing = causalRangeId(event);
  if (existing) {
    if (currentRange?.rangeId === existing) return currentRange;
    if (priorRange?.rangeId === existing) return priorRange;
    return { rangeId: existing, version: event?.rangeVersion ?? null };
  }
  const distinct = currentRange?.rangeId && currentRange.rangeId !== priorRange?.rangeId
    ? [currentRange, priorRange]
    : [currentRange || priorRange];
  return distinct.find((range) => rangeOwnsEvent(range, event, { allowOriginLeg })) || null;
}

export function stableDisplacementId(candles, event, timeframe = null) {
  if (event?.displacementId) return event.displacementId;
  const index = Number(event?.displacementIndex ?? event?.atIndex);
  if (!Number.isInteger(index)) return null;
  const candle = candles?.[index];
  const time = candle?.closeTime ?? candle?.time ?? event?.time;
  if (time == null) return null;
  return `DISP_${timeframe || "TF"}_${event?.direction || "-"}_${time}`;
}

export function bindStructureEventIdentity(event, {
  candles = [],
  currentRange = null,
  priorRange = null,
  profile = null,
  timeframe = null,
  allowOriginLeg = true,
} = {}) {
  if (!event) return event;
  const range = rangeForEvent(event, { currentRange, priorRange, allowOriginLeg });
  const originRangeId = causalRangeId(event) || range?.rangeId || null;
  const time = finite(event.time ?? event.confirmedAt);
  const displacementId = stableDisplacementId(candles, event, timeframe);
  const id = event.id || [
    "STRUCT",
    timeframe || "TF",
    event.type || "EVENT",
    event.direction || "-",
    time ?? "-",
    event.level ?? "-",
    displacementId || event.atIndex || "-",
  ].join("_");
  return {
    ...event,
    id,
    timeframe: event.timeframe || timeframe || null,
    originRangeId,
    rangeId: originRangeId, // compatibility alias; never sourced from an unconditional fallback
    rangeVersion: event.rangeVersion ?? range?.version ?? null,
    displacementId,
    tradingDayId: event.tradingDayId ?? (time == null ? null : tradingDayIdAt(time, profile)),
  };
}

export function bindStructureEventsIdentity(events, options = {}) {
  return (events || []).map((event) => bindStructureEventIdentity(event, options));
}

/** Strict equality used by formal L3/CHAIN/HTF confirmation. Missing identity never acts as a wildcard. */
export function sameCausalIdentity(a, b, { requireDisplacement = false } = {}) {
  const ar = causalRangeId(a);
  const br = causalRangeId(b);
  const ad = causalTradingDayId(a);
  const bd = causalTradingDayId(b);
  if (!ar || !br || ar !== br || !ad || !bd || ad !== bd) return false;
  if (!requireDisplacement) return true;
  return !!a?.displacementId && !!b?.displacementId && a.displacementId === b.displacementId;
}
