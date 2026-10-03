// web-rpa-mcp — 无人值守运维：并发锁 / 中断检测 / 运行留存清理 / 跨流程总览
import fs from 'node:fs';
import path from 'node:path';
import { DIRS, ensureDirs, readConfig, readJson, writeJson, logger, nowIso } from './core.mjs';
import { listFlows, listRuns } from './store.mjs';

const L = logger('ops');

/* ---------------- 并发锁 ----------------
   定时任务与手工一键运行可能撞在一起：同一流程并发执行会重复提交业务数据。
   用一个带 pid 的锁文件挡住第二次执行，并自动清理超过 6 小时的过期锁。 */

const STALE_MS = 6 * 3600 * 1000;
export const heldLocks = new Set();

function lockFile(flowId) { return path.join(DIRS.work, 'locks', flowId + '.lock'); }

function pidAlive(pid) {
  if (!pid || pid === process.pid) return pid === process.pid;
  try { process.kill(pid, 0); return true; }
  catch (e) { return !!(e && e.code === 'EPERM'); }
}

export function lockInfo(flowId) {
  const f = lockFile(flowId);
  if (!fs.existsSync(f)) return { held: false };
  const rec = readJson(f, null);
  if (!rec) return { held: false };
  const ageMs = Date.now() - new Date(rec.at || 0).getTime();
  const alive = pidAlive(rec.pid);
  const stale = !alive || ageMs > STALE_MS;
  return { held: !stale, stale, flowId, pid: rec.pid, at: rec.at, stamp: rec.stamp, trigger: rec.trigger, ageMs };
}

export function acquireLock(flowId, meta = {}) {
  ensureDirs();
  fs.mkdirSync(path.dirname(lockFile(flowId)), { recursive: true });
  const cur = lockInfo(flowId);
  if (cur.held) return { ok: false, heldBy: cur };
  if (cur.stale) L.warn('清理过期锁后重试', { flowId, pid: cur.pid, ageMs: cur.ageMs });
  writeJson(lockFile(flowId), Object.assign({ flowId, pid: process.pid, at: nowIso() }, meta));
  heldLocks.add(flowId);
  return { ok: true };
}

export function releaseLock(flowId) {
  heldLocks.delete(flowId);
  const f = lockFile(flowId);
  try {
    if (!fs.existsSync(f)) return false;
    const rec = readJson(f, null);
    // 只释放自己持有的锁，避免误删别人的
    if (!rec || rec.pid === process.pid) { fs.unlinkSync(f); return true; }
  } catch (e) { L.warn('释放锁失败', { flowId, err: String(e && e.message ? e.message : e) }); }
  return false;
}

export function releaseAllLocks() {
  for (const id of [...heldLocks]) { try { releaseLock(id); } catch { /* ignore */ } }
}

/* ---------------- 中断检测 ----------------
   硬崩（被 kill / 断电）时来不及写报告，只剩一个 running.json。
   把这种情况显式暴露出来，否则"定时任务静默没跑"根本无从发现。 */

export function runningMarkerPath(flowId, stamp) { return path.join(DIRS.runs, flowId, stamp, 'running.json'); }

export function writeRunningMarker(flowId, stamp, info = {}) {
  const p = runningMarkerPath(flowId, stamp);
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(Object.assign({ flowId, stamp, pid: process.pid, startedAt: nowIso() }, info), null, 2), 'utf8');
    return true;
  } catch (e) { L.warn('写入运行标记失败', { err: String(e && e.message ? e.message : e) }); return false; }
}

export function clearRunningMarker(flowId, stamp) {
  try { fs.unlinkSync(runningMarkerPath(flowId, stamp)); } catch { /* ignore */ }
}

