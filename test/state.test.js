import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanupState, compareState } from "../monitor/state.js";

test("cleanupState: 剔除跌出 list 的残留合约，保留 list 内合约", () => {
  const state = {
    BTCUSDT: { bias: "BULLISH" },
    ETHUSDT: { bias: "NEUTRAL" },
    OLDUSDT: { bias: "BEARISH" }, // 已跌出 Top15 的残留
  };
  const cleaned = cleanupState(state, ["BTCUSDT", "ETHUSDT"]);
  assert.deepEqual(Object.keys(cleaned).sort(), ["BTCUSDT", "ETHUSDT"]);
  assert.equal(cleaned.BTCUSDT.bias, "BULLISH");
});

test("cleanupState: list 内但 state 无记录的合约不出现", () => {
  const cleaned = cleanupState({ BTCUSDT: { bias: "NEUTRAL" } }, ["BTCUSDT", "ETHUSDT"]);
  assert.deepEqual(Object.keys(cleaned), ["BTCUSDT"]);
});

test("cleanupState: 空 state / 空 list 均返回空对象", () => {
  assert.deepEqual(cleanupState({}, ["BTCUSDT"]), {});
  assert.deepEqual(cleanupState({ BTCUSDT: { bias: "NEUTRAL" } }, []), {});
});

test("compareState: 4H 临时跌破与 HTF 临时突破会独立触发通知", () => {
  const prev = { bias: "BULLISH", confidence: "MEDIUM", decision: "WATCH", structureAlert: null, htfAlert: null };
  const cur = { ...prev, structureAlert: "DOWN_65000", htfAlert: "1D_BULLISH_70000" };
  assert.deepEqual(compareState(prev, cur).changes, ["structureAlert", "htfAlert"]);
});
