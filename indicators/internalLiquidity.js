/**
 * 1H internal swing 流动性上下文。
 * 实盘与历史回放共用，避免 riskLine 因两条路径采用不同 swing/生效时间而漂移。
 */

import { findSwings, analyzeSwings } from "./swing.js";
import { liquidityStateForLevel } from "./liquidity.js";

export function buildInternalLiquidityContext(h1, price, now, windowMs = 48 * 5 * 60_000) {
  const closed = (h1 || []).filter((k) => k?.closeTime != null && k.closeTime <= now);
  const swings = analyzeSwings(findSwings(closed, 1, 1));
  const activeFrom = (s) => closed[s.index + 1]?.closeTime ?? closed[s.index]?.closeTime;
  const stateFor = (s, isBuy) => liquidityStateForLevel({ price: s.price }, isBuy, closed, activeFrom(s));
  const activeHigh = swings.filter((s) => s.type === "HIGH").reverse()
    .find((s) => stateFor(s, true).state === "ACTIVE" && (price == null || s.price > price)) || null;
  const activeLow = swings.filter((s) => s.type === "LOW").reverse()
    .find((s) => stateFor(s, false).state === "ACTIVE" && (price == null || s.price < price)) || null;
  const toLevel = (s, type, state = { state: "ACTIVE" }) => s ? {
    type,
    price: s.price,
    activeFrom: activeFrom(s),
    ...(s.time != null ? { time: s.time } : {}),
    ...state,
  } : null;
  const recentConsumed = (type, isBuy) => swings
    .filter((s) => s.type === type)
    .map((s) => ({ swing: s, state: stateFor(s, isBuy) }))
    .filter(({ state }) => Number(state.state === "SWEPT" ? state.sweptAt : state.brokenAt) >= now - windowMs)
    .map(({ swing, state }) => toLevel(swing, isBuy ? "INTERNAL_HIGH" : "INTERNAL_LOW", state));

  return {
    closed,
    swings,
    activeHigh,
    activeLow,
    activeHighLevel: toLevel(activeHigh, "INTERNAL_HIGH"),
    activeLowLevel: toLevel(activeLow, "INTERNAL_LOW"),
    recentConsumedHigh: recentConsumed("HIGH", true),
    recentConsumedLow: recentConsumed("LOW", false),
    internalSwing: {
      low: activeLow?.price ?? null,
      high: activeHigh?.price ?? null,
    },
  };
}
