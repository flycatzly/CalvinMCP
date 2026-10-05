/**
 * collect.js — 翻页表格采集 + 两期对比（collect_table 的取数与判定）
 *
 * 来源（两篇文章合并中的「文章二」差异化能力）：
 *   「380 多页数据档案，一页一页翻出来，整理成带日期的 Excel；每周再跑一遍出对比报告。」
 *   翻页采集是确定性体力活，同样**不需要 LLM** —— 判据与流程都是确定的，
 *   用 LLM 反而把确定的事变成概率的事（与 explore.js 同一条纪律）。
 *
 * 与真实 API 的对齐：翻页动作复用 playwright-cli 的会话动作；
 *   「下一页/页码框」这类控件靠快照 ref 定位（needleFromTarget/healCandidates 同款启发式，
 *   文章二的实测经验：有页码输入框就填页码，比摸索「下一页」按钮快得多）。
 *
 * 产物纪律（与全项目一致）：行数据一律落盘，工具返回只给计数、摘要与路径。
 *   rows.json（两期对比的基准）/ rows-<date>.csv（Excel 直接打开，带 BOM 防中文乱码）/ report.json。
 *
 * 停止条件（防死循环，三选一必有其一）：
 *   max-pages 到上限；empty 一页零行；no-new-rows 整页行都见过（点「下一页」没推进）。
 *   「没推进就停」也是幂等的近亲：重复跑不会无限翻。
 */
import fs from 'node:fs';
import path from 'node:path';

import { ARTIFACT_DIRS, safeSession } from './cli.js';

/** 采集硬上限：翻页是体力活也是烧钱活，超过上限必须由人分批。 */
export const MAX_PAGES_HARD = 100;
export const MAX_ROWS_HARD = 20000;

/**
 * 页面表格取数脚本（自包含；selector/fields 由 buildTableEvalFn 注入）。
 * 口径：第一个匹配 selector 的 table（缺省 table/[role=table]），
 * 行 = tbody tr（无 tbody 则非表头行），单元格 innerText 去空白截断。
 */