/** 找出最近一次"有开始标记但没有报告"的执行 */
export function interruptedRun(flowId) {
  const base = path.join(DIRS.runs, flowId);
  if (!fs.existsSync(base)) return null;
  const dirs = fs.readdirSync(base).filter((d) => {
    try { return fs.statSync(path.join(base, d)).isDirectory(); } catch { return false; }
  }).sort().reverse();
  for (const d of dirs) {
    const marker = path.join(base, d, 'running.json');
    const report = path.join(base, d, 'report.json');
    if (fs.existsSync(marker) && !fs.existsSync(report)) {
      return Object.assign({ stamp: d }, readJson(marker, {}) || {});
    }
  }
  return null;
}

/* ---------------- 运行留存 ----------------
   无人值守跑久了 runs/ 会无限增长，必须有上限与天龄双约束。 */

export function pruneRuns(flowId, opts = {}) {
  const cfg = readConfig();
  const outer = opts || {};
  const keepCount = outer.keepCount === undefined ? Number(cfg.run.keepRunsPerFlow) || 0 : Number(outer.keepCount);
  const keepDays = outer.keepDays === undefined ? Number(cfg.run.keepRunDays) || 0 : Number(outer.keepDays);
  const dryRun = !!outer.dryRun;
  const base = path.join(DIRS.runs, flowId);
  if (!fs.existsSync(base)) return { flowId, total: 0, kept: 0, removed: [], dryRun };
  const dirs = fs.readdirSync(base).filter((d) => {
    try { return fs.statSync(path.join(base, d)).isDirectory(); } catch { return false; }
  }).sort();
  const total = dirs.length;
  // 规则（明确可预测）：
  //   只设次数 -> 保留最新 N 次，其余全删
  //   只设天龄 -> 保留 N 天内，其余全删
  //   两者都设 -> 保留最新 N 次；超出部分还需"超过 N 天"才删（不失控也不误删近期）
  //   都不设   -> 不清理
  const countCut = keepCount > 0 ? Math.max(0, total - keepCount) : 0;
  const removed = [];
  const ageOf = (d) => {
    try { return (Date.now() - fs.statSync(path.join(base, d)).mtime.getTime()) / 86400000; }
    catch { return 0; }
  };
  for (let i = 0; i < total; i++) {
    const d = dirs[i];
    const beyondCount = keepCount > 0 && i < countCut;
    const tooOld = keepDays > 0 && ageOf(d) > keepDays;
    let del = false;
    if (keepCount > 0 && keepDays > 0) del = beyondCount && tooOld;
    else if (keepCount > 0) del = beyondCount;
    else if (keepDays > 0) del = tooOld;
    if (!del) continue;
    removed.push(d);
    if (!dryRun) {
      try { fs.rmSync(path.join(base, d), { recursive: true, force: true }); }
      catch (e) { L.warn('删除运行记录失败', { flowId, stamp: d, err: String(e && e.message ? e.message : e) }); }
    }
  }
  return { flowId, total, kept: total - removed.length, removed, dryRun, keepCount, keepDays };
}

export function pruneAllRuns(opts = {}) {
  return listFlows().map((f) => pruneRuns(f.id, opts));
}

export function pruneLogs(opts = {}) {
  const keepDays = opts.keepDays === undefined ? Number(readConfig().run.keepRunDays) || 30 : Number(opts.keepDays);
  const dryRun = !!opts.dryRun;
  if (!fs.existsSync(DIRS.logs)) return { total: 0, kept: 0, removed: [], dryRun };
  const files = fs.readdirSync(DIRS.logs);
  const removed = [];
  for (const f of files) {
    const p = path.join(DIRS.logs, f);
    let st = null;
    try { st = fs.statSync(p); } catch { continue; }
    if (!st.isFile()) continue;
    const ageDays = (Date.now() - st.mtime.getTime()) / 86400000;
    if (ageDays > keepDays) {
      removed.push(f);
      if (!dryRun) { try { fs.unlinkSync(p); } catch { /* ignore */ } }
    }
  }
  return { total: files.length, kept: files.length - removed.length, removed, dryRun, keepDays };
}

/* ---------------- 跨流程总览 ---------------- */

function scheduleIndex() { return readJson(path.join(DIRS.work, 'sched', 'index.json'), {}) || {}; }

