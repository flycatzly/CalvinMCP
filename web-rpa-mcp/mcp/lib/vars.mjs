// web-rpa-mcp — 变量系统：模板解析、参数取值（内置/环境/表格/凭据）、日期自动识别
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DIRS, formatDate, addDays, logger } from './core.mjs';
import { readTable, resolveColumn } from './table.mjs';
import { getSecret } from './secrets.mjs';

const L = logger('vars');
const TOKEN_RE = /\$\{([^}]+)\}/g;

/** 日期型内置变量：名称 -> 默认格式 */
const DATE_BUILTINS = {
  today: 'YYYY-MM-DD',
  now: 'YYYY-MM-DD HH:mm:ss',
  yesterday: 'YYYY-MM-DD',
  tomorrow: 'YYYY-MM-DD',
  daystart: 'YYYY-MM-DD 00:00:00',
  dayend: 'YYYY-MM-DD 23:59:59',
  monthstart: 'YYYY-MM-01',
  yeartoday: 'YYYY-01-01',
  time: 'HH:mm:ss',
  date: 'YYYY-MM-DD',
};

function dateBase(name, now) {
  switch (name) {
    case 'yesterday': return addDays(now, -1);
    case 'tomorrow': return addDays(now, 1);
    default: return now;
  }
}

export function resolveBuiltin(name, arg, now = new Date()) {
  let key = String(name).toLowerCase();
  // 支持日期偏移：${today-7:YYYYMMDD}、${today+3}、${now-1:YYYY-MM-DD}
  let offset = 0;
  const om = /^([a-z]+)([+-])([0-9]{1,4})$/.exec(key);
  if (om) {
    key = om[1];
    offset = (om[2] === '-' ? -1 : 1) * Number(om[3]);
  }
  if (Object.prototype.hasOwnProperty.call(DATE_BUILTINS, key)) {
    const base = dateBase(key, now);
    return formatDate(offset ? addDays(base, offset) : base, arg || DATE_BUILTINS[key]);
  }
  switch (key) {
    case 'timestamp': return String(now.getTime());
    case 'uuid': return crypto.randomUUID();
    case 'random': {
      const n = Math.min(18, Math.max(1, Number(arg) || 6));
      let s = '';
      for (let i = 0; i < n; i++) s += Math.floor(Math.random() * 10);
      return s;
    }
    case 'root': case 'cwd': return DIRS.root;
    case 'env': return process.env[arg] !== undefined ? process.env[arg] : null;
    case 'osuser': return process.env.USERNAME || process.env.USER || null;
    default: return null;
  }
}

/** 解析单个 ${...} 表达式 */
export function resolveToken(expr, ctx = {}) {
  const raw = String(expr).trim();
  if (!raw) return null;
  const i = raw.indexOf(':');
  const name = i >= 0 ? raw.slice(0, i) : raw;
  const arg = i >= 0 ? raw.slice(i + 1) : '';
  const now = ctx.now || new Date();

  if (ctx.values && Object.prototype.hasOwnProperty.call(ctx.values, name)) {
    return ctx.values[name];
  }
  const b = resolveBuiltin(name, arg, now);
  if (b !== null && b !== undefined) return b;
  if (name.toLowerCase() === 'file' && arg) {
    try { return fs.readFileSync(path.resolve(arg), 'utf8').trim(); } catch { return null; }
  }
  return null;
}

/** 字符串模板解析；未知变量保持原样，由 collectUnresolved 报告 */
export function resolveTemplate(text, ctx = {}) {
  if (typeof text !== 'string') return text;
  return text.replace(TOKEN_RE, (m, expr) => {
    const v = resolveToken(expr, ctx);
    return v === null || v === undefined ? m : String(v);
  });
}

/** 递归解析对象/数组里的模板 */
export function resolveDeep(value, ctx = {}) {
  if (typeof value === 'string') return resolveTemplate(value, ctx);
  if (Array.isArray(value)) return value.map((v) => resolveDeep(v, ctx));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = resolveDeep(v, ctx);
    return out;
  }
  return value;
}

