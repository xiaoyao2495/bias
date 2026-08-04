import { validateProtectedStructure } from "../indicators/structure.js";
import { rankLiquidityTargets } from "../indicators/liquidity.js";
import { rankPDArray } from "../indicators/pdArray.js";
import { computeScenario } from "../indicators/scenario.js";
import { computeConfidence } from "./confidence.js";
import { buildExplanation } from "./explanation.js";
import { buildDecision } from "./decision.js";

/**
 * dailyBiasEngine.js — ICT 2022 4H Daily Bias Engine V1.4.1 核心
 *
 * 方向与位置拆离（V1.3）：
 *   Structure  →  Market Bias（只由 4H 结构方向决定）
 *   Liquidity  →  Draw Target（bias 方向对应的主流动性目标）
 *   Dealing Range → Location（Premium/Discount）
 *   Market Bias + Location → Execution Context（READY / WAIT）
 *
 * Market Bias：
 *   BULLISH : Structure = BULLISH（HH + HL）
 *   BEARISH : Structure = BEARISH（LH + LL）
 *   NEUTRAL : 其他
 *
 * Execution State（Location + V1.9 Location Context 只影响执行，不影响 Bias）：
 *   BULLISH : DISCOUNT_VALID → READY（可找多），PREMIUM → WAIT（等回撤至折扣区），LATE_IMPULSE → WAIT（推动末端不追）
 *   BEARISH : PREMIUM_VALID  → READY（可找空），DISCOUNT → WAIT（等回撤至溢价区），LATE_IMPULSE → WAIT
 *
 * Draw Target：
 *   BULLISH → { side: "BSL", target: primaryBuyDraw }（优先级 PWH > PDH > EQH）
 *   BEARISH → { side: "SSL", target: primarySellDraw }（优先级 PWL > PDL > EQL）
 *
 * Invalidation（不是止损，是"当前 Bias 何时不成立"）：
 *   BULLISH : 跌破 protectedLow（最近 HL）→ { type: "BREAK_PROTECTED_LOW", price }
 *   BEARISH: 突破 protectedHigh（最近 LH）→ { type: "BREAK_PROTECTED_HIGH", price }
 *
 * 第一版明确不做：MSS / BOS 分类 / Displacement / 5m Entry / Gate / Notification / Score / AI 判断
 */

