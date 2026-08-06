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
import { analyzeBias } from "../engine/analyzeBias.js";
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

  // 共用分析链路（与实时监控/历史扫描一致，engine/analyzeBias.js）：
  // 内部按 replayTime 截断日/周线并注入 htfDirection，保证回放与实时结果一致；
  // 后续指标/confidence 更新只需改 analyzeBias 一处，回放/审计自动同步
  const { structure, liquidity, location, pdArray, bias } = analyzeBias({
    candles: candles4h,
    daily: day,
    weekly: week,
    price,
    time: replayTime,
  });

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
