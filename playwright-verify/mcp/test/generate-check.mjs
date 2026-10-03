/**
 * generate-check.mjs — 生成器回归测试
 *
 * 钉死的性质（每一条都对应一个踩过的坑）：
 *   1) 生成物通过静态门禁（语法 + lint ERROR 0）才允许写盘 —— 「脚本还没跑通就提交」是这条流程最容易踩的坑。
 *   2) 页面层 / 用例层分离，且用例层只调用页面层方法，不内联定位细节。
 *   3) 方法名必须 ASCII、唯一、且带可读语义前缀 ——
 *      中文名字不能塌成 fill/fill2，也不能只剩一个裸哈希。
 *   4) 未解析的占位符必须在生成前报错，而不是当字面量写进脚本。
 *   5) 脆弱选择器（裸 XPath / nth-child）在生成阶段就被拒绝，不给「先写坏再修」的机会。
 *   6) 断言写在页面对象里时，用例层不会因为「本用例没有 expect」被门禁误挡。
 */
import { generate, writeGenerated, locatorExpr, normalizeSteps } from '../lib/generate.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

let failures = 0;
const log = (s) => process.stdout.write(`${s}\n`);
const check = (name, cond, extra = '') => {
  if (!cond) failures++;
  log(`${cond ? 'PASS ' : 'FAIL '} ${name}${extra ? `  ${extra}` : ''}`);
};
const throws = (name, fn) => {
  try { fn(); failures++; log(`FAIL  ${name}（本该报错却通过了）`); } catch (e) { log(`PASS  ${name}  → ${e.message.slice(0, 80)}`); }
};

const baseInput = {
  spec: 'checkout',
  pages: [
    {
      name: 'login',
      navPath: '/login',
      steps: [
        { act: 'fill', locator: { kind: 'label', text: '账号' }, value: 'u1' },
        { act: 'fill', locator: { kind: 'label', text: '密码' }, value: 'secret_sauce' },
        { act: 'click', locator: { kind: 'role', role: 'button', name: '登录' } },
        { act: 'assertVisible', locator: { kind: 'testid', id: 'user-menu' } },
      ],
    },
    {
      name: 'checkout',
      navPath: '/checkout',
      steps: [
        { act: 'click', locator: { kind: 'role', role: 'button', name: '去结算' } },
        { act: 'assertText', locator: { kind: 'testid', id: 'order-amount' }, expect: '¥99.00' },
      ],
    },
  ],
  cases: [
    {
      title: '登录后下单单件商品',
      page: 'login',
      claims: '证明 u1 在 test 环境登录成功',
      steps: [
        { act: 'fill', locator: { kind: 'label', text: '账号' }, value: 'u1' },
        { act: 'click', locator: { kind: 'role', role: 'button', name: '登录' } },
        { act: 'assertVisible', locator: { kind: 'testid', id: 'user-menu' } },
      ],
    },
    {
      title: '结算页金额等于 99 元',
      page: 'checkout',
      claims: '证明加购 SKU_A 后结算金额为 99 元',
      steps: [{ act: 'assertText', locator: { kind: 'testid', id: 'order-amount' }, expect: '¥99.00' }],
    },
  ],
};

/* ---- 1. 门禁 + 分离 ---- */
const r = generate(baseInput);
check('生成物通过静态门禁', r.lint.passed && r.syntax.passed, r.verdict);
check('语法门禁通过', r.syntax.results.every((s) => s.ok),
  r.syntax.results.filter((s) => !s.ok).map((s) => `${s.label}: ${s.error}`).join(' | '));
