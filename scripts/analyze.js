/**
 * analyze.js — 入口：拉取 4H/日/周 K 线 → 各 indicator → Daily Bias → 打印报告
 *
 * 用法：
 *   node scripts/analyze.js BTCUSDT [limit]
 */
import { detectStructureEvents } from "../indicators/mss.js";
import { analyzeReplayPoint, loadReplayHistory, REPLAY_HISTORY_COUNTS } from "../engine/replayPipeline.js";
import { formatReport } from "../report/formatter.js";
import { marketNow } from "../utils/marketClock.js";

const symbol = process.argv[2] || "BTCUSDT";
// 默认与 Monitor / Scanner / Replay 共用 5000 根 4H 冷启动窗口；显式 limit 仍保留为
// 调试开关，但短窗口输出不应拿来与生产 Range version 做逐字段比较。
const limit = Number(process.argv[3]) || REPLAY_HISTORY_COUNTS.h4;

async function main() {
  console.error(`正在获取 ${symbol} 数据...`);

  const cutoff = marketNow();
  const history = await loadReplayHistory({
    symbol,
    earliestCutoff: cutoff,
    h4Count: limit,
    dailyCount: REPLAY_HISTORY_COUNTS.daily,
    weeklyCount: REPLAY_HISTORY_COUNTS.weekly,
  });
  const point = analyzeReplayPoint({ symbol, cutoff, history });
  const candles4h = point.input.candles;
  const price = point.price;
  const { structure, liquidity, location, pdArray, bias } = point.result;

  // P1-B：MSS / BOS（4H 环境层，周期无关指标；传入当前价判断"哪个 swing 被打破"）
  const mss = detectStructureEvents(candles4h, { price });

  console.log(formatReport({ symbol, structure, liquidity, location, pdArray, bias, mss }));
}

main().catch((e) => {
  console.error(`分析失败: ${e.message}`);
  process.exit(1);
});
