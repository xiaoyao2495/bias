/**
 * runMonitor.js — Monitor 常驻入口（pm2 保活，进程内自调度）
 *
 * 流程：
 *   getTopVolumeSymbols(15) → analyzeSymbols（串行，防限频）
 *   → compareState → 状态变化则推钉钉 → saveState → 睡到下一个对齐点
 *
 * 调度（北京时间）：
 *   全天每 10 分钟对齐检测一次（pm2 只负责保活，进程内自调度）。
 *
 * 推送策略：
 *   首轮（state.json 无记录）→ 推送一次全览（15 合约当前状态）
 *   后续轮次 → 只推状态变化的合约：
 *     bias 翻转        → ⚠️ {SYMBOL} 4H Bias Changed（含 旧 → 新 对比）
 *     confidence/decision 变化 → ℹ️ {SYMBOL} 4H Bias Updated
 *   4H 收盘报告 → 每根 4H 收线后（北京 00/04/08/12/16/20）即使无变化也推一次
 *     （记录在 monitor/closeReport.json，首轮全览已覆盖则不重复推）
 *   流动性扫损 → ⚡ {SYMBOL} 扫损：刺破/跌破流动性位后收回（state.sweepTime 去重）
 *
 * 用法：
 *   node scripts/runMonitor.js                # 常驻：Top15 全量，自调度
 *   node scripts/runMonitor.js BTCUSDT ETHUSDT  # 常驻：指定合约（测试用）
 *   node scripts/runMonitor.js --once          # 只跑一轮后退出（手动/测试）
 *   node scripts/runMonitor.js --once --dry    # 只计算不推送
 *   DINGTALK_WEBHOOK=xxx node scripts/runMonitor.js  # 配置钉钉 webhook（必须）
 */
import { getTopVolumeSymbols } from "../monitor/topVolume.js";
import { analyzeSymbols } from "../monitor/biasMonitor.js";
import { loadState, saveState, compareState } from "../monitor/state.js";
import { sendMarkdown } from "../monitor/dingTalk.js";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOG_FILE = join(__dirname, "..", "monitor", "log.txt");
const CLOSE_REPORT_FILE = join(__dirname, "..", "monitor", "closeReport.json"); // 记录已推送收盘报告的 4H 边界

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

const TOP_N = 15;
const ICON = { BULLISH: "🟢", BEARISH: "🔴", NEUTRAL: "⚪" };
const BJ_OFFSET_MS = 8 * 3600_000;

/**
 * 执行一轮监控：扫描 → 比较 → 推送变化 → 存状态。
 * @param {Object} [p]
 * @param {string[]} [p.symbols] 指定合约列表（默认 Top15）
 * @param {number} [p.topN=15]
 * @param {boolean} [p.dryRun] 只计算不推送
 */
