/**
 * auditCases.js — V1.7 Final Audit（只审计，不改逻辑）
 *
 * 遍历 cases/manifest.json 中全部案例，重新回放分析，输出：
 *   1. 控制台人工检查表（Structure / Liquidity / Location / PD Array / Bias / Invalidation）
 *   2. cases/audit.json（humanReview=false，待人工逐例确认）
 *
 * 自动判定只做基础一致性检查（PASS / REVIEW），真正的 ICT 判断留给人工。
 *   - locationCheck：Range 跨度 > 100% 会标 REVIEW（风险 1：范围过大）
 *   - liquidityCheck：primary 为 EXTERNAL_* 会附 note（风险 2：是否更该重视 PWH/PWL）
 *   - pdArrayCheck：记录 Primary 是 FVG 还是 OB（风险 3：优先级待确认）
 *
 * 用法：
 *   node scripts/auditCases.js
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { getHistory } from "../data/binance.js";
import { findSwings, analyzeSwings } from "../indicators/swing.js";
import { buildStructure } from "../indicators/structure.js";
import { computeLiquidity } from "../indicators/liquidity.js";
import { computeDealingRange } from "../indicators/dealingRange.js";
import { findFvgs, findOrderBlocks, annotatePDArray } from "../indicators/pdArray.js";
import { computeHtfDirection } from "../indicators/scenario.js";
import { computeDailyBias } from "../engine/dailyBiasEngine.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CASES_DIR = join(__dirname, "..", "cases");
const HISTORY = { "4h": 3000, "1d": 2000, "1w": 400 };

const manifest = JSON.parse(readFileSync(join(CASES_DIR, "manifest.json"), "utf8"));

function sliceToTime(candles, time) {
  return candles.filter((k) => k.closeTime <= time);
}

/** 与 replayCase.js 完全相同的回放分析流程 */
async function analyzeOne(symbol, replayTime) {
  const [h4, daily, weekly] = await Promise.all([
    getHistory(symbol, "4h", HISTORY["4h"]),
    getHistory(symbol, "1d", HISTORY["1d"]),
    getHistory(symbol, "1w", HISTORY["1w"]),
  ]);
  const candles4h = sliceToTime(h4, replayTime);
  const day = sliceToTime(daily, replayTime);
  const week = sliceToTime(weekly, replayTime);

  const price = candles4h[candles4h.length - 1].close;
  const swings = findSwings(candles4h);
  const labeled = analyzeSwings(swings);
  const structure = buildStructure(labeled);
  const liquidity = computeLiquidity(day, week, swings, 0.002, replayTime);
  const location = computeDealingRange(swings, structure, price);
  const fvgs = findFvgs(candles4h);
  const obs = findOrderBlocks(candles4h);
  const pdArray = annotatePDArray({ fvg: fvgs.slice(-6), ob: obs.slice(-6) }, location, candles4h);
  const htfDirection = computeHtfDirection(day, week, price);
  const bias = computeDailyBias({ structure, liquidity, location, price, pdArray, htfDirection });
  return { symbol, replayTime, price, structure, liquidity, location, bias };
}

function audit(r) {
  const { structure, liquidity, location, bias, price } = r;
  const span = location.high != null && location.low != null ? (location.high - location.low) / price : null;

  const structureCheck = {
    status: "PASS",
    direction: structure.direction,
    type: structure.type,
    sequence: structure.sequence.join(" → "),
    protectedLow: structure.protectedLow,
    protectedHigh: structure.protectedHigh,
  };

  const draw = bias.draw && bias.draw.primary;
  const liquidityCheck = {
    status: bias.bias === "NEUTRAL" || draw ? "PASS" : "REVIEW",
    primaryDraw: draw ? `${draw.type} ${draw.price}` : null,
    alternatives: bias.draw ? bias.draw.alternatives.map((a) => `${a.type} ${a.price}`) : [],
    note: draw && draw.type.startsWith("EXTERNAL") ? "Primary 为外部结构位，人工确认是否更应重视 PWH/PWL（风险 2）" : null,
  };

  const locationCheck = {
    status: span != null && span > 1.0 ? "REVIEW" : "PASS",
    range: location.high != null ? `${location.low} - ${location.high}` : null,
    current: price,
    location: location.location,
    context: location.context || null,
    rangeType: location.rangeType,
    note: span != null && span > 1.0 ? `Range 跨度 ${Math.round(span * 100)}% > 100%，人工确认 ICT 是否使用如此大的 dealing range（风险 1）` : null,
  };

  const p = bias.pdArray && bias.pdArray.primary;
  const pdArrayCheck = {
    status: bias.bias === "NEUTRAL" || p ? "PASS" : "REVIEW",
    primary: p ? `${p.type} ${p.price} (${p.location}, ${p.status})` : null,
    note: p ? `Primary 为 ${p.type.includes("FVG") ? "FVG" : "OB"}，FVG/OB 优先级待人工确认（风险 3）` : "同向顺位无 VALID 执行区域（可能全在逆位或已填充）",
  };

  const finalBias = {
    bias: bias.bias,
    effectiveBias: bias.effectiveBias,
    execution: bias.executionState,
    invalidation: bias.invalidation ? `${bias.invalidation.type} ${bias.invalidation.price} [${bias.invalidation.source}]` : null,
  };

  // V2.0：Scenario（HTF 参照）+ Confidence（硬门槛+3 项加分）
  const scenarioCheck = {
    state: bias.scenario ? bias.scenario.state : null,
    label: bias.scenario ? bias.scenario.label : null,
    htfDirection: bias.scenario ? bias.scenario.htfDirection : null,
  };
  const confidenceCheck = {
    level: bias.confidence ? bias.confidence.level : null,
    score: bias.confidence ? bias.confidence.score : null,
    checks: bias.confidence ? bias.confidence.checks : null,
  };

  return {
    symbol: r.symbol,
    date: new Date(r.replayTime).toISOString().slice(0, 10),
    structureCheck,
    liquidityCheck,
    locationCheck,
    pdArrayCheck,
    finalBias,
    scenarioCheck,
    confidenceCheck,
    humanReview: false,
  };
}

