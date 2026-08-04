/**
 * ecosystem.config.cjs — pm2 部署配置（Windows 服务器）
 *
 * 服务器准备：
 *   1. 安装 Node.js 18+（建议 20 LTS）与 pm2：npm install -g pm2
 *   2. 拷贝项目到服务器，npm install
 *   3. 配置钉钉 webhook（Windows cmd）：
 *        set DINGTALK_WEBHOOK=https://oapi.dingtalk.com/robot/send?access_token=...
 *      然后 pm2 start 会把该环境变量随配置保存
 *   4. 启动：
 *        pm2 start ecosystem.config.cjs
 *        pm2 save          （保存进程列表，重启服务器后可 pm2 resurrect）
 *
 * 调度说明：
 *   runMonitor.js 是常驻进程，内部自调度（北京时间全天每 10 分钟对齐检测，
 *   变化才推送），pm2 只负责保活：
 *   - 不配置 cron_restart（调度由进程内 setTimeout 完成）
 *   - autorestart: true = 进程崩溃自动重启
 *   - 如需验证/单轮手动跑：node scripts/runMonitor.js --once
 *
 * Windows 上 pm2 startup 不可用；如需开机自启用 pm2-windows-startup 或任务计划程序
 */
module.exports = {
  apps: [
    {
      name: "ict-4h-bias-monitor",
      script: "scripts/runMonitor.js",
      cwd: __dirname,
      autorestart: true,
      max_restarts: 5,
      time: true,
      env: {
        DINGTALK_WEBHOOK: process.env.DINGTALK_WEBHOOK || "",
      },
    },
  ],
};
