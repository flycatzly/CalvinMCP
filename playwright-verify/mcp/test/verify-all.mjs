#!/usr/bin/env node
/**
 * verify-all.mjs — 一键跑完全部回归测试
 *
 * 用法：node mcp/test/verify-all.mjs [--with-browser] [--keep-artifacts] [--mode 1|2|3]
 *
 * 为什么要有这个入口：
 *   门禁的公信力是它唯一的资产。改一行规则就可能冤枉一批用例，
 *   所以「改完必须一键跑全绿」这件事必须足够便宜，便宜到没人有理由跳过。
 *
 * --with-browser 会额外跑真实浏览器回归（约 30 秒，需要已装浏览器）。
 * 默认不跑，因为无浏览器的环境（CI 容器）也应该能验证核心判定逻辑。
 * --keep-artifacts 保留产物目录（.playwright-artifacts/ 等）；默认全绿后自动清理、失败保留现场。
 * --mode 1|2|3 按《部署说明》§15.3 判据行复跑三态验收 —— 每态不只跑对应命令，
 *   还校验状态本身（依赖在不在、SKIP 是否诚实、矩阵是否真跑），对不上直接 exit 1：
 *   1 = 零依赖裸跑（12 套）；2 = 零依赖 + 浏览器面（13 套，执行层诚实 SKIP）；
 *   3 = 全量（可选依赖必须就位，矩阵真跑且聚 4 签名）。
 *   没有 --mode 时不校验状态（开发机日常回归用，装没装依赖都能跑）。
 */
