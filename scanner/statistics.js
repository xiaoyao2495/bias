/**
 * statistics.js — V2.2 Historical Bias Statistics
 *
 * 对 Historical Bias Database 做分组统计，回答三个问题：
 *   1. Bias Accuracy   — 方向本身有没有统计优势（WIN/LOSS）
 *   2. Confidence 有效性 — HIGH > MEDIUM > LOW 是否成立
 *   3. Scenario 有无意义 — CONTINUATION vs REVERSAL_ATTEMPT 是否区分效果
 * 附加：Execution（READY/WAIT）对比、多窗口对比。
 *
 * 判定口径（来自 evaluator）：WIN=触及 Draw 或 ±targetPct，LOSS=触及保护位，
 * 窗口内两者都未发生 = NEUTRAL（不计入 accuracy 分母）。
 */

/**
 * @param {Array} samples scanner 生成的样本数组
 * @param {number} window 主评估窗口（4H 根数，默认 30）
 * @returns {Object} 分组统计对象
 */
export function computeStatistics(samples, window = 30) {
  const directional = samples.filter((s) => s.bias !== "NEUTRAL");

  const byBias = {};
  for (const b of ["BULLISH", "BEARISH"]) {
    byBias[b] = summarize(samples.filter((s) => s.bias === b), window);
  }

  const byConfidence = {};
  for (const b of ["BULLISH", "BEARISH"]) {
    byConfidence[b] = {};
    for (const c of ["HIGH", "MEDIUM", "LOW"]) {
      byConfidence[b][c] = summarize(samples.filter((s) => s.bias === b && s.confidence === c), window);
    }
  }

  // Scenario 按状态归类：CONTINUATION / REVERSAL_ATTEMPT / RANGE / TRANSITION
  const scenarioState = (s) => {
    const label = s.scenario || "";
    if (label.includes("CONTINUATION")) return "CONTINUATION";
    if (label.includes("REVERSAL_ATTEMPT")) return "REVERSAL_ATTEMPT";
    if (label.includes("RANGE")) return "RANGE";
    return "TRANSITION";
  };
  const byScenario = {};
  for (const b of ["BULLISH", "BEARISH"]) {
    byScenario[b] = {};
    for (const st of ["CONTINUATION", "REVERSAL_ATTEMPT"]) {
      byScenario[b][st] = summarize(samples.filter((s) => s.bias === b && scenarioState(s) === st), window);
    }
  }

  const byExecution = {
    READY: summarize(directional.filter((s) => s.execution === "READY"), window),
    WAIT: summarize(directional.filter((s) => s.execution === "WAIT"), window),
  };

  // 多窗口对比（全部有向样本）
  const byWindow = {};
  const wins = Object.keys(samples[0]?.futures || {});
  for (const w of wins) {
    byWindow[w] = summarize(directional, Number(w));
  }

  const distribution = {
    total: samples.length,
    BULLISH: samples.filter((s) => s.bias === "BULLISH").length,
    BEARISH: samples.filter((s) => s.bias === "BEARISH").length,
    NEUTRAL: samples.filter((s) => s.bias === "NEUTRAL").length,
  };

  return { distribution, byBias, byConfidence, byScenario, byExecution, byWindow };
}

/** 一组样本在指定窗口的统计摘要 */
function summarize(samples, window) {
  const w = String(window);
  let win = 0;
  let loss = 0;
  let neutral = 0;
  let skip = 0;
  for (const s of samples) {
    const f = s.futures && s.futures[w];
    if (!f) continue;
    if (f.outcome === "WIN") win++;
    else if (f.outcome === "LOSS") loss++;
    else if (f.outcome === "NEUTRAL") neutral++;
    else skip++;
  }
  const decided = win + loss;
  return {
    n: samples.length,
    win,
    loss,
    neutral,
    skip,
    accuracy: decided ? Math.round((win / decided) * 1000) / 10 : null,
  };
}

/** 渲染统计报告文本 */
export function formatStatsReport({ symbol, meta, stats }) {
  const L = [];
  const bar = "=".repeat(52);
  L.push(`${symbol} 4H Bias Historical Result`, bar, "");
  L.push(`扫描: ${meta.startTime.slice(0, 10)} ~ ${meta.endTime.slice(0, 10)}（step ${meta.step} 根 4H ≈ ${meta.step === 1 ? "每 4 小时" : "每日 1 样本"}）`);
  L.push(`样本: ${stats.distribution.total}（BULLISH ${stats.distribution.BULLISH} / BEARISH ${stats.distribution.BEARISH} / NEUTRAL ${stats.distribution.NEUTRAL}）`);
  L.push(`判定: WIN=触及 Draw 或 ±${(meta.targetPct * 100).toFixed(0)}%，LOSS=触及保护位；NEUTRAL 不计入 accuracy`, "");

  const acc = (x) => (x.accuracy == null ? "-" : `${x.accuracy}%`);
  const row = (label, s) => `${label.padEnd(26)} n=${String(s.n).padStart(4)}  WIN ${String(s.win).padStart(4)}  LOSS ${String(s.loss).padStart(4)}  acc ${acc(s).padStart(6)}`;

  L.push("--- 1. Bias Accuracy（窗口 30 根 4H ≈ 5 天）---");
  for (const b of ["BULLISH", "BEARISH"]) L.push(row(`${b}`, stats.byBias[b]));
  L.push("");

  L.push("--- 2. Confidence 有效性（HIGH > MEDIUM > LOW ?）---");
  for (const b of ["BULLISH", "BEARISH"]) {
    for (const c of ["HIGH", "MEDIUM", "LOW"]) {
      L.push(row(`${b} ${c}`, stats.byConfidence[b][c]));
    }
  }
  L.push("");

  L.push("--- 3. Scenario 对比（CONTINUATION vs REVERSAL_ATTEMPT）---");
  for (const b of ["BULLISH", "BEARISH"]) {
    for (const st of ["CONTINUATION", "REVERSAL_ATTEMPT"]) {
      L.push(row(`${b} ${st}`, stats.byScenario[b][st]));
    }
  }
  L.push("");

  L.push("--- 4. Execution 对比（READY vs WAIT）---");
  L.push(row("READY", stats.byExecution.READY));
  L.push(row("WAIT", stats.byExecution.WAIT));
  L.push("");

  L.push("--- 5. 多窗口对比（全部有向样本）---");
  for (const [w, s] of Object.entries(stats.byWindow)) {
    L.push(row(`未来 ${w} 根 4H`, s));
  }
  L.push("", bar);
  return L.join("\n");
}
