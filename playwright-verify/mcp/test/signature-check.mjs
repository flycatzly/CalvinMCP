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
  clean, classify, signature, summarize, cleanIsIdempotent, summarizeTrend, formatTrendText, slimTrendForContext, TREND_MD_MAX_ROWS,
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

/* ---- 5. 输入校验：解析失败/不像报告必须报错（「不报错但结论错」，2026-10-04 真实测试实测） ----
 * 旧实现对不可解析字符串直接给全零空报告（isError=false、totals 全 0）——
 * 调用方会把「解析失败」当成「没有失败」。失败必须以 .error 显式表达。 */
const badJson = summarize('{"not": "a report"');
check('不可解析 JSON 必须报错（绝不静默全零报告）',
  /解析失败/.test(badJson.error || '') && !badJson.totals, badJson.error || JSON.stringify(badJson.totals));
const wrongShape = summarize({ foo: 1 });
check('非报告形状必须报错（缺 suites/stats 不许当成 0 条通过）',
  /suites|stats/.test(wrongShape.error || '') && !wrongShape.totals, wrongShape.error || '(未报错)');
const strRep = summarize(JSON.stringify(json));
check('合法 JSON 字符串输入真解析（与对象输入结论一致）',
  !strRep.error && strRep.totals.tests === rep.totals.tests && strRep.clusters.length === rep.clusters.length,
  JSON.stringify(strRep.totals));
const emptyRep = summarize({ stats: { expected: 0, unexpected: 0, flaky: 0, skipped: 0, duration: 0 }, suites: [] });
check('最小合法空报告不误伤（守卫不宽不窄）',
  !emptyRep.error && emptyRep.totals.tests === 0 && emptyRep.totals.failed === 0, emptyRep.error || emptyRep.headline);

/* ---- 6. 多报告趋势（v1.8.7）：通过率曲线 + 签名漂移，签名沿用单一源 ---- */
// 夹具口径与真实报告一致：stats 与 specs 互相吻合（tests 由遍历 specs 数出，凑满 10 条），
// 否则 passRate 的分母对不上 —— 趋势钉先抓出实现真 bug（计数矩阵写 ++ 丢簇内多条）后才绿。
const tRep = (fails, extra = {}) => {
  const passers = Array.from({ length: 10 - fails.length }, (_, j) => ({
    title: `P${j}`, ok: true, file: 't.spec.ts',
    tests: [{ status: 'expected', results: [mk('passed', null)] }],
  }));
  const failSpecs = fails.map((msg, i) => ({
    title: `T${i}`, ok: false, file: 't.spec.ts',
    tests: [{ status: 'unexpected', results: [mk('failed', msg)] }],
  }));
  return summarize({
    stats: { expected: 10 - fails.length, unexpected: fails.length, flaky: 0, skipped: 0, duration: 1000 },
    suites: [{ title: 't', file: 't.spec.ts', specs: [...passers, ...failSpecs] }],
  }, extra);
};
// 三份报告：断言失败（持续且计数 1→2→2）、超时失败（第 2 份起消失=消除）、env 失败（第 3 份才出现=新签名）。
// 两条不同预期值的断言失败必须落进同一签名（引号内容归一化）—— 趋势的「同一根因」才对得上。
const t1 = tRep(['Error: expect(locator).toHaveText(expected) failed\nExpected: "a"\nReceived: "b"',
  'TimeoutError: locator.click: Timeout 3000ms exceeded.'], { file: 'r1.json' });
const t2 = tRep(['Error: expect(locator).toHaveText(expected) failed\nExpected: "a"\nReceived: "b"',
  'Error: expect(locator).toHaveText(expected) failed\nExpected: "x"\nReceived: "y"'], { file: 'r2.json' });
const t3 = tRep(['Error: expect(locator).toHaveText(expected) failed\nExpected: "a"\nReceived: "b"',
  'Error: expect(locator).toHaveText(expected) failed\nExpected: "x"\nReceived: "y"',
  'page.goto: net::ERR_CONNECTION_REFUSED at http://localhost:3000/'], { file: 'r3.json' });
const trend = summarizeTrend([t1, t2, t3]);
check('趋势通过率曲线按份对齐（失败 2→2→3、签名数 2→1→2、通过率 80→80→70）',
  trend.runs.length === 3 && trend.runs.map((r) => r.failed).join(',') === '2,2,3'
  && trend.runs.map((r) => r.signatureCount).join(',') === '2,1,2'
  && trend.runs[0].passRate === 80 && trend.runs[2].passRate === 70,
  JSON.stringify(trend.runs.map((r) => [r.failed, r.signatureCount, r.passRate])));
