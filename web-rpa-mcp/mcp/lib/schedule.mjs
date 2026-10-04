// web-rpa-mcp — 定时：Windows 任务计划程序封装（生成 .cmd 包装器 + schtasks 注册）
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DIRS, MCP_DIR, ROOT, ensureDirs, readConfig, readJson, writeJson, logger, formatDate } from './core.mjs';

const execFileAsync = promisify(execFile);
const L = logger('schedule');

const INDEX_FILE = () => path.join(DIRS.work, 'sched', 'index.json');

function loadIndex() { return readJson(INDEX_FILE(), {}) || {}; }
function saveIndex(o) { writeJson(INDEX_FILE(), o); }

export function taskPrefix() { return (readConfig().schedule && readConfig().schedule.taskPrefix) || 'WebRPA'; }
export function taskName(flowId) { return taskPrefix() + '\\' + flowId; }
export function wrapperPath(flowId) { return path.join(DIRS.work, 'sched', flowId + '.cmd'); }
export function paramsPath(flowId) { return path.join(DIRS.work, 'sched', flowId + '.params.json'); }

/** 生成任务计划调用的 .cmd 包装器（避免命令行引号地狱） */
export function writeWrapper(flowId, opts = {}) {
  const dir = path.dirname(wrapperPath(flowId));
  fs.mkdirSync(dir, { recursive: true });
  const logFile = path.join(DIRS.logs, 'schedule-' + flowId + '.log');
  const args = ['run', flowId, '--trigger', 'schedule'];
  if (opts.params && Object.keys(opts.params).length) {
    writeJson(paramsPath(flowId), opts.params);
    args.push('--params-file', paramsPath(flowId));
  }
  if (opts.headed) args.push('--headed');
  const runner = path.join(MCP_DIR, 'runner.mjs');
  const q = (s) => '"' + String(s) + '"';
  const line = [
    '@echo off',
    'chcp 65001 >nul',
    'cd /d ' + q(ROOT),
    q(process.execPath) + ' ' + q(runner) + ' ' + args.map(q).join(' ') + ' >> ' + q(logFile) + ' 2>&1',
    'exit /b %ERRORLEVEL%',
  ].join('\r\n');
  fs.writeFileSync(wrapperPath(flowId), line + '\r\n', 'utf8');
  return wrapperPath(flowId);
}

/** schtasks 按控制台代码页输出（中文 Windows 通常是 936/GBK），用 UTF-8 解码会乱码，字段就解析不出来 */
let _oemDecoder = null;
async function oemDecoder() {
  if (_oemDecoder) return _oemDecoder;
  let cp = 65001;
  try {
    const r0 = await execFileAsync('chcp.com', [], { windowsHide: true, encoding: 'buffer' });
    const m = /([0-9]+)/.exec(Buffer.from(r0.stdout || Buffer.alloc(0)).toString('latin1'));
    if (m) cp = Number(m[1]);
  } catch { /* 探测失败按 UTF-8 */ }
  const table = { 936: 'gbk', 950: 'big5', 932: 'shift_jis', 949: 'euc-kr', 65001: 'utf-8', 1252: 'windows-1252', 437: 'windows-1252', 850: 'windows-1252' };
  const label = table[cp] || 'utf-8';
  try { _oemDecoder = new TextDecoder(label); } catch { _oemDecoder = new TextDecoder('utf-8'); }
  L.info('schtasks 输出编码', { codePage: cp, decoder: label });
  return _oemDecoder;
}

async function runSchtasks(args) {
  const dec = await oemDecoder();
  const dec0 = (buf) => dec.decode(buf || Buffer.alloc(0)).trim();
  try {
    const { stdout, stderr } = await execFileAsync('schtasks', args, { windowsHide: true, timeout: 30000, encoding: 'buffer', maxBuffer: 8388608 });
    return { ok: true, out: dec0(stdout), err: dec0(stderr) };
  } catch (e) {
    const out = dec0(e && e.stdout);
    const err = dec0(e && e.stderr) || String(e && e.message ? e.message : e).trim();
    return { ok: false, out, err };
  }
}

function buildScheduleArgs(spec) {
  const kind = String(spec.frequency || 'daily').toLowerCase();
  const at = spec.at || '09:00';
  if (kind === 'daily') return ['/SC', 'DAILY', '/ST', at];
  if (kind === 'weekly') {
    const days = (spec.days && spec.days.length ? spec.days : ['MON']).map((d) => String(d).toUpperCase()).join(',');
    return ['/SC', 'WEEKLY', '/D', days, '/ST', at];
  }
  if (kind === 'minute') return ['/SC', 'MINUTE', '/MO', String(Number(spec.everyMinutes) || 30)];
  if (kind === 'hourly') return ['/SC', 'HOURLY', '/MO', String(Number(spec.everyHours) || 1), '/ST', at];
  if (kind === 'logon') return ['/SC', 'ONLOGON'];
  if (kind === 'once') {
    const d = spec.date || new Date().toISOString().slice(0, 10).replace(/-/g, '/');
    return ['/SC', 'ONCE', '/ST', at, '/SD', d];
  }
  return ['/SC', 'DAILY', '/ST', at];
}

