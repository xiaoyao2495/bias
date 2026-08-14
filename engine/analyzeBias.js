/**
 * analyzeBias.js — 共用 Bias 分析函数（biasMonitor 实时监控 与 historicalScanner 回放 共用）
 *
 * 组合指标层（swing / structure / liquidity / dealingRange / pdArray / scenario）+ engine，
 * 消除两处"拉数据 → 结构 → Bias"链路的重复实现（审计 m3）。
 *
 * 行为约定（保证 实时 与 回放 完全一致）：
 *   - 内部统一按 time 截断日/周线：computeHtfDirection 要求调用方预截断，
 *     实时模式若传完整日线会用"进行中的最新日 K"（未定型），与回放不一致；
 *     统一截断后 HTF 方向只认已收盘日/周 K，实时性由 price（4H 收盘价）的 BOS 修正注入。
 *   - computeLiquidity 自身按 now 过滤（lastCompleted），传截断数组幂等安全。
 */
import { findSwings, analyzeSwings } from "../indicators/swing.js";
import { buildStructure } from "../indicators/structure.js";
import { computeLiquidity, liquidityStateForLevel } from "../indicators/liquidity.js";
import { computeDealingRange } from "../indicators/dealingRange.js";
import { findFvgs, findOrderBlocks, annotatePDArray } from "../indicators/pdArray.js";
import { computeHtfContext } from "../indicators/scenario.js";
import { lastTradingWeek, computeActiveWindows, activeVolumeWindowAt, ictSessionAt } from "../indicators/killzone.js";
import { scanStructureEvents } from "../indicators/mss.js";
import { computeDailyBias } from "./dailyBiasEngine.js";

/**
 * @param {Object} p
 * @param {Array}  p.candles  4H K 线（已按分析时刻截断，末根为当前判定基准）
 * @param {Array}  p.daily    日线 K 线（可传完整历史，内部按 time 截断）
 * @param {Array}  p.weekly   周线 K 线（可传完整历史，内部按 time 截断）
 * @param {number} p.price    执行参考价（实盘=最近已收盘 5m；回放=4H 收盘）
 * @param {number} [p.structurePrice] 4H 结构确认价（必须是已收盘 4H close）；不传则回退 price
 * @param {number} p.time     分析时刻（ms，取 closeTime <= time 的已收盘日/周 K；回放 = 4H 收盘点）
 * @param {number} [p.analysisTime] 实时模式的流动性截断时刻（ms）＝当前最近已收盘 5m 的 closeTime。
 *                            日/周/盘前流动性与活跃窗口用它截断；不传（回放/审计）→ 回退 time。
 * @param {Array}  [p.h1]     1h K 线（可选，上周交易周成交量 → 数据驱动活跃窗口）。
 *                            传入后计算 activeVolumeWindow；不传则该统计因子为空。
 * @param {number} [p.pdArrayLimit=6] PD Array（FVG/OB）截取数量
 * @param {Array}  [p.m5]     5m K 线（可选，仅美股关联标的用于精确计算盘前 04:00-09:30 ET）。
 * @param {string} [p.symbol] 合约代码；用于显式限定 PRE_MARKET 流动性的资产范围。
 * @returns {{ structure, liquidity, location, pdArray, htfDirection, htfContext, activeVolumeWindow, ictSession, session, bias }}
 */
