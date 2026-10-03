/**
 * signature-check.mjs — 缺陷 4 的回归测试
 *
 * 原文缺陷 4：断言失败被归成了「超时」。
 * 根因是错误消息里带着 ANSI 颜色转义 —— 判定正则写 `Error: expect\(` 而真实文本是
 * `Error: ` 紧跟控制字符再跟 `expect(`，永远匹配不上；更糟的是签名里清洗了 ANSI、判定里没清洗，
 * 于是「签名看着正常、归因全歪」。
 *
 * 本测试用带 ANSI 的真实消息形态钉死两件事：
 *   1) 断言失败必须归成 assertion，不能归成 timeout；
 *   2) 判定与签名吃同一份清洗文本 —— 清洗是幂等的，且同一根因的多条失败必须聚成一个签名。
 */
import {
  clean, classify, signature, summarize, cleanIsIdempotent,
} from '../lib/signature.js';

let failures = 0;
const log = (s) => process.stdout.write(`${s}\n`);
const check = (name, cond, extra = '') => {
  if (!cond) failures++;
  log(`${cond ? 'PASS ' : 'FAIL '} ${name}${extra ? `  ${extra}` : ''}`);
};

/* ---- 1. ANSI 清洗 ---- */
const ansiMsg = 'Error: \u001b[2mexpect(\u001b[22m\u001b[31mlocator\u001b[39m\u001b[2m).\u001b[22mtoHaveText'
  + '\u001b[2m(expected)\u001b[22m failed\n\nExpected: \u001b[32m"¥99.00"\u001b[39m\nReceived: \u001b[31m"¥100.00"\u001b[39m';
const cleaned = clean(ansiMsg);
check('ANSI 已被清除', !/\u001b/.test(cleaned), JSON.stringify(cleaned.slice(0, 40)));
check('清洗幂等', cleanIsIdempotent(ansiMsg));
check('字面量 \\x1b 也被清除', !/\\x1b/.test(clean('Error: \\x1b[2mexpect(\\x1b[22mx)')));
check('清洗后 expect( 直接可见', /Error: expect\(locator\)\.toHaveText/.test(cleaned));

/* ---- 2. 归因正确性（缺陷 4 的核心） ---- */
check('带 ANSI 的断言失败 → assertion（不是 timeout）', classify(cleaned) === 'assertion', `实际=${classify(cleaned)}`);

const cases = [
  ['strict mode violation: getByText(<s>) resolved to 3 elements', 'locator-strict'],
  ['TimeoutError: locator.click: Timeout 3000ms exceeded.\nCall log:\n  - waiting for locator(\'#pay\')', 'timeout'],
  ['page.goto: net::ERR_CONNECTION_REFUSED at http://localhost:3000/', 'env'],
  ['Error: expect(locator).toBeVisible() failed\n\nLocator: getByRole(\'button\')\nExpected: visible', 'assertion'],
  ['Timed out 5000ms waiting for expect(locator).toBeVisible()', 'assertion'],
  ['Error: locator.click: Error: strict mode violation: locator(\'a\') resolved to 2 elements', 'locator-strict'],
];
for (const [msg, want] of cases) {
  const got = classify(clean(msg));
  check(`分类 ${want}`, got === want, `实际=${got}`);
}

/* ---- 3. 签名聚类：同源必须同一个签名，异源不能混 ---- */
const s1 = signature(clean(ansiMsg), 'demo/tests/order.spec.ts');
const s2 = signature(clean('Error: \u001b[2mexpect(\u001b[22m\u001b[31mlocator\u001b[39m\u001b[2m).\u001b[22mtoHaveText'
  + '\u001b[2m(expected)\u001b[22m failed\n\nExpected: \u001b[32m"¥50.00"\u001b[39m\nReceived: \u001b[31m"¥60.00"\u001b[39m'), 'demo/tests/order.spec.ts');
check('同源失败签名相同（尽管预期值不同）', s1 === s2, `\n  s1=${s1.slice(0, 90)}\n  s2=${s2.slice(0, 90)}`);
check('签名里不残留 ANSI', !/\u001b/.test(s1));
check('签名里不残留具体数字', !/\d{2,}/.test(s1.replace(/<n>/g, '').replace(/<loc>/g, '')), s1.slice(0, 90));