import path from 'node:path';
import os from 'node:os';
import { spawnSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import { resolvePlaywrightRunner, resolveCliRunner } from '../lib/runner.js';
import { SUITES, planWaves, coreCounts, expectedAssertions, summarizeSuiteExit, PIN_FILES } from './suites.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const argv = process.argv.slice(2);
const parallel = argv.includes('--parallel') || argv.includes('--concurrent');
const keepArtifacts = argv.includes('--keep-artifacts');

// --mode：§15.3 判据行的三态验收开关。为什么状态也要校验 ——
// 同一条 --with-browser 命令在零依赖机器上会「诚实 SKIP 后报绿」（mode 2 的形态），
// 在全量机器上才是真全量（mode 3）；不校验状态，mode 3 就能在零依赖机器上
// 静默退化成 mode 2 还报绿，判据行就成了摆设。
const mode = (() => {
  const i = argv.findIndex((a) => a === '--mode' || a.startsWith('--mode='));
  if (i === -1) return null;
  const v = argv[i] === '--mode' ? argv[i + 1] : argv[i].slice('--mode='.length);
  if (!['1', '2', '3'].includes(v)) {
    console.error(`--mode 只接受 1|2|3（收到：${v || '空'}）`);
    process.exit(1);
  }
  return v;
})();
if (mode === '1' && argv.includes('--with-browser')) {
  console.error('--mode 1 是零浏览器面（不带 --with-browser）；要跑浏览器面用 --mode 2/3');
  process.exit(1);
}
const withBrowser = mode === '2' || mode === '3' ? true : argv.includes('--with-browser');

// 可选依赖探测：与 run_verify/runCli 用同一套解析逻辑（runner.js），
// 跳过与否必须与「工具真跑起来会不会失败」一致，不能另写一份猜测。
// 纯净发布包按口径不带 node_modules —— 执行层缺失时诚实 SKIP，不红着脸报失败。
const HAS_TEST = !!resolvePlaywrightRunner(ROOT);
const HAS_CLI = !!resolveCliRunner(ROOT);

// 预检：状态不对就别白跑 —— mode 2 验的是零依赖态的「诚实 SKIP」形态、mode 3 验的是真全量，
// 提前拦下省一轮几分钟的无效回归（对不上是环境错不是产品错，修法也不同）。
if (mode === '2' && (HAS_TEST || HAS_CLI)) {
  console.error('判据[mode 2] 是零依赖态：本机已能解析可选依赖（@playwright/test/@playwright/cli）——');
  console.error('  这不是零依赖环境，跑了也验不了「诚实 SKIP」形态。请在一次性纯净副本（无 node_modules）上跑；');
  console.error('  本机要跑全量请用 --mode 3。');
  process.exit(1);
}
if (mode === '3' && (!HAS_TEST || !HAS_CLI)) {
  console.error('判据[mode 3] 是全量态：可选依赖未就位（缺 @playwright/test / @playwright/cli）——');
  console.error('  请先 npm ci 装可选依赖（或在装齐依赖的树上跑）；零依赖形态请用 --mode 2。');
  process.exit(1);
}

// 浏览器套件前置：源码树通道配置自愈（幂等）。
// 为什么在这里做：.playwright/cli.config.json 是装机基础设施，distribute 一律排除、
// install.mjs 只给部署目录生成 —— 源码树没人负责，clone 后第一次 --with-browser 时
// CLI 回退自己的默认通道（Windows 上找 chrome），5 套连锁以「daemonPid」失败，
// 真实根因要翻日志才知道。决策函数与 setup-cli-config.mjs / install.mjs 共用同一份
// （cli-config.mjs，含「手工配置不覆盖」矩阵），不在这里另写一份猜测。
// mode 2（零依赖副本）不会进来：HAS_CLI=false，副本树也不会被写脏。
if (withBrowser && HAS_CLI) {
  const { pickChannel, buildCliConfig, decideCliConfig } = await import('../../skill/playwright-verify/scripts/cli-config.mjs');
  const cfgFile = path.join(ROOT, '.playwright', 'cli.config.json');
  let cfg = null;
  try { cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8')); } catch { /* 缺失/坏文件按重生成处理 */ }
  const decision = decideCliConfig({ cfg, platform: process.platform });
  if (decision.action === 'regenerate') {
    const { channel, source } = pickChannel({ platform: process.platform });
    fs.mkdirSync(path.dirname(cfgFile), { recursive: true });
    fs.writeFileSync(cfgFile, `${JSON.stringify(buildCliConfig({ platform: process.platform, arch: process.arch, channel, source }), null, 2)}\n`, 'utf8');
    console.log(`浏览器套件前置：已生成 ${cfgFile}（${decision.detail}；通道 ${channel || 'chromium'}，${source}）`);
  }
}

// 套件清单与波次调度抽在 suites.mjs —— 调度结构（谁并发、谁独占末位）是
// 「会假失败 vs 不会」的分界线，加固 H21 对它做行为断言，不靠人记。

const results = [];
console.log('playwright-verify-mcp 全量回归');
console.log(`项目根：${ROOT}`);
console.log(`浏览器回归：${withBrowser ? '开启' : '跳过需要浏览器的套件（加 --with-browser 开启）'}`);
console.log(`执行方式：${parallel ? '并发（--parallel，见下方警告）' : '串行（默认）'}\n`);

// 并发踩踏面：早期版本直接 Promise.all 全部套件，三轮实测 4/10、8/10、9/10 —— **会假失败**。
//   一个会假失败的门禁，比一个慢的门禁危险得多：人一旦被冤枉过，就会开始忽略它。
//   当时踩的四个点，逐个钉死后并行才敢开：
//     1) CLI 套件用固定会话名抢同一浏览器会话 → 会话名一律带时间戳（构造即唯一）；
//     2) 产物按扫目录取序号命名，后写覆盖前写 → claimPath 时间戳+随机码（构造即唯一）；
//     3) demo/generated-* 读写互踩 → 生成器套件写临时目录，编排产物目录名在
//        distribute/deployed-check 的排除表里（任意层级）；
//     4) 部署副本验证比对整棵树，任何并发写入都会报假漂移 → planWaves 让它独占末波（serial: true）。
//   现在 --parallel 是「波内并发、波间串行」：非 serial 套件同波并发，部署副本验证独占末波殿后。
//   串行仍是默认 —— 并发缩短的是墙钟时间，串行换的是零意外；日常门禁用串行，
//   显式 --parallel 才开波内并发（部署前想快跑一轮时用）。
//   另：收尾统一 kill-all 收割孤儿浏览器（否则残留句柄会让 distribute 的 rmSync 报 EPERM，实测踩过）。
const t0 = Date.now();

/**
 * 跑一套测试，返回汇总。
 *
 * 并发而不是顺序，理由：这些套件彼此独立、且都受「进程启动 + 浏览器冷启动」主导，
 * 顺序跑总时长是累加，并发跑总时长是最慢的那一套。
 * 但它们**不是完全无状态** —— 都会写 .playwright-artifacts/ 下的日志，
 * 所以日志文件名必须带上套件名，否则并发时互相覆盖，失败时看不到现场。
 */
function runSuite(s) {
  return new Promise((resolve) => {
    const file = path.join(ROOT, s.file);
    if (!fs.existsSync(file)) {
      resolve({ ...s, ok: false, detail: '测试文件不存在', failedLines: [] });
      return;
    }
    if (s.browser && !withBrowser) {
      resolve({ ...s, ok: true, skipped: true, detail: 'SKIP（需要 --with-browser）' });
      return;
    }
    // 执行层缺失时诚实 SKIP（纯净包口径）：即使加了 --with-browser，
    // 没有可选依赖就跑不出有意义的结果 —— 红着脸报失败只会训练人忽略门禁。
    if (s.needs && s.needs.length) {
      const missing = s.needs.filter((n) => (n === 'cli' ? !HAS_CLI : !HAS_TEST));
      if (missing.length) {
        const pkgs = missing.map((m) => (m === 'cli' ? '@playwright/cli' : '@playwright/test')).join('、');
        resolve({
          ...s,
          ok: true,
          skipped: true,
          detail: `SKIP（缺可选依赖 ${pkgs}：纯净包口径 —— 可选依赖由被测项目/本机提供）`,
        });
        return;
      }
    }
    if (s.file.includes('deployed-check')) {
      const inst = path.join(os.homedir(), '.agents', 'skills', 'playwright-verify-mcp');
      if (!fs.existsSync(inst)) {
        resolve({ ...s, ok: true, skipped: true, detail: 'SKIP（尚未安装到 ~/.agents/skills）' });
        return;
      }
    }

    const started = Date.now();
    const child = spawn(process.execPath, [file], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      // 标记「在 verify-all 调度下」：套件自带的独立收尾 kill-all 是全机收割，
      // 会把 --parallel 并发兄弟套件的活会话一起杀掉（踩踏面）。子进程看到此标记
      // 就跳过自装兜底，由 verify-all 结尾的统一 kill-all 负责收割。
      env: { ...process.env, PWVERIFY_UNDER_HARNESS: '1' },
    });
    let out = '';
    let err = '';
    let settled = false;
    // 挂死守卫：某套测试若进入死循环，没有守卫时整个 verify-all 会一起卡住，
    // 而「卡住」比「失败」更难排查 —— 看不到任何输出，也拿不到退出码。
    // 实测踩过一次死循环（skipToken 返回后退），所以这道守卫是必需品，不是保险起见。
    const HANG_MS = 240_000;
    const hangTimer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill('SIGKILL'); } catch { /* 已退出 */ }
      resolve({
        ...s,
        ok: false,
        detail: `挂死超时（>${HANG_MS / 1000}s），已强制终止`,
        failedLines: ['疑似死循环：请对该套单跑并加迭代计数定位'],
        seconds: Math.round((Date.now() - started) / 100) / 10,
      });
    }, HANG_MS);
    const settle = (fn) => { if (settled) return; settled = true; clearTimeout(hangTimer); fn(); };
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('error', (e) => settle(() => resolve({ ...s, ok: false, detail: `启动失败：${e.message}`, failedLines: [] })));
    child.on('close', (code) => settle(() => {
      // 退出取证归类抽在 suites.summarizeSuiteExit（加固 H20 钉住）：
      // 崩溃（无 FAIL 行）时输出尾部（含 stderr）必须带出来，崩溃根因不许丢。
      resolve({
        ...s,
        ...summarizeSuiteExit(code, out, err),
        seconds: Math.round((Date.now() - started) / 100) / 10,
      });
    }));
  });
}

