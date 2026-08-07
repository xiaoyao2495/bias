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
import { getHistory } from "../data/binance.js";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOG_FILE = join(__dirname, "..", "monitor", "log.txt");
const CLOSE_REPORT_FILE = join(__dirname, "..", "monitor", "closeReport.json"); // 记录已推送收盘报告的 4H 边界
const OPP_DIGEST_FILE = join(__dirname, "..", "monitor", "opportunityDigest.json"); // 记录机会榜上次推送时间

/** 文件日志：Windows 上 pm2 的 out/err 日志空白，写文件便于在服务器上排查 */
function log(...args) {
  const ts = new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });
  const line = `[${ts}] ${args.join(" ")}`;
  try {
    appendFileSync(LOG_FILE, line + "\n");
  } catch {}
  console.error(line);
}

// 模块加载即打点：诊断 pm2 进程是否真正加载/进入了该脚本
log(`[runMonitor] 模块加载（argv1=${process.argv[1] || "(无)"}，pm_exec_path=${process.env.pm_exec_path || "(无)"}，cwd=${process.cwd()}）`);

const TOP_N = 12;
/** 监控排除名单：用户不关注的合约（不参与 Top 排名，若在 N 内由后续补位）
 *  SOLUSDT 数据异常；KORUUSDT 标的为韩国半导体股，流动性时段特殊且近期误报频繁 */
const EXCLUDE_SYMBOLS = ["SOLUSDT", "KORUUSDT"];
const ICON = { BULLISH: "🟢", BEARISH: "🔴", NEUTRAL: "⚪" };
const BJ_OFFSET_MS = 8 * 3600_000;
/** 5m 机会扫描：5m 历史长度（≈3.5 天，swing 结构/执行区/MSS-BOS 历史用，缓存 TTL 5 分钟） */
const OPP_M5_LIMIT = 1000;
/** 同一机会 key 推送冷却（避免同一执行区/同一链条每 10 分钟重复推） */
const OPP_COOLDOWN_MS = 60 * 60_000;

/** Session 展示（数据驱动活跃窗口）：活跃窗口 20:00-24:00（占比 23.4%） */
function sessionText(s) {
  if (!s) return null;
  return `活跃窗口 ${String(s.start).padStart(2, "0")}:00-${String(s.end).padStart(2, "0")}:00（占比 ${s.ratio}%）`;
}

// 中文化（交互信息规范）：ICT 术语标签（Scenario/Bias 等）保留英文，标签值/原因内容翻译
const SCENARIO_CN = {
  BULLISH_CONTINUATION: "多头延续",
  BEARISH_CONTINUATION: "空头延续",
  BULLISH_REVERSAL_ATTEMPT: "多头反转尝试",
  BEARISH_REVERSAL_ATTEMPT: "空头反转尝试",
  RANGE: "区间",
  TRANSITION: "过渡",
};
const scenarioCN = (s) => SCENARIO_CN[s] || s || "-";
/** 决策原因 → 中文（decision.reason 枚举映射，未命中保持原样） */
const REASON_CN = {
  "No directional bias": "无方向偏倚",
  "Direction probability too low": "方向概率过低",
  "No reward estimate (missing draw or invalidation)": "缺少目标或失效位，无法评估盈亏比",
  "Direction correct but reward insufficient (planR < 0.5)": "方向正确但空间不足（planR < 0.5）",
  "Acceptable direction, but room limited — wait for retracement to improve R": "方向可接受但空间有限，等待回撤改善盈亏比",
  "Enough upside room with acceptable direction probability": "方向概率可接受且上方空间充足",
};
const reasonCN = (r) => (r ? REASON_CN[r] || r : "-");

/**
 * 执行一轮监控：扫描 → 比较 → 推送变化 → 存状态。
 * @param {Object} [p]
 * @param {string[]} [p.symbols] 指定合约列表（默认 Top12，排除 SOLUSDT/KORUUSDT）
 * @param {number} [p.topN=12]
 * @param {boolean} [p.dryRun] 只计算不推送
 */
