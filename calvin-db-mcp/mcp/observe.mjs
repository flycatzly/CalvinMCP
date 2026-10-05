/**
 * observe.mjs — v1.6.9 观测面打点（可选启用、零依赖）
 *
 * 设计约束（与全包纪律一致）：
 *  1) 默认完全关闭：仅当环境变量 DBMCP_ERR_LOG 指向日志文件路径时才写盘，未设置则零行为；
 *  2) 日志脱敏走权威 scrub：由 server.mjs 启动时注入（setScrub），秘密清洗逻辑单一真相源，
 *     不在本模块复制清洗规则（防规则漂移致漏洗）；先整段脱敏、再截断（防截断出半个秘密）；
 *  3) 日志写失败静默：观测面 fail-open——磁盘满/路径不可写/路径是目录都绝不影响工具调用；
 *     安全红线仍 fail-closed，两者不混（打点不是安全控制）；
 *  4) 契约零侵入：只追加审计记录，不改 tools/call 的 result/error 载荷任何字段；
 *  5) 单行有界：每字段截断（MAX_FIELD），单行 < 2KB，防超长 SQL/错误文本灌爆日志；
 *     文件总量有界：v1.6.10 超限滚动（DBMCP_ERR_LOG_MAX_BYTES / DBMCP_ERR_LOG_KEEP，见下）。
 *
 * 记录语义：每次 tools/call（含失败与未知工具）恰好 1 行 NDJSON；
 * id 为 JSON-RPC 请求 id，与客户端请求一一关联；错误行带稳定错误码与重试态，
 * 成功行 code/retry 为 null——错误率与重试态分布可直接统计（分母=全部行）。
 */
import fs from "node:fs";

/** 单字段截断上限（scrub 后截断） */
export const MAX_FIELD = 200;

let scrubFn = (t) => String(t);

/** 注入权威脱敏函数（server.mjs 启动时调用一次；自测可注入自定义清单验证清洗链路） */
export function setScrub(fn) {
  if (typeof fn === "function") scrubFn = fn;
}

/** 整段脱敏后截断（顺序不可反：秘密可能出现在任意位置） */
function safe(text) {
  const s = scrubFn(String(text));
  return s.length > MAX_FIELD ? s.slice(0, MAX_FIELD) + "…" : s;
}

/**
 * 构造单条日志记录（纯函数，供自测直接断言字段/脱敏/截断）。
 * rec: { id, tool, args, duration_ms, is_error, code, retry, err_msg }
 */
export function fmtLogLine(rec) {
  const args = (rec && rec.args) || {};
  const pick = (v) => (typeof v === "string" && v ? safe(v) : null);
  return JSON.stringify({
    ts: new Date().toISOString(),
    id: rec?.id ?? null,
    tool: pick(rec?.tool),
    is_error: !!rec?.is_error,
    code: typeof rec?.code === "string" ? rec.code : null,
    retry: typeof rec?.retry === "string" ? rec.retry : null,
    duration_ms: Number.isFinite(rec?.duration_ms) ? rec.duration_ms : null,
    source: pick(args.source),
    table: pick(args.table),
    sql_head: pick(args.sql),
    err_head: rec?.is_error ? pick(rec?.err_msg) : null,
  });
}

/* ------------------------- v1.6.10 日志滚动（总量有界） ------------------------- */
// DBMCP_ERR_LOG_MAX_BYTES：单文件上限（缺省 10MB，合法域 [1024, 1GB]，越界/非整数回落缺省）
// DBMCP_ERR_LOG_KEEP：滚动保留份数（缺省 3，合法域 [1, 20]）——文件名 <path>.1 为最近一次滚动的旧日志
// 滚动语义：写入前 stat 当前大小，size+行 > 上限时把 .KEEP 删掉、.N 顺次后移（.KEEP-1→.KEEP … .1→.2）、
// 主文件 → .1，再追加新行。Windows 上 rename 目标必须不存在，故从高位往低位挪且先删末端。
// 有界不变量：单行 <2KB（字段截断）+ 每文件 ≤ max(maxBytes, 行上限) + 保留 ≤ KEEP 份 → 总量有界。
// 失败边界：stat/rename/删除任一步失败都吞掉并照常追加（宁可暂时超限也不丢记录），下一次调用重试滚动；
// 追加写失败依旧 fail-open——观测面永不改变工具调用的行为与结果。

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_KEEP = 3;

/** 环境变量取整数，越界/非法回落缺省（观测面配置容错，不引入参数校验错误面） */
function intEnv(name, def, min, max) {
  const v = process.env[name];
  if (v == null || v === "") return def;
  const n = Number(v);
  return Number.isInteger(n) && n >= min && n <= max ? n : def;
}

function rotateIfNeeded(target, lineBytes) {
  let size = 0;
  try { size = fs.statSync(target).size; } catch { return; } // 不存在/取不到 → 首次写，无需滚动
  if (size === 0) return;
  const max = intEnv("DBMCP_ERR_LOG_MAX_BYTES", DEFAULT_MAX_BYTES, 1024, 1 << 30);
  if (size + lineBytes <= max) return;
  const keep = intEnv("DBMCP_ERR_LOG_KEEP", DEFAULT_KEEP, 1, 20);
  try { fs.rmSync(`${target}.${keep}`, { force: true }); } catch { /* 失败则该步跳过 */ }
  for (let i = keep - 1; i >= 1; i--) {
    try { fs.renameSync(`${target}.${i}`, `${target}.${i + 1}`); } catch { /* 该档缺失或被占用：跳过 */ }
  }
  try { fs.renameSync(target, `${target}.1`); } catch { /* 滚动失败：追加仍在原文件，记录不丢 */ }
}

/**
 * 追加一条调用记录（callTool 出口唯一调用点）。
 * 未启用 / 写失败均静默返回——观测面永不改变工具调用的行为与结果。
 */
export function logToolCall(rec) {
  try {
    const target = String(process.env.DBMCP_ERR_LOG || "").trim();
    if (!target) return;
    const line = fmtLogLine(rec) + "\n";
    rotateIfNeeded(target, Buffer.byteLength(line, "utf8"));
    fs.appendFileSync(target, line, "utf8");
  } catch { /* fail-open：日志写失败不影响工具调用 */ }
}