export function collectUnresolved(value, acc = [], seen = new Set()) {
  if (typeof value === 'string') {
    for (const m of value.matchAll(TOKEN_RE)) {
      const name = String(m[1]).split(':')[0];
      if (!seen.has(name)) { seen.add(name); acc.push(name); }
    }
  } else if (Array.isArray(value)) value.forEach((v) => collectUnresolved(v, acc, seen));
  else if (value && typeof value === 'object') Object.values(value).forEach((v) => collectUnresolved(v, acc, seen));
  return acc;
}

/* ---------------- 参数取值 ---------------- */

/** 从表格文件按 <path>#<col>[@row|*] 取值；col 支持列名 / A 列字母 / 1 基序号 */
export function fromTable(spec) {
  const hash = spec.lastIndexOf('#');
  const file = hash >= 0 ? spec.slice(0, hash) : spec;
  let colSpec = hash >= 0 ? spec.slice(hash + 1) : '';
  let mode = 'first';
  const at = colSpec.lastIndexOf('@');
  if (at >= 0) {
    const m = colSpec.slice(at + 1).trim();
    colSpec = colSpec.slice(0, at);
    if (m === '*') mode = 'all';
    else if (m !== '') mode = Number(m);
  }
  const abs = path.resolve(file);
  const table = readTable(abs, {});
  const idx = resolveColumn(table, colSpec);
  const values = table.rows.map((r) => String(r[idx] === undefined || r[idx] === null ? '' : r[idx]).trim()).filter((v) => v !== '');
  if (!values.length) throw new Error('表格「' + abs + '」第 ' + (idx + 1) + ' 列没有数据');
  if (mode === 'all') return values.join('\n');
  const n = mode === 'first' ? 0 : Number(mode);
  if (n >= values.length) {
    throw new Error('表格「' + abs + '」第 ' + (idx + 1) + ' 列只有 ' + values.length + ' 行，取不到第 ' + n + ' 行');
  }
  return values[n];
}

async function fromSource(p, ctx) {
  const src = p.source;
  if (!src) return undefined;
  const i = String(src).indexOf(':');
  const kind = (i < 0 ? src : String(src).slice(0, i)).trim();
  const rest = i < 0 ? '' : String(src).slice(i + 1);
  switch (kind) {
    case 'const': case 'default': return p.default;
    case 'env': {
      const v = process.env[rest];
      if (v === undefined) L.warn('环境变量不存在', { name: rest });
      return v;
    }
    case 'file': {
      try { return fs.readFileSync(path.resolve(rest), 'utf8').trim(); }
      catch (e) { throw new Error('读取文件失败: ' + rest + ' — ' + String(e && e.message ? e.message : e)); }
    }
    case 'secret': {
      const v = getSecret(rest);
      if (v === null) throw new Error('凭据「' + rest + '」不存在，请先用 secret_set 写入');
      return v;
    }
    case 'flow': {
      const parts = rest.split(':');
      const chain = ctx.chain || {};
      const rec = chain[parts[0]];
      if (!rec) return undefined;
      const key = parts[1];
      // 串联结果既可能直接挂在流程 id 上，也可能包在 extracted 里，两种都支持
      if (rec.extracted && Object.prototype.hasOwnProperty.call(rec.extracted, key)) return rec.extracted[key];
      return rec[key];
    }
    case 'table': case 'excel': case 'csv': case 'xlsx': return fromTable(rest);
    case 'prompt': return undefined;
    default:
      L.warn('未知参数来源', { source: src });
      return undefined;
  }
}

/**
 * 解析流程参数：provided > source > default > required 校验
 */
