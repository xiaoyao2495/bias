/**
 * killzone.test.js — ICT 2022 Killzone（Session）标注
 *
 * 覆盖 killzoneOfTime（某时刻落在哪个窗口，半开区间 [start, end)）
 * 与 killzoneOfK（K 覆盖时段与各窗口重叠时长取最长）。
 * 北京时间口径（夏令时）：Asian 08-10 / London 14-17 / NY 19-22 / LondonClose 22-24。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { killzoneOfTime, killzoneOfK } from "../indicators/killzone.js";

/** 北京时刻 → epoch ms（北京 = UTC+8） */
const bjMs = (y, mo, d, h, min = 0) => Date.UTC(y, mo - 1, d, h - 8, min);

test("killzoneOfTime：边界内命中对应窗口", () => {
  assert.equal(killzoneOfTime(bjMs(2026, 8, 6, 8, 0)).name, "ASIAN");
  assert.equal(killzoneOfTime(bjMs(2026, 8, 6, 9, 59)).name, "ASIAN");
  assert.equal(killzoneOfTime(bjMs(2026, 8, 6, 14, 0)).name, "LONDON");
  assert.equal(killzoneOfTime(bjMs(2026, 8, 6, 19, 0)).name, "NEW_YORK");
  assert.equal(killzoneOfTime(bjMs(2026, 8, 6, 22, 0)).name, "LONDON_CLOSE");
});

test("killzoneOfTime：半开区间 [start, end) — 边界整点不命中下一窗口", () => {
  assert.equal(killzoneOfTime(bjMs(2026, 8, 6, 10, 0)), null); // 亚洲结束
  assert.equal(killzoneOfTime(bjMs(2026, 8, 6, 17, 0)), null); // 伦敦结束
  assert.equal(killzoneOfTime(bjMs(2026, 8, 6, 0, 0)), null); // 深夜无窗口
});

test("killzoneOfK：取覆盖时段内重叠最长的窗口", () => {
  // 12:00-16:00 与伦敦 14-17 重叠 2h → LONDON
  assert.equal(killzoneOfK({ time: bjMs(2026, 8, 6, 12), closeTime: bjMs(2026, 8, 6, 16) }).name, "LONDON");
  // 08:00-12:00 与亚洲 08-10 重叠 2h → ASIAN
  assert.equal(killzoneOfK({ time: bjMs(2026, 8, 6, 8), closeTime: bjMs(2026, 8, 6, 12) }).name, "ASIAN");
  // 17:00-21:00 与纽约 19-22 重叠 2h（伦敦已结束）→ NEW_YORK
  assert.equal(killzoneOfK({ time: bjMs(2026, 8, 6, 17), closeTime: bjMs(2026, 8, 6, 21) }).name, "NEW_YORK");
});

test("killzoneOfK：无重叠（盘整时段）→ null", () => {
  assert.equal(killzoneOfK({ time: bjMs(2026, 8, 6, 0), closeTime: bjMs(2026, 8, 6, 4) }), null);
  assert.equal(killzoneOfK({ time: bjMs(2026, 8, 6, 10), closeTime: bjMs(2026, 8, 6, 14) }), null);
});

test("killzoneOfK：缺字段/异常 K → null（防御）", () => {
  assert.equal(killzoneOfK({ time: bjMs(2026, 8, 6, 8) }), null);
  assert.equal(killzoneOfK(null), null);
});
