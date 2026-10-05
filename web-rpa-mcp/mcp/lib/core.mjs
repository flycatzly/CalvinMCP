// web-rpa-mcp — 共享核心：路径 / 配置 / 原子 JSON IO / ID / 日志 / 时间
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const MCP_DIR = path.resolve(__dirname, '..');
export const ROOT = path.resolve(MCP_DIR, '..');

export const DIRS = {
  root: ROOT,
  mcp: MCP_DIR,
  flows: path.join(ROOT, 'flows'),
  runs: path.join(ROOT, 'runs'),
  logs: path.join(ROOT, 'logs'),
  work: path.join(ROOT, '.work'),
  configFile: path.join(ROOT, 'web-rpa.config.json'),
};

export function ensureDirs() {
  for (const d of [DIRS.flows, DIRS.runs, DIRS.logs, DIRS.work]) {
    try { fs.mkdirSync(d, { recursive: true }); } catch { /* ignore */ }
  }
}

/**
 * 解析运行总时长预算（毫秒）：显式参数 > 配置 run.maxDurationMs > 无人值守默认上限。
 * 只有 trigger=schedule 才吃兜底上限：手工运行要能跑长任务，但定时任务跑飞（页面卡死/反复弹窗）
 * 没有上限就会占住流程锁拖到天亮——所以无人值守必须有默认帽。显式传 0 是"确要不限"的逃生口。
 */
export function resolveRunBudget(optsMax, runCfg = {}, trigger = 'manual') {
  const hasExplicit = optsMax !== undefined && optsMax !== null && !(typeof optsMax === 'string' && optsMax.trim() === '');
  const explicit = hasExplicit ? (Number(optsMax) || 0) : null;
  let maxDurationMs = explicit !== null ? explicit : (Number(runCfg.maxDurationMs) || 0);
  let cappedBy = null;
  // 只有"没显式给、配置也没给"才吃无人值守兜底帽：显式 0 是确要不限的逃生口，不能被兜底顶掉
  if (explicit === null && !maxDurationMs && String(trigger).toLowerCase() === 'schedule') {
    const un = Number(runCfg.unattendedMaxDurationMs) || 0;
    if (un > 0) { maxDurationMs = un; cappedBy = 'unattendedMaxDurationMs'; }
  }
  return { maxDurationMs, cappedBy };
}

/* ---------------- id / 时间戳安全闸 ----------------
   流程 id 与运行时间戳会拼进 flows/、runs/、locks/ 下的文件路径。不设闸时
   flow_get('../web-rpa.config') 能读到 flows/ 之外的任意 .json（含 webhook 配置），
   flow_save 能覆盖、flow_delete 能删——路径穿越是真实可达的攻击面（已实测）。
   规则：拒绝空/超长、路径分隔符与 Windows 非法字符、控制符、'..'、点号开头、点或空格收尾。 */
