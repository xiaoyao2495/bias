/**
 * killzone.test.js — Killzone（Session）标注：数据驱动版
 *
 * 覆盖 computeActiveWindows（1h 成交量 → 活跃窗口合并/占比/降级）
 * 与 killzoneOfK（K 覆盖时段与活跃窗口重叠时长取最长）。
 * 活跃小时 = 该小时成交量 > 全天均值 × factor（默认 1.2）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { computeActiveWindows, killzoneOfK } from "../indicators/killzone.js";

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

test("computeActiveWindows：单段活跃窗口 — 20:00-23:00 高量 → [20,24]", () => {
  // 4 小时 200 vs 其余 100 → mean = 116.67，阈值 140 → 仅 20-23 活跃
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

test("computeActiveWindows：阈值过滤 — 略高于均值的小时不计入窗口", () => {
  // 全天 100，仅 20 点 115（>mean 100 但 <120 阈值）→ 无窗口
  assert.deepEqual(computeActiveWindows(buildH1({ 20: 115 })), []);
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
