/**
 * biasMonitor.js — Monitor Step 2：对给定 symbol 列表跑 Daily Bias Engine
 *
 * 每个 symbol 用与 Historical Scanner 完全相同的流程：
 *   拉 4H/1D/1W 历史（已收盘 K）→ 结构/流动性/区间/PD Array/HTF 方向
 *   → computeDailyBias → 输出简洁摘要（Structure/Bias/Scenario/Confidence/Quality/Decision）
 *
 * 实时版没有未来窗口，Quality 用 planR（理论盈亏比 = |Draw−Entry|/Risk）分级代理：
 *   planR >= 1  → HIGH（空间充足）
 *   0.5 ~ 1     → MEDIUM（空间一般）
 *   < 0.5       → LOW（空间不足，接近目标）
 *   NEUTRAL/无 draw → "-"
 *
 * 决策简化为钉钉友好标签（保留原始值供 state 比较）：
 *   WATCH_FOR_ENTRY → WATCH（值得关注入场）
 *   WAIT_FOR_RETRACEMENT → WAIT（等回撤）
 *   NO_TRADE → NO TRADE
 *   WAIT → WAIT
 *
 * 用法（CLI 验证）：
 *   node monitor/biasMonitor.js BTCUSDT ETHUSDT SOLUSDT
 */
import { getHistory, getKlines } from "../data/binance.js";
import { findSwings, analyzeSwings } from "../indicators/swing.js";
import { buildStructure } from "../indicators/structure.js";
import { computeLiquidity } from "../indicators/liquidity.js";
import { computeDealingRange } from "../indicators/dealingRange.js";
import { findFvgs, findOrderBlocks, annotatePDArray } from "../indicators/pdArray.js";
import { computeHtfDirection } from "../indicators/scenario.js";
import { detectSweeps } from "../indicators/sweep.js";
import { findDisplacements } from "../indicators/displacement.js";
import { computeDailyBias } from "../engine/dailyBiasEngine.js";
import { pathToFileURL } from "node:url";

// 与 scanner/replayCase 同款数据窗口：4H 5000 根 ≈ 830 天，1D/1W 供 HTF 方向
const HISTORY = { "4h": 5000, "1d": 2000, "1w": 400 };

/**
 * 对单个 symbol 跑一次 Bias 分析，返回简洁摘要。
 * @param {string} symbol 如 "BTCUSDT"
 * @returns {Promise<Object>} 摘要对象（字段见 analyzeSymbol 返回）
 */