export async function runMonitor({ symbols, topN = TOP_N, dryRun = false } = {}) {
  const list = symbols && symbols.length ? symbols : (await getTopVolumeSymbols(topN)).map((t) => t.symbol);
  log(`[runMonitor] 开始，合约数=${list.length}: ${list.join(",")}`);
  const results = await analyzeSymbols(list, { onProgress: (n, t) => log(`[runMonitor] 分析进度 ${n}/${t}`) });
  const failed = results.filter((r) => r.error).length;
  log(`[runMonitor] 分析完成：成功 ${results.length - failed} / ${results.length}`);
  const prevState = loadState();
  const isFirstRun = Object.keys(prevState).length === 0;
  const nextState = {};
  const overview = [];
  const changed = [];

  for (const r of results) {
    if (r.error) {
      console.error(`[runMonitor] ${r.symbol} 分析失败: ${r.error}`);
      continue;
    }
    const prev = prevState[r.symbol] || null;
    const cur = {
      bias: r.bias,
      confidence: r.confidence,
      decision: r.decisionLabel,
      scenario: r.scenario,
      quality: r.quality,
      planR: r.planR,
      sweepTime: r.sweep ? r.sweep.time : null, // 扫损事件去重（time 变化 = 新事件）
    };
    nextState[r.symbol] = cur;
    const cmp = compareState(prev, cur);
    const item = { symbol: r.symbol, price: r.price, confidenceScore: r.confidenceScore, reason: r.reason, structureStatus: r.structureStatus, invalidation: r.invalidation, mss: r.mss, last4h: r.last4h, sweep: r.sweep, displacement: r.displacement, ...cmp, prev, cur };
    overview.push(item);
    if (cmp.changed) changed.push(item);
  }

  if (!dryRun) {
    if (isFirstRun) {
      await sendMarkdown(buildOverview(overview), "4H Bias Monitor");
      log(`[runMonitor] 首轮全览已推送（${overview.length} 合约）`);
    } else {
      for (const item of changed) {
        // 新加入合约（isNew）无 prev→cur 对比上下文，不推送（静默存状态，等下次变化再推）
        if (item.isNew) continue;
        await sendMarkdown(buildChanged(item), `${item.symbol} Bias`);
        log(`[runMonitor] 已推送 ${item.symbol}（${item.changes.join(",")}）`);
      }
      log(`[runMonitor] 本轮完成: ${changed.length} 变化 / ${overview.length} 合约`);
      // P1-A：流动性扫损事件（独立推送；state 无该事件记录 → 新扫损才推）
      for (const item of overview) {
        if (item.sweep && item.prev && item.prev.sweepTime !== item.sweep.time) {
          await sendMarkdown(buildSweep(item), `${item.symbol} 扫损`);
          log(`[runMonitor] 已推送 ${item.symbol} 扫损（${item.sweep.side} @ ${item.sweep.level}）`);
        }
      }
    }
    // 4H 收盘报告：每根 4H 收线后即使无状态变化也推一次（首轮全览已覆盖，只记录边界不推）
    const boundaryMs = latestBjBoundaryMs();
    if (!isFirstRun && boundaryMs > loadCloseReport()) {
      await sendMarkdown(buildCloseReport(overview), "4H 收盘报告");
      log(`[runMonitor] 4H 收盘报告已推送（边界 ${new Date(boundaryMs).toISOString()}）`);
    }
    saveCloseReport(boundaryMs);
    saveState(nextState);
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

/** 4H 边界对应的时段（北京时间，ICT 简化标注） */
function sessionOfBjHour(h) {
  if (h >= 8 && h < 16) return "亚洲";
  if (h >= 16 && h < 20) return "伦敦";
  return "纽约";
}

/**
 * 4H 收盘报告：每根 4H 收线后的固定状态播报（即使无变化也推）。
 * 每合约一行：收于开盘上方/下方 + 幅度 + 当前 Bias + 信心度（ICT Daily Bias 的 open/close 视角）。
 */
function buildCloseReport(overview) {
  const bj = new Date(Date.now() + BJ_OFFSET_MS);
  const bjHour = bj.getUTCHours();
  const boundary = new Date(latestBjBoundaryMs());
  const bjBoundary = new Date(boundary.getTime() + BJ_OFFSET_MS);
  const label = `${String(bjBoundary.getUTCHours()).padStart(2, "0")}:00`;
  const lines = [`**4H 收盘报告** · ${sessionOfBjHour(bjHour)}时段（北京 ${label} 收线）`, `本根 4H 收盘：`, ""];
  for (const r of overview) {
    const k = r.last4h;
    if (!k || k.open == null) continue;
    const pct = ((k.close - k.open) / k.open) * 100;
    const up = k.close >= k.open;
    const disp = r.displacement ? ` · 位移${r.displacement.direction === "UP" ? "↑" : "↓"}${r.displacement.ratio.toFixed(1)}x` : "";
    lines.push(`**${r.symbol}** ${up ? "收上" : "收下"} ${pct >= 0 ? "+" : ""}${pct.toFixed(2)}% · ${ICON[r.cur.bias] || ""} ${r.cur.bias} · ${r.cur.confidence}${r.confidenceScore != null ? ` ${r.confidenceScore}` : ""}${disp}`);
  }
  return lines.join("<br/>");
}

/** 扫损事件消息（⚡）：市场刚扫掉某流动性位后收回——带当前市场背景，帮助理解"在什么结构下发生" */
function buildSweep({ symbol, sweep, price, cur, confidenceScore }) {
  const sideText = sweep.side === "BSL" ? "上方买方流动性（BSL）" : "下方卖方流动性（SSL）";
  const levelText = sweepTypeLabel(sweep.type);
  const sweptText = sweep.side === "BSL" ? `刺破 ${levelText} ${sweep.level}（高 ${sweep.sweptPrice}）后收回` : `跌破 ${levelText} ${sweep.level}（低 ${sweep.sweptPrice}）后收回`;
  const lines = [
    `**⚡ ${symbol} 流动性扫损**  🕐 ${nowHHMM()}`,
    "",
    `${sideText}被扫：${sweptText}，收 ${sweep.close}`,
    `时间: ${new Date(sweep.time).toISOString().slice(0, 16).replace("T", " ")} · 现价 ${price}`,
    "",
    "市场背景:",
    `Bias: ${ICON[cur.bias] || ""} ${cur.bias}`,
    `Scenario: ${cur.scenario}`,
    `信心度: ${cur.confidence}${confidenceScore != null ? ` ${confidenceScore}` : ""}`,
    `操作: ${cur.decision}`,
  ];
  return lines.join("<br/>");
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

/** 首轮全览（紧凑，避免刷屏） */
function buildOverview(list) {
  const lines = [`**4H Bias Monitor**  ${nowHHMM()}`, ""];
  for (const r of list) {
    lines.push(`**${r.symbol}** ${ICON[r.cur.bias] || ""} ${r.cur.bias}`);
    lines.push(`Scenario: ${r.cur.scenario} · 信心度: ${r.cur.confidence}${r.confidenceScore != null ? ` ${r.confidenceScore}` : ""} · 机会质量: ${r.cur.quality}${r.cur.planR != null ? ` (${r.cur.planR.toFixed(2)})` : ""} · 操作: ${r.cur.decision}`);
    lines.push("");
  }
  return lines.join("<br/>");
}

/**
 * 状态变化消息（bias 翻转 → ⚠️，其余 → ℹ️）。
 * 变化原因分层：Bias 变化 → 市场状态（结构失效/新结构），与 Confidence 原因分离，
 * 避免"结构失效"被误读为"方向概率低"。
 */
function buildChanged({ symbol, price, reason, changes, prev, cur, confidenceScore, structureStatus, invalidation, mss }) {
  const biasFlipped = changes.includes("bias");
  const head = biasFlipped ? `**⚠️ ${symbol} 4H Bias 变化**  🕐 ${nowHHMM()}` : `**ℹ️ ${symbol} 4H Bias 更新**  🕐 ${nowHHMM()}`;
  const lines = [head, ""];

  if (biasFlipped) {
    lines.push(`${ICON[prev.bias] || ""} ${prev.bias} → ${ICON[cur.bias] || ""} ${cur.bias}`, "");
    // Change Reason：市场发生了什么（结构失效 = MSS 事件 → 突破保护位）
    if (structureStatus === "INVALIDATED" && mss) {
      const dirText = mss.direction === "BULLISH" ? "向上突破" : "向下跌破";
      const levelText = mss.type === "BREAK_PROTECTED_HIGH" ? "保护高位" : "保护低位";
      lines.push(`**结构事件: MSS**（${dirText}${levelText} ${mss.level}，原 ${mss.structureFrom} 结构失效）`);
      lines.push(`触发: ${mss.time} · 价格 ${mss.price}`);
    } else if (structureStatus === "INVALIDATED") {
      const broken = invalidation && invalidation.type === "BREAK_PROTECTED_HIGH";
      const level = invalidation && invalidation.price != null ? invalidation.price : "-";
      lines.push(`结构: INVALIDATED（价格突破${broken ? "保护高位" : "保护低位"} ${level}，原 ${prev.bias} 结构失效）`);
    } else {
      const desc =
        cur.bias === "BULLISH" ? "新多头结构形成（HH+HL）" :
        cur.bias === "BEARISH" ? "新空头结构形成（LH+LL）" : "结构方向未确认";
      lines.push(`结构: ${structureStatus || "-"}（${desc}）`);
    }
    lines.push("");
  }
  if (changes.includes("confidence")) lines.push(`信心度: ${prev.confidence} → ${cur.confidence}${confidenceScore != null ? ` ${confidenceScore}` : ""}`);
  else if (biasFlipped) lines.push(`信心度: ${cur.confidence}${confidenceScore != null ? ` ${confidenceScore}` : ""}`);
  if (changes.includes("decision")) lines.push(`操作: ${prev.decision} → ${cur.decision}`);
  else if (biasFlipped) lines.push(`操作: ${cur.decision}`);
  if (!biasFlipped && cur.scenario) lines.push(`Scenario: ${cur.scenario}`);
  lines.push(`机会质量: ${cur.quality}${cur.planR != null ? ` (planR ${cur.planR.toFixed(2)})` : ""}`);
  // 非 bias 变化时 reason 是可信度/空间原因；bias 变化时原因已在结构行解释
  if (!biasFlipped) lines.push(`原因: ${reason}`);
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