export async function runMonitor({ symbols, topN = TOP_N, dryRun = false } = {}) {
  const list = symbols && symbols.length ? symbols : (await getTopVolumeSymbols(topN, { exclude: EXCLUDE_SYMBOLS })).map((t) => t.symbol);
  log(`[runMonitor] 开始，合约数=${list.length}: ${list.join(",")}`);
  const prevState = loadState();
  const isFirstRun = Object.keys(prevState).length === 0;
  // 4H 收盘边界轮（到达新边界 或 首轮）→ 强制刷新 4H 缓存：
  // 收盘报告必须用最新已收盘 K（缓存快照在部分启动相位下会滞后一根，见 M1 相位扫描）；
  // 顺带让 Bias/结构检测在 4H 收盘后第一轮即生效，而非等 30min TTL 过期。
  const boundaryMs = latestBjBoundaryMs();
  const force4h = isFirstRun || boundaryMs > loadCloseReport();
  if (force4h) log(`[runMonitor] 4H 收盘边界轮 → 强制刷新 4H 数据`);
  const results = await analyzeSymbols(list, { onProgress: (n, t) => log(`[runMonitor] 分析进度 ${n}/${t}`), force4h });
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
    const cur = {
      bias: r.bias,
      confidence: r.confidence,
      decision: r.decisionLabel,
      scenario: r.scenario,
      session: r.session, // ICT Killzone 背景（通知展示）
      quality: r.quality,
      planR: r.planR,
      sweepTime: r.sweep ? r.sweep.key : null, // 扫损事件去重（key = 5m K 开盘时间_方向，同一根 5m 内同一侧只推一次）
      ob: r.ob, // { type, kind, state, ... } | null（最近 Order Block 细类）
      oppPushed: (prev && prev.oppPushed) || {}, // 5m 机会推送去重（key → 推送时间戳），冷却期内不重复推
    };
    nextState[r.symbol] = cur;
    const cmp = compareState(prev, cur);
    const item = { symbol: r.symbol, price: r.price, confidenceScore: r.confidenceScore, reason: r.reason, structureStatus: r.structureStatus, invalidation: r.invalidation, mss: r.mss, mss5m: r.mss5m, last4h: r.last4h, sweep: r.sweep, displacement: r.displacement, ...cmp, prev, cur };
    overview.push(item);
    if (cmp.changed) changed.push(item);
  }

  if (!dryRun) {
    if (isFirstRun) {
      try {
        await sendMarkdown(buildOverview(overview), "4H Bias Monitor");
        log(`[runMonitor] 首轮全览已推送（${overview.length} 合约）`);
      } catch (e) {
        log(`[runMonitor] 首轮全览推送失败: ${e.message}`);
      }
    } else {
      for (const item of changed) {
        // 新加入合约（isNew）无 prev→cur 对比上下文，不推送（静默存状态，等下次变化再推）
        if (item.isNew) continue;
        try {
          await sendMarkdown(buildChanged(item), `${item.symbol} Bias`);
          log(`[runMonitor] 已推送 ${item.symbol}（${item.changes.join(",")}）`);
        } catch (e) {
          // 推送失败不落地新状态 → 下一轮 compareState 仍变化 → 重推（宁可重复不漏报）
          log(`[runMonitor] ${item.symbol} Bias 推送失败，保留旧状态下轮重试: ${e.message}`);
          nextState[item.symbol] = prevState[item.symbol];
        }
      }
      log(`[runMonitor] 本轮完成: ${changed.length} 变化 / ${overview.length} 合约`);
      // P1-A：流动性扫损事件（独立推送；state 无该事件记录 → 新扫损才推）
      for (const item of overview) {
        if (item.sweep && item.prev && item.prev.sweepTime !== item.sweep.key) {
          try {
            await sendMarkdown(buildSweep(item), `${item.symbol} 扫损`);
            log(`[runMonitor] 已推送 ${item.symbol} 扫损（${item.sweep.side} @ ${item.sweep.level}）`);
          } catch (e) {
            // 保留旧 sweepTime → 下一轮仍视为新扫损 → 重推（不漏报流动性事件）
            log(`[runMonitor] ${item.symbol} 扫损推送失败，保留旧记录下轮重试: ${e.message}`);
            nextState[item.symbol].sweepTime = item.prev.sweepTime;
          }
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
        await sendMarkdown(buildCloseReport(overview), "4H 收盘报告");
        log(`[runMonitor] 4H 收盘报告已推送（边界 ${new Date(boundaryMs).toISOString()}）`);
        saveCloseReport(boundaryMs); // 推送成功才记录边界，失败下轮重试
      } catch (e) {
        log(`[runMonitor] 4H 收盘报告推送失败: ${e.message}`);
      }
    }
    // 白名单清理：只保留本轮监控 list 内的合约，剔除跌出 Top10 的残留状态
    saveState(cleanupState(nextState, list));
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
export function nextDelayMs(now = new Date()) {
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
    const delay = intervalMs ?? nextDelayMs();
    const next = new Date(Date.now() + delay);
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
export function latestBjBoundaryMs(now = new Date()) {
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

/**
 * 4H 收盘报告：每根 4H 收线后的固定状态播报（即使无变化也推）。
 * 每合约一行：收于开盘上方/下方 + 幅度 + 当前 Bias + 信心度（ICT Daily Bias 的 open/close 视角）。
 */
export function buildCloseReport(overview) {
  const boundary = new Date(latestBjBoundaryMs());
  const bjBoundary = new Date(boundary.getTime() + BJ_OFFSET_MS);
  const label = `${String(bjBoundary.getUTCHours()).padStart(2, "0")}:00`;
  // 数据驱动后无全局 Killzone 窗口：统计本时段处于自身活跃窗口的合约数，反映整体活跃度
  const activeCount = overview.filter((r) => r.session).length;
  const kzText = `本时段 ${activeCount}/${overview.length} 合约处于活跃窗口`;
  const lines = [`**4H 收盘报告** · ${kzText}（北京 ${label} 收线）`, `本根 4H 收盘：`, ""];
  for (const r of overview) {
    const k = r.last4h;
    if (!k || k.open == null) continue;
    const pct = ((k.close - k.open) / k.open) * 100;
    const up = k.close >= k.open;
    const disp = r.displacement
      ? ` · 位移${r.displacement.direction === "UP" ? "↑" : "↓"}${r.displacement.ratio.toFixed(1)}x（${dispEvidence(r.displacement)}）`
      : "";
    lines.push(`**${r.symbol}** ${up ? "收上" : "收下"} ${pct >= 0 ? "+" : ""}${pct.toFixed(2)}% · ${ICON[r.cur.bias] || ""} ${r.cur.bias} · ${r.cur.confidence}${r.confidenceScore != null ? ` ${r.confidenceScore}` : ""}${disp}`);
  }
  return lines.join("<br/>");
}

/** 扫损事件消息（⚡）：市场刚扫掉某流动性位后收回——带当前市场背景，帮助理解"在什么结构下发生" */
export function buildSweep({ symbol, sweep, price, cur, confidenceScore, mss5m }) {
  const sideText = sweep.side === "BSL" ? "上方买方流动性（BSL）" : "下方卖方流动性（SSL）";
  const levelText = sweepTypeLabel(sweep.type);
  const sweptText = sweep.side === "BSL" ? `刺破 ${levelText} ${sweep.level}（高 ${sweep.sweptPrice}）后收回` : `跌破 ${levelText} ${sweep.level}（低 ${sweep.sweptPrice}）后收回`;
  const tag = sweep.realtime ? "实时" : "已确认";
  const timeText = sweep.realtime
    ? `检测于 ${nowHHMM()}（本根 5m 进行中）`
    : `时间: ${bjTime(sweep.closedTime)}（已收盘确认）`;
  const lines = [
    `**⚡ ${symbol} 流动性扫损（${tag}）**  🕐 ${nowHHMM()}`,
    "",
    `${sideText}被扫：${sweptText}，收 ${sweep.close}`,
    `${timeText} · 现价 ${price}`,
    "",
    "市场背景:",
    `Bias: ${ICON[cur.bias] || ""} ${cur.bias}`,
    `Session: ${sessionText(cur.session) || "非 Killzone"}`,
    `Scenario: ${scenarioCN(cur.scenario)}`,
  ];
  // P1-B：5m 结构事件（扫损→收回→MSS 是 ICT 经典链条，标注当前 5m 结构状态）
  if (mss5m && mss5m.lastEvent) {
    const ev = mss5m.lastEvent;
    const status = ev.confirmed ? "已确认" : ev.realtime ? "实时" : "";
    lines.push(`5m 结构: ${ev.type} ${ev.direction} @ ${ev.level}（${status}）`);
  }
  lines.push(`信心度: ${cur.confidence}${confidenceScore != null ? ` ${confidenceScore}` : ""}`);
  lines.push(`操作: ${cur.decision}`);
  return lines.join("<br/>");
}

/** 位移证据摘要：结构突破位（BOS）+ 缺口区间（FVG），让用户确认是否真为 ICT 三条件位移 */
function dispEvidence(d) {
  const parts = [];
  if (d.structureBreak && d.structureBreak.level != null) parts.push(`BOS ${fmtPrice(d.structureBreak.level)}`);
  if (d.fvg && d.fvg.top != null && d.fvg.bottom != null) parts.push(`FVG ${fmtPrice(d.fvg.bottom)}-${fmtPrice(d.fvg.top)}`);
  return parts.join("，");
}

/** 价格显示：整数原样，小数保留 2 位去尾零 */
function fmtPrice(n) {
  return String(Number(n.toFixed(2)));
}

/** 流动性位类型 → 中文标签 */
function sweepTypeLabel(type) {
  return (
    {
      PDH: "昨日高点",
      PDL: "昨日低点",
      PWH: "上周高点",
      PWL: "上周低点",
      EQH: "等高点",
      EQL: "等低点",
      EXTERNAL_HIGH: "外部结构高点",
      EXTERNAL_LOW: "外部结构低点",
    }[type] || type
  );
}

/** Order Block 细类 → 中文（ICT 2022 L4：BREAKER 破位反包 / REJECTION 拒绝 / STANDARD 标准）
 *  仅在有关注价值时显示：BREAKER/REJECTION 总是显示；STANDARD 需未回踩（FRESH）才显示 */
const OB_KIND_CN = { BREAKER: "破位反包", REJECTION: "拒绝", STANDARD: "标准" };
function obText(o) {
  if (!o) return null;
  if (o.kind === "STANDARD" && o.state === "USED") return null;
  const kind = OB_KIND_CN[o.kind] || o.kind;
  const state = o.state === "USED" ? "已回踩" : o.state === "FRESH" ? "未回踩" : o.state;
  const loc = o.location === "DISCOUNT" ? "折扣区" : o.location === "PREMIUM" ? "溢价区" : null;
  return `最近OB: ${o.type === "BULLISH_OB" ? "多头OB" : "空头OB"}（${kind}·${state}${loc ? `·${loc}` : ""}）`;
}

/** 首轮全览（紧凑，避免刷屏） */
export function buildOverview(list) {
  const lines = [`**4H Bias Monitor**  ${nowHHMM()}`, ""];
  for (const r of list) {
    lines.push(`**${r.symbol}** ${ICON[r.cur.bias] || ""} ${r.cur.bias}`);
    lines.push(`Scenario: ${scenarioCN(r.cur.scenario)} · 信心度: ${r.cur.confidence}${r.confidenceScore != null ? ` ${r.confidenceScore}` : ""} · 机会质量: ${r.cur.quality}${r.cur.planR != null ? ` (${r.cur.planR.toFixed(2)})` : ""} · 操作: ${r.cur.decision}`);
    lines.push("");
  }
  return lines.join("<br/>");
}

/** 结构状态描述（中文）：当前 Bias 对应 ICT 结构形态 */
function structureDesc(bias) {
  return bias === "BULLISH" ? "新多头结构形成（HH+HL）" : bias === "BEARISH" ? "新空头结构形成（LH+LL）" : "结构方向未确认";
}

/** 5m 机会类型 → 中文标签 */
const OPP_TYPE_CN = { CHAIN: "扫损→MSS→回踩", BOS: "结构突破 BOS", RETRACE: "执行区回踩" };

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
      const opps = scanOpportunities({ symbol: item.symbol, env: item, m5 });
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
    const lastTs = prevState[op.symbol]?.oppPushed?.[op.key] || 0;
    if (Date.now() - lastTs < OPP_COOLDOWN_MS) continue;
    if (dryRun) {
      log(`[runMonitor][dry] 机会候选 ${op.symbol} ${op.type} ${op.direction} score=${op.score}`);
      continue;
    }
    try {
      await sendMarkdown(buildOpportunity(op, itemOf(op, overview)), `${op.symbol} 5m机会`);
      pushed[op.key] = Date.now();
      log(`[runMonitor] 已推送 ${op.symbol} 5m 机会（${op.type} score=${op.score}）`);
    } catch (e) {
      log(`[runMonitor] ${op.symbol} 机会推送失败，下轮重试: ${e.message}`);
    }
  }

  // 📊 机会榜：每 30 分钟整点轮（北京时间 0/30 分），距上次推送 ≥25 分钟去重
  const bjMin = new Date(Date.now() + BJ_OFFSET_MS).getUTCMinutes();
  const top = all.filter((o) => o.score >= OPP_MIN_SCORE).sort((a, b) => b.score - a.score).slice(0, 5);
  if (bjMin % 30 === 0 && top.length && Date.now() - loadDigestTs() >= 25 * 60_000) {
    if (dryRun) {
      log(`[runMonitor][dry] 机会榜 ${top.map((o) => `${o.symbol} ${o.type}(${o.score})`).join(", ")}`);
      return;
    }
    try {
      await sendMarkdown(buildOpportunityDigest(top), "5m 机会榜");
      saveDigestTs(Date.now());
      log(`[runMonitor] 5m 机会榜已推送（${top.length} 条）`);
    } catch (e) {
      log(`[runMonitor] 机会榜推送失败: ${e.message}`);
    }
  }
}

/** 从 overview 中找回某机会对应的环境 item（含 cur/price/confidenceScore） */
function itemOf(op, overview) {
  return overview.find((i) => i.symbol === op.symbol) || {};
}

/** 5m 机会单条消息（🎯）：环境背景 + 入场参考 + 触发链条（钉钉格式规范） */
export function buildOpportunity(op, env) {
  const dirCN = op.direction === "BULLISH" ? "多头" : "空头";
  const cur = env.cur || {};
  const lines = [
    `**🎯 ${op.symbol} 5m 机会**  🕐 ${nowHHMM()}`,
    "",
    `${ICON[op.direction] || ""} ${dirCN}（${OPP_TYPE_CN[op.type] || op.type}）· 评分 ${op.score}`,
  ];
  if (op.zone) lines.push(`执行区: ${op.zone.type} ${fmtPrice(op.zone.bottom)}-${fmtPrice(op.zone.top)}`);
  // 审计修复：回踩/突破信号只是"价格到达观察位"，入场需执行区确认（反K/收回/结构确认），
  // 文案用"观察位"避免被理解为可直接市价入场的价位
  lines.push(`观察位: ${fmtPrice(op.entry)} · 现价 ${fmtPrice(env.price)}（需回踩/突破后确认再入场）`);
  lines.push(`环境: ${ICON[cur.bias] || ""} ${cur.bias || "-"} · 信心度 ${cur.confidence || "-"}${env.confidenceScore != null ? ` ${env.confidenceScore}` : ""} · 操作 ${cur.decision || "-"} · ${sessionText(cur.session) || "非活跃窗口"}`);
  lines.push(`触发: ${op.trigger}`);
  lines.push(`价格: ${env.price}`);
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
export function buildChanged({ symbol, price, reason, changes, prev, cur, confidenceScore, structureStatus, invalidation, mss }) {
  const biasFlipped = changes.includes("bias");
  const head = biasFlipped ? `**⚠️ ${symbol} 4H Bias 变化**  🕐 ${nowHHMM()}` : `**ℹ️ ${symbol} 4H Bias 更新**  🕐 ${nowHHMM()}`;
  const lines = [head, ""];

  if (biasFlipped) {
    lines.push(`${ICON[prev.bias] || ""} ${prev.bias} → ${ICON[cur.bias] || ""} ${cur.bias}`, "");
    // Change Reason：市场发生了什么（结构失效 = MSS 事件 → 突破保护位）
    if (structureStatus === "INVALIDATED" && mss) {
      // schema 与 indicators/mss.js 统一：direction = UP/DOWN（突破方向），type 恒为 "MSS"
      const dirText = mss.direction === "UP" ? "向上突破" : "向下跌破";
      lines.push(`**结构事件: MSS**（${dirText} ${mss.level}，原 ${mss.structureFrom} 结构失效）`);
      lines.push(`触发: ${mss.time} · 价格 ${mss.price}`);
    } else if (structureStatus === "INVALIDATED") {
      const broken = invalidation && invalidation.type === "BREAK_PROTECTED_HIGH";
      const level = invalidation && invalidation.price != null ? invalidation.price : "-";
      lines.push(`结构: INVALIDATED（价格突破${broken ? "保护高位" : "保护低位"} ${level}，原 ${prev.bias} 结构失效）`);
    } else {
      lines.push(`结构: ${structureStatus || "-"}（${structureDesc(cur.bias)}）`);
    }
    lines.push("");
  } else {
    // ℹ️ 更新：补当前 Bias 与结构状态背景（bias 未变，无 旧→新 对比，但用户需一眼看到当前环境）
    lines.push(`${ICON[cur.bias] || ""} ${cur.bias}`);
    lines.push(`结构: ${structureStatus || "-"}（${structureDesc(cur.bias)}）`);
    lines.push("");
  }
  if (cur.session) lines.push(`Session: ${sessionText(cur.session)}`);
  // 辅助状态：OB 细类（ICT 2022 L4），仅在有关注价值时显示，避免噪音
  const ob = obText(cur.ob);
  if (ob) lines.push(ob);
  if (changes.includes("confidence")) lines.push(`信心度: ${prev.confidence} → ${cur.confidence}${confidenceScore != null ? ` ${confidenceScore}` : ""}`);
  else if (biasFlipped) lines.push(`信心度: ${cur.confidence}${confidenceScore != null ? ` ${confidenceScore}` : ""}`);
  if (changes.includes("decision")) lines.push(`操作: ${prev.decision} → ${cur.decision}`);
  else if (biasFlipped) lines.push(`操作: ${cur.decision}`);
  if (!biasFlipped && cur.scenario) lines.push(`Scenario: ${scenarioCN(cur.scenario)}`);
  lines.push(`机会质量: ${cur.quality}${cur.planR != null ? ` (planR ${cur.planR.toFixed(2)})` : ""}`);
  // 非 bias 变化时 reason 是可信度/空间原因；bias 变化时原因已在结构行解释
  if (!biasFlipped) lines.push(`原因: ${reasonCN(reason)}`);
  lines.push(`价格: ${price}`);
  return lines.join("<br/>");
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
  return new Date().toLocaleString("zh-CN", {
    timeZone: "Asia/Shanghai",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

/** 时间戳 → 北京时间 "MM-DD hh:mm"（与消息其他时间统一北京时间，避免 UTC/北京混用） */
function bjTime(ms) {
  return new Date(ms).toLocaleString("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
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
