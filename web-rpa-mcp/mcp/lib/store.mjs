// web-rpa-mcp — 流程与运行的持久化 + 步骤人类可读渲染
import fs from 'node:fs';
import path from 'node:path';
import { DIRS, ensureDirs, readJson, writeJson, slugify, shortId, stampId, nowIso, logger, assertSafeId, pidAlive } from './core.mjs';

const L = logger('store');

export const FLOW_VERSION = 1;

export function flowPath(id) {
  const p = path.join(DIRS.flows, assertSafeId(id, '流程 id') + '.json');
  // 双闸：字符规则之外再复核结果确实落在 flows/ 内，防规则盲区
  if (!path.resolve(p).startsWith(path.resolve(DIRS.flows) + path.sep)) throw new Error('流程 id 不合法（越出流程目录）: ' + String(id).slice(0, 40));
  return p;
}

/** 由名字生成稳定且唯一的流程 id */
export function newFlowId(name) {
  const base = slugify(name, 'flow');
  if (!fs.existsSync(flowPath(base))) return base;
  return base + '-' + shortId();
}

export function listFlows() {
  ensureDirs();
  const out = [];
  for (const f of fs.readdirSync(DIRS.flows)) {
    if (!f.endsWith('.json')) continue;
    const flow = readJson(path.join(DIRS.flows, f));
    if (!flow || !flow.id) continue;
    out.push({
      id: flow.id,
      name: flow.name || flow.id,
      stepCount: (flow.steps || []).length,
      paramCount: (flow.params || []).length,
      assertionCount: (flow.assertions || []).length,
      startUrl: flow.startUrl || null,
      updatedAt: flow.updatedAt || null,
      locked: !!flow.locked,
    });
  }
  out.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  return out;
}

export function loadFlow(id) {
  const p = flowPath(id);
  if (!fs.existsSync(p)) return null;
  return readJson(p);
}

export function saveFlow(flow) {
  if (!flow || !flow.id) throw new Error('流程缺少 id');
  const next = { ...flow, version: flow.version || FLOW_VERSION, updatedAt: nowIso() };
  writeJson(flowPath(next.id), next);
  L.info('已保存流程', { id: next.id, steps: (next.steps || []).length });
  return next;
}

export function deleteFlow(id) {
  const p = flowPath(id);
  if (!fs.existsSync(p)) return false;
  fs.unlinkSync(p);
  return true;
}

export function requireFlow(id) {
  const f = loadFlow(id);
  if (!f) throw new Error('流程不存在: ' + id + '（用 flow_list 查看可用流程）');
  return f;
}

/* ---------------- 流程备份与回滚 ----------------
   片段重录/批量修改会覆盖流程定义，动手之前先留一份，出问题能一键回退。 */

export function backupRoot() { return path.join(DIRS.work, 'backups'); }

export function backupFlow(id, keep = 10) {
  const src = flowPath(id);
  if (!fs.existsSync(src)) return null;
  const dir = backupRoot();
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, id + '.' + stampId() + '.json');
  fs.copyFileSync(src, dest);
  try {
    const files = fs.readdirSync(dir).filter((f) => f.indexOf(id + '.') === 0).sort();
    const maxAgeMs = 30 * 24 * 3600 * 1000;   // 备份最多保留 30 天：长期高频改动的流程不会把 .work/backups 撑爆
    const doomed = files.filter((f, i) => {
      if (i < files.length - keep) return true;
      try { return Date.now() - fs.statSync(path.join(dir, f)).mtimeMs > maxAgeMs; } catch { return false; }
    });
    for (const old of doomed) {
      try { fs.unlinkSync(path.join(dir, old)); } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
  L.info('已备份流程', { id, dest });
  return dest;
}

export function listBackups(id) {
  const dir = backupRoot();
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.indexOf(id + '.') === 0)
    .sort()
    .reverse()
    .map((f) => ({ file: path.join(dir, f), at: f.slice(id.length + 1).replace(/\.json$/, '') }));
}