// 波次执行：波内按 --parallel 决定并发/串行，波间严格串行（末波的整树比对不容并发写入）。
// 串行模式下波内也是按声明顺序跑 —— 整体顺序与「纯串行一个一个来」完全一致，行为不变。
const waves = planWaves(SUITES);
const settled = [];
for (const wave of waves) {
  const part = parallel
    ? await Promise.all(wave.map(runSuite))
    : await (async () => {
      const out = [];
      for (const s of wave) out.push(await runSuite(s));
      return out;
    })();
  settled.push(...part);
}
results.push(...settled);

for (const r of settled) {
  if (r.skipped) { console.log(`− ${r.name} — ${r.detail}\n`); continue; }
  console.log(`${r.ok ? '✓' : '✗'} ${r.name} — ${r.detail}（${r.seconds ?? '?'}s）`);
  for (const l of r.failedLines.slice(0, 12)) console.log(`    ${l}`);
  if (!r.ok) console.log('');
}

// 可选：真实浏览器回归（验证执行层与报告聚类在真数据上成立）
if (withBrowser && !HAS_TEST) {
  // 纯净包口径：没有 @playwright/test 就没有「真跑」可言，诚实 SKIP 而不是报「没生成报告」
  // （那会把「依赖缺失」误导成「json reporter 坏了」，修法完全不同）。
  results.push({
    name: '真实浏览器回归矩阵',
    ok: true,
    skipped: true,
    detail: 'SKIP（缺可选依赖 @playwright/test：纯净包口径 —— 可选依赖由被测项目/本机提供）',
  });
  console.log('− 真实浏览器回归矩阵 — SKIP（缺可选依赖 @playwright/test：纯净包口径）\n');
} else if (withBrowser) {
  console.log('▶ 真实浏览器回归（demo/regression）\n  2 通过 / 6 失败 / 1 偶发 → 4 个根因签名\n');
  const { runPlaywright } = await import('../lib/runner.js');
  const res = await runPlaywright({
    cwd: ROOT,
    args: ['--config', 'demo/regression/playwright.config.ts'],
    timeoutMs: 300_000,
    logDir: path.join(ROOT, '.playwright-artifacts', 'logs'),
  });
  // 这个回归**故意**有 6 条失败，所以退出码 1 是预期；要检查的是矩阵与聚类
  const reportFile = path.join(ROOT, 'demo/test-results/report.json');
  let matrixOk = false;
  let clusterOk = false;
  let detail = '';
  let rep = null;
  if (fs.existsSync(reportFile)) {
    const { summarizeFile } = await import('../lib/signature.js');
    rep = summarizeFile(reportFile);
    const t = rep.totals;
    matrixOk = t.failed === 6 && t.flaky === 1 && t.passed === 2;
    clusterOk = rep.clusters.length === 4;
    detail = `通过 ${t.passed} / 失败 ${t.failed} / 偶发 ${t.flaky}，聚成 ${rep.clusters.length} 个签名`
      + `（${rep.clusters.map((c) => `${c.category}:${c.count}`).join(' ')}）`;
  } else {
    detail = '没有生成报告（json reporter 未生效？）';
  }
  const ok = matrixOk && clusterOk;
  results.push({
    name: '真实浏览器回归矩阵', ok, detail,
    matrix: rep ? { ...rep.totals, clusters: rep.clusters.length } : null,
  });
  console.log(`  ${ok ? '✓' : '✗'} ${detail}\n`);
  // 环境类失败要给修法：「矩阵对不上」只是结论，人还得自己翻报告才知道
  // 是缺浏览器而不是用例/归因坏了 —— 这类提示省下的就是一整轮排查。
  if (!ok && rep?.clusters?.some((c) => c.category === 'env')) {
    console.log('  ↳ 根因是环境（浏览器没装/通道不对），不是用例或归因坏了。');
    console.log('    修法：npx playwright install chromium；或按平台重生成 .playwright/cli.config.json');
    console.log('         （node skill/playwright-verify/scripts/setup-cli-config.mjs）\n');
  }
}

