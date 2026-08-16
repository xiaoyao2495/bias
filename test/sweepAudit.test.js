import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyLiquidityEvent, detectSweepEvents } from "../indicators/sweep.js";
import {
  attachSweepNotificationAudit,
  buildSweepAudit,
  formatSweepAudit,
  SWEEP_AUDIT_REASON,
} from "../indicators/sweepAudit.js";

const now = Date.now();
const k = (i, high, low, close) => ({ time: now - (4 - i) * 300_000, closeTime: now - (3 - i) * 300_000, open: close, high, low, close });

test("审计原因覆盖：无数据、无池、未刺破、L1等待收回", () => {
  assert.equal(buildSweepAudit().marketReason, SWEEP_AUDIT_REASON.DATA_UNAVAILABLE);
  assert.equal(buildSweepAudit({ h5m: [k(0, 101, 99, 100)], now }).marketReason, SWEEP_AUDIT_REASON.NO_ELIGIBLE_LIQUIDITY);
  const noPierce = buildSweepAudit({ h5m: [k(0, 101, 99, 100)], buyLevels: [{ price: 105 }], now });
  assert.equal(noPierce.marketReason, SWEEP_AUDIT_REASON.NO_PIERCE);
  const l1 = buildSweepAudit({
    h5m: [k(0, 106, 104, 105.5)], buyLevels: [{ price: 105 }],
    sweeps: [{ tier: 1 }], now,
  });
  assert.equal(l1.marketReason, SWEEP_AUDIT_REASON.WAITING_RECLAIM);
});

test("L2 审计区分：等待结构、普通收破无位移、位移但没有ICT有效FVG", () => {
  const input = {
    h5m: [k(0, 106, 104, 104.5)],
    buyLevels: [{ price: 105 }],
    sweeps: [{ tier: 2, originRangeId: "DR_A" }],
    now,
  };
  assert.equal(buildSweepAudit(input).marketReason, SWEEP_AUDIT_REASON.WAITING_STRUCTURE);
  const ordinary = { status: "STRUCTURE_BREAK", confirmedAt: now, firstMss: { confirmedByDisplacement: false } };
  assert.equal(buildSweepAudit({ ...input, sequences: [ordinary] }).marketReason, SWEEP_AUDIT_REASON.NO_DISPLACEMENT);
  const displaced = { status: "DISPLACEMENT_CONFIRMED", confirmedAt: now, firstMss: { confirmedByDisplacement: true } };
  assert.equal(buildSweepAudit({ ...input, sequences: [displaced] }).marketReason, SWEEP_AUDIT_REASON.NO_ICT_FVG);
});

test("L2 在没有确认 Dealing Range 时不得升级，并给出明确审计原因", () => {
  const audit = buildSweepAudit({
    h5m: [k(0, 106, 104, 105)],
    buyLevels: [{ price: 105 }],
    sweeps: [{ tier: 2, reclaimed: true }],
    sequences: [],
    now,
    dealingRangeReady: false,
  });
  assert.equal(audit.marketReason, "NO_CONFIRMED_DEALING_RANGE");
  assert.equal(audit.dealingRangeReady, false);
});

test("当前虽有 Range，但 sweep 发生时尚未绑定 Range，审计不得误写等待结构", () => {
  const audit = buildSweepAudit({
    h5m: [k(0, 106, 104, 104.5)],
    buyLevels: [{ price: 105 }],
    sweeps: [{ tier: 2, time: now - 300_000 }],
    sequences: [{ status: "RAID", confirmedAt: now - 300_000, firstMss: null }],
    now,
    dealingRangeReady: true,
    rangeId: "DR_NEW",
  });
  assert.equal(audit.marketReason, SWEEP_AUDIT_REASON.NO_RANGE_AT_EVENT);
});

test("外部资产最近窗口全部处于休市时，审计明确显示市场关闭", () => {
  const audit = buildSweepAudit({
    h5m: [k(0, 106, 104, 104.5)],
    buyLevels: [{ price: 105 }],
    now,
    eventTimeAllowed: () => false,
  });
  assert.equal(audit.marketReason, SWEEP_AUDIT_REASON.MARKET_CLOSED);
  assert.equal(audit.recentBars, 0);
  assert.equal(audit.rawRecentBars, 1);
});