export function computeDailyBias({ structure, liquidity, location, price, pdArray, htfDirection }) {
  const reason = [];
  const direction = structure.direction;
  const status = validateProtectedStructure(structure, price);
  const structureStatus = status.status;

  // 1. Market Bias（原始结构方向，审计保留）：只由 Structure 决定
  let bias = "NEUTRAL";
  if (direction === "BULLISH") bias = "BULLISH";
  else if (direction === "BEARISH") bias = "BEARISH";

  // V1.4.1：保护位穿透 → 有效方向失效（原始方向保留，供审计"之前为什么看多"）
  const effectiveBias = structureStatus === "INVALIDATED" ? "NEUTRAL" : bias;

  // 2. Draw Target（V1.5 Liquidity Audit：Primary + Alternative + Reason，按 ICT 优先级）
  let draw = null;
  if (bias === "BULLISH" || bias === "BEARISH") {
    const ranked = rankLiquidityTargets(structure, liquidity, bias, price);
    if (ranked.primary) {
      draw = { side: bias === "BULLISH" ? "BSL" : "SSL", primary: ranked.primary, alternatives: ranked.alternatives };
    }
  }

  // 3. Execution State：Location + Location Context（V1.9），且基于有效方向（失效 → NONE）
  const loc = location.location;
  const ctx = location.context;
  let executionState = "NONE";
  if (effectiveBias === "BULLISH") {
    if (ctx === "LATE_IMPULSE") executionState = "WAIT"; // V1.9：接近目标（推动末端），不追多
    else if (loc === "DISCOUNT") executionState = "READY";
    else if (loc === "PREMIUM") executionState = "WAIT";
  } else if (effectiveBias === "BEARISH") {
    if (ctx === "LATE_IMPULSE") executionState = "WAIT"; // V1.9：接近目标（推动末端），不追空
    else if (loc === "PREMIUM") executionState = "READY";
    else if (loc === "DISCOUNT") executionState = "WAIT";
  }

  // Reason（审计用：说清楚每个字段的依据）
  if (bias === "BULLISH") {
    reason.push("4H Higher High Higher Low");
    reason.push(draw ? `Draw on Liquidity = ${draw.primary.type}` : "No buy-side liquidity above");
    if (structureStatus === "INVALIDATED") {
      reason.push(`Protected low broken (price ${price} < ${status.brokenLevel}) — structure INVALIDATED`);
    } else if (ctx === "LATE_IMPULSE") {
      reason.push(`Price in ${loc} near range target (LATE_IMPULSE) — execution WAIT (avoid chasing late impulse)`);
    } else if (loc === "DISCOUNT") reason.push("Price in discount — execution READY (look for longs)");
    else if (loc === "PREMIUM") reason.push("Price in premium — execution WAIT (wait for discount retracement)");
    else reason.push(`Price location unknown (${loc})`);
  } else if (bias === "BEARISH") {
    reason.push("4H Lower High Lower Low");
    reason.push(draw ? `Draw on Liquidity = ${draw.primary.type}` : "No sell-side liquidity below");
    if (structureStatus === "INVALIDATED") {
      reason.push(`Protected high broken (price ${price} > ${status.brokenLevel}) — structure INVALIDATED`);
    } else if (ctx === "LATE_IMPULSE") {
      reason.push(`Price in ${loc} near range target (LATE_IMPULSE) — execution WAIT (avoid chasing late impulse)`);
    } else if (loc === "PREMIUM") reason.push("Price in premium — execution READY (look for shorts)");
    else if (loc === "DISCOUNT") reason.push("Price in discount — execution WAIT (wait for premium retracement)");
    else reason.push(`Price location unknown (${loc})`);
  } else {
    reason.push("Structure not confirmed (HH/HL or LH/LL missing)");
  }

  const invalidation = buildInvalidation(bias, structure);

  // V1.6：PD Array 执行区域排名（跟随有效方向；不参与 bias 判定）
  const pdArrayRank = rankPDArray({ bias: effectiveBias, range: location, pdArray: pdArray || { fvg: [], ob: [] } });

  // V2.0：Scenario State（HTF 参照，只描述状态）+ Bias Confidence（只描述可信度）
  const scenario = computeScenario({ direction: bias, structureStatus, htfDirection });
  // V2.3：Confidence 改为成功概率评分（Scenario Base + HTF Alignment + Quality − Risk），输出 score/level/factors
  const confidence = computeConfidence({ bias, structure, structureStatus, location, draw, pdArray: pdArrayRank, price, scenario });

  // V2.1：Bias Explanation Chain（把各组件的依据翻译成人类可读的解释链，不改判定）
  const explanation = buildExplanation({ structure, draw, location, pdArray: pdArrayRank, bias, invalidation, structureStatus });

  // V2.5：Bias Decision Layer（融合 Confidence × planR，输出 Opportunity / Tradeability / Decision）
  const decision = buildDecision({ bias, confidence, draw, price, invalidation });

  return { bias, structureStatus, effectiveBias, draw, executionState, reason, invalidation, pdArray: pdArrayRank, scenario, confidence, explanation, decision };
}

function buildInvalidation(bias, structure) {
  if (bias === "BULLISH" && structure.protectedLow != null) {
    const info = structure.protectedLowInfo || {};
    return {
      type: "BREAK_PROTECTED_LOW",
      price: structure.protectedLow,
      invalidationType: info.invalidationType || "STRUCTURE_PROTECTED_LOW",
      source: info.source || "RECENT_SWING_LOW",
    };
  }
  if (bias === "BEARISH" && structure.protectedHigh != null) {
    const info = structure.protectedHighInfo || {};
    return {
      type: "BREAK_PROTECTED_HIGH",
      price: structure.protectedHigh,
      invalidationType: info.invalidationType || "STRUCTURE_PROTECTED_HIGH",
      source: info.source || "RECENT_SWING_HIGH",
    };
  }
  return null;
}
