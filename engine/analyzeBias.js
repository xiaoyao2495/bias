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
 * @param {number} p.time     分析时刻（ms，取 closeTime <= time 的已收盘日/周 K）
 * @param {Array}  [p.h1]     1h K 线（可选，数据驱动 Killzone：上周交易周成交量 → 活跃窗口）。
 *                            传入后统一计算 session（Killzone 标注 + confidence 时机因子）；
 *                            不传（回放/审计）→ session null，无 Killzone 因子，行为不变。
 * @param {number} [p.pdArrayLimit=6] PD Array（FVG/OB）截取数量
 * @returns {{ structure, liquidity, location, pdArray, htfDirection, session, bias }}
 */
export function analyzeBias({ candles, daily, weekly, price, time, h1, pdArrayLimit = 6 }) {
  const day = daily.filter((c) => c.closeTime <= time);
  const week = weekly.filter((c) => c.closeTime <= time);

  const swings = findSwings(candles);
  const labeled = analyzeSwings(swings);
  const structure = buildStructure(labeled);
  const liquidity = computeLiquidity(day, week, swings, 0.002, time, 150, h1);
  const location = computeDealingRange(swings, structure, price);
  const fvgs = findFvgs(candles);
  const obs = findOrderBlocks(candles);
  const pdArray = annotatePDArray({ fvg: fvgs.slice(-pdArrayLimit), ob: obs.slice(-pdArrayLimit) }, location, candles);
  const htfDirection = computeHtfDirection(day, week, price);
  // Session（数据驱动 Killzone）：上周交易周（周一~五）1h 成交量 → 活跃窗口 →
  // 当前 4H K（candles 末根）覆盖的最长重叠窗口；h1 不传/数据不足 → null（非 Killzone）
  let session = null;
  if (h1 && h1.length) {
    const wk = lastTradingWeek(h1);
    if (wk.length >= 24) {
      session = killzoneOfK(candles[candles.length - 1], computeActiveWindows(wk));
    }
  }
  const bias = computeDailyBias({ structure, liquidity, location, price, pdArray, htfDirection, session });

  return { structure, liquidity, location, pdArray, htfDirection, session, bias };
}
