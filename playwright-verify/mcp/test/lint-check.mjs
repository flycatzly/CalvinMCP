/**
 * lint-check.mjs — 用三份样例集 + 结构边界 + 对抗语料验证扫描器
 *
 * 期望（对应原文的验收标准）：
 *   clean.spec.ts   → ERROR 0 / WARN 0    合格写法不报（不冤枉人）
 *   messy.spec.ts  → ERROR 9 / WARN 12   坏味道全中
 *   tricky.spec.ts → ERROR 0 / WARN 0    陷阱不误报
 *
 * 注意 messy 的最低要求：**test.only 那一条必须被扫描到**（原文缺陷 1 的回归钉子）。
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import { lintSource, RULES, adversarialCorpus } from '../lib/lint.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const demo = path.resolve(__dirname, '../../demo/tests');

const EXPECT = {
  'clean.spec.ts': { error: 0, warn: 0, tests: 3 },
  // tricky 里的用例都是真的可执行用例（3 条），另有一个容器。
  // 这里同时钉住「0 ERROR / 0 WARN」**与「用例数确实被扫出来」**——
  // 只钉告警数会漏掉「一条都没扫到」这种静默失明：
  // 曾经因为模板串插值把整个文件标成字符串，用例数直接变 0 而三条断言全绿。
  'tricky.spec.ts': { error: 0, warn: 0, tests: 3 },
  // messy 的 ERROR 数是 9：其中 2 条是 PW001（`page.waitForTimeout`）。
  // 注意这个数字曾经是 6 —— 因为 PW001 的正则排除了点号，**漏掉了 `page.` 形态**，
  // 而其余规则把总数填满了，计数看起来"正常"。修好判据后立刻变多。
  // 教训：只钉总数是不够的，必须同时钉**具体规则是否命中**（见下面的逐规则断言）。
  // WARN 数是 12：曾经 11 —— PW013 只认 `timeout:`/`timeout=` 选项形态，
  // 夹具里 37 行的 `test.setTimeout(300_000)`（调用形态）一直漏报，修好后 +1。
  'messy.spec.ts': { error: 9, warn: 12, tests: 4, mustIncludeTests: 4, expectIds: ['PW001', 'PW002', 'PW003', 'PW004', 'PW005', 'PW006', 'PW007'] },
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

/* ------------------------------------------------------------------ *
 * 对抗语料：规则误报/漏报的边界回归
 *
 * 三份样例集钉的是「整体像不像样」，但每条规则的**判据边界**没有回归保护 ——
 * 改一次正则就可能悄悄放宽或收紧，而总数照样「看起来正常」（PW001 的教训）。
 * 这里按「一条边界一个钉子」的方式补上：每个用例钉「必须命中」或「必须不冤枉」的规则 id。
 *
 * 9 条实证洞钉（改判据前是红的）+ 9 条边界守卫（改判据前后都绿，防修过头）。
 * 判定形态：把 src 包进一条标准用例体，避免夹具上下文波动干扰判据。
 * ------------------------------------------------------------------ */
const ADV_WRAP = (src) => `test('t', async ({ page }) => {\n${src}\n  await expect(page.getByTestId('z')).toBeVisible();\n});`;

const ADV_CASES = [
  // ---- 实证洞钉：这些形态在 2026-10 的对抗探针里确认过漏报/误报 ----
  {
    name: 'PW002 漏报洞：test.describe.only( 链式形态（describe 前是点号，被旧前缀类挡住）',
    src: `test.describe.only('组', () => {});`,
    expectIds: ['PW002'], forbidIds: ['PW007'],
  },
  {
    name: 'PW002 漏报洞：test.describe.serial.only( 链式修饰形态',
    src: `test.describe.serial.only('组', () => {});`,
    expectIds: ['PW002'], forbidIds: ['PW007'],
  },
  {
    name: 'PW008 漏报洞：链式接收者 page.locator(\'#x\').isVisible()（旧正则不跨调用后缀）',
    src: `if (!await page.locator('#x').isVisible()) {\n    throw new Error('真失败');\n  }`,
    expectIds: ['PW008'],
  },
  {
    name: 'PW008 漏报洞：括号形态 !(await x.isVisible())',
    src: `if (!(await page.locator('#x').isVisible())) {\n    throw new Error('真失败');\n  }`,
    expectIds: ['PW008'],
  },
  {
    name: 'PW013 漏报洞：test.setTimeout(300_000) 调用形态（旧正则只认 timeout:/timeout=）',
    src: `test.setTimeout(300_000);`,
    expectIds: ['PW013'],
  },
  {
    name: 'PW106 误报洞：waitForSelector(\'.x\') 有参等待不算空等待（实参判据要看保留字符串）',
    src: `await page.waitForSelector('.x');`,
    forbidIds: ['PW106'],
  },
  {
    name: 'PW006 漏报洞：同行前缀劫持 await goto(); expect(...)（那个 await 属于 goto）',
    src: `await page.goto('/x'); expect(page.getByTestId('y')).toBeVisible();`,
    expectIds: ['PW006'],
  },
  {
    name: 'PW006 漏报洞：跨行未 await 断言（prettier 折行后行级正则失明）',
    src: `expect(\n    page.getByTestId('y')\n  ).toBeVisible();`,
    expectIds: ['PW006'],
  },
  {
    name: 'PW006 误报洞：变量接走 promise 再 await（两行分开时旧式整行 /await/ 会冤枉）',
    src: `const p = expect(page.getByTestId('y')).toBeVisible();\n  await p;`,
    forbidIds: ['PW006'],
  },

  // ---- 边界守卫：修判据时最容易修过头的地方，前后都必须绿 ----
  {
    name: 'PW002 守卫：mytest.only( 不冤枉（前缀类必须继续挡住标识符尾缀）',
    src: `mytest.only('a', () => {});`,
    forbidIds: ['PW002'],
  },
  {
    name: 'PW002/PW007 守卫：普通 test.describe( 容器不冤枉（空容器不是无断言用例）',
    src: `test.describe('组', () => {});`,
    forbidIds: ['PW002', 'PW007'],
  },
  {
    name: 'PW008 守卫：简单接收者 !await panel.isVisible() 仍命中（原形态不能回归）',
    src: `if (!await panel.isVisible()) {\n    throw new Error('真失败');\n  }`,
    expectIds: ['PW008'],
  },
  {
    name: 'PW006 守卫：同步值断言不 await 是正确的（requireAsyncSource 闸门不许松）',
    src: `const amount = '¥99.00';\n  expect(amount).toBe('¥99.00');`,
    forbidIds: ['PW006'],
  },
  {
    name: 'PW006 守卫：同行 await expect(...) 不冤枉（正向 await 判定不许坏）',
    src: `await expect(page.getByTestId('y')).toBeVisible();`,
    forbidIds: ['PW006'],
  },
  {
    name: 'PW013 守卫：test.setTimeout(30_000) 短超时不冤枉（阈值判据不许退回数位数）',
    src: `test.setTimeout(30_000);`,
    forbidIds: ['PW013'],
  },
  {
    name: 'PW013 守卫：选项形态 { timeout: 30_000 } 短超时不冤枉',
    src: `await page.locator('#x').click({ timeout: 30_000 });`,
    forbidIds: ['PW013'],
  },
  {
    name: 'PW106 守卫：waitForSelector() 真空参仍命中（原判据不能回归）',
    src: `await page.waitForSelector();`,
    expectIds: ['PW106'],
  },
  {
    name: 'PW106 守卫：注释伪装的 waitForSelector() 不冤枉（脱敏在前不许漏）',
    src: `// await page.waitForSelector();\n  await page.waitForLoadState('load');`,
    forbidIds: ['PW106'],
  },
];

