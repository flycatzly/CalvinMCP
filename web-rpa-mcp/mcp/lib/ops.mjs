// web-rpa-mcp — 无人值守运维：并发锁 / 中断检测 / 运行留存清理 / 跨流程总览
import fs from 'node:fs';
import path from 'node:path';
import { DIRS, ensureDirs, readConfig, readJson, writeJson, logger, nowIso, assertSafeId, pidAlive } from './core.mjs';
import { listFlows, listRuns, listRunsEx, runsFlowRoot, enumerateRuns, dropRunIndexEntries } from './store.mjs';
import { outboxInfo } from './notify.mjs';

const L = logger('ops');

/* ---------------- 并发锁 ----------------
   定时任务与手工一键运行可能撞在一起：同一流程并发执行会重复提交业务数据。
   用一个带 pid 的锁文件挡住第二次执行，并自动清理超过 6 小时的过期锁。 */

const STALE_MS = 6 * 3600 * 1000;
export const heldLocks = new Set();

function lockFile(flowId) {
  const p = path.join(DIRS.work, 'locks', assertSafeId(flowId, '流程 id') + '.lock');
  if (!path.resolve(p).startsWith(path.resolve(path.join(DIRS.work, 'locks')) + path.sep)) throw new Error('流程 id 不合法（越出锁目录）: ' + String(flowId).slice(0, 40));
  return p;
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
  const f = lockFile(flowId);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  // 原子创建（'wx'：文件已存在则报 EEXIST）：定时任务与手工运行同一毫秒撞上来时，
  // "先检查再覆盖写"存在竞态窗口，两个进程都可能认为自己拿到了锁；独占创建只有一个赢家。
  for (let attempt = 0; attempt < 2; attempt++) {
    const cur = lockInfo(flowId);
    if (cur.held) return { ok: false, heldBy: cur };
    if (cur.stale) {
      L.warn('清理过期锁后重试', { flowId, pid: cur.pid, ageMs: cur.ageMs });
      try { fs.unlinkSync(f); } catch { /* 已被别人清掉，直接尝试创建 */ }
    }
    const rec = Object.assign({ flowId, pid: process.pid, at: nowIso() }, meta);
    try {
      const fd = fs.openSync(f, 'wx');
      fs.writeFileSync(fd, JSON.stringify(rec, null, 2), 'utf8');
      fs.closeSync(fd);
      heldLocks.add(flowId);
      return { ok: true };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      // 撞上别人刚建好的锁：回到循环头重新判断它是否有效（无效则清掉重建，最多再试一轮）
    }
  }
  return { ok: false, heldBy: lockInfo(flowId) };
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

export function runningMarkerPath(flowId, stamp) { return path.join(runsFlowRoot(flowId), assertSafeId(stamp, '运行标识'), 'running.json'); }

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

/** 扫描"有开始标记但没有报告"的执行，按标记里的 pid 分活/死两类。
   pid 活着 = 进行中（正在跑或正在等人工），死了才是真中断（强杀/断电/崩溃）。
   此前不判活性、一律报"中断"——任何进行中的运行都会被 status_report 误报"进程可能被强杀"。 */
function scanActiveMarkers(flowId) {
  const { base, dirs, entries } = enumerateRuns(flowId);
  let live = null, dead = null;
  for (const d of dirs) {
    // 已进索引 = 已有报告，running.json 早被收尾清掉——跳过即免掉每目录 3 次 stat。
    // 探针实锤：400 次运行的流程，旧实现无活进程时全目录扫一遍要 23ms（interrupted+live 各一次）
    if (entries.has(d)) continue;
    const marker = path.join(base, d, 'running.json');
    const report = path.join(base, d, 'report.json');
    if (fs.existsSync(marker) && !fs.existsSync(report)) {
      const rec = Object.assign({ stamp: d }, readJson(marker, {}) || {});
      const alive = pidAlive(rec.pid);
      if (alive && !live) live = rec;
      if (!alive && !dead) dead = rec;
      if (live && dead) break;
    }
  }
  return { live, dead };
}

/** 最近一次真中断（有开始标记、没有报告、且标记里的 pid 已死） */
export function interruptedRun(flowId) { return scanActiveMarkers(flowId).dead; }

/** 进行中的运行（有开始标记、没有报告、且标记里的 pid 还活着）——"在等人工"也在这里（marker.waitingHuman） */
export function liveRunInfo(flowId) { return scanActiveMarkers(flowId).live; }

/* ---------------- 运行留存 ----------------
   无人值守跑久了 runs/ 会无限增长，必须有上限与天龄双约束。 */

export function pruneRuns(flowId, opts = {}) {
  const cfg = readConfig();
  const outer = opts || {};
  // 显式只给一个留存维度时，另一维度按 0（不限）参与判定：调用方意图是"按我给的这条规则清"。
  // 若把配置默认值（50 次/30 天）隐式并进"两者都设"的 AND 规则，会出现
  // "只传 keepCount:1 却一条不删"的静默空跑（配置天龄在场导致 beyondCount && tooOld 恒假）。
  // 两个维度都显式给 -> AND 规则；都不给 -> 配置双约束（既有语义不变）。
  const explicitCount = outer.keepCount !== undefined;
  const explicitDays = outer.keepDays !== undefined;
  const keepCount = explicitCount ? (Number(outer.keepCount) || 0)
    : (explicitDays ? 0 : Number(cfg.run.keepRunsPerFlow) || 0);
  const keepDays = explicitDays ? (Number(outer.keepDays) || 0)
    : (explicitCount ? 0 : Number(cfg.run.keepRunDays) || 0);
  const keepVideos = outer.keepVideos === undefined ? Number(cfg.run.keepVideosPerFlow) || 0 : Number(outer.keepVideos);
  const dryRun = !!outer.dryRun;
  const base = runsFlowRoot(flowId);
  if (!fs.existsSync(base)) {
    return { flowId, total: 0, kept: 0, removed: [], dryRun, keepCount, keepDays, keepVideos, videosRemoved: 0, videosKept: 0 };
  }
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
  const keptDirs = [];
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
    if (!del) { keptDirs.push(d); continue; }
    removed.push(d);
    if (!dryRun) {
      try { fs.rmSync(path.join(base, d), { recursive: true, force: true }); }
      catch (e) { L.warn('删除运行记录失败', { flowId, stamp: d, err: String(e && e.message ? e.message : e) }); }
    }
  }
  // 索引同步裁掉已删运行的条目（dryRun 不动盘也不动索引）——不裁则下次读按幽灵条目整段重建
  if (!dryRun && removed.length) dropRunIndexEntries(flowId, removed);

  // 录像磁盘治理：留下的运行记录里，录像（.webm）按 mtime 只留最近 keepVideos 段（0=不限）。
  // 录像比报告/截图大一个量级，是 runs/ 膨胀的主因；只动 .webm，报告与截图永不误删。
  let videosRemoved = 0;
  let videosKept = 0;
  if (keepVideos > 0) {
    const vids = [];
    for (const d of keptDirs) {
      const vdir = path.join(base, d, 'videos');
      let files = [];
      try { files = fs.readdirSync(vdir); } catch { continue; }
      for (const f of files) {
        if (!/\.webm$/i.test(f)) continue;
        const p = path.join(vdir, f);
        try { vids.push({ p, mtime: fs.statSync(p).mtime.getTime() }); } catch { /* ignore */ }
      }
    }
    vids.sort((a, b) => a.mtime - b.mtime); // 最旧在前
    const over = Math.max(0, vids.length - keepVideos);
    for (let i = 0; i < over; i++) {
      videosRemoved++;
      if (!dryRun) {
        try { fs.rmSync(vids[i].p); }
        catch (e) { L.warn('删除录像失败', { flowId, file: vids[i].p, err: String(e && e.message ? e.message : e) }); }
      }
    }
    videosKept = vids.length - over;
  }

  return { flowId, total, kept: total - removed.length, removed, dryRun, keepCount, keepDays, keepVideos, videosRemoved, videosKept };
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
 * 由定时 spec 推出"正常应该多久跑一次"（小时）；once/logon 这类无固定间隔的返回 null。
 * 判"多久没跑算异常"用 interval*1.5 + 1h 宽限，比一刀切 30 小时准：
 * 分钟级任务坏一整天没人管是事故，每天级任务又会天天误报。
 */
export function scheduleIntervalHours(spec) {
  const kind = String((spec && spec.frequency) || 'daily').toLowerCase();
  if (kind === 'minute') return Math.max(1, Number(spec.everyMinutes) || 30) / 60;
  if (kind === 'hourly') return Math.max(1, Number(spec.everyHours) || 1);
  if (kind === 'daily') return 24;
  if (kind === 'weekly') return 24 * 7;
  if (kind === 'monthly') return 24 * 30;
  return null;
}

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
    const { runs, total } = listRunsEx(f.id, 100);
    const last = runs[0] || null;
    // 连续失败只数「已定论的失败」（fail/blocked）；pass 即止。
    // running（未定论）与 interrupted（崩溃另计，item.interrupted 已单列）既不计失败、也不打断计数——
    // 否则"正在跑的那次"或"崩溃那次"会被当成一次失败，虚增连续失败数、误报"连续失败 N 次"告警（探针实锤）。
    let consecutiveFailures = 0;
    for (const r of runs) {
      if (r.status === 'pass') break;
      if (r.status === 'running' || r.status === 'interrupted') continue;
      consecutiveFailures++;
    }
    const healedTotal = runs.reduce((s, r) => s + (Number(r.healedCount) || 0), 0);
    const lock = lockInfo(f.id);
    const scan = scanActiveMarkers(f.id); // 一次扫描同时拿活/死，别扫两遍
    const interrupted = scan.dead;
    const live = scan.live;
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
      totalRuns: total,
      healedTotal,
      stepCount: f.stepCount,
      running: lock.held ? { pid: lock.pid, since: lock.at, trigger: lock.trigger } : (live ? { pid: live.pid, since: live.startedAt, trigger: live.trigger } : null),
      waitingHuman: live && live.waitingHuman ? live.waitingHuman : null,
      interrupted: interrupted ? { stamp: interrupted.stamp, startedAt: interrupted.startedAt, pid: interrupted.pid } : null,
      scheduled: s ? s.spec : null,
    };
    items.push(item);

    if (!last) problems.push({ flowId: f.id, level: 'warn', message: '从未执行过' });
    else if (last.status === 'fail') problems.push({ flowId: f.id, level: 'error', message: '最近一次失败：' + (item.lastError || '(无详情)') });
    else if (last.status === 'blocked') problems.push({ flowId: f.id, level: 'warn', message: '最近一次被阻断：' + (item.lastError || '(无详情)') });
    if (consecutiveFailures >= 3) problems.push({ flowId: f.id, level: 'error', message: '连续失败 ' + consecutiveFailures + ' 次' });
    if (item.waitingHuman) problems.push({ flowId: f.id, level: 'warn', message: '正在等待人工接管：' + (item.waitingHuman.reason || '需要人工') + (item.waitingHuman.until ? '（截止 ' + item.waitingHuman.until + '）' : '') });
    if (interrupted) problems.push({ flowId: f.id, level: 'error', message: '存在中断的执行（' + interrupted.stamp + '）：进程可能被强杀或断电' });
    if (lock.held || (live && !item.waitingHuman)) problems.push({ flowId: f.id, level: 'info', message: '正在执行中（pid ' + (lock.held ? lock.pid : live.pid) + '）' });
    if (s && last && item.lastAgeHours !== null) {
      const intervalHours = scheduleIntervalHours(s.spec);
      item.scheduleIntervalHours = intervalHours;
      if (intervalHours !== null) {
        const expect = intervalHours * 1.5 + 1;
        if (item.lastAgeHours > expect && item.lastStatus !== null) {
          problems.push({ flowId: f.id, level: 'warn', message: '已配置定时（约 ' + intervalHours + ' 小时一次）但 ' + item.lastAgeHours + ' 小时没有新执行记录' });
        }
      }
    }
  }

  // 告警发件箱滞留是"失败链路最后一环断了"的信号：积压越久越要被无人值守视图点名
  const ob = outboxInfo();
  if (ob.count > 0) {
    problems.push({
      flowId: 'notify-outbox',
      level: ob.oldestAgeHours !== null && ob.oldestAgeHours >= 24 ? 'error' : 'warn',
      message: '发件箱积压 ' + ob.count + ' 条告警未发出（最旧 ' + (ob.oldestAgeHours === null ? '?' : ob.oldestAgeHours) + ' 小时）：告警链路可能断了，积压在 .work/notify-outbox.json，下次任意告警发送成功前会按序补发',
    });
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
      waitingHuman: items.filter((i) => i.waitingHuman).length,
      notifyOutbox: ob.count,
      notifyOutboxOldestAgeHours: ob.oldestAgeHours,
    },
    problems: opts.onlyProblems ? undefined : problems,
    items: opts.onlyProblems ? items.filter((i) => i.lastStatus !== 'pass' || i.interrupted || i.running || i.waitingHuman) : items,
    conclusion: problems.length
      ? '发现 ' + problems.length + ' 条需要关注：' + problems.filter((p) => p.level !== 'info').map((p) => p.flowId).join('、')
      : '全部流程最近一次执行正常',
  };
}
