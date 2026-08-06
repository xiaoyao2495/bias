/**
 * analyzeStructure.js — 任意币种 4H 结构分析（真实数据）
 *
 * 用法: node scripts/analyzeStructure.js <SYMBOL>   （如 BTCUSDT ETHUSDT MUUSDT）
 *
 * 输出：
 *   - 4H 结构方向（BULLISH/BEARISH/NEUTRAL）与类型、最近 label 序列
 *   - 最近 Swing High/Low 的 HH/HL/LH/LL 标签、价格、北京时间位置
 *   - 结构保护位（BULLISH=protectedLow，BEARISH=protectedHigh）与外部关键位
 *   - 最近 12 个 Swing 明细，可直接定位 HH/HL 在哪根 4H
 */
import { getHistory } from "../data/binance.js";
import { findSwings, analyzeSwings } from "../indicators/swing.js";
import { buildStructure } from "../indicators/structure.js";

const bj = (ms) =>
  new Date(ms).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });

async function main() {
  const symbol = (process.argv[2] || "").toUpperCase();
  if (!symbol) {
    console.error("用法: node scripts/analyzeStructure.js <SYMBOL> （如 BTCUSDT ETHUSDT MUUSDT）");
    process.exit(1);
  }

  const h4 = await getHistory(symbol, "4h", 5000, { force: true });
  const lastK = h4[h4.length - 1];
  console.log(`${symbol} 4H ${h4.length} 根 | 末根 ${bj(lastK.closeTime)} close=${lastK.close}`);

  const labeled = analyzeSwings(findSwings(h4));
  const structure = buildStructure(labeled);

  console.log(`\nstructure.direction: ${structure.direction} | type: ${structure.type}`);
  console.log(`sequence: ${structure.sequence.join(" ")}`);
  console.log(
    `lastHigh: ${structure.lastHigh ? structure.lastHigh.label + " " + structure.lastHigh.price + " @" + bj(h4[structure.lastHigh.index].time) : null}`
  );
  console.log(
    `lastLow: ${structure.lastLow ? structure.lastLow.label + " " + structure.lastLow.price + " @" + bj(h4[structure.lastLow.index].time) : null}`
  );

  // 结构结论：BULLISH = HH + HL；BEARISH = LH + LL（judgeStructure 判定）
  if (structure.direction === "BULLISH") {
    console.log(`结构结论: 新多头结构（HH ${structure.lastHigh.price} + HL ${structure.lastLow.price}）| 保护位 protectedLow: ${structure.protectedLow}（跌破失效）`);
  } else if (structure.direction === "BEARISH") {
    console.log(`结构结论: 新空头结构（LH ${structure.lastHigh.price} + LL ${structure.lastLow.price}）| 保护位 protectedHigh: ${structure.protectedHigh}（升破失效）`);
  } else {
    console.log("结构结论: 无有效结构（HH/HL 或 LH/LL 未同时成立）");
  }

  console.log(`externalSwingHigh: ${structure.externalSwingHigh} | externalSwingLow: ${structure.externalSwingLow}`);

  console.log("\n=== 最近 12 个 Swing（HH/HL/LH/LL，北京时间）===");
  for (const s of labeled.slice(-12)) {
    const k = h4[s.index];
    console.log(`${s.label.padEnd(3)} ${s.type.padEnd(5)} price=${String(s.price).padEnd(8)} @ ${bj(k.time)}  (K#${s.index})`);
  }
}

main().catch((e) => {
  console.error("失败:", e.message);
  process.exit(1);
});