for (const c of ADV_CASES) {
  let r;
  try {
    r = lintSource(ADV_WRAP(c.src), 'adv.spec.ts');
  } catch (e) {
    failures++;
    log(`FAIL  对抗语料 · ${c.name}\n        THREW ${e.message}`);
    continue;
  }
  const fired = new Set(r.findings.map((f) => f.id));
  const missing = (c.expectIds || []).filter((id) => !fired.has(id));
  const wronged = (c.forbidIds || []).filter((id) => fired.has(id));
  const ok = missing.length === 0 && wronged.length === 0;
  if (!ok) failures++;
  log(`${ok ? 'PASS ' : 'FAIL '} 对抗语料 · ${c.name}`
    + (missing.length ? ` · 漏报 ${missing.join(',')}` : '')
    + (wronged.length ? ` · 冤枉 ${wronged.join(',')}` : '')
    + (!ok ? ` · 实际命中 ${[...fired].join(',') || '空'}` : ''));
}

log('');

/* ------------------------------------------------------------------ *
 * 属性化语料（v1.8.13）：每条规则自带 bad/good，随规则表走（单一源）。
 * 手写 ADV_CASES 钉「咬过人的洞」；这里钉「每条规则的判据边界」——
 * bad 必须命中自己（漏报=红），good 不许命中自己（冤枉=红），真 lint 跑。
 * ------------------------------------------------------------------ */
log('=== 属性化对抗语料：每条规则 bad 命中 / good 不冤枉（覆盖门见 rules-check） ===');
{
  const corpus = adversarialCorpus();
  const byId = new Map();
  for (const c of corpus) {
    const r = lintSource(c.raw ? c.src : ADV_WRAP(c.src), `attr-${c.id}-${c.kind}.spec.ts`);
    const fired = new Set(r.findings.map((f) => f.id));
    const missing = (c.expectIds || []).filter((id) => !fired.has(id));
    const wronged = (c.forbidIds || []).filter((id) => fired.has(id));
    byId.set(`${c.id}:${c.kind}`, { ok: missing.length === 0 && wronged.length === 0, missing, wronged, fired: [...fired] });
  }
  for (const rule of RULES) {
    const bad = byId.get(`${rule.id}:bad`);
    const good = byId.get(`${rule.id}:good`);
    const ok = !!bad?.ok && !!good?.ok;
    if (!ok) failures++;
    log(`${ok ? 'PASS ' : 'FAIL '} 属性化语料 · ${rule.id}（${rule.title}）`
      + (!bad || !good ? ' · 语料缺失（bad/good 必须成对）' : '')
      + (bad && !bad.ok ? ` · bad 漏报（实际命中 ${bad.fired.join(',') || '空'}）` : '')
      + (good && !good.ok ? ` · good 冤枉（实际命中 ${good.fired.join(',') || '空'}）` : ''));
  }
  const covered = RULES.every((r) => r.samples?.bad && r.samples?.good) && corpus.length === RULES.length * 2;
  if (!covered) failures++;
  log(`${covered ? 'PASS ' : 'FAIL '} 属性化语料覆盖门：每条规则都带 bad+good（新规则不带语料进不了表）`
    + ` · ${corpus.length} 案 = ${RULES.length} 规则 × 2`);
}

log('');
log(failures === 0 ? '全部样例符合预期 ✅' : `${failures} 项不符合预期 ❌`);
process.exit(failures === 0 ? 0 : 1);
