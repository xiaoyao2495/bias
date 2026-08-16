/**
 * runMonitor.js — Monitor 常驻入口（pm2 保活，进程内自调度）
 *
 * 流程：
 *   getTopVolumeSymbols(12, { exclude: ["SOLUSDT", "KORUUSDT"] }) → analyzeSymbols（串行，防限频）
 *   → compareState → 状态变化则推钉钉 → saveState → 睡到下一个对齐点
 *
 * 调度（北京时间）：
 *   全天每 10 分钟对齐检测一次（pm2 只负责保活，进程内自调度）。
 *
 * 推送策略：
 *   首轮（state.json 无记录）→ 推送一次全览（10 合约当前状态）
 *   后续轮次 → 只推状态变化的合约：
 *     bias 翻转        → ⚠️ {SYMBOL} 4H Bias Changed（含 旧 → 新 对比）
 *     confidence/decision 变化 → ℹ️ {SYMBOL} 4H Bias Updated
 *   4H 收盘报告 → 每根 4H 收线后（北京 00/04/08/12/16/20）即使无变化也推一次
 *     （记录在 monitor/closeReport.json，首轮全览已覆盖则不重复推）
 *   流动性扫损 → ⚡ {SYMBOL} 扫损：刺破/跌破流动性位后收回（state.sweepTime 去重）
 *
 * 用法：
 *   node scripts/runMonitor.js                # 常驻：Top10 全量（排除 SOLUSDT），自调度
 *   node scripts/runMonitor.js BTCUSDT ETHUSDT  # 常驻：指定合约（测试用）
 *   node scripts/runMonitor.js --once          # 只跑一轮后退出（手动/测试）
 *   node scripts/runMonitor.js --once --dry    # 只计算不推送
 *   DINGTALK_WEBHOOK=xxx node scripts/runMonitor.js  # 配置钉钉 webhook（必须）
 */
import { getTopVolumeSymbols } from "../monitor/topVolume.js";
import { analyzeSymbols } from "../monitor/biasMonitor.js";
import { scanOpportunities, OPP_MIN_SCORE } from "../monitor/opportunity.js";
import { loadState, saveState, compareState, cleanupState } from "../monitor/state.js";
import { sendMarkdown } from "../monitor/dingTalk.js";
import { loadCalendarEvents, loadExchangeInfo, newsLineFor } from "../monitor/newsCalendar.js";
import { getHistory, syncBinanceClock } from "../data/binance.js";
import { marketNow } from "../utils/marketClock.js";
import { attachSweepNotificationAudit, formatSweepAudit } from "../indicators/sweepAudit.js";
import { appendFileSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOG_FILE = join(__dirname, "..", "monitor", "log.txt");
const CLOSE_REPORT_FILE = join(__dirname, "..", "monitor", "closeReport.json"); // 记录已推送收盘报告的 4H 边界
const OPP_DIGEST_FILE = join(__dirname, "..", "monitor", "opportunityDigest.json"); // 记录机会榜上次推送时间
const NOTIFY_FILE = join(__dirname, "..", "monitor", "notifications.jsonl"); // 推送消息存档（JSONL，可下载供 AI 分析）
const NOTIFY_RETENTION_MS = 24 * 3600_000; // 存档保留时长：超过 24h 未更新则清空重写，文件始终只保留最近一天

/** 文件日志：Windows 上 pm2 的 out/err 日志空白，写文件便于在服务器上排查 */
function log(...args) {
  const ts = new Date(marketNow()).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });
  const line = `[${ts}] ${args.join(" ")}`;
  try {
    appendFileSync(LOG_FILE, line + "\n");
  } catch {}
  console.error(line);
}

/** 推送消息存档：每条钉钉消息追加一行 JSON 到 notifications.jsonl。
 *  用户可从服务器下载该文件（或粘贴内容）供 AI 分析实盘通知。
 *  保留策略：文件超过 NOTIFY_RETENTION_MS（24h）未更新则清空重写——文件永远只有最近一天的消息。
 *  @param {string} [filePath] 测试注入用；默认 NOTIFY_FILE */
export function appendNotification(text, title = "", filePath = NOTIFY_FILE) {
  try {
    const localNow = Date.now();
    const now = marketNow();
    const entry = {
      ts: new Date(now).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false }),
      tsMs: now,
      title,
      text,
    };
    try {
      if (localNow - statSync(filePath).mtimeMs > NOTIFY_RETENTION_MS) writeFileSync(filePath, "");
    } catch {}
    appendFileSync(filePath, JSON.stringify(entry) + "\n");
  } catch {}
}

/** 发送钉钉通知并同步存档（推送成功才入档，dry run 不推送自然不存档） */
async function sendNotification(text, title) {
  const data = await sendMarkdown(text, title);
  appendNotification(text, title);
  return data;
}

/** 扫损去重集合（兼容迁移）：继承上一轮已推送的 key；旧版单值 sweepTime 并入（视为已推送，不重推） */
function sweepPushedOf(prev, retained = {}) {
  const base = { ...retained, ...((prev && prev.sweepPushed) || {}) };
  if (prev && prev.sweepTime && !base[prev.sweepTime]) base[prev.sweepTime] = 1;
  return base;
}

/** 返回尚未推送的独立扫损事件；legacyKey 兼容升级前 `${time}_${side}` 去重记录。 */
export function pendingSweepEvents(sweeps, pushed = {}, now = marketNow()) {
  return (sweeps || []).filter((sweep) => {
    const eventAt = sweep.closedTime ?? sweep.reclaimTime ?? sweep.time;
    const eventTime = Number(eventAt);
    if (!Number.isFinite(eventTime)) return false;
    const age = now - eventTime;
    if (age < -SWEEP_FUTURE_TOLERANCE_MS || age > SWEEP_NOTIFY_MAX_AGE_MS) return false;
    if ((sweep.tier ?? 2) === 1 && age > L1_NOTIFY_MAX_AGE_MS) return false;
    if (pushed[sweep.key]) return false;
    const stageRank = (key) => key.endsWith("_ICT_2022_CONFIRMED") ? 3 : key.endsWith("_RECLAIMED_RAID") ? 2 : key.endsWith("_LIQUIDITY_TAKEN") ? 1 : 0;
    // 同一 baseKey 只允许向上升级；合并同价来源后也兼容任一旧来源 key，避免部署迁移重推。
    const baseKeys = [...new Set([
      sweep.baseKey,
      sweep.previousBaseKey,
      ...(sweep.sourceBaseKeys || []),
      ...(sweep.sourcePreviousBaseKeys || []),
    ].filter(Boolean))];
    if (baseKeys.some((baseKey) => Object.keys(pushed).some((key) => key.startsWith(`${baseKey}_`) && stageRank(key) >= (sweep.tier ?? 2)))) return false;
    // 旧 key 只代表旧版“已收回扫损”（现 L2），不能吞掉新增的 L1 或后续升级的 L3。
    return !((sweep.tier ?? 2) === 2 && sweep.legacyKey && pushed[sweep.legacyKey]);
  });
}

/**
 * 通知层按“同一确认时刻 + 同一方向”合并一波扫过的多个价位。
 * 检测层仍保留独立事件，确保每个池可以分别 L1→L2→L3 升级并独立去重。
 */
export function groupSweepNotifications(sweeps) {
  const groups = [];
  for (const sweep of sweeps || []) {
    const eventAt = sweep.closedTime ?? sweep.reclaimTime ?? sweep.time;
    let group = groups.find((item) => item.side === sweep.side && item.eventAt === eventAt);
    if (!group) {
      group = { side: sweep.side, eventAt, events: [] };
      groups.push(group);
    }
    group.events.push(sweep);
  }
  return groups.map((group) => {
    if (group.events.length === 1) return group.events[0];
    const ordered = [...group.events].sort((a, b) => (b.tier ?? 2) - (a.tier ?? 2));
    const primary = ordered[0];
    return {
      ...primary,
      notificationEvents: group.events,
      notificationKeys: [...new Set(group.events.map((event) => event.key).filter(Boolean))],
    };
  });
}

/** 机会去重时间：优先新稳定 key；升级首轮兼容旧版“滚动 index + 确认时间”key。 */
export function opportunityLastPushedAt(op, pushed = {}) {
  const direct = Number(pushed?.[op?.key]) || 0;
  if (direct || op?.type !== "RETRACE" || !op.zone) return direct;
  const bottom = String(op.zone.bottom);
  const top = String(op.zone.top);
  const prefix = `RETRACE_${op.direction}_`;
  const bounds = `_${bottom}_${top}`;
  return Math.max(0, ...Object.entries(pushed || {})
    .filter(([key]) => key.startsWith(prefix) && (key.endsWith(bounds) || key.includes(`${bounds}_`)))
    .map(([, ts]) => Number(ts) || 0));
}

// 模块加载即打点：诊断 pm2 进程是否真正加载/进入了该脚本
log(`[runMonitor] 模块加载（argv1=${process.argv[1] || "(无)"}，pm_exec_path=${process.env.pm_exec_path || "(无)"}，cwd=${process.cwd()}）`);

const TOP_N = 30;
/** 监控排除名单：用户不关注的合约（不参与 Top 排名，若在 N 内由后续补位）
 *  SOLUSDT 数据异常；KORUUSDT 标的为韩国半导体股，流动性时段特殊且近期误报频繁；
 *  SNXXUSDT、SKHYNIXUSDT 用户指定屏蔽 */
