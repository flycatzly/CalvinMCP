/**
 * lint-check.mjs — 用三份样例集验证扫描器
 *
 * 期望（对应原文的验收标准）：
 *   clean.spec.ts   → ERROR 0 / WARN 0    合格写法不报（不冤枉人）
 *   messy.spec.ts  → ERROR 6 / WARN 11   坏味道全中
 *   tricky.spec.ts → ERROR 0 / WARN 0    陷阱不误报
 *
 * 注意 messy 的最低要求：**test.only 那一条必须被扫描到**（原文缺陷 1 的回归钉子）。
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import { lintSource, RULES } from '../lib/lint.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const demo = path.resolve(__dirname, '../../demo/tests');

const EXPECT = {
  'clean.spec.ts': { error: 0, warn: 0, tests: 3 },
  // tricky 里的用例都是真的可执行用例（3 条），另有一个容器。
  // 这里同时钉住「0 ERROR / 0 WARN」**与「用例数确实被扫出来」**——
  // 只钉告警数会漏掉「一条都没扫到」这种静默失明：
  // 曾经因为模板串插值把整个文件标成字符串，用例数直接变 0 而三条断言全绿。
  'tricky.spec.ts': { error: 0, warn: 0, tests: 3 },
  // messy 的 ERROR 数是 8：其中 2 条是 PW001（`page.waitForTimeout`）。
  // 注意这个数字曾经是 6 —— 因为 PW001 的正则排除了点号，**漏掉了 `page.` 形态**，
  // 而其余规则把总数填满了，计数看起来"正常"。修好判据后立刻变成 8。
  // 教训：只钉总数是不够的，必须同时钉**具体规则是否命中**（见下面的逐规则断言）。
  'messy.spec.ts': { error: 9, warn: 11, tests: 4, mustIncludeTests: 4, expectIds: ['PW001', 'PW002', 'PW003', 'PW004', 'PW005', 'PW006', 'PW007'] },
};

let failures = 0;
const log = (s) => process.stdout.write(`${s}\n`);

for (const [name, exp] of Object.entries(EXPECT)) {
  const file = path.join(demo, name);
  if (!fs.existsSync(file)) { log(`SKIP  ${name}（文件不存在）`); failures++; continue; }
  const src = fs.readFileSync(file, 'utf8');
  const r = lintSource(src, name);
  const errors = r.findings.filter((f) => f.severity === 'ERROR');
  const warns = r.findings.filter((f) => f.severity === 'WARN');

  const okE = exp.error === undefined || errors.length === exp.error;
  const okW = exp.warn === undefined || warns.length === exp.warn;
  const wantTests = exp.tests ?? exp.mustIncludeTests;
  const okT = wantTests === undefined || r.tests === wantTests;
  // 逐规则断言：总数对上不代表每条规则都活着。
  // PW001 曾经因为正则排除点号而静默失效，总数却被别的规则填满 —— 只有按 id 断言才抓得到。
  const gotIds = new Set(r.findings.map((f) => f.id));
  const missedIds = (exp.expectIds || []).filter((id) => !gotIds.has(id));
  const okI = missedIds.length === 0;
  const pass = okE && okW && okT && okI;
  if (!pass) failures++;

  log(`${pass ? 'PASS ' : 'FAIL '} ${name}  ERROR ${errors.length}/${exp.error ?? '-'} · WARN ${warns.length}/${exp.warn ?? '-'} · 用例 ${r.tests}${wantTests !== undefined ? `/${wantTests}` : ''}`
    + (missedIds.length ? ` · 漏报规则 ${missedIds.join(',')}` : ''));
  for (const f of r.findings) {
    log(`        ${f.severity === 'ERROR' ? 'ERROR' : 'WARN '} ${f.id}:${f.line}  ${f.title}`);
    log(`        证据: ${f.evidence.trim().slice(0, 110)}`);
  }
  // 回归钉子：test.only 那条用例必须出现在扫描结果里，否则缺陷 1 复发
  if (exp.mustIncludeTests && !r.testNames.some((t) => t.includes('下单主流程'))) {
    log('        !! 缺陷 1 复发：test.only 的用例整块没被扫描到');
    failures++;
  }
}

log('');
log(`规则表：共 ${RULES.length} 条（ERROR ${RULES.filter((r) => r.severity === 'ERROR').length} / WARN ${RULES.filter((r) => r.severity === 'WARN').length}）`);

/* ------------------------------------------------------------------ *
 * 结构解析的边界回归
 *
 * 这三条钉的是「用例体范围」这个最容易错、且错了会大面积误报的地方：
 *   1) 解构参数 `async ({ page }) => {}` 的第一个 { 是参数，不是函数体。
 *      判错会让所有断言检查失效 → 每条用例都被误报「没有断言」。
 *   2) 参数列表里可以再写箭头函数，所以找箭头必须只认顶层那个。
 *   3) 表达式体（`=> test.step(...)`）没有自己的花括号；
 *      若放宽成「箭头后第一个 {」，会把内层 step 的括号当成外层用例的体，
 *      PW007 就会拿内层的断言去判断外层，误报。
 * ------------------------------------------------------------------ */