/**
 * 无人值守时真正需要的那个视图：只看"有没有问题"。
 * 返回每个流程的最后状态、连续失败次数、是否中断/正在跑、自愈趋势、定时配置。
 */
export function statusReport(opts = {}) {
  const flows = listFlows();
  const sched = scheduleIndex();
  const items = [];
  const problems = [];
  const now = Date.now();

  for (const f of flows) {
    const runs = listRuns(f.id, 100);
    const last = runs[0] || null;
    let consecutiveFailures = 0;
    for (const r of runs) {
      if (r.status === 'pass') break;
      consecutiveFailures++;
    }
    const healedTotal = runs.reduce((s, r) => s + (Number(r.healedCount) || 0), 0);
    const lock = lockInfo(f.id);
    const interrupted = interruptedRun(f.id);
    const s = sched[f.id] || null;
    const item = {
      flowId: f.id,
      name: f.name,
      lastStatus: last ? last.status : null,
      lastRunAt: last ? last.startedAt : null,
      lastAgeHours: last && last.startedAt ? Number(((now - new Date(last.startedAt).getTime()) / 3600000).toFixed(1)) : null,
      lastTrigger: last ? last.trigger : null,
      lastError: last ? (last.error ? String(last.error).split('\n')[0].slice(0, 200) : null) : null,
      consecutiveFailures,
      totalRuns: runs.length,
      healedTotal,
      stepCount: f.stepCount,
      running: lock.held ? { pid: lock.pid, since: lock.at, trigger: lock.trigger } : null,
      interrupted: interrupted ? { stamp: interrupted.stamp, startedAt: interrupted.startedAt, pid: interrupted.pid } : null,
      scheduled: s ? s.spec : null,
    };
    items.push(item);

    if (!last) problems.push({ flowId: f.id, level: 'warn', message: '从未执行过' });
    else if (last.status === 'fail') problems.push({ flowId: f.id, level: 'error', message: '最近一次失败：' + (item.lastError || '(无详情)') });
    else if (last.status === 'blocked') problems.push({ flowId: f.id, level: 'warn', message: '最近一次被阻断：' + (item.lastError || '(无详情)') });
    if (consecutiveFailures >= 3) problems.push({ flowId: f.id, level: 'error', message: '连续失败 ' + consecutiveFailures + ' 次' });
    if (interrupted) problems.push({ flowId: f.id, level: 'error', message: '存在中断的执行（' + interrupted.stamp + '）：进程可能被强杀或断电' });
    if (lock.held) problems.push({ flowId: f.id, level: 'info', message: '正在执行中（pid ' + lock.pid + '）' });
    if (s && last && item.lastAgeHours !== null) {
      const expect = /minute/i.test(JSON.stringify(s.spec)) ? 1 : 30;   // 粗略：超过 30 小时没跑过就值得看
      if (item.lastAgeHours > expect && item.lastStatus !== null) {
        problems.push({ flowId: f.id, level: 'warn', message: '已配置定时但 ' + item.lastAgeHours + ' 小时没有新执行记录' });
      }
    }
  }

  const ok = items.filter((i) => i.lastStatus === 'pass' && !i.interrupted).length;
  const bad = items.filter((i) => i.lastStatus === 'fail' || i.lastStatus === 'blocked' || i.interrupted).length;
  return {
    generatedAt: nowIso(),
    summary: {
      flows: items.length,
      healthy: ok,
      problematic: bad,
      neverRun: items.filter((i) => !i.lastStatus).length,
      scheduled: items.filter((i) => i.scheduled).length,
      running: items.filter((i) => i.running).length,
    },
    problems: opts.onlyProblems ? undefined : problems,
    items: opts.onlyProblems ? items.filter((i) => i.lastStatus !== 'pass' || i.interrupted || i.running) : items,
    conclusion: problems.length
      ? '发现 ' + problems.length + ' 条需要关注：' + problems.filter((p) => p.level !== 'info').map((p) => p.flowId).join('、')
      : '全部流程最近一次执行正常',
  };
}
