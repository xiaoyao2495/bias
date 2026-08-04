/**
 * analyze.js — 入口：拉取 4H/日/周 K 线 → 各 indicator → Daily Bias → 打印报告
 *
 * 用法：
 *   node scripts/analyze.js BTCUSDT [limit]
 */
import { get4hKlines, getDailyKlines, getWeeklyKlines } from "../data/binance.js";
import { findSwings, analyzeSwings } from "../indicators/swing.js";
import { buildStructure } from "../indicators/structure.js";
import { computeLiquidity } from "../indicators/liquidity.js";
import { computeDealingRange } from "../indicators/dealingRange.js";
import { findFvgs, findOrderBlocks, annotatePDArray } from "../indicators/pdArray.js";
import { computeDailyBias } from "../engine/dailyBiasEngine.js";
import { formatReport } from "../report/formatter.js";

const symbol = process.argv[2] || "BTCUSDT";
const limit = Number(process.argv[3]) || 500;

async function main() {
  console.error(`正在获取 ${symbol} 数据...`);

  const [candles4h, daily, weekly] = await Promise.all([
    get4hKlines(symbol, limit),
    getDailyKlines(symbol, 30),
    getWeeklyKlines(symbol, 10),
  ]);

  const price = candles4h[candles4h.length - 1].close;

  // 1. Structure
  const swings = findSwings(candles4h);
  const labeled = analyzeSwings(swings);
  const structure = buildStructure(labeled);

  // 2. Liquidity
  const liquidity = computeLiquidity(daily, weekly, swings);

  // 3. Dealing Range（External Range V1：按结构方向取推动段）
  const location = computeDealingRange(swings, structure, price);

  // 4. PD Array（V1.6：标注执行属性，作为执行区域，不参与 bias 判定）
  const fvgs = findFvgs(candles4h);
  const obs = findOrderBlocks(candles4h);
  const pdArray = annotatePDArray(
    { fvg: fvgs.slice(-6), ob: obs.slice(-6) },
    location,
    candles4h
  );

  // 5. Daily Bias
  const bias = computeDailyBias({ structure, liquidity, location, price, pdArray });

  console.log(formatReport({ symbol, structure, liquidity, location, pdArray, bias }));
}

main().catch((e) => {
  console.error(`分析失败: ${e.message}`);
  process.exit(1);
});