const STRUCT_CASES = [
  {
    name: '解构参数不被当成函数体',
    src: `test('a', async ({ page }) => {
  await expect(page.getByTestId('ok')).toBeVisible();
});`,
    expectTests: 1, expectNoFindings: true,
  },
  {
    name: '参数列表里的嵌套箭头不影响函数体定位',
    src: `test('a', async ({ page, request }) => {
  const r = await request.get('/x');
  await expect(page.getByTestId('ok')).toHaveText(
    [1, 2].map((n) => String(n)).join(',')
  );
});`,
    expectTests: 1, expectNoFindings: true,
  },
  {
    name: '表达式体 + 内层 test.step 不产生误报',
    src: `test('a', async ({ page }) =>
  test.step('s', async () => {
    await page.goto('/x');
    await expect(page.getByTestId('ok')).toBeVisible();
  }));`,
    // 表达式体的用例本身不登记为用例块（它没有花括号体），内层 step 登记为容器。
    // 关键是**不产生 PW007 误报** —— 之前会把内层花括号当外层用例体，然后拿内层断言判断外层。
    expectTests: 0, expectNoFindings: true,
  },
  {
    name: '多行 await expect 仍被认作有断言',
    src: `test('a', async ({ page }) => {
  await expect(
    page.getByRole('cell', { name: '状态' })
  ).toHaveText('已结算');
});`,
    expectTests: 1, expectNoFindings: true,
  },
  // ---- 词法健壮性：这些形态都真实存在于测试代码里，判错会「静默失明」或「挂死」 ----
  {
    name: 'URL 正则里的 // 不被当成注释（否则整行后续代码消失）',
    src: `test('a', async ({ page }) => {
  const urlRe = /https?:\\/\\//;
  await page.goto('/x');
  await expect(page.getByTestId('ok')).toHaveText(String(urlRe.test('https://a')));
});`,
    expectTests: 1, expectNoFindings: true,
  },
  {
    name: 'return 后接花括号正则，花括号配平不被搞乱',
    src: `test('a', async ({ page }) => {
  function hasBrace(x) { return /}/.test(x); }
  await expect(page.getByTestId('ok')).toHaveText(String(hasBrace('}')));
});`,
    expectTests: 1, expectNoFindings: true,
  },
  {
    name: '模板串插值不吞掉后续代码（含嵌套插值）',
    src: `test(\`case \${1}\`, async ({ page }) => {
  const label = \`订单 \${ { a: 1 }.a } \${ \`嵌套\` }\`;
  await expect(page.getByTestId('ok')).toHaveText(label);
});`,
    expectTests: 1, expectNoFindings: true,
  },
  {
    name: '只给用例名的 test.skip 仍判为静默跳过（名字不是理由）',
    src: `test.skip('被跳过的用例名');
test('a', async ({ page }) => {
  await expect(page.getByTestId('ok')).toBeVisible();
});`,
    expectTests: 1, expectIds: ['PW103'],
  },
  {
    name: '带理由+单号的 test.skip 不报（规范写法不该被冤枉）',
    src: `test.skip(true, 'ISSUE-123 等待接口修复');
test('a', async ({ page }) => {
  await expect(page.getByTestId('ok')).toBeVisible();
});`,
    expectTests: 1, expectNoFindings: true,
  },
  {
    name: '条件式 test.skip 不报（它不是"缺理由"）',
    src: `test.skip(process.env.CI === 'true');
test('a', async ({ page }) => {
  await expect(page.getByTestId('ok')).toBeVisible();
});`,
    expectTests: 1, expectNoFindings: true,
  },
  {
    name: '极端输入不崩也不挂（未闭合结构）',
    src: `/* 未闭合块注释
const re = /abc
test('a', async ({`,
    expectAny: true,
  },
];

for (const c of STRUCT_CASES) {
  const t0 = Date.now();
  let r;
  try {
    r = lintSource(c.src, 'struct.spec.ts');
  } catch (e) {
    failures++;
    log(`FAIL  结构解析 · ${c.name}\n        THREW ${e.message}`);
    continue;
  }
  const ms = Date.now() - t0;
  const errs = r.findings.filter((f) => f.severity === 'ERROR');

  if (c.expectAny) {
    // 只要求「不崩、不挂、不超时」
    const ok = ms < 2000;
    if (!ok) failures++;
    log(`${ok ? 'PASS ' : 'FAIL '} 结构解析 · ${c.name}  用时 ${ms}ms（不崩不挂）`);
    continue;
  }

  const okT = c.expectTests === undefined || r.tests === c.expectTests;
  const okF = !c.expectNoFindings || errs.length === 0;
  const okIds = !c.expectIds || c.expectIds.every((id) => r.findings.some((f) => f.id === id));
  const ok = okT && okF && okIds;
  if (!ok) failures++;
  log(`${ok ? 'PASS ' : 'FAIL '} 结构解析 · ${c.name}`
    + `  用例 ${r.tests}/${c.expectTests ?? '-'} · ERROR ${errs.length}`
    + (errs.length ? `\n        ${errs.map((f) => `${f.id}:${f.line} ${f.title}`).join(' | ')}` : '')
    + (c.expectIds ? ` · 命中 ${r.findings.map((f) => f.id).join(',')}` : ''));
}

log('');
log(failures === 0 ? '全部样例符合预期 ✅' : `${failures} 项不符合预期 ❌`);
process.exit(failures === 0 ? 0 : 1);