test("因果链构建异常优先进入扫损审计，不再静默表现为等待结构", () => {
  const audit = buildSweepAudit({
    h5m: [k(0, 100, 99, 99.5)],
    buyLevels: [{ type: "PDH", price: 101 }],
    sweeps: [{ tier: 2 }],
    pipelineError: { stage: "SWEEP_MSS_FVG_SEQUENCE", message: "fixture failure" },
  });
  assert.equal(audit.marketReason, SWEEP_AUDIT_REASON.PIPELINE_ERROR);
  assert.equal(audit.pipelineError.message, "fixture failure");
});

test("L3 与通知层分别审计 READY、去重和L1过期", () => {
  const audit = buildSweepAudit({
    h5m: [k(0, 106, 104, 104.5)], buyLevels: [{ price: 105 }], sweeps: [{ tier: 3 }], now, rangeId: "DR_A",
  });
  assert.equal(audit.marketReason, SWEEP_AUDIT_REASON.ICT_CONFIRMED);
  assert.equal(attachSweepNotificationAudit(audit, [{ tier: 3 }], [{ tier: 3 }], now).notification.reason, "READY_TO_NOTIFY");
  assert.equal(attachSweepNotificationAudit(audit, [{ tier: 3 }], [], now).notification.reason, "DEDUPED_OR_ALREADY_NOTIFIED");
  assert.equal(attachSweepNotificationAudit(audit, [{ tier: 1, time: now - 21 * 60_000 }], [], now).notification.reason, "L1_EXPIRED");
  assert.match(formatSweepAudit(audit), /range=DR_A.*L3:1.*L3_ICT_CONFIRMED/);
});

test("重启回放：相同 rangeId 的扫损 key 稳定；新区间不会与旧区间共用 key", () => {
  const rows = [
    k(0, 104, 100, 103),
    k(1, 106, 103, 104), // 刺破 105 并收回
  ];
  const level = { type: "EXTERNAL_HIGH", price: 105, activeFrom: 0, originRangeId: "DR_STABLE", rangeId: "DR_STABLE" };
  const first = detectSweepEvents(rows, [level], [], null, 48)[0];
  const afterRestart = detectSweepEvents(rows.map((row) => ({ ...row })), [{ ...level }], [], null, 48)[0];
  assert.equal(first.key, afterRestart.key);
  assert.match(first.key, /DR_STABLE/);
  const newRange = detectSweepEvents(rows, [{ ...level, originRangeId: "DR_NEXT", rangeId: "DR_NEXT" }], [], null, 48)[0];
  assert.notEqual(first.key, newRange.key);
});

test("逐根回放：同一池只允许 L1→L2→L3 正向升级且 baseKey 不变", () => {
  const level = { type: "EXTERNAL_HIGH", price: 105, activeFrom: 0, originRangeId: "DR_REPLAY", rangeId: "DR_REPLAY" };
  const takenRows = [k(0, 104, 100, 103), k(1, 106, 104, 105.5)];
  const l1 = detectSweepEvents(takenRows, [level], [], null, 48)[0];
  assert.equal(l1.tier, 1);

  const reclaimedRows = [...takenRows, k(2, 105.4, 103, 104)];
  const l2 = detectSweepEvents(reclaimedRows, [level], [], null, 48)[0];
  assert.equal(l2.tier, 2);
  assert.equal(l2.baseKey, l1.baseKey);

  const l3 = classifyLiquidityEvent({
    ...l2,
    tradingDayId: "2026-08-16",
    mss5m: { lastEvent: { confirmedByDisplacement: true, originRangeId: "DR_REPLAY", rangeId: "DR_REPLAY", tradingDayId: "2026-08-16", displacementId: "DISP_REPLAY" } },
    confirmationFvg: { executable: true, originRangeId: "DR_REPLAY", rangeId: "DR_REPLAY", tradingDayId: "2026-08-16", displacementId: "DISP_REPLAY" },
  });
  assert.equal(l3.tier, 3);
  assert.equal(l3.baseKey, l1.baseKey);
  assert.deepEqual([l1.tier, l2.tier, l3.tier], [1, 2, 3]);
});
