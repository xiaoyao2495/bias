/**
 * killzone.js — ICT 2022 Killzone（Session）标注
 *
 * ICT 2022 课程四个 Killzone（纽约本地时间，官方 PDF）：
 *   Asian        08:00 PM - 10:00 PM EDT
 *   London       02:00 AM - 05:00 AM EDT
 *   New York     07:00 AM - 10:00 AM EDT
 *   London Close 10:00 AM - 12:00 PM EDT
 *
 * 换算为北京时间（UTC+8；当前夏令时 EDT=UTC-4 → 北京 = EDT+12）：
 *   Asian        08:00 - 10:00
 *   London       14:00 - 17:00
 *   New York     19:00 - 22:00
 *   London Close 22:00 - 24:00
 *
 * 冬令时（EST=UTC-5）各窗口整体后移 1 小时（北京 09-11 / 15-18 / 20-23 / 23-01）。
 * 加密市场 24/7 无夏令时，此处按夏令时口径固定，便于对照北京时间。
 *
 * 标注规则：
 *   killzoneOfTime(ms) — 某时刻落在哪个 Killzone 窗口（直接小时判断）
 *   killzoneOfK(k)     — K 覆盖时段与各窗口的重叠时长，取重叠最长者；无重叠 → null
 */

const BJ_OFFSET_MS = 8 * 3600_000;
/** [名称, 中文, 北京时间起始 h, 结束 h)  半开区间 */
const KILLZONES = [
  { name: "ASIAN", cn: "亚洲", start: 8, end: 10 },
  { name: "LONDON", cn: "伦敦", start: 14, end: 17 },
  { name: "NEW_YORK", cn: "纽约", start: 19, end: 22 },
  { name: "LONDON_CLOSE", cn: "伦敦收盘", start: 22, end: 24 },
];

/** ms → 北京时间小时（小数） */
function bjHour(ms) {
  const d = new Date(ms + BJ_OFFSET_MS);
  return d.getUTCHours() + d.getUTCMinutes() / 60 + d.getUTCSeconds() / 3600;
}

/** 某时刻（ms）落在哪个 Killzone：{ name, cn, start, end } | null */
export function killzoneOfTime(ms) {
  const h = bjHour(ms);
  return KILLZONES.find((z) => h >= z.start && h < z.end) || null;
}

/** K 覆盖时段与各 Killzone 的重叠时长，取重叠最长者；无重叠 → null */
export function killzoneOfK(k) {
  if (!k || k.time == null || k.closeTime == null) return null;
  const h1 = bjHour(k.time);
  const h2 = bjHour(k.closeTime);
  if (h2 <= h1) return null; // 防御：不处理覆盖结束早于开始的异常 K
  let best = null;
  let bestOv = 0;
  for (const z of KILLZONES) {
    const ov = Math.max(0, Math.min(h2, z.end) - Math.max(h1, z.start));
    if (ov > bestOv) {
      bestOv = ov;
      best = z;
    }
  }
  return bestOv > 0 ? best : null;
}
