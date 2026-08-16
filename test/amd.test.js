import { test } from "node:test";
import assert from "node:assert/strict";
import { computeAmdStage } from "../indicators/amd.js";
import { resolveInstrumentProfile } from "../indicators/instrumentProfile.js";

const PROFILE = resolveInstrumentProfile("BTCUSDT", { BTCUSDT: "COIN" });
const NOW = Date.UTC(2026, 7, 7, 13, 45); // 09:45 ET，交易日 2026-08-07
const ACTIVE_FROM = Date.UTC(2026, 7, 7, 4, 0); // Asia 00:00 ET 完成
const SESSION = {
  name: "ASIA", completed: true, tradingDayId: "2026-08-07",
  activeFrom: ACTIVE_FROM, high: 105, low: 95,
};
const IDENTITY = { originRangeId: "DR_AMD", rangeId: "DR_AMD", tradingDayId: "2026-08-07" };
const ssl = { type: "ASIA_LOW", side: "SSL", tier: 2, reclaimed: true, key: "ssl", time: Date.UTC(2026, 7, 7, 11), closedTime: Date.UTC(2026, 7, 7, 11, 5), ...IDENTITY };
const bsl = { type: "ASIA_HIGH", side: "BSL", tier: 2, reclaimed: true, key: "bsl", time: Date.UTC(2026, 7, 7, 11), closedTime: Date.UTC(2026, 7, 7, 11, 5), ...IDENTITY };

function confirmedSequence(sweep, direction = sweep.side === "SSL" ? "UP" : "DOWN") {
  return {
    id: `seq-${sweep.key}`,
    status: "ICT_CONFIRMED",
    primarySweep: sweep,
    direction,
    confirmedAt: sweep.closedTime,
    mssAt: sweep.closedTime + 10 * 60_000,
    confirmationFvg: { type: "FVG" },
    originRangeId: sweep.originRangeId,
    rangeId: sweep.rangeId,
    tradingDayId: sweep.tradingDayId,
  };
}

test("Session Range 未完成时保持 UNSET，不用 ER/ATR 伪造积累", () => {
  const r = computeAmdStage({ profile: PROFILE, sessionRange: { ...SESSION, completed: false }, now: NOW });
  assert.equal(r.stage, "UNSET");
});

test("当日 Asia Range 完成且尚无 raid → ACCUMULATION", () => {
  const r = computeAmdStage({ profile: PROFILE, sessionRange: SESSION, now: NOW });
  assert.equal(r.stage, "ACCUMULATION");
  assert.equal(r.tradingDayId, "2026-08-07");
  assert.match(r.reason, /等待流动性 raid/);
});

test("当日扫 SSL 收回但因果链未闭合 → MANIPULATION，预期向上", () => {
  const r = computeAmdStage({ profile: PROFILE, sessionRange: SESSION, sweeps: [ssl], bias: "BULLISH", now: NOW });
  assert.equal(r.stage, "MANIPULATION");
  assert.equal(r.direction, "BULLISH");
});

test("孤立 displacement 不能把 MANIPULATION 升级成 DISTRIBUTION", () => {
  const r = computeAmdStage({
    profile: PROFILE, sessionRange: SESSION, sweeps: [ssl], bias: "BULLISH", now: NOW,
    displacement: { time: ssl.closedTime + 1000, direction: "UP", ratio: 3 },
  });
  assert.equal(r.stage, "MANIPULATION");
});

test("同一 raid 的位移 MSS + 同一位移 FVG → DISTRIBUTION", () => {
  const seq = confirmedSequence(ssl);
  const r = computeAmdStage({ profile: PROFILE, sessionRange: SESSION, sweeps: [ssl], liquiditySequences: [seq], bias: "BULLISH", now: NOW });
  assert.equal(r.stage, "DISTRIBUTION");
  assert.equal(r.direction, "BULLISH");
  assert.equal(r.liquiditySequenceId, seq.id);
});

test("确认链方向与 HTF Bias 冲突 → 保持 MANIPULATION，不生成方向", () => {
  const r = computeAmdStage({ profile: PROFILE, sessionRange: SESSION, sweeps: [bsl], liquiditySequences: [confirmedSequence(bsl)], bias: "BULLISH", now: NOW });
  assert.equal(r.stage, "MANIPULATION");
  assert.match(r.reason, /冲突/);
});

test("跨交易日 raid 不得与今天 Session Range 拼接", () => {
  const old = { ...ssl, key: "old", tradingDayId: "2026-08-06", time: Date.UTC(2026, 7, 6, 11), closedTime: Date.UTC(2026, 7, 6, 11, 5) };
  const r = computeAmdStage({ profile: PROFILE, sessionRange: SESSION, sweeps: [old], liquiditySequences: [confirmedSequence(old)], bias: "BULLISH", now: NOW });
  assert.equal(r.stage, "ACCUMULATION");
});

test("更新的第二次 raid 必须等待自己的 MSS/FVG，不能复用旧链", () => {
  const newer = { ...bsl, key: "new", time: bsl.time + 60 * 60_000, closedTime: bsl.closedTime + 60 * 60_000 };
  const r = computeAmdStage({ profile: PROFILE, sessionRange: SESSION, sweeps: [ssl, newer], liquiditySequences: [confirmedSequence(ssl)], bias: "BULLISH", now: NOW });
  assert.equal(r.stage, "MANIPULATION");
  assert.equal(r.direction, "BEARISH");
});

test("AMD 不得把旧 Range 的确认链嫁接到当前 raid", () => {
  const oldRangeSequence = { ...confirmedSequence(ssl), originRangeId: "DR_OLD", rangeId: "DR_OLD" };
  const r = computeAmdStage({
    profile: PROFILE,
    sessionRange: SESSION,
    sweeps: [ssl],
    liquiditySequences: [oldRangeSequence],
    bias: "BULLISH",
    now: NOW,
  });
  assert.equal(r.stage, "MANIPULATION");
  assert.equal(r.liquiditySequenceId, null);
});

test("股票关联使用 PRE_MARKET 同日模型，不接收 Crypto Asia Range", () => {
  const equity = resolveInstrumentProfile("MUUSDT", { MUUSDT: "EQUITY" });
  const wrong = computeAmdStage({ profile: equity, sessionRange: SESSION, now: NOW });
  assert.equal(wrong.stage, "UNSET");
  assert.equal(wrong.sessionModel, "US_EQUITY");
});
