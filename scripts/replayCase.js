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
import { analyzeReplayPoint, loadReplayHistory, REPLAY_HISTORY_COUNTS } from "../engine/replayPipeline.js";
import { formatReport } from "../report/formatter.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CASES_DIR = join(__dirname, "..", "cases");

// 回放需要覆盖回放时间之前的足够历史：
// 与 Monitor / Historical Scanner 使用同一个 4H 冷启动窗口；否则同一 cutoff 虽可能
// 得到相同 Range ID，生命周期 version/selectedAt 仍会因历史起点不同而漂移。

const symbol = (process.argv[2] || "BTCUSDT").toUpperCase();
const replayTime = Date.parse(process.argv[3] || "");
const doSave = process.argv.includes("--save");

if (!replayTime) {
  console.error("用法: node scripts/replayCase.js <SYMBOL> <ISO_TIME> [--save]");
  console.error("示例: node scripts/replayCase.js BTCUSDT 2026-07-01T00:00:00Z --save");
  process.exit(1);
}

async function main() {
  console.error(`[replay] ${symbol} @ ${new Date(replayTime).toISOString()} 拉取历史数据...`);

  const history = await loadReplayHistory({
    symbol,
    earliestCutoff: replayTime,
    h4Count: REPLAY_HISTORY_COUNTS.h4,
    dailyCount: REPLAY_HISTORY_COUNTS.daily,
    weeklyCount: REPLAY_HISTORY_COUNTS.weekly,
  });
  const point = analyzeReplayPoint({ symbol, cutoff: replayTime, history });
  const candles4h = point.input.candles;

  if (candles4h.length < 60) {
    console.error(`[replay] 回放时间 ${new Date(replayTime).toISOString()} 超出数据范围（4H 仅 ${candles4h.length} 根），无法计算`);
    process.exit(1);
  }

  const { structure, liquidity, location, pdArray, bias } = point.result;
  console.error(`[replay] profile=${point.profile.sessionModel} HTF=${liquidity.htfLiquiditySource} marketDay=${point.marketDayId} ictDay=${point.ictTradingDayId}`);

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
