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
import { computeLiquidity } from "../indicators/liquidity.js";
import { computeDealingRange } from "../indicators/dealingRange.js";
import { findFvgs, findOrderBlocks, annotatePDArray } from "../indicators/pdArray.js";
import { computeHtfDirection } from "../indicators/scenario.js";
import { lastTradingWeek, computeActiveWindows, killzoneOfK } from "../indicators/killzone.js";
import { computeDailyBias } from "./dailyBiasEngine.js";

/**
 * @param {Object} p
 * @param {Array}  p.candles  4H K 线（已按分析时刻截断，末根为当前判定基准）
 * @param {Array}  p.daily    日线 K 线（可传完整历史，内部按 time 截断）
 * @param {Array}  p.weekly   周线 K 线（可传完整历史，内部按 time 截断）
 * @param {number} p.price    当前价（4H 收盘 / 实时价）
 * @param {number} p.time     分析时刻（ms，取 closeTime <= time 的已收盘日/周 K；回放 = 4H 收盘点）
 * @param {number} [p.analysisTime] 实时模式的流动性截断时刻（ms）＝当前最近已收盘 5m 的 closeTime。
 *                            日/周/盘前流动性用它截断；不传（回放/审计）→ 回退 time（4H 收盘点）。
 *                            避免盘前区间只统计到上一根已收盘 4H 的结束时间（如 21:30 漏掉 20:00-21:00
 *                            这根已收盘 1H K）。结构/FVG/OB 仍只用 candles（已收盘 4H），不受影响。
 * @param {Array}  [p.h1]     1h K 线（可选，数据驱动 Killzone：上周交易周成交量 → 活跃窗口）。
 *                            传入后统一计算 session（Killzone 标注 + confidence 时机因子）；
 *                            不传（回放/审计）→ session null，无 Killzone 因子，行为不变。
 * @param {number} [p.pdArrayLimit=6] PD Array（FVG/OB）截取数量
 * @param {Object} [p.sessionCandle] 仅用于 Session（活跃窗口）判定的参考 K：传当前进行中 4H
 *   （取其时间范围 [openTime, closeTime)），避免用"上一根已收盘 4H"判断导致最多 4 小时的
 *   窗口滞后。它只提供时间范围，绝不参与 Structure/FVG/OB（那些仍只用 candles）。
 *   不传（回放/审计）→ 回退 candles 末根，行为不变。
 * @returns {{ structure, liquidity, location, pdArray, htfDirection, session, bias }}
 */
export function analyzeBias({ candles, daily, weekly, price, time, analysisTime, h1, pdArrayLimit = 6, sessionCandle }) {
  // P1：日/周/盘前流动性截断时刻与结构参考时刻拆分——结构只用已收盘 4H（candles），
  // 流动性截断用 analysisTime（实时 = 最近已收盘 5m 的 closeTime），回放回退 time（4H 收盘点）。
  const cutoff = analysisTime ?? time;
  const day = daily.filter((c) => c.closeTime <= cutoff);
  const week = weekly.filter((c) => c.closeTime <= cutoff);

  const swings = findSwings(candles);
  const labeled = analyzeSwings(swings);
  const structure = buildStructure(labeled);
  const liquidity = computeLiquidity(day, week, swings, 0.002, cutoff, 150, h1);
  const location = computeDealingRange(swings, structure, price);
  const fvgs = findFvgs(candles);
  const obs = findOrderBlocks(candles);
  const pdArray = annotatePDArray({ fvg: fvgs.slice(-pdArrayLimit), ob: obs.slice(-pdArrayLimit) }, location, candles);
  const htfDirection = computeHtfDirection(day, week, price);
  // Session（数据驱动 Killzone）：上周交易周（周一~五）1h 成交量 → 活跃窗口 →
  // 当前 4H 覆盖的最长重叠窗口。参考 K 用 sessionCandle（当前进行中 4H 的时间范围）——
  // 若用已收盘 4H 末根，21:30 会拿 16:00–20:00 那根判断窗口，Session +10 / 活跃窗口展示
  // 全部滞后最多 4 小时；进行中 K 只取其时间范围，不参与结构。h1 不传/数据不足 → null。
  let session = null;
  if (h1 && h1.length) {
    const wk = lastTradingWeek(h1);
    if (wk.length >= 24) {
      const sessionRef = sessionCandle || candles[candles.length - 1];
      session = killzoneOfK(sessionRef, computeActiveWindows(wk));
    }
  }
  const bias = computeDailyBias({ structure, liquidity, location, price, pdArray, htfDirection, session });

  return { structure, liquidity, location, pdArray, htfDirection, session, bias };
}