/** 回滚到最近一次（或指定一次）备份 */
export function restoreFlow(id, which) {
  const list = listBackups(id);
  if (!list.length) return { ok: false, error: '还没有任何备份可供回滚（备份在改动流程时自动生成）' };
  const pick = which ? (list.find((x) => x.file === which || x.at === which) || null) : list[0];
  if (!pick) return { ok: false, error: '找不到该备份: ' + which, available: list.slice(0, 5) };
  const data = readJson(pick.file);
  if (!data || !Array.isArray(data.steps)) return { ok: false, error: '备份文件内容不合法: ' + pick.file };
  const saved = saveFlow(Object.assign({}, data, { id, restoredFrom: pick.file }));
  return { ok: true, restoredFrom: pick.file, stepCount: (saved.steps || []).length, flow: saved };
}

/* ---------------- 运行记录 ---------------- */

/** 某流程的运行根目录（runs/<flowId>）——runs 侧所有拼接统一走这里，杜绝 flowId/stamp 路径穿越 */
export function runsFlowRoot(flowId) {
  const p = path.join(DIRS.runs, assertSafeId(flowId, '流程 id'));
  if (!path.resolve(p).startsWith(path.resolve(DIRS.runs) + path.sep)) throw new Error('流程 id 不合法（越出运行目录）: ' + String(flowId).slice(0, 40));
  return p;
}

export function runDir(flowId, stamp) { return path.join(runsFlowRoot(flowId), assertSafeId(stamp, '运行标识')); }

export function saveRun(report) {
  const dir = runDir(report.flowId, report.stamp);
  writeJson(path.join(dir, 'report.json'), report);
  const base = runsFlowRoot(report.flowId);
  try {
    writeJson(path.join(base, 'latest.json'), {
      stamp: report.stamp, status: report.status, startedAt: report.startedAt,
      durationMs: report.durationMs, error: report.error || null,
    });
  } catch { /* ignore */ }
  // 运行摘要索引随报告同步落盘；索引失败只影响性能（读侧自愈重建），绝不影响证据
  try {
    const map = readIndexMap(base);
    const runs = map ? [...map.values()] : [];
    const e = runSummary(report);
    const i = runs.findIndex((r) => r.stamp === e.stamp);
    if (i >= 0) runs[i] = e; else runs.push(e);
    runs.sort((a, b) => (String(a.stamp) < String(b.stamp) ? -1 : String(a.stamp) > String(b.stamp) ? 1 : 0));
    writeJson(path.join(base, 'index.json'), { version: RUN_INDEX_VERSION, updated: nowIso(), runs });
  } catch { /* ignore */ }
  return path.join(dir, 'report.json');
}

/* ---------------- 运行索引（runs/<flowId>/index.json） ----------------
   旧 listRuns 逐个 readJson 每次运行的 report.json（完整报告含步骤明细，可达几百 KB），
   无人值守总览 statusReport 对每个流程都来一遍——运行越多越慢（探针实锤：400 次运行时
   仅 listRuns(100) 就 5.5ms/次，marker 全目录扫描再 23ms）。
   索引把运行摘要在 saveRun 时顺手记下来，读侧一次 readJson 拿全部摘要。
   索引只是 report.json 的投影缓存，证据源永远是报告本身；外部直写/删除运行目录后，
   读侧按「目录有报告却不在索引 / 索引条目无目录」两个集合差自愈重建——宁可多读一遍，
   不可长期说谎。 */
const RUN_INDEX_VERSION = 2;

function runIndexPath(base) { return path.join(base, 'index.json'); }

/** report → listRuns 摘要（索引投影与直接读报告共用同一口径，字段/缺省值必须逐个一致） */
function runSummary(rep) {
  return {
    stamp: rep.stamp, status: rep.status, startedAt: rep.startedAt,
    durationMs: rep.durationMs, trigger: rep.trigger || 'manual',
    healedCount: (rep.healed || []).length, failedStep: rep.failedStep || null,
    error: rep.error || null,
    // 预算可观测投影（v2）：status_report 聚合"经常性越线"用；旧报告没有这些字段=undefined，聚合口径天然不计
    timedOut: !!rep.timedOut,
    maxDurationMs: rep.maxDurationMs || null,
    budgetOverrunMs: typeof rep.budgetOverrunMs === 'number' ? rep.budgetOverrunMs : null,
  };
}

