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

/** 发送一条告警 */
export async function sendNotify(msg, cfg = readConfig(), { force = false } = {}) {
  const n = cfg.notify || {};
  if (!force && (!n.enabled || !n.webhook)) return { sent: false, skipped: '未启用或未配置 webhook' };
  if (!n.webhook) return { sent: false, error: '未配置 webhook 地址' };
  const type = n.type || 'generic';
  const payload = buildPayload(type, msg);
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
    L.info('告警已发送', { type, status: res.status, url: maskSecret(n.webhook, 12) });
    try {
      ensureDirs();
      fs.appendFileSync(path.join(DIRS.logs, 'alerts.log'),
        JSON.stringify({ at: new Date().toISOString(), type, status: res.status, title: msg.title }) + '\n', 'utf8');
    } catch { /* ignore */ }
    return { sent: true, type, status: res.status, response: bodyText.slice(0, 300) };
  } catch (e) {
    const err = String(e && e.message ? e.message : e);
    L.error('告警发送失败', { type, err });
    return { sent: false, type, error: err };
  } finally {
    clearTimeout(timer);
  }
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
    },
  };
}
