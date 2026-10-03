// web-rpa-mcp — 集成测试：逐步覆盖全部步骤类型 / 断言 / 录制边界 / 自愈 / 串联 / 凭据 / 告警
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { startDemoServer } from '../../demo/app.mjs';
import { startRecording, stopRecording, activeSession, recordingStatus, cancelRecording, startSplice } from '../lib/recorder.mjs';
import { runFlow, preflightFlow } from '../lib/player.mjs';
import { runChain } from '../lib/chain.mjs';
import { loadFlow, saveFlow, deleteFlow, listFlows, flowMarkdown, stepLabel, listRuns, loadRun, listBackups, restoreFlow } from '../lib/store.mjs';
import { lintFlow } from '../lib/lint.mjs';
import { setSecret, getSecret, listSecrets, deleteSecret } from '../lib/secrets.mjs';
import { readTable, resolveColumn } from '../lib/table.mjs';
import { composeRunMessage, sendNotify } from '../lib/notify.mjs';
import { writeWrapper } from '../lib/schedule.mjs';
import {
  statusReport, pruneRuns, pruneLogs, acquireLock, releaseLock, lockInfo,
  writeRunningMarker, interruptedRun,
} from '../lib/ops.mjs';
import { closeAll, getPlaywright } from '../lib/browser.mjs';
import { formatDate, DIRS, readConfig, writeConfig } from '../lib/core.mjs';

let pass = 0, fail = 0, skip = 0;
const failures = [];
// 诚实 SKIP 口径（同 mysql-validate 退出码 3）：缺 playwright 级联出来的失败降级为 SKIP ——
// 签名直配 + 级联（上游缺依赖导致 null 解引用）两类。探针守卫：只有环境真的解析不到
// playwright 才降级；装了仍报缺 = 产品缺陷 = 照旧 FAIL。
const depSig = /未找到可用的 playwright|PLAYWRIGHT_NOT_FOUND/;
let depTainted = false;
let pwMissing = false;
try { await getPlaywright(); } catch (e) { pwMissing = !!(e && e.code === 'PLAYWRIGHT_NOT_FOUND'); }

/* 按组过滤（日常迭代提速）：node test/integration.mjs --group 4,17 只跑指定组。
   注意：个别组依赖前面组造出来的流程/数据，单独跑不过时要连着它依赖的组一起跑。 */
const argv = process.argv.slice(2);
const onlyGroups = new Set();
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--group' && argv[i + 1]) { for (const g of argv[++i].split(',')) if (g.trim()) onlyGroups.add(g.trim()); }
  else if (argv[i].indexOf('--group=') === 0) { for (const g of argv[i].slice(8).split(',')) if (g.trim()) onlyGroups.add(g.trim()); }
}
let curGroup = '';
function G(id, title) {
  curGroup = id;
  if (onlyGroups.size && !onlyGroups.has(id)) return;
  console.log('\n[G' + id + '] ' + title);
}
function groupActive() { return !onlyGroups.size || !curGroup || onlyGroups.has(curGroup); }

async function A(name, fn) {
  if (!groupActive()) return;
  try { await fn(); pass++; console.log('  ok   ' + name); }
  catch (e) {
    const msg = e && e.message ? e.message : String(e);
    const dep = pwMissing && (depSig.test(msg) || (depTainted && /Cannot read properties of null/.test(msg)));
    if (dep) {
      if (depSig.test(msg)) depTainted = true;
      skip++; console.log('  SKIP ' + name + '\n       （诚实 SKIP：' + (depSig.test(msg) ? '环境缺 playwright 依赖' : '级联自上游缺依赖，前置未跑') + '）');
      return;
    }
    fail++; failures.push(name + ' -> ' + msg); console.log('  FAIL ' + name + '\n       ' + msg);
  }
}
function S(name, why) { if (!groupActive()) return; skip++; console.log('  skip ' + name + '  (' + why + ')'); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let DEMO = '';
const created = [];
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'webrpa-int-'));

function L(v) { return [{ strategy: 'testid', value: v }]; }
function CSS(sel) { return [{ strategy: 'css', value: sel }]; }
function clk(v) { return { op: 'click', locators: L(v) }; }
function clkNav(v) { return { op: 'click', locators: L(v), waitForNav: 'load' }; }
function fl(v, val) { return { op: 'fill', locators: L(v), value: val }; }
function ext(v, as) { return { op: 'extract', locators: L(v), as: as }; }
function gt(u) { return { op: 'goto', url: u }; }
function F(id, steps, extra) {
  // 与录制器一致：startUrl 取第一个 goto 的地址（预检就落在"步骤真正作用的那一页"）
  const firstGoto = (steps || []).find((s) => s.op === 'goto' && s.url && String(s.url).indexOf('${') < 0);
  return Object.assign({
    id: id, name: id, version: 1,
    startUrl: firstGoto ? firstGoto.url : DEMO + '/',
    params: [], steps: steps, assertions: [],
  }, extra || {});
}
async function run(flow, opts) {
  const rep = await runFlow(flow, Object.assign({ params: {}, headed: false, trigger: 'integration', allowLintErrors: true }, opts || {}));
  // 诚实 SKIP 证据口径：探针确认缺 playwright，且这份报告就是被缺依赖打断的——
  // 把报告里的缺依赖原文带出去，让 A() 按证据降级，别让后续断言（期望失败/报告明细）吞掉根因。
  // 报告里没有缺依赖字样的照旧返回给断言（不遮真实缺陷）。
  if (pwMissing && depSig.test(JSON.stringify(rep))) {
    const m = JSON.stringify(rep).match(depSig);
    throw new Error('run 报告含缺依赖根因: ' + (m ? m[0] : 'PLAYWRIGHT_NOT_FOUND'));
  }
  return rep;
}

/* 本地告警接收器 */
function startAlarmReceiver() {
  const got = [];
  const server = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => { b += c; });
    req.on('end', () => {
      try { got.push(JSON.parse(b)); } catch { got.push({ raw: b }); }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, got, url: 'http://127.0.0.1:' + server.address().port + '/hook' }));
  });
}

