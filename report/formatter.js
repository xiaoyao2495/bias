/**
 * formatter.js — 输出报告（ASCII 报告）
 */
const LINE = "=".repeat(32);

export function formatReport(r) {
  const { symbol, structure, liquidity, location, pdArray, bias } = r;
  const lines = [];

  lines.push(LINE, "");
  lines.push(`${symbol} 4H Daily Bias`, "");
  if (r.replayTime) lines.push(`Time: ${new Date(r.replayTime).toISOString().slice(0, 10)}`, "");
  lines.push("Structure:");
  lines.push(structure.type, "");
  lines.push("Sequence:");
  lines.push(structure.sequence.length ? structure.sequence.join(" → ") : "-", "");
  lines.push("Direction:");
  lines.push(directionName(structure.direction), "");
  lines.push("MSS / BOS:");
  pushMssBos(lines, r.mss);
  lines.push("Liquidity Target:", "");

  lines.push("Primary Buy Draw:");
  lines.push(liquidity.primaryBuyDraw ? `${liquidity.primaryBuyDraw.type} ${fmtPrice(liquidity.primaryBuyDraw.price)}` : "-");
  lines.push("");
  lines.push("Buy Side:");
  liquidity.buySide.forEach((t) => lines.push(`${t.type} ${fmtPrice(t.price)}`));
  lines.push("");

  lines.push("Sell Side:");
  liquidity.sellSide.forEach((t) => lines.push(`${t.type} ${fmtPrice(t.price)}`));
  lines.push("");

  lines.push("Primary Sell Draw:");
  lines.push(liquidity.primarySellDraw ? `${liquidity.primarySellDraw.type} ${fmtPrice(liquidity.primarySellDraw.price)}` : "-");
  lines.push("");

  lines.push("Range Type:");
  lines.push(location.rangeType === "RECENT" ? "RECENT (OBSERVATION ONLY)" : location.rangeType || "-", "");
  lines.push("Range Status:");
  lines.push(location.lifecycleStatus || "-", "");
  lines.push("Range:");
  if (location.high != null) lines.push(`${fmtPrice(location.low)} - ${fmtPrice(location.high)}`);
  else lines.push("-");
  lines.push("Equilibrium:");
  lines.push(location.equilibrium != null ? fmtPrice(location.equilibrium) : "-");
  lines.push("Location:");
  lines.push(locationName(location.location), "");
  lines.push("Context:");
  lines.push(location.context || "-", "");

  lines.push("PD Array:", "");
  pushPdArray(lines, bias.pdArray);
  lines.push("");

  lines.push("Market Bias:");
  lines.push(`${biasIcon(bias.bias)} ${bias.bias}`, "");
  lines.push("Structure Status:");
  lines.push(`${bias.structureStatus === "INVALIDATED" ? "❌" : "✅"} ${bias.structureStatus}`, "");
  lines.push("Effective Bias:");
  lines.push(`${biasIcon(bias.effectiveBias)} ${bias.effectiveBias}`, "");
  lines.push("Draw Target:");
  if (bias.draw && bias.draw.primary) {
    lines.push(`${bias.draw.primary.type} ${fmtPrice(bias.draw.primary.price)}`, "");
    lines.push("Alternative:");
    if (bias.draw.alternatives.length) {
      for (const a of bias.draw.alternatives) lines.push(`${a.type} ${fmtPrice(a.price)}`);
    } else {
      lines.push("-");
    }
    lines.push("");
    lines.push("Reason:");
    lines.push(bias.draw.primary.reason);
  } else {
    lines.push("-");
  }
  lines.push("");
  lines.push("Execution:");
  lines.push(bias.executionState || "-", "");
  lines.push("");

  lines.push("Invalidation:", "");
  lines.push(bias.invalidation ? formatInvalidation(bias.invalidation) : "-");
  lines.push("");

  // V2.1：Bias Explanation Chain（替代旧 Reason 区块）
  lines.push("Bias Explanation:", "");
  if (bias.explanation && bias.explanation.length) {
    bias.explanation.forEach((item, i) => {
      lines.push(`${i + 1}. ${item.component}:`);
      item.lines.forEach((l) => lines.push(`   ${l}`));
      lines.push("");
    });
  } else {
    lines.push("-", "");
  }

  // V2.0：Scenario（HTF 参照）+ V2.3 Confidence（score + level + factors）
  lines.push("Scenario:", "");
  lines.push(bias.scenario ? bias.scenario.label : "-", "");
  lines.push("Confidence:", "");
  if (bias.confidence) {
    lines.push(`${bias.confidence.level} (score ${bias.confidence.score})`);
    if (bias.confidence.factors && bias.confidence.factors.length) {
      lines.push("Factors:");
      for (const f of bias.confidence.factors) {
        lines.push(`   ${String(f.value).padEnd(16)} ${f.name}`);
      }
    }
  } else {
    lines.push("-");
  }
  lines.push("");

  // V2.5：Decision Layer（Opportunity = Confidence × planR → Tradeability / Decision）
  lines.push("Opportunity:");
  lines.push(bias.decision ? `${bias.decision.opportunity} / 100` : "-");
  lines.push("Plan R:");
  lines.push(bias.decision && bias.decision.planR != null ? Number(bias.decision.planR.toFixed(2)) : "-");
  lines.push("Tradeability:");
  lines.push(bias.decision ? bias.decision.tradeability : "-", "");
  lines.push("Decision:");
  lines.push(bias.decision ? bias.decision.decision : "-");
  lines.push("Reason:");
  lines.push(bias.decision ? bias.decision.reason : "-", "");

  lines.push(LINE);

  return lines.join("\n");
}

