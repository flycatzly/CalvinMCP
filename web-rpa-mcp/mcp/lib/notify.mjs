// web-rpa-mcp — 异常告警：企业微信/钉钉/飞书/Slack/通用 Webhook + 本地告警日志
import fs from 'node:fs';
import path from 'node:path';
import { DIRS, ensureDirs, readConfig, logger, maskSecret } from './core.mjs';

const L = logger('notify');

export function shouldNotify(event, cfg = readConfig()) {
  const n = cfg.notify || {};
  if (!n.enabled) return false;
  if (!n.webhook) return false;
  const on = Array.isArray(n.on) ? n.on : [];
  return on.includes(event) || on.includes('all');
}

function buildPayload(type, msg) {
  switch (type) {
    case 'wecom':
      return { msgtype: 'markdown', markdown: { content: msg.markdown } };
    case 'dingtalk':
      return { msgtype: 'markdown', markdown: { title: msg.title, text: msg.markdown } };
    case 'feishu':
      return { msg_type: 'text', content: { text: msg.text } };
    case 'slack':
      return { text: msg.text };
    default:
      return msg.data || { title: msg.title, text: msg.text, markdown: msg.markdown };
  }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function logAlert(type, status, msg) {
  try {
    ensureDirs();
    fs.appendFileSync(path.join(DIRS.logs, 'alerts.log'),
      JSON.stringify({ at: new Date().toISOString(), type, status, title: msg.title }) + '\n', 'utf8');
  } catch { /* ignore */ }
}

/* ---- 告警发件箱（outbox）：发送彻底失败的告警先落盘，下次发送前自动补发 ---- */

const OUTBOX_CAP = 20;
const outboxFile = () => path.join(DIRS.work, 'notify-outbox.json');

function loadOutbox() {
  const f = outboxFile();
  let raw = null;
  try { raw = fs.readFileSync(f, 'utf8'); } catch { return []; }
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    // 坏文件别静默灭迹：挪到 .corrupt-<ts> 留证据再当空箱（下次入队会重建）
    try { fs.renameSync(f, f + '.corrupt-' + Date.now()); } catch { /* ignore */ }
    return [];
  }
}

function saveOutbox(entries) {
  const capped = entries.slice(-OUTBOX_CAP);
  if (capped.length < entries.length) L.warn('发件箱已满（上限 ' + OUTBOX_CAP + ' 条），丢弃最旧 ' + (entries.length - capped.length) + ' 条积压告警', { cap: OUTBOX_CAP });
  try {
    ensureDirs();
    fs.writeFileSync(outboxFile(), JSON.stringify(capped, null, 2), 'utf8');
  } catch { /* ignore */ }
}

/** 彻底发送失败后入队（保留最近 20 条） */
function queueOutbox(msg) {
  const q = loadOutbox();
  q.push({ at: new Date().toISOString(), msg });
  saveOutbox(q);
  return q.length > OUTBOX_CAP ? OUTBOX_CAP : q.length;
}

/** 当前积压的待补发告警条数（doctor/status 用） */
export function outboxCount() { return loadOutbox().length; }

/** 发件箱积压现状：条数 + 最旧一条的年龄——积压越久越说明告警链路断了，必须能被无人值守视图看见 */
export function outboxInfo() {
  const q = loadOutbox();
  const oldest = q[0] || null;
  let oldestAgeHours = null;
  if (oldest && oldest.at) {
    const t = Date.parse(oldest.at);
    if (!Number.isNaN(t)) oldestAgeHours = Number(((Date.now() - t) / 3600000).toFixed(1));
  }
  return { count: q.length, oldestAt: (oldest && oldest.at) || null, oldestAgeHours };
}

/**
 * 补发积压告警：网络恢复后，下次任何一次发送前把旧告警先发出去（保持时序，遇错即停，
 * 失败的那条连同其后所有条目留在队列里下次再试，避免乱序和风暴）。
 */
async function flushOutbox(cfg) {
  const q = loadOutbox();
  if (!q.length) return 0;
  const left = [];
  let flushed = 0;
  let failed = false;
  for (const entry of q) {
    if (failed) { left.push(entry); continue; }
    const r = await sendNotify(entry.msg, cfg, { force: true, skipFlush: true, noQueue: true });
    if (r && r.sent) { flushed++; continue; }
    if (r && r.permanent) {
      // 毒条目：4xx 永远发不进，留在队列里会永久堵死后续补发——移出并记 dead-letter 留痕，继续补发后面的
      L.warn('积压告警被服务端永久拒绝，移出发件箱（dead-letter）', { title: (entry.msg && entry.msg.title) || '', err: r.error });
      logAlert('outbox-dead-letter', 0, entry.msg || {});
      continue;
    }
    failed = true;
    left.push(entry);
  }
  saveOutbox(left);
  if (flushed) L.info('补发积压告警', { flushed, remaining: left.length });
  return flushed;
}

/**
 * 发送一条告警（网络抖动/服务端 5xx/429 自动重试 2 次；彻底失败入发件箱待补发）。
 * 告警是失败链路的最后一环——它丢了，无人值守的事故就没人知道，比慢两秒糟得多。
 */