const EXCLUDE_SYMBOLS = ["SOLUSDT", "KORUUSDT", "SNXXUSDT", "SKHYNIXUSDT"];
const ICON = { BULLISH: "🟢", BEARISH: "🔴", NEUTRAL: "⚪" };
const BJ_OFFSET_MS = 8 * 3600_000;
/** 5m 机会扫描：5m 历史长度（≈3.5 天，swing 结构/执行区/MSS-BOS 历史用，缓存 TTL 5 分钟） */
const OPP_M5_LIMIT = 1000;
/** 同一机会 key 推送冷却（避免同一执行区/同一链条每 10 分钟重复推） */
const OPP_COOLDOWN_MS = 60 * 60_000;
const STATE_META_KEY = "__meta";
const SWEEP_HISTORY_TTL_MS = 24 * 3600_000;
const SWEEP_HISTORY_MAX_PER_SYMBOL = 500;
/** L1 只是“拿走但未收回”，只保留两个轮询周期的即时价值；L2/L3 仍可在 4h 事件窗内补报。 */
const L1_NOTIFY_MAX_AGE_MS = 20 * 60_000;
/** 48 根 5m 检测窗 + 一个轮询宽限；超过它说明行情快照已经陈旧，不得补发 L2/L3。 */
const SWEEP_NOTIFY_MAX_AGE_MS = 4 * 3600_000 + 10 * 60_000;
const SWEEP_FUTURE_TOLERANCE_MS = 10 * 60_000;

/** 去重历史独立于 Top30 当前成员保存，避免标的跌出后再进入导致旧事件重推。 */
export function pruneSweepPushed(pushed, now = marketNow()) {
  return Object.fromEntries(
    Object.entries(pushed || {})
      .filter(([, ts]) => ts === 1 || (Number.isFinite(Number(ts)) && now - Number(ts) <= SWEEP_HISTORY_TTL_MS))
      .sort((a, b) => Number(b[1]) - Number(a[1]))
      .slice(0, SWEEP_HISTORY_MAX_PER_SYMBOL)
  );
}

/** 数据驱动活跃成交量窗口展示；它不是 ICT 固定 Killzone。 */
function sessionText(s) {
  if (!s) return null;
  return `活跃窗口 ${String(s.start).padStart(2, "0")}:00-${String(s.end).padStart(2, "0")}:00（占比 ${s.ratio}%）`;
}

function ictSessionText(s) {
  return s ? `ICT Session ${s.label}` : "当前不在 ICT Killzone";
}

// 市场背景直白化：说明 4H 结构与日线优先、周线兜底的高周期方向关系。
const SCENARIO_CN = {
  BULLISH_CONTINUATION: "4H 与大周期一致向上",
  BEARISH_CONTINUATION: "4H 与大周期一致向下",
  BULLISH_REVERSAL_ATTEMPT: "4H 正在转多，但大周期仍偏空",
  BEARISH_REVERSAL_ATTEMPT: "4H 正在转空，但大周期仍偏多",
  RANGE: "方向不明确，价格处于震荡",
  TRANSITION: "新方向尚未确认",
};
function htfTimeframeCN(context) {
  const tf = context?.confirmedTimeframe;
  return tf === "1D" ? "日线" : tf === "1W" ? "周线" : tf === "1M" ? "月线" : "大周期";
}
const scenarioCN = (s, context) => (SCENARIO_CN[s] || s || "-").replaceAll("大周期", htfTimeframeCN(context));
/** 决策原因 → 中文（decision.reason 枚举映射，未命中保持原样） */
const REASON_CN = {
  "No directional bias": "无方向偏倚",
  "Direction probability too low": "方向概率过低",
  "No reward estimate (missing draw or invalidation)": "缺少有效目标或止损参考，无法评估结构空间",
  "Direction correct but reward insufficient (planR < 0.5)": "方向正确但第一目标结构空间不足",
  "Acceptable direction, but room limited — wait for retracement to improve R": "方向可接受但第一目标结构空间有限，等待更好位置",
  "Enough upside room with acceptable direction probability": "方向概率可接受且上方空间充足",
};
const reasonCN = (r) => (r ? REASON_CN[r] || r : "-");

/** 最终操作：方向评分只能说明“值得关注”，执行区未就绪或第一目标结构空间不足时仍必须等待。 */
export function resolveFinalAction(r, prev = null) {
  const directionDecision = r.decisionLabel;
  // planR 0.5 临界区保留旧动作，避免 NO TRADE/WAIT 每轮来回跳。
  if (r.reason === "Direction correct but reward insufficient (planR < 0.5)" && r.planR >= 0.45 && prev?.decision === "WAIT") return "WAIT";
  if (directionDecision === "WAIT" && r.planR <= 0.55 && prev?.decision === "NO TRADE") return "NO TRADE";
  if (directionDecision !== "WATCH") return directionDecision;

  const execution = r.execution;
  if (execution !== "READY") return "WAIT";
  if (r.planR == null || r.planR < 0.95) return "WAIT";
  // 1R 临界区使用旧状态，避免价格轻微波动造成 WATCH/WAIT 每十分钟翻转。
  if (r.planR < 1.05) return prev?.decision === "WATCH" ? "WATCH" : "WAIT";
  return "WATCH";
}

/**
 * 执行一轮监控：扫描 → 比较 → 推送变化 → 存状态。
 * @param {Object} [p]
 * @param {string[]} [p.symbols] 指定合约列表（默认 Top20，排除 SOLUSDT/KORUUSDT）
 * @param {number} [p.topN=30]
 * @param {boolean} [p.dryRun] 只计算不推送
 */