function printChecklist(a) {
  const out = [];
  out.push("=".repeat(40));
  out.push(`${a.symbol} ${a.date}`);
  out.push("");
  out.push("① Structure");
  out.push(`   方向: ${a.structureCheck.direction}`);
  out.push(`   类型: ${a.structureCheck.type}`);
  out.push(`   序列: ${a.structureCheck.sequence}`);
  out.push(`   评价: ${a.structureCheck.status}`);
  out.push("");
  out.push("② Liquidity");
  out.push(`   Primary Draw: ${a.liquidityCheck.primaryDraw || "-"}`);
  if (a.liquidityCheck.alternatives.length) out.push(`   Alternative: ${a.liquidityCheck.alternatives.join(", ")}`);
  out.push(`   评价: ${a.liquidityCheck.status}`);
  if (a.liquidityCheck.note) out.push(`   ⚠ ${a.liquidityCheck.note}`);
  out.push("");
  out.push("③ Location");
  out.push(`   Range: ${a.locationCheck.range || "-"}`);
  out.push(`   Current: ${a.locationCheck.current}`);
  out.push(`   Location: ${a.locationCheck.location}`);
  out.push(`   Context: ${a.locationCheck.context || "-"}`);
  out.push(`   评价: ${a.locationCheck.status}`);
  if (a.locationCheck.note) out.push(`   ⚠ ${a.locationCheck.note}`);
  out.push("");
  out.push("④ PD Array");
  out.push(`   Primary: ${a.pdArrayCheck.primary || "-"}`);
  out.push(`   评价: ${a.pdArrayCheck.status}`);
  if (a.pdArrayCheck.note) out.push(`   ⚠ ${a.pdArrayCheck.note}`);
  out.push("");
  out.push("⑤ Bias");
  out.push(`   最终: ${a.finalBias.bias}（effective ${a.finalBias.effectiveBias}，Execution ${a.finalBias.execution}）`);
  out.push("");
  out.push("⑥ Invalidation");
  out.push(`   ${a.finalBias.invalidation || "-"}`);
  out.push("");
  out.push("⑦ Scenario");
  out.push(`   ${a.scenarioCheck.label || "-"}（HTF ${a.scenarioCheck.htfDirection || "-"}）`);
  out.push("");
  out.push("⑧ Confidence");
  out.push(`   ${a.confidenceCheck.level || "-"}（score ${a.confidenceCheck.score ?? "-"} / 100）`);
  if (a.confidenceCheck.checks) {
    out.push(`   检查: ${Object.entries(a.confidenceCheck.checks).map(([k, v]) => `${k}=${v}`).join(" ")}`);
  }
  out.push("");
  console.log(out.join("\n"));
}

async function main() {
  const audits = [];
  for (const c of manifest.cases) {
    const r = await analyzeOne(c.symbol, Date.parse(c.replayTime));
    const a = audit(r);
    audits.push(a);
    printChecklist(a);
  }
  writeFileSync(join(CASES_DIR, "audit.json"), JSON.stringify(audits, null, 2) + "\n");
  console.error(`[audit] 已写入 cases/audit.json（${audits.length} 例，全部 humanReview=false 待人工确认）`);
}

main().catch((e) => {
  console.error(`[audit] 失败: ${e.message}`);
  process.exit(1);
});
