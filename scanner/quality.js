/**
 * quality.js — V2.4 Historical Bias Quality（方向正确性 ≠ 盈亏质量）
 *
 * V2.2/V2.3 只回答"Bias 对不对"（Direction Accuracy），但交易者真正关心的是
 * "这个 Bias 有没有交易价值"。同一 WIN 里：
 *   样本 A：MFE +8% / MAE −0.5%  → 优秀
 *   样本 B：MFE +1% / MAE −5%    → 垃圾
 * 旧 Scanner 都算 WIN。V2.4 增加三个评价维度：
 *
 *   1. Direction Accuracy — 未来窗口内是否触及目标（保留，V2.2 口径）
 *   2. R Multiple          — 盈亏比（planR 理论 / outcome r 实际）
 *   3. MAE/MFE             — 路径质量（最大逆行 / 最大顺行，%）
 *
 * 按 Confidence level（HIGH/MEDIUM/LOW）分组输出，回答"HIGH 是否真的值得交易"。
 */

/**
 * @param {Array} samples scanner 生成的样本数组
 * @param {number} window 主评估窗口（4H 根数，默认 30）
 * @returns {Object} { window, groups: { HIGH, MEDIUM, LOW }, overall }
 *  每组: { n, win, loss, accuracy, avgR, medianR, planR, medianMaePct, medianMfePct }
 */
export function computeQuality(samples, window = 30) {
  const grouped = { HIGH: [], MEDIUM: [], LOW: [] };
  for (const s of samples) {
    if (s.bias === "NEUTRAL" || s.confidence == null) continue;
    if (grouped[s.confidence]) grouped[s.confidence].push(s);
  }

  const overall = samples.filter((s) => s.bias !== "NEUTRAL");
  return {
    window,
    groups: {
      HIGH: summarize(grouped.HIGH, window),
      MEDIUM: summarize(grouped.MEDIUM, window),
      LOW: summarize(grouped.LOW, window),
    },
    overall: summarize(overall, window),
  };
}

function summarize(list, window) {
  const w = String(window);
  let win = 0;
  let loss = 0;
  const rs = []; // outcome R（只计 WIN/LOSS，有结论才统计）
  const planRs = []; // 理论盈亏比
  const maes = [];
  const mfes = [];

  for (const s of list) {
    const f = s.futures && s.futures[w];
    if (f) {
      if (f.outcome === "WIN") win++;
      else if (f.outcome === "LOSS") loss++;
      if (f.r != null && (f.outcome === "WIN" || f.outcome === "LOSS")) rs.push(f.r);
    }
    if (s.planR != null) planRs.push(s.planR);
    if (s.maePct != null) maes.push(s.maePct);
    if (s.mfePct != null) mfes.push(s.mfePct);
  }

  const decided = win + loss;
  return {
    n: list.length,
    win,
    loss,
    accuracy: decided ? Math.round((win / decided) * 1000) / 10 : null,
    avgR: round(mean(rs), 2),
    medianR: round(median(rs), 2),
    planR: round(median(planRs), 2),
    medianMaePct: round(median(maes), 3), // 保留 0.1% 精度：0.005 → 0.5%
    medianMfePct: round(median(mfes), 3),
  };
}

function mean(arr) {
  return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null;
}

function median(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function round(v, digits) {
  return v == null ? null : Number(v.toFixed(digits));
}

/** 渲染质量报告文本（追加在统计报告之后） */
export function formatQualityReport({ symbol, meta, quality }) {
  const L = [];
  const bar = "-".repeat(52);
  L.push(bar);
  L.push(`Quality by Confidence（窗口 ${quality.window} 根 4H ≈ ${Math.round((quality.window * 4) / 24)} 天）`);
  L.push(`口径: Direction Accuracy = WIN/(WIN+LOSS)；R = 盈亏/风险（LOSS=−1）；MAE/MFE = 相对 Entry 的 %`, "");

  const pct = (x) => (x == null ? "-" : `${(x * 100).toFixed(1)}%`);
  const row = (label, g) =>
    `${label.padEnd(9)} n=${String(g.n).padStart(4)}  acc ${String(g.accuracy == null ? "-" : `${g.accuracy}%`).padStart(6)}  avgR ${String(g.avgR ?? "-").padStart(6)}  medR ${String(g.medianR ?? "-").padStart(6)}  planR ${String(g.planR ?? "-").padStart(6)}  medMAE ${pct(g.medianMaePct).padStart(6)}  medMFE ${pct(g.medianMfePct).padStart(6)}`;

  L.push("全体");
  L.push(row("ALL", quality.overall));
  L.push("");
  for (const c of ["HIGH", "MEDIUM", "LOW"]) {
    L.push(`${c}`);
    L.push(row(c, quality.groups[c]));
    L.push("");
  }
  L.push(bar);
  return L.join("\n");
}
