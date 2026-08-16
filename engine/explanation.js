/**
 * explanation.js — V2.1 Bias Explanation Chain
 *
 * 把引擎已算出的各组件翻译成"为什么是这个 Bias"的人类可读解释链，
 * 类似 ICT 分析师逐条说明。5 个组件（顺序固定）：
 *   1. Structure   — 方向来自哪组 HH/HL 或 LH/LL
 *   2. Liquidity   — Bias 方向的流动性目标（Primary Draw）
 *   3. Location    — 价格在区间哪一侧 + Context 的执行含义
 *   4. PD Array    — 同向顺位的执行区域（FVG/OB）
 *   5. Invalidation— 保护位与失效条件
 *
 * 只做翻译（复用引擎已计算结果），不重新计算、不改变任何判定。
 * 输出：Array<{ component: string, lines: string[] }>
 */

/** 组装五段解释链 */
export function buildExplanation({ structure, draw, location, pdArray, bias, invalidation, structureStatus }) {
  return [
    explainStructure(structure, structureStatus),
    explainLiquidity(bias, draw),
    explainLocation(location, bias, structureStatus),
    explainPDArray(pdArray, bias),
    explainInvalidation(bias, invalidation),
  ];
}

/** 1. Structure：方向由哪组 swing 确认 */
function explainStructure(structure, structureStatus) {
  const d = structure.direction;
  let summary;
  if (d === "BULLISH") summary = "HH + HL confirmed";
  else if (d === "BEARISH") summary = "LH + LL confirmed";
  else summary = "Structure not confirmed (HH/HL or LH/LL missing)";

  const lines = [d === "NEUTRAL" ? summary : `${summary} — ${structure.type}`];
  if (structureStatus === "INVALIDATED") lines.push("Protected level broken — structure INVALIDATED");
  return { component: "Structure", lines };
}

/** 2. Liquidity：Bias 方向的 Primary Draw */
function explainLiquidity(bias, draw) {
  const primary = draw && draw.primary;
  if (!primary) {
    const msg =
      bias === "BULLISH"
        ? "No buy-side liquidity above"
        : bias === "BEARISH"
          ? "No sell-side liquidity below"
          : "-";
    return { component: "Liquidity", lines: [msg] };
  }
  const side = bias === "BULLISH" ? "Buy-side above" : "Sell-side below";
  const lines = [`${side}: ${primary.type} ${fmtPrice(primary.price)}${primary.reason ? ` (${primary.reason})` : ""}`];
  if (draw.alternatives && draw.alternatives.length) {
    const shown = draw.alternatives.slice(0, 2).map((a) => `${a.type} ${fmtPrice(a.price)}`).join(", ");
    lines.push(`Alternatives: ${shown}${draw.alternatives.length > 2 ? " …" : ""}`);
  }
  return { component: "Liquidity", lines };
}

/** 3. Location：严格按 50% EQ 的 Premium/Discount 给出执行含义。 */
function explainLocation(location, bias, structureStatus) {
  const loc = location.location;
  const lines = [loc == null || loc === "UNKNOWN" ? "Price location unknown" : loc === "AT_EQ" ? "Price at EQUILIBRIUM" : `Price in ${loc}`];

  let meaning = "";
  if (structureStatus === "INVALIDATED") {
    meaning = "structure invalidated — no execution";
  } else if (bias === "BULLISH") {
    if (loc === "DISCOUNT") meaning = "valid discount zone (READY for longs)";
    else if (loc === "PREMIUM") meaning = "wait for discount retracement (WAIT)";
    else if (loc === "AT_EQ") meaning = "no premium/discount advantage (WAIT)";
  } else if (bias === "BEARISH") {
    if (loc === "PREMIUM") meaning = "valid premium zone (READY for shorts)";
    else if (loc === "DISCOUNT") meaning = "wait for premium retracement (WAIT)";
    else if (loc === "AT_EQ") meaning = "no premium/discount advantage (WAIT)";
  }
  if (meaning) lines.push(meaning);
  return { component: "Location", lines };
}

/** 4. PD Array：同向顺位执行区域 */
function explainPDArray(pdArray, bias) {
  const p = pdArray && pdArray.primary;
  if (!p) {
    if (bias === "NEUTRAL") return { component: "PD Array", lines: ["No direction — no execution zone"] };
    const zone = bias === "BULLISH" ? "discount" : "premium";
    return { component: "PD Array", lines: [`No aligned ${zone} PD Array (FVG/OB)`] };
  }
  const price = p.type.includes("FVG") ? `${fmtPrice(p.bottom)}-${fmtPrice(p.top)}` : fmtPrice(p.price);
  return { component: "PD Array", lines: [`${pdName(p.type)} ${price} — ${p.location}, ${p.status}`] };
}

/** 5. Invalidation：保护位与失效条件 */
function explainInvalidation(bias, invalidation) {
  if (!invalidation) return { component: "Invalidation", lines: ["-"] };
  const level = invalidation.type === "BREAK_PROTECTED_LOW" ? "Protected Low" : "Protected High";
  const src = invalidation.source ? ` [${invalidation.source}]` : "";
  return { component: "Invalidation", lines: [`${level} ${fmtPrice(invalidation.price)} — break = bias invalidated${src}`] };
}

function pdName(type) {
  return (
    {
      BULLISH_FVG: "Bullish FVG",
      BEARISH_FVG: "Bearish FVG",
      BULLISH_OB: "Bullish OB",
      BEARISH_OB: "Bearish OB",
    }[type] || type
  );
}

function fmtPrice(n) {
  if (n == null) return "-";
  if (Number.isInteger(n)) return String(n);
  return String(Number(n.toFixed(2)));
}
