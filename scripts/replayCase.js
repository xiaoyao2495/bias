/**
 * replayCase.js — V1.2 Case Replay
 *
 * 把 Daily Bias Engine 回放到历史某个时间点，输出固定格式报告，
 * 用于对照 ICT 2022 人工判断（Structure / Liquidity / Location / Primary Draw / Bias）。
 *
 * 用法：
 *   node scripts/replayCase.js BTCUSDT 2026-07-01T00:00:00Z [--save]
 *
 * 说明：
 *   - 只使用回放时间之前已收盘的 K 线（closeTime <= replayTime），避免未来函数
 *   - 数据走本地缓存 + 代理（data/binance.js），回放所需长历史自动分页拉取
 *   - --save：额外把报告写入 cases/{SYMBOL}_{YYYY-MM-DD}.txt
 *
 * 用法示例：
 *   node scripts/replayCase.js BTCUSDT 2026-07-01T00:00:00Z --save
 */
import { writeFileSync, mkdirSync } from "node:fs";
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
import { formatReport } from "../report/formatter.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CASES_DIR = join(__dirname, "..", "cases");

// 回放需要覆盖回放时间之前的足够历史：
//   4H 3000 根 ≈ 500 天；1D 2000 根 ≈ 5.5 年（保证 2025 年回放点的 HTF 方向可稳定判定）；1W 400 根 ≈ 7.7 年
const HISTORY = { "4h": 3000, "1d": 2000, "1w": 400 };

const symbol = (process.argv[2] || "BTCUSDT").toUpperCase();
const replayTime = Date.parse(process.argv[3] || "");
const doSave = process.argv.includes("--save");

if (!replayTime) {
  console.error("用法: node scripts/replayCase.js <SYMBOL> <ISO_TIME> [--save]");
  console.error("示例: node scripts/replayCase.js BTCUSDT 2026-07-01T00:00:00Z --save");
  process.exit(1);
}

/** 截断到回放时间之前已收盘的 K 线 */
function sliceToTime(candles, time) {
  return candles.filter((k) => k.closeTime <= time);
}

async function main() {
  console.error(`[replay] ${symbol} @ ${new Date(replayTime).toISOString()} 拉取历史数据...`);

  const [h4, daily, weekly] = await Promise.all([
    getHistory(symbol, "4h", HISTORY["4h"]),
    getHistory(symbol, "1d", HISTORY["1d"]),
    getHistory(symbol, "1w", HISTORY["1w"]),
  ]);

  const candles4h = sliceToTime(h4, replayTime);
  const day = sliceToTime(daily, replayTime);
  const week = sliceToTime(weekly, replayTime);

  if (candles4h.length < 60) {
    console.error(`[replay] 回放时间 ${new Date(replayTime).toISOString()} 超出数据范围（4H 仅 ${candles4h.length} 根），无法计算`);
    process.exit(1);
  }

  const price = candles4h[candles4h.length - 1].close;

  // 1. Structure
  const swings = findSwings(candles4h);
  const labeled = analyzeSwings(swings);
  const structure = buildStructure(labeled);

  // 2. Liquidity（注入回放时间，只认已收盘的日/周 K）
  const liquidity = computeLiquidity(day, week, swings, 0.002, replayTime);

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

  // 5. Daily Bias（V2.0：注入 HTF 方向用于 Scenario 判定）
  const htfDirection = computeHtfDirection(day, week, price);
  const bias = computeDailyBias({ structure, liquidity, location, price, pdArray, htfDirection });

  const report = formatReport({ symbol, replayTime, structure, liquidity, location, pdArray, bias });

  console.log(report);

  if (doSave) {
    mkdirSync(CASES_DIR, { recursive: true });
    const name = `${symbol}_${new Date(replayTime).toISOString().slice(0, 10)}.txt`;
    const file = join(CASES_DIR, name);
    writeFileSync(file, report + "\n");
    console.error(`[replay] 已保存: ${file}`);
  }
}

main().catch((e) => {
  console.error(`[replay] 失败: ${e.message}`);
  process.exit(1);
});