export async function resolveParams(flow, provided = {}, ctx = {}) {
  const params = flow.params || [];
  const values = {};
  const missing = [];
  const notices = [];
  const now = ctx.now || new Date();

  for (const [k, v] of Object.entries(provided || {})) {
    if (v !== undefined) values[k] = v;
  }

  for (const p of params) {
    if (values[p.name] !== undefined && values[p.name] !== '') continue;
    let v;
    try { v = await fromSource(p, { ...ctx, values }); }
    catch (e) { notices.push('参数「' + p.name + '」取值失败: ' + String(e && e.message ? e.message : e)); v = undefined; }
    if (v === undefined || v === null || v === '') v = p.default;
    if (v === undefined || v === null || v === '') {
      if (p.required) missing.push(p.name);
      continue;
    }
    values[p.name] = v;
  }

  for (let round = 0; round < 2; round++) {
    for (const p of params) {
      if (typeof values[p.name] === 'string') {
        values[p.name] = resolveTemplate(values[p.name], { values, now });
      }
    }
  }
  return { values, missing, notices };
}

/** 供 agent 展示的参数说明 */
export function describeParams(flow) {
  return (flow.params || []).map((p) => ({
    name: p.name,
    label: p.label || p.name,
    source: p.source || (p.default !== undefined ? 'const' : 'prompt'),
    default: p.secret ? (p.default ? '***' : '') : p.default,
    required: !!p.required,
    secret: !!p.secret,
  }));
}

/* ---------------- 日期字面量自动变量化 ---------------- */

const DATE_PATTERNS = [
  [/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD'],
  [/^\d{4}\/\d{2}\/\d{2}$/, 'YYYY/MM/DD'],
  [/^\d{4}\.\d{2}\.\d{2}$/, 'YYYY.MM.DD'],
  [/^\d{8}$/, 'YYYYMMDD'],
  [/^\d{4}年\d{2}月\d{2}日$/, 'YYYY年MM月DD日'],
  [/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}$/, 'YYYY-MM-DD HH:mm'],
  [/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}$/, 'YYYY-MM-DD HH:mm:ss'],
  [/^\d{14}$/, 'YYYYMMDDHHmmss'],
  [/^\d{2}-\d{2}$/, 'MM-DD'],
];

/**
 * 把「今天/昨天/明天」的日期字面量替换成 ${today:...}，并给出可参数化的重复值建议。
 */
export function autodetectVariables(steps, now = new Date()) {
  const replaced = [];
  const counter = new Map();
  const out = (steps || []).map((s, idx) => {
    const step = JSON.parse(JSON.stringify(s));
    if (step.op === 'fill' && typeof step.value === 'string' && step.value && !/\$\{/.test(step.value)) {
      for (const pair of DATE_PATTERNS) {
        const re = pair[0];
        const pattern = pair[1];
        if (!re.test(step.value)) continue;
        const candidates = [
          ['today', now, '${today:' + pattern + '}'],
          ['yesterday', addDays(now, -1), '${yesterday:' + pattern + '}'],
          ['tomorrow', addDays(now, 1), '${tomorrow:' + pattern + '}'],
        ];
        for (const c of candidates) {
          if (formatDate(c[1], pattern) === step.value) {
            replaced.push({ step: idx + 1, from: step.value, to: c[2], kind: c[0] });
            step.value = c[2];
            step.autoVariable = true;
            break;
          }
        }
        if (step.autoVariable) break;
      }
    }
    const v = step.op === 'fill' && typeof step.value === 'string' ? step.value : null;
    if (v && !/\$\{/.test(v) && !step.sensitive) {
      counter.set(v, (counter.get(v) || 0) + 1);
    }
    return step;
  });

  const suggestions = [];
  for (const entry of counter) {
    const value = entry[0];
    const count = entry[1];
    if (count >= 2 && value.length >= 3 && value.length <= 80) {
      suggestions.push({ value, occurrences: count, reason: '同一字面值出现 ' + count + ' 次，建议抽成参数' });
    }
  }
  for (const entry of counter) {
    const value = entry[0];
    const count = entry[1];
    if (/^[A-Za-z0-9_-]{8,}$/.test(value) && /\d/.test(value) && !suggestions.some((s) => s.value === value)) {
      suggestions.push({ value, occurrences: count, reason: '形如业务编号，建议抽成参数（可从 Excel/环境变量取值）' });
    }
  }
  return { steps: out, replaced, suggestions };
}

export const _internal = { DATE_PATTERNS, dateBase };