/** 读索引 → Map<stamp, 摘要>；缺/坏/版本不符返回 null（触发重建） */
function readIndexMap(base) {
  const idx = readJson(runIndexPath(base));
  if (!idx || idx.version !== RUN_INDEX_VERSION || !Array.isArray(idx.runs)) return null;
  const m = new Map();
  for (const e of idx.runs) if (e && e.stamp) m.set(String(e.stamp), e);
  return m;
}

/** 全量重建索引：扫运行目录、读 report.json、写 index.json。Map 的键用目录名
 *  （生产里目录名就是 stamp，runDir 由 report.stamp 拼出；键用目录名保证自愈判定不空转） */
function rebuildIndexMap(base, dirs) {
  const entries = new Map();
  const runs = [];
  for (const d of dirs) {
    const rep = readJson(path.join(base, d, 'report.json'));
    if (!rep) continue;
    const e = runSummary(rep);
    entries.set(d, e);
    runs.push(e);
  }
  runs.sort((a, b) => (String(a.stamp) < String(b.stamp) ? -1 : String(a.stamp) > String(b.stamp) ? 1 : 0));
  try { writeJson(runIndexPath(base), { version: RUN_INDEX_VERSION, updated: nowIso(), runs }); }
  catch { /* 索引写失败只影响性能，读侧下次再重建 */ }
  return entries;
}

/** 运行目录枚举 + 索引自愈。dirs=全部运行目录（新→旧，剔除 latest.json/index.json），
 *  entries=Map<目录名, 摘要>（只含已完成运行；进行中/中断的目录不在索引里，靠 running.json 判）。
 *  自愈触发器只有两个集合差：① 目录有 report.json 却不在索引（升级前存量/外部直写）；
 *  ② 索引条目无对应目录（外部删除）。其余情况零报告读取。 */
export function enumerateRuns(flowId) {
  const base = runsFlowRoot(flowId);
  if (!fs.existsSync(base)) return { base, dirs: [], entries: new Map() };
  let names = [];
  try { names = fs.readdirSync(base); } catch { return { base, dirs: [], entries: new Map() }; }
  const dirs = names.filter((d) => d !== 'latest.json' && d !== 'index.json').sort().reverse();
  let entries = readIndexMap(base);
  let heal = !entries;
  if (entries) {
    for (const d of dirs) {
      if (!entries.has(d) && fs.existsSync(path.join(base, d, 'report.json'))) { heal = true; break; }
    }
    if (!heal) {
      const set = new Set(dirs);
      for (const k of entries.keys()) if (!set.has(k)) { heal = true; break; }
    }
  }
  if (heal) entries = rebuildIndexMap(base, dirs);
  return { base, dirs, entries };
}

/** pruneRuns 删除运行目录后同步裁掉索引条目——不裁则下次读按"幽灵条目"整段重建，白读全部报告 */
export function dropRunIndexEntries(flowId, stamps) {
  if (!stamps || !stamps.length) return;
  try {
    const base = runsFlowRoot(flowId);
    const map = readIndexMap(base);
    if (!map) return;
    const drop = new Set(stamps.map(String));
    const runs = [...map.values()].filter((e) => !drop.has(String(e.stamp)));
    writeJson(runIndexPath(base), { version: RUN_INDEX_VERSION, updated: nowIso(), runs });
  } catch { /* ignore */ }
}

export function listRuns(flowId, limit = 20) {
  return listRunsEx(flowId, limit).runs;
}