check('生成 3 个文件（2 页面层 + 1 用例层）', r.files.length === 3, r.files.map((f) => f.path).join(', '));
check('页面层与用例层分目录', r.files.some((f) => f.path.startsWith('pages/')) && r.files.some((f) => f.path.startsWith('tests/')));
const spec = r.files.find((f) => f.path.startsWith('tests/')).content;
const loginPo = r.files.find((f) => f.path.includes('LoginPage')).content;
check('用例层不内联定位细节', !/getBy\w+\(|locator\(/.test(spec), spec.split('\n').filter((l) => /locator\(|getBy/.test(l)).join('|'));
check('用例层调用页面层方法', /await loginPage\.\w+\(\);/.test(spec));
check('断言留在页面层', /await expect\(this\.page\.getByTestId\('user-menu'\)\)\.toBeVisible\(\)/.test(loginPo));
check('页面层用 this.page', !/(?<!this\.)\bpage\.getBy/.test(loginPo));

/* ---- 2. 交付契约：每条用例必须有「证明了什么」 ---- */
check('每条用例都有 claims 说明', r.claims.length === 2 && r.claims.every((c) => c.claims && !c.claims.startsWith('（未声明')));
const noClaims = generate({ ...baseInput, cases: baseInput.cases.map((c) => ({ ...c, claims: undefined })) });
check('缺 claims 时给出明确占位提示', noClaims.claims.every((c) => c.claims.includes('未声明')));

/* ---- 3. 方法名：ASCII + 唯一 + 可读 ---- */
const methodNames = [...loginPo.matchAll(/async (\w+)\(/g)].map((m) => m[1]);
check('方法名全为 ASCII', methodNames.every((n) => /^[A-Za-z_$][\w$]*$/.test(n)), methodNames.join(', '));
check('方法名互不重复', new Set(methodNames).size === methodNames.length, methodNames.join(', '));
check('方法名没有塌成 fill/fill2', !methodNames.includes('fill'), methodNames.join(', '));
check('方法名带可读语义前缀', methodNames.some((n) => n.startsWith('fill')), methodNames.join(', '));
check('纯 ASCII 名称不加哈希', /async expectVisibleUserMenu\(/.test(loginPo), methodNames.join(', '));

/* ---- 4. 占位符必须报错 ---- */
throws('未解析占位符 ${PW} 被拒绝', () => generate({
  ...baseInput,
  pages: [{ ...baseInput.pages[0], steps: [{ act: 'fill', locator: { kind: 'label', text: '账号' }, value: '${PW}' }] }],
}));
throws('未解析占位符 {{password}} 被拒绝', () => generate({
  ...baseInput,
  pages: [{ ...baseInput.pages[0], steps: [{ act: 'fill', locator: { kind: 'label', text: '账号' }, value: '{{password}}' }] }],
}));

/* ---- 5. 脆弱选择器在生成阶段被拒绝 ---- */
throws('裸 XPath 被拒绝', () => locatorExpr({ kind: 'selector', selector: '//div[@id="app"]/span[2]' }));
throws('nth-child 被拒绝', () => locatorExpr({ kind: 'selector', selector: 'ul > li:nth-child(3)' }));
check('role 定位生成 getByRole', locatorExpr({ kind: 'role', role: 'button', name: '提交' }) === "page.getByRole('button', { name: '提交' })");
check('testid 定位生成 getByTestId', locatorExpr({ kind: 'testid', id: 'order-amount' }) === "page.getByTestId('order-amount')");

/* ---- 6. 动作名大小写/分隔符不敏感 ---- */
check('动作名归一（assert_visible）', normalizeSteps([{ act: 'assert_visible', locator: { kind: 'text', text: 'x' } }])[0].act === 'assertVisible');
check('动作名归一（ASSERTVISIBLE）', normalizeSteps([{ act: 'ASSERTVISIBLE', locator: { kind: 'text', text: 'x' } }])[0].act === 'assertVisible');
throws('未知动作被拒绝', () => normalizeSteps([{ act: 'teleport' }]));

/* ---- 7. PO 断言不触发 PW007 误报 ---- */
check('用例层无直接 expect 却被判为 WARN 而非 ERROR',
  r.lint.errorCount === 0 && r.lint.files.some((f) => f.findings.some((x) => x.id === 'PW007' && x.severity === 'WARN')),
  JSON.stringify(r.lint.files.map((f) => `${f.file}:E${f.errorCount}W${f.warnCount}`)));

/* ---- 8. 写盘门禁 ---- */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-'));
const okWrite = writeGenerated(r, tmp);
check('通过门禁后允许写盘', okWrite.written === true && okWrite.files.length === 3, JSON.stringify(okWrite.files?.length));
const bad = generate({ ...baseInput, pages: [{ name: 'p', steps: [{ act: 'click', locator: { kind: 'role', role: 'button', name: 'x' } }] }], cases: [{ title: 't', page: 'p', claims: 'c', steps: [{ act: 'click', locator: { kind: 'role', role: 'button', name: 'x' } }] }] });
const badWrite = writeGenerated(bad, tmp);
check('门禁不过则阻止写盘', bad.lint.passed === false && badWrite.written === false, badWrite.reason);

log('');
log(failures === 0 ? '生成器回归测试全部通过 ✅' : `${failures} 项失败 ❌`);
process.exit(failures === 0 ? 0 : 1);
