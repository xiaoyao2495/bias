/**
 * analyze.js — 入口：拉取 4H/日/周 K 线 → 各 indicator → Daily Bias → 打印报告
 *
 * 用法：
 *   node scripts/analyze.js BTCUSDT [limit]
 */
import { get4hKlines, getDailyKlines, getWeeklyKlines } from "../data/binance.js";
import { detectStructureEvents } from "../indicators/mss.js";
import { analyzeBias } from "../engine/analyzeBias.js";
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

  // 共用分析链路（与监控/回放一致，engine/analyzeBias.js）：内部按 time 截断日/周线
  // 并注入 htfDirection 用于 Scenario 判定——此前缺该参数导致 HTF 恒为 NEUTRAL，与监控结果不一致
  const { structure, liquidity, location, pdArray, bias } = analyzeBias({
    candles: candles4h,
    daily,
    weekly,
    price,
    time: candles4h[candles4h.length - 1].closeTime,
  });

  // P1-B：MSS / BOS（4H 环境层，周期无关指标；传入当前价判断"哪个 swing 被打破"）
  const mss = detectStructureEvents(candles4h, { price });

  console.log(formatReport({ symbol, structure, liquidity, location, pdArray, bias, mss }));
}

main().catch((e) => {
  console.error(`分析失败: ${e.message}`);
  process.exit(1);
});