/** P1-B：MSS / BOS 状态（Internal/External 分层 + 最近事件） */
function pushMssBos(lines, mss) {
  if (!mss) {
    lines.push("-", "");
    return;
  }
  const int = mss.structureLayer && mss.structureLayer.internal;
  const ext = mss.structureLayer && mss.structureLayer.external;
  lines.push("Internal:");
  const intParts = [];
  if (int) {
    intParts.push(int.trend || "-");
    if (int.protectedLow != null) intParts.push(`protectedLow ${fmtPrice(int.protectedLow)}`);
    if (int.protectedHigh != null) intParts.push(`protectedHigh ${fmtPrice(int.protectedHigh)}`);
  }
  lines.push(intParts.length ? intParts.join(" · ") : "-", "");
  lines.push("External:");
  lines.push(ext ? `high ${fmtPrice(ext.high)} / low ${fmtPrice(ext.low)}` : "-", "");
  const ev = mss.lastEvent;
  lines.push("Event:");
  lines.push(ev ? `${ev.type} ${ev.direction} @ ${fmtPrice(ev.level)} (${ev.levelType})` : "-");
  lines.push("");
}

function pushPdArray(lines, ranked) {
  const p = ranked && ranked.primary;
  if (!p) {
    lines.push("Primary:", "-");
    return;
  }
  lines.push("Primary:");
  lines.push(`${pdName(p.type)} ${p.type.includes("FVG") ? `${fmtPrice(p.bottom)}-${fmtPrice(p.top)}` : fmtPrice(p.price)}`);
  lines.push("Location:");
  lines.push(p.location || "-");
  lines.push("Status:");
  lines.push(p.status, "");

  if (ranked.alternatives.length) {
    lines.push("Alternative:");
    for (const a of ranked.alternatives) {
      lines.push(`${pdName(a.type)} ${a.type.includes("FVG") ? `${fmtPrice(a.bottom)}-${fmtPrice(a.top)}` : fmtPrice(a.price)}`);
    }
  }
}

function pdName(type) {
  return {
    BULLISH_FVG: "Bullish FVG",
    BEARISH_FVG: "Bearish FVG",
    BULLISH_OB: "Bullish OB",
    BEARISH_OB: "Bearish OB",
  }[type] || type;
}

function formatInvalidation(inv) {
  const meta = inv.source ? ` [${inv.invalidationType} · ${inv.source}]` : "";
  if (inv.type === "BREAK_PROTECTED_LOW") return `Break Protected Low ${fmtPrice(inv.price)}${meta}`;
  if (inv.type === "BREAK_PROTECTED_HIGH") return `Break Protected High ${fmtPrice(inv.price)}${meta}`;
  return "-";
}

function fmtPrice(n) {
  if (n == null) return "-";
  if (Number.isInteger(n)) return String(n);
  return String(Number(n.toFixed(2)));
}

function directionName(d) {
  return { BULLISH: "Bullish", BEARISH: "Bearish", NEUTRAL: "Neutral" }[d] || d;
}

function locationName(l) {
  return { PREMIUM: "Premium", DISCOUNT: "Discount", AT_EQ: "At Equilibrium", UNKNOWN: "Unknown" }[l] || l;
}

function biasIcon(b) {
  return { BULLISH: "🟢", BEARISH: "🔴", NEUTRAL: "⚪" }[b] || "";
}
