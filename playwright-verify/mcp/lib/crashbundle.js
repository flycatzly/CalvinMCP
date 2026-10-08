/**
 * crashbundle.js — 崩溃/异常退出现场立即落盘（r44）
 *
 * 为什么存在：r43 取证 campaign 实证「现场不落盘 = 不可分析」——
 *   · w4-trio-03 的 0xC0000409 全靠复现台即时落盘才定住成员退出码（3221226505）
 *     与崩溃点（A 段仅 4 PASS 行）；verify-all 内存里只有尾部 12 行。
 *   · mode 1 sanity 首跑出现过一次 nl-agent-check 失败（计数 0），stdout 被
 *     `| tail` 管道吞掉、复跑全绿 —— 永久不可分类。正反两面同一课。
 *
 * 判据面与 suites.summarizeSuiteExit 的崩溃/异常退出分支同口径：**非零退出
 * （含 signal kill 的 null）且输出无 FAIL 行**才落 bundle。有 FAIL 行 = 断言失败，
 * 失败现场由 failedLines + 套件自身日志负责，不是本模块的缺口。
 *
 * 契约：
 *   · 全绿零产出零噪音（shouldBundle=false 时不写任何文件）。
 *   · 写盘失败绝不掀翻 harness（try/catch，返回 WRITE_FAILED 诚实原因）。
 *   · bundle 目录自修剪（保留最近 CRASH_BUNDLE_KEEP 个），**不进** verify-all
 *     收尾清理清单 —— 下一次全绿运行不许抹掉上一次的崩溃证据（r42 留存帽教训）。
 *     目录名时间戳前缀 = 字典序即时间序，修剪按名排序删最旧。
 */
import fs from 'node:fs';
import path from 'node:path';

/** bundle 落点（仓库/副本根下的目录名；exclude.js ARTIFACT_DIRS 单一源已排除各面） */
export const CRASH_BUNDLE_DIR = 'crash-bundles';

/** 自修剪保留个数（崩溃是低频事件，20 个现场足够翻很久的账） */
export const CRASH_BUNDLE_KEEP = 20;

/**
 * 该不该落 bundle：纯决策，时钟与 IO 无关。
 *
 * @param {number|null} exitCode 进程退出码（signal kill 后 close 给 null）
 * @param {string} out stdout 累积
 * @param {string} [err] stderr 累积
 * @returns {boolean}
 */
export function shouldBundle(exitCode, out, err = '') {
  if (exitCode === 0) return false;
  const lines = `${out || ''}${err || ''}`.split('\n');
  return !lines.some((l) => l.trim().startsWith('FAIL'));
}

/**
 * meta.json 确定性组装（时钟由入参注入，钉可静态断言）。
 * freememGB/rssMB 是 harness 侧读数（子进程已亡，读不到它的）—— 如实命名不冒充。
 */
export function buildBundleMeta(info) {
  const raw = info.exitCode;
  const hasCode = raw !== null && raw !== undefined;
  const u = hasCode ? Number(raw) >>> 0 : null;
  const toIso = (v) => (typeof v === 'number' ? new Date(v).toISOString() : null);
  return {
    suite: info.suiteName || null,
    file: info.suiteFile || null,
    exitCode: hasCode ? Number(raw) : null,
    unsignedExit: u,
    hexExit: u === null ? null : `0x${u.toString(16).toUpperCase()}`,
    startedAt: toIso(info.startedAt),
    endedAt: toIso(info.endedAt),
    durationMs: Number.isFinite(info.durationMs) ? info.durationMs : null,
    passCount: Number.isFinite(info.passCount) ? info.passCount : null,
    skipCount: Number.isFinite(info.skipCount) ? info.skipCount : null,
    mode: info.mode ?? null,
    parallel: !!info.parallel,
    freememGB: Number.isFinite(info.freememGB) ? info.freememGB : null,
    rssMB: Number.isFinite(info.rssMB) ? info.rssMB : null,
    node: process.version,
  };
}

/**
 * 写一个崩溃现场 bundle。永不抛错。
 *
 * @param {string} root verify-all 的 ROOT（仓库/部署副本根）
 * @param {object} info { suiteName, suiteFile, exitCode, out, err, startedAt, endedAt,
 *   durationMs, passCount, skipCount, mode, parallel, freememGB, rssMB }
 * @returns {{written: boolean, dir?: string, meta?: object, reason?: string}}
 *   reason: NOT_CRASH（不该落）| WRITE_FAILED: …（诚实报因，不影响判定）
 */
export function writeCrashBundle(root, info) {
  if (!shouldBundle(info.exitCode, info.out, info.err)) return { written: false, reason: 'NOT_CRASH' };
  const ended = Number.isFinite(info.endedAt) ? info.endedAt : Date.now();
  // ISO 换成文件系统安全形：2026-10-08T03-04-05-123（字典序 = 时间序，自修剪靠它）
  const stamp = new Date(ended).toISOString().replace(/[:.]/g, '-').slice(0, 23);
  const base = path.basename(info.suiteFile || info.suiteName || 'unknown').replace(/\.mjs$/i, '');
  const slug = base.replace(/[^\w.-]/g, '_') || 'unknown';
  const dir = path.join(root, CRASH_BUNDLE_DIR, `${stamp}_${slug}`);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'stdout.log'), info.out || '', 'utf8');
    fs.writeFileSync(path.join(dir, 'stderr.log'), info.err || '', 'utf8');
    const meta = buildBundleMeta({ ...info, endedAt: ended });
    fs.writeFileSync(path.join(dir, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`, 'utf8');
    pruneBundles(path.join(root, CRASH_BUNDLE_DIR));
    return { written: true, dir, meta };
  } catch (e) {
    return { written: false, reason: `WRITE_FAILED: ${e && e.message}` };
  }
}

/**
 * 自修剪：保留最近 keep 个 bundle 目录，删更旧的。尽力而为，不抛错。
 *
 * @param {string} bundleRoot crash-bundles 目录
 * @param {number} [keep]
 * @returns {{pruned: number, total: number}}
 */
export function pruneBundles(bundleRoot, keep = CRASH_BUNDLE_KEEP) {
  let names = [];
  try {
    names = fs.readdirSync(bundleRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory()).map((d) => d.name).sort();
  } catch { return { pruned: 0, total: 0 }; }
  const cap = Number.isInteger(keep) && keep >= 1 ? keep : CRASH_BUNDLE_KEEP;
  const excess = names.length - cap;
  let pruned = 0;
  if (excess > 0) {
    for (const name of names.slice(0, excess)) {
      try { fs.rmSync(path.join(bundleRoot, name), { recursive: true, force: true }); pruned += 1; } catch { /* 尽力而为 */ }
    }
  }
  return { pruned, total: names.length - pruned };
}

export default { CRASH_BUNDLE_DIR, CRASH_BUNDLE_KEEP, shouldBundle, buildBundleMeta, writeCrashBundle, pruneBundles };
