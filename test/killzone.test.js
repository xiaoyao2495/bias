/**
 * killzone.test.js — Killzone（Session）标注：数据驱动版
 *
 * 覆盖 computeActiveWindows（1h 成交量 → 活跃窗口合并/占比/降级）
 * 与 killzoneOfK（K 覆盖时段与活跃窗口重叠时长取最长）。
 * 活跃小时 = 该小时成交量 > 全天均值 × factor（默认 1.5）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { computeActiveWindows, lastTradingWeek, killzoneOfK } from "../indicators/killzone.js";

const HOUR = 3600_000;
/** 北京时刻 → epoch ms（北京 = UTC+8） */
const bjMs = (y, mo, d, h, min = 0) => Date.UTC(y, mo - 1, d, h - 8, min);

/** 构造连续 N 天 1h K：每天 24 根，指定小时用 volByHour[h]，其余 100 */
function buildH1(volByHour, days = 3) {
  const out = [];
  for (let d = 0; d < days; d++)
    for (let h = 0; h < 24; h++) out.push({ time: bjMs(2026, 8, 6, h) + d * 24 * HOUR, quoteVol: (volByHour && volByHour[h]) || 100 });
  return out;
}

test("lastTradingWeek：只保留上周一~五（北京口径，排除周末与本周）", () => {
  const now = bjMs(2026, 8, 6, 12); // 2026-08-06 周四
  const k = (y, mo, d, h) => ({ time: bjMs(y, mo, d, h) });
  const h1 = [
    k(2026, 7, 26, 23), // 上周日 23:00 → 排除
    k(2026, 7, 27, 0), // 上周一 00:00 → 含（下边界）
    k(2026, 7, 29, 8), // 上周三 → 含
    k(2026, 7, 31, 23), // 上周五 23:00 → 含
    k(2026, 8, 1, 0), // 上周六 00:00 → 排除（上周五 24:00 整点，半开区间）
    k(2026, 8, 3, 0), // 本周一 → 排除
  ];
  const out = lastTradingWeek(h1, now);
  assert.deepEqual(
    out.map((x) => x.time),
    [k(2026, 7, 27, 0).time, k(2026, 7, 29, 8).time, k(2026, 7, 31, 23).time]
  );
});

test("lastTradingWeek：今天是周一 → 上周 = 前一个完整周", () => {
  const now = bjMs(2026, 8, 3, 9); // 2026-08-03 周一 09:00
  const k = (y, mo, d, h) => ({ time: bjMs(y, mo, d, h) });
  const h1 = [k(2026, 7, 26, 23), k(2026, 7, 27, 0), k(2026, 7, 31, 23), k(2026, 8, 2, 23), k(2026, 8, 3, 0)];
  const out = lastTradingWeek(h1, now);
  assert.deepEqual(
    out.map((x) => x.time),
    [k(2026, 7, 27, 0).time, k(2026, 7, 31, 23).time]
  );
});

test("computeActiveWindows：单段活跃窗口 — 20:00-23:00 高量 → [20,24]", () => {
  // 4 小时 200 vs 其余 100 → mean = 116.67，阈值 1.5×mean ≈ 175 → 仅 20-23 活跃
  const w = computeActiveWindows(buildH1({ 20: 200, 21: 200, 22: 200, 23: 200 }));
  assert.deepEqual(w, [{ start: 20, end: 24, ratio: 28.6 }]); // 800/2800
});

test("computeActiveWindows：多段窗口 — 亚洲 + 美股时段，按占比降序", () => {
  // 6 小时 200 vs 其余 100 → total 3000：[8,10]=13.3%，[20,24]=26.7%
  const w = computeActiveWindows(buildH1({ 8: 200, 9: 200, 20: 200, 21: 200, 22: 200, 23: 200 }));
  assert.deepEqual(w, [
    { start: 20, end: 24, ratio: 26.7 },
    { start: 8, end: 10, ratio: 13.3 },
  ]);
});

test("computeActiveWindows：阈值过滤 — 1.5×均值以下的小时不入窗口（1.2 会误判的次级峰）", () => {
  // 全天 100，20 点 130（1.3×mean 100）：旧 factor 1.2 会算活跃（130>120），
  // 1.5 修正后（阈值 150）不计入——对应实盘 5-6% 次级峰（BTC 06/09 点、MU 08 点）误报修复
  assert.deepEqual(computeActiveWindows(buildH1({ 20: 130 })), []);
});

test("computeActiveWindows：碎片过滤 — 占比 <10% 的窗口丢弃（XAG 02-03 点 7%、09-10 点 6.3% 场景）", () => {
  // 21-23 三小时 300（主峰 29.1%）+ 02 点 195（过 1.5 阈值但占比仅 6.3%）+ 其余 100
  // → 只保留主峰窗口，碎片窗口丢弃
  const w = computeActiveWindows(buildH1({ 21: 300, 22: 300, 23: 300, 2: 195 }));
  assert.deepEqual(w, [{ start: 21, end: 24, ratio: 29.1 }]);
});

test("computeActiveWindows：降级 — 空/不足 24 根/无成交量数据 → []", () => {
  assert.deepEqual(computeActiveWindows([]), []);
  assert.deepEqual(computeActiveWindows(buildH1({}).slice(0, 10)), []); // 不足 24 根
  assert.deepEqual(computeActiveWindows(buildH1({}, 2).map((k) => ({ time: k.time }))), []); // 无 quoteVol（旧缓存）
});

test("killzoneOfK：K 覆盖时段与活跃窗口重叠", () => {
  const windows = [{ start: 20, end: 24, ratio: 28.6 }];
  // 完全覆盖：20:00-24:00 → 重叠 4h（跨午夜段 [20,24)）
  assert.deepEqual(killzoneOfK({ time: bjMs(2026, 8, 6, 20), closeTime: bjMs(2026, 8, 6, 24) }, windows), windows[0]);
  // 部分重叠：18:00-22:00 → 与 [20,24) 重叠 2h
  assert.deepEqual(killzoneOfK({ time: bjMs(2026, 8, 6, 18), closeTime: bjMs(2026, 8, 6, 22) }, windows), windows[0]);
  // 无重叠：12:00-16:00 → null
  assert.equal(killzoneOfK({ time: bjMs(2026, 8, 6, 12), closeTime: bjMs(2026, 8, 6, 16) }), null);
});

test("killzoneOfK：多窗口取重叠最长", () => {
  const windows = [
    { start: 8, end: 10, ratio: 13.3 },
    { start: 20, end: 24, ratio: 26.7 },
  ];
  assert.deepEqual(killzoneOfK({ time: bjMs(2026, 8, 6, 21), closeTime: bjMs(2026, 8, 6, 23) }, windows), windows[1]);
  assert.deepEqual(killzoneOfK({ time: bjMs(2026, 8, 6, 9), closeTime: bjMs(2026, 8, 6, 11) }, windows), windows[0]);
});

test("killzoneOfK：防御 — 无窗口/异常 K → null", () => {
  assert.equal(killzoneOfK({ time: bjMs(2026, 8, 6, 20), closeTime: bjMs(2026, 8, 6, 24) }, []), null);
  assert.equal(killzoneOfK(null, [{ start: 20, end: 24, ratio: 28.6 }]), null);
  assert.equal(killzoneOfK({ time: bjMs(2026, 8, 6, 20) }, [{ start: 20, end: 24, ratio: 28.6 }]), null);
});
