#!/usr/bin/env node
/**
 * log_summary.mjs — 观测日志一页纸摘要（脚本方式）
 *
 * 用法：
 *   node scripts/log_summary.mjs [日志路径]            # 缺省取 $PVMCP_LOG
 *   node scripts/log_summary.mjs [日志路径] --json
 *
 * 消费 server.mjs 的 PVMCP_LOG 结构化记录（每请求一行 name/ms/outcome/code；
 * nl_test_goal 另带 cache=hit|miss|skip），
 * 输出调用量、成功率、延迟分布（P50/P95/P99）、错误分布（按 code 聚）、
 * 计划缓存命中率（按工具：三态分布 + hit/(hit+miss)，skip 不进分母）。
 *
 * 退出码：0 = 出数（报告工具，数据好坏不阻断）/ 2 = 用法或环境错误（缺文件、没设 PVMCP_LOG）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { lib, parseArgs, finish } from './verify-lib.mjs';

const { flags, positional } = parseArgs();
const file = positional[0] || process.env.PVMCP_LOG;
if (!file) {
  finish(2, '用法：node scripts/log_summary.mjs [日志路径] [--json]\n'
    + '没给路径时读 $PVMCP_LOG —— 先设置它并让 MCP server 跑一会儿，再回来出数。');
}

try {
  const { summarizeLog, formatText } = await lib('logsummary.js');
  if (!fs.existsSync(file)) {
    finish(2, `日志不存在：${path.resolve(file)}\n`
      + '确认 PVMCP_LOG 指向的路径与实际写入一致；未设置 PVMCP_LOG 时 server 不写任何日志。');
  }
  const summary = summarizeLog(fs.readFileSync(file, 'utf8'));
  // 轮转前件提示：server 侧超限轮转会把前一段挪到 <file>.1 —— 当前文件汇总不含它，
  // 不提示的话「调用量比预期少」就成了静默错觉。text 模式加一行说明；json 模式加增量字段（形状兼容）。
  const prevFile = `${file}.1`;
  if (fs.existsSync(prevFile)) {
    const prevLines = fs.readFileSync(prevFile, 'utf8').split('\n').filter((l) => l.trim()).length;
    if (flags.json) summary.rotatedPrev = { file: path.basename(prevFile), lines: prevLines };
    else summary.__prevNote = `轮转前日志 ${path.basename(prevFile)}：${prevLines} 行，未计入本次汇总（需要时单独出数）`;
  }
  if (flags.json) finish(0, JSON.stringify(summary, null, 2));
  else {
    let text = formatText(summary, `观测摘要（${file}）`);
    if (summary.__prevNote) text += `\n  （${summary.__prevNote}）`;
    finish(0, text);
  }
} catch (e) {
  finish(2, `log_summary 无法执行：${e.message}`);
}