const s3 = signature(clean('page.goto: net::ERR_CONNECTION_REFUSED at http://localhost:3000/'), 'demo/tests/order.spec.ts');
check('异源失败签名不同', s1 !== s3);

/* ---- 4. 端到端：6 条失败压成 4 个根因（对齐原文第 5 节） ---- */
const mk = (status, msg, duration = 500) => ({
  status, duration, errors: msg ? [{ message: msg }] : [],
});
const json = {
  stats: { expected: 2, unexpected: 6, flaky: 1, skipped: 0, duration: 83_100 },
  suites: [{
    title: 'demo', file: 'demo/tests/regression.spec.ts',
    specs: [
      { title: 'A', ok: false, file: 'demo/tests/regression.spec.ts', tests: [{ status: 'unexpected', results: [mk('failed', ansiMsg)] }] },
      { title: 'B', ok: false, file: 'demo/tests/regression.spec.ts', tests: [{ status: 'unexpected', results: [mk('failed', 'Error: \u001b[2mexpect(\u001b[22mlocator\u001b[39m).toHaveText(\u001b[2mexpected\u001b[22m) failed\nExpected: "a"\nReceived: "b"')] }] },
      { title: 'C', ok: false, file: 'demo/tests/regression.spec.ts', tests: [{ status: 'unexpected', results: [mk('failed', 'Error: expect(locator).toHaveText(expected) failed\nExpected: "x"\nReceived: "y"')] }] },
      { title: 'D', ok: false, file: 'demo/tests/regression.spec.ts', tests: [{ status: 'unexpected', results: [mk('failed', 'Error: strict mode violation: getByText(\'x\') resolved to 3 elements')] }] },
      { title: 'E', ok: false, file: 'demo/tests/regression.spec.ts', tests: [{ status: 'unexpected', results: [mk('failed', 'TimeoutError: locator.click: Timeout 3000ms exceeded.\nCall log:\n  - waiting for locator(\'#pay\')')] }] },
      { title: 'F', ok: false, file: 'demo/tests/regression.spec.ts', tests: [{ status: 'unexpected', results: [mk('failed', 'page.goto: net::ERR_CONNECTION_REFUSED at http://localhost:3000/')] }] },
      { title: 'G', ok: true, file: 'demo/tests/regression.spec.ts', tests: [{ status: 'flaky', results: [mk('failed', 'TimeoutError: locator.click: Timeout 1000ms exceeded.'), mk('passed', null)] }] },
      { title: 'H', ok: true, file: 'demo/tests/regression.spec.ts', tests: [{ status: 'expected', results: [mk('passed', null)] }] },
    ],
  }],
};
const rep = summarize(json, { file: 'demo/tests/regression.spec.ts' });
check('识别 6 条失败', rep.totals.failed === 6, JSON.stringify(rep.totals));
check('3 条断言失败聚成 1 个签名', rep.clusters.find((c) => c.category === 'assertion')?.count === 3,
  rep.clusters.map((c) => `${c.category}:${c.count}`).join(' '));
check('压成 4 个根因签名', rep.clusters.length === 4, `实际 ${rep.clusters.length}: ${rep.clusters.map((c) => c.category).join(',')}`);
check('聚类条数之和 = 6', rep.clusters.reduce((s, c) => s + c.count, 0) === 6, String(rep.clusters.reduce((s, c) => s + c.count, 0)));
check('偶发不混进聚类（单独列出）', rep.clusterList === undefined && rep.flakeDetails.length === 1 && rep.clusters.every((c) => !c.tests.includes('demo › G')),
  JSON.stringify(rep.flakeDetails.map((f) => f.title)));
check('断言失败没有被误归成 timeout', rep.clusters.find((c) => c.category === 'assertion') !== undefined);
check('识别 1 条偶发', rep.flakes.length === 1, JSON.stringify(rep.flakes));
check('headline 给出压缩比', /6 条失败聚成 4 个根因签名/.test(rep.headline), rep.headline);
log('');
log(rep.headline);
for (const c of rep.clusters) log(`  [${c.count} 次 · ${c.category}] ${c.signature.slice(0, 100)}  → ${c.owner}`);
log('');
log(failures === 0 ? '缺陷 4 回归测试全部通过 ✅' : `${failures} 项失败 ❌`);
process.exit(failures === 0 ? 0 : 1);
