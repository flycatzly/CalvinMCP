/**
 * logsummary.js — PVMCP_LOG 观测日志的聚合（纯函数，无 IO）
 *
 * 消费的是 server.mjs 写的「一请求一行」结构化记录：
 *   [ISO时间戳] tools/call name=<token> ms=<非负整数> outcome=<ok|error|rejected> code=<token>[ cache=<hit|miss|skip>][ msg=<行尾文本>]
 *
 * 口径（和写入侧对账，改一侧必须同步另一侧）：
 *   · 调用量 total = 三态之和，**含 rejected** —— 被拒的请求也是调用量，
 *     把它漏掉就是上一轮修掉的那个低估 bug 的镜像。
 *   · 成功率 = ok / total（被拒算未成功；total=0 时返回 null，不拿 0% 充数）。
 *   · 延迟样本只算**真执行了 handler 的调用**（ok|error）：rejected 的 ms=0 是
 *     构造值，混进分位数会把 P95 拉假。
 *   · 错误分布按 code 聚（ok 的 code='-' 不计）；rejected 的 code 是 -32602 这类协议码。
 *   · cache= 是**可选字段**（只有 nl_test_goal 落，v1.8.10）：缺字段的行照常解析，
 *     该工具不长 cache 桶 —— 缺字段不是异常，更不是「命中率 0%」的证据。
 *     值不在 PLAN_CACHE_STATES 白名单里 → 整行进 malformed（与 ms=oops 同口径，
 *     不静默猜）。cache 命中率 = hit / (hit + miss)：skip 是「没查」（llm=off），
 *     不是查询结果，不进分母；只有 skip 时命中率 null（不拿 0% 充数）。
 *   · 解析不了的调用行进 malformed 原文保留，**绝不静默丢弃** ——
 *     丢一行 = 调用量少一个，正是「不报错但数字错」的静默失效。
 *
 * 分位数用 nearest-rank（升序取第 ceil(p/100·n) 个）：确定性、无插值歧义、纯 JS 零依赖。
 */
import { PLAN_CACHE_STATES } from './plancache.js';

/** 调用行语法：code= 之后可选 cache=（白名单取 PLAN_CACHE_STATES 单一源）再可选 msg=。
 *  白名单外的 cache=（cache=banana）让整行失配 → malformed —— 与 ms=oops 同口径，
 *  不静默猜值、也不为保调用量吞掉坏数据。 */
const CALL_RE = new RegExp(
  `^name=(\\S+) ms=(\\d+) outcome=(ok|error|rejected) code=(\\S+)(?:\\s+cache=(${PLAN_CACHE_STATES.join('|')}))?(?:\\s+msg=.*)?$`,
);

/** 解析单行：返回 { kind: 'call'|'other'|'malformed', ...call 字段 }；call 含 cache（缺省 null）。 */
function parseLine(raw) {
  const line = raw.trim();
  if (!line) return null; // 空行不是事件
  // 去掉行首 [ISO 时间戳]（写入侧 log() 保证在位；缺了也容忍，用整行继续解析）
  const body = line.replace(/^\[[^\]]*\]\s*/, '');
  if (!body.startsWith('tools/call')) return { kind: 'other' };
  const rest = body.slice('tools/call'.length).trim();
  const m = CALL_RE.exec(rest);
  if (!m) return { kind: 'malformed', raw: line };
  return {
    kind: 'call',
    name: m[1],
    ms: Number(m[2]),
    outcome: m[3],
    code: m[4],
    cache: m[5] || null,
  };
}

function nearestRank(sortedAsc, p) {
  if (!sortedAsc.length) return null;
  const rank = Math.ceil((p / 100) * sortedAsc.length);
  return sortedAsc[Math.min(sortedAsc.length - 1, Math.max(0, rank - 1))];
}

/**
 * 聚合整份日志文本。
 *
 * @param {string} text 日志文件内容
 * @returns {object} 摘要：{ total, ok, error, rejected, otherLines, malformedCount, malformed,
 *   successRate, byCode, byTool, latency: { count, p50, p95, p99, max, avg } }；
 *   byTool[name].cache = { hit, miss, skip, total, hitRate }（仅带 cache= 行的工具才有该桶）
 */
