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
    // aligned = 有顺位 primary 执行区 且 价格仍在区间内/紧贴（未远离已填充区），
    // 避免"价格已跑远/已填充"的执行区仍给 +25 最强正因子导致信心度虚高
    pdArrayAligned: !!(pdArray && pdArray.primary && price != null && withinRange(price, pdArray.primary)),
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
  let baseScore = { TREND_CONTINUATION: 25, REVERSAL_ATTEMPT: 5 }[state] ?? 10;
  // P0-2（ICT 2022）：4H 结构确认（HH+HL）本身就是有效 Bias，HTF 中性只是"无助力"，
  // 不是"方向存疑"。此前把"结构确认但 HTF 中性"与"结构失效"都归入 TRANSITION base 10，
  // 把已确认结构的信心度拖到 LOW（如 MUUSDT 08-07：planR 3.43 仍 NO TRADE）。
  // 修正：保护位有效（结构未失效）的 TRANSITION = 方向成立但无 HTF 助力，给中间分。
  if (state === "TRANSITION" && checks.structureConfirmed && checks.protectedValid) baseScore = 20;
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
// 执行区贴边容差：价格在区间 ±1% 内视为"仍在执行区附近"。
// V2.6 收紧（0.02 → 0.01）：±2% 对高价合约（ETH 1900+ = 38 美元）太宽，
// 价格在 PREMIUM、执行区在 DISCOUNT 时仍被判"贴边"→ pdArrayAligned ±25 分
// 开关因子随微小价格波动在阈值 40 附近来回翻转，10 分钟内刷屏（MEDIUM 45 ↔ LOW 20）。
// 收紧后"价格未真正进入/贴近执行区"不再计对齐分。
const PD_ARRAY_MARGIN = 0.01;

/** 价格是否位于执行区区间内/紧贴（aligned 语义：未远离执行区）。
 * 有 top/bottom → 按区间 ±margin 判；只有参考价（简化输入）→ 按参考价贴近度判。 */
function withinRange(price, primary, margin = PD_ARRAY_MARGIN) {
  if (price == null || primary == null) return false;
  const top = primary.top;
  const bottom = primary.bottom;
  if (top != null && bottom != null) {
    return price >= bottom * (1 - margin) && price <= top * (1 + margin);
  }
  if (primary.price != null) {
    return Math.abs(price - primary.price) / price <= margin;
  }
  return false;
}

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
