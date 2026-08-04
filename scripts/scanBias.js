/**
 * scanBias.js — V2.2 Historical Bias Scanner CLI
 *
 * 用法：
 *   node scripts/scanBias.js <SYMBOL> [--start 2025-01-01] [--end 2026-01-01] [--step 6] [--target 0.05]
 *
 *   --start/--end : 扫描区间（默认 start=2025-01-01，end=今天）
 *   --step        : 每隔多少根 4H 取一个样本（默认 6 ≈ 每日 1 样本；1 = 每 4 小时）
 *   --target      : 目标幅度（默认 0.05 = ±5%）
 *
 * 输出：
 *   scanner/reports/{SYMBOL}_samples.json — Historical Bias Database
 *   scanner/reports/{SYMBOL}_stats.txt    — 分组统计报告（同时打印到控制台）
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { scanHistory } from "../scanner/historicalScanner.js";
import { computeStatistics, formatStatsReport } from "../scanner/statistics.js";
import { computeQuality, formatQualityReport } from "../scanner/quality.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPORTS_DIR = join(__dirname, "..", "scanner", "reports");

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

async function main() {
  const symbol = (process.argv[2] || "BTCUSDT").toUpperCase();
  const start = new Date(`${arg("start", "2025-01-01")}T00:00:00Z`).getTime();
  const end = new Date(`${arg("end", new Date().toISOString().slice(0, 10))}T00:00:00Z`).getTime();
  const step = Math.max(1, Number(arg("step", "6")));
  const targetPct = Number(arg("target", "0.05"));

  console.error(`[scan] ${symbol} ${new Date(start).toISOString().slice(0, 10)} ~ ${new Date(end).toISOString().slice(0, 10)}（step ${step}）`);

  let lastPct = -1;
  const { samples, meta } = await scanHistory({
    symbol,
    startTime: start,
    endTime: end,
    step,
    targetPct,
    onProgress: (n, total) => {
      const pct = Math.floor((n / total) * 100);
      if (pct !== lastPct && pct % 10 === 0) {
        lastPct = pct;
        console.error(`[scan] ${pct}% (${n}/${total})`);
      }
    },
  });

  const stats = computeStatistics(samples, 30);
  const report = formatStatsReport({ symbol, meta, stats });
  // V2.4：盈亏质量报告（方向正确性 ≠ 盈亏质量）
  const quality = computeQuality(samples, 30);
  const qualityReport = formatQualityReport({ symbol, meta, quality });
  const fullReport = report + "\n" + qualityReport + "\n";

  mkdirSync(REPORTS_DIR, { recursive: true });
  writeFileSync(join(REPORTS_DIR, `${symbol}_samples.json`), JSON.stringify(samples, null, 2) + "\n");
  writeFileSync(join(REPORTS_DIR, `${symbol}_stats.txt`), fullReport + "\n");

  console.log(fullReport);
  console.error(`[scan] 样本库: ${join(REPORTS_DIR, `${symbol}_samples.json`)}（${samples.length} 条）`);
  console.error(`[scan] 统计+质量报告: ${join(REPORTS_DIR, `${symbol}_stats.txt`)}`);
}

main().catch((e) => {
  console.error(`[scan] 失败: ${e.message}`);
  process.exit(1);
});