async function main() {
  const today = formatDate(new Date(), 'YYYY-MM-DD');
  const demo = await startDemoServer(0);
  DEMO = demo.url;
  console.log('\n演示站点: ' + DEMO);

  /* ================= G1 录制：富控件（select/radio/checkbox/textarea/file/hover/scroll） ================= */
  G('1', '录制富控件表单');
  const uploadFile = path.join(TMP, '附件-测试.txt');
  fs.writeFileSync(uploadFile, 'hello attachment', 'utf8');

  await A('录制富控件表单（select/checkbox/textarea/上传/hover/滚动）', async () => {
    const rec = await startRecording({ url: DEMO + '/form', name: 'int-富控件' });
    assert.ok(rec.ok, JSON.stringify(rec));
    const page = activeSession().page;
    await page.waitForSelector('[data-testid="orderNo"]');
    await page.fill('[data-testid="orderNo"]', 'SO-999');
    await sleep(250);
    await page.selectOption('[data-testid="reason"]', 'refund');
    await sleep(250);
    await page.check('[data-testid="agree"]');
    await sleep(250);
    await page.fill('[data-testid="note"]', '请尽快处理');
    await sleep(250);
    await page.setInputFiles('[data-testid="attach"]', uploadFile);
    await sleep(400);
    await page.hover('[data-testid="hoverMenu"]');
    await sleep(900);                       // 等 hover 探测窗口
    await page.click('[data-testid="hoverAction"]');
    await sleep(400);
    await page.click('[data-testid="deepBtn"]');   // 需要自动滚动
    await sleep(400);
    await page.click('[data-testid="formSubmit"]');
    await page.waitForSelector('[data-testid="formOk"]', { timeout: 15000 });
    await sleep(1300);

    const stop = await stopRecording({ name: 'int-富控件' });
    assert.ok(stop.ok, JSON.stringify(stop));
    created.push(stop.flowId);
    globalThis.__richFlowId = stop.flowId;
    console.log('    步骤:');
    stop.flow.steps.forEach((s, i) => console.log('      ' + stepLabel(s, i)));
    console.log('    lint errors=' + stop.lint.errors.length + ' warnings=' + stop.lint.warnings.length);
    stop.lint.errors.forEach((e) => console.log('      ERROR [' + e.code + '] ' + e.message));

    const ops = stop.flow.steps.map((s) => s.op);
    assert.ok(ops.includes('fill'), '没录到 fill');
    assert.ok(ops.includes('select'), '没录到 select');
    assert.ok(ops.includes('check'), '没录到 check');
    assert.ok(ops.includes('setInputFiles'), '没录到 setInputFiles');
    assert.ok(ops.includes('hover'), '没录到 hover（下拉菜单场景）');
    assert.ok(stop.flow.steps.some((s) => s.op === 'select' && s.value === 'refund'), 'select 值不对');
    assert.ok(stop.flow.steps.some((s) => s.op === 'check' && s.checked === true), 'check 状态不对');
  });

  await A('上传步骤缺少 path 时被静态检查阻断（L091）', async () => {
    const flow = loadFlow(globalThis.__richFlowId);
    const lint = lintFlow(flow, {});
    assert.ok(lint.errors.some((e) => e.code === 'L091'), '没有报 L091: ' + JSON.stringify(lint.errors));
    assert.equal(lint.ok, false);
  });

  await A('补上上传路径后静态检查通过，且能回放富控件流程', async () => {
    const flow = loadFlow(globalThis.__richFlowId);
    const up = flow.steps.find((s) => s.op === 'setInputFiles');
    up.path = uploadFile;
    // 断言依赖页面结果，录制时已推断；若没有则补一条
    if (!(flow.assertions || []).length) flow.assertions = [{ kind: 'textPresent', text: '工单提交成功', message: '必须提交成功' }];
    saveFlow(flow);
    const lint = lintFlow(loadFlow(flow.id), {});
    assert.equal(lint.errors.length, 0, '仍有阻断项: ' + JSON.stringify(lint.errors));

    const rep = await run(loadFlow(flow.id), { allowLintErrors: false });
    console.log('    回放状态=' + rep.status + ' 错误=' + (rep.error || '无'));
    rep.steps.forEach((s) => console.log('      ' + s.index + '. ' + s.op + ' [' + s.status + '] ' + (s.detail || s.error || '')));
    assert.equal(rep.status, 'pass', '回放失败: ' + rep.error);
    assert.ok(rep.screenshots.length > 0, '没有截图证据');
  });

  await A('回放后页面状态正确（勾选/备注/上传文件名都生效）', async () => {
    const probe = F('__probe_rich', [
      gt(DEMO + '/form'),
      fl('orderNo', 'SO-999'),
      { op: 'select', locators: L('reason'), label: '维修' },
      { op: 'check', locators: L('agree'), checked: true },
      fl('note', '备注X'),
      { op: 'setInputFiles', locators: L('attach'), path: uploadFile },
      { op: 'click', locators: L('formSubmit'), waitForNav: 'load' },
      { op: 'waitForText', text: '工单提交成功' },
    ], { assertions: [{ kind: 'textPresent', text: '工单提交成功' }] });
    const rep = await run(probe);
    assert.equal(rep.status, 'pass', rep.error);
    assert.equal(rep.finalUrl.indexOf('/form-result') > 0, true, 'URL 不对: ' + rep.finalUrl);
  });

  /* ================= G2 iframe 录制与回放 ================= */
  G('2', 'iframe 内元素录制与回放');
  await A('iframe 内的点击带上了 frame 链并能回放', async () => {
    const rec = await startRecording({ url: DEMO + '/frame', name: 'int-iframe' });
    assert.ok(rec.ok, JSON.stringify(rec));
    const page = activeSession().page;
    await page.waitForSelector('#innerFrame');
    const fr = page.frameLocator('#innerFrame');
    await fr.locator('#innerBtn').click();
    await sleep(500);
    await fr.locator('#innerResult').waitFor();
    await sleep(1200);
    const stop = await stopRecording({ name: 'int-iframe' });
    assert.ok(stop.ok, JSON.stringify(stop));
    created.push(stop.flowId);
    stop.flow.steps.forEach((s, i) => console.log('      ' + stepLabel(s, i)));
    const inner = stop.flow.steps.find((s) => s.op === 'click' && (s.locators || []).some((l) => l.value === 'innerBtn'));
    assert.ok(inner, '没录到内层按钮点击');
    assert.ok(Array.isArray(inner.frame) && inner.frame.length > 0, '内层点击没有 frame 链: ' + JSON.stringify(inner.frame));
    assert.ok(String(inner.frame[0].value).indexOf('innerFrame') >= 0, 'frame 选择器不对: ' + JSON.stringify(inner.frame));

    const flow = loadFlow(stop.flowId);
    flow.assertions = [{ kind: 'textPresent', text: '内层已点击', message: '内层按钮必须生效' }];
    saveFlow(flow);
    const rep = await run(loadFlow(flow.id));
    console.log('    iframe 回放状态=' + rep.status + ' 错误=' + (rep.error || '无'));
    assert.equal(rep.status, 'pass', 'iframe 回放失败: ' + rep.error);
  });

  /* ================= G3 各步骤类型 ================= */
  G('3', '步骤类型与断言');

  await A('select 按 label 选择', async () => {
    const f = F('t-select', [
      gt(DEMO + '/form'), fl('orderNo', 'SO-1'),
      { op: 'select', locators: L('reason'), label: '换货' },
      { op: 'check', locators: L('agree'), checked: true },
      clkNav('formSubmit'), { op: 'waitForText', text: '工单提交成功' },
      ext('echoReason', 'reason'),
    ], { assertions: [{ kind: 'extracted', as: 'reason', equals: 'exchange' }] });
    const rep = await run(f);
    assert.equal(rep.status, 'pass', JSON.stringify(rep.assertions) + ' ' + rep.error);
    assert.equal(rep.extracted.reason, 'exchange');
  });

  await A('check 取消勾选后提交被拒（证明 unchecked 生效）', async () => {
    const f = F('t-uncheck', [
      gt(DEMO + '/form'), fl('orderNo', 'SO-2'),
      { op: 'check', locators: L('agree'), checked: true },
      { op: 'check', locators: L('agree'), checked: false },
      clkNav('formSubmit'), { op: 'waitForText', text: '请先核对信息' },
    ], { assertions: [{ kind: 'textPresent', text: '请先核对信息' }] });
    const rep = await run(f);
    assert.equal(rep.status, 'pass', rep.error);
  });

  await A('press 回车提交表单', async () => {
    const f = F('t-press', [
      gt(DEMO + '/form'), fl('orderNo', 'SO-3'),
      { op: 'press', locators: L('orderNo'), key: 'Enter', waitForNav: 'load' },
      { op: 'waitForText', text: '请先核对信息' },
    ], { assertions: [{ kind: 'textPresent', text: '请先核对信息' }] });
    const rep = await run(f);
    assert.equal(rep.status, 'pass', rep.error);
  });

  await A('hover 展开面板后点击', async () => {
    const f = F('t-hover', [
      gt(DEMO + '/form'),
      { op: 'hover', locators: L('hoverMenu') },
      { op: 'waitFor', locators: L('hoverAction') },
      clk('hoverAction'),
      { op: 'waitForText', text: '已点击导出明细' },
    ], { assertions: [{ kind: 'textPresent', text: '已点击导出明细' }] });
    const rep = await run(f);
    assert.equal(rep.status, 'pass', rep.error);
  });

  await A('scrollIntoView 滚动到底部按钮并点击', async () => {
    const f = F('t-scroll', [
      gt(DEMO + '/form'),
      { op: 'scrollIntoView', locators: L('deepBtn') },
      clk('deepBtn'),
      { op: 'waitForText', text: '底部按钮已点击' },
    ], { assertions: [{ kind: 'textPresent', text: '底部按钮已点击' }] });
    const rep = await run(f);
    assert.equal(rep.status, 'pass', rep.error);
  });

  await A('waitFor 等待延迟出现的元素（慢加载）', async () => {
    const f = F('t-slow', [
      gt(DEMO + '/slow?ms=2200'),
      { op: 'waitFor', locators: L('slowBtn'), state: 'visible', timeoutMs: 15000 },
      clk('slowBtn'),
      { op: 'waitForText', text: '延迟按钮已点击' },
      { op: 'sleep', ms: 200 },
      { op: 'screenshot', name: 'slow-ok' },
    ], { assertions: [{ kind: 'textPresent', text: '延迟按钮已点击' }] });
    const rep = await run(f);
    assert.equal(rep.status, 'pass', rep.error);
    assert.ok(rep.steps.some((s) => s.op === 'screenshot' && s.status === 'pass'), '截图步骤未成功');
  });

  await A('extract 取属性值与文本', async () => {
    const f = F('t-extract', [
      gt(DEMO + '/form'),
      { op: 'extract', locators: L('dlLink3'), as: 'href3', attr: 'href' },
      ext('formSubmit', 'submitText'),
      { op: 'extract', locators: L('orderNo'), as: 'phAttr', attr: 'placeholder' },
    ], { assertions: [{ kind: 'extracted', as: 'phAttr', equals: '请输入订单号' }] });
    const rep = await run(f);
    assert.equal(rep.status, 'pass', JSON.stringify(rep.assertions) + ' ' + rep.error);
    assert.ok(String(rep.extracted.href3).indexOf('/download') >= 0, 'href 提取不对: ' + rep.extracted.href3);
  });

  await A('optional 步骤在元素缺失时跳过而不是失败', async () => {
    const f = F('t-optional', [
      gt(DEMO + '/form'),
      { op: 'click', locators: L('thisDoesNotExist'), optional: true, timeoutMs: 3000 },
      ext('formSubmit', 'exists'),
    ], { assertions: [{ kind: 'extracted', as: 'exists', equals: '提交工单' }] });
    const rep = await run(f);
    assert.equal(rep.status, 'pass', rep.error);
    assert.ok(rep.steps.some((s) => (s.detail || '').indexOf('可选步骤') >= 0), '没有跳过提示');
  });

  await A('textAbsent / elementAbsent / noErrorBanner / title / url 断言', async () => {
    const f = F('t-asserts', [
      gt(DEMO + '/form'),
    ], {
      assertions: [
        { kind: 'textAbsent', text: '绝不存在的文案' },
        { kind: 'elementAbsent', selector: '#nope-404' },
        { kind: 'noErrorBanner' },
        { kind: 'title', contains: 'B系统' },
        { kind: 'url', contains: '/form' },
        { kind: 'elementVisible', selector: '[data-testid="formSubmit"]' },
        { kind: 'elementVisible', text: '提交工单' },
      ],
    });
    const rep = await run(f);
    rep.assertions.forEach((a) => console.log('      ' + (a.pass ? 'PASS' : 'FAIL') + ' [' + a.kind + '] ' + a.detail));
    assert.equal(rep.status, 'pass', JSON.stringify(rep.assertions.map((a) => a.kind + ':' + a.pass)) + ' ' + rep.error);
  });

  await A('noErrorBanner 在错误页上正确判失败', async () => {
    const f = F('t-errbanner', [gt(DEMO + '/error')], { assertions: [{ kind: 'noErrorBanner', message: '不应有错误提示' }] });
    const rep = await run(f);
    assert.equal(rep.status, 'fail');
    assert.ok(rep.assertions.some((a) => a.kind === 'noErrorBanner' && !a.pass));
  });

  await A('listNotEmpty 拒绝「暂无记录」占位行', async () => {
    const okList = F('t-list-ok', [gt(DEMO + '/list?n=5')], { assertions: [{ kind: 'listNotEmpty', selector: 'ul li', min: 3 }] });
    const repOk = await run(okList);
    assert.equal(repOk.status, 'pass', repOk.error);

    const emptyList = F('t-list-empty', [gt(DEMO + '/list?n=0')], { assertions: [{ kind: 'listNotEmpty', selector: 'ul li', min: 1 }] });
    const repEmpty = await run(emptyList);
    assert.equal(repEmpty.status, 'fail', '空列表竟然通过了');
    const detail = repEmpty.assertions.find((a) => a.kind === 'listNotEmpty').detail;
    assert.ok(detail.indexOf('有效数据行 0') >= 0, '占位行没有被排除: ' + detail);
  });

  await A('下载行数校验：3 行通过、空明细失败', async () => {
    const okDl = F('t-dl-ok', [
      gt(DEMO + '/form'),
      { op: 'click', locators: L('dlLink3'), expectDownload: true },
    ], { assertions: [{ kind: 'download', minBytes: 1, minLines: 4, message: '必须有表头 + 3 行明细' }] });
    const repOk = await run(okDl);
    assert.equal(repOk.status, 'pass', JSON.stringify(repOk.assertions));
    assert.ok(repOk.assertions[0].detail.indexOf('4行') > 0, '未报告行数: ' + repOk.assertions[0].detail);

    // 要求超过实际行数 -> 必须失败（防止"只要有文件就算成功"）
    const strictDl = F('t-dl-strict', [
      gt(DEMO + '/form'),
      { op: 'click', locators: L('dlLink3'), expectDownload: true },
    ], { assertions: [{ kind: 'download', minBytes: 1, minLines: 9, message: '要求 9 行明细' }] });
    const repStrict = await run(strictDl);
    assert.equal(repStrict.status, 'fail', '行数不足竟然通过了: ' + repStrict.assertions[0].detail);

    const emptyDl = F('t-dl-empty', [
      gt(DEMO + '/form'),
      { op: 'click', locators: L('dlLink0'), expectDownload: true },
    ], { assertions: [{ kind: 'download', minBytes: 1, minLines: 2, message: '空明细必须失败' }] });
    const repEmpty = await run(emptyDl);
    assert.equal(repEmpty.status, 'fail', '空明细竟然通过了: ' + JSON.stringify(repEmpty.assertions));
  });

  await A('流程级断言与内联 assert 都执行', async () => {
    const f = F('t-assert-mix', [
      gt(DEMO + '/form'),
      { op: 'assert', kind: 'elementVisible', selector: '[data-testid="formSubmit"]' },
    ], { assertions: [{ kind: 'textPresent', text: '提交工单' }] });
    const rep = await run(f);
    assert.equal(rep.status, 'pass', rep.error);
  });

  /* ================= G4 空结果守卫与豁免 ================= */
  G('4', '空结果守卫');
  await A('空表格被判失败（占位行不算数据）', async () => {
    const f = F('t-guard', [gt(DEMO + '/form')], {
      steps: [
        gt(DEMO + '/login'),
        { op: 'fill', locators: L('empNo'), value: '1001' },
        { op: 'fill', locators: [{ strategy: 'css', value: '#pwd' }], value: 'x' },
        clkNav('loginBtn'),
      ],
      assertions: [],
    });
    // 直接访问 /list?n=0 更简单：空列表页
    const f2 = F('t-guard2', [gt(DEMO + '/list?n=0')], { assertions: [] });
    const rep = await run(f2);
    console.log('      空结果守卫: ' + JSON.stringify(rep.emptyGuard));
    assert.equal(rep.status, 'fail', '空结果未被拦截');
    assert.ok(rep.assertions.some((a) => a.kind === 'emptyResultGuard'), '没有 emptyResultGuard 断言');
  });

  await A('emptyResultOk=true 时豁免空结果守卫', async () => {
    const f = F('t-guard-ok', [gt(DEMO + '/list?n=0')], { assertions: [], emptyResultOk: true });
    const rep = await run(f, { allowLintErrors: true });
    assert.equal(rep.status, 'pass', '豁免后仍失败: ' + rep.error);
    const lint = lintFlow(f, {});
    assert.ok(!lint.errors.some((e) => e.code === 'L010'), 'L010 应降级为警告');
  });

  /* ================= G5 重试 ================= */
  G('5', '步骤重试');
  await A('首次 503 的页面通过重试成功', async () => {
    const f = F('t-retry', [gt(DEMO + '/flaky'), { op: 'assert', kind: 'textPresent', text: '服务已恢复' }]);
    const rep = await run(f, { });
    console.log('      状态=' + rep.status + ' 错误=' + (rep.error || '无'));
    assert.equal(rep.status, 'pass', '重试没有生效: ' + rep.error);
  });

  /* ================= G6 人工接管 ================= */
  G('6', '人工接管');
  await A('无头模式下 humanHandoff 立即报错（不静默卡死）', async () => {
    const f = F('t-human-headless', [
      gt(DEMO + '/handoff'),
      { op: 'humanHandoff', reason: '人工校验', resumeWhenText: '人工处理完成', timeoutMs: 20000 },
    ], { assertions: [{ kind: 'textPresent', text: '人工处理完成' }] });
    const rep = await run(f, { headed: false });
    assert.equal(rep.status, 'fail');
    assert.ok(/人工接管/.test(rep.error || ''), '错误信息不明确: ' + rep.error);
  });

  await A('有头模式下 humanHandoff 等到条件满足后继续', async () => {
    const f = F('t-human-headed', [
      gt(DEMO + '/handoff'),
      { op: 'humanHandoff', reason: '人工校验', resumeWhenText: '人工处理完成', timeoutMs: 30000 },
      { op: 'assert', kind: 'textPresent', text: '人工处理完成' },
    ], { assertions: [{ kind: 'textPresent', text: '人工处理完成' }] });
    const rep = await run(f, { headed: true });
    assert.equal(rep.status, 'pass', '有头人工接管失败: ' + rep.error);
  });

  /* ================= G7 串联（extract -> 参数 -> 目标页） ================= */
  G('7', '串联与前后取值');
  await A('前一个流程 extract 的值通过 flow: 来源传给后一个流程', async () => {
    const src = F('t-chain-src', [
      gt(DEMO + '/chain/source'),
      ext('srcOrderNo', 'orderNo'),
      ext('srcToken', 'token'),
    ], { assertions: [{ kind: 'textPresent', text: '取数页' }] });
    const dst = F('t-chain-dst', [
      { op: 'goto', url: DEMO + '/chain/target?orderNo=\${orderNo}&token=\${token}' },
      { op: 'assert', kind: 'textPresent', text: '串联数据已接收' },
    ], {
      params: [
        { name: 'orderNo', source: 'flow:t-chain-src:orderNo', required: true },
        { name: 'token', source: 'flow:t-chain-src:token', required: true },
      ],
      assertions: [{ kind: 'textPresent', text: '串联数据已接收' }],
    });
    saveFlow(src); saveFlow(dst);
    created.push(src.id, dst.id);

    const r = await runChain([{ flow: src.id }, { flow: dst.id }], { notify: false, trigger: 'integration' });
    console.log('      串联结果: ' + JSON.stringify({ status: r.status, summary: r.summary, error: r.error }));
    assert.equal(r.status, 'pass', '串联失败: ' + r.error);
    assert.equal(r.extracted.orderNo, 'SO20261003');
    assert.equal(r.extracted.token, 'TK-8891');
  });

  await A('流程内 chain 步骤可以嵌套执行另一个流程', async () => {
    const inner = F('t-chain-inner', [gt(DEMO + '/chain/source'), ext('srcToken', 'token')], {
      assertions: [{ kind: 'textPresent', text: '取数页' }],
    });
    const outer = F('t-chain-outer', [
      gt(DEMO + '/form'),
      { op: 'chain', flow: 't-chain-inner' },
      { op: 'assert', kind: 'textPresent', text: '提交工单' },
    ], { assertions: [{ kind: 'textPresent', text: '提交工单' }] });
    saveFlow(inner); saveFlow(outer);
    created.push(inner.id, outer.id);
    const rep = await run(loadFlow(outer.id));
    console.log('      状态=' + rep.status + ' 错误=' + (rep.error || '无'));
    assert.equal(rep.status, 'pass', '嵌套串联失败: ' + rep.error);
  });

  /* ================= G8 凭据 ================= */
  G('8', '凭据加密与掩码');
  await A('secret_set/get/list/delete 往返正确', async () => {
    setSecret('int_tok', 'TK-SECRET-12345');
    assert.equal(getSecret('int_tok'), 'TK-SECRET-12345');
    assert.ok(listSecrets().some((s) => s.name === 'int_tok'));
    const raw = fs.readFileSync(path.join(DIRS.work, 'secrets.json'), 'utf8');
    assert.ok(raw.indexOf('TK-SECRET-12345') < 0, '凭据在磁盘上是明文！');
    deleteSecret('int_tok');
    assert.equal(getSecret('int_tok'), null);
  });

  await A('参数 source=secret: 生效，且报告里做掩码', async () => {
    setSecret('int_tok2', 'TK-8891');
    const f = F('t-secret', [
      { op: 'goto', url: DEMO + '/chain/target?orderNo=SO20261003&token=\${tok}' },
      { op: 'assert', kind: 'textPresent', text: '串联数据已接收' },
    ], {
      params: [{ name: 'tok', source: 'secret:int_tok2', secret: true, required: true }],
      assertions: [{ kind: 'textPresent', text: '串联数据已接收' }],
    });
    saveFlow(f);
    created.push(f.id);
    const rep = await run(loadFlow(f.id), { allowLintErrors: false });
    assert.equal(rep.status, 'pass', rep.error);
    assert.ok(JSON.stringify(rep).indexOf('TK-8891') < 0, '报告里泄露了凭据明文');
    assert.ok(String(rep.params.tok).indexOf('*') >= 0, '参数没有被掩码: ' + rep.params.tok);
    deleteSecret('int_tok2');
  });

  /* ================= G9 表格参数（文章的核心诉求：单号从 Excel 取） ================= */
  G('9', '从表格文件取参数');
  await A('CSV 取单号并真正填进页面', async () => {
    const csv = path.join(TMP, 'orders.csv');
    fs.writeFileSync(csv, '\uFEFF单号,客户\nSO-CSV-777,张伟\nSO-CSV-888,李娜\n', 'utf8');
    const tbl = readTable(csv);
    assert.deepEqual(tbl.headers, ['单号', '客户']);
    assert.equal(resolveColumn(tbl, '客户'), 1);

    const f = F('t-csv-param', [
      gt(DEMO + '/form'),
      fl('orderNo', '\${单号}'),
      { op: 'check', locators: L('agree'), checked: true },
      clkNav('formSubmit'),
      { op: 'waitForText', text: '工单提交成功' },
      ext('echoOrderNo', 'echo'),
    ], {
      params: [{ name: '单号', source: 'csv:' + csv + '#单号@1', required: true }],
      assertions: [{ kind: 'extracted', as: 'echo', equals: 'SO-CSV-888' }],
    });
    const rep = await run(f);
    assert.equal(rep.status, 'pass', JSON.stringify(rep.assertions) + ' ' + rep.error);
    assert.equal(rep.extracted.echo, 'SO-CSV-888');
  });

  await A('表格整列取值（@*）换行拼接', async () => {
    const csv = path.join(TMP, 'multi.csv');
    fs.writeFileSync(csv, '单号\nA1\nA2\nA3\n', 'utf8');
    const f = F('t-csv-all', [gt(DEMO + '/form')], {
      params: [{ name: '单号s', source: 'csv:' + csv + '#单号@*' }],
      assertions: [{ kind: 'textPresent', text: '提交工单' }],
    });
    const rep = await run(f);
    assert.equal(rep.status, 'pass', rep.error);
  });

  /* ================= G10 证据与报告 ================= */
  G('10', '证据、报告与预检');
  await A('evidenceOn=never 时不产截图', async () => {
    const f = F('t-noev', [gt(DEMO + '/form')], { assertions: [{ kind: 'textPresent', text: '提交工单' }] });
    const rep = await run(f, { evidenceOn: 'never' });
    assert.equal(rep.status, 'pass', rep.error);
    assert.equal(rep.screenshots.length, 0, '仍然产生了截图: ' + JSON.stringify(rep.screenshots));
  });

  await A('失败时自动截当前屏并写报告', async () => {
    const f = F('t-failshot', [gt(DEMO + '/form'), clk('nopeBtn')], { assertions: [{ kind: 'textPresent', text: 'x' }] });
    const rep = await run(f, { allowLintErrors: true });
    assert.equal(rep.status, 'fail');
    assert.ok(rep.screenshots.length > 0, '失败没有截图');
    assert.ok(rep.reportPath && fs.existsSync(rep.reportPath), '报告不存在');
    assert.ok(fs.existsSync(rep.screenshots[0]), '截图文件不存在');
  });

  await A('run_history / loadRun 能读到刚才的执行', async () => {
    const runs = listRuns('t-failshot', 10);
    assert.ok(runs.length > 0, '没有历史记录');
    const latest = loadRun('t-failshot', 'latest');
    assert.ok(latest && latest.flowId === 't-failshot', 'latest 读取失败');
    assert.equal(latest.status, 'fail');
  });

  await A('preflight 非破坏性预检能命中定位符', async () => {
    const f = F('t-preflight', [
      gt(DEMO + '/form'),
      fl('orderNo', 'x'),
      clk('formSubmit'),
    ], { assertions: [{ kind: 'textPresent', text: 'x' }] });
    const r = await preflightFlow(f, { headed: false });
    assert.ok(!r.error, '预检异常: ' + r.error);
    const checked = r.steps.filter((s) => s.checked);
    assert.ok(checked.length >= 2, '预检没有检查步骤');
    assert.ok(checked.some((s) => s.resolvable), '起始页能命中的元素一个都没命中');
  });

  /* ================= G11 录制器边界 ================= */
  G('11', '录制器边界');
  await A('重复 record_start 被拒绝', async () => {
    const a = await startRecording({ url: DEMO + '/form', name: 'int-dup' });
    assert.ok(a.ok, JSON.stringify(a));
    const b = await startRecording({ url: DEMO + '/form', name: 'int-dup2' });
    assert.equal(b.ok, false, '第二次录制竟然开始了');
    assert.ok(/进行中/.test(b.error || ''), '提示不明确: ' + b.error);
    const st = recordingStatus();
    assert.equal(st.recording, true);
    const c = await cancelRecording();
    assert.ok(c.ok, JSON.stringify(c));
    assert.equal(recordingStatus().recording, false);
  });

  await A('没有录制会话时 record_stop 报错', async () => {
    const r = await stopRecording({});
    assert.equal(r.ok, false);
    assert.ok(/没有/.test(r.error || ''), r.error);
  });

  await A('record_cancel 丢弃已录步骤', async () => {
    const a = await startRecording({ url: DEMO + '/form', name: 'int-cancel' });
    const page = activeSession().page;
    await page.waitForSelector('[data-testid="orderNo"]');
    await page.fill('[data-testid="orderNo"]', 'SO-CANCEL');
    await sleep(900);
    assert.ok(recordingStatus().stepCount > 0, '没有录到步骤');
    const c = await cancelRecording();
    assert.ok(c.ok);
    assert.ok(c.discardedSteps > 0, '没有丢弃步骤');
  });

  /* ================= G12 告警 ================= */
  G('12', '告警链路');
  const alarm = await startAlarmReceiver();
  await A('sendNotify 真能把消息 POST 出去', async () => {
    const cfg = { notify: { enabled: true, type: 'generic', webhook: alarm.url, on: ['failure', 'success'], timeoutMs: 5000 } };
    const res = await sendNotify({ title: 'T', text: 'hello', markdown: 'm', data: { flowId: 'x' } }, cfg, { force: true });
    console.log('      发送结果: ' + JSON.stringify(res));
    assert.ok(res.sent, '发送失败: ' + JSON.stringify(res));
    assert.ok(alarm.got.length >= 1, '接收端没收到');
    assert.equal(alarm.got[0].flowId, 'x');
  });

  await A('失败流程会触发告警并带上失败信息', async () => {
    const before = alarm.got.length;
    const f = F('t-alarm', [gt(DEMO + '/error')], { assertions: [{ kind: 'noErrorBanner', message: '不该有错误' }] });
    ensureNotifyConfig(alarm.url);
    try {
      const rep = await run(f, { notify: true });
      assert.equal(rep.status, 'fail');
      await sleep(600);
      const newOnes = alarm.got.slice(before);
      assert.ok(newOnes.length > 0, '没有发出告警');
      const last = newOnes[newOnes.length - 1];
      console.log('      告警内容: ' + JSON.stringify(last).slice(0, 300));
      assert.equal(last.flowId, 't-alarm');
      assert.ok(last.assertions && last.assertions.some((a) => !a.pass), '告警缺少失败断言明细');
    } finally { restoreNotifyConfig(); }
  });

  await A('composeRunMessage 关键信息齐全', async () => {
    const f = F('t-msg', [gt(DEMO + '/error')], { assertions: [{ kind: 'noErrorBanner' }] });
    const rep = await run(f, { allowLintErrors: true });
    const msg = composeRunMessage(rep, { notify: {} });
    assert.ok(msg.title.indexOf('t-msg') >= 0, '缺少流程名');
    assert.ok(msg.text.indexOf('校验') >= 0 || msg.markdown.indexOf('校验') >= 0, '缺少校验信息');
  });

  /* ================= G13 定时包装器 ================= */
  G('13', '定时包装器');
  await A('各种频率都能生成可执行的 .cmd 包装器', async () => {
    for (const spec of [
      { frequency: 'daily', at: '09:00' },
      { frequency: 'weekly', at: '08:30', days: ['MON', 'WED'] },
      { frequency: 'minute', everyMinutes: 15 },
      { frequency: 'hourly', everyHours: 2, at: '07:00' },
      { frequency: 'logon' },
      { frequency: 'once', at: '10:00', date: '2026/12/31' },
    ]) {
      const w = writeWrapper('t-sched', spec);
      assert.ok(fs.existsSync(w), '包装器不存在: ' + w);
      const txt = fs.readFileSync(w, 'utf8');
      assert.ok(txt.indexOf('runner.mjs') > 0, '未调用 runner');
      assert.ok(txt.indexOf('--trigger') > 0, '未带 trigger');
    }
  });

  await A('带 params 的包装器会写出参数文件并被 runner 读取', async () => {
    const w = writeWrapper('t-sched', { frequency: 'daily', at: '09:00', params: { A: '1', B: '2' } });
    const txt = fs.readFileSync(w, 'utf8');
    assert.ok(txt.indexOf('--params-file') > 0, '未传参数文件: ' + txt);
    const m = /--params-file"\s+"([^"]+)"/.exec(txt.replace(/\s+/g, ' '));
    const pf = m ? m[1] : w.replace(/\.cmd$/, '.params.json');
    assert.ok(fs.existsSync(pf), '参数文件不存在: ' + pf);
    const obj = JSON.parse(fs.readFileSync(pf, 'utf8'));
    assert.deepEqual(obj, { A: '1', B: '2' });
  });

  /* ================= G15 无人值守运维 ================= */
  G('15', '无人值守运维');

  await A('并发锁：同一流程第二次执行被挡住，释放后可正常跑', async () => {
    const f = F('t-lock', [gt(DEMO + '/form')], { assertions: [{ kind: 'textPresent', text: '提交工单' }] });
    assert.ok(acquireLock('t-lock', { trigger: 'test' }).ok, '首次加锁失败');
    try {
      const blocked = await run(f, { allowLintErrors: true });
      assert.equal(blocked.status, 'blocked', '应当被锁挡住，实际 ' + blocked.status);
      assert.ok(/正在执行中/.test(blocked.error || ''), '错误信息不明确: ' + blocked.error);
      const info = lockInfo('t-lock');
      assert.equal(info.held, true, '锁状态不对: ' + JSON.stringify(info));
    } finally { releaseLock('t-lock'); }
    const ok2 = await run(f, { allowLintErrors: true });
    assert.equal(ok2.status, 'pass', '释放锁后应当能跑: ' + ok2.error);
  });

  await A('弹窗：expectDialog=接受 时 confirm 走「确定」分支', async () => {
    const f = F('t-dlg-accept', [
      gt(DEMO + '/dialog'),
      { op: 'click', locators: L('confirmBtn'), expectDialog: { accept: true } },
      { op: 'waitForText', text: '已确认提交' },
    ], { assertions: [{ kind: 'textPresent', text: '已确认提交' }] });
    const rep = await run(f);
    console.log('      弹窗记录: ' + JSON.stringify(rep.dialogs));
    assert.equal(rep.status, 'pass', rep.error);
    assert.equal(rep.dialogs.length, 1, '弹窗记录数量不对');
    assert.equal(rep.dialogs[0].action, 'accept');
    assert.equal(rep.dialogs[0].handled, true, '应标记为已处理');
  });

  await A('弹窗：dialog 步骤同样生效（手工流程用）', async () => {
    const f = F('t-dlg-step', [
      gt(DEMO + '/dialog'),
      { op: 'dialog', accept: false },
      { op: 'click', locators: L('confirmBtn') },
      { op: 'waitForText', text: '已取消提交' },
    ], { assertions: [{ kind: 'textPresent', text: '已取消提交' }] });
    const rep = await run(f);
    assert.equal(rep.status, 'pass', rep.error);
    assert.equal(rep.dialogs[0].action, 'dismiss', '应当取消: ' + JSON.stringify(rep.dialogs));
  });

  await A('弹窗：未处理时自动取消并判失败（静默失败类）', async () => {
    const f = F('t-dlg-bad', [
      gt(DEMO + '/dialog'),
      { op: 'click', locators: L('confirmBtn') },
      { op: 'waitForText', text: '已取消提交' },
    ], { assertions: [{ kind: 'textPresent', text: '已取消提交' }] });
    const rep = await run(f);
    assert.equal(rep.status, 'fail', '未处理的弹窗竟然通过了');
    const da = rep.assertions.find((a) => a.kind === 'noUnexpectedDialog');
    assert.ok(da && !da.pass, '缺少弹窗断言: ' + JSON.stringify(rep.assertions.map((a) => a.kind + ':' + a.pass)));
  });

  await A('弹窗：strictDialogs=false 时只提示不判失败', async () => {
    const before = readConfig().run.strictDialogs;
    writeConfig({ run: { strictDialogs: false } });
    try {
      const f = F('t-dlg-lenient', [
        gt(DEMO + '/dialog'),
        { op: 'click', locators: L('confirmBtn') },
        { op: 'waitForText', text: '已取消提交' },
      ], { assertions: [{ kind: 'textPresent', text: '已取消提交' }] });
      const rep = await run(f);
      assert.equal(rep.status, 'pass', '宽松模式下不该失败: ' + rep.error);
      const da = rep.assertions.find((a) => a.kind === 'noUnexpectedDialog');
      assert.ok(da && da.pass, '弹窗断言应通过');
    } finally { writeConfig({ run: { strictDialogs: before } }); }
  });

  await A('日期偏移变量可用（today-7 / today+1）', async () => {
    const f = F('t-dateoff', [
      gt(DEMO + '/form'),
      fl('orderNo', '${today-7:YYYYMMDD}'),
      { op: 'extract', locators: L('orderNo'), as: 'v' },
    ], { assertions: [{ kind: 'extracted', as: 'v', matches: '^[0-9]{8}$' }] });
    const rep = await run(f);
    assert.equal(rep.status, 'pass', rep.error);
    const expect = formatDate(new Date(Date.now() - 7 * 86400000), 'YYYYMMDD');
    assert.equal(rep.extracted.v, expect, '偏移值不对: ' + rep.extracted.v + ' != ' + expect);
  });

  await A('截图脱敏：有密码框时打码并标记', async () => {
    const f = F('t-mask-yes', [gt(DEMO + '/login')], { assertions: [{ kind: 'textPresent', text: '登录' }] });
    const rep = await run(f, { evidenceOn: 'always' });
    assert.equal(rep.status, 'pass', rep.error);
    assert.equal(rep.evidenceMasked, true, '有密码框却没有打码');
  });

  await A('截图脱敏：无敏感字段时不打码', async () => {
    const f = F('t-mask-no', [gt(DEMO + '/form')], { assertions: [{ kind: 'textPresent', text: '提交工单' }] });
    const rep = await run(f, { evidenceOn: 'always' });
    assert.equal(rep.status, 'pass', rep.error);
    assert.equal(rep.evidenceMasked, false, '不该打码');
  });

  await A('无限滚动：scrollTo 触发分批加载直到第 3 批', async () => {
    const f = F('t-infinite', [
      gt(DEMO + '/infinite'),
      { op: 'scrollTo', to: 'bottom', times: 4, waitMs: 600 },
      { op: 'assert', kind: 'textPresent', text: '已加载 3 批' },
    ], { assertions: [{ kind: 'textPresent', text: '已加载 3 批' }] });
    const rep = await run(f);
    assert.equal(rep.status, 'pass', rep.error);
  });

  await A('Shadow DOM：影子按钮可录制且可回放', async () => {
    const rec = await startRecording({ url: DEMO + '/shadow', name: 't-shadow' });
    assert.ok(rec.ok, JSON.stringify(rec));
    const page = activeSession().page;
    await page.waitForSelector('#host');
    await page.locator('[data-testid="shadowBtn"]').click();
    await sleep(700);
    const stop = await stopRecording({ name: 't-shadow' });
    assert.ok(stop.ok, JSON.stringify(stop));
    created.push(stop.flowId);
    const clickStep = stop.flow.steps.find((s) => s.op === 'click');
    assert.ok(clickStep, '没录到影子按钮点击');
    assert.ok((clickStep.locators || []).some((l) => l.value === 'shadowBtn'), '定位符缺少 shadowBtn: ' + JSON.stringify((clickStep.locators || []).map((l) => l.strategy + ':' + l.value)));
    const flow = loadFlow(stop.flowId);
    flow.assertions = [{ kind: 'textPresent', text: '影子已点击', message: '影子按钮必须生效' }];
    saveFlow(flow);
    const rep = await run(loadFlow(flow.id));
    console.log('      shadow 回放=' + rep.status + ' 错误=' + (rep.error || '无'));
    assert.equal(rep.status, 'pass', 'Shadow DOM 回放失败: ' + rep.error);
  });

  await A('中断检测：有开始标记但没有报告 -> interrupted', async () => {
    const f = F('t-interrupted', [gt(DEMO + '/form')], { assertions: [{ kind: 'textPresent', text: '提交工单' }] });
    saveFlow(f);
    created.push(f.id);
    writeRunningMarker(f.id, '20260101-000000-000', { trigger: 'schedule' });
    const runs = listRuns(f.id, 5);
    assert.ok(runs.some((r) => r.status === 'interrupted'), 'listRuns 没暴露中断: ' + JSON.stringify(runs));
    assert.ok(interruptedRun(f.id), 'interruptedRun 没找到');
    const st = statusReport({});
    const item = st.items.find((i) => i.flowId === f.id);
    assert.ok(item, 'statusReport 缺少该流程');
    assert.ok(item.interrupted, 'statusReport 没标出中断');
    assert.ok(st.problems.some((x) => /中断/.test(x.message)), 'problems 没报中断: ' + JSON.stringify(st.problems));
  });

  await A('总览：正常流程被算作健康', async () => {
    const st = statusReport({});
    const demoItem = st.items.find((i) => i.flowId === '演示-订单日报导出');
    if (demoItem) {
      console.log('      演示流程: ' + JSON.stringify({ last: demoItem.lastStatus, runs: demoItem.totalRuns, scheduled: !!demoItem.scheduled }));
      // 发布包首跑（全新机器、还没有历史运行记录）只要求演示流程被收录；跑过之后才要求最近一次成功
      if (demoItem.totalRuns > 0) assert.equal(demoItem.lastStatus, 'pass', '演示流程最近一次应当成功');
    }
    assert.ok(typeof st.summary.flows === 'number' && st.summary.flows >= 1, 'summary 不对: ' + JSON.stringify(st.summary));
  });

  await A('留存清理：预演不删、应用后只保留最新 N 次', async () => {
    const f = F('t-retention', [gt(DEMO + '/form')], { assertions: [{ kind: 'textPresent', text: '提交工单' }] });
    saveFlow(f);
    created.push(f.id);
    for (let i = 0; i < 3; i++) {
      const r = await run(f);
      assert.equal(r.status, 'pass', r.error);
    }
    const count = () => fs.readdirSync(path.join(DIRS.runs, f.id)).filter((d) => {
      try { return fs.statSync(path.join(DIRS.runs, f.id, d)).isDirectory(); } catch { return false; }
    }).length;
    const before = count();
    assert.ok(before >= 3, '运行记录不足: ' + before);
    const dry = pruneRuns(f.id, { keepCount: 1, keepDays: 0, dryRun: true });
    assert.ok(dry.removed.length >= 2, '预演应列出待删: ' + JSON.stringify(dry));
    assert.equal(count(), before, '预演不应真的删除');
    const real = pruneRuns(f.id, { keepCount: 1, keepDays: 0, dryRun: false });
    assert.ok(real.removed.length >= 2, JSON.stringify(real));
    assert.equal(count(), 1, '应只剩 1 次，实际 ' + count());
  });

  await A('env 来源的参数会被静态检查提醒（L023）', async () => {
    const lint = lintFlow({
      id: 't-env', steps: [{ op: 'goto', url: DEMO + '/form' }],
      params: [{ name: 'p', source: 'env:FOO' }], assertions: [{ kind: 'textPresent', text: 'x' }],
    }, {});
    assert.ok(lint.warnings.some((w) => w.code === 'L023'), '没有报 L023: ' + JSON.stringify(lint.warnings.map((w) => w.code)));
  });

  await A('弹窗有记录时静态检查给出提示（L025）', async () => {
    const lint = lintFlow({
      id: 't-dlglint', startUrl: DEMO + '/dialog',
      steps: [{ op: 'goto', url: DEMO + '/dialog' }, { op: 'click', locators: L('confirmBtn'), expectDialog: { accept: true, message: '确认提交这笔单据吗？' } }],
      params: [], assertions: [{ kind: 'textPresent', text: 'x' }],
    }, {});
    assert.ok(lint.infos.some((i2) => i2.code === 'L025'), '没有报 L025: ' + JSON.stringify(lint.infos.map((i2) => i2.code)));
  });

  /* ================= G14 静态检查 ================= */
  G('14', '静态检查');
  await A('goto 指向浏览器内置页时被静态检查阻断（L002）', async () => {
    const f = F('t-badurl', [{ op: 'goto', url: 'edge://downloads-hub/' }], {
      assertions: [{ kind: 'textPresent', text: 'x' }],
    });
    const lint = lintFlow(f, {});
    assert.ok(lint.errors.some((e2) => e2.code === 'L002'), '没有报 L002: ' + JSON.stringify(lint.errors));
    const rep = await run(f, { allowLintErrors: false });
    assert.equal(rep.status, 'blocked', '应当被阻断，实际 ' + rep.status);
  });

  await A('无任何步骤的流程被阻断（L000）', async () => {
    const lint = lintFlow({ id: 't-empty', steps: [], params: [], assertions: [{ kind: 'textPresent', text: 'x' }] }, {});
    assert.ok(lint.errors.some((e2) => e2.code === 'L000'), '没有报 L000: ' + JSON.stringify(lint.errors));
  });

  /* ================= G16 剩余能力 ================= */
  G('16', '剩余能力（clickAndDownload / runner CLI / 浏览器配置）');

  await A('clickAndDownload 一步完成"点击 + 等下载"', async () => {
    const f = F('t-clickdl', [
      gt(DEMO + '/form'),
      { op: 'clickAndDownload', locators: L('dlLink3') },
    ], { assertions: [{ kind: 'download', minBytes: 1, minLines: 4, message: '下载必须有表头 + 3 行' }] });
    const rep = await run(f);
    assert.equal(rep.status, 'pass', JSON.stringify(rep.assertions) + ' ' + rep.error);
    assert.equal(rep.downloads.length, 1, '没有捕获到下载: ' + JSON.stringify(rep.downloads));
  });

  await A('runner CLI：help / list / show / history / status / prune / doctor 全部可用', async () => {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const exec = promisify(execFile);
    const runnerPath = path.join(process.cwd(), 'runner.mjs');
    const cases = [
      { args: ['help'], expect: /用法/, allowFail: true },
      { args: ['list'], expect: /演示-订单日报导出|还没有任何流程/ },
      { args: ['show', '演示-订单日报导出'], expect: /步骤/ },
      { args: ['history', '演示-订单日报导出'], expect: /stamp|\[/ },
      // status 在"有问题"时故意返回退出码 1（可直接接告警），所以这里允许非零退出
      { args: ['status'], expect: /summary/, allowFail: true },
      { args: ['prune'], expect: /预演/ },
      { args: ['doctor'], expect: /playwright/, allowFail: true },
    ];
    for (const cse of cases) {
      let out = '';
      try {
        const r1 = await exec(process.execPath, [runnerPath].concat(cse.args), { cwd: process.cwd(), timeout: 120000, maxBuffer: 8388608 });
        out = String(r1.stdout || '') + String(r1.stderr || '');
      } catch (e1) {
        out = String(e1.stdout || '') + String(e1.stderr || '');
        if (!cse.allowFail) throw new Error('runner ' + cse.args.join(' ') + ' 失败: ' + out.slice(0, 200));
      }
      assert.ok(cse.expect.test(out), 'runner ' + cse.args.join(' ') + ' 输出不符: ' + out.slice(0, 200));
    }
  });

  await A('浏览器配置：显式 channel=msedge 可运行', async () => {
    writeConfig({ browser: { channel: 'msedge' } });
    try {
      const f = F('t-cfg-channel', [gt(DEMO + '/form')], { assertions: [{ kind: 'textPresent', text: '提交工单' }] });
      const rep = await run(f);
      assert.equal(rep.status, 'pass', rep.error);
    } finally { writeConfig({ browser: { channel: null } }); }
    assert.equal(readConfig().browser.channel, null, 'channel 未能恢复默认');
  });

  await A('浏览器配置：userAgent 与 viewport 真正生效', async () => {
    writeConfig({ browser: { userAgent: 'WebRPA-Test-UA/9.9', viewport: { width: 800, height: 600 } } });
    try {
      const f = F('t-cfg-ua', [
        gt(DEMO + '/echo'),
        { op: 'extract', locators: L('vp'), as: 'vp' },
      ], {
        assertions: [
          { kind: 'textPresent', text: 'WebRPA-Test-UA/9.9', message: 'userAgent 未生效' },
          { kind: 'extracted', as: 'vp', matches: '^viewport: 800x600$', message: 'viewport 未生效' },
        ],
      });
      const rep = await run(f);
      console.log('      viewport 实测: ' + rep.extracted.vp);
      assert.equal(rep.status, 'pass', JSON.stringify(rep.assertions) + ' ' + rep.error);
    } finally { writeConfig({ browser: { userAgent: null, viewport: null } }); }
    assert.equal(readConfig().browser.viewport.width, 1440, 'viewport 未能恢复默认');
  });

  await A('浏览器配置：headed=true 且 slowMo 可正常执行', async () => {
    writeConfig({ browser: { slowMo: 30 } });
    try {
      const f = F('t-cfg-headed', [gt(DEMO + '/form')], { assertions: [{ kind: 'textPresent', text: '提交工单' }] });
      const rep = await run(f, { headed: true });
      assert.equal(rep.status, 'pass', rep.error);
    } finally { writeConfig({ browser: { slowMo: null } }); }
    assert.equal(readConfig().browser.slowMo, 0, 'slowMo 未能恢复默认');
  });

  /* ================= G17 片段重录（splice） ================= */
  G('17', '片段重录');

  async function mkSpliceFlow(id) {
    const f = F(id, [
      gt(DEMO + '/form'),
      fl('orderNo', 'SO-BEFORE'),
      { op: 'check', locators: L('agree'), checked: true },
      clkNav('formSubmit'),
      { op: 'waitForText', text: '工单提交成功' },
    ], { assertions: [{ kind: 'textPresent', text: '工单提交成功' }] });
    saveFlow(f);
    created.push(id);
    return f;
  }

  await A('片段重录：只重做中间一步，前缀被真实重放（已填字段不必重做）', async () => {
    const id = 't-splice-mid';
    await mkSpliceFlow(id);
    const r = await startSplice({ flowId: id, from: 3, to: 3 });
    assert.ok(r.ok, JSON.stringify(r));
    assert.equal(r.splice.prefixCount, 2, '前缀步数不对');
    const page = activeSession().page;
    const noValue = await page.inputValue('[data-testid="orderNo"]');
    assert.equal(noValue, 'SO-BEFORE', '前缀没有真正重放（工单号没被填上）');
    await page.check('[data-testid="agree"]');
    await sleep(800);
    const stop = await stopRecording({ name: id });
    assert.ok(stop.ok, JSON.stringify(stop));
    assert.equal(stop.mode, 'splice');
    assert.equal(stop.splice.insertedSteps, 1, '新片段应只有 1 步');
    assert.equal(stop.splice.prefixSteps, 2);
    assert.equal(stop.splice.suffixSteps, 2);
    assert.equal(stop.splice.totalAfter, 5);
    const segText = stop.insertedSteps.join(' | ');
    assert.ok(!/填入/.test(segText), '片段里不该再有"填入"（说明前缀没被真实重放）: ' + segText);
    assert.ok(stop.backupPath && fs.existsSync(stop.backupPath), '没有生成备份');
    const rep = await run(loadFlow(id), { allowLintErrors: false });
    assert.equal(rep.status, 'pass', '拼接后回放失败: ' + rep.error);
  });

  await A('片段重录：重录到最后一步（后缀为空）且能回放', async () => {
    const id = 't-splice-tail';
    await mkSpliceFlow(id);
    const r = await startSplice({ flowId: id, from: 4 });
    assert.ok(r.ok, JSON.stringify(r));
    assert.equal(r.splice.to, 5, 'to 默认应当是最后一步');
    const page = activeSession().page;
    await page.click('[data-testid="formSubmit"]');
    await page.waitForSelector('[data-testid="formOk"]', { timeout: 15000 });
    await sleep(900);
    const stop = await stopRecording({ name: id });
    assert.ok(stop.ok, JSON.stringify(stop));
    assert.equal(stop.splice.suffixSteps, 0);
    assert.ok(stop.splice.insertedSteps >= 1, '片段应有步骤');
    const rep = await run(loadFlow(id), { allowLintErrors: false });
    assert.equal(rep.status, 'pass', '回放失败: ' + rep.error);
  });

  await A('片段重录：keepSuffix=false 时丢弃后面的原步骤', async () => {
    const id = 't-splice-nosuffix';
    await mkSpliceFlow(id);
    const r = await startSplice({ flowId: id, from: 4, keepSuffix: false });
    assert.ok(r.ok, JSON.stringify(r));
    const page = activeSession().page;
    await page.click('[data-testid="formSubmit"]');
    await page.waitForSelector('[data-testid="formOk"]', { timeout: 15000 });
    await sleep(900);
    const stop = await stopRecording({ name: id });
    assert.ok(stop.ok, JSON.stringify(stop));
    assert.equal(stop.splice.suffixSteps, 0);
    assert.equal(stop.splice.totalAfter, 3 + stop.splice.insertedSteps);
    const rep = await run(loadFlow(id), { allowLintErrors: false });
    assert.equal(rep.status, 'pass', '回放失败: ' + rep.error);
  });

  await A('片段重录：没有操作就结束 -> 拒绝保存且原流程不变', async () => {
    const id = 't-splice-empty';
    await mkSpliceFlow(id);
    const before = JSON.stringify(loadFlow(id).steps);
    const r = await startSplice({ flowId: id, from: 3, to: 3 });
    assert.ok(r.ok, JSON.stringify(r));
    await sleep(500);
    const stop = await stopRecording({ name: id });
    assert.equal(stop.ok, false, '空片段不该保存');
    assert.ok(/没有录到任何步骤/.test(stop.error || ''), '错误信息不明确: ' + stop.error);
    assert.equal(JSON.stringify(loadFlow(id).steps), before, '原流程被改动了');
  });

  await A('片段重录：新片段同样做日期自动变量化', async () => {
    const id = 't-splice-var';
    await mkSpliceFlow(id);
    const r = await startSplice({ flowId: id, from: 3, to: 3 });
    assert.ok(r.ok, JSON.stringify(r));
    const page = activeSession().page;
    await page.fill('[data-testid="note"]', formatDate(new Date(), 'YYYY-MM-DD'));
    await sleep(900);
    const stop = await stopRecording({ name: id });
    assert.ok(stop.ok, JSON.stringify(stop));
    const hit = loadFlow(id).steps.find((s) => s.op === 'fill' && String(s.value).indexOf('${today') === 0);
    assert.ok(hit, '新片段里的"今天"没有被变量化: ' + JSON.stringify(loadFlow(id).steps.filter((s) => s.op === 'fill').map((s) => s.value)));
  });

  await A('片段重录：非法序号与不存在的流程都被拒绝', async () => {
    const id = 't-splice-bad';
    await mkSpliceFlow(id);
    const a1 = await startSplice({ flowId: id, from: 9 });
    assert.equal(a1.ok, false);
    assert.ok(/超出流程步骤数/.test(a1.error || ''), a1.error);
    const a2 = await startSplice({ flowId: id, from: 4, to: 2 });
    assert.equal(a2.ok, false);
    assert.ok(/to 必须 >= from/.test(a2.error || ''), a2.error);
    const a3 = await startSplice({ flowId: 'no-such-flow', from: 1 });
    assert.equal(a3.ok, false);
    assert.ok(/流程不存在/.test(a3.error || ''), a3.error);
    assert.equal(activeSession(), null, '失败的启动不该留下会话');
  });

  await A('片段重录期间同一流程被执行会被锁挡住，取消后恢复', async () => {
    const id = 't-splice-lock';
    await mkSpliceFlow(id);
    const r = await startSplice({ flowId: id, from: 3, to: 3 });
    assert.ok(r.ok, JSON.stringify(r));
    const blocked = await run(loadFlow(id), { allowLintErrors: true });
    assert.equal(blocked.status, 'blocked', '重录期间竟能被执行: ' + blocked.status);
    assert.ok(/正在执行中/.test(blocked.error || ''), blocked.error);
    const c = await cancelRecording();
    assert.ok(c.ok, JSON.stringify(c));
    assert.equal(c.originalFlowUntouched, true, '取消应说明原流程未改动');
    const after = await run(loadFlow(id), { allowLintErrors: true });
    assert.equal(after.status, 'pass', '取消后应能执行: ' + after.error);
  });

  await A('备份与回滚：flow_restore 能回到改动前的定义', async () => {
    const id = 't-splice-restore';
    await mkSpliceFlow(id);
    const beforeSteps = JSON.stringify(loadFlow(id).steps);
    const r = await startSplice({ flowId: id, from: 3, to: 3 });
    assert.ok(r.ok, JSON.stringify(r));
    const page = activeSession().page;
    await page.check('[data-testid="agree"]');
    await sleep(800);
    const stop = await stopRecording({ name: id });
    assert.ok(stop.ok, JSON.stringify(stop));
    assert.equal((loadFlow(id).spliceHistory || []).length, 1, '没有记录 spliceHistory');
    const backups = listBackups(id);
    assert.ok(backups.length >= 1, '没有备份');
    const res = restoreFlow(id);
    assert.ok(res.ok, JSON.stringify(res));
    assert.deepEqual(JSON.parse(JSON.stringify(loadFlow(id).steps)), JSON.parse(beforeSteps), '回滚后步骤与改动前不一致');
  });

  /* ================= 收尾 ================= */
  for (const id of created) { try { deleteFlow(id); } catch { /* ignore */ } }
  for (const id of ['t-select', 't-uncheck', 't-press', 't-hover', 't-scroll', 't-slow', 't-extract', 't-optional',
    't-asserts', 't-errbanner', 't-list-ok', 't-list-empty', 't-dl-ok', 't-dl-empty', 't-dl-strict', 't-assert-mix', 't-guard',
    't-guard2', 't-guard-ok', 't-retry', 't-human-headless', 't-human-headed', 't-secret', 't-csv-param',
    't-csv-all', 't-noev', 't-failshot', 't-preflight', 't-alarm', 't-msg',
    't-lock', 't-dlg-accept', 't-dlg-step', 't-dlg-bad', 't-dlg-lenient', 't-dateoff',
    't-mask-yes', 't-mask-no', 't-infinite', 't-interrupted', 't-retention', 't-badurl',
    't-splice-mid', 't-splice-tail', 't-splice-nosuffix', 't-splice-empty', 't-splice-var',
    't-splice-bad', 't-splice-lock', 't-splice-restore']) {
    try { deleteFlow(id); } catch { /* ignore */ }
    try { fs.rmSync(path.join(DIRS.runs, id), { recursive: true, force: true }); } catch { /* ignore */ }
  }
  alarm.server.close();
  demo.server.close();
  await closeAll();
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }

  console.log('\n总计: ' + pass + ' passed, ' + fail + ' failed, ' + skip + ' 诚实SKIP');
  if (fail) console.log('\n失败项:\n' + failures.join('\n'));
  process.exit(fail ? 1 : skip ? 3 : 0);
}

/* 临时开启告警配置以便测试真实链路 */
let __notifyBackup = null;
function ensureNotifyConfig(url) {
  __notifyBackup = readConfig().notify;
  writeConfig({ notify: { enabled: true, type: 'generic', webhook: url, on: ['failure', 'success', 'healed'], timeoutMs: 5000 } });
}
function restoreNotifyConfig() {
  if (__notifyBackup) writeConfig({ notify: __notifyBackup });
}

main().catch(async (e) => {
  const msg = String(e && e.message ? e.message : e);
  try { await closeAll(); } catch { /* ignore */ }
  if (pwMissing && depSig.test(msg)) {
    console.log('\nSKIP 集成测试（整体）（诚实 SKIP：环境缺 playwright 依赖——先在 mcp 目录 npm install）');
    console.log('\n总计: ' + pass + ' passed, ' + fail + ' failed, 1 诚实SKIP');
    process.exit(3);
  }
  console.error('\n集成测试异常: ' + String(e && e.stack ? e.stack : e));
  process.exit(1);
});