/**
 * 单遍枚举同时给出窗口摘要、真实运行总数、全量自愈累计与全量连续失败数。
 * total=运行目录总数（一次 readdir 即得，含进行中/中断），不再被 limit 封顶——
 * 旧实现 statusReport 用 listRuns(100).length 当 totalRuns，超过 100 次就恒报 100（少报）。
 * healedTotal=全部已完成运行的 healedCount 之和，同样不许被 limit 封顶——
 * 旧实现只累加窗口内 ≤100 条，自愈发生在窗口外就整段少报（探针实锤 150→101、30→0）。
 * consecutiveFailures=从最新往回数到首个 pass 为止的已定论失败数（fail/blocked），
 * 对全部运行目录计数、不受 limit 封顶——旧实现 statusReport 只对 ≤100 条窗口计数，
 * 连败 >100 恒报 100（探针实锤 150→100）。running/interrupted/无报告目录不计失败也不打断
 * （与原窗口口径逐字一致）。
 * 摘要仍按 limit 截；total/healedTotal/consecutiveFailures 是全量真值（后两者对已载入的
 * 索引求值，零额外 I/O）。
 */
export function listRunsEx(flowId, limit = 20) {
  const { base, dirs, entries } = enumerateRuns(flowId);
  const total = dirs.length;
  let healedTotal = 0;
  for (const e of entries.values()) healedTotal += Number(e && e.healedCount) || 0;
  let consecutiveFailures = 0;
  for (const d of dirs) {
    const e = entries.get(d);
    if (!e) continue; // 进行中/中断/空目录（不在索引）：不计失败也不打断
    if (e.status === 'pass') break;
    if (e.status === 'running' || e.status === 'interrupted') continue;
    consecutiveFailures++;
  }
  if (!dirs.length) return { runs: [], total, healedTotal: 0, consecutiveFailures: 0 };
  const out = [];
  // 运行目录名就是可排序的时间戳（stampId：YYYYMMDD-HHmmss-mmm），倒序取、凑够 limit 即停。
  // 已完成运行的摘要直接从索引拿（一次 readJson），不再逐个读 report.json
  for (const d of dirs) {
    if (out.length >= limit) break;
    const e = entries.get(d);
    if (e) { out.push(Object.assign({}, e)); continue; }
    // 索引里没有 = 没有报告：可能是进行中/中断（running.json）或空目录，口径与旧实现一致——
    // 按标记里的 pid 分活/死：活着是"进行中"（含等待人工），死了才是"被强杀/断电的静默没跑成"
    const marker = readJson(path.join(base, d, 'running.json'));
    if (marker) {
      const alive = pidAlive(marker.pid);
      out.push(alive ? {
        stamp: d, status: 'running', startedAt: marker.startedAt || null,
        durationMs: null, trigger: marker.trigger || 'unknown', healedCount: 0,
        failedStep: null, error: null, running: true,
        waitingHuman: marker.waitingHuman || null,
      } : {
        stamp: d, status: 'interrupted', startedAt: marker.startedAt || null,
        durationMs: null, trigger: marker.trigger || 'unknown', healedCount: 0,
        failedStep: null, error: '进程中断（未被正常收尾，可能是强杀/断电/崩溃）', interrupted: true,
        waitingHuman: marker.waitingHuman || null,
      });
    }
  }
  return { runs: out, total, healedTotal, consecutiveFailures };
}

export function loadRun(flowId, stamp) {
  if (stamp === 'latest') {
    const latest = readJson(path.join(runsFlowRoot(flowId), 'latest.json'));
    if (!latest) return null;
    stamp = latest.stamp;
  }
  return readJson(path.join(runDir(flowId, stamp), 'report.json'));
}

/* ---------------- 人类可读渲染 ---------------- */

const OP_LABEL = {
  goto: '打开网址',
  click: '点击',
  clickAndDownload: '点击并下载',
  fill: '填入',
  select: '选择',
  check: '勾选',
  press: '按键',
  setInputFiles: '上传文件',
  waitFor: '等待元素',
  waitForText: '等待文字',
  humanHandoff: '人工接管',
  screenshot: '截图',
  extract: '取值',
  download: '等待下载',
  assert: '校验',
  chain: '串联流程',
  hover: '悬停',
  scrollIntoView: '滚动到可见',
  sleep: '等待',
  dialog: '处理弹窗',
  scrollTo: '滚动页面',
};

function locHint(step) {
  const l = (step.locators || [])[0];
  if (!l) return '(无定位符)';
  const extra = l.name ? ' "' + l.name + '"' : '';
  return l.strategy + '=' + String(l.value).slice(0, 60) + extra;
}