export function buildTableEvalFn({ selector = '', maxRows = 2000 } = {}) {
  const sel = String(selector || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  return `() => JSON.stringify((() => {
  const sel = '${sel}';
  const root = sel ? document.querySelector(sel) : (document.querySelector('table') || document.querySelector('[role="table"]') || document.querySelector('[role="grid"]'));
  if (!root) return { url: location.href, headers: [], rows: [], rowCount: 0, tableFound: false };
  const headCells = Array.from(root.querySelectorAll('thead th, thead td'));
  const headers = headCells.map((c) => (c.innerText || '').trim().slice(0, 60));
  const trs = Array.from(root.querySelectorAll('tr')).filter((tr) => !tr.closest('thead'));
  const rows = trs.slice(0, ${Number(maxRows) || 2000}).map((tr) =>
    Array.from(tr.querySelectorAll('th,td')).slice(0, 50).map((c) => (c.innerText || '').trim().slice(0, 200)));
  return { url: location.href, headers, rows, rowCount: rows.length, tableFound: true };
})())`;
}

/** 采集结果文件路径（构造即唯一，沿用 session-序号-随机码约定的随机段）。 */
export function collectDir(cwd, session = 'collect') {
  const uniq = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
  const dir = path.join(cwd, ARTIFACT_DIRS.reports, `collect-${safeSession(session)}-${uniq}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** 解析 eval 落盘件（与 explore.parseFactsFile 同一解包纪律：信封/双层编码/杂讯都认）。 */
export function parseTableFile(text) {
  const t = String(text || '').trim();
  if (!t) return null;
  const tryOne = (input, depth = 0) => {
    if (depth > 3) return null;
    let obj = input;
    if (typeof obj === 'string') {
      try { obj = JSON.parse(obj); } catch {
        const i = obj.indexOf('{');
        const j = obj.lastIndexOf('}');
        if (i < 0 || j <= i) return null;
        try { obj = JSON.parse(obj.slice(i, j + 1)); } catch { return null; }
      }
      if (typeof obj === 'string') return tryOne(obj, depth + 1);
    }
    if (!obj || typeof obj !== 'object') return null;
    if ('rows' in obj) return obj;
    for (const key of ['result', 'stdout', 'content', 'data']) {
      if (obj[key] !== undefined) {
        const inner = tryOne(obj[key], depth + 1);
        if (inner) return inner;
      }
    }
    return null;
  };
  return tryOne(t);
}

/** 行去重键：默认第 0 列（业务编号）；空行与全空键不算新行。 */
export function rowKey(row, keyIndex = 0) {
  const v = Array.isArray(row) ? row[keyIndex] : undefined;
  const s = v === undefined || v === null ? '' : String(v).trim();
  return s;
}

/**
 * 把一页行并进累计：返回本轮新增数（用于 no-new-rows 判定）。
 * 同 key 后出现的行直接丢弃（翻页重复/表格吸底行），不覆盖首见行 —— 首见为准，结果稳定。
 */
export function mergeRows(acc, pageRows, keyIndex = 0) {
  let added = 0;
  for (const row of pageRows || []) {
    if (!Array.isArray(row) || row.every((c) => !String(c ?? '').trim())) continue;
    const k = rowKey(row, keyIndex);
    if (!k) continue;
    if (acc.map.has(k)) continue;
    acc.map.set(k, row);
    added++;
  }
  return added;
}

/**
 * 两期对比（纯函数）：按 key 列比 rows 的 新增/删除/变化/未变。
 * 语义是「数据归并的对照表」，不是测试判定 —— 新增与变化不是失败。
 */
export function diffRows(prevRows = [], currRows = [], keyIndex = 0) {
  const prev = new Map();
  for (const r of prevRows) {
    const k = rowKey(r, keyIndex);
    if (k) prev.set(k, r);
  }
  const curr = new Map();
  for (const r of currRows) {
    const k = rowKey(r, keyIndex);
    if (k) curr.set(k, r);
  }

  const added = [];
  const changed = [];
  let unchanged = 0;
  for (const [k, row] of curr) {
    if (!prev.has(k)) { added.push(row); continue; }
    const before = prev.get(k);
    const same = before.length === row.length && before.every((c, i) => String(c ?? '') === String(row[i] ?? ''));
    if (same) unchanged++;
    else changed.push({ key: k, before, after: row });
  }
  const removed = [...prev.keys()].filter((k) => !curr.has(k)).map((k) => prev.get(k));
  return {
    added, removed, changed, unchanged,
    totalPrev: prev.size, totalCurr: curr.size,
  };
}

/** CSV 编码（RFC4180 引号转义；带 BOM —— Excel 直接双击打开不乱码）。 */
export function formatCsv(headers, rows) {
  const cell = (v) => {
    const s = v === undefined || v === null ? '' : String(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [];
  if (headers && headers.length) lines.push(headers.map(cell).join(','));
  for (const r of rows) lines.push((r || []).map(cell).join(','));
  return `﻿${lines.join('\r\n')}\r\n`;
}

/** 采集总判定：只判「采集本身」成不成 —— 零行是 Fail（目标达成不了），其余 Pass。 */
export function judgeCollect({ rowCount, stopReason }) {
  if (!rowCount) {
    return {
      verdict: 'Fail',
      issues: [{ kind: 'collect-empty', detail: `一页都没采到行（停止原因 ${stopReason || 'unknown'}）` }],
    };
  }
  return { verdict: 'Pass', issues: [] };
}

/**
 * 断点续采计划（纯函数）：从上一次的 rows.json 推「带哪些行、从哪页续」。
 * 指纹（url + keyIndex）必须一致 —— 不一致拒绝续采（COLLECT_STALE）：
 * 爬错页会把别的表的行混进基准，污染两期对比，宁可让人从头来。
 * 续采起点 = 最后一个产出过新行的页 +1（eval 失败/零行的页没并进 acc，会被这一步重扫）；
 * 基准里一行没产出过 → 从第 1 页重扫（和不续采等价，不会更坏）。
 * 返回 {ok, seedRows, seedPages, startPage} | {ok:false, why, detail}。
 */
export function planResume(prev, { url, keyIndex = 0 } = {}) {
  if (!prev || typeof prev !== 'object' || !Array.isArray(prev.rows) || !Array.isArray(prev.pages)) {
    return { ok: false, why: 'COLLECT_RESUME_UNREADABLE', detail: '续采基准不可解析，或缺 rows/pages 字段（要上次采集落盘的 rows.json）' };
  }
  if (String(prev.url || '') !== String(url || '') || Number(prev.keyIndex || 0) !== Number(keyIndex || 0)) {
    return {
      ok: false,
      why: 'COLLECT_STALE',
      detail: `续采基准指纹不匹配（基准 url=${prev.url} keyIndex=${Number(prev.keyIndex || 0)}；本次 url=${url} keyIndex=${keyIndex}），拒绝续采 —— 请从头采集，或换与本次目标一致的基准`,
    };
  }
  let startPage = 1;
  for (const p of prev.pages) {
    const n = p && Number(p.page);
    if (n && Number(p.added) > 0 && n >= startPage) startPage = n + 1;
  }
  return { ok: true, seedRows: prev.rows, seedPages: prev.pages, startPage };
}

/** 日期文件名（文章二口径：产出带日期的表）。 */
export function dateStamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export default {
  MAX_PAGES_HARD, MAX_ROWS_HARD, buildTableEvalFn, collectDir, parseTableFile,
  rowKey, mergeRows, diffRows, formatCsv, judgeCollect, planResume, dateStamp,
};