export function analyzeBias({ candles, daily, weekly, price, structurePrice, time, analysisTime, h1, m5, symbol, pdArrayLimit = 6 }) {
  // P1：日/周/盘前流动性截断时刻与结构参考时刻拆分——结构只用已收盘 4H（candles），
  // 流动性截断用 analysisTime（实时 = 最近已收盘 5m 的 closeTime），回放回退 time（4H 收盘点）。
  const cutoff = analysisTime ?? time;
  const day = daily.filter((c) => c.closeTime <= cutoff);
  const week = weekly.filter((c) => c.closeTime <= cutoff);

  const swings = findSwings(candles);
  const labeled = analyzeSwings(swings);
  const structure = buildStructure(labeled);
  const liquidity = computeLiquidity(day, week, swings, 0.002, cutoff, 150, m5, candles, { symbol });
  annotateStructureLiquidityStates(structure, candles);
  const location = computeDealingRange(swings, structure, price, liquidity);
  const fvgs = findFvgs(candles);
  const obs = findOrderBlocks(candles);
  const pdArray = annotatePDArray({ fvg: fvgs.slice(-pdArrayLimit), ob: obs.slice(-pdArrayLimit) }, location, candles);
  const htfContext = computeHtfContext(day, week, price);
  const htfDirection = htfContext.confirmedDirection;
  const reversalEvidence = findReversalEvidence(candles, structure, liquidity);
  // 数据驱动活跃窗口只按“当前分析时刻”命中，不能拿整根进行中 4H 的覆盖范围判断，
  // 否则 20:10 会因该 K 将在 21:00 覆盖活跃窗口而提前获得评分。
  let activeVolumeWindow = null;
  if (h1 && h1.length) {
    const wk = lastTradingWeek(h1, cutoff);
    if (wk.length >= 24) {
      activeVolumeWindow = activeVolumeWindowAt(cutoff, computeActiveWindows(wk));
    }
  }
  const ictSession = ictSessionAt(cutoff);
  const session = activeVolumeWindow; // 兼容旧 state/消息；新代码应读取 activeVolumeWindow
  const bias = computeDailyBias({
    structure,
    liquidity,
    location,
    price,
    structurePrice: structurePrice ?? price,
    pdArray,
    htfDirection,
    htfContext,
    reversalEvidence,
    ictSession,
  });

  return { structure, liquidity, location, pdArray, htfDirection, htfContext, activeVolumeWindow, ictSession, session, bias };
}

function annotateStructureLiquidityStates(structure, candles) {
  const closeAt = (index, time) => {
    const k = index != null ? candles[index] : null;
    return k ? k.closeTime ?? k.time : time;
  };
  if (structure.externalSwingHigh != null) {
    structure.externalSwingHighState = liquidityStateForLevel(
      { price: structure.externalSwingHigh },
      true,
      candles,
      closeAt(structure.externalSwingHighIndex, structure.externalSwingHighTime)
    );
  }
  if (structure.externalSwingLow != null) {
    structure.externalSwingLowState = liquidityStateForLevel(
      { price: structure.externalSwingLow },
      false,
      candles,
      closeAt(structure.externalSwingLowIndex, structure.externalSwingLowTime)
    );
  }
  if (structure.lastHigh) {
    structure.lastHighState = liquidityStateForLevel(
      { price: structure.lastHigh.price },
      true,
      candles,
      closeAt(structure.lastHigh.index, structure.lastHigh.time)
    );
  }
  if (structure.lastLow) {
    structure.lastLowState = liquidityStateForLevel(
      { price: structure.lastLow.price },
      false,
      candles,
      closeAt(structure.lastLow.index, structure.lastLow.time)
    );
  }
}

/** HTF 冲突时，只有“反向流动性已扫 + 4H 位移 MSS”才确认反转 Narrative。 */
export function findReversalEvidence(candles, structure, liquidity) {
  const direction = structure.direction;
  if (direction !== "BULLISH" && direction !== "BEARISH") return { confirmed: false, sweep: null, mss: null };
  const levels = direction === "BULLISH" ? [...(liquidity.sellSide || [])] : [...(liquidity.buySide || [])];
  const extState = direction === "BULLISH" ? structure.externalSwingLowState : structure.externalSwingHighState;
  if (extState && extState.state === "SWEPT") {
    levels.push({ type: direction === "BULLISH" ? "EXTERNAL_LOW" : "EXTERNAL_HIGH", ...extState });
  }
  const swept = levels
    .filter((x) => x.state === "SWEPT")
    .sort((a, b) => (b.sweptAt || 0) - (a.sweptAt || 0))[0] || null;
  if (!swept) return { confirmed: false, sweep: null, mss: null };

  const expected = direction === "BULLISH" ? "UP" : "DOWN";
  const events = scanStructureEvents(candles, { lookback: 50, left: 2, right: 2 });
  const mss = [...events]
    .reverse()
    .find((e) => e.type === "MSS" && e.direction === expected && e.confirmedByDisplacement && e.time >= swept.sweptAt) || null;
  return { confirmed: !!mss, sweep: swept, mss };
}
