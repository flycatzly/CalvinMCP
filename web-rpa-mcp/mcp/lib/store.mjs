// web-rpa-mcp — 流程与运行的持久化 + 步骤人类可读渲染
import fs from 'node:fs';
import path from 'node:path';
import { DIRS, ensureDirs, readJson, writeJson, slugify, shortId, stampId, nowIso, logger } from './core.mjs';

const L = logger('store');

export const FLOW_VERSION = 1;

export function flowPath(id) { return path.join(DIRS.flows, id + '.json'); }

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
export function runDir(flowId, stamp) { return path.join(DIRS.runs, flowId, stamp); }

export function saveRun(report) {
  const dir = runDir(report.flowId, report.stamp);
  writeJson(path.join(dir, 'report.json'), report);
  try {
    writeJson(path.join(DIRS.runs, report.flowId, 'latest.json'), {
      stamp: report.stamp, status: report.status, startedAt: report.startedAt,
      durationMs: report.durationMs, error: report.error || null,
    });
  } catch { /* ignore */ }
  return path.join(dir, 'report.json');
}

export function listRuns(flowId, limit = 20) {
  const base = path.join(DIRS.runs, flowId);
  if (!fs.existsSync(base)) return [];
  const out = [];
  for (const d of fs.readdirSync(base)) {
    if (d === 'latest.json') continue;
    const rep = readJson(path.join(base, d, 'report.json'));
    if (!rep) {
      // 有开始标记却没有报告 = 进程被强杀/断电，这种"静默没跑成"必须能被看见
      const marker = readJson(path.join(base, d, 'running.json'));
      if (marker) {
        out.push({
          stamp: d, status: 'interrupted', startedAt: marker.startedAt || null,
          durationMs: null, trigger: marker.trigger || 'unknown', healedCount: 0,
          failedStep: null, error: '进程中断（未被正常收尾，可能是强杀/断电/崩溃）', interrupted: true,
        });
      }
      continue;
    }
    out.push({
      stamp: rep.stamp, status: rep.status, startedAt: rep.startedAt,
      durationMs: rep.durationMs, trigger: rep.trigger || 'manual',
      healedCount: (rep.healed || []).length, failedStep: rep.failedStep || null,
      error: rep.error || null,
    });
  }
  out.sort((a, b) => String(b.stamp).localeCompare(String(a.stamp)));
  return out.slice(0, limit);
}

export function loadRun(flowId, stamp) {
  if (stamp === 'latest') {
    const latest = readJson(path.join(DIRS.runs, flowId, 'latest.json'));
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