export async function sendNotify(msg, cfg = readConfig(), { force = false, skipFlush = false, noQueue = false } = {}) {
  const n = cfg.notify || {};
  if (!force && (!n.enabled || !n.webhook)) return { sent: false, skipped: '未启用或未配置 webhook' };
  if (!n.webhook) return { sent: false, error: '未配置 webhook 地址' };

  // 先补发积压告警（skipFlush 由 flushOutbox 自身使用，防递归）
  let flushed = 0;
  if (!skipFlush) {
    try { flushed = await flushOutbox(cfg); } catch { /* 补发失败不挡本次发送 */ }
  }

  const type = n.type || 'generic';
  const payload = buildPayload(type, msg);
  const maxAttempts = 3;
  const backoff = [0, 800, 1600];
  let lastErr = null;
  let lastStatus = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (backoff[attempt - 1]) await sleep(backoff[attempt - 1]);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Number(n.timeoutMs) || 8000);
    try {
      const res = await fetch(n.webhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      const bodyText = await res.text().catch(() => '');
      lastStatus = res.status;
      // 5xx/限流是服务端临时问题，值得重试；4xx 是请求本身不对，重试也没用
      if (res.status >= 500 || res.status === 429) {
        lastErr = 'HTTP ' + res.status;
        L.warn('告警发送失败，准备重试', { type, status: res.status, attempt, maxAttempts });
        continue;
      }
      // 4xx（429 已按限流重试）：被服务端拒绝=告警没送出去——如实报失败，绝不谎报"已发送"（误报成功类）；
      // 不重试、不入箱（补发同样永远发不进），标 permanent 让补发循环把它移出队列（毒条目不死堵箱）
      if (res.status >= 400) {
        lastErr = 'HTTP ' + res.status;
        L.error('告警被服务端拒绝（HTTP ' + res.status + '）：不重试、不补发', { type, status: res.status });
        logAlert(type, res.status, msg);
        return { sent: false, type, attempts: attempt, error: lastErr + '（被服务端拒绝，请求本身不对）', queued: false, permanent: true };
      }
      L.info('告警已发送', { type, status: res.status, attempts: attempt, url: maskSecret(n.webhook, 12) });
      logAlert(type, res.status, msg);
      return { sent: true, type, status: res.status, attempts: attempt, response: bodyText.slice(0, 300), ...(flushed ? { flushed } : {}) };
    } catch (e) {
      lastErr = String(e && e.message ? e.message : e);
      L.warn('告警发送异常，准备重试', { type, err: lastErr, attempt, maxAttempts });
    } finally {
      clearTimeout(timer);
    }
  }
  L.error('告警发送失败（已重试 ' + maxAttempts + ' 次）', { type, err: lastErr });
  logAlert(type, lastStatus || 0, msg);
  // 只有「临时性故障」（网络错误 / 5xx / 429）才入队补发；
  // 4xx 说明 webhook/格式配错了，补发也永远发不进，还会堵住整个发件箱
  const retryable = lastStatus === null || lastStatus >= 500 || lastStatus === 429;
  let queued = false;
  if (retryable && !noQueue) {
    try { queueOutbox(msg); queued = true; L.warn('告警已入发件箱待补发', { at: outboxFile() }); } catch { /* ignore */ }
  }
  return { sent: false, type, attempts: maxAttempts, error: lastErr || ('HTTP ' + lastStatus), queued, ...(flushed ? { flushed } : {}) };
}

const ICON = { pass: '[OK]', fail: '[FAIL]', warning: '[WARN]' };

/** 把一次运行结果组装成告警文案 */
export function composeRunMessage(report, cfg = readConfig()) {
  const icon = report.status === 'pass' ? ICON.pass : report.status === 'fail' ? ICON.fail : ICON.warning;
  const okWord = report.status === 'pass' ? '执行成功' : '执行失败';
  const title = icon + ' Web RPA ' + okWord + '：' + (report.name || report.flowId);
  const lines = [];
  lines.push('**Web RPA ' + okWord + '**  ' + icon);
  lines.push('> 流程：' + (report.name || report.flowId) + '  (id: ' + report.flowId + ')');
  lines.push('> 触发：' + (report.trigger || 'manual') + '  耗时：' + Math.round((report.durationMs || 0) / 1000) + 's');
  if (report.failedStep) lines.push('> 失败步骤：第 ' + report.failedStep + ' 步');
  if (report.error) lines.push('> 原因：' + String(report.error).split('\n')[0].slice(0, 200));
  const asserts = report.assertions || [];
  if (asserts.length) {
    const bad = asserts.filter((a) => !a.pass);
    lines.push('> 校验：' + (asserts.length - bad.length) + '/' + asserts.length + ' 通过');
    bad.slice(0, 3).forEach((a) => lines.push('>   x ' + (a.message || a.kind)));
  }
  if ((report.healed || []).length) {
    lines.push('> 自愈：' + report.healed.length + ' 处定位符降级命中（' + report.healed.map((h) => '第' + h.step + '步').join('、') + '）');
  }
  if (report.reportPath) lines.push('> 报告：' + report.reportPath);
  if ((report.screenshots || []).length) lines.push('> 截图：' + report.screenshots.length + ' 张');
  if ((report.videos || []).length) lines.push('> 录像：' + report.videos.length + ' 段（' + report.videos.map((v) => path.basename(v)).join('、') + '）');
  if (report.timedOut) lines.push('> 总超时：是（maxDurationMs=' + report.maxDurationMs + '，已优雅收尾）');
  const mention = (cfg.notify && cfg.notify.mention) ? '\n' + cfg.notify.mention : '';
  const text = lines.join('\n').replace(/\*\*/g, '') + mention;
  return {
    title,
    markdown: '## ' + title + '\n' + lines.join('\n') + mention,
    text: title + '\n' + text,
    data: {
      flowId: report.flowId, name: report.name, status: report.status,
      failedStep: report.failedStep || null, error: report.error || null,
      durationMs: report.durationMs, reportPath: report.reportPath || null,
      assertions: (report.assertions || []).map((a) => ({ kind: a.kind, pass: a.pass, message: a.message })),
      healed: report.healed || [],
      videos: report.videos || [],
      timedOut: !!report.timedOut,
    },
  };
}