console.log('='.repeat(60));
for (const r of results) console.log(`  [${r.ok ? (r.skipped ? 'SKIP' : 'PASS') : 'FAIL'}] ${r.name} — ${r.detail}`);
const failed = results.filter((r) => !r.ok);
console.log('='.repeat(60));
const totalSec = Math.round((Date.now() - t0) / 100) / 10;
console.log(failed.length
  ? `\n结果：${results.length - failed.length}/${results.length} 套通过，${failed.length} 套失败 ❌（总耗时 ${totalSec}s）`
  : `\n结果：${results.length}/${results.length} 套全部通过 ✅（总耗时 ${totalSec}s）`);

// --mode 判据校验（§15.3 判据行）：跑完不算完，状态要对得上。
// 期望断言总数 = 核心段（coreCounts：与套件声明同源，数字单一源）+ 存在性钉（H10/H14/H22 各钉一个
// . 前缀基础设施文件，在位才生效、纯净包里诚实 SKIP 不计数）+ 部署副本段（装了才跑，未安装诚实 SKIP 不计数）。
// 合法断言变更时改 suites.mjs 的声明并同步 §15.3 判据行（H16/H22 机械对账）——
// 对不上就失败，防止断言悄悄变少（静默失效）。
const CORE = coreCounts();
const DEPLOYED_N = SUITES.find((s) => s.serial).assertions;
const DOT_PINS = SUITES.reduce((n, s) => n + (s.dotPins || 0), 0);