export async function analyzeSymbol(symbol) {
  const [h4, daily, weekly, m5] = await Promise.all([
    getHistory(symbol, "4h", HISTORY["4h"]),
    getHistory(symbol, "1d", HISTORY["1d"]),
    getHistory(symbol, "1w", HISTORY["1w"]),
    // 5m 用于流动性扫损/位移检测（辅助信息，缓存 TTL 5 分钟）；拉取失败降级为 []，
    // 不阻断主分析（否则 5m 抖动会导致整个合约分析失败）
    getKlines(symbol, "5m", 100).catch(() => []),
  ]);

  if (!h4.length) throw new Error(`${symbol} 无 4H 数据`);
  const lastK = h4[h4.length - 1];
  // 收盘报告需要"最后已收盘 4H"（最后一根若未收盘则取上一根），用于展示收于开盘上方/下方
  const lastClosed = lastK.closeTime <= Date.now() ? lastK : h4[h4.length - 2] || lastK;
  const price4h = lastK.close; // 4H 末根收盘价（缓存下最多陈旧 4 小时）
  const time = lastK.closeTime;
  // 核心判定与展示用实时价：5m 末根 close（进行中 5m 的 close = 当前最新成交价，TTL 5 分钟）。
  // 修复 major：直接拿 4H 收盘价判结构失效/MSS/confidence/planR，最多延迟 4 小时才报；
  // 5m 拉取失败时回退 4H 收盘价。
  const price5m = m5.length ? m5[m5.length - 1].close : null;
  const price = price5m ?? price4h;

  const swings = findSwings(h4);
  const labeled = analyzeSwings(swings);
  const structure = buildStructure(labeled);
  const liquidity = computeLiquidity(daily, weekly, swings, 0.002, time);
  const location = computeDealingRange(swings, structure, price);
  const fvgs = findFvgs(h4);
  const obs = findOrderBlocks(h4);
  const pdArray = annotatePDArray({ fvg: fvgs.slice(-6), ob: obs.slice(-6) }, location, h4);
  const htfDirection = computeHtfDirection(daily, weekly, price);
  const bias = computeDailyBias({ structure, liquidity, location, price, pdArray, htfDirection });

  // P1-A：流动性扫损（5m K 线：进行中 5m 实时检测 + 最近 48 根已收盘 5m 确认，≈4 小时窗口）
  // 用 5m 粒度：扫损是分钟级价格行为（刺破流动性后收回），4H 单根 K 会把整个过程包住，粒度过粗
  const buyLevels = (liquidity.buySide || []).concat(
    structure.externalSwingHigh != null ? [{ type: "EXTERNAL_HIGH", price: structure.externalSwingHigh }] : []
  );
  const sellLevels = (liquidity.sellSide || []).concat(
    structure.externalSwingLow != null ? [{ type: "EXTERNAL_LOW", price: structure.externalSwingLow }] : []
  );
  const sweep = detectSweeps(m5, buyLevels, sellLevels, price5m, 48);

  // P1-C：位移 K（5m 粒度：最近 48 根 5m ≈ 4 小时内出现位移 K，用于收盘报告标注）
  const dispList = findDisplacements(m5);
  const lastDisp = dispList.length ? dispList[dispList.length - 1] : null;
  const displacement =
    lastDisp && m5[m5.length - 1].closeTime - lastDisp.time <= 48 * 5 * 60_000
      ? { time: lastDisp.time, direction: lastDisp.direction, ratio: lastDisp.ratio }
      : null;

  const decision = bias.decision || {};
  const planR = decision.planR ?? null;
  const quality = planR == null ? "-" : planR >= 1 ? "HIGH" : planR >= 0.5 ? "MEDIUM" : "LOW";

  return {
    symbol,
    time: new Date(time).toISOString().slice(0, 16).replace("T", " "),
    price,
    // 最后已收盘 4H（收盘报告用：收于开盘上方/下方）
    last4h: { open: lastClosed.open, close: lastClosed.close, time: lastClosed.closeTime },
    // 用有效方向（结构失效 → NEUTRAL），避免显示"已过期的旧结构方向"误导
    bias: bias.effectiveBias || bias.bias,
    structureStatus: bias.structureStatus,
    invalidation: bias.invalidation || null, // { type, price }：结构失效时用于解释"突破哪个保护位"
    mss: bias.mss
      ? { ...bias.mss, time: new Date(time).toISOString().slice(0, 16).replace("T", " ") } // MSS 事件：方向/保护位/触发时间
      : null,
    scenario: bias.scenario ? bias.scenario.label : "-",
    confidence: bias.confidence ? bias.confidence.level : "-",
    confidenceScore: bias.confidence ? bias.confidence.score : null,
    sweep, // { side, type, level, sweptPrice, close, time } | null（流动性扫损事件）
    displacement, // { time, direction, ratio } | null（位移 K，最近 3 根内）
    quality,
    planR,
    decision: decision.decision || "-",
    decisionLabel: decisionLabel(decision.decision),
    reason: decision.reason || "-",
    execution: bias.executionState || "-",
    location: location.location,
    context: location.context || "-",
  };
}

/** 对多个 symbol 串行分析（避免 Binance 限频），返回摘要数组 */
export async function analyzeSymbols(symbols, { onProgress } = {}) {
  const results = [];
  for (let i = 0; i < symbols.length; i++) {
    const s = symbols[i];
    try {
      results.push(await analyzeSymbol(s));
    } catch (e) {
      results.push({ symbol: s, error: e.message });
    }
    if (onProgress) onProgress(i + 1, symbols.length);
  }
  return results;
}

function decisionLabel(d) {
  return {
    WATCH_FOR_ENTRY: "WATCH",
    WAIT_FOR_RETRACEMENT: "WAIT",
    NO_TRADE: "NO TRADE",
    WAIT: "WAIT",
  }[d] || d || "-";
}

/** CLI：node monitor/biasMonitor.js BTCUSDT ETHUSDT SOLUSDT */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const symbols = process.argv.slice(2);
  if (!symbols.length) {
    console.error("用法: node monitor/biasMonitor.js <SYMBOL>... （如 BTCUSDT ETHUSDT SOLUSDT）");
    process.exit(1);
  }
  const icon = { BULLISH: "🟢", BEARISH: "🔴", NEUTRAL: "⚪" };
  analyzeSymbols(symbols, { onProgress: (n, t) => console.error(`[monitor] ${n}/${t}`) })
    .then((list) => {
      for (const r of list) {
        if (r.error) {
          console.log(`${r.symbol}\n  ERROR: ${r.error}\n`);
          continue;
        }
        console.log(`${r.symbol}  ${r.price}`);
        console.log(`Bias: ${icon[r.bias] || ""} ${r.bias}`);
        console.log(`Scenario: ${r.scenario}`);
        console.log(`信心度: ${r.confidence}${r.confidenceScore != null ? ` ${r.confidenceScore}` : ""}`);
        console.log(`机会质量: ${r.quality}${r.planR != null ? ` (planR ${r.planR.toFixed(2)})` : ""}`);
        console.log(`操作: ${r.decisionLabel}`);
        console.log(`原因: ${r.reason}`);
        console.log(`Execution: ${r.execution} @ ${r.location}/${r.context}\n`);
      }
    })
    .catch((e) => {
      console.error(`[monitor] 失败: ${e.message}`);
      process.exit(1);
    });
}
