/**
 * confidence.js — V2.3 Bias Confidence（成功概率评分，不是 Entry 信号）
 *
 * V2.3.1 初版（假设版）：Liquidity/Location/PD Array 各加分、LATE_IMPULSE 罚分。
 * V2.3.3 单变量验证（BTC+ETH 2025 双标的，控制目标距离分桶）推翻了初版假设：
 *
 *   单变量胜率（窗口 30 根 4H，WIN=触及 Draw 或 ±5%）：
 *     LATE_IMPULSE        BTC 72.7% / ETH 76.3%  ← 强正因子（趋势惯性，目标近）
 *     DISCOUNT_VALID      BTC 30.4% / ETH 28.6%  ← 负因子（回撤位未来 5 天易破保护位）
 *     PREMIUM_VALID       BTC 22.2% / ETH 20.7%  ← 负因子（对称）
 *     PD array aligned    BTC 68.0% / ETH 66.3%  ← 最强正因子（未对齐近 0%）
 *     CONTINUATION        BTC 70.0% / ETH 66.1%  ← 正因子（弱-中）
 *
 * 注意：这与 V1.9"不追高（LATE_IMPULSE→WAIT）"不冲突——V1.9 是入场时机层，
 * 这里衡量的是"Bias 方向在未来 N 根内触及目标"的惯性层，两个维度。
 *
 * V2.3 终版权重（数据驱动）：
 *
 *   Confidence = Base(Scenario) + Alignment(HTF) + Quality(PD/Liquidity) ± 位置因子
 *
 *   Base        : CONTINUATION +25 / REVERSAL_ATTEMPT +5 / TRANSITION +10
 *   Alignment   : HTF 同向 +15（CONTINUATION 必触发），HTF 反向 -10
 *   Quality     : PD array aligned +25（最强）、Liquidity +10
 *   位置因子    : LATE_IMPULSE +15（趋势惯性）、VALID 折价/溢价位 -10（回撤/反抽）
 *   微调        : 距目标 <2% +5（近目标惯性）、Wide range -10（防御）
 *
 * 输出 score(0-100) + level(HIGH/MEDIUM/LOW) + factors(因子明细)。
 * HIGH ≥ 75，MEDIUM ≥ 40，LOW < 40（经 BTC/ETH 双标的扫描验证：HIGH 75-79% > MEDIUM > LOW）。
 */
export function computeConfidence({ bias, structure, structureStatus, location, draw, pdArray, price, scenario }) {
  const checks = {
    structureConfirmed: structure.direction !== "NEUTRAL",
    protectedValid: structureStatus === "VALID",
    liquidityClear: !!(draw && draw.primary),
    locationValid: location.context === "DISCOUNT_VALID" || location.context === "PREMIUM_VALID",
    pdArrayAligned: !!(pdArray && pdArray.primary),
  };

  // 硬门槛：结构未确认 / 保护位失效 → 直接 LOW，无评分
  if (!checks.structureConfirmed || !checks.protectedValid) {
    const factors = [];
    if (!checks.structureConfirmed) factors.push({ name: "Structure not confirmed", value: "0" });
    if (!checks.protectedValid) factors.push({ name: "Protected level invalid", value: "0" });
    return { level: "LOW", score: 0, factors, checks };
  }

  const factors = [];
  let score = 0;

  // 1. Base：Scenario 状态质量（V2.3.3 单变量：CONTINUATION 66-70% > REVERSAL 48-55%）
  const state = (scenario && scenario.state) || "TRANSITION";
  const baseScore = { TREND_CONTINUATION: 25, REVERSAL_ATTEMPT: 5 }[state] ?? 10;
  score += baseScore;
  if (baseScore > 0) {
    const name = state === "TREND_CONTINUATION" ? "Trend continuation" : state === "REVERSAL_ATTEMPT" ? "Reversal attempt" : "Transition";
    factors.push({ name, value: `+${baseScore}` });
  }

  // 2. Alignment：4H 与 HTF 同向（CONTINUATION 时必触发）
  const htf = scenario ? scenario.htfDirection : "NEUTRAL";
  if (htf === bias) {
    score += 15;
    factors.push({ name: "HTF alignment", value: "+15" });
  } else if (htf !== "NEUTRAL") {
    score -= 10;
    factors.push({ name: "HTF conflict", value: "-10" });
  }

  // 3. Quality：PD Array（最强正因子）+ Liquidity
  if (checks.pdArrayAligned) {
    score += 25;
    factors.push({ name: "PD array aligned", value: "+25" });
  }
  if (checks.liquidityClear) {
    score += 10;
    factors.push({ name: "Liquidity target", value: "+10" });
  }

  // 4. 位置因子（数据修正）：LATE_IMPULSE 强惯性为正，VALID 回撤/反抽位为负
  const lateImpulse = location.context === "LATE_IMPULSE";
  if (lateImpulse) {
    score += 15;
    factors.push({ name: "Late impulse momentum", value: "+15" });
  } else if (checks.locationValid) {
    score -= 10;
    factors.push({ name: "Retrace location (weak)", value: "-10" });
  }

  // 5. 微调：近目标惯性 +5；宽区间防御 -10
  const dist = drawDist(bias, price, draw);
  if (dist != null && dist < NEAR_DRAW_PCT) {
    score += 5;
    factors.push({ name: "Near draw target", value: "+5" });
  }
  const rangePct = rangeRatio(location, price);
  if (rangePct != null && rangePct > WIDE_RANGE_PCT) {
    score -= 10;
    factors.push({ name: "Wide range", value: "-10" });
  }

  score = Math.max(0, Math.min(95, Math.round(score)));
  const level = score >= LEVELS.HIGH ? "HIGH" : score >= LEVELS.MEDIUM ? "MEDIUM" : "LOW";
  return { level, score, factors, checks };
}

// ---- 阈值与常量 ----
const NEAR_DRAW_PCT = 0.02; // 距目标 <2% 视为"目标就在眼前"（惯性最强）
const WIDE_RANGE_PCT = 0.25; // 区间跨度 > 价格 25% 视为宽区间（防御性罚分）
const LEVELS = { HIGH: 75, MEDIUM: 40 }; // score >= 75 → HIGH；>= 40 → MEDIUM；否则 LOW

/** 价格到 Draw Target 的相对距离（BULLISH 用上方目标，BEARISH 用下方目标） */
function drawDist(bias, price, draw) {
  const p = draw && draw.primary && draw.primary.price;
  if (p == null || price == null) return null;
  return bias === "BULLISH" ? (p - price) / price : (price - p) / price;
}

/** 当前 Impulse Range 跨度相对价格的比例 */
function rangeRatio(location, price) {
  const high = location && location.high;
  const low = location && location.low;
  if (high == null || low == null || price == null || high <= low) return null;
  return (high - low) / price;
}
