// 临时分析：交易日北京 21:30 + 21:35 两根 5m K 同方向 → 22:00 价格相关性
// 用法: node scripts/tmp_open_analysis.js SYMBOL [count]
import { getHistory } from "../data/binance.js";

const SYMBOL = (process.argv[2] || "SNDKUSDT").toUpperCase();
const COUNT = Number(process.argv[3]) || 60000;
const k = await getHistory(SYMBOL, "5m", COUNT, { force: false });
console.log(`数据范围: ${new Date(k[0].time).toISOString()} → ${new Date(k[k.length - 1].time).toISOString()} (${k.length} 根)`);

const BJT = 8 * 3600_000;
const days = new Map();
for (const x of k) {
  const b = new Date(x.time + BJT);
  const dateStr = b.toISOString().slice(0, 10);
  const hhmm = `${String(b.getUTCHours()).padStart(2, "0")}:${String(b.getUTCMinutes()).padStart(2, "0")}`;
  if (!days.has(dateStr)) days.set(dateStr, {});
  const d = days.get(dateStr);
  if (hhmm === "21:30") d.k30 = x;
  else if (hhmm === "21:35") d.k35 = x;
  else if (hhmm === "21:55") d.k55 = x;
}

const rows = [];
for (const [date, { k30, k35, k55 }] of days) {
  if (!k30 || !k35 || !k55) continue;
  const dow = new Date(k30.time + BJT).getUTCDay();
  const d1 = Math.sign(k30.close - k30.open);
  const d2 = Math.sign(k35.close - k35.open);
  const pBase = k35.close;
  const p22 = k55.close;
  rows.push({ date, dow, d1, d2, ret: (p22 - pBase) / pBase, out: Math.sign(p22 - pBase) });
}

function binomialP(kk, n, p) {
  let sum = 0;
  const logFact = (m) => (m <= 1 ? 0 : m * Math.log(m) - m + 0.5 * Math.log(2 * Math.PI * m));
  for (let x = kk; x <= n; x++) {
    sum += Math.exp(logFact(n) - logFact(x) - logFact(n - x) + x * Math.log(p) + (n - x) * Math.log(1 - p));
  }
  return sum;
}

function analyze(rows, label) {
  const N = rows.length;
  if (!N) { console.log(`\n${label}: 无样本`); return; }
  const upBase = rows.filter((r) => r.out > 0).length / N;
  const downBase = rows.filter((r) => r.out < 0).length / N;
  const sig = rows.filter((r) => r.d1 !== 0 && r.d1 === r.d2);
  const upSig = sig.filter((r) => r.d1 > 0);
  const dnSig = sig.filter((r) => r.d1 < 0);
  const avg = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);
  console.log(`\n===== ${SYMBOL} ${label}（21:40 → 22:00，共 20 分钟）=====`);
  console.log(`总样本: ${N} | 基线: 22:00 上涨 ${(upBase * 100).toFixed(1)}% / 下跌 ${(downBase * 100).toFixed(1)}%`);
  console.log(`触发信号: ${sig.length} 天（涨 ${upSig.length} / 跌 ${dnSig.length}）`);
  if (!sig.length) return;
  const upCont = upSig.filter((r) => r.out > 0).length;
  const dnCont = dnSig.filter((r) => r.out < 0).length;
  const revUp = upSig.filter((r) => r.out < 0).length;
  const revDn = dnSig.filter((r) => r.out > 0).length;
  console.log(`涨信号后 22:00 继续上涨: ${((upCont / upSig.length) * 100).toFixed(1)}% (${upCont}/${upSig.length}，反向 ${revUp})  平均收益 ${(avg(upSig.map((r) => r.ret)) * 100).toFixed(2)}%  p=${binomialP(upCont, upSig.length, upBase).toFixed(3)}`);
  console.log(`跌信号后 22:00 继续下跌: ${((dnCont / dnSig.length) * 100).toFixed(1)}% (${dnCont}/${dnSig.length}，反向 ${revDn})  平均收益 ${(avg(dnSig.map((r) => r.ret)) * 100).toFixed(2)}%  p=${binomialP(dnCont, dnSig.length, downBase).toFixed(3)}`);
  console.log(`同方向总延续率: ${(((upCont + dnCont) / sig.length) * 100).toFixed(1)}%`);
}

const wk = rows.filter((r) => r.dow >= 1 && r.dow <= 5);
analyze(wk, "周一~周五");
analyze(rows, "全部日期");