export async function runMonitor({ symbols, topN = TOP_N, dryRun = false } = {}) {
  await syncBinanceClock();
  const list = symbols && symbols.length ? symbols : (await getTopVolumeSymbols(topN, { exclude: EXCLUDE_SYMBOLS })).map((t) => t.symbol);
  log(`[runMonitor] 开始，合约数=${list.length}: ${list.join(",")}`);
  const prevState = loadState();
  const isFirstRun = Object.keys(prevState).filter((k) => k !== STATE_META_KEY).length === 0;
  const retainedSweepHistory = prevState[STATE_META_KEY]?.sweepPushedBySymbol || {};
  // 消息面窗口（范围：股票代币 + BTCUSDT/ETHUSDT；每周拉一次缓存一周，exchangeInfo 进程内缓存）
  // 每轮只加载一次，扫损 / Bias 变化消息复用同一份窗口数据
  let newsEvents = [];
  let newsClasses = {};
  try {
    [newsEvents, newsClasses] = await Promise.all([loadCalendarEvents(), loadExchangeInfo()]);
  } catch (e) {
    log(`[runMonitor] 消息面日历加载失败（降级，不标注）: ${e.message}`);
  }
  // 4H 收盘边界轮（到达新边界 或 首轮）→ 强制刷新 4H 缓存：
  // 收盘报告必须用最新已收盘 K（缓存快照在部分启动相位下会滞后一根，见 M1 相位扫描）；
  // 顺带让 Bias/结构检测在 4H 收盘后第一轮即生效，而非等 30min TTL 过期。
  const boundaryMs = latestBjBoundaryMs();
  const force4h = isFirstRun || boundaryMs > loadCloseReport();
  if (force4h) log(`[runMonitor] 4H 收盘边界轮 → 强制刷新 4H 数据`);
  const priorRanges = Object.fromEntries(list.map((symbol) => [symbol, prevState[symbol]?.rangeLifecycle || null]));
  const results = await analyzeSymbols(list, { onProgress: (n, t) => log(`[runMonitor] 分析进度 ${n}/${t}`), force4h, priorRanges, exchangeInfo: newsClasses });
  const failed = results.filter((r) => r.error).length;
  log(`[runMonitor] 分析完成：成功 ${results.length - failed} / ${results.length}`);
  const nextState = {};
  const overview = [];
  const changed = [];

  for (const r of results) {
    if (r.error) {
      console.error(`[runMonitor] ${r.symbol} 分析失败: ${r.error}`);
      // 保留该合约旧状态：saveState 是全量写入，若不保留，失败合约会被清掉，
      // 恢复后 compareState 视为 isNew 被静默跳过 → 漏推（major bug 修复）
      if (prevState[r.symbol]) nextState[r.symbol] = prevState[r.symbol];
      continue;
    }
    const prev = prevState[r.symbol] || null;
    const finalDecision = resolveFinalAction(r, prev);
    const cur = {
      bias: r.bias,
      structureBias: r.structureBias,
      narrativeBias: r.narrativeBias,
      executionBias: r.executionBias || r.bias,
      drawOnLiquidity: r.drawOnLiquidity || null,
      narrativeContext: r.narrativeContext || null,
      htfContext: r.htfContext,
      confidence: r.confidence,
      decision: finalDecision,
      directionDecision: r.decisionLabel,
      execution: r.execution,
      location: r.location,
      context: r.context,
      rangePosition: r.rangePosition,
      dealingRangeReady: r.dealingRangeReady === true,
      rangeObservation: r.rangeObservation || null,
      scenario: r.scenario,
      instrumentProfile: r.instrumentProfile || null,
      sessionRange: r.sessionRange || null,
      referenceSessionRange: r.referenceSessionRange || null,
      amd: r.amd || null,
      activeVolumeWindow: r.activeVolumeWindow || r.session,
      ictSession: r.ictSession || null,
      executionSession: r.executionSession || null,
      session: r.session, // 兼容旧 state；语义为 activeVolumeWindow
      quality: r.quality,
      planR: r.planR,
      remotePlanR: r.remotePlanR,
      riskLine: r.riskLine ?? null, // planR 的最近失效线（消息层算等效回撤点用）
      structureSpaceRatio: r.structureSpaceRatio,
      remoteStructureSpaceRatio: r.remoteStructureSpaceRatio,
      targets: r.targets,
      rangeLifecycle: r.rangeLifecycle || null,
      sweepAudit: r.sweepAudit || null,
      // 扫损事件去重：已推送的扫损 key 集合（key = 5m K 开盘时间_方向）。
      // 原为单值 sweepTime，位列表漂移（INTERNAL_HIGH→PDH 或新事件插入）导致检测事件在
      // 新旧 key 间切换时旧事件被重复推（08/15 SNDK/BZ/ZEC/BNB 5 处重复）；集合保证同 key 永不重推。
      sweepPushed: sweepPushedOf(prev, retainedSweepHistory[r.symbol]), // 兼容迁移 + Top30 进出保留
      ob: r.ob, // { type, kind, state, ... } | null（最近 Order Block 细类）
      structureAlert: r.provisionalStructureBreak
        ? `${r.provisionalStructureBreak.direction}_${r.provisionalStructureBreak.level}`
        : null,
      htfAlert: r.htfContext?.provisionalBreak
        ? `${r.htfContext.provisionalBreak.timeframe}_${r.htfContext.provisionalBreak.direction}_${r.htfContext.provisionalBreak.level}`
        : null,
      oppPushed: (prev && prev.oppPushed) || {}, // 5m 机会推送去重（key → 推送时间戳），冷却期内不重复推
    };
    nextState[r.symbol] = cur;
    const cmp = compareState(prev, cur);
    const item = {
      symbol: r.symbol,
      price: r.price,
      analysisTime: r.analysisTime,
      newsLine: newsLineFor(r.symbol, newsEvents, newsClasses), // 消息面窗口标注（股票代币 + BTC/ETH）
      confluenceScore: r.confluenceScore ?? r.confidenceScore,
      confidenceScore: r.confidenceScore,
      reason: r.reason,
      structureStatus: r.structureStatus,
      invalidation: r.invalidation,
      mssInvalidation: r.mssInvalidation,
      structureProtection: r.structureProtection,
      mss: r.mss,
      provisionalStructureBreak: r.provisionalStructureBreak,
      htfContext: r.htfContext,
      mss5m: r.mss5m,
      last4h: r.last4h,
      sweep: r.sweep,
      sweeps: r.sweeps || (r.sweep ? [r.sweep] : []),
      liquiditySequences: r.liquiditySequences || [],
      sweepAudit: r.sweepAudit || null,
      rangeTransition: r.rangeTransition || null,
      displacement: r.displacement,
      executionZones: r.executionZones,
      instrumentProfile: r.instrumentProfile || null,
      sessionRange: r.sessionRange || null,
      referenceSessionRange: r.referenceSessionRange || null,
      amd: r.amd || null,
      ...cmp,
      prev,
      cur,
    };
    overview.push(item);
    if (cmp.changed) changed.push(item);
  }

  // 检测层与通知层分开审计：市场事件存在但 pending=0 时，可以明确判断是去重/过期，
  // 不再把“一直没通报”笼统归因于扫损检测。dry-run 也计算并打印，但不写 state。
  for (const item of overview) {
    item.pendingSweeps = pendingSweepEvents(item.sweeps, item.cur.sweepPushed);
    item.sweepAudit = attachSweepNotificationAudit(item.sweepAudit, item.sweeps, item.pendingSweeps);
    item.cur.sweepAudit = item.sweepAudit;
    log(`[sweep-audit] ${item.symbol} ${formatSweepAudit(item.sweepAudit)}`);
    if (item.rangeTransition?.changed) {
      log(`[range] ${item.symbol} ${item.rangeTransition.reason}: ${item.rangeTransition.from || "-"} -> ${item.rangeTransition.to || "-"}`);
    }
  }

  if (!dryRun) {
    if (isFirstRun) {
      try {
        await sendNotification(buildOverview(overview), "4H Bias Monitor");
        log(`[runMonitor] 首轮全览已推送（${overview.length} 合约）`);
      } catch (e) {
        log(`[runMonitor] 首轮全览推送失败: ${e.message}`);
      }
    } else {
      for (const item of changed) {
        // 新加入合约（isNew）无 prev→cur 对比上下文，不推送（静默存状态，等下次变化再推）
        if (item.isNew) continue;
        try {
          await sendNotification(buildChanged(item), `${item.symbol} Bias`);
          log(`[runMonitor] 已推送 ${item.symbol}（${item.changes.join(",")}）`);
        } catch (e) {
          // 推送失败不落地新状态 → 下一轮 compareState 仍变化 → 重推（宁可重复不漏报）
          log(`[runMonitor] ${item.symbol} Bias 推送失败，保留旧状态下轮重试: ${e.message}`);
          nextState[item.symbol] = prevState[item.symbol];
        }
      }
      log(`[runMonitor] 本轮完成: ${changed.length} 变化 / ${overview.length} 合约`);
    }
    // 流动性扫损是独立事件：首轮及新进入 Top30 的标的也必须推；cur 已合并跨 Top30 的历史去重。
    for (const item of overview) {
      const pendingSweeps = item.pendingSweeps || [];
      for (const sweep of groupSweepNotifications(pendingSweeps)) {
        try {
          await sendNotification(
            buildSweep({ ...item, sweep, mss5m: sweep.mss5m || null }),
            `${item.symbol} 扫损`,
          );
          const pushedAt = marketNow();
          const pushedKeys = sweep.notificationKeys?.length ? sweep.notificationKeys : [sweep.key];
          for (const key of pushedKeys) nextState[item.symbol].sweepPushed[key] = pushedAt;
          const levels = sweep.notificationEvents?.length
            ? sweep.notificationEvents.map((event) => event.level).join(", ")
            : sweep.level;
          log(`[runMonitor] 已推送 ${item.symbol} 扫损（${sweep.side} @ ${levels}）`);
        } catch (e) {
          // 本轮 key 未写入 nextState.sweepPushed → 下一轮仍视为新扫损 → 重推（不漏报流动性事件）
          log(`[runMonitor] ${item.symbol} 扫损推送失败，保留旧记录下轮重试: ${e.message}`);
        }
      }
    }
    // P2：5m 机会发现（顺 4H Bias 的入场触发器）。真实运行首轮不推（全览已覆盖整体），
    // 非首轮每轮扫描 + 新机会推送（key 冷却去重）；dry 模式也扫描打点，便于本地验证。
    if (!isFirstRun || dryRun) {
      try {
        await scanAndPushOpportunities({ overview, prevState, nextState, dryRun });
      } catch (e) {
        log(`[runMonitor] 机会扫描失败: ${e.message}`);
      }
    }
    // 4H 收盘报告：每根 4H 收线后即使无状态变化也推一次（首轮全览已覆盖，只记录边界不推）
    // boundaryMs 已在轮首计算（同时决定 force4h 刷新）
    if (!isFirstRun && boundaryMs > loadCloseReport()) {
      try {
        await sendNotification(buildCloseReport(overview), "4H 收盘报告");
        log(`[runMonitor] 4H 收盘报告已推送（边界 ${new Date(boundaryMs).toISOString()}）`);
        saveCloseReport(boundaryMs); // 推送成功才记录边界，失败下轮重试
      } catch (e) {
        log(`[runMonitor] 4H 收盘报告推送失败: ${e.message}`);
      }
    }
    // 当前状态仍只保留 Top30；扫损 key 另存 meta（24h/每标的 500 条），避免跌出再进入时重复推。
    const sweepPushedBySymbol = { ...retainedSweepHistory };
    for (const [symbol, state] of Object.entries(nextState)) {
      sweepPushedBySymbol[symbol] = pruneSweepPushed(state.sweepPushed);
    }
    for (const [symbol, pushed] of Object.entries(sweepPushedBySymbol)) {
      const pruned = pruneSweepPushed(pushed);
      if (Object.keys(pruned).length) sweepPushedBySymbol[symbol] = pruned;
      else delete sweepPushedBySymbol[symbol];
    }
    saveState({ ...cleanupState(nextState, list), [STATE_META_KEY]: { sweepPushedBySymbol } });
    log(`[runMonitor] 状态已保存（${Object.keys(nextState).length} 合约）`);
  }

  return { firstRun: isFirstRun, changed, overview };
}

/**
 * 距下一个对齐点（北京时间）的等待毫秒数。
 * 全天每 10 分钟对齐检测一次。
 * 用 UTC 字段 + 8h 偏移模拟北京时间，与服务器时区无关。
 * @param {Date} [now] 测试可注入
 */
