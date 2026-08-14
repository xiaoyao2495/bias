import { test } from "node:test";
import assert from "node:assert/strict";
import { filterUpcomingEvents, isNewsRelevantSymbol, newsLineFor } from "../monitor/newsCalendar.js";

// 固定测试时刻：2026-08-14 12:00 UTC = 北京 2026-08-14 20:00
const NOW = Date.UTC(2026, 7, 14, 12, 0, 0);

const events = [
  { title: "CPI y/y", country: "USD", date: "2026-08-14T12:30:00Z", impact: "High", forecast: "3.0%", previous: "3.2%" },
  { title: "FOMC Statement", country: "USD", date: "2026-08-14T18:00:00Z", impact: "High" },
  { title: "Cash Rate", country: "AUD", date: "2026-08-14T13:00:00Z", impact: "High" }, // 非 USD，排除
  { title: "Cleveland Fed Inflation Expectations", country: "USD", date: "2026-08-14T14:00:00Z", impact: "Low" }, // 低影响，排除
  { title: "Core CPI m/m", country: "USD", date: "2026-08-14T09:00:00Z", impact: "High" }, // 已过，排除
  { title: "Non-Farm Employment Change", country: "USD", date: "2026-08-15T02:00:00Z", impact: "High" }, // 明天（北京时间）
];

test("filterUpcomingEvents: 只留未来窗口内 USD High，按时间升序", () => {
  const list = filterUpcomingEvents(events, NOW, 8);
  // 北京 20:00 + 8h = 次日 04:00；NFP（UTC 次日 02:00 = 北京 10:00）超出窗口 → 排除
  assert.equal(list.length, 2);
  assert.deepEqual(
    list.map((e) => e.title),
    ["CPI y/y", "FOMC Statement"]
  );
  assert.equal(list[0].ts, Date.UTC(2026, 7, 14, 12, 30, 0));
});

test("filterUpcomingEvents: 无事件 / 空数组 → 空列表", () => {
  assert.deepEqual(filterUpcomingEvents([], NOW, 8), []);
  assert.deepEqual(filterUpcomingEvents(null, NOW, 8), []);
});

test("isNewsRelevantSymbol: BTCUSDT/ETHUSDT 恒标注；EQUITY/KR_EQUITY 股票代币标注；山寨币不标注", () => {
  const exch = { MUUSDT: "EQUITY", SKHYNIXUSDT: "KR_EQUITY", DOGEUSDT: "COIN", XAUUSDT: "COMMODITY" };
  assert.equal(isNewsRelevantSymbol("BTCUSDT", exch), true);
  assert.equal(isNewsRelevantSymbol("ETHUSDT", exch), true);
  assert.equal(isNewsRelevantSymbol("MUUSDT", exch), true);
  assert.equal(isNewsRelevantSymbol("SKHYNIXUSDT", exch), true);
  assert.equal(isNewsRelevantSymbol("DOGEUSDT", exch), false);
  assert.equal(isNewsRelevantSymbol("XAUUSDT", exch), false);
  // exchangeInfo 拉取失败（空对象）时只剩 BTC/ETH 恒标注
  assert.equal(isNewsRelevantSymbol("MUUSDT", {}), false);
});

test("newsLineFor: 不相关合约 → null（即使有事件）", () => {
  const exch = { DOGEUSDT: "COIN" };
  assert.equal(newsLineFor("DOGEUSDT", events, exch, { now: NOW }), null);
});

test("newsLineFor: 相关合约但窗口内无高影响数据 → null", () => {
  const exch = { MUUSDT: "EQUITY" };
  assert.equal(newsLineFor("MUUSDT", [], exch, { now: NOW }), null);
});

test("newsLineFor: BTCUSDT 标注 CPI 短名 + 北京时间（当天只显 HH:mm，跨天补 MM/DD）", () => {
  const line = newsLineFor("BTCUSDT", events, {}, { now: NOW });
  assert.ok(line.includes("未来 8h 有高影响数据 CPI（20:30）、FOMC声明（08/15 02:00）"));
  assert.ok(line.includes("数据前波动多为操纵"));
});

test("newsLineFor: 事件超过展示上限 → 追加等 N 项", () => {
  const many = [
    ...events,
    { title: "Fed Funds Rate", country: "USD", date: "2026-08-14T12:45:00Z", impact: "High" },
    { title: "PCE Price Index m/m", country: "USD", date: "2026-08-14T13:15:00Z", impact: "High" },
    { title: "Retail Sales m/m", country: "USD", date: "2026-08-14T13:30:00Z", impact: "High" },
  ];
  const line = newsLineFor("BTCUSDT", many, {}, { now: NOW });
  // 窗口内共 5 项 USD High（CPI 12:30、FOMC利率决议 12:45、PCE 13:15、零售销售 13:30、FOMC声明 18:00）
  // 最多列 3 个：CPI、FOMC利率决议、PCE → 追加"等 5 项"
  assert.match(line, /^未来 8h 有高影响数据 CPI（20:30）、FOMC利率决议（20:45）、PCE（21:15） 等 5 项/);
});
