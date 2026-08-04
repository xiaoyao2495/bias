/**
 * decision.js — V2.5 Bias Decision Layer（最终决策层）
 *
 * V2.3 Confidence 回答"方向是否可信"，V2.4 Quality 回答"有没有交易价值"。
 * 但两者分开输出时用户仍需自己脑补"那到底怎么看？"。
 * V2.5 增加最终决策层，融合两个维度输出可执行结论：
 *
 *   Opportunity = Confidence × Space（乘法：两个维度都要好）
 *     HIGH + planR 0.3 → 低机会；MEDIUM + planR 1.5 → 高机会
 *
 *   Tradeability（单独一档，避免误解 Confidence=可交易）
 *   Decision（WAIT / NO_TRADE / WAIT_FOR_RETRACEMENT / WATCH_FOR_ENTRY）
 *
 * 数据依据（V2.4）：HIGH 方向准（75-79%）但 planR 低（~0.34）→ 追单无优势；
 * LOW 方向差（~21%）即使 planR 高（~1.5）期望值仍为负 → 不交易。
 * 只做决策层，不改动 Bias / Confidence / Quality。
 */

/**
 * @param {object} p
 * @param {"BULLISH"|"BEARISH"|"NEUTRAL"} p.bias
 * @param {object|null} p.confidence  { score, level }（computeConfidence 输出）
 * @param {object|null} p.draw        { primary: { type, price } }（rankLiquidityTargets 主目标）
 * @param {number} p.price            当前价
 * @param {number|null} p.invalidation 保护位价格
 * @returns {{ planR: number|null, opportunity: number, tradeability: string, decision: string, reason: string }}
 */
export function buildDecision({ bias, confidence, draw, price, invalidation }) {
  // invalidation 可能是数字（scanner 直传）或对象 { type, price }（engine 传入），统一取价格
  const invalidationPrice = invalidation && typeof invalidation === "object" ? invalidation.price : invalidation;

  // planR：理论盈亏比 = |Draw − Entry| / Risk（Entry 假设 = 当前价）
  let planR = null;
  const drawPrice = draw && draw.primary ? draw.primary.price : null;
  if (bias !== "NEUTRAL" && drawPrice != null && price != null && invalidationPrice != null) {
    const risk = bias === "BULLISH" ? price - invalidationPrice : invalidationPrice - price;
    if (risk > 0) planR = Math.abs(drawPrice - price) / risk;
  }

  if (bias === "NEUTRAL") {
    return { planR: null, opportunity: 0, tradeability: "LOW", decision: "WAIT", reason: "No directional bias" };
  }

  const confScore = confidence && confidence.score != null ? confidence.score : 0;
  const confLevel = confidence && confidence.level ? confidence.level : "LOW";

  // Opportunity = Confidence × Space（space 归一化：planR 2 → 满分）
  const space = planR == null ? 0 : Math.min(1, planR / 2);
  const opportunity = Math.round(confScore * space);
  const tradeability = opportunity >= 60 ? "HIGH" : opportunity >= 35 ? "MEDIUM" : "LOW";

  // Decision 规则（优先级：方向不可信 > 空间不足 > 等回撤 > 值得找入场）
  let decision;
  let reason;
  if (confLevel === "LOW") {
    decision = "NO_TRADE";
    reason = "Direction probability too low";
  } else if (planR == null) {
    decision = "NO_TRADE";
    reason = "No reward estimate (missing draw or invalidation)";
  } else if (planR < 0.5) {
    decision = "NO_TRADE";
    reason = "Direction correct but reward insufficient (planR < 0.5)";
  } else if (planR < 1) {
    decision = "WAIT_FOR_RETRACEMENT";
    reason = "Acceptable direction, but room limited — wait for retracement to improve R";
  } else {
    decision = "WATCH_FOR_ENTRY";
    reason = "Enough upside room with acceptable direction probability";
  }

  return { planR, opportunity, tradeability, decision, reason };
}