export function nextDelayMs(now = new Date(marketNow())) {
  const bj = new Date(now.getTime() + BJ_OFFSET_MS);
  const mins = bj.getUTCHours() * 60 + bj.getUTCMinutes() + bj.getUTCSeconds() / 60 + bj.getUTCMilliseconds() / 60000;
  const step = 10; // 全天统一每 10 分钟对齐
  const nextSlot = Math.floor(mins / step) * step + step; // 严格大于当前的对齐点
  return Math.max((nextSlot - mins) * 60_000, 1000); // 至少 1 秒，避免忙循环
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 常驻循环：立即跑一轮，之后按北京时间对齐点定时检测（变化才推送）。
 * @param {Object} [p]
 * @param {string[]} [p.symbols]
 * @param {number} [p.intervalMs] 覆盖调度间隔（测试用）
 */
export async function startMonitorLoop({ symbols, intervalMs } = {}) {
  await runMonitor({ symbols });
  for (;;) {
    const delay = intervalMs ?? nextDelayMs(new Date(marketNow()));
    const next = new Date(marketNow() + delay);
    log(`[monitor] 下次检测: ${next.toISOString()}（${Math.round(delay / 60000)} 分钟后）`);
    await sleep(delay);
    try {
      await runMonitor({ symbols });
    } catch (e) {
      log(`[monitor] 本轮失败: ${e.message}，继续下一轮`);
    }
  }
}

/**
 * 最近一个已过的 4H 边界（北京时间 00/04/08/12/16/20 整点）对应的 epoch ms。
 * 用 UTC 字段 + 8h 偏移模拟北京时间，与服务器时区无关。
 * @param {Date} [now]
 */
export function latestBjBoundaryMs(now = new Date(marketNow())) {
  const bj = new Date(now.getTime() + BJ_OFFSET_MS);
  const startOfBjDay = Date.UTC(bj.getUTCFullYear(), bj.getUTCMonth(), bj.getUTCDate());
  const mins = bj.getUTCHours() * 60 + bj.getUTCMinutes();
  const boundaryMin = Math.floor(mins / 240) * 240; // 4H = 240 分钟
  return startOfBjDay + boundaryMin * 60000 - BJ_OFFSET_MS;
}

/** 4H 收盘报告记录：已推送到的边界（无记录 → 0） */
function loadCloseReport() {
  try {
    return JSON.parse(readFileSync(CLOSE_REPORT_FILE, "utf8")).lastBoundary || 0;
  } catch {
    return 0;
  }
}

function saveCloseReport(boundaryMs) {
  writeFileSync(CLOSE_REPORT_FILE, JSON.stringify({ lastBoundary: boundaryMs }));
}

/** 4H 收盘报告：分开表达有效方向、4H 结构、HTF 背景与当前 4H 内的 5m 行为。 */
export function buildCloseReport(overview) {
  const boundary = new Date(latestBjBoundaryMs());
  const bjBoundary = new Date(boundary.getTime() + BJ_OFFSET_MS);
  const label = `${String(bjBoundary.getUTCHours()).padStart(2, "0")}:00`;
  // 数据驱动后无全局 Killzone 窗口：统计本时段处于自身活跃窗口的合约数，反映整体活跃度（0 时省略）
  const activeCount = overview.filter((r) => r.cur?.activeVolumeWindow || r.activeVolumeWindow || r.cur?.session || r.session).length;
  const kzText = activeCount > 0 ? ` · 本时段 ${activeCount}/${overview.length} 合约处于活跃窗口` : "";
  const lines = [`**4H 收盘报告**${kzText}（北京 ${label} 收线）`, ""];
  const expanded = [];
  const compact = [];
  const quietNeutral = [];
  const counts = { structure: 0, mss: 0, spike: 0, pressure: 0, ordinary: 0 };
  for (const r of overview) {
    const k = r.last4h;
    if (!k || k.open == null) continue;
    const pct = ((k.close - k.open) / k.open) * 100;
    const up = k.close >= k.open;
    const cur = r.cur || {};
    const structureBias = cur.structureBias || cur.bias || "NEUTRAL";
    const narrativeBias = cur.narrativeBias || r.htfContext?.confirmedDirection || "NEUTRAL";
    const conflict = r.structureStatus !== "INVALIDATED" && cur.bias === "NEUTRAL" && structureBias !== "NEUTRAL" && narrativeBias !== "NEUTRAL" && structureBias !== narrativeBias;
    const spike = Math.abs(pct) >= 5;
    const invalidationRisk = r.structureStatus === "INVALIDATED" ? null : invalidationDistance(r, k.close);
    const nearInvalidation = invalidationRisk != null && invalidationRisk <= 3;
    const oppositeDisp = r.displacement && cur.bias !== "NEUTRAL" && directionFromDisp(r.displacement) !== cur.bias;
    const failedDisp = displacementFailed(r.displacement, k.close);
    const strongOppositeDisp = oppositeDisp && r.displacement.ratio >= 2;
    const structureEvent = r.structureStatus === "INVALIDATED" || !!r.mss || !!r.provisionalStructureBreak || conflict;
    const important = spike || nearInvalidation || structureEvent || strongOppositeDisp || failedDisp;

    if (structureEvent) counts.structure++;
    if (nearInvalidation) counts.mss++;
    if (spike) counts.spike++;
    if (strongOppositeDisp || failedDisp) counts.pressure++;

    if (cur.bias === "NEUTRAL" && structureBias === "NEUTRAL" && !r.displacement && !important) {
      quietNeutral.push(r.symbol);
      continue;
    }

    const risk = closeReportRisk({ structureEvent, nearInvalidation, spike, strongOppositeDisp, oppositeDisp, failedDisp });
    const reportAction = closeReportAction(cur, risk);
    const conclusion = closeReportConclusion({ cur, structureBias, risk, reportAction, conflict, nearInvalidation, oppositeDisp, failedDisp });
    const marker = spike ? "⚡" : structureEvent || nearInvalidation ? "⚠️" : strongOppositeDisp ? "△" : "•";
    const detail = [];
    detail.push(`${marker} **${r.symbol}** ${up ? "收上" : "收下"} ${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%`);
    detail.push(`方向: ${biasDisplay(cur.bias)} · 模型信心 ${cur.confidence || "-"}${(r.confluenceScore ?? r.confidenceScore) != null ? ` · 共振评分 ${r.confluenceScore ?? r.confidenceScore}` : ""} · 当前风险 ${risk}`);
    detail.push(`建议操作: ${reportAction}${cur.decision && cur.decision !== reportAction ? `（模型 ${cur.decision}）` : ""}`);
    detail.push(`环境: ${structureSummary(structureBias, r.structureStatus)} · ${htfSummary(r.htfContext || cur.htfContext)}`);
    // 推动区间（审计）：说清当前 Impulse Range 从哪来、被什么推到哪（ICT Impulse = Liquidity → Displacement → Expansion）
    if (r.range && r.range.startReason && r.range.endReason) {
      const rangeTypeCN = r.range.rangeType === "IMPULSE_BULLISH" ? "多头推动" : r.range.rangeType === "IMPULSE_BEARISH" ? "空头推动" : "近期区间";
      detail.push(`推动区间: ${rangeTypeCN}（${r.range.startReason} ${fmtPrice(r.range.low)} → ${r.range.endReason} ${fmtPrice(r.range.high)}）`);
    }
    // AMD 阶段（ICT Market Maker Model：积累→操纵→分发；仅分发阶段有交易价值）
    if (r.amd) detail.push(`阶段: ${amdSummary(r.amd)}`);

    if (conflict) detail.push(`状态: 4H 与大周期方向冲突，反转证据不足，暂时保持中性`);
    if (r.structureStatus === "INVALIDATED" && r.mss) {
      detail.push(`4H结构事件: MSS ${r.mss.direction === "UP" ? "向上" : "向下"}突破 ${fmtPrice(r.mss.level)}，原结构失效`);
    } else if (r.provisionalStructureBreak) {
      detail.push(`实时预警: 已越过4H关键位 ${fmtPrice(r.provisionalStructureBreak.level)}，等待4H收盘确认`);
    }
    if (r.displacement) detail.push(displacementSummary(r.displacement, up, cur.bias, k.close));
    if (invalidationRisk != null) {
      detail.push(`4H MSS确认位: 距离 ${invalidationRisk.toFixed(2)}%${nearInvalidation ? "，接近结构转移确认位" : ""}`);
    }
    const deepRisk = levelDistance(r.structureProtection || r.invalidation, k.close);
    if (deepRisk != null && (r.structureProtection?.price !== r.mssInvalidation?.price)) {
      detail.push(`4H深层保护位: 距离 ${deepRisk.toFixed(2)}%（趋势最后防线，不是5m止损）`);
    }
    detail.push(`结论: ${conclusion}`);

    const row = { abs: Math.abs(pct), important, oppositeDisp, detail, compact: compactCloseRow(r.symbol, pct, cur, risk, reportAction) };
    if (important) expanded.push(row);
    else {
      compact.push(row);
      counts.ordinary++;
    }
  }
  expanded.sort((a, b) => (b.abs - a.abs));
  compact.sort((a, b) => (b.oppositeDisp - a.oppositeDisp) || (b.abs - a.abs));
  lines.push(`结构变化 ${counts.structure} · 临近MSS确认 ${counts.mss} · 大幅异动 ${counts.spike} · 短线压力 ${counts.pressure} · 普通 ${counts.ordinary} · 中性无事件 ${quietNeutral.length}`, "");
  for (const row of expanded) lines.push(...row.detail, "");
  if (compact.length) {
    lines.push("**普通状态**");
    for (const row of compact) lines.push(row.compact);
    lines.push("");
  }
  if (quietNeutral.length) lines.push(`中性无事件: ${quietNeutral.join("、")}`);
  return lines.join("<br/>");
}

function biasDisplay(bias) {
  return `${ICON[bias] || ""} ${{ BULLISH: "多头", BEARISH: "空头", NEUTRAL: "中性" }[bias] || bias || "-"}`;
}

/** AMD 阶段文案：积累/操纵/分发 + 方向 + 证据（ICT Market Maker Model） */
function amdSummary(amd) {
  if (!amd) return "-";
  const stageCN = { ACCUMULATION: "积累", MANIPULATION: "操纵", DISTRIBUTION: "分发" }[amd.stage] || amd.stage;
  const dirCN = amd.direction === "BULLISH" ? "多头" : amd.direction === "BEARISH" ? "空头" : null;
  const dir = dirCN ? `(${dirCN})` : "";
  return `${stageCN}${dir} · ${amd.reason || "-"}`;
}

function structureSummary(bias, status) {
  if (status === "INVALIDATED") return "4H结构已失效";
  return bias === "BULLISH" ? "4H多头结构有效" : bias === "BEARISH" ? "4H空头结构有效" : "4H结构方向未确认";
}

function htfSummary(context) {
  const direction = context?.confirmedDirection || "NEUTRAL";
  const tf = context?.confirmedTimeframe === "1D" ? "日线" : context?.confirmedTimeframe === "1W" ? "周线" : context?.confirmedTimeframe === "1M" ? "月线" : "大周期";
  const dir = direction === "BULLISH" ? "偏多" : direction === "BEARISH" ? "偏空" : "方向未确认";
  return `${tf}${dir}`;
}

function directionFromDisp(d) {
  return d.direction === "UP" ? "BULLISH" : "BEARISH";
}

function displacementFailed(d, candleClose) {
  const level = d?.structureBreak?.level;
  if (level == null || candleClose == null) return false;
  return d.direction === "UP" ? candleClose < level : candleClose > level;
}

function displacementSummary(d, candleUp, effectiveBias, candleClose) {
  const up = d.direction === "UP";
  const level = d.structureBreak?.level;
  const close = candleClose;
  const reclaimed = close != null && level != null && (up ? close < level : close > level);
  let behavior;
  if (reclaimed && up) behavior = "收盘重新跌回BOS下方，向上推动失败";
  else if (reclaimed && !up) behavior = "收盘重新站回BOS上方，向下推动失败";
  else if ((up && !candleUp) || (!up && candleUp)) behavior = `${up ? "向上" : "向下"}位移后收平/反向，尚未确认失败`;
  else if (effectiveBias === "NEUTRAL") behavior = "短线位移，仅观察";
  else if (directionFromDisp(d) === effectiveBias) behavior = "顺有效方向位移";
  else behavior = "与有效方向相反，短线压力增加";
  const time = d.time != null ? `${bjHHMM(d.time)} ` : "";
  const counts = d.count > 1
    ? `；本4H位移 向上${d.upCount ?? 0}次/向下${d.downCount ?? 0}次，主导${d.dominantDirection === "UP" ? "向上" : d.dominantDirection === "DOWN" ? "向下" : "均衡"}`
    : "";
  return `短线行为: ${time}5m${up ? "向上" : "向下"}位移 ${d.ratio.toFixed(1)}x${d.quality === "HIGH" ? "（高质量）" : ""}（${behavior}${counts}；${dispEvidence(d)}）`;
}

function closeReportRisk({ structureEvent, nearInvalidation, spike, strongOppositeDisp, oppositeDisp, failedDisp }) {
  if (structureEvent || nearInvalidation || (spike && strongOppositeDisp)) return "高";
  if (spike || strongOppositeDisp || oppositeDisp || failedDisp) return "中";
  return "低";
}

function closeReportAction(cur, risk) {
  if (cur.bias === "NEUTRAL" || risk === "高") return "WAIT";
  return cur.decision || "WAIT";
}

function closeReportConclusion({ cur, structureBias, risk, reportAction, conflict, nearInvalidation, oppositeDisp, failedDisp }) {
  if (conflict) return "4H 与大周期冲突，等待反转证据闭环";
  if (cur.bias === "NEUTRAL") return "当前没有可执行方向，继续等待";
  const side = structureBias === "BULLISH" ? "多头" : "空头";
  if (nearInvalidation) return `${side}尚未失效，但接近保护位，不适合继续追${side === "多头" ? "多" : "空"}`;
  if (oppositeDisp) return `${side}仍有效，但短线存在逆势压力，等待压力解除`;
  if (failedDisp) return `${side}仍有效，但本4H内的5m推动失败，等待重新确认动能`;
  if (risk === "高") return `${side}结构仍有效，但当前波动风险高，暂时等待`;
  return reportAction === "WATCH" ? `${side}结构有效，可继续观察入场条件` : `${side}结构有效，按计划等待更好位置`;
}

function compactCloseRow(symbol, pct, cur, risk, action) {
  return `• **${symbol}** ${pct >= 0 ? "+" : ""}${pct.toFixed(2)}% · ${biasDisplay(cur.bias)} · 风险${risk} · ${action}`;
}

function invalidationDistance(r, close) {
  // 新结果使用最近 swing 的 MSS 确认位；兼容测试/旧状态时才回退深层保护位。
  const level = (r.mssInvalidation || r.invalidation)?.price;
  const structureBias = r.cur?.structureBias || r.cur?.bias;
  if (level == null || close == null || close === 0 || (structureBias !== "BULLISH" && structureBias !== "BEARISH")) return null;
  const validSide = structureBias === "BULLISH" ? close > level : close < level;
  if (!validSide) return 0;
  return Math.abs(close - level) / Math.abs(close) * 100;
}

function levelDistance(level, close) {
  const price = level?.price;
  if (price == null || close == null || close === 0) return null;
  return Math.abs(close - price) / Math.abs(close) * 100;
}

function bjHHMM(ms) {
  return new Date(ms).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", hour12: false });
}

/** 扫损事件消息（⚡）：市场刚扫掉某流动性位后收回——带当前市场背景，帮助理解"在什么结构下发生" */
export function buildSweep({ symbol, sweep, price, cur, confidenceScore, mss5m, newsLine }) {
  const notificationEvents = sweep.notificationEvents?.length > 1 ? sweep.notificationEvents : null;
  const tier = notificationEvents
    ? Math.max(...notificationEvents.map((event) => event.tier ?? 2))
    : sweep.tier ?? 2;
  const stage = sweep.stage || "RECLAIMED_RAID";
  const sideText = sweep.side === "BSL" ? "上方买方流动性（BSL）" : "下方卖方流动性（SSL）";
  const levelTextOf = (event) => [...new Set(event.levelTypes?.length ? event.levelTypes : [event.type])]
    .map(sweepTypeLabel).join(" / ");
  const sweptTextOf = (event) => {
    const eventTier = event.tier ?? 2;
    const levelText = levelTextOf(event);
    if (eventTier === 1) return event.side === "BSL"
      ? `刺破 ${levelText} ${event.level}（高 ${event.sweptPrice}），尚未收回`
      : `跌破 ${levelText} ${event.level}（低 ${event.sweptPrice}），尚未收回`;
    return event.side === "BSL"
      ? `刺破 ${levelText} ${event.level}（高 ${event.sweptPrice}）后收回`
      : `跌破 ${levelText} ${event.level}（低 ${event.sweptPrice}）后收回`;
  };
  const timeTextOf = (event) => event.realtime
    ? `检测于 ${nowHHMM()}（本根 5m 进行中）`
    : event.reclaimTime != null
      ? `刺破 K: ${klineSpan(event.time)} → 收回 K: ${klineSpan(event.reclaimTime)}（跨根确认）`
      : (event.tier ?? 2) === 1
        ? `拿流动性 K: ${klineSpan(event.time)}（已收盘）`
        : `扫损 K: ${klineSpan(event.time)}（已收盘确认）`;
  const tag = notificationEvents
    ? notificationEvents.every((event) => event.realtime) ? "实时" : tier === 1 ? "已收盘" : "已确认"
    : sweep.realtime ? "实时" : tier === 1 ? "已收盘" : "已确认";
  const explicitTier = sweep.tier != null;
  const lines = [
    notificationEvents
      ? `**⚡ ${symbol} 流动性事件（合并 ${notificationEvents.length} 个池 · 最高 L${tier} · ${tag}）**  🕐 ${nowHHMM()}`
      : explicitTier
      ? `**⚡ ${symbol} 流动性事件 L${tier}（${tag}）**  🕐 ${nowHHMM()}`
      : `**⚡ ${symbol} 流动性扫损（${tag}）**  🕐 ${nowHHMM()}`,
    "",
  ];
  if (notificationEvents) {
    lines.push(`${sideText}本次波及 ${notificationEvents.length} 个独立流动性池：`);
    for (const event of notificationEvents) {
      lines.push(`L${event.tier ?? 2} · ${event.stage || "RECLAIMED_RAID"}：${sweptTextOf(event)}，收 ${event.close}`);
      lines.push(`${[levelFormedText(event), timeTextOf(event)].filter(Boolean).join(" · ")}`);
    }
    lines.push(`现价 ${price}`, "");
  } else {
    lines.push(
      ...(explicitTier ? [`级别: L${tier} · ${stage}`] : []),
      `${sideText}${tier === 1 ? "已被拿走" : "被扫"}：${sweptTextOf(sweep)}，收 ${sweep.close}`,
      `${[levelFormedText(sweep), timeTextOf(sweep), `现价 ${price}`].filter(Boolean).join(" · ")}`,
      "",
    );
  }
  // Judas Swing（ICT 2022）：NY Open 窗口内、方向与 4H Bias 相反的扫损 = 开盘假动作，
  // 先插针扫流动性（止损），随后反转走真方向 → 提醒别把假动作当方向信号
  if (sweep.judas) {
    lines.push(`⚠️ 开盘假动作（NY Open 窗口）: 方向与 4H Bias 相反，留意反转`);
    lines.push("");
  }
  // 消息面窗口（ICT 2022）：数据发布前的扫损可能是机构操纵，别当 Judas/结构信号
  if (newsLine) {
    lines.push(`⚠️ 消息面: ${newsLine}`);
    lines.push("");
  }
  lines.push(
    "环境:",
    `Bias: ${ICON[cur.bias] || ""} ${cur.bias}`,
    `活跃成交量: ${sessionText(cur.activeVolumeWindow || cur.session) || "当前不在统计活跃窗口"}`,
    ictSessionText(cur.ictSession),
    `市场背景: ${scenarioCN(cur.scenario, cur.htfContext)}`,
  );
  // P1-B：5m 结构事件（扫损→收回→MSS 是 ICT 经典链条，标注当前 5m 结构状态）
  if (mss5m && mss5m.lastEvent) {
    const ev = mss5m.lastEvent;
    const status = ev.confirmed ? "已确认" : ev.realtime ? "实时" : "";
    lines.push(`5m 结构: ${ev.semanticType || ev.type} ${ev.direction} @ ${ev.level}（${status}）`);
    if (tier === 3 && sweep.confirmationFvg) {
      const fvg = sweep.confirmationFvg;
      const fvgStatus = fvg.executionStatus || fvg.status || "OPEN";
      const quality = fvg.quality === "STRUCTURE" ? "结构级" : "位移级";
      lines.push(`ICT 2022确认: 位移主导 MSS · FVG ${fmtPrice(fvg.bottom)}-${fmtPrice(fvg.top)}（${quality} · ${fvgStatus}）`);
    }
  }
  lines.push(`模型信心: ${cur.confidence}${confidenceScore != null ? ` · 共振评分 ${confidenceScore}` : ""}`);
  lines.push(`操作: ${cur.decision}`);
  return lines.join("<br/>");
}

/** 位移证据摘要：结构突破位（BOS）+ 缺口区间（FVG）+ 可选量能倍率。
 *  位移硬条件来自价格交付；量能为辅助证据，BOS/FVG 为标签可能为空。FVG 极窄（宽度 ≤ 价格 0.02%，1 tick 级）
 *  时只显示单值，避免 0.05-0.05 噪音 */
function dispEvidence(d) {
  const parts = [];
  if (d.structureBreak && d.structureBreak.level != null) parts.push(`5m BOS ${fmtPrice(d.structureBreak.level)}`);
  if (d.fvg && d.fvg.top != null && d.fvg.bottom != null) {
    const narrow = d.fvg.top - d.fvg.bottom <= d.fvg.top * 0.0002;
    parts.push(narrow ? `5m FVG ${fmtPrice(d.fvg.bottom)}` : `5m FVG ${fmtPrice(d.fvg.bottom)}-${fmtPrice(d.fvg.top)}`);
  }
  if (d.volumeRatio != null) parts.push(`量 ${d.volumeRatio.toFixed(1)}x`);
  return parts.join("，");
}

/** 价格格式化：按量级自适应小数位（BTC 千级 1 位、百级 2 位、个位 3 位、低价币 5 位） */
function fmtPrice(n) {
  if (n == null) return "-";
  const abs = Math.abs(n);
  const digits = abs >= 1000 ? 1 : abs >= 100 ? 2 : abs >= 1 ? 3 : 5;
  return String(Number(n.toFixed(digits)));
}

/** 流动性位类型 → 中文标签 */
function sweepTypeLabel(type) {
  return (
    {
      PDH: "昨日高点",
      PDL: "昨日低点",
      PWH: "上周高点",
      PWL: "上周低点",
      PRE_MARKET_HIGH: "盘前高点",
      PRE_MARKET_LOW: "盘前低点",
      ASIA_HIGH: "亚洲时段高点",
      ASIA_LOW: "亚洲时段低点",
      EQH: "等高点",
      EQL: "等低点",
      EXTERNAL_HIGH: "区间外部高点（ERL）",
      EXTERNAL_LOW: "区间外部低点（ERL）",
      INTERNAL_HIGH: "内部摆动高点",
      INTERNAL_LOW: "内部摆动低点",
    }[type] || type
  );
}

/** 严格 ICT Order Block / Breaker → 直白交易文案。 */
function obText(o, bias, price) {
  if (!o) return null;
  if (o.status === "FILLED" || o.status === "INVALIDATED" || o.state === "INVALIDATED") return null;
  const midpoint = o.low != null && o.high != null ? (o.low + o.high) / 2 : null;
  if (price != null && midpoint != null && Math.abs(midpoint - price) / Math.abs(price) > 0.15) return null;

  const bullish = o.direction ? o.direction === "BULLISH" : String(o.type || "").startsWith("BULLISH");
  let position = null;
  if (price != null && o.low != null && o.high != null) {
    if (price < o.low) position = "ABOVE";
    else if (price > o.high) position = "BELOW";
    else position = "INSIDE";
  }

  let title;
  if (position === "INSIDE") title = bullish ? "当前支撑" : "当前阻力";
  else if (position === "ABOVE") title = bullish ? "上方多头区域" : "上方阻力";
  else if (position === "BELOW") title = bullish ? "下方支撑" : "下方空头区域";
  else title = bullish ? "多头支撑" : "空头阻力";

  let behavior;
  if (o.kind === "BREAKER") behavior = bullish ? "失败空头 OB 反转为多头 Breaker" : "失败多头 OB 反转为空头 Breaker";
  else behavior = bullish ? "结构上破位移产生的多头 OB" : "结构下破位移产生的空头 OB";

  const state = o.state === "FRESH"
    ? "尚未回踩"
    : o.state === "MITIGATED" || o.state === "USED"
      ? "已浅回踩"
      : o.state === "CE_REACHED"
        ? "已触及中点，消耗较深"
        : null;
  const relation =
    bias === "BULLISH" && !bullish
      ? "与当前多头方向相反"
      : bias === "BEARISH" && bullish
        ? "与当前空头方向相反"
        : null;
  const details = [state, relation].filter(Boolean).join("；");
  return `${title}: ${behavior}${details ? `（${details}）` : ""}`;
}

/** 首轮全览（紧凑，避免刷屏） */
export function buildOverview(list) {
  const lines = [`**4H Bias Monitor**  ${nowHHMM()}`, ""];
  for (const r of list) {
    lines.push(`**${r.symbol}** ${ICON[r.cur.bias] || ""} ${r.cur.bias}`);
    lines.push(`市场背景: ${scenarioCN(r.cur.scenario, r.cur.htfContext)} · 模型信心: ${r.cur.confidence}${(r.confluenceScore ?? r.confidenceScore) != null ? ` · 共振评分 ${r.confluenceScore ?? r.confidenceScore}` : ""} · 机会质量: ${r.cur.quality}${r.cur.planR != null ? ` (${formatPlanR(r.cur.planR)})` : ""} · 操作: ${r.cur.decision}`);
    lines.push("");
  }
  return lines.join("<br/>");
}

/** 结构状态描述（中文）：当前 Bias 对应 ICT 结构形态 */
function structureDesc(bias) {
  return bias === "BULLISH" ? "新多头结构形成（HH+HL）" : bias === "BEARISH" ? "新空头结构形成（LH+LL）" : "结构方向未确认";
}

/** 5m 机会类型 → 中文标签 */
const OPP_TYPE_CN = { CHAIN: "扫损→MSS→回踩", RETRACE: "执行区回踩", KEY_MSS: "关键位置MSS" };

/** 机会榜上次推送时间记录（monitor/opportunityDigest.json） */
function loadDigestTs() {
  try {
    return JSON.parse(readFileSync(OPP_DIGEST_FILE, "utf8")).lastTs || 0;
  } catch {
    return 0;
  }
}

function saveDigestTs(ts) {
  writeFileSync(OPP_DIGEST_FILE, JSON.stringify({ lastTs: ts }));
}

/**
 * P2：5m 机会发现（顺 4H Bias 的入场触发器）。
 * 对每个成功合约拉长 5m 历史 → scanOpportunities → 新机会推送（key 冷却去重）+
 * 每 30 分钟整点轮推送机会榜。全部副作用失败均降级，不阻断主监控。
 */
async function scanAndPushOpportunities({ overview, prevState, nextState, dryRun }) {
  const all = [];
  for (const item of overview) {
    try {
      const m5 = await getHistory(item.symbol, "5m", OPP_M5_LIMIT);
      const opps = scanOpportunities({ symbol: item.symbol, env: opportunityEnvOf(item), m5 });
      if (opps.length) log(`[runMonitor] ${item.symbol} 5m 机会 ${opps.length} 个（${opps.map((o) => o.type).join(",")}）`);
      all.push(...opps);
    } catch (e) {
      log(`[runMonitor] ${item.symbol} 机会扫描失败: ${e.message}`);
    }
  }
  if (!all.length) return;

  // 🎯 新机会推送：score ≥ 门槛 且 同 key 超过冷却期（推送成功才落地时间戳，失败下轮重试）
  for (const op of all) {
    if (op.score < OPP_MIN_SCORE) continue;
    const pushed = nextState[op.symbol].oppPushed;
    // 审计修复：旧版 state.json 合约条目无 oppPushed 字段（升级兼容），可选链避免
    // 首轮升级后整个机会扫描段抛 TypeError 中断（见审计重要 #4）
    const lastTs = opportunityLastPushedAt(op, pushed);
    if (marketNow() - lastTs < OPP_COOLDOWN_MS) continue;
    if (dryRun) {
      log(`[runMonitor][dry] 机会候选 ${op.symbol} ${op.type} ${op.direction} score=${op.score}`);
      continue;
    }
    try {
      await sendNotification(buildOpportunity(op, itemOf(op, overview)), `${op.symbol} 5m机会`);
      pushed[op.key] = marketNow();
      log(`[runMonitor] 已推送 ${op.symbol} 5m 机会（${op.type} score=${op.score}）`);
    } catch (e) {
      log(`[runMonitor] ${op.symbol} 机会推送失败，下轮重试: ${e.message}`);
    }
  }

  // 📊 机会榜：每 30 分钟整点轮（北京时间 0/30 分），距上次推送 ≥25 分钟去重
  const bjMin = new Date(marketNow() + BJ_OFFSET_MS).getUTCMinutes();
  const top = all.filter((o) => o.score >= OPP_MIN_SCORE).sort((a, b) => b.score - a.score).slice(0, 5);
  if (bjMin % 30 === 0 && top.length && marketNow() - loadDigestTs() >= 25 * 60_000) {
    if (dryRun) {
      log(`[runMonitor][dry] 机会榜 ${top.map((o) => `${o.symbol} ${o.type}(${o.score})`).join(", ")}`);
      return;
    }
    try {
      await sendNotification(buildOpportunityDigest(top), "5m 机会榜");
      saveDigestTs(marketNow());
      log(`[runMonitor] 5m 机会榜已推送（${top.length} 条）`);
    } catch (e) {
      log(`[runMonitor] 机会榜推送失败: ${e.message}`);
    }
  }
}

/** 将 runMonitor 的 overview 条目展开为机会扫描器约定的平铺环境。 */
export function opportunityEnvOf(item) {
  return {
    ...item,
    ...(item?.cur || {}),
    price: item?.price,
    structureStatus: item?.structureStatus,
    sweep: item?.sweep || null,
    sweeps: item?.sweeps || [],
    liquiditySequences: item?.liquiditySequences || [],
  };
}

/** 从 overview 中找回某机会对应的环境 item（含 cur/price/confidenceScore） */
function itemOf(op, overview) {
  return overview.find((i) => i.symbol === op.symbol) || {};
}

/** 5m 机会单条消息（🎯）：环境背景 + 入场参考 + 触发链条（钉钉格式规范） */
export function buildOpportunity(op, env) {
  const dirCN = op.direction === "BULLISH" ? "多头" : "空头";
  const cur = env.cur || {};
  const keyMss = op.type === "KEY_MSS";
  const lines = [
    `**${keyMss ? "🔔" : "🎯"} ${op.symbol} ${keyMss ? "关键位置5m结构确认" : "5m 机会"}**  🕐 ${nowHHMM()}`,
    "",
    `${ICON[op.direction] || ""} ${dirCN}（${OPP_TYPE_CN[op.type] || op.type}）· 评分 ${op.score}`,
  ];
  if (keyMss && op.localSweep) {
    const side = op.localSweep.side === "BSL" ? "上方短线流动性" : "下方短线流动性";
    lines.push(`流动性行为: 扫${side} ${fmtPrice(op.localSweep.level)}（极值 ${fmtPrice(op.localSweep.sweptPrice)}）`);
  }
  if (op.zone) {
    const quality = op.zone.quality === "STRUCTURE" ? " · 结构级" : op.zone.quality === "DISPLACEMENT" ? " · 位移级" : op.zone.quality === "RAW" ? " · 原始级" : "";
    const status = op.zone.executionStatus ? ` · ${op.zone.executionStatus}` : "";
    lines.push(`执行区: ${op.zone.type} ${fmtPrice(op.zone.bottom)}-${fmtPrice(op.zone.top)}${quality}${status}`);
  }
  // P1-3 后进入这里的信号已经通过已收盘 5m 确认；观察位仍只是执行区参考，
  // 交易计划的确认价与失效位单独展示，避免把区域边界误读成市价入场点。
  lines.push(`观察位: ${fmtPrice(op.entry)} · 现价 ${fmtPrice(env.price)}`);
  if (op.confirmation) {
    lines.push(`入场确认: ${op.confirmation.text} · 确认价 ${fmtPrice(op.confirmation.price)} · ${bjHHMM(op.confirmation.time)}`);
  }
  if (op.trade) {
    const stopSource = ["SWEEP_EXTREME", "LOCAL_SWEEP_EXTREME"].includes(op.trade.stopSource)
      ? "扫损极值"
      : op.trade.stopSource === "REJECTION_EXTREME"
        ? "回踩拒绝极值"
        : "5m执行区远端";
    lines.push(`${keyMss ? "5m参考计划" : "5m交易计划"}: 确认价 ${fmtPrice(op.trade.entry)} · 失效位 ${fmtPrice(op.trade.stop)}（${stopSource}）`);
    if (op.trade.target != null) {
      const planR = op.trade.planR;
      // V2.7：5m 微距止损 ÷ 4H 远端目标会让 planR 虚高到失真（如 NBIS 28.77R——
      // 止损 0.2% 一个插针即扫）。超过 10R 时标注止损过近，避免误读成高盈亏比。
      const warn = !keyMss && Number.isFinite(planR) && planR > 10 ? " · ⚠️止损过近，盈亏比失真" : "";
      lines.push(`第一目标: ${fmtPrice(op.trade.target)} · ${keyMss ? "参考" : "交易"} planR ${formatPlanR(planR)}${warn}`);
    } else {
      lines.push(`${keyMss ? "参考" : "交易"} planR: 暂无有效第一目标，暂不估算`);
    }
  }
  if (keyMss && op.marketState) {
    const progress = Number.isFinite(op.marketState.progressR) ? formatPlanR(op.marketState.progressR) : "-";
    const remaining = Number.isFinite(op.marketState.remainingR) ? formatPlanR(op.marketState.remainingR) : "-";
    lines.push(`当前状态: 已运行 ${progress}R · 剩余空间比 ${remaining}`);
  }
  lines.push(`环境: ${ICON[cur.bias] || ""} ${cur.bias || "-"} · 模型信心 ${cur.confidence || "-"}${(env.confluenceScore ?? env.confidenceScore) != null ? ` · 共振评分 ${env.confluenceScore ?? env.confidenceScore}` : ""} · 操作 ${cur.decision || "-"} · ${sessionText(cur.activeVolumeWindow || cur.session) || "非活跃窗口"} · ${ictSessionText(cur.ictSession)}`);
  if (env.amd) lines.push(`阶段: ${amdSummary(env.amd)}`);
  lines.push(`触发: ${op.trigger}`);
  if (keyMss) lines.push(`结论: 有效的5m转向证据；${op.displacementConfirmed ? "带位移确认" : "未形成位移/FVG，不是最高质量信号"}，操作 WATCH`);
  return lines.join("<br/>");
}

/** 5m 机会榜（📊）：每 30 分钟整点汇总当前 Top 5 机会 */
export function buildOpportunityDigest(list) {
  const lines = [`**📊 5m 机会榜**  🕐 ${nowHHMM()}`, "", `本时段 ${list.length} 个合约出现 5m 机会（评分 ≥ ${OPP_MIN_SCORE}）：`, ""];
  for (let i = 0; i < list.length; i++) {
    const o = list[i];
    const dirCN = o.direction === "BULLISH" ? "多头" : "空头";
    lines.push(`${i + 1}. ${o.symbol} ${ICON[o.direction] || ""} ${dirCN} ${OPP_TYPE_CN[o.type] || o.type} @ ${fmtPrice(o.entry)}（${o.score}）`);
  }
  return lines.join("<br/>");
}

/**
 * 状态变化消息（bias 翻转 → ⚠️，其余 → ℹ️）。
 * 变化原因分层：Bias 变化 → 市场状态（结构失效/新结构），与 Confidence 原因分离，
 * 避免"结构失效"被误读为"方向概率低"。
 */
export function buildChanged({ symbol, price, reason, changes, prev, cur, confidenceScore, structureStatus, invalidation, mssInvalidation, structureProtection, mss, provisionalStructureBreak, htfContext, newsLine }) {
  const biasFlipped = changes.includes("bias");
  const head = biasFlipped ? `**⚠️ ${symbol} 4H Bias 变化**  🕐 ${nowHHMM()}` : `**ℹ️ ${symbol} 4H Bias 更新**  🕐 ${nowHHMM()}`;
  const lines = [head, ""];

  if (biasFlipped) {
    lines.push(`${ICON[prev.bias] || ""} ${prev.bias} → ${ICON[cur.bias] || ""} ${cur.bias}`, "");
    // Change Reason：市场发生了什么（结构失效 = MSS 事件 → 突破保护位）
    if (structureStatus === "INVALIDATED" && mss) {
      // 无位移只是结构破坏；只有 displacement 交付才使用课程意义的 MSS 标签。
      const dirText = mss.direction === "UP" ? "向上突破" : "向下跌破";
      const structureEventName = mss.semanticType || (mss.confirmedByDisplacement ? "MSS" : "STRUCTURE_BREAK");
      lines.push(`**结构事件: ${structureEventName}**（${dirText} ${mss.level}，原 ${mss.structureFrom} 结构失效）`);
      lines.push(`触发: ${mss.time} · 价格 ${mss.price}`);
    } else if (structureStatus === "INVALIDATED") {
      const broken = invalidation && invalidation.type === "BREAK_PROTECTED_HIGH";
      const level = invalidation && invalidation.price != null ? invalidation.price : "-";
      lines.push(`结构: INVALIDATED（价格突破${broken ? "保护高位" : "保护低位"} ${level}，原 ${prev.bias} 结构失效）`);
    } else {
      lines.push(`结构: ${structureStatus || "-"}（${structureDesc(cur.structureBias || cur.bias)}）`);
    }
    lines.push("");
  } else {
    // ℹ️ 更新：补当前 Bias 与结构状态背景（bias 未变，无 旧→新 对比，但用户需一眼看到当前环境）
    lines.push(`${ICON[cur.bias] || ""} ${cur.bias}`);
    lines.push(`结构: ${structureStatus || "-"}（${structureDesc(cur.structureBias || cur.bias)}）`);
    lines.push("");
  }
  if (changes.includes("structureAlert")) {
    if (provisionalStructureBreak) {
      const dir = provisionalStructureBreak.direction === "DOWN" ? "向下跌破" : "向上突破";
      lines.push(`实时预警: 5m 已${dir} 4H 关键结构位 ${provisionalStructureBreak.level}，等待 4H 收盘确认`);
    } else {
      lines.push("实时预警解除: 价格已回到 4H 关键结构位内，4H 结构未失效");
    }
  }
  if (changes.includes("htfAlert")) {
    const p = htfContext?.provisionalBreak;
    if (p) {
      const tf = p.timeframe === "1D" ? "日线" : p.timeframe === "1W" ? "周线" : "月线";
      const dir = p.direction === "BULLISH" ? "向上突破" : "向下跌破";
      lines.push(`大周期预警: 价格正在${dir}${tf}关键位 ${p.level}，等待${tf}收盘确认`);
    } else {
      lines.push("大周期临时突破已解除，继续采用上次收盘确认方向");
    }
  }
  // 消息面窗口（ICT 2022）：数据发布前/后的 Bias 变化可能是操纵，勿当真实方向信号
  if (newsLine) lines.push(`⚠️ 消息面: ${newsLine}`);
  if (cur.activeVolumeWindow || cur.session) lines.push(`活跃成交量: ${sessionText(cur.activeVolumeWindow || cur.session)}`);
  if (cur.ictSession) lines.push(ictSessionText(cur.ictSession));
  // 辅助状态：最近仍有效的结构级 OB / Breaker；失效对象已在分析层过滤。
  const ob = obText(cur.ob, cur.bias, price);
  if (ob) lines.push(ob);
  if (changes.includes("confidence")) lines.push(`模型信心: ${prev.confidence} → ${cur.confidence}${confidenceScore != null ? ` · 共振评分 ${confidenceScore}` : ""}`);
  else if (biasFlipped) lines.push(`模型信心: ${cur.confidence}${confidenceScore != null ? ` · 共振评分 ${confidenceScore}` : ""}`);
  if (changes.includes("decision")) lines.push(`操作: ${prev.decision} → ${cur.decision}`);
  else if (biasFlipped) lines.push(`操作: ${cur.decision}`);
  if (cur.directionDecision && cur.directionDecision !== cur.decision) lines.push(`方向评级: ${cur.directionDecision}（执行区尚未就绪）`);
  if (!biasFlipped && cur.scenario) lines.push(`市场背景: ${scenarioCN(cur.scenario, cur.htfContext)}`);
  if (mssInvalidation?.price != null) {
    // MSS 位是"反势确认线"：多头结构 = 最近 swing low（收盘跌破才转空），空头结构 = 最近 swing high（收盘突破才转多）。
    // 写死"突破"会把多头防守位误导成上方目标（INTCUSDT 08/14：100.33 是下方防线，价格 105.38 已在其上，并非"已突破待确认"）。
    const mssDir = mssInvalidation.type === "BREAK_LAST_LOW" ? "跌破" : "突破";
    lines.push(`4H MSS确认位: ${fmtPrice(mssInvalidation.price)}（收盘${mssDir}才确认结构转移）`);
  }
  if (structureProtection?.price != null) lines.push(`4H深层保护位: ${fmtPrice(structureProtection.price)}（趋势最后防线，不是5m止损）`);
  // planR 的 Risk 用最近的 ACTIVE 失效线（1h 最近 ACTIVE swing > 4H MSS > 深层保护位）。
  // 与展示的 4H 位不同时标注出来，避免"planR 用 1h 止损算、消息却只显示 4H 位"的数字对不上。
  if (cur.riskLine != null && cur.riskLine !== (mssInvalidation?.price ?? null) && cur.riskLine !== (structureProtection?.price ?? null)) {
    lines.push(`止损参考: 最近1H摆动 ${fmtPrice(cur.riskLine)}（planR 风险基准）`);
  }
  // planR 只出现在目标行（机会质量等级由 planR 决定），避免同一数值重复展示
  lines.push(`机会质量: ${cur.quality}`);
  const first = cur.targets?.first;
  const remote = cur.targets?.remote;
  if (first) lines.push(`第一目标: ${targetTypeCN(first.type)} ${fmtPrice(first.price)}（${formatPlanR(first.planR)}R）`);
  // 等效回撤点：第一目标 planR < 1（空间不足/有限）时给出"回撤到哪才有合格 R"的可执行提示。
  // 否则只会报"空间不足"，用户不知道差多少（DRAM/MU 08/14 其实只差 ~0.6% 回撤就有合格 R）。
  // p(R) = (target + R×riskLine) / (1+R)；只显示在 (riskLine, 现价) 区间内的合理回撤点。
  if (first && first.planR != null && first.planR < 1 && cur.riskLine != null) {
    const r1 = (first.price + cur.riskLine) / 2; // 1R 等效回撤价
    const inRange = cur.bias === "BULLISH" ? r1 < price && r1 > cur.riskLine : r1 > price && r1 < cur.riskLine;
    if (inRange) lines.push(`回撤到 ${fmtPrice(r1)} 可达 1R`);
  }
  if (remote) lines.push(`远端目标: ${targetTypeCN(remote.type)} ${fmtPrice(remote.price)}（${formatPlanR(remote.planR)}R）`);
  // 非 bias 变化时 reason 是可信度/空间原因；bias 变化时原因已在结构行解释
  if (!biasFlipped) lines.push(`原因: ${finalReason(cur, reason)}`);
  lines.push(`价格: ${price}`);
  return lines.join("<br/>");
}

function formatPlanR(value) {
  if (value == null) return "-";
  return value >= 0.95 && value < 1.05 ? value.toFixed(3) : value.toFixed(2);
}

function targetTypeCN(type) {
  return ({ PDH: "昨日高点", PDL: "昨日低点", PWH: "上周高点", PWL: "上周低点", EQH: "等高点", EQL: "等低点", PRE_MARKET_HIGH: "盘前高点", PRE_MARKET_LOW: "盘前低点", ASIA_HIGH: "亚洲时段高点", ASIA_LOW: "亚洲时段低点", INTERNAL_HIGH: "内部摆动高点", INTERNAL_LOW: "内部摆动低点" })[type] || type;
}

function finalReason(cur, fallback) {
  if (cur.directionDecision === "WATCH" && cur.decision === "WAIT") {
    if (cur.planR != null && cur.planR < 1) return "方向成立，但第一目标结构空间不足，等待更好位置";
    return "方向成立，但执行区尚未就绪，继续等待";
  }
  return reasonCN(fallback);
}

/** 北京时间 "2026-08-04 20:00" */
function now() {
  return new Date().toLocaleString("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

/** 北京时间 hh:mm */
function nowHHMM() {
  return new Date(marketNow()).toLocaleString("zh-CN", {
    timeZone: "Asia/Shanghai",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

/**
 * 5m K 时段（北京时间）："MM-DD hh:mm - hh:mm"（开盘带日期，结束只显时刻）。
 * 扫损消息要明确"发生在哪根 K"，用户对照图表 5 分钟刻度即可定位——
 * 直接用 closeTime 会显示成 22:34 这类非整刻度（Binance closeTime = 开盘+5min−1ms），
 * 在 5m 图上找不到对应 K。
 */
function klineSpan(openMs) {
  const opts = { timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", hour12: false };
  const open = new Date(openMs).toLocaleString("zh-CN", { ...opts, month: "2-digit", day: "2-digit" });
  const end = new Date(openMs + 5 * 60_000).toLocaleString("zh-CN", opts);
  return `${open} - ${end}`;
}

/**
 * 被扫流动性位的形成时间（北京时间）——用户要对照图表定位"这个位是哪天/哪根 K 形成的"。
 * 各类流动性位的时间语义不同：
 *   PDH/PDL/PWH/PWL → 日/周 K（显示日期，日 K 恒为北京 08:00 开盘，时间无信息量）
 *   EQH/EQL/EXTERNAL → 4H swing K（显示日期+时间，精确到该根 4H）
 *   INTERNAL_HIGH/LOW → 1H swing K（显示日期+时间，精确到该根 1H）
 *   PRE_MARKET_HIGH/LOW → 纽约 04:00-09:30 盘前区间（仅美股关联合约，自动处理夏/冬令时；
 *     显示形成极值的日内 K 时间）；仅旧数据无 highTime/lowTime 时回退显示日期
 * 无形成时间（旧数据/未注入）→ null，消息里省略该段。
 */
function levelFormedText(sweep) {
  if (sweep.levelTime != null) {
    const isDayK = sweep.type === "PDH" || sweep.type === "PDL" || sweep.type === "PWH" || sweep.type === "PWL";
    const isSession = ["PRE_MARKET_HIGH", "PRE_MARKET_LOW", "ASIA_HIGH", "ASIA_LOW"].includes(sweep.type);
    const is1h = sweep.type === "INTERNAL_HIGH" || sweep.type === "INTERNAL_LOW";
    const opts = { timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit", hour12: false };
    if (!isDayK) Object.assign(opts, { hour: "2-digit", minute: "2-digit" });
    const t = new Date(sweep.levelTime).toLocaleString("zh-CN", opts);
    const suffix = isDayK ? "（日/周 K）" : isSession ? "" : is1h ? "（1H K）" : "（4H K）";
    return `流动性位形成: ${t}${suffix}`;
  }
  const d = sweep.levelDate; // PRE_MARKET 旧数据兜底："2026-08-07"
  if (d) return `流动性位形成: ${d.slice(5, 7)}/${d.slice(8, 10)}`;
  return null;
}

// CLI 入口：pm2 fork 模式下 argv[1] 是 pm2 容器脚本（ProcessContainerFork.js），
// 真正的入口脚本在 process.env.pm_exec_path；普通命令行运行才用 argv[1]。
const entry = process.env.pm_exec_path || process.argv[1] || "";
if (/runMonitor\.js$/i.test(entry)) {
  log(`[runMonitor] CLI 入口命中（entry=${entry}）`);
  const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const dryRun = process.argv.includes("--dry");
  const once = process.argv.includes("--once");
  const opts = { symbols: args.length ? args : undefined };
  const task = once ? runMonitor({ ...opts, dryRun }) : startMonitorLoop(opts);
  task
    .then((r) => {
      if (once && dryRun) {
        console.log(`[runMonitor] dry-run: firstRun=${r.firstRun}, changed=${r.changed.length}`);
        for (const c of r.changed) console.log(`  ${c.symbol}: ${c.changes.join(",")}`);
      }
    })
    .catch((e) => {
      log(`[runMonitor] 失败: ${e.message}`);
      console.error(`[runMonitor] 失败: ${e.message}`);
      process.exit(1);
    });
}
