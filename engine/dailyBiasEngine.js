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

export function computeDailyBias({ structure, liquidity, location, price, structurePrice, pdArray, htfDirection, htfContext, reversalEvidence, session }) {
  const reason = [];
  const direction = structure.direction;
  // 4H 结构只能由已收盘 4H 确认；price 可继续使用最新 5m 收盘价计算执行空间。
  const confirmedPrice = structurePrice ?? price;
  const status = validateProtectedStructure(structure, confirmedPrice);
  let structureStatus = status.status;

  // P0-1（ICT 2022）：MSS = 打破最近反方向 swing → 结构转移，不等 HH/HL 重排。
  // 4H 结构 BULLISH 时，最近 swing low（lastLow，通常比 protectedLow 浅的 HL）被价格跌破
  // 即为结构转移；validateProtectedStructure 只查深位（protectedLow = 最后一个 HH 之前的
  // 位移起点），会滞后一根 4H（mss.js 已按"最近 swing"检测，4H bias 层此前不一致）。
  const lastLow = structure.lastLow;
  const lastHigh = structure.lastHigh;
  const brokenLow = direction === "BULLISH" && lastLow && confirmedPrice != null && confirmedPrice <= lastLow.price;
  const brokenHigh = direction === "BEARISH" && lastHigh && confirmedPrice != null && confirmedPrice >= lastHigh.price;
  if (brokenLow || brokenHigh) structureStatus = "INVALIDATED";
  // 实际被打破的结构位：优先最近 swing（MSS 语义），其次保护位（V1.4 深位审计）
  const brokenLevel = brokenLow ? lastLow.price : brokenHigh ? lastHigh.price : status.brokenLevel;

  // 1. Market Bias（原始结构方向，审计保留）：只由 Structure 决定
  let structureBias = "NEUTRAL";
  if (direction === "BULLISH") structureBias = "BULLISH";
  else if (direction === "BEARISH") structureBias = "BEARISH";

  // 实时价格越过 4H swing 只记预警；必须等待 4H 收盘才生成确认 MSS。
  const provisionalLow = direction === "BULLISH" && lastLow && price != null && price <= lastLow.price && !brokenLow;
  const provisionalHigh = direction === "BEARISH" && lastHigh && price != null && price >= lastHigh.price && !brokenHigh;
  const provisionalStructureBreak = provisionalLow || provisionalHigh
    ? {
        type: "PROVISIONAL_4H_BREAK",
        direction: provisionalLow ? "DOWN" : "UP",
        level: provisionalLow ? lastLow.price : lastHigh.price,
        price,
        confirmed: false,
        awaiting: "4H_CLOSE",
      }
    : null;

  // 2. Draw Target（V1.5 Liquidity Audit：Primary + Alternative + Reason，按 ICT 优先级）
  let draw = null;
  if (structureBias === "BULLISH" || structureBias === "BEARISH") {
    const ranked = rankLiquidityTargets(structure, liquidity, structureBias, price);
    if (ranked.primary) {
      draw = { side: structureBias === "BULLISH" ? "BSL" : "SSL", primary: ranked.primary, alternatives: ranked.alternatives };
    }
  }

  // 三层 Bias：结构事实 → HTF/流动性叙事 → 可执行方向。
  // HTF 与 4H 冲突时，只有“反向流动性被扫 + 4H 位移确认 MSS/FVG”才允许反转成立。
  const confirmedHtf = htfContext?.confirmedDirection || htfDirection || "NEUTRAL";
  const narrativeBias = confirmedHtf !== "NEUTRAL" ? confirmedHtf : structureBias;
  const narrativeConflict = structureBias !== "NEUTRAL" && narrativeBias !== "NEUTRAL" && narrativeBias !== structureBias;
  let effectiveBias = structureStatus === "INVALIDATED" ? "NEUTRAL" : structureBias;
  if (effectiveBias !== "NEUTRAL" && narrativeConflict && !reversalEvidence?.confirmed) effectiveBias = "NEUTRAL";

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
  if (structureBias === "BULLISH") {
    reason.push("4H Higher High Higher Low");
    reason.push(draw ? `Draw on Liquidity = ${draw.primary.type}` : "No buy-side liquidity above");
    if (structureStatus === "INVALIDATED") {
      reason.push(`Protected low broken by 4H close (${confirmedPrice} < ${brokenLevel}) — structure INVALIDATED`);
    } else if (provisionalStructureBreak) {
      reason.push(`Live price below 4H swing ${brokenLevel ?? lastLow.price} — provisional only, awaiting 4H close`);
    } else if (ctx === "LATE_IMPULSE") {
      reason.push(`Price in ${loc} near range target (LATE_IMPULSE) — execution WAIT (avoid chasing late impulse)`);
    } else if (loc === "DISCOUNT") reason.push("Price in discount — execution READY (look for longs)");
    else if (loc === "PREMIUM") reason.push("Price in premium — execution WAIT (wait for discount retracement)");
    else reason.push(`Price location unknown (${loc})`);
  } else if (structureBias === "BEARISH") {
    reason.push("4H Lower High Lower Low");
    reason.push(draw ? `Draw on Liquidity = ${draw.primary.type}` : "No sell-side liquidity below");
    if (structureStatus === "INVALIDATED") {
      reason.push(`Protected high broken by 4H close (${confirmedPrice} > ${brokenLevel}) — structure INVALIDATED`);
    } else if (provisionalStructureBreak) {
      reason.push(`Live price above 4H swing ${brokenLevel ?? lastHigh.price} — provisional only, awaiting 4H close`);
    } else if (ctx === "LATE_IMPULSE") {
      reason.push(`Price in ${loc} near range target (LATE_IMPULSE) — execution WAIT (avoid chasing late impulse)`);
    } else if (loc === "PREMIUM") reason.push("Price in premium — execution READY (look for shorts)");
    else if (loc === "DISCOUNT") reason.push("Price in discount — execution WAIT (wait for premium retracement)");
    else reason.push(`Price location unknown (${loc})`);
  } else {
    reason.push("Structure not confirmed (HH/HL or LH/LL missing)");
  }
  if (narrativeConflict && !reversalEvidence?.confirmed) {
    reason.push(`4H structure conflicts with confirmed HTF (${confirmedHtf}); awaiting liquidity sweep + displaced 4H MSS/FVG`);
  }

  const invalidation = buildInvalidation(structureBias, structure);

  // V1.4.1 MSS 事件化（P0）：结构失效 = 一次市场结构转移（MSS）。
  // 事件 schema 与 indicators/mss.js 统一：{ type, direction, level, price, confirmed }
  //   type      = "MSS"（最近 swing 被反势打破 = 结构转移；顺势 BOS 由 mss.js 按最近 swing 判定）
  //   direction = 突破方向：BULLISH 结构跌破低点 → DOWN；BEARISH 突破高点 → UP
  // P0-1：level 用实际被打破的最近 swing（brokenLevel），与 5m 层 mss.js 语义一致
  let mss = null;
  if (structureStatus === "INVALIDATED" && brokenLevel != null) {
    mss = {
      type: "MSS", // 统一结构事件类型（与 mss.js 一致），不再用 BREAK_PROTECTED_*
      direction: direction === "BULLISH" ? "DOWN" : "UP", // 突破方向，与 mss.js UP/DOWN 一致
      level: brokenLevel,
      price: confirmedPrice,
      confirmed: true, // 4H 保护位穿透按传入价格（收盘/实时）判定，视为已确认事件
      realtime: false,
      structureFrom: structureBias, // 原结构方向（审计：之前为什么看多/看空）
      structureTo: "NEUTRAL", // 失效后有效方向
    };
  }

  // V1.6：PD Array 执行区域排名（跟随有效方向；不参与 bias 判定）
  const pdArrayRank = rankPDArray({ bias: effectiveBias, range: location, pdArray: pdArray || { fvg: [], ob: [] } });

  // V2.0：Scenario State（HTF 参照，只描述状态）+ Bias Confidence（只描述可信度）
  const scenario = computeScenario({ direction: structureBias, structureStatus, htfDirection: confirmedHtf });
  // V2.3：Confidence 改为成功概率评分（Scenario Base + HTF Alignment + Quality − Risk），输出 score/level/factors
  const confidence = computeConfidence({ bias: structureBias, effectiveBias, structure, structureStatus, location, draw, pdArray: pdArrayRank, price, scenario, session });

  // V2.1：Bias Explanation Chain（把各组件的依据翻译成人类可读的解释链，不改判定）
  const explanation = buildExplanation({ structure, draw, location, pdArray: pdArrayRank, bias: structureBias, invalidation, structureStatus });

  // V2.5：Bias Decision Layer（融合 Confidence × planR，输出 Opportunity / Tradeability / Decision）
  // M2 修复：用 effectiveBias 而非 bias——结构失效后 bias 仍是旧方向，若按旧方向算 planR，
  // 即使 confidence LOW 兜底到 NO_TRADE，语义也不严谨（失效 = 无方向 = WAIT）。
  const decision = buildDecision({ bias: effectiveBias, confidence, draw, price, invalidation });

  return {
    bias: structureBias,
    structureBias,
    narrativeBias,
    effectiveBias,
    structureStatus,
    draw,
    executionState,
    reason,
    invalidation,
    mss,
    provisionalStructureBreak,
    reversalEvidence: reversalEvidence || null,
    htfContext: htfContext || null,
    pdArray: pdArrayRank,
    scenario,
    confidence,
    explanation,
    decision,
  };
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