export function assertSafeId(id, what = 'id') {
  const s = typeof id === 'string' ? id : String(id === undefined || id === null ? '' : id);
  if (!s || s.length > 128) throw new Error(what + ' 不合法（长度需 1–128 字符）: ' + s.slice(0, 40));
  if (/[\\/:*?"<>|\x00-\x1f]/.test(s) || s.includes('..') || s.startsWith('.') || /[. ]$/.test(s)) {
    throw new Error(what + ' 不合法（不得包含路径分隔符/冒号/引号/控制符或 ..，不得以点开头、以点或空格收尾）: ' + s.slice(0, 40));
  }
  return s;
}

/** assertSafeId 的 schema 面口径（入口 pattern 先挡一道报 INVALID_ARGUMENT；细节由 assertSafeId 兜底） */
export const SAFE_ID_PATTERN = '^[^\\\\/:*?"<>|\\u0000-\\u001f]{1,128}$';

/** 进程是否还活着（kill 0 探测；EPERM 也算活着）。判"运行标记是进行中还是硬崩中断"的唯一依据 */
export function pidAlive(pid) {
  if (!pid || pid === process.pid) return pid === process.pid;
  try { process.kill(pid, 0); return true; }
  catch (e) { return !!(e && e.code === 'EPERM'); }
}

/** 默认配置：全部可在 web-rpa.config.json 覆盖 */
export const DEFAULT_CONFIG = {
  browser: {
    // auto | chromium | msedge | chrome | custom
    mode: 'auto',
    channel: null,
    executablePath: null,
    headless: true,
    viewport: { width: 1440, height: 900 },
    // 复用同一个浏览器用户目录：人工登录一次，之后无人值守不用再登（见 profile_login）
    persistProfile: false,
    profileDir: null,            // 默认 <项目>/.work/profile
    slowMo: 0,
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    recordViewport: { width: 1440, height: 900 },
    userAgent: null,
  },
  run: {
    stepTimeoutMs: 15000,
    navTimeoutMs: 45000,
    retries: 1,
    retryDelayMs: 800,
    maxDurationMs: 0,              // 运行级总超时：0=不限；到期后优雅收尾（截图+报告+告警+释放锁）
    unattendedMaxDurationMs: 7200000, // 无人值守（trigger=schedule）兜底总超时：手工不限但定时不能跑飞拖到天亮（0=取消兜底）
    saveVideo: false,              // true 时回放全程录像（Playwright recordVideo，需要自带 ffmpeg）
    videoOn: 'failure',            // failure | always —— 成功时是否保留录像（failure=删掉成功录像省空间）
    keepVideosPerFlow: 20,         // 每个流程最多保留多少段录像（0=不限）；报告/截图不受影响
    saveEvidence: true,
    evidenceOn: 'always',          // always | failure | never
    humanHandoffTimeoutMs: 180000,
    emptyResultGuard: true,
    healMinScore: 0.72,
    strictDialogs: true,        // 出现未预期的浏览器弹窗时判失败（静默 dismiss 会导致"看起来成功实际没生效"）
    keepRunsPerFlow: 50,        // 每个流程最多保留多少次运行记录（0=不限）
    keepRunDays: 30,            // 运行记录最多保留多少天（0=不限）
  },
  notify: {
    enabled: false,
    type: 'generic',               // wecom | dingtalk | feishu | slack | generic
    webhook: '',
    on: ['failure', 'healed'],     // failure | success | healed | scheduled
    timeoutMs: 8000,
    mention: '',
  },
  schedule: { taskPrefix: 'WebRPA' },
  security: {
    maskSecrets: true,               // 参数值/日志脱敏总开关；false 仅放开参数值与日志便于调试（secret 凭据值、webhook 回显永远打码，不可关闭）
    maskFieldsInScreenshots: true,   // 截图前把密码框等敏感字段打码，避免证据图里泄露
    // 键名脱敏名单（不分大小写精确匹配）：参数/报告/日志/告警里这些键的值一律替换为 ***，
    // 且原值加入全文清除名单——没标 secret:true 的「password」类参数此前会明文进报告
    redactKeys: ['password', 'passwd', 'pwd', 'token', 'secret', 'otp', 'captcha', 'code', 'signature', 'authorization'],
  },
};

export function deepMerge(base, over) {
  if (over === null || over === undefined) return base;
  if (Array.isArray(base) || Array.isArray(over) || typeof base !== 'object' || typeof over !== 'object') {
    return over === undefined ? base : over;
  }
  const out = { ...base };
  for (const k of Object.keys(over)) out[k] = deepMerge(base[k], over[k]);
  return out;
}

export function readConfig() {
  try {
    const raw = fs.readFileSync(DIRS.configFile, 'utf8');
    return deepMerge(DEFAULT_CONFIG, JSON.parse(raw));
  } catch {
    return structuredClone(DEFAULT_CONFIG);
  }
}

/**
 * 应用配置变更：**null 表示"删除该键、恢复默认"**。
 * 否则像 channel/userAgent/webhook 这种一旦设置就再也撤销不了（deepMerge 遇到 null 会保留原值）。
 */
function applyPatch(base, patch) {
  const out = Array.isArray(base) ? base.slice() : Object.assign({}, base);
  for (const k of Object.keys(patch || {})) {
    const v = patch[k];
    if (v === null) { delete out[k]; continue; }
    if (v && typeof v === 'object' && !Array.isArray(v) && out[k] && typeof out[k] === 'object' && !Array.isArray(out[k])) {
      out[k] = applyPatch(out[k], v);
    } else out[k] = v;
  }
  return out;
}

export function writeConfig(patch) {
  const next = applyPatch(readConfig(), patch);
  writeJson(DIRS.configFile, next);
  return next;
}

export function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

export function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

export function exists(p) { try { fs.accessSync(p); return true; } catch { return false; } }

export function slugify(s, fallback = 'flow') {
  const out = String(s || '')
    .trim()
    .replace(/[\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/[^\p{L}\p{N}._-]+/gu, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
  return out || fallback;
}

export function shortId(prefix = '') {
  return prefix + crypto.randomBytes(4).toString('hex');
}

export function sha1(s) { return crypto.createHash('sha1').update(String(s)).digest('hex'); }

/** 时间戳目录名：20260930-103412-123 */
export function stampId(d = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${p(d.getMilliseconds(), 3)}`;
}

/** 支持 YYYY MM DD HH mm ss 记号的时间格式化 */
export function formatDate(d, pattern = 'YYYY-MM-DD') {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return String(pattern)
    .replace(/YYYY/g, String(d.getFullYear()))
    .replace(/MM/g, p(d.getMonth() + 1))
    .replace(/DD/g, p(d.getDate()))
    .replace(/HH/g, p(d.getHours()))
    .replace(/mm/g, p(d.getMinutes()))
    .replace(/ss/g, p(d.getSeconds()));
}

export function addDays(d, n) { const x = new Date(d.getTime()); x.setDate(x.getDate() + n); return x; }

export function nowIso() { return new Date().toISOString(); }

/** 日志：控制台走 stderr（stdout 留给 MCP 协议），同时按天落盘 */
const LOG_SINKS = new Set();
export function log(scope, level, msg, extra) {
  // 日志脱敏：命中 security.redactKeys 的键值替换为 ***（readConfig 失败静默返回默认配置，不会递归日志）
  let safe = extra;
  try {
    const cfg = readConfig();
    if (maskingEnabled(cfg)) safe = redactByKey(extra, redactKeyList(cfg));
  } catch { /* 脱敏失败不阻断日志本身 */ }
  const line = `[${new Date().toISOString()}] [${level}] [${scope}] ${msg}${safe ? ' ' + safeJson(safe) : ''}`;
  if (level === 'error' || level === 'warn') process.stderr.write(line + '\n');
  else if (process.env.WEBRPA_DEBUG) process.stderr.write(line + '\n');
  try {
    ensureDirs();
    fs.appendFileSync(path.join(DIRS.logs, `${formatDate(new Date())}.log`), line + '\n', 'utf8');
  } catch { /* ignore */ }
}

export function safeJson(v, max = 4000) {
  let s;
  try { s = typeof v === 'string' ? v : JSON.stringify(v); } catch { s = String(v); }
  if (s == null) s = String(v);
  return s.length > max ? s.slice(0, max) + '…' : s;
}

export function logger(scope) {
  return {
    info: (m, e) => log(scope, 'info', m, e),
    warn: (m, e) => log(scope, 'warn', m, e),
    error: (m, e) => log(scope, 'error', m, e),
  };
}

/** 掩码敏感串（用于日志/报告） */
export function maskSecret(s, keep = 3) {
  const str = String(s ?? '');
  if (!str) return '';
  if (str.length <= keep * 2) return '*'.repeat(str.length);
  return str.slice(0, keep) + '*'.repeat(Math.min(12, str.length - keep * 2)) + str.slice(-keep);
}

/** 脱敏总开关（security.maskSecrets）：false 只放开「参数值/日志」脱敏便于调试；
 *  secret 凭据值与 webhook 等凭据回显永远打码，不受此开关影响 */
export function maskingEnabled(cfg) {
  return !(cfg && cfg.security && cfg.security.maskSecrets === false);
}

/** 键名脱敏名单（security.redactKeys）→ 小写集合 */
export function redactKeyList(cfg) {
  const list = (cfg && cfg.security && Array.isArray(cfg.security.redactKeys))
    ? cfg.security.redactKeys
    : DEFAULT_CONFIG.security.redactKeys;
  return new Set(list.map((k) => String(k).toLowerCase()));
}

/** 键名脱敏：对象树里命中名单的键（不分大小写），值整体替换为 ***；返回新对象，不改入参 */
export function redactByKey(value, keys, on = true) {
  if (!on || !keys || typeof keys.has !== 'function' || keys.size === 0) return value;
  if (Array.isArray(value)) return value.map((v) => redactByKey(v, keys, on));
  if (value && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value)) {
      out[k] = keys.has(String(k).toLowerCase()) ? '***' : redactByKey(value[k], keys, on);
    }
    return out;
  }
  return value;
}

/** 路径脱敏：把文本里的本地绝对路径压成「mcp 相对段 / 文件名」，:line:col 原样保留。
 *  错误回包与日志同走这一出口——stack 帧曾把安装绝对路径（file:///D:/...）回给外部 MCP 客户端。
 *  包内路径（含 web-rpa-mcp/mcp/）保留 mcp/ 之后的相对段便于定位；其余只留文件名。
 *  正则要点：路径段内不含冒号（不吞 :line:col）；空格仅在其后仍接路径分隔符时算路径内部
 *  （"C:\Program Files\app" 整体脱敏，"读取 /a/b.csv 失败" 不吞尾部中文）；lookbehind 挡住
 *  URL 里的伪路径（https://x/home/y 不命中 /home/）。 */
const PATH_RE = /(?<![\w/.])(?:(?:file:\/\/\/)?[A-Za-z]:[\\/]|(?:file:\/\/)?\/(?:home|Users|root|tmp|var|opt|mnt|work)[\\/])(?:[^\s:()\[\]'",，。、！？<>|*?/\\]+|[\\/]| +(?=[^\s:()\[\]'",，。、！？<>|*?]*[\\/]))*(?=[:\s)\]'",，。、！？\n,]|$)/g;

export function redactPath(text) {
  return String(text ?? '').replace(PATH_RE, (m) => {
    const norm = m.replace(/^[A-Za-z]:/, '').replace(/\\/g, '/');
    const i = norm.toLowerCase().indexOf('web-rpa-mcp/mcp/');
    if (i >= 0) return norm.slice(i + 'web-rpa-mcp/mcp/'.length);
    const segs = norm.split('/').filter(Boolean);
    return segs[segs.length - 1] || m;
  });
}

/** 返回结构化 MCP 文本结果。
 *  structuredContent 把结构化 data 作为真字段透出（纯增量）：客户端不必再从 content[0].text 里抠 JSON。
 *  content 文本原样保留作通用回退（老客户端只读 text 完全不受影响），isError:false 形状不变；
 *  失败路径 fail() 不带 structuredContent，isError:true 形状逐字节不变。 */
export function ok(data, summary) {
  const text = summary ? `${summary}\n\n` + JSON.stringify(data, null, 2) : JSON.stringify(data, null, 2);
  return { content: [{ type: 'text', text }], isError: false, structuredContent: data };
}

export function fail(message, data) {
  const text = data ? `❌ ${message}\n\n` + JSON.stringify(data, null, 2) : `❌ ${message}`;
  return { content: [{ type: 'text', text }], isError: true };
}

/* ---------------- 工具入参校验（inputSchema 驱动） ----------------
   工具声明的 inputSchema 就是对外契约：客户端照它构造参数，服务端就必须照它验收。
   不验收的后果是"错误参数悄悄改变安全语义"：headed:'false' 被当 true（弹出真浏览器）、
   maxDurationMs:-1 被当"不限时"（看门狗失效）。现在在 tools/call 入口统一把关：
   标量做一次保守的字符串强制转换（LLM 客户端常把数字/布尔发成字符串，转换能提高成功率），
   转不动就报 INVALID_ARGUMENT 并点名参数路径，不再让 handler 各自宽松判断。 */

const TYPE_CN = { integer: '整数', number: '数字', boolean: '布尔值', string: '字符串', array: '数组', object: '对象' };

function previewVal(v) {
  if (v !== null && typeof v === 'object') return Array.isArray(v) ? 'array' : 'object';
  const s = JSON.stringify(v);
  return s === undefined ? String(v) : (s.length > 40 ? s.slice(0, 40) + '…' : s);
}

function coerceScalar(v, type) {
  if (typeof v !== 'string') return v;
  const s = v.trim();
  if (type === 'integer' || type === 'number') return s !== '' && Number.isFinite(Number(s)) ? Number(s) : undefined;
  if (type === 'boolean') { if (/^true$/i.test(s)) return true; if (/^false$/i.test(s)) return false; return undefined; }
  return v;
}

function typeOk(v, type) {
  switch (type) {
    case 'integer': return Number.isInteger(v);
    case 'number': return typeof v === 'number' && Number.isFinite(v);
    case 'boolean': return typeof v === 'boolean';
    case 'string': return typeof v === 'string';
    case 'array': return Array.isArray(v);
    case 'object': return v !== null && typeof v === 'object' && !Array.isArray(v);
    default: return true;
  }
}

function validateNode(v, sch, path) {
  if (!sch || typeof sch !== 'object' || !sch.type) return { ok: true, value: v }; // 未声明类型的片段不设限
  const where = path || '(root)';
  let val = coerceScalar(v, sch.type);
  if (val === undefined || !typeOk(val, sch.type)) {
    return { ok: false, error: { param: where, expected: TYPE_CN[sch.type] || sch.type, got: previewVal(v),
      message: where + ' 应为' + (TYPE_CN[sch.type] || sch.type) + '，实际收到 ' + previewVal(v) } };
  }
  if (Array.isArray(sch.enum) && sch.enum.length && !sch.enum.some((e) => e === val)) {
    return { ok: false, error: { param: where, expected: sch.enum.join(' / '), got: previewVal(val),
      message: where + ' 只能是 ' + sch.enum.join(' / ') + '，实际收到 ' + previewVal(val) } };
  }
  if (typeof sch.pattern === 'string' && typeof val === 'string') {
    let re = null;
    try { re = new RegExp(sch.pattern); } catch { re = null; }
    if (re && !re.test(val)) {
      return { ok: false, error: { param: where, expected: '符合格式 ' + sch.pattern, got: previewVal(val),
        message: where + ' 格式不合法（应匹配 ' + sch.pattern + '），实际收到 ' + previewVal(val) } };
    }
  }
  if (typeof val === 'number') {
    if (sch.minimum !== undefined && val < sch.minimum) {
      return { ok: false, error: { param: where, expected: '≥ ' + sch.minimum, got: previewVal(val),
        message: where + ' 应 ≥ ' + sch.minimum + '，实际收到 ' + previewVal(val) } };
    }
    if (sch.maximum !== undefined && val > sch.maximum) {
      return { ok: false, error: { param: where, expected: '≤ ' + sch.maximum, got: previewVal(val),
        message: where + ' 应 ≤ ' + sch.maximum + '，实际收到 ' + previewVal(val) } };
    }
  }
  if (sch.type === 'object') {
    for (const k of (sch.required || [])) {
      if (val[k] === undefined || val[k] === null) {
        return { ok: false, error: { param: path ? path + '.' + k : k, expected: 'required', got: null,
          message: '缺少必填参数 ' + (path ? path + '.' + k : k) } };
      }
    }
    if (sch.properties) {
      const out = {};
      for (const k of Object.keys(sch.properties)) {
        if (val[k] === undefined || val[k] === null) continue;
        const r = validateNode(val[k], sch.properties[k], path ? path + '.' + k : k);
        if (!r.ok) return r;
        out[k] = r.value;
      }
      for (const k of Object.keys(val)) if (!(k in out)) out[k] = val[k]; // 未声明的键原样放行（handler 可能用到）
      val = out;
    }
  }
  if (sch.type === 'array' && sch.items) {
    const out = [];
    for (let i = 0; i < val.length; i++) {
      const r = validateNode(val[i], sch.items, (path || 'root') + '[' + i + ']');
      if (!r.ok) return r;
      out.push(r.value);
    }
    val = out;
  }
  return { ok: true, value: val };
}

/**
 * 按 inputSchema 验收工具入参（含标量强制转换）。
 * @returns {{ok: true, value: object} | {ok: false, error: {param, expected, got, message}}}
 */
export function validateArgs(args, schema) {
  const root = validateNode(args && typeof args === 'object' && !Array.isArray(args) ? args : {},
    Object.assign({ type: 'object' }, schema || {}), '');
  return root.ok ? { ok: true, value: root.value } : { ok: false, error: root.error };
}
