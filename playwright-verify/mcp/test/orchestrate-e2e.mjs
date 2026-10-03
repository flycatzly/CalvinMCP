/**
 * orchestrate-e2e.mjs — Excel 编排的端到端验证（真读表 → 真映射 → 真生成 → 真执行）
 *
 * 这是「手工用例表直接变可执行回归」这条链路的完整验收。
 * 之前只验到「读表 + 映射」（readOnly 模式），没验过生成与执行。
 *
 * 链路：demo/cases/e2e.xlsx（openpyxl 读）
 *      → 自然语言步骤映射成原子步骤
 *      → generate_scripts 生成 PO 分层脚本（带生成门禁）
 *      → 落盘 + 配一个 config
 *      → 真跑 Playwright（页面是本仓库自带的 demo/site/index.html，file:// 打开，离线可跑）
 *      → 解析 json 报告，确认真的通过
 *
 * 每一步都断言，所以任何一环坏掉都能定位到具体是「读表、映射、生成、门禁、执行」中的哪一个。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { orchestrate, readCases, caseToSteps, resolvePython } from '../lib/orchestrate.js';
import { runPlaywright, runToFiles, resolvePlaywrightRunner } from '../lib/runner.js';
import { summarizeFile } from '../lib/signature.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const INPUT = path.join(ROOT, 'demo/cases/e2e.xlsx');
const OUT = path.join(ROOT, 'demo/generated-e2e');

let failures = 0;
const log = (s) => process.stdout.write(`${s}\n`);
const check = (name, cond, extra = '') => {
  if (!cond) failures++;
  log(`${cond ? 'PASS ' : 'FAIL '} ${name}${extra ? `  ${extra}` : ''}`);
};

check('用例表存在', fs.existsSync(INPUT), INPUT);

/* ---- 1) 读表 ---- */
const read = await readCases(INPUT, { cwd: ROOT });
check('读表成功', read.ok, read.message || '');
check('读到 2 条用例', read.caseCount === 2, String(read.caseCount));
check('识别出「用例名称/步骤/预期结果/环境/账号」列',
  ['title', 'steps', 'expect', 'env', 'account'].every((k) => read.columns?.[k]),
  JSON.stringify(read.columns));