// 逐套件断言数对账（数字单一源）：每套实跑 PASS 数必须等于 suites.mjs 声明 ——
// 断言悄悄变少（规则静默失效）或没同步声明（文档/判据漂移）都在这里现形。
// 混合依赖态（只装一半）没实测过，expectedAssertions 返回 null 时跳过该套（不误报）。
const pins = PIN_FILES.filter((f) => fs.existsSync(path.join(ROOT, f))).length;
const env = { fullDeps: HAS_TEST && HAS_CLI, noDeps: !HAS_TEST && !HAS_CLI, pins };
const countDrift = [];
for (const r of results) {
  if (r.skipped || !r.ok || !r.file) continue;
  const suite = SUITES.find((s) => s.file === r.file);
  if (!suite) continue;
  const exp = expectedAssertions(suite, env);
  if (exp !== null && r.passCount !== exp) countDrift.push(`${r.name}：实跑 ${r.passCount} / 声明 ${exp}`);
}

let modeFailed = false;
if (mode) {
  // 只计通过套件的断言：失败套件跑出的半截数字没有判据意义（check[0] 已经拦红）
  const total = results.reduce((n, r) => n + (r.ok ? r.passCount || 0 : 0), 0);
  const deployedRan = results.some((r) => r.file && r.file.includes('deployed-check') && !r.skipped && r.ok);
  const expected = CORE[mode] + pins + (deployedRan ? DEPLOYED_N : 0);
  const matrix = results.find((r) => r.name === '真实浏览器回归矩阵');
  const browserSuites = settled.filter((r) => r.browser);
  const checks = [];
  checks.push([`套件全数在且无失败（${results.length} 套）`, failed.length === 0 && results.length === (mode === '1' ? 13 : 14)]);
  if (mode === '1') {
    checks.push(['5 个浏览器套件以「需要 --with-browser」诚实 SKIP',
      browserSuites.length === 5 && browserSuites.every((r) => r.skipped && (r.detail || '').includes('需要 --with-browser'))]);
    checks.push(['无「缺可选依赖」类 SKIP（裸跑面不碰执行层）',
      !results.some((r) => r.skipped && (r.detail || '').includes('缺可选依赖'))]);
  }
  if (mode === '2') {
    checks.push(['零依赖态成立（可选依赖均不可解析）', !HAS_TEST && !HAS_CLI]);
    checks.push(['执行层与矩阵以「缺可选依赖」诚实 SKIP',
      !!(matrix && matrix.skipped && (matrix.detail || '').includes('缺可选依赖'))
      && browserSuites.filter((r) => r.needs).every((r) => r.skipped && (r.detail || '').includes('缺可选依赖'))]);
  }
  if (mode === '3') {
    checks.push(['可选依赖就位（@playwright/test + @playwright/cli）', HAS_TEST && HAS_CLI]);
    checks.push(['无「缺可选依赖」SKIP（不许降级成 mode 2 还报绿）',
      !results.some((r) => r.skipped && (r.detail || '').includes('缺可选依赖'))]);
    checks.push(['矩阵真跑且 2/6/1 → 4 签名',
      !!(matrix && matrix.matrix && matrix.matrix.passed === 2 && matrix.matrix.failed === 6
        && matrix.matrix.flaky === 1 && matrix.matrix.clusters === 4)]);
  }
  checks.push([`断言总数 ${total} = 期望 ${expected}（核心 ${CORE[mode]} + . 前缀钉 ${pins}/${DOT_PINS} + 部署副本 ${deployedRan ? DEPLOYED_N : 0}）`,
    total === expected]);
  checks.push([`逐套件断言数与 suites.mjs 声明一致（数字单一源）`,
    countDrift.length === 0]);
  modeFailed = checks.some(([, ok]) => !ok);
  const passN = results.length - failed.length;
  const shape = mode === '1' ? `${passN}/13（${total} 断言）`
    : mode === '2' ? `${passN}/14（${total} 断言 + 诚实 SKIP）`
      : `${passN}/14（${total} 断言 + 矩阵 4 签名）`;
  console.log(`\n判据[mode ${mode}]：${shape} —— ${modeFailed ? '判据不满足 ❌' : '与《部署说明》§15.3 判据一致 ✅'}`);
  for (const [desc, ok] of checks) if (!ok) console.log(`  ✗ ${desc}`);
}