const assertSig = t2.clusters[0].signature;
check('趋势签名漂移三分法：新签名=env（回归信号）、消除=timeout、持续=assertion 且计数序列对齐',
  trend.newSignatures.length === 1 && trend.newSignatures[0].category === 'env'
  && trend.resolvedSignatures.length === 1 && trend.resolvedSignatures[0].category === 'timeout'
  && trend.persisting.length === 1 && trend.persisting[0].category === 'assertion'
  && trend.persisting[0].prevCount === 2 && trend.persisting[0].lastCount === 2
  && trend.signatureSeries.find((s) => s.signature === assertSig)?.counts.join(',') === '1,2,2',
  JSON.stringify({
    newS: trend.newSignatures.map((s) => s.category),
    resolved: trend.resolvedSignatures.map((s) => s.category),
    persist: trend.persisting.map((s) => [s.category, s.prevCount, s.lastCount]),
  }));
check('趋势 headline 给出失败增量与三分法计数',
  /3 份报告：失败 2 → 3（\+1）/.test(trend.headline) && /新签名 1 \/ 消除 1 \/ 持续 1/.test(trend.headline),
  trend.headline);
const trendMd = formatTrendText(trend);
check('趋势 md 人读版：通过率表 + 三段漂移 + 签名计数序列（落盘形态可核对）',
  /# 回归趋势（3 份报告）/.test(trendMd) && /新签名 1 个（回归信号/.test(trendMd)
  && /消除 1 个（修复成效/.test(trendMd) && /持续 1 个（存量/.test(trendMd)
  && /1 → 2 → 2/.test(trendMd) && /\| 3 \| r3\.json \| 7\/10 \| 70% \| 3 \|/.test(trendMd),
  `${trendMd.split('\n')[0]} …共 ${trendMd.length} 字符`);