/* ---- 1b) 无 openpyxl 兜底：缺可选依赖时 Excel 链路必须降级可用 ---- */
// 强制禁用 openpyxl（PYTHONPATH 前置一个 import 即抛 ImportError 的假包），
// 逼 read_cases.py 走内置 zip+XML 解析。这条钉的是「零依赖承诺」：
// CI 容器与新机器的 Python 都没有 openpyxl，兜底一失效，Excel 链路在那里整条挂掉，
// 而且挂得像「环境没配好」，很容易被无限期搁置。
{
  const os = await import('node:os');
  const shim = fs.mkdtempSync(path.join(os.tmpdir(), 'pvmcp-shim-'));
  fs.writeFileSync(path.join(shim, 'openpyxl.py'), 'raise ImportError("blocked by fallback test")\n');
  const outJson = path.join(shim, 'out.json');
  const r = await runToFiles({
    command: resolvePython() || 'python',
    args: [path.join(ROOT, 'mcp', 'py', 'read_cases.py'), INPUT, '--out', outJson],
    cwd: ROOT,
    env: { PYTHONPATH: shim, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
    timeoutMs: 60_000,
    logDir: path.join(ROOT, '.playwright-artifacts', 'logs'),
    logName: 'read-cases-nofallback',
  });
  let fb = null;
  try { fb = JSON.parse(fs.readFileSync(outJson, 'utf8')); } catch { /* 断言会报无输出 */ }
  check('无 openpyxl 时内置解析兜底仍读到 2 条用例', fb?.caseCount === 2 && fb?.columns?.title,
    `exit=${r.code} caseCount=${fb?.caseCount ?? '(无输出)'} ${fb?.error || ''}`);
  fs.rmSync(shim, { recursive: true, force: true });
}

/* ---- 2) 映射 ---- */
for (const c of read.cases || []) {
  const m = caseToSteps(c);
  check(`「${c.title}」全部步骤可映射`, m.unmapped.length === 0,
    m.unmapped.length ? `无法映射：${m.unmapped.join(' / ')}` : `${m.steps.length} 步`);
  check(`「${c.title}」含至少一条断言`,
    m.steps.some((s) => s.act.startsWith('assert')),
    m.steps.map((s) => s.act).join(','));
}

/* ---- 3) 编排（生成 + 门禁 + 落盘），先不执行 ---- */
fs.rmSync(OUT, { recursive: true, force: true });
const rep = await orchestrate({
  input: INPUT, cwd: ROOT, outDir: OUT, run: false,
  pageName: 'demo', navPath: '/', specName: 'from-excel',
});
check('编排成功', rep.ok, rep.message || '');
check('生成门禁通过', rep.generate?.lint?.errorCount === 0 && rep.generate?.syntax === true,
  JSON.stringify(rep.generate));
check('脚本已落盘', rep.written?.written === true && rep.written.files.length >= 2,
  rep.written?.files?.map((f) => path.basename(f)).join(', '));
check('页面层与用例层分开', rep.generatedFiles.some((f) => f.startsWith('pages/'))
  && rep.generatedFiles.some((f) => f.startsWith('tests/')),
  rep.generatedFiles.join(', '));

const specName = rep.generatedFiles.find((f) => f.startsWith('tests/'));
const specPath = path.join(OUT, specName);
check('用例层文件存在', fs.existsSync(specPath), specPath);
const specSrc = fs.readFileSync(specPath, 'utf8');
check('用例层不内联定位细节', !/getBy\w+\(|locator\(/.test(specSrc));
check('用例层带「本用例证明」的说明', /本用例证明：/.test(specSrc));
check('页面层包含三段式方法（fill/click/断言）',
  /async fill\w*\(/.test(fs.readFileSync(path.join(OUT, rep.generatedFiles.find((f) => f.startsWith('pages/'))), 'utf8')));

/* ---- 4) 配一个 config 让它真能跑 ----
 * goto 的目标已经在用例里（file:// 绝对路径），所以这里不需要 baseURL 或 webServer。
 * 关掉重试，让「通过」是第一次就通过，而不是重试掩盖。 */
const configSrc = `/**
 * 编排产物的运行配置（由 orchestrate-e2e.mjs 生成，用于验证链路真的能跑）
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  testDir: './tests',
  timeout: 30_000,
  expect: { timeout: 5_000 },
  retries: 0,
  workers: 1,
  reporter: [
    ['list'],
    ['json', { outputFile: path.resolve(HERE, 'report.json') }],
  ],
  use: {
    actionTimeout: 5_000,
    trace: 'off',
  },
});
`;
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'playwright.config.ts'), configSrc, 'utf8');

/* ---- 5) 真执行 ---- */
// 真跑段需要执行层：缺可选依赖时诚实 SKIP（纯净包口径）——
// 读表/映射/生成/门禁/落盘（上面几步）不依赖 Playwright，照常验收。
if (!resolvePlaywrightRunner(ROOT)) {
  log('\nSKIP  真跑编排产物与报告确认（缺可选依赖 @playwright/test：纯净包口径 —— 可选依赖由被测项目/本机提供）');
} else {
  log('\n--- 真跑编排产物 ---');
  const res = await runPlaywright({
    cwd: ROOT,
    args: ['--config', path.join(OUT, 'playwright.config.ts')],
    timeoutMs: 180_000,
    logDir: path.join(ROOT, '.playwright-artifacts', 'logs'),
  });
  check('Playwright 执行完成（退出码 0）', res.code === 0,
    `exit=${res.code}，日志 ${res.stdoutFile}`);
  if (res.code !== 0) {
    log('\n输出尾部：');
    log((res.stdout || '').split('\n').filter((l) => l.trim()).slice(-25).join('\n'));
  }

  /* ---- 6) 报告确认 ---- */
  const reportFile = path.join(OUT, 'report.json');
  if (fs.existsSync(reportFile)) {
    const s = summarizeFile(reportFile);
    check('报告显示全部通过', s.totals.failed === 0 && s.totals.passed >= 2,
      `通过 ${s.totals.passed} / 失败 ${s.totals.failed}`);
    check('没有偶发（retries=0，通过就是真通过）', s.totals.flaky === 0, `偶发 ${s.totals.flaky}`);
  } else {
    check('生成 json 报告', false, reportFile);
  }
}

log('');
log(failures === 0 ? 'Excel 编排端到端验证全部通过 ✅' : `${failures} 项失败 ❌`);
process.exit(failures === 0 ? 0 : 1);