// 收尾：产物目录「只在失败时保留」。
// 这些目录是产品「证据一律落盘」约定的正常产出（readCases/cli_*/run_verify 都往里写），
// 全绿之后它们对使用者只是噪音 —— 尤其在部署副本里跑全量时会把树跑脏（发布口径见
// 部署说明 §15）。失败时一律保留：现场就是排查材料。
const ARTIFACT_DIRS = [
  '.playwright-artifacts',
  '.playwright-cli',
  'test-results',
  'demo/test-results',
  'demo/generated',
  'demo/generated-e2e',
  'demo/generated-orchestrated',
  'demo/generated-booltest',
  'demo/generated-argscheck',
  'mcp/py/__pycache__',
];
// 收割孤儿浏览器（无条件，先于产物清理）：套件各自 close 自己的会话，但失败/崩溃
// 路径会留下开着的会话与 headless 浏览器 —— 它们带文件句柄，会让随后的整树打包
// （distribute 的 rmSync）报 EPERM（实测踩过）。kill-all 只杀浏览器进程；
// 此时所有套件已出结论，不影响任何判定。
if (HAS_CLI) {
  try {
    const { runCli } = await import('../lib/cli.js');
    const reap = await runCli({ cwd: ROOT, session: 'verify-all-reap', subcommand: 'kill-all', args: [], timeoutMs: 30_000 });
    if (!reap.ok) console.log(`\n（收尾 kill-all 未成功：${reap.summary || reap.reason} —— 不影响判定，但可能留下孤儿浏览器）`);
  } catch { /* 收尾尽力而为：失败不影响判定 */ }
}

const present = ARTIFACT_DIRS.filter((d) => fs.existsSync(path.join(ROOT, d)));
if (failed.length || keepArtifacts) {
  console.log(`\n产物目录保留（${failed.length ? '存在失败，现场不清理' : '--keep-artifacts'}）${present.length ? `：${present.join('、')}` : '：无'}`);
} else if (!present.length) {
  console.log('\n产物目录：本次运行未产生');
} else {
  // Windows 上浏览器子进程可能短暂持有句柄导致 rmSync EPERM —— 稍候重试一次再认输。
  const leftovers = [];
  for (const d of present) {
    const p = path.join(ROOT, d);
    let gone = false;
    for (let i = 0; i < 2 && !gone; i++) {
      try { fs.rmSync(p, { recursive: true, force: true }); } catch { await new Promise((r) => setTimeout(r, 250)); }
      gone = !fs.existsSync(p);
    }
    if (!gone) leftovers.push(d);
  }
  if (leftovers.length) {
    console.log(`\n⚠ 产物清理未完全（文件被占用？）：${leftovers.join('、')} —— 可手动删除，不影响上面的结论`);
  } else {
    console.log(`\n产物目录已清理：${present.join('、')}（全绿；失败时自动保留现场，--keep-artifacts 强制保留）`);
  }
}
// 逐套件断言数漂移：日常（无 --mode）跑也要报 —— 「断言悄悄变少」没有理由只在验收态才拦。
if (countDrift.length) {
  console.log(`\n逐套件断言数与 suites.mjs 声明不一致（数字单一源）：`);
  for (const d of countDrift) console.log(`  ✗ ${d}`);
  console.log('  断言合法变更时：改 suites.mjs 声明 → 同步 README 套件表与 §15.3 判据行（H16/H22 会机械对账）');
}
process.exit(failed.length || modeFailed || countDrift.length ? 1 : 0);