/** 一句话描述一个步骤 */
export function stepLabel(step, idx) {
  const n = idx === undefined ? '' : (idx + 1) + '. ';
  const op = OP_LABEL[step.op] || step.op;
  switch (step.op) {
    case 'goto': return n + op + ' ' + (step.url || step.locator || '');
    case 'click': case 'hover': case 'scrollIntoView':
      return n + op + ' ' + locHint(step) + (step.optional ? ' [可跳过]' : '');
    case 'fill': return n + op + ' ' + locHint(step) + ' = ' + (step.sensitive ? '******' : JSON.stringify(step.value));
    case 'select': return n + op + ' ' + locHint(step) + ' -> ' + (step.label || step.value);
    case 'check': return n + (step.checked === false ? '取消勾选' : '勾选') + ' ' + locHint(step);
    case 'press': return n + op + ' ' + (step.key || 'Enter') + ' ' + locHint(step);
    case 'setInputFiles': return n + op + ' ' + locHint(step) + ' <- ' + (step.path || (step.fileNames || []).join(','));
    case 'waitFor': return n + op + ' ' + locHint(step) + ' state=' + (step.state || 'visible');
    case 'waitForText': return n + op + ' 出现文字 ' + JSON.stringify(step.text);
    case 'humanHandoff': return n + '人工接管（' + (step.reason || '需要人工') + '，最多 ' + Math.round((step.timeoutMs || 180000) / 1000) + 's）';
    case 'screenshot': return n + op + ' ' + (step.name || 'evidence');
    case 'extract': return n + op + ' ' + locHint(step) + ' as ' + (step.as || '?');
    case 'download': return n + op + ' 保存到 ' + (step.saveAs || '(自动)');
    case 'assert': return n + op + ' [' + (step.kind || '?') + '] ' + (step.message || '');
    case 'chain': return n + op + ' ' + (step.flow || '?') + ' ' + (step.params ? JSON.stringify(step.params) : '');
    case 'sleep': return n + op + ' ' + (step.ms || 1000) + 'ms';
    case 'dialog': return n + op + '：' + (step.accept === false ? '取消' : '接受') + '下一个浏览器弹窗';
    case 'scrollTo': return n + op + ' 到' + (step.to === 'top' ? '顶部' : '底部') + (step.times ? ' x' + step.times : '') + (step.locators && step.locators.length ? ' ' + locHint(step) : '');
    default: return n + op + ' ' + JSON.stringify(step).slice(0, 100);
  }
}

/** 渲染完整步骤清单（供人工审阅，代理文章里"录完看一遍步骤清单"） */
export function flowMarkdown(flow) {
  const lines = [];
  lines.push('# 流程：' + (flow.name || flow.id));
  lines.push('');
  lines.push('- id: ' + flow.id);
  lines.push('- 起始地址: ' + (flow.startUrl || '(未设置)'));
  lines.push('- 步骤数: ' + (flow.steps || []).length);
  lines.push('- 断言数: ' + (flow.assertions || []).length);
  lines.push('- 更新时间: ' + (flow.updatedAt || '-'));
  if (flow.params && flow.params.length) {
    lines.push('');
    lines.push('## 变量');
    for (const p of flow.params) {
      lines.push('- ' + p.name + (p.label ? '（' + p.label + '）' : '') +
        ' 来源=' + (p.source || (p.default !== undefined ? 'const' : 'prompt')) +
        (p.default !== undefined && !p.secret ? ' 默认=' + JSON.stringify(p.default) : '') +
        (p.required ? ' [必填]' : '') + (p.secret ? ' [敏感]' : ''));
    }
  }
  lines.push('');
  lines.push('## 步骤');
  (flow.steps || []).forEach((s, i) => lines.push(stepLabel(s, i)));
  if (flow.assertions && flow.assertions.length) {
    lines.push('');
    lines.push('## 断言');
    flow.assertions.forEach((a, i) => lines.push((i + 1) + '. [' + a.kind + '] ' + (a.message || '') + ' ' + JSON.stringify(a).slice(0, 120)));
  }
  return lines.join('\n');
}
