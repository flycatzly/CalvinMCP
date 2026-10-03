#!/usr/bin/env node
/**
 * verify-all.mjs — 一键跑完全部回归测试
 *
 * 用法：node mcp/test/verify-all.mjs [--with-browser]
 *
 * 为什么要有这个入口：
 *   门禁的公信力是它唯一的资产。改一行规则就可能冤枉一批用例，
 *   所以「改完必须一键跑全绿」这件事必须足够便宜，便宜到没人有理由跳过。
 *
 * --with-browser 会额外跑真实浏览器回归（约 30 秒，需要已装浏览器）。
 * 默认不跑，因为无浏览器的环境（CI 容器）也应该能验证核心判定逻辑。
 */
import path from 'node:path';
import os from 'node:os';
import { spawnSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const argv = process.argv.slice(2);
const withBrowser = argv.includes('--with-browser');
const parallel = argv.includes('--parallel') || argv.includes('--concurrent');

const SUITES = [
  { name: '扫描器（三份样例集）', file: 'mcp/test/lint-check.mjs', note: 'clean 不冤枉 / messy 全中 / tricky 不误报' },
  { name: '归因（缺陷 4 回归）', file: 'mcp/test/signature-check.mjs', note: 'ANSI 清洗幂等、断言不被误归成超时、6 条压成 4 个签名' },
  { name: '生成器', file: 'mcp/test/generate-check.mjs', note: '门禁、PO 分层、方法名、占位符、脆弱选择器' },
  { name: 'MCP 协议与工具面', file: 'mcp/test/protocol-check.mjs', note: '握手、版本协商、13 个工具、错误语义、真实 stdio' },
  { name: '规则表一致性', file: 'mcp/test/rules-check.mjs', note: '规则 id 唯一、文档与实际规则表不漂移' },
  // 加固套件来自一次对抗性审计：专钉「不报错但结论错」的静默失效
  { name: '加固（静默失效/反转/覆盖/篡改）', file: 'mcp/test/hardened-check.mjs', note: 'H1–H17：规则静默失效、数据篡改、模板串吞代码、静默覆盖、落盘绕过、配置误判、环境失败不漏成 unknown、智能体线守门' },
  { name: 'CLI 真实交互与落盘', file: 'mcp/test/cli-e2e.mjs', note: 'Ref 交互、fill/click 生效、产物落盘、PNG 魔数、白名单', browser: true },
  { name: 'Excel 编排端到端', file: 'mcp/test/orchestrate-e2e.mjs', note: '读表 → 映射 → 生成门禁 → 落盘 → 真跑通过', browser: true },
  { name: '参数规范化与产物命名', file: 'mcp/test/args-check.mjs', note: '布尔不静默反转、非法值报错、并发产物不互相覆盖', browser: true },
  // 智能体线（自然语言声明式测试）：无浏览器套验 LLM 协议回环与守门，浏览器套验真执行
  { name: '智能体线（LLM 回环/守门/计划契约）', file: 'mcp/test/nl-agent-check.mjs', note: 'stub LLM 真 HTTP 回环、危险目标拒绝、白名单不静默丢弃、死链坏图判定' },
  { name: '智能体线端到端（真浏览器）', file: 'mcp/test/nl-agent-e2e.mjs', note: 'LLM 规划→goto/fill/click/断言/截图真执行、降级骨架、Fail 语义、巡检', browser: true },
  // 部署副本验证必须**排在最后**：它比对整棵树，任何仍在写盘（或刚写完还在落盘）的套件都会让它报假漂移。
  // 实测：排在中间时，紧跟 install 之后的第一次全量会假失败一次、第二次就正常 —— 典型的顺序竞态。
  // 一个会假失败的门禁比一个慢的门禁危险得多，所以这里用顺序把它钉死。
  { name: '部署副本验证（须最后跑）', file: 'mcp/test/deployed-check.mjs', note: '装完的副本能发现工具、真能调用、与源码逐文件一致（未安装时自动 SKIP）' },
];

const results = [];
console.log('playwright-verify-mcp 全量回归');
console.log(`项目根：${ROOT}`);
console.log(`浏览器回归：${withBrowser ? '开启' : '跳过需要浏览器的套件（加 --with-browser 开启）'}`);
console.log(`执行方式：${parallel ? '并发（--parallel，见下方警告）' : '串行（默认）'}\n`);

// 并发为什么**默认关闭**（这是实测教训，不是保守）：
//   这些套件并非彼此独立，至少四处会互相踩：
//     1) CLI 相关套件用**固定的会话名**（healthcheck / e2e-*），并发时抢同一个浏览器会话；
//     2) 都往 .playwright-artifacts/ 写日志与产物，并发时互相覆盖现场；
//     3) demo/generated-* 被编排套件写入，而生成器套件也在读同一批样例；
//     4) 部署副本验证在**比对整棵树**，任何并发写入都会让它报出假漂移。
//   实测把并发打开后，三轮结果分别是 4/10、8/10、9/10 通过 —— **会假失败**。
//   一个会假失败的门禁，比一个慢的门禁危险得多：人一旦被冤枉过，就会开始忽略它。
//   所以并发只在显式 --parallel 时启用，并附警告。
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
      resolve({ ...s, ok: false, detail: '测试文件不存在' });
      return;
    }
    if (s.browser && !withBrowser) {
      resolve({ ...s, ok: true, skipped: true, detail: 'SKIP（需要 --with-browser）' });
      return;
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
    child.on('error', (e) => settle(() => resolve({ ...s, ok: false, detail: `启动失败：${e.message}` })));
    child.on('close', (code) => settle(() => {
      const text = `${out}${err}`;
      const failed = text.split('\n').filter((l) => l.trim().startsWith('FAIL'));
      const ok = code === 0;
      const passCount = text.split('\n').filter((l) => l.trim().startsWith('PASS')).length;
      resolve({
        ...s, ok,
        detail: ok ? `全部通过（${passCount} 项断言）` : `${failed.length || '?'} 项失败（退出码 ${code}）`,
        failedLines: ok ? [] : failed.map((l) => l.trim()),
        seconds: Math.round((Date.now() - started) / 100) / 10,
      });
    }));
  });
}

// 串行（默认）或并发（显式 --parallel）
const settled = parallel
  ? await Promise.all(SUITES.map(runSuite))
  : await (async () => {
    const out = [];
    for (const s of SUITES) out.push(await runSuite(s));
    return out;
  })();
results.push(...settled);

for (const r of settled) {
  if (r.skipped) { console.log(`− ${r.name} — ${r.detail}\n`); continue; }
  console.log(`${r.ok ? '✓' : '✗'} ${r.name} — ${r.detail}（${r.seconds ?? '?'}s）`);
  for (const l of r.failedLines.slice(0, 12)) console.log(`    ${l}`);
  if (!r.ok) console.log('');
}

// 可选：真实浏览器回归（验证执行层与报告聚类在真数据上成立）
if (withBrowser) {
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
  results.push({ name: '真实浏览器回归矩阵', ok, detail });
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
process.exit(failed.length ? 1 : 0);
