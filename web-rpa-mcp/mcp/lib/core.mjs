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
    saveEvidence: true,
    evidenceOn: 'always',          // always | failure | never
    humanHandoffTimeoutMs: 180000,
    blockSensitiveAutofill: true,
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
    maskSecrets: true,
    maskFieldsInScreenshots: true,   // 截图前把密码框等敏感字段打码，避免证据图里泄露

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
  const line = `[${new Date().toISOString()}] [${level}] [${scope}] ${msg}${extra ? ' ' + safeJson(extra) : ''}`;
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

/** 返回结构化 MCP 文本结果 */
export function ok(data, summary) {
  const text = summary ? `${summary}\n\n` + JSON.stringify(data, null, 2) : JSON.stringify(data, null, 2);
  return { content: [{ type: 'text', text }], isError: false };
}

export function fail(message, data) {
  const text = data ? `❌ ${message}\n\n` + JSON.stringify(data, null, 2) : `❌ ${message}`;
  return { content: [{ type: 'text', text }], isError: true };
}