/** 注册前纯校验：返回错误消息（中文、可操作）或 null。once 任务时刻已过时 schtasks 只会报系统错误，这里提前拦下 */
export function validateSpec(spec, now = new Date()) {
  const kind = String((spec && spec.frequency) || 'daily').toLowerCase();
  if (kind !== 'once') return null;
  const dateStr = String(spec.date || formatDate(now, 'YYYY/MM/DD')).trim();
  const atStr = String(spec.at || '09:00').trim();
  const dm = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/.exec(dateStr);   // schtasks /SD 只认 YYYY/MM/DD
  const tm = /^(\d{1,2}):(\d{1,2})$/.exec(atStr);
  if (!dm) return 'once 任务的 date 格式应为 YYYY/MM/DD（收到 "' + dateStr + '"）';
  if (!tm) return 'once 任务的 at 格式应为 HH:mm（收到 "' + atStr + '"）';
  const when = new Date(Number(dm[1]), Number(dm[2]) - 1, Number(dm[3]), Number(tm[1]), Number(tm[2]));
  if (Number.isNaN(when.getTime())) return 'once 任务的日期/时刻无法解析：' + dateStr + ' ' + atStr;
  if (when.getTime() <= now.getTime()) {
    return 'once 任务的时刻（' + dateStr + ' ' + atStr + '）已经过去，请指定将来的日期或时刻（不传 date 默认用今天）';
  }
  return null;
}

/** 注册（或覆盖）一个定时任务 */
export async function addSchedule(flowId, spec = {}) {
  ensureDirs();
  const invalid = validateSpec(spec);
  if (invalid) return { ok: false, task: taskName(flowId), error: invalid, stderr: invalid, schedule: spec };
  const wrapper = writeWrapper(flowId, spec);
  const name = taskName(flowId);
  const del = await runSchtasks(['/Delete', '/TN', name, '/F']);
  const args = ['/Create', '/TN', name, '/TR', '"' + wrapper + '"', ...buildScheduleArgs(spec), '/F'];
  const res = await runSchtasks(args);
  const index = loadIndex();
  index[flowId] = {
    flowId, task: name, wrapper, spec,
    createdAt: new Date().toISOString(), ok: res.ok,
    priorDeleteOutput: del.ok ? '' : del.err,
    lastOutput: res.ok ? res.out : res.err,
  };
  saveIndex(index);
  L.info('定时注册结果', { flowId, ok: res.ok });
  return { ok: res.ok, task: name, wrapper, schedule: spec, stdout: res.out, stderr: res.err };
}

export async function removeSchedule(flowId) {
  const name = taskName(flowId);
  const res = await runSchtasks(['/Delete', '/TN', name, '/F']);
  const index = loadIndex();
  delete index[flowId];
  saveIndex(index);
  return { ok: res.ok, task: name, stdout: res.out, stderr: res.err };
}

export async function runScheduleNow(flowId) {
  const name = taskName(flowId);
  const res = await runSchtasks(['/Run', '/TN', name]);
  return { ok: res.ok, task: name, stdout: res.out, stderr: res.err };
}

export async function queryTask(flowId) {
  const name = taskName(flowId);
  const res = await runSchtasks(['/Query', '/TN', name, '/FO', 'LIST', '/V']);
  if (!res.ok) return { exists: false, task: name, error: res.err };
  const fields = {};
  for (const line of res.out.split(/\r?\n/)) {
    const m = /^([^:]+):\s*(.*)$/.exec(line);
    if (m) fields[m[1].trim()] = m[2].trim();
  }
  const pick = (...keys) => {
    for (const k of keys) if (fields[k] !== undefined) return fields[k];
    return null;
  };
  // schtasks 的字段名随系统语言变化；取不到时退回用我们自己的运行记录与日志判断
  const logFile = path.join(DIRS.logs, 'schedule-' + flowId + '.log');
  let logMtime = null;
  let logTail = null;
  try {
    if (fs.existsSync(logFile)) {
      logMtime = fs.statSync(logFile).mtime.toISOString();
      logTail = fs.readFileSync(logFile, 'utf8').trim().split(/\r?\n/).slice(-6).join('\n').slice(0, 600);
    }
  } catch { /* ignore */ }

  const rec = loadIndex()[flowId] || {};
  let lastRunFromHistory = null;
  try {
    const { listRuns } = await import('./store.mjs');
    const runs = listRuns(flowId, 5).filter((r) => r.trigger === 'schedule' || r.trigger === 'cli');
    if (runs.length) lastRunFromHistory = runs[0];
  } catch { /* ignore */ }

  return {
    exists: true, task: name,
    status: pick('Status', '状态', '计划任务状态'),
    nextRun: pick('Next Run Time', '下次运行时间'),
    lastRun: pick('Last Run Time', '上次运行时间'),
    lastResult: pick('Last Result', '上次结果'),
    schedule: pick('Schedule Type', '计划类型') || (rec.spec ? JSON.stringify(rec.spec) : null),
    logFile: fs.existsSync(logFile) ? logFile : null,
    logMtime,
    logTail,
    lastRunFromHistory,
    raw: res.out.slice(0, 800),
  };
}

/** 汇总：登记表 + 系统实际状态 */
export async function listSchedules() {
  const index = loadIndex();
  const out = [];
  for (const flowId of Object.keys(index)) {
    const rec = index[flowId];
    const q = await queryTask(flowId);
    out.push({
      flowId, task: rec.task, spec: rec.spec, wrapper: rec.wrapper,
      exists: q.exists, status: q.status || null, nextRun: q.nextRun || null,
      lastRun: q.lastRun || null, lastResult: q.lastResult || null,
    });
  }
  return out;
}

export function isWindows() { return process.platform === 'win32'; }