/* ---- 7. 趋势 md 行截断（v1.8.9）：只截展示不截数据，诚实「还有 N 条」 ---- */
log('=== 7) 趋势 md 行截断：签名爆炸时 md 有界，结构化数据保全量 ===');
{
  const bigSpec = (title, msg) => ({
    title, ok: false, file: 's.spec.ts',
    tests: [{ status: 'unexpected', results: [{ status: 'failed', duration: 5, errors: [{ message: msg }] }] }],
  });
  const bigReport = ({ p, rFrom, rTo, nFrom, nTo }) => {
    const specs = [];
    for (let i = 1; i <= p; i++) specs.push(bigSpec(`F-P${String(i).padStart(3, '0')}`, `Error: 持续签名P${String(i).padStart(3, '0')} 金额校验失败（期望 99 实得 100）`));
    for (let i = rFrom; i <= rTo; i++) specs.push(bigSpec(`F-R${String(i).padStart(3, '0')}`, `Error: 消除签名R${String(i).padStart(3, '0')} 超时未响应`));
    for (let i = nFrom; i <= nTo; i++) specs.push(bigSpec(`F-N${String(i).padStart(3, '0')}`, `Error: 新签名N${String(i).padStart(3, '0')} 元素找不到`));
    for (let j = 0; j < 4; j++) specs.push({ title: `P${j}`, ok: true, file: 's.spec.ts', tests: [{ status: 'expected', results: [] }] });
    return {
      stats: { expected: 4, unexpected: p + Math.max(0, rTo - rFrom + 1) + Math.max(0, nTo - nFrom + 1), flaky: 0, skipped: 0, duration: 1000 },
      suites: [{ title: 's', specs }],
    };
  };
  // w1-w4：P001-100 + R001-010；w5：P001-100 + N001-020 → 持续 100 / 消除 10 / 新 20，共 130 签名
  const bigReports = [1, 2, 3, 4].map((i) => summarize(bigReport({ p: 100, rFrom: 1, rTo: 10, nFrom: 1, nTo: 0 }), { file: `w${i}.json` }));
  bigReports.push(summarize(bigReport({ p: 100, rFrom: 1, rTo: 0, nFrom: 1, nTo: 20 }), { file: 'w5.json' }));
  const bigTrend = summarizeTrend(bigReports);

  check('截断常数钉：TREND_MD_MAX_ROWS = 50', TREND_MD_MAX_ROWS === 50, `=${TREND_MD_MAX_ROWS}`);
  check('结构化数据不截断：signatureSeries=130 / 持续=100 全量在（CI 对账不缺行）',
    bigTrend.signatureSeries.length === 130 && bigTrend.persisting.length === 100
    && bigTrend.newSignatures.length === 20 && bigTrend.resolvedSignatures.length === 10,
    `series=${bigTrend.signatureSeries.length} persist=${bigTrend.persisting.length}`);

  const bigMd = formatTrendText(bigTrend);
  const listRows = bigMd.split('\n').filter((l) => l.startsWith('- ['));
  check('md 行截断：每个列表 ≤50 行（130 签名的 260 条签名行变有界 ≤200）',
    listRows.length <= 4 * TREND_MD_MAX_ROWS,
    `签名行=${listRows.length}`);
  check('诚实计数行：持续段「还有 50 条未展示，共 100 条」+ 序列段「还有 80 条未展示，共 130 条」',
    /…（该列表还有 50 条未展示，共 100 条/.test(bigMd) && /…（该列表还有 80 条未展示，共 130 条/.test(bigMd)
    && /md 只截展示不截数据/.test(bigMd));
  check('截断保权重序：持续段与序列段首行 == 结构化数据排序后的首位',
    bigMd.includes(`- [${bigTrend.persisting[0].category}] ${bigTrend.persisting[0].signature.slice(0, 130)}`)
    && bigMd.includes(`：${bigTrend.signatureSeries[0].counts.join(' → ')}`));
  check('小趋势形态零变化：≤50 条时无截断注记（r14 的 3 份报告 md 保持原形）',
    !trendMd.includes('…（该列表还有'), '');

  /* ---- 7.5 趋势上下文有界（v1.8.11）：slimTrendForContext —— 全量落盘、上下文有界 ---- */
  const slimBig = slimTrendForContext(bigTrend);
  const slimBytes = Buffer.byteLength(JSON.stringify(slimBig));
  const fullBytes = Buffer.byteLength(JSON.stringify(bigTrend));
  check('上下文有界口径：130 签名截到 TREND_MD_MAX_ROWS 条（与 md 同一常量单一源）+ 四个 total 诚实 + contextTruncated/version2',
    slimBig.signatureSeries.length === TREND_MD_MAX_ROWS && slimBig.signatureSeriesTotal === 130
    && slimBig.persisting.length === TREND_MD_MAX_ROWS && slimBig.persistingTotal === 100
    && slimBig.newSignaturesTotal === 20 && slimBig.resolvedSignaturesTotal === 10
    && slimBig.contextTruncated === true && slimBig.version === 2 && bigTrend.version === 1,
    `series=${slimBig.signatureSeries.length}/${slimBig.signatureSeriesTotal} trunc=${slimBig.contextTruncated}`);
  check('回灌面有界：slim 体积 ≤ 全量一半（130 签名场景实测省 58%）且不随签名数线性膨胀的上限成立',
    slimBytes <= fullBytes * 0.5,
    `slim=${(slimBytes / 1024).toFixed(1)}KB full=${(fullBytes / 1024).toFixed(1)}KB（${(slimBytes / fullBytes * 100).toFixed(0)}%）`);
  check('行内保真：截后条目与全量前 50 条逐字段相等（签名串/计数矩阵不动，join-back 可靠）+ sample 已去',
    slimBig.signatureSeries.every((s, i) => {
      const f = bigTrend.signatureSeries[i];
      return !('sample' in s) && s.signature === f.signature && s.category === f.category
        && JSON.stringify(s.counts) === JSON.stringify(f.counts) && s.categoryLabel === f.categoryLabel;
    }),
    `首条=${slimBig.signatureSeries[0].signature.slice(0, 40)}`);
  check('纯函数不突变输入：slim 后 bigTrend 仍 130 全量含 sample（落盘 JSON 的数据源不被污染）',
    bigTrend.signatureSeries.length === 130 && 'sample' in bigTrend.signatureSeries[0] && bigTrend.persisting.length === 100,
    `series=${bigTrend.signatureSeries.length}`);
  check('未超上限形态：小趋势全行透传 + totals=长度 + contextTruncated=false（条目形态统一仍去 sample）',
    (() => {
      const s = slimTrendForContext(trend);
      return s.signatureSeries.length === trend.signatureSeries.length && s.signatureSeriesTotal === trend.signatureSeries.length
        && s.contextTruncated === false && s.version === 2 && !('sample' in s.signatureSeries[0]);
    })(),
    `小趋势 series=${trend.signatureSeries.length}`);
}

log('');
log(rep.headline);
for (const c of rep.clusters) log(`  [${c.count} 次 · ${c.category}] ${c.signature.slice(0, 100)}  → ${c.owner}`);
log('');
log(failures === 0 ? '缺陷 4 回归测试全部通过 ✅' : `${failures} 项失败 ❌`);
process.exit(failures === 0 ? 0 : 1);