export function summarizeLog(text) {
  const s = {
    total: 0, ok: 0, error: 0, rejected: 0,
    otherLines: 0, malformedCount: 0, malformed: [],
    successRate: null,
    byCode: {},
    byTool: {},
    latency: { count: 0, p50: null, p95: null, p99: null, max: null, avg: null },
  };
  const samples = [];
  for (const raw of String(text ?? '').split('\n')) {
    const p = parseLine(raw);
    if (!p) continue;
    if (p.kind === 'other') { s.otherLines++; continue; }
    if (p.kind === 'malformed') {
      s.malformedCount++;
      if (s.malformed.length < 20) s.malformed.push(p.raw); // 留样上限 20，防超大日志把摘要撑爆
      continue;
    }
    s.total++;
    s[p.outcome]++;
    if (p.code !== '-') s.byCode[p.code] = (s.byCode[p.code] || 0) + 1;
    const t = s.byTool[p.name] || (s.byTool[p.name] = { ok: 0, error: 0, rejected: 0, total: 0, maxMs: 0 });
    t[p.outcome]++;
    t.total++;
    if (p.ms > t.maxMs) t.maxMs = p.ms;
    if (p.cache) {
      // 计划缓存三态按工具聚（带 cache= 的行才长桶；缺字段的工具不长 —— 形状兼容）
      const c = t.cache || (t.cache = { hit: 0, miss: 0, skip: 0, total: 0, hitRate: null });
      c[p.cache]++;
      c.total++;
    }
    if (p.outcome !== 'rejected') samples.push(p.ms);
  }
  if (s.total > 0) s.successRate = s.ok / s.total;
  // 命中率 = hit/(hit+miss)：skip 是「没查」（llm=off），不是查询结果，不进分母；
  // 只有 skip 时 null（不拿 0% 充数）—— 与 successRate 的 null 口径一致。
  for (const t of Object.values(s.byTool)) {
    if (t.cache) t.cache.hitRate = t.cache.hit + t.cache.miss > 0 ? t.cache.hit / (t.cache.hit + t.cache.miss) : null;
  }
  if (samples.length) {
    const sorted = [...samples].sort((a, b) => a - b);
    s.latency = {
      count: sorted.length,
      p50: nearestRank(sorted, 50),
      p95: nearestRank(sorted, 95),
      p99: nearestRank(sorted, 99),
      max: sorted[sorted.length - 1],
      avg: Math.round((sorted.reduce((a, b) => a + b, 0) / sorted.length) * 10) / 10,
    };
  }
  return s;
}

/** 一页纸人读摘要。 */
export function formatText(summary, title = '观测摘要') {
  const s = summary;
  const pct = s.successRate === null ? '—' : `${(s.successRate * 100).toFixed(1)}%`;
  const lat = s.latency.count
    ? `p50 ${s.latency.p50} / p95 ${s.latency.p95} / p99 ${s.latency.p99} / max ${s.latency.max} / avg ${s.latency.avg}（样本 ${s.latency.count}，不含 rejected）`
    : '无执行样本';
  const codes = Object.entries(s.byCode).map(([c, n]) => `${c} ×${n}`).join('、') || '无';
  // 按工具块（v1.8.15）：每工具一行、按调用量降序（并列按名字稳定序）。
  // 为什么改：maxMs 一直采集了却从不渲染（「哪个工具最慢」一页内答不了），
  // 且多工具挤一行在长日志下不可读。max 含 rejected 的 ms=0 —— 0 只会拉低不会抬高，
  // 具名最慢值仍然是真实执行的上界。工具数受工具表上限约束（14），无需再截断。
  const toolLines = Object.entries(s.byTool)
    .sort((a, b) => b[1].total - a[1].total || (a[0] < b[0] ? -1 : 1))
    .map(([n, t]) => {
      const parts = [`  · ${n} 共 ${t.total}`];
      if (t.ok) parts.push(`ok ${t.ok}`);
      if (t.error) parts.push(`error ${t.error}`);
      if (t.rejected) parts.push(`rejected ${t.rejected}`);
      parts.push(`max ${t.maxMs}ms`);
      if (t.cache) {
        const rate = t.cache.hitRate === null ? '—' : `${(t.cache.hitRate * 100).toFixed(1)}%`;
        parts.push(`cache hit ${t.cache.hit}/miss ${t.cache.miss}/skip ${t.cache.skip}（命中率 ${rate}）`);
      }
      return parts.join(' ');
    });
  const toolsBlock = toolLines.length ? ['  按工具（按调用量降序）：', ...toolLines] : ['  按工具：无'];
  return [
    `${title}：`,
    `  调用量 ${s.total}（ok ${s.ok} / error ${s.error} / rejected ${s.rejected}）  成功率 ${pct}`,
    `  延迟 ms：${lat}`,
    `  错误分布：${codes}`,
    ...toolsBlock,
    `  其他事件 ${s.otherLines} 行；解析异常 ${s.malformedCount} 行${s.malformedCount ? `（示例：${s.malformed[0].slice(0, 60)}…）` : ''}`,
  ].join('\n');
}

export default { summarizeLog, formatText };
