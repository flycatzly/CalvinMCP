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
import { loadFlow, saveFlow, deleteFlow, listFlows, flowMarkdown, stepLabel, listRuns, loadRun, listBackups, restoreFlow, backupFlow, saveRun } from '../lib/store.mjs';
import { lintFlow } from '../lib/lint.mjs';
import { setSecret, getSecret, listSecrets, deleteSecret } from '../lib/secrets.mjs';
import { readTable, resolveColumn } from '../lib/table.mjs';
import { composeRunMessage, sendNotify, outboxCount, outboxInfo } from '../lib/notify.mjs';
import { writeWrapper } from '../lib/schedule.mjs';
import {
  statusReport, pruneRuns, pruneLogs, acquireLock, releaseLock, lockInfo,
  writeRunningMarker, interruptedRun, liveRunInfo,
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

/* 告警发件箱（.work/notify-outbox.json）是全局落盘状态，测试前后都要清干净，
   否则上一次残留的积压会在下一次 sendNotify 时被补发，打乱 hits 计数断言 */
const OUTBOX = path.join(DIRS.work, 'notify-outbox.json');
function clearOutbox() { try { fs.rmSync(OUTBOX, { force: true }); } catch { /* ignore */ } }

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

  await A('run.retries=0 时不重试（首次断连直接失败）', async () => {
    // 判别式：1500ms 失败窗口盖住本次 goto 的全部内部重试，重试必须等窗口外（retryDelayMs=3000）才可能成。
    // 若 run.retries 未被消费（仍按默认 1 重试）：第二次尝试落在窗口外恢复成功，此用例必红。
    const f = F('t-noretry', [gt(DEMO + '/flaky?key=noretry&failWindow=1500'), { op: 'assert', kind: 'textPresent', text: '服务已恢复' }]);
    const before = readConfig().run;
    writeConfig({ run: { retries: 0, retryDelayMs: 3000 } });
    try {
      const rep = await run(f);
      assert.equal(rep.status, 'fail', 'retries=0 不该重试成功: ' + rep.error);
    } finally {
      writeConfig({ run: { retries: before.retries, retryDelayMs: before.retryDelayMs } });
    }
    assert.equal(readConfig().run.retries, 1, 'retries 未恢复默认');
    assert.equal(readConfig().run.retryDelayMs, 800, 'retryDelayMs 未恢复默认');
  });

  await A('run.retries 与 retryDelayMs 配置驱动重试（判别式：延迟不被消费则重试落在失败窗口内仍失败）', async () => {
    // 失败窗口 1500ms < retryDelayMs 3000ms：只有"睡满配置延迟"的重试才落在窗口外恢复成功。
    // 若 retryDelayMs 未被消费（默认 800ms）：重试落在窗口内仍被断连 → 判失败，此用例必红。
    const f = F('t-retry-cfg', [gt(DEMO + '/flaky?key=retrycfg&failWindow=1500'), { op: 'assert', kind: 'textPresent', text: '服务已恢复' }]);
    const before = readConfig().run;
    writeConfig({ run: { retries: 1, retryDelayMs: 3000 } });
    try {
      const t0 = Date.now();
      const rep = await run(f);
      const took = Date.now() - t0;
      console.log('      重试总耗时 ' + took + 'ms（配置 retryDelayMs=3000）');
      assert.equal(rep.status, 'pass', '配置 retries=1 的重试应生效: ' + rep.error);
      assert.ok(took >= 2500, 'retryDelayMs=3000 未被消费，实际 ' + took + 'ms');
    } finally {
      writeConfig({ run: { retries: before.retries, retryDelayMs: before.retryDelayMs } });
    }
    assert.equal(readConfig().run.retryDelayMs, 800, 'retryDelayMs 未恢复默认');
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

  await A('等待人工期间 status_report 能看到 waitingHuman（真实接管窗口）', async () => {
    const f = F('t-waiting-human', [
      gt(DEMO + '/form'),
      { op: 'humanHandoff', reason: '等待人工可见性测试', timeoutMs: 8000 }, // 无恢复条件 → 固定 3s 放行窗口
    ], { assertions: [{ kind: 'textPresent', text: '提交工单' }] });
    saveFlow(f);
    created.push(f.id);
    const runP = run(f, { headed: true });
    let seen = null;
    const t0 = Date.now();
    // 判别式：轮询预算 15s ≫ 等待窗口 3s，且窗口内每 150ms 采样一次（约 20 次机会）
    while (!seen && Date.now() - t0 < 15000) {
      await new Promise((r) => setTimeout(r, 150));
      const st = statusReport({});
      const item = st.items.find((i) => i.flowId === f.id);
      if (item && item.waitingHuman) seen = item.waitingHuman;
    }
    const rep = await runP;
    assert.ok(seen, '等待窗口内 status_report 应看到 waitingHuman');
    assert.ok(/等待人工可见性测试/.test(seen.reason), 'reason 不对: ' + JSON.stringify(seen));
    assert.equal(rep.status, 'pass', '运行应正常放行: ' + rep.error);
  });

  await A('humanHandoff 不带 timeoutMs 时用 run.humanHandoffTimeoutMs 兜底', async () => {
    // 判别式：配置 2500ms；若配置未被消费（默认 180s），等待窗口拖满 3 分钟，took<15s 必红
    const f = F('t-handoff-cfg', [
      gt(DEMO + '/handoff'),
      { op: 'humanHandoff', reason: '配置兜底超时验证', resumeWhenText: '永不出现的恢复条件-XYZ' },
    ], { assertions: [{ kind: 'textPresent', text: '提交工单' }] });
    const before = readConfig().run.humanHandoffTimeoutMs;
    writeConfig({ run: { humanHandoffTimeoutMs: 2500 } });
    try {
      const t0 = Date.now();
      const rep = await run(f, { headed: true });
      const took = Date.now() - t0;
      console.log('      状态=' + rep.status + ' 耗时=' + took + 'ms 错误=' + (rep.error || '无'));
      assert.equal(rep.status, 'fail', '恢复条件永不满足应超时失败: ' + rep.error);
      assert.ok(/人工接管超时/.test(rep.error || ''), '错误应指向人工接管超时: ' + rep.error);
      assert.ok(took >= 2000 && took < 15000, '应按配置 2500ms 等待窗口超时，实际 ' + took + 'ms');
    } finally {
      writeConfig({ run: { humanHandoffTimeoutMs: before } });
    }
    assert.equal(readConfig().run.humanHandoffTimeoutMs, 180000, 'humanHandoffTimeoutMs 未恢复默认');
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

  await A('redactKeys：未标 secret 的 password 参数明文不进报告（键名脱敏+全文清除）', async () => {
    const f = F('t-redact-key', [
      { op: 'goto', url: DEMO + '/chain/target?orderNo=SO-REDACT&token=${password}' },
      { op: 'assert', kind: 'textPresent', text: '串联数据已接收' },
    ], {
      params: [{ name: 'password', required: true }],
      assertions: [{ kind: 'textPresent', text: '串联数据已接收' }],
    });
    saveFlow(f);
    created.push(f.id);
    const rep = await run(loadFlow(f.id), { params: { password: 'FAKE-PASS-911' } });
    assert.equal(rep.status, 'pass', rep.error);
    assert.equal(rep.params.password, '***', 'password 参数没被键名脱敏: ' + rep.params.password);
    assert.ok(JSON.stringify(rep).indexOf('FAKE-PASS-911') < 0, '报告里泄露了 password 明文（步骤 URL/明细未被全文清除）');
  });

  await A('security.redactKeys 自定义名单整体替换默认', async () => {
    const before = readConfig().security.redactKeys;
    writeConfig({ security: { redactKeys: ['订单号'] } });
    try {
      const f = F('t-redact-custom', [
        { op: 'goto', url: DEMO + '/chain/target?orderNo=${订单号}&token=${password}' },
        { op: 'assert', kind: 'textPresent', text: '串联数据已接收' },
      ], {
        params: [{ name: '订单号', required: true }, { name: 'password', required: true }],
        assertions: [{ kind: 'textPresent', text: '串联数据已接收' }],
      });
      saveFlow(f);
      created.push(f.id);
      const rep = await run(loadFlow(f.id), { params: { 订单号: 'FAKE-ORD-777', password: 'FAKE-PASS-222' } });
      assert.equal(rep.status, 'pass', rep.error);
      assert.equal(rep.params['订单号'], '***', '自定义名单键没被脱敏: ' + rep.params['订单号']);
      assert.equal(rep.params.password, 'FAKE-PASS-222', '名单外的键应保持明文（自定义名单整体替换默认）');
      assert.ok(JSON.stringify(rep).indexOf('FAKE-ORD-777') < 0, '命中键的原值未被全文清除');
    } finally {
      writeConfig({ security: { redactKeys: before } });
    }
  });

  await A('maskSecrets=false 只放开参数脱敏，secret 凭据仍打码且全文清除', async () => {
    setSecret('int_tok3', 'TK-FAKE-777');
    const before = readConfig().security.maskSecrets;
    writeConfig({ security: { maskSecrets: false } });
    try {
      const f = F('t-mask-off', [
        { op: 'goto', url: DEMO + '/chain/target?orderNo=SO-MASK&token=${tok}' },
        { op: 'assert', kind: 'textPresent', text: '串联数据已接收' },
      ], {
        params: [{ name: 'password', required: true }, { name: 'tok', source: 'secret:int_tok3', secret: true, required: true }],
        assertions: [{ kind: 'textPresent', text: '串联数据已接收' }],
      });
      saveFlow(f);
      created.push(f.id);
      const rep = await run(loadFlow(f.id), { params: { password: 'FAKE-PASS-333' } });
      assert.equal(rep.status, 'pass', rep.error);
      assert.equal(rep.params.password, 'FAKE-PASS-333', 'maskSecrets=false 应放开非凭据参数值便于调试: ' + rep.params.password);
      assert.ok(String(rep.params.tok).indexOf('*') >= 0, 'secret 凭据不许随开关放行: ' + rep.params.tok);
      assert.ok(JSON.stringify(rep).indexOf('TK-FAKE-777') < 0, 'secret 凭据明文必须全文清除');
    } finally {
      writeConfig({ security: { maskSecrets: before } });
      deleteSecret('int_tok3');
    }
  });

  await A('extracted 是数据通道：键名命中 redactKeys 也不脱敏、不清除（链式取值契约）', async () => {
    const f = F('t-data-channel', [
      gt(DEMO + '/chain/source'),
      ext('srcToken', 'token'),
    ], { assertions: [{ kind: 'textPresent', text: '取数页' }] });
    saveFlow(f);
    created.push(f.id);
    const rep = await run(loadFlow(f.id));
    assert.equal(rep.status, 'pass', rep.error);
    assert.equal(rep.extracted.token, 'TK-8891', 'extracted 是数据通道，键名命中 redactKeys 不该被改写: ' + rep.extracted.token);
  });

  await A('extracted 对 secret 值不豁免：密钥出现在产出里也全文清除（红线）', async () => {
    setSecret('int_tok4', 'TK-8891');
    try {
      const f = F('t-secret-scrub-extracted', [
        { op: 'goto', url: DEMO + '/chain/source?tok=${tok}' },
        ext('srcToken', 'token'),
      ], {
        params: [{ name: 'tok', source: 'secret:int_tok4', secret: true, required: true }],
        assertions: [{ kind: 'textPresent', text: '取数页' }],
      });
      saveFlow(f);
      created.push(f.id);
      const rep = await run(loadFlow(f.id), { allowLintErrors: false });
      assert.equal(rep.status, 'pass', rep.error);
      assert.ok(String(rep.params.tok).indexOf('*') >= 0, 'secret 参数没被掩码: ' + rep.params.tok);
      assert.equal(rep.extracted.token, '***', 'secret 值出现在 extracted 里必须清除: ' + rep.extracted.token);
      assert.ok(JSON.stringify(rep).indexOf('TK-8891') < 0, 'secret 凭据明文渗进了报告（含 extracted）');
    } finally {
      deleteSecret('int_tok4');
    }
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

  await A('run.saveEvidence=false 时不产截图（即便 evidenceOn=always）', async () => {
    // 判别式：evidenceOn=always 是"必截"口径，只有 saveEvidence=false 被消费才会一个不产
    const f = F('t-noev-cfg', [gt(DEMO + '/form')], { assertions: [{ kind: 'textPresent', text: '提交工单' }] });
    const before = readConfig().run.saveEvidence;
    writeConfig({ run: { saveEvidence: false } });
    try {
      const rep = await run(f, { evidenceOn: 'always' });
      assert.equal(rep.status, 'pass', rep.error);
      assert.equal((rep.screenshots || []).length, 0, 'saveEvidence=false 不该有截图: ' + JSON.stringify(rep.screenshots));
    } finally {
      writeConfig({ run: { saveEvidence: before } });
    }
    assert.equal(readConfig().run.saveEvidence, true, 'saveEvidence 未恢复默认');
  });

  await A('url 断言支持 regex（匹配通过 / 不匹配判失败）', async () => {
    const f = F('t-url-regex', [gt(DEMO + '/form')], {
      assertions: [{ kind: 'url', regex: '/form$', message: '地址应匹配 /form$' }],
    });
    const rep = await run(f);
    assert.equal(rep.status, 'pass', JSON.stringify(rep.assertions) + ' ' + rep.error);
    const f2 = F('t-url-regex-bad', [gt(DEMO + '/form')], {
      assertions: [{ kind: 'url', regex: '^https?://nomatch-zzz', message: '故意不匹配' }],
    });
    const rep2 = await run(f2);
    assert.equal(rep2.status, 'fail', 'regex 不匹配应判失败: ' + rep2.status);
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

  await A('record_stop.save=false 只返回流程不落盘', async () => {
    const a = await startRecording({ url: DEMO + '/form', name: 'int-nosave' });
    assert.ok(a.ok, JSON.stringify(a));
    const page = activeSession().page;
    await page.waitForSelector('[data-testid="orderNo"]');
    await page.fill('[data-testid="orderNo"]', 'SO-NOSAVE');
    await sleep(900);
    const r = await stopRecording({ name: 'int-nosave', save: false });
    assert.ok(r.ok, JSON.stringify(r));
    assert.equal(r.saved, false, 'save=false 应标记未保存: ' + JSON.stringify(r));
    assert.ok(r.stepCount > 0, '即使不保存也应返回已录步骤: ' + r.stepCount);
    assert.ok(!loadFlow(r.flowId), 'save=false 不该写流程文件');
  });

  await A('record_stop 提交防抖中的填入（停止前 700ms 内的输入不静默丢失）', async () => {
    // 判别式：填完 250ms 就停（< 700ms 防抖），fill 只存在于挂起态；
    // 修前 __rpa.flush 是空引用（调用方静默 no-op），这步填入会被整个丢掉
    const a = await startRecording({ url: DEMO + '/form', name: 'int-flush' });
    assert.ok(a.ok, JSON.stringify(a));
    try {
      const page = activeSession().page;
      await page.waitForSelector('[data-testid="orderNo"]');
      await page.fill('[data-testid="orderNo"]', 'SO-FLUSH');
      await sleep(250);
      const r = await stopRecording({ name: 'int-flush', save: false, inferAssertions: false });
      assert.ok(r.ok, JSON.stringify(r));
      const fills = r.flow.steps.filter((s) => s.op === 'fill');
      assert.ok(fills.some((s) => s.value === 'SO-FLUSH'), '停止前 250ms 的填入被静默丢弃（flush 未生效）: ' + JSON.stringify(r.flow.steps.map((s) => s.op)));
    } catch (e) {
      try { await cancelRecording(); } catch { /* 没有会话时忽略 */ }
      throw e;
    }
  });

  await A('html 上的点击不录成无定位符幽灵步骤（回放点不着、只会卡阻断级）', async () => {
    // 判别式：documentElement.click() 的目标解析到 <html>，一个定位符都生成不出来；
    // 修前会录成「点击 (无定位符)」，回放被 L040 卡死后连坐全部步骤
    const a = await startRecording({ url: DEMO + '/form', name: 'int-ghostclick' });
    assert.ok(a.ok, JSON.stringify(a));
    try {
      const page = activeSession().page;
      await page.waitForSelector('[data-testid="orderNo"]');
      await page.fill('[data-testid="orderNo"]', 'SO-GHOST');
      await sleep(800);
      await page.evaluate(() => { document.documentElement.click(); });
      await sleep(200);
      const r = await stopRecording({ name: 'int-ghostclick', save: false, inferAssertions: false });
      assert.ok(r.ok, JSON.stringify(r));
      const bad = r.flow.steps.filter((s) => s.op !== 'goto' && !(s.locators || []).length);
      assert.equal(bad.length, 0, '录到了无定位符的幽灵步骤: ' + JSON.stringify(bad));
      assert.ok(!r.flow.steps.some((s) => s.op === 'click'), 'html 上的点击不该录成 click 步骤: ' + JSON.stringify(r.flow.steps.map((s) => s.op)));
    } catch (e) {
      try { await cancelRecording(); } catch { /* 没有会话时忽略 */ }
      throw e;
    }
  });

  await A('record_stop.inferAssertions=false 不自动补断言（对照：默认会推断）', async () => {
    // 判别式：报表页 tbody 恒有行（哪怕"暂无数据"占位行），默认推断必产出断言；
    // 若 inferAssertions=false 未被消费，对照形态会被推断进断言，断言数不会是 0
    async function recordToReport(name, inferAssertions) {
      const a = await startRecording({ url: DEMO + '/', name });
      assert.ok(a.ok, JSON.stringify(a));
      try {
        const page = activeSession().page;
        await page.waitForSelector('[data-testid="empNo"]');
        await page.fill('[data-testid="empNo"]', '9527');
        await page.fill('#pwd', 'demo-pass');   // demo 密码框只有 id="pwd"，没有 data-testid
        await page.click('[data-testid="loginBtn"]');
        await page.waitForSelector('table#tbl');
        await sleep(900);
        const r = inferAssertions === undefined
          ? await stopRecording({ name })
          : await stopRecording({ name, inferAssertions });
        assert.ok(r.ok, JSON.stringify(r));
        return r;
      } catch (e) {
        // 录制会话是全局单例：这里失败必须释放，否则后续所有录制用例都被"已有会话"连坐
        try { await cancelRecording(); } catch { /* 没有会话时忽略 */ }
        throw e;
      }
    }
    const on = await recordToReport('int-assert-on');
    created.push(on.flowId);
    console.log('      默认推断断言: ' + JSON.stringify(on.assertions));
    assert.ok(on.assertions.length > 0, '默认应自动推断断言（对照组失效则本用例失去判别力）');
    const off = await recordToReport('int-noassert', false);
    created.push(off.flowId);
    assert.equal(off.assertions.length, 0, 'inferAssertions=false 不该自动补断言: ' + JSON.stringify(off.assertions));
  });

  await A('record_stop.keepBrowserOpen=true 时录制结束后浏览器保留可继续操作', async () => {
    let page;
    try {
      const a = await startRecording({ url: DEMO + '/form', name: 'int-keepopen' });
      assert.ok(a.ok, JSON.stringify(a));
      page = activeSession().page;
      await page.waitForSelector('[data-testid="orderNo"]');
      await page.fill('[data-testid="orderNo"]', 'SO-KEEPOPEN');
      await sleep(900);
      const r = await stopRecording({ name: 'int-keepopen', keepBrowserOpen: true });
      assert.ok(r.ok, JSON.stringify(r));
      created.push(r.flowId);
      assert.ok(!page.isClosed(), 'keepBrowserOpen=true 时录制结束后浏览器不该被关闭');
    } finally {
      await closeAll();   // 收尾：keepBrowserOpen 留下的浏览器必须关掉，别影响后续用例
    }
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

  await A('告警 4xx 如实失败并标 permanent：不重试、不入箱（notify_test 判定面必须报失败）', async () => {
    clearOutbox();
    const server = http.createServer((req, res) => { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end('{"err":true}'); });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    try {
      const url = 'http://127.0.0.1:' + server.address().port + '/hook';
      const cfg = { notify: { enabled: true, type: 'generic', webhook: url, on: ['failure'], timeoutMs: 5000 } };
      const res = await sendNotify({ title: 'T', text: 'x', markdown: 'x', data: {} }, cfg, { force: true, skipFlush: true });
      assert.equal(res.sent, false, '被拒不许谎报送达: ' + JSON.stringify(res));
      assert.equal(res.permanent, true, '4xx 应标 permanent（补发循环据此移出毒条目）: ' + JSON.stringify(res));
      assert.equal(res.queued, false, '4xx 不应入箱: ' + JSON.stringify(res));
      // server.mjs notify_test 的判定三元（res.sent ? ok : fail）在 4xx 下必须走 fail 分支
      const surface = res.sent ? 'ok:✅ 测试告警已发送' : 'fail:发送失败：' + (res.error || '');
      assert.ok(surface.startsWith('fail:'), 'notify_test 必须如实报失败，实际: ' + surface);
    } finally { server.close(); clearOutbox(); }
  });

  await A('发件箱毒条目不死堵箱：补发被永久拒绝的条目移出记 dead-letter，后续积压继续补发', async () => {
    clearOutbox();
    let hits = 0;
    const server = http.createServer((req, res) => {
      hits++;
      const code = hits === 1 ? 400 : 200;   // 首条=毒条目被拒，其余放行
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(code === 200 ? '{"ok":true}' : '{"err":true}');
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    try {
      const url = 'http://127.0.0.1:' + server.address().port + '/hook';
      const old = new Date(Date.now() - 3600 * 1000).toISOString();
      fs.writeFileSync(OUTBOX, JSON.stringify([
        { at: old, msg: { title: '积压-A', text: 'a', markdown: 'a' } },
        { at: old, msg: { title: '积压-B', text: 'b', markdown: 'b' } },
      ], null, 2), 'utf8');
      const cfg = { notify: { enabled: true, type: 'generic', webhook: url, on: ['failure'], timeoutMs: 5000 } };
      const res = await sendNotify({ title: '新告警', text: 'n', markdown: 'n', data: {} }, cfg, { force: true }); // 不带 skipFlush：走补发路径
      assert.ok(res.sent, '新告警应送达: ' + JSON.stringify(res));
      assert.equal(hits, 3, '毒条目被拒后应继续补发 B + 新告警，共 3 次请求，实际 ' + hits);
      assert.equal(outboxCount(), 0, 'B 补发成功、毒条目 A 移出，队列应清空');
      const log = fs.readFileSync(path.join(DIRS.logs, 'alerts.log'), 'utf8');
      assert.ok(log.indexOf('outbox-dead-letter') >= 0 && log.indexOf('积压-A') >= 0, '毒条目应记 dead-letter 留痕');
    } finally { server.close(); clearOutbox(); }
  });

  await A('发件箱滞留被 status_report 点名：>24h 判 error、summary 带积压数与最旧时长', async () => {
    clearOutbox();
    const old = new Date(Date.now() - 26 * 3600 * 1000).toISOString();
    fs.writeFileSync(OUTBOX, JSON.stringify([{ at: old, msg: { title: '滞留告警', text: 'x', markdown: 'x' } }], null, 2), 'utf8');
    const rep = statusReport();
    assert.equal(rep.summary.notifyOutbox, 1, 'summary 应带积压数: ' + JSON.stringify(rep.summary));
    assert.ok(rep.summary.notifyOutboxOldestAgeHours >= 25, 'summary 应带最旧时长: ' + JSON.stringify(rep.summary));
    const p = (rep.problems || []).find((x) => x.flowId === 'notify-outbox');
    assert.ok(p, 'problems 应点名发件箱积压: ' + JSON.stringify(rep.problems));
    assert.equal(p.level, 'error', '滞留 >24h 应判 error: ' + JSON.stringify(p));
    assert.ok(p.message.indexOf('发件箱积压') >= 0, 'message 应可读: ' + p.message);
    // 新鲜积压（<24h）判 warn 不误报 error
    const fresh = new Date().toISOString();
    fs.writeFileSync(OUTBOX, JSON.stringify([{ at: fresh, msg: { title: '刚积压', text: 'x', markdown: 'x' } }], null, 2), 'utf8');
    const rep2 = statusReport();
    const p2 = (rep2.problems || []).find((x) => x.flowId === 'notify-outbox');
    assert.ok(p2 && p2.level === 'warn', '未超 24h 应判 warn: ' + JSON.stringify(p2));
    clearOutbox();
  });

  await A('发件箱文件损坏不灭迹：坏文件备份保留原始内容，后续可重建', async () => {
    clearOutbox();
    const backups = () => fs.readdirSync(DIRS.work).filter((f) => f.startsWith('notify-outbox.json.corrupt'));
    backups().forEach((f) => fs.rmSync(path.join(DIRS.work, f), { force: true }));
    fs.writeFileSync(OUTBOX, '{ 坏数据', 'utf8');
    assert.equal(outboxCount(), 0, '坏文件按空箱处理');
    const bs = backups();
    assert.equal(bs.length, 1, '坏文件应备份保留: ' + JSON.stringify(bs));
    const kept = fs.readFileSync(path.join(DIRS.work, bs[0]), 'utf8');
    assert.equal(kept, '{ 坏数据', '备份应保留原始坏内容作证据');
    clearOutbox();
    bs.forEach((f) => fs.rmSync(path.join(DIRS.work, f), { force: true }));
  });

  await A('发件箱超过上限（20 条）丢最旧留最新', async () => {
    clearOutbox();
    const arr = [];
    for (let i = 0; i < 25; i++) arr.push({ at: new Date(Date.now() - (25 - i) * 1000).toISOString(), msg: { title: '旧积压-' + i, text: 'x', markdown: 'x' } });
    fs.writeFileSync(OUTBOX, JSON.stringify(arr, null, 2), 'utf8');
    // 一次网络级失败入队会触发封顶裁剪（只留最新 20 条）
    const server = http.createServer(() => {});
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const url = 'http://127.0.0.1:' + server.address().port + '/hook';
    await new Promise((r) => server.close(r));
    const cfg = { notify: { enabled: true, type: 'generic', webhook: url, on: ['failure'], timeoutMs: 1000 } };
    await sendNotify({ title: '新积压', text: 'x', markdown: 'x', data: {} }, cfg, { force: true, skipFlush: true });
    assert.equal(outboxCount(), 20, '应封顶 20 条');
    const kept = JSON.parse(fs.readFileSync(OUTBOX, 'utf8'));
    assert.equal(kept[0].msg.title, '旧积压-6', '最旧的应被丢弃: ' + JSON.stringify(kept[0]));
    assert.equal(kept[kept.length - 1].msg.title, '新积压', '最新入队的应保留: ' + JSON.stringify(kept[kept.length - 1]));
    clearOutbox();
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

  await A('并发锁：死进程留下的锁文件会被清理并允许重新加锁（原子创建路径）', async () => {
    const fsx = await import('node:fs');
    const pathx = await import('node:path');
    const { DIRS } = await import('../lib/core.mjs');
    const f = pathx.join(DIRS.work, 'locks', 't-lock-stale.lock');
    fsx.mkdirSync(pathx.dirname(f), { recursive: true });
    // 模拟被强杀进程留下的锁：pid 已不存在 -> 判定为过期，acquireLock 应当能清掉并拿到
    fsx.writeFileSync(f, JSON.stringify({ flowId: 't-lock-stale', pid: 9999999, at: new Date(Date.now() - 3600_000).toISOString(), trigger: 'dead' }), 'utf8');
    const stale = lockInfo('t-lock-stale');
    assert.equal(stale.stale, true, '应当被判定为过期锁: ' + JSON.stringify(stale));
    const got = acquireLock('t-lock-stale', { trigger: 'test' });
    assert.ok(got.ok, '过期锁应当能被重新获得: ' + JSON.stringify(got));
    try {
      const again = acquireLock('t-lock-stale', { trigger: 'test2' });
      assert.equal(again.ok, false, '持锁期间第二次加锁应当失败');
      assert.ok(again.heldBy && again.heldBy.pid === process.pid, '持锁者应当是当前进程');
    } finally { releaseLock('t-lock-stale'); }
    assert.equal(lockInfo('t-lock-stale').held, false, '释放后不应当再有锁');
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

  await A('截图脱敏：security.maskFieldsInScreenshots=false 时密码框页面也不打码（开关真被消费）', async () => {
    // 判别式：/login 有密码框，开关默认 true 时 evidenceMasked 必为 true（上一用例已锁）；
    // 置 false 后必须变成不打码——若开关未被消费，仍会打码，此用例必红
    const f = F('t-mask-cfg', [gt(DEMO + '/login')], { assertions: [{ kind: 'textPresent', text: '登录' }] });
    const before = readConfig().security.maskFieldsInScreenshots;
    writeConfig({ security: { maskFieldsInScreenshots: false } });
    try {
      const rep = await run(f, { evidenceOn: 'always' });
      assert.equal(rep.status, 'pass', rep.error);
      assert.ok(!rep.evidenceMasked, 'maskFieldsInScreenshots=false 时不该打码: ' + rep.evidenceMasked);
    } finally {
      writeConfig({ security: { maskFieldsInScreenshots: before } });
    }
    assert.equal(readConfig().security.maskFieldsInScreenshots, true, 'maskFieldsInScreenshots 未恢复默认');
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
    writeRunningMarker(f.id, '20260101-000000-000', { trigger: 'schedule', pid: 999999999 }); // 死 pid 模拟硬崩后的残留标记
    const runs = listRuns(f.id, 5);
    assert.ok(runs.some((r) => r.status === 'interrupted'), 'listRuns 没暴露中断: ' + JSON.stringify(runs));
    assert.ok(interruptedRun(f.id), 'interruptedRun 没找到');
    const st = statusReport({});
    const item = st.items.find((i) => i.flowId === f.id);
    assert.ok(item, 'statusReport 缺少该流程');
    assert.ok(item.interrupted, 'statusReport 没标出中断');
    assert.ok(st.problems.some((x) => /中断/.test(x.message)), 'problems 没报中断: ' + JSON.stringify(st.problems));
  });

  await A('活 marker 是进行中而非中断（且等待人工可见）', async () => {
    const f = F('t-live-marker', [gt(DEMO + '/form')], { assertions: [{ kind: 'textPresent', text: '提交工单' }] });
    saveFlow(f);
    created.push(f.id);
    writeRunningMarker(f.id, '20260102-000000-000', {
      trigger: 'manual', pid: process.pid,
      waitingHuman: { reason: '验证码', startedAt: new Date().toISOString(), until: '2026-01-02T00:05:00.000Z' },
    });
    const runs = listRuns(f.id, 5);
    const row = runs.find((r) => r.stamp === '20260102-000000-000');
    assert.ok(row && row.status === 'running', '活 marker 应报 running: ' + JSON.stringify(row));
    assert.ok(row.waitingHuman && /验证码/.test(row.waitingHuman.reason), 'run_history 应透出等待人工: ' + JSON.stringify(row));
    assert.ok(!interruptedRun(f.id), '活 marker 不该算中断');
    assert.ok(liveRunInfo(f.id), 'liveRunInfo 应找到进行中的运行');
    const st = statusReport({});
    const item = st.items.find((i) => i.flowId === f.id);
    assert.ok(item && !item.interrupted, '活 marker 不该标 interrupted: ' + JSON.stringify(item));
    assert.ok(item.waitingHuman && /验证码/.test(item.waitingHuman.reason), 'status_report 应透出等待人工: ' + JSON.stringify(item && item.waitingHuman));
    assert.ok(st.problems.some((x) => /等待人工接管/.test(x.message)), 'problems 应提示等待人工: ' + JSON.stringify(st.problems));
    assert.ok(!st.problems.some((x) => x.flowId === f.id && /进程可能被强杀/.test(x.message)), '不该误报中断');
  });

  await A('连续失败只数真失败：进行中的那次不计为失败（不误报连续失败）', async () => {
    const f = F('t-cf-running', [gt(DEMO + '/form')], {});
    saveFlow(f); created.push(f.id);
    saveRun({ flowId: f.id, stamp: '20260101-000000-000', status: 'pass', startedAt: '2026-01-01T00:00:00.000Z', durationMs: 1, trigger: 'manual', healed: [] });
    writeRunningMarker(f.id, '20260102-000000-000', { trigger: 'manual', pid: process.pid }); // 活 pid => running
    const item = statusReport({}).items.find((i) => i.flowId === f.id);
    assert.equal(item.lastStatus, 'running', '最近应是进行中，实为 ' + item.lastStatus);
    // 上一次已完成是 pass，当前这次还在跑（未定论）——连续失败必须是 0，不能把进行中的那次当失败
    assert.equal(item.consecutiveFailures, 0, '进行中的那次不该计为失败，实为 ' + item.consecutiveFailures);
  });

  await A('连续失败只数真失败：中断项另计，不重复计入连续失败', async () => {
    const f = F('t-cf-interrupted', [gt(DEMO + '/form')], {});
    saveFlow(f); created.push(f.id);
    saveRun({ flowId: f.id, stamp: '20260101-000000-000', status: 'fail', startedAt: '2026-01-01T00:00:00.000Z', durationMs: 1, trigger: 'manual', healed: [] });
    saveRun({ flowId: f.id, stamp: '20260102-000000-000', status: 'fail', startedAt: '2026-01-02T00:00:00.000Z', durationMs: 1, trigger: 'manual', healed: [] });
    writeRunningMarker(f.id, '20260103-000000-000', { trigger: 'manual', pid: 999999999 }); // 死 pid => interrupted
    const item = statusReport({}).items.find((i) => i.flowId === f.id);
    // 只有 2 次真失败；interrupted 是崩溃（item.interrupted 已单列）不等于失败，不应再算作一次
    assert.equal(item.consecutiveFailures, 2, '中断项不该计为失败（否则重复计数），实为 ' + item.consecutiveFailures);
  });

  await A('totalRuns 是真实运行总数（不受 100 条摘要窗口封顶）', async () => {
    const f = F('t-totalruns', [gt(DEMO + '/form')], {});
    saveFlow(f); created.push(f.id);
    const N = 108;
    for (let i = 0; i < N; i++) {
      const stamp = '20260101-120000-' + String(i).padStart(3, '0');
      saveRun({ flowId: f.id, stamp, status: 'pass', startedAt: '2026-01-01T00:00:00.000Z', durationMs: 1, trigger: 'manual', healed: [] });
    }
    const item = statusReport({}).items.find((i) => i.flowId === f.id);
    assert.equal(item.totalRuns, N, 'totalRuns 应是真实总数 ' + N + '（旧实现封顶 100），实为 ' + item.totalRuns);
    assert.equal(listRuns(f.id, 100).length, 100, '摘要窗口仍按 limit 截到 100');
    // 错误语义：totalRuns 取自运行目录数（readdir dirs.length），与 index.json 是否损坏无关——
    // 索引坏掉也必须照报真实总数，不能因索引退化而少报或抛错（自愈重建后仍给真值）。
    fs.writeFileSync(path.join(DIRS.runs, f.id, 'index.json'), '{corrupt-json', 'utf8');
    const afterCorrupt = statusReport({}).items.find((i) => i.flowId === f.id);
    assert.equal(afterCorrupt.totalRuns, N, '索引损坏时 totalRuns 仍应是真实总数 ' + N + '（取自目录数），实为 ' + afterCorrupt.totalRuns);
    // 幂等：只读统计，重复调用给同样的真值
    const again = statusReport({}).items.find((i) => i.flowId === f.id);
    assert.equal(again.totalRuns, N, '幂等：重复调用 totalRuns 不变，实为 ' + again.totalRuns);
    assert.equal(again.consecutiveFailures, 0, '幂等且只读：' + N + ' 次 pass 不该有连续失败，实为 ' + again.consecutiveFailures);
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
    // 与 cwd 无关：曾用 process.cwd()，从项目根跑自检会误报"找不到 runner.mjs"（ESM 里没有 __dirname，用 import.meta.dirname）
    const runnerPath = path.join(import.meta.dirname, '..', 'runner.mjs');
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

  await A('浏览器配置：locale 与 timezoneId 真正生效', async () => {
    writeConfig({ browser: { locale: 'en-US', timezoneId: 'America/New_York' } });
    try {
      const f = F('t-cfg-ltz', [
        gt(DEMO + '/echo'),
        ext('lang', 'lang'),
        ext('tz', 'tz'),
      ], {
        assertions: [
          { kind: 'extracted', as: 'lang', matches: '^lang: en-US$', message: 'locale 未生效' },
          { kind: 'extracted', as: 'tz', matches: '^tz: America/New_York$', message: 'timezoneId 未生效' },
        ],
      });
      const rep = await run(f);
      console.log('      lang=' + rep.extracted.lang + '  tz=' + rep.extracted.tz);
      assert.equal(rep.status, 'pass', JSON.stringify(rep.assertions) + ' ' + rep.error);
    } finally { writeConfig({ browser: { locale: 'zh-CN', timezoneId: 'Asia/Shanghai' } }); }
    assert.equal(readConfig().browser.locale, 'zh-CN', 'locale 未恢复默认');
    assert.equal(readConfig().browser.timezoneId, 'Asia/Shanghai', 'timezoneId 未恢复默认');
  });

  await A('浏览器配置：recordViewport 决定录制窗口大小', async () => {
    writeConfig({ browser: { recordViewport: { width: 1024, height: 768 } } });
    try {
      const a = await startRecording({ url: DEMO + '/form', name: 'int-recvp' });
      assert.ok(a.ok, JSON.stringify(a));
      const vp = activeSession().page.viewportSize();
      assert.equal(vp.width, 1024, 'recordViewport 未生效: ' + JSON.stringify(vp));
      assert.equal(vp.height, 768, 'recordViewport 未生效: ' + JSON.stringify(vp));
    } finally {
      try { await cancelRecording(); } catch { /* 没有会话时忽略 */ }
      writeConfig({ browser: { recordViewport: { width: 1440, height: 900 } } });
    }
    assert.equal(readConfig().browser.recordViewport.width, 1440, 'recordViewport 未恢复默认');
    assert.equal(readConfig().browser.recordViewport.height, 900, 'recordViewport 未恢复默认');
  });

  await A('浏览器配置：profileDir 指定的持久化目录真正被使用', async () => {
    const custom = path.join(TMP, 'custom-profile');
    writeConfig({ browser: { persistProfile: true, profileDir: custom } });
    try {
      const f = F('t-cfg-profile', [gt(DEMO + '/form')], { assertions: [{ kind: 'textPresent', text: '提交工单' }] });
      const rep = await run(f);
      assert.equal(rep.status, 'pass', rep.error);
      assert.ok(fs.existsSync(custom), '自定义 profileDir 未被创建/使用');
    } finally {
      writeConfig({ browser: { persistProfile: false, profileDir: null } });
    }
    assert.equal(readConfig().browser.profileDir, null, 'profileDir 未恢复默认');
    assert.equal(readConfig().browser.persistProfile, false, 'persistProfile 未恢复默认');
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

  await A('flow_restore.which 指定备份：按时间戳或完整路径回指定版本（不是只能回最近一次）', async () => {
    const id = 't-restore-which';
    // 备份不随 deleteFlow 清理，上次异常中断的运行可能留下残件——先清干净，本用例只数自己造的两份
    for (const b of listBackups(id)) { try { fs.rmSync(b.file, { force: true }); } catch { /* ignore */ } }
    const f = F(id, [gt(DEMO + '/form')], { assertions: [{ kind: 'textPresent', text: '提交工单' }] });
    f.name = 'v0-name';
    saveFlow(f); created.push(f.id);
    await sleep(25);                       // 备份文件名带毫秒时间戳，错开避免同名覆盖
    backupFlow(f.id);                      // 备份 1 = v0-name
    const v2 = loadFlow(f.id); v2.name = 'v2-name'; saveFlow(v2);
    await sleep(25);
    backupFlow(f.id);                      // 备份 2 = v2-name
    const v3 = loadFlow(f.id); v3.name = 'v3-name'; saveFlow(v3);
    const list = listBackups(f.id);
    assert.equal(list.length, 2, '应有 2 份备份: ' + JSON.stringify(list));

    const which = list[1].at;              // which=时间戳 → 较旧那份（v0-name）
    const resOld = restoreFlow(f.id, which);
    assert.ok(resOld.ok, JSON.stringify(resOld));
    assert.equal(loadFlow(f.id).name, 'v0-name', 'which=时间戳应回到对应备份，实际 ' + loadFlow(f.id).name);

    const resNew = restoreFlow(f.id, list[0].file);   // which=完整路径 → 较新那份（v2-name）
    assert.ok(resNew.ok, JSON.stringify(resNew));
    assert.equal(loadFlow(f.id).name, 'v2-name', 'which=完整路径应回到对应备份，实际 ' + loadFlow(f.id).name);

    const resBad = restoreFlow(f.id, 'no-such-backup');
    assert.equal(resBad.ok, false, '不存在的 which 应报错而不是回退到最近一次');
    assert.ok(/找不到该备份/.test(resBad.error || ''), '错误信息应点名找不到该备份: ' + resBad.error);
  });

  /* ================= G18 运行总超时 / 录像证据 / 告警重试 / 定时预期 / 历史早停 ================= */
  G('18', '运行总超时看门狗 / 录像证据 / 告警重试 / 定时预期 / 历史早停');

  await A('运行总超时：超过 maxDurationMs 优雅收尾（判失败+写报告+释放锁）', async () => {
    const f = F('t-timeout', [gt(DEMO + '/form'), { op: 'sleep', ms: 30000 }, { op: 'screenshot', name: 'x' }]);
    const t0 = Date.now();
    const rep = await run(f, { maxDurationMs: 1500 });
    const took = Date.now() - t0;
    assert.equal(rep.status, 'fail', '总超时应判失败: ' + rep.status);
    assert.ok(rep.timedOut, '缺少 timedOut 标记');
    assert.ok(String(rep.error).indexOf('总超时') >= 0, '错误信息应说明总超时: ' + rep.error);
    assert.ok(rep.reportPath && fs.existsSync(rep.reportPath), '超时未写出报告（没收尾）');
    assert.ok(took < 30000, '30s 的 sleep 没被看门狗拦住，实测 ' + took + 'ms');
    assert.equal(lockInfo('t-timeout').held, false, '超时后流程锁未释放');
    created.push('t-timeout');
  });

  await A('总超时收尾：最后一步越过预算不得报成功（scrollTo 内层等待受总时限约束）', async () => {
    // 修前：scrollTo 的滚动间隔完全不受总时限约束，5 次 x1s 的等待把运行推过预算后，
    // 若它是最后一步，整场以 pass 收尾——超时判定必须确定性，成功路径也要收尾判定
    const f = F('t-timeout-scroll', [gt(DEMO + '/form'), { op: 'scrollTo', to: 'bottom', times: 5, waitMs: 1000 }], { emptyResultOk: true });
    const t0 = Date.now();
    const rep = await run(f, { maxDurationMs: 4000 });
    const took = Date.now() - t0;
    assert.equal(rep.status, 'fail', '越过总时限的运行不得报成功（当前: ' + rep.status + '）');
    assert.ok(rep.timedOut, '缺少 timedOut 标记');
    assert.ok(/总超时/.test(String(rep.error)), '错误应说明总超时: ' + rep.error);
    assert.ok(took < 15000, '5s 的滚动等待没被预算拦住，实测 ' + took + 'ms');
    created.push('t-timeout-scroll');
  });

  await A('总超时收尾：人工接管固定放行也不得越过预算报成功', async () => {
    // 修前：无恢复条件的 humanHandoff 固定睡满 3s（不裁剪）再返回成功，越过总时限后
    // 仍报成功 = 误报；固定放行的等待必须与 sleep 步骤同口径受总时限约束。
    // 预算 2500ms < 固定放行 3s：无论启动快慢，放行等待注定越过预算，裁剪/收尾判定必触发。
    const f = F('t-timeout-handoff', [gt(DEMO + '/handoff'), { op: 'humanHandoff', reason: '等待人工', timeoutMs: 30000 }], { emptyResultOk: true });
    const t0 = Date.now();
    const rep = await run(f, { maxDurationMs: 2500, headed: true });
    const took = Date.now() - t0;
    assert.equal(rep.status, 'fail', '越过总时限的运行不得报成功（当前: ' + rep.status + '）');
    assert.ok(rep.timedOut, '缺少 timedOut 标记');
    assert.ok(/总超时/.test(String(rep.error)), '错误应说明总超时: ' + rep.error);
    assert.ok(took < 15000, '固定放行等待没被预算拦住，实测 ' + took + 'ms');
    created.push('t-timeout-handoff');
  });

  await A('录像证据：失败运行保留 webm（环境缺录像能力时诚实降级并注明）', async () => {
    const f = F('t-video', [gt(DEMO + '/form'), { op: 'screenshot', name: 'x' }],
      { assertions: [{ kind: 'textPresent', text: '__绝不存在的文字__', message: '故意失败以留录像' }] });
    const rep = await run(f, { saveVideo: true });
    assert.equal(rep.status, 'fail', '该用例应失败: ' + rep.error);
    if (rep.videoNote) {
      assert.ok(String(rep.videoNote).indexOf('录像') >= 0, rep.videoNote);
      assert.equal(rep.videos.length, 0, '降级时不该有录像: ' + JSON.stringify(rep.videos));
      console.log('      （诚实降级）' + rep.videoNote);
    } else {
      assert.ok(rep.videos.length >= 1, '失败运行应保留录像: ' + JSON.stringify(rep.videos));
      for (const v of rep.videos) assert.ok(fs.existsSync(v) && fs.statSync(v).size > 0, '录像文件缺失或为空: ' + v);
    }
    created.push('t-video');
  });

  await A('录像证据：成功运行按 videoOn=failure 删除录像省空间', async () => {
    const f = F('t-video-ok', [gt(DEMO + '/form')], { assertions: [{ kind: 'textPresent', text: '提交工单' }] });
    const rep = await run(f, { saveVideo: true });
    assert.equal(rep.status, 'pass', rep.error);
    if (!rep.videoNote) {
      assert.equal(rep.videos.length, 0, '成功的录像应被删除: ' + JSON.stringify(rep.videos));
      const vdir = path.join(DIRS.runs, 't-video-ok', rep.stamp, 'videos');
      const left = fs.existsSync(vdir) ? fs.readdirSync(vdir).filter((x) => /\.webm$/i.test(x)) : [];
      assert.equal(left.length, 0, '录像文件未真正删除: ' + left.join(','));
    }
    created.push('t-video-ok');
  });

  await A('告警重试：服务端前两次 5xx，第三次送达（attempts=3）', async () => {
    clearOutbox(); // 防上次残留积压被补发，打乱 hits 计数
    let hits = 0;
    const server = http.createServer((req, res) => {
      hits++;
      const code = hits <= 2 ? 500 : 200;
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(code === 200 ? '{"ok":true}' : '{"err":true}');
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    try {
      const url = 'http://127.0.0.1:' + server.address().port + '/hook';
      const cfg = { notify: { enabled: true, type: 'generic', webhook: url, on: ['failure'], timeoutMs: 5000 } };
      const res = await sendNotify({ title: 'T', text: 'x', markdown: 'x', data: {} }, cfg, { force: true });
      assert.ok(res.sent, '重试后应送达: ' + JSON.stringify(res));
      assert.equal(res.attempts, 3, '应重试到第 3 次: ' + JSON.stringify(res));
      assert.equal(hits, 3, '服务端应被请求 3 次，实际 ' + hits);
    } finally { server.close(); }
  });

  await A('告警重试：4xx 是请求本身不对，不重试也不谎报送达', async () => {
    let hits = 0;
    const server = http.createServer((req, res) => {
      hits++;
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end('{"err":true}');
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    try {
      const url = 'http://127.0.0.1:' + server.address().port + '/hook';
      const cfg = { notify: { enabled: true, type: 'generic', webhook: url, on: ['failure'], timeoutMs: 5000 } };
      const res = await sendNotify({ title: 'T', text: 'x', markdown: 'x', data: {} }, cfg, { force: true, skipFlush: true });
      assert.equal(res.sent, false, '被拒=没送出去，不许谎报送达: ' + JSON.stringify(res));
      assert.equal(res.attempts, 1, '4xx 不应重试: ' + JSON.stringify(res));
      assert.equal(hits, 1, '只应请求 1 次，实际 ' + hits);
      assert.equal(res.queued, false, '4xx 永远发不进，不应入箱: ' + JSON.stringify(res));
      assert.ok(/HTTP 400/.test(String(res.error)), '错误应点名 HTTP 400: ' + JSON.stringify(res));
    } finally { server.close(); }
  });

  await A('告警重试：网络级失败也会重试满 3 次后如实报失败', async () => {
    clearOutbox();
    // 先开再关，拿一个"确定没人监听"的端口
    const server = http.createServer(() => {});
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const url = 'http://127.0.0.1:' + server.address().port + '/hook';
    await new Promise((r) => server.close(r));
    const cfg = { notify: { enabled: true, type: 'generic', webhook: url, on: ['failure'], timeoutMs: 2000 } };
    const res = await sendNotify({ title: 'T', text: 'x', markdown: 'x', data: {} }, cfg, { force: true });
    assert.equal(res.sent, false, JSON.stringify(res));
    assert.equal(res.attempts, 3, '网络失败应重试满 3 次: ' + JSON.stringify(res));
    assert.ok(res.error, '应带失败原因');
    assert.equal(res.queued, true, '网络级失败应入发件箱待补发: ' + JSON.stringify(res));
    clearOutbox();
  });

  await A('status_report 定时预期按频率算：daily 三天没跑要点名，once 不误报', async () => {
    const f = F('t-sched-expect', [gt(DEMO + '/form')]);
    saveFlow(f);
    created.push('t-sched-expect');
    const stamp = '20251001-120000-000';
    const d = path.join(DIRS.runs, 't-sched-expect', stamp);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'report.json'), JSON.stringify({
      flowId: 't-sched-expect', stamp, status: 'pass',
      startedAt: new Date(Date.now() - 3 * 24 * 3600 * 1000).toISOString(), durationMs: 1000, healed: [],
    }));
    const idxPath = path.join(DIRS.work, 'sched', 'index.json');
    const hadIdx = fs.existsSync(idxPath);
    const idxBackup = hadIdx ? fs.readFileSync(idxPath, 'utf8') : null;
    try {
      const idx = hadIdx ? JSON.parse(idxBackup) : {};
      idx['t-sched-expect'] = { spec: { frequency: 'daily', at: '09:00' } };
      fs.mkdirSync(path.dirname(idxPath), { recursive: true });
      fs.writeFileSync(idxPath, JSON.stringify(idx));
      const rep1 = statusReport();
      assert.ok(rep1.problems.some((p) => p.flowId === 't-sched-expect' && /没有新执行记录/.test(p.message)),
        'daily 三天没跑应点名: ' + JSON.stringify(rep1.problems));
      idx['t-sched-expect'] = { spec: { frequency: 'once', date: '2025/12/31', at: '10:00' } };
      fs.writeFileSync(idxPath, JSON.stringify(idx));
      const rep2 = statusReport();
      assert.ok(!rep2.problems.some((p) => p.flowId === 't-sched-expect' && /没有新执行记录/.test(p.message)),
        'once 任务不该按固定间隔点名: ' + JSON.stringify(rep2.problems));
    } finally {
      if (idxBackup !== null) fs.writeFileSync(idxPath, idxBackup);
      else { try { fs.unlinkSync(idxPath); } catch { /* ignore */ } }
    }
  });

  await A('listRuns 早停：只取最新 N 条（新→旧，中断记录排最前）', async () => {
    const id = 't-listruns';
    const base = path.join(DIRS.runs, id);
    fs.mkdirSync(base, { recursive: true });
    for (let i = 0; i < 30; i++) {
      const stamp = '20251001-120000-' + String(i).padStart(3, '0');
      const d2 = path.join(base, stamp);
      fs.mkdirSync(d2, { recursive: true });
      fs.writeFileSync(path.join(d2, 'report.json'), JSON.stringify({
        flowId: id, stamp, status: 'pass', startedAt: '2025-10-01T12:00:00.000Z', durationMs: 1, healed: [],
      }));
    }
    const dInt = path.join(base, '20251001-130000-000');
    fs.mkdirSync(dInt, { recursive: true });
    fs.writeFileSync(path.join(dInt, 'running.json'), JSON.stringify({ startedAt: '2025-10-01T13:00:00.000Z', trigger: 'manual' }));
    const runs = listRuns(id, 5);
    assert.equal(runs.length, 5, '早停应只返回 5 条: ' + runs.length);
    assert.deepEqual(runs.map((r) => r.stamp), [
      '20251001-130000-000', '20251001-120000-029', '20251001-120000-028', '20251001-120000-027', '20251001-120000-026',
    ]);
    assert.equal(runs[0].status, 'interrupted', '有标记无报告 = 中断，必须可见');
  });

  await A('运行索引：saveRun 同步落 index.json，listRuns 摘要口径与报告逐字段一致', async () => {
    const id = 't-runidx-save';
    created.push(id);
    fs.rmSync(path.join(DIRS.runs, id), { recursive: true, force: true }); // 用例自密封：上一轮残件会让计数翻倍
    for (let i = 0; i < 3; i++) {
      saveRun({
        flowId: id, stamp: '20251002-120000-00' + i, status: i === 1 ? 'fail' : 'pass',
        startedAt: '2025-10-02T12:00:0' + i + '.000Z', durationMs: 100 + i, trigger: 'cli',
        healed: i === 2 ? [{}, {}] : [], failedStep: i === 1 ? 2 : null, error: i === 1 ? 'boom' : null,
      });
    }
    const idx = JSON.parse(fs.readFileSync(path.join(DIRS.runs, id, 'index.json'), 'utf8'));
    assert.equal(idx.version, 1, '索引应带版本号');
    assert.equal(idx.runs.length, 3, '3 次运行应有 3 条摘要: ' + idx.runs.length);
    const runs = listRuns(id, 10);
    assert.deepEqual(runs.map((r) => r.stamp), ['20251002-120000-002', '20251002-120000-001', '20251002-120000-000']);
    assert.deepEqual(runs[1], {
      stamp: '20251002-120000-001', status: 'fail', startedAt: '2025-10-02T12:00:01.000Z',
      durationMs: 101, trigger: 'cli', healedCount: 0, failedStep: 2, error: 'boom',
    }, '摘要字段/缺省值口径必须与直读 report.json 一致');
    assert.equal(runs[0].healedCount, 2, 'healedCount 应取报告 healed[] 长度');
  });

  await A('运行索引自愈：外部直写报告、删除目录、索引损坏都被集合差抓到并重建', async () => {
    const id = 't-runidx-heal';
    created.push(id);
    fs.rmSync(path.join(DIRS.runs, id), { recursive: true, force: true }); // 用例自密封：上一轮残件会让计数翻倍
    const base = path.join(DIRS.runs, id);
    fs.mkdirSync(base, { recursive: true });
    const plant = (stamp) => {
      const d = path.join(base, stamp);
      fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(path.join(d, 'report.json'), JSON.stringify({ flowId: id, stamp, status: 'pass', startedAt: '2025-10-02T12:00:00.000Z', durationMs: 1, healed: [] }));
    };
    plant('20251002-120000-001');
    plant('20251002-120000-002');
    assert.equal(listRuns(id, 10).length, 2, '外部直写的运行（不经 saveRun）必须被看到');
    plant('20251002-120000-003');
    assert.equal(listRuns(id, 10).length, 3, '索引已存在时再直写也必须可见（增量集合差触发）');
    fs.rmSync(path.join(base, '20251002-120000-001'), { recursive: true, force: true });
    assert.deepEqual(listRuns(id, 10).map((r) => r.stamp), ['20251002-120000-003', '20251002-120000-002'], '目录被外部删除后不得报幽灵条目');
    fs.writeFileSync(path.join(base, 'index.json'), '{ 坏数据');
    assert.deepEqual(listRuns(id, 10).map((r) => r.stamp), ['20251002-120000-003', '20251002-120000-002'], '索引损坏必须自愈重建，结果不变');
  });

  await A('运行索引：pruneRuns 裁剪同步清索引条目，不留幽灵', async () => {
    const id = 't-runidx-prune';
    created.push(id);
    fs.rmSync(path.join(DIRS.runs, id), { recursive: true, force: true }); // 用例自密封：上一轮残件会让计数翻倍
    for (let i = 0; i < 5; i++) {
      saveRun({ flowId: id, stamp: '20251002-120000-00' + i, status: 'pass', startedAt: '2025-10-02T12:00:0' + i + '.000Z', durationMs: 1, trigger: 'manual', healed: [] });
    }
    const r = pruneRuns(id, { keepCount: 2, keepDays: 0 }); // 两个边界都钉死：天龄走配置会让"既设次数又设天龄"变成 beyondCount && tooOld
    assert.equal(r.removed.length, 3, '应删 3 条: ' + JSON.stringify(r.removed));
    const idx = JSON.parse(fs.readFileSync(path.join(DIRS.runs, id, 'index.json'), 'utf8'));
    assert.equal(idx.runs.length, 2, '索引应同步裁到 2 条: ' + idx.runs.length);
    assert.deepEqual(listRuns(id, 10).map((x) => x.stamp), ['20251002-120000-004', '20251002-120000-003']);
  });

  await A('运行索引：进行中断记录与索引摘要按 stamp 交错排序不变', async () => {
    const id = 't-runidx-order';
    created.push(id);
    fs.rmSync(path.join(DIRS.runs, id), { recursive: true, force: true }); // 用例自密封：上一轮残件会让计数翻倍
    const base = path.join(DIRS.runs, id);
    fs.mkdirSync(base, { recursive: true });
    saveRun({ flowId: id, stamp: '20251002-120000-001', status: 'pass', startedAt: '2025-10-02T12:00:00.000Z', durationMs: 1, trigger: 'manual', healed: [] });
    saveRun({ flowId: id, stamp: '20251002-120000-003', status: 'pass', startedAt: '2025-10-02T12:00:02.000Z', durationMs: 1, trigger: 'manual', healed: [] });
    const dInt = path.join(base, '20251002-120000-002'); // 中间夹一个有标记无报告的
    fs.mkdirSync(dInt, { recursive: true });
    fs.writeFileSync(path.join(dInt, 'running.json'), JSON.stringify({ startedAt: '2025-10-02T12:00:01.000Z', trigger: 'schedule' }));
    const runs = listRuns(id, 10);
    assert.deepEqual(runs.map((x) => [x.stamp, x.status]), [
      ['20251002-120000-003', 'pass'], ['20251002-120000-002', 'interrupted'], ['20251002-120000-001', 'pass'],
    ], '中断记录必须按 stamp 交错在索引摘要之间: ' + JSON.stringify(runs.map((x) => x.stamp)));
  });

  await A('录像证据：含敏感输入的流程自动跳过录像（防录像泄露密码画面）', async () => {
    const f = F('t-video-secret', [
      gt(DEMO + '/form'),
      { op: 'fill', locators: L('reportDate'), value: '2026-10-04', sensitive: true },
      { op: 'screenshot', name: 'x' },
    ]);
    const rep = await run(f, { saveVideo: true });
    assert.ok(rep.videoNote && String(rep.videoNote).indexOf('敏感') >= 0, '应注明因敏感输入跳过录像: ' + rep.videoNote);
    assert.equal(rep.videos.length, 0, '敏感流程不应产出录像: ' + JSON.stringify(rep.videos));
    created.push('t-video-secret');
  });

  await A('持久化启动失败不污染 broken 缓存（不连累普通回放）', async () => {
    const { launchContext, brokenBrowsers } = await import('../lib/browser.mjs');
    const before = brokenBrowsers().map((b) => b.key).sort();
    writeConfig({ browser: { mode: 'custom', executablePath: path.join(TMP, 'no-such-browser.exe') } });
    try {
      let err = null;
      try { await launchContext({ persistent: true, headed: false }); } catch (e) { err = e; }
      assert.ok(err, '坏 exe 路径的持久化启动应当失败');
      assert.ok(/启动失败|持久化/.test(String(err.message)), err.message);
      const after = brokenBrowsers().map((b) => b.key).sort();
      assert.deepEqual(after, before, '持久化启动失败不应写入 broken 缓存');
    } finally {
      writeConfig({ browser: { mode: 'auto', channel: null, executablePath: null } });
    }
    assert.equal(readConfig().browser.mode, 'auto', '浏览器配置未恢复默认');
  });

  await A('chain 超时继承：子流程只拿到父流程剩余时长，跑飞被父预算拦住', async () => {
    // 子流程故意不带结果校验（lint 脏）：父流程 allowLintErrors 的口径应级联到子流程，
    // 这个用例同时守住「超时继承」与「lint 口径级联」两件事
    const child = F('t-chain-child', [gt(DEMO + '/form'), { op: 'sleep', ms: 30000 }, { op: 'screenshot', name: 'x' }]);
    saveFlow(child);
    created.push('t-chain-child');
    const parent = F('t-chain-parent', [gt(DEMO + '/form'), { op: 'chain', flow: 't-chain-child' }],
      { assertions: [{ kind: 'textPresent', text: '提交工单' }] });
    created.push('t-chain-parent');
    const t0 = Date.now();
    const rep = await run(parent, { maxDurationMs: 8000 });
    const took = Date.now() - t0;
    assert.equal(rep.status, 'fail', '子流程跑飞应判失败: ' + rep.error);
    assert.ok(/总超时/.test(String(rep.error)), '错误应说明总超时: ' + rep.error);
    assert.ok(took < 20000, '30s 的子流程 sleep 没被父预算拦住，实测 ' + took + 'ms');
    const childRep = loadRun('t-chain-child', 'latest');
    assert.ok(childRep && childRep.maxDurationMs, '子流程报告应记录继承到的总超时');
    assert.ok(childRep.maxDurationMs <= 8000, '子流程预算应 ≤ 父流程总时限: ' + childRep.maxDurationMs);
  });

  await A('chain 预算：maxDurationMs 用尽后剩余流程标记未执行', async () => {
    const a = F('t-chain-skip-a', [gt(DEMO + '/form'), { op: 'sleep', ms: 5000 }]);
    const b = F('t-chain-skip-b', [gt(DEMO + '/form')]);
    saveFlow(a); saveFlow(b);
    created.push('t-chain-skip-a', 't-chain-skip-b');
    const t0 = Date.now();
    const r = await runChain([{ flow: 't-chain-skip-a', continueOnError: true }, { flow: 't-chain-skip-b' }], {
      maxDurationMs: 200, headed: false, trigger: 'integration', allowLintErrors: true, notify: false,
    });
    const took = Date.now() - t0;
    assert.equal(r.status, 'fail', r.error);
    assert.ok(/串联超过总时限/.test(String(r.error)), '应说明串联超过总时限: ' + r.error);
    assert.equal(r.results.length, 2, JSON.stringify(r.results));
    assert.equal(r.results[1].status, 'skipped', '预算用尽后第二个流程应标记 skipped: ' + JSON.stringify(r.results[1]));
    assert.ok(took < 20000, '实测 ' + took + 'ms');
  });

  await A('无人值守默认上限：trigger=schedule 未配总超时时自动封顶', async () => {
    const before = readConfig().run.unattendedMaxDurationMs;
    const f = F('t-unattended', [gt(DEMO + '/form'), { op: 'sleep', ms: 30000 }, { op: 'screenshot', name: 'x' }]);
    saveFlow(f);
    created.push('t-unattended');
    writeConfig({ run: { unattendedMaxDurationMs: 4000 } });
    try {
      const t0 = Date.now();
      const rep = await run(f, { trigger: 'schedule' });
      const took = Date.now() - t0;
      assert.equal(rep.status, 'fail', rep.error);
      assert.ok(rep.timedOut, '应被无人值守上限拦下');
      assert.ok(/总超时/.test(String(rep.error)), rep.error);
      assert.equal(rep.budgetSource, 'unattendedMaxDurationMs', '应标注预算来源: ' + rep.budgetSource);
      assert.equal(rep.maxDurationMs, 4000, '应使用 unattendedMaxDurationMs: ' + rep.maxDurationMs);
      assert.ok(took < 20000, '30s sleep 没被 4s 上限拦住，实测 ' + took + 'ms');
    } finally {
      writeConfig({ run: { unattendedMaxDurationMs: before } });
    }
    assert.equal(readConfig().run.unattendedMaxDurationMs, before, '配置未恢复');
  });

  await A('告警 outbox：彻底失败入队，网络恢复后下次发送自动补发', async () => {
    clearOutbox();
    // 先开再关，拿一个"确定没人监听"的端口
    const dead = http.createServer(() => {});
    await new Promise((r) => dead.listen(0, '127.0.0.1', r));
    const deadUrl = 'http://127.0.0.1:' + dead.address().port + '/hook';
    await new Promise((r) => dead.close(r));
    const cfgFail = { notify: { enabled: true, type: 'generic', webhook: deadUrl, on: ['failure'], timeoutMs: 1500 } };
    const r1 = await sendNotify({ title: '积压-1', text: 'x', markdown: 'x' }, cfgFail, { force: true });
    assert.equal(r1.sent, false, JSON.stringify(r1));
    assert.equal(r1.queued, true, '网络级失败应入发件箱: ' + JSON.stringify(r1));
    assert.ok(fs.existsSync(OUTBOX), '发件箱文件应存在');
    assert.equal(JSON.parse(fs.readFileSync(OUTBOX, 'utf8')).length, 1, '应积压 1 条');

    const alarm2 = await startAlarmReceiver();
    try {
      const cfgOk = { notify: { enabled: true, type: 'generic', webhook: alarm2.url, on: ['failure'], timeoutMs: 5000 } };
      const r2 = await sendNotify({ title: '新告警', text: 'y', markdown: 'y' }, cfgOk, { force: true });
      assert.ok(r2.sent, JSON.stringify(r2));
      assert.equal(r2.flushed, 1, '应补发 1 条积压: ' + JSON.stringify(r2));
      assert.equal(alarm2.got.length, 2, '服务端应收到 2 条（1 补发 + 1 新）: ' + alarm2.got.length);
      assert.equal(alarm2.got[0].title, '积压-1', '先补发积压（保持时序）: ' + JSON.stringify(alarm2.got.map((g) => g.title)));
      assert.equal(alarm2.got[1].title, '新告警', '新告警在后');
      assert.equal(JSON.parse(fs.readFileSync(OUTBOX, 'utf8')).length, 0, '发件箱应清空');
    } finally {
      alarm2.server.close();
      clearOutbox();
    }
  });

  await A('doctor 录像能力：探测 Playwright 自带 ffmpeg（诚实报有/无）', async () => {
    const { detectFfmpeg } = await import('../lib/browser.mjs');
    const r = detectFfmpeg();
    assert.equal(typeof r.ffmpeg, 'boolean', JSON.stringify(r));
    if (r.ffmpeg) assert.ok(r.path && fs.existsSync(r.path), 'ffmpeg 路径应真实存在: ' + r.path);
    else assert.equal(r.path, null, '没有 ffmpeg 时不该编路径: ' + JSON.stringify(r));
  });

  await A('录像磁盘治理：pruneRuns 按 keepVideos 只留最近 N 段，报告截图不动', async () => {
    const id = 't-video-prune';
    const base = path.join(DIRS.runs, id);
    fs.mkdirSync(base, { recursive: true });
    const stamps = [];
    for (let i = 0; i < 5; i++) {
      const stamp = '20251001-12000' + i + '-000';
      stamps.push(stamp);
      const d = path.join(base, stamp);
      fs.mkdirSync(path.join(d, 'videos'), { recursive: true });
      fs.writeFileSync(path.join(d, 'report.json'), JSON.stringify({ flowId: id, stamp, status: 'pass', startedAt: '2025-10-01T12:00:00.000Z', durationMs: 1, healed: [] }));
      fs.writeFileSync(path.join(d, 'shot.png'), 'png');
      const v = path.join(d, 'videos', 'video.webm');
      fs.writeFileSync(v, 'webm-' + i);
      const t = new Date(Date.now() - (5 - i) * 60000); // i=0 最旧 … i=4 最新
      fs.utimesSync(v, t, t);
    }
    const countWebm = () => stamps.reduce((s, st) => s + (fs.existsSync(path.join(base, st, 'videos', 'video.webm')) ? 1 : 0), 0);
    const dry = pruneRuns(id, { keepVideos: 2, keepCount: 0, keepDays: 0, dryRun: true });
    assert.equal(dry.videosRemoved, 3, JSON.stringify(dry));
    assert.equal(dry.videosKept, 2, JSON.stringify(dry));
    assert.equal(countWebm(), 5, 'dryRun 不应真删');
    const real = pruneRuns(id, { keepVideos: 2, keepCount: 0, keepDays: 0 });
    assert.equal(real.videosRemoved, 3, JSON.stringify(real));
    assert.equal(real.videosKept, 2, JSON.stringify(real));
    assert.equal(countWebm(), 2, '应只剩 2 段录像');
    assert.ok(fs.existsSync(path.join(base, stamps[3], 'videos', 'video.webm')), '应留下第 4 新的');
    assert.ok(fs.existsSync(path.join(base, stamps[4], 'videos', 'video.webm')), '应留下最新的');
    assert.equal(fs.readdirSync(base).length, 5, 'keepCount/keepDays=0 时运行记录本身不该被删');
    for (const st of stamps) assert.ok(fs.existsSync(path.join(base, st, 'shot.png')), '截图不该被误删: ' + st);
  });

  await A('run.navTimeoutMs：导航超时按配置判失败（本地哑端口，确定性复现）', async () => {
    // 收到请求永不响应的本地端口：goto 必然走到超时，不受外网/防火墙状态影响
    const silent = http.createServer(() => { /* 收到请求永不响应 */ });
    await new Promise((r) => silent.listen(0, '127.0.0.1', r));
    const url = 'http://127.0.0.1:' + silent.address().port + '/';
    const before = readConfig().run.navTimeoutMs;
    writeConfig({ run: { navTimeoutMs: 1500 } });
    try {
      const f = F('t-navtimeout', [{ op: 'goto', url }], { assertions: [{ kind: 'url', contains: '127.0.0.1', message: '不该到达任何页面' }] });
      const t0 = Date.now();
      const rep = await run(f);
      const took = Date.now() - t0;
      console.log('      状态=' + rep.status + ' 耗时=' + took + 'ms 错误=' + (rep.error || '无'));
      assert.equal(rep.status, 'fail', '导航超时应判失败: ' + rep.status + ' ' + rep.error);
      // 两次尝试都撞在死端口上：首错是 Timeout 1500ms，重试的第二错可能是 net::ERR_ABORTED
      // （Chromium 中止还挂着的首个请求），错误族只要指向导航失败即可；
      // navTimeoutMs 被消费的硬证据在步骤耗时：默认 45s×2 次尝试 ≥90s，配置生效时 ≈4s。
      assert.ok(/page\.goto|timeout|超时|ERR_/i.test(rep.error || ''), '失败原因应指向导航失败: ' + rep.error);
      const stepMs = rep.steps && rep.steps[0] ? rep.steps[0].ms : took;
      assert.ok(stepMs < 20000, '配置 1500ms 导航超时应快速失败：步骤耗时 ' + stepMs + 'ms');
      assert.ok(took < 45000, '失败收尾必须有界（截图/evaluate 不得无限等），实际 ' + took + 'ms');
    } finally {
      writeConfig({ run: { navTimeoutMs: before } });
      // 死端口可能还挂着浏览器残留连接，close() 会等它们断开——先强制断连再关，收尾必须确定性有界
      if (silent.closeAllConnections) silent.closeAllConnections();
      await new Promise((r) => silent.close(r));
    }
    assert.equal(readConfig().run.navTimeoutMs, 45000, 'navTimeoutMs 未恢复默认');
  });

  await A('status_report.onlyProblems 只返回有问题的流程（problems 字段省略）', async () => {
    const okF = F('t-sp-ok', [gt(DEMO + '/form')], { assertions: [{ kind: 'textPresent', text: '提交工单' }] });
    saveFlow(okF); created.push(okF.id);
    const rOk = await run(okF);
    assert.equal(rOk.status, 'pass', rOk.error);
    const badF = F('t-sp-bad', [gt(DEMO + '/error')], { assertions: [{ kind: 'textPresent', text: '永不出现-XYZ' }] });
    saveFlow(badF); created.push(badF.id);
    const rBad = await run(badF);
    assert.equal(rBad.status, 'fail', '该用例应失败: ' + rBad.error);
    const all = statusReport({});
    assert.ok(all.items.some((i) => i.flowId === 't-sp-ok'), '全量应包含通过的流程');
    assert.ok(all.items.some((i) => i.flowId === 't-sp-bad'), '全量应包含失败的流程');
    assert.ok(Array.isArray(all.problems), '默认应带 problems 汇总');
    const only = statusReport({ onlyProblems: true });
    assert.ok(!only.items.some((i) => i.flowId === 't-sp-ok'), 'onlyProblems 不该包含通过的流程: ' + JSON.stringify(only.items.map((i) => i.flowId + ':' + i.lastStatus)));
    assert.ok(only.items.some((i) => i.flowId === 't-sp-bad'), 'onlyProblems 应保留失败流程');
    assert.equal(only.problems, undefined, 'onlyProblems=true 时 problems 字段应省略');
  });

  await A('run.keepRunsPerFlow 配置驱动 pruneRuns（不传 keepCount 时走配置）', async () => {
    const f = F('t-cfg-keepruns', [gt(DEMO + '/form')], { assertions: [{ kind: 'textPresent', text: '提交工单' }] });
    fs.rmSync(path.join(DIRS.runs, f.id), { recursive: true, force: true });
    for (let i = 0; i < 3; i++) {
      const r = await run(f);
      assert.equal(r.status, 'pass', r.error);
    }
    const count = () => fs.readdirSync(path.join(DIRS.runs, f.id)).filter((d) => {
      try { return fs.statSync(path.join(DIRS.runs, f.id, d)).isDirectory(); } catch { return false; }
    }).length;
    assert.equal(count(), 3, '应有 3 次运行记录: ' + count());
    writeConfig({ run: { keepRunsPerFlow: 1, keepRunDays: 0, keepVideosPerFlow: 0 } });
    try {
      const res = pruneRuns(f.id, {});
      assert.ok(res.removed.length >= 2, JSON.stringify(res));
      assert.equal(count(), 1, '配置 keepRunsPerFlow=1 应只留 1 次，实际 ' + count());
    } finally {
      writeConfig({ run: { keepRunsPerFlow: 50, keepRunDays: 30, keepVideosPerFlow: 20 } });
    }
    assert.equal(readConfig().run.keepRunsPerFlow, 50, 'keepRunsPerFlow 未恢复默认');
  });

  await A('run.keepRunDays 配置驱动：超过天龄的运行记录被清理', async () => {
    const id = 't-cfg-keepdays';
    const base = path.join(DIRS.runs, id);
    fs.rmSync(base, { recursive: true, force: true });
    try {
      const mk = (stamp, ageDays) => {
        const d = path.join(base, stamp);
        fs.mkdirSync(d, { recursive: true });
        fs.writeFileSync(path.join(d, 'report.json'), JSON.stringify({ flowId: id, stamp, status: 'pass', startedAt: '2025-10-01T12:00:00.000Z', durationMs: 1, healed: [] }));
        const t = new Date(Date.now() - ageDays * 86400000);
        fs.utimesSync(d, t, t);            // pruneRuns 的天龄以运行目录 mtime 为准
      };
      mk('20251001-120000-000', 10);
      mk('20251002-120000-000', 1);
      writeConfig({ run: { keepRunsPerFlow: 0, keepRunDays: 5, keepVideosPerFlow: 0 } });
      try {
        const res = pruneRuns(id, {});
        assert.ok(res.removed.includes('20251001-120000-000'), '10 天前的应被清: ' + JSON.stringify(res));
        assert.ok(!res.removed.includes('20251002-120000-000'), '1 天内的不该清: ' + JSON.stringify(res));
        assert.ok(!fs.existsSync(path.join(base, '20251001-120000-000')), '10 天前的目录应已删除');
        assert.ok(fs.existsSync(path.join(base, '20251002-120000-000')), '1 天内的目录应保留');
      } finally {
        writeConfig({ run: { keepRunsPerFlow: 50, keepRunDays: 30, keepVideosPerFlow: 20 } });
      }
      assert.equal(readConfig().run.keepRunDays, 30, 'keepRunDays 未恢复默认');
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  await A('pruneRuns 显式单维度：只传 keepCount 不被配置 keepDays 稀释（修"传了 keepCount:1 却一条不删"）', async () => {
    const id = 't-prune-singledim';
    const base = path.join(DIRS.runs, id);
    fs.rmSync(base, { recursive: true, force: true });
    try {
      const mk = (stamp) => {
        const d = path.join(base, stamp);
        fs.mkdirSync(d, { recursive: true });
        fs.writeFileSync(path.join(d, 'report.json'), JSON.stringify({ flowId: id, stamp, status: 'pass', startedAt: '2025-10-01T12:00:00.000Z', durationMs: 1, healed: [] }));
      };
      // 配置默认双约束（50 次/30 天）在场：修复前只传 keepCount:1 会走"两者都设"AND 规则，
      // 新记录不超 30 天恒被保留 -> 静默空跑；修复后显式单维度即单维度生效
      mk('20251001-120000-000'); mk('20251002-120000-000'); mk('20251003-120000-000');
      const res1 = pruneRuns(id, { keepCount: 1 });
      assert.equal(res1.keepDays, 0, '显式只传 keepCount 时 keepDays 应按 0（不限）参与判定: ' + JSON.stringify(res1));
      assert.equal(res1.removed.length, 2, '应删 2 条: ' + JSON.stringify(res1));
      assert.equal(fs.readdirSync(base).length, 1, '应只剩 1 次');
      // 对称：只传 keepDays 时次数不参与（配置 keepRunsPerFlow=50 不稀释天龄规则）
      fs.rmSync(base, { recursive: true, force: true });
      for (const s of ['20251001-120000-000', '20251002-120000-000']) {
        mk(s);
        const t = new Date(Date.now() - (s === '20251001-120000-000' ? 10 : 1) * 86400000);
        fs.utimesSync(path.join(base, s), t, t);
      }
      const res2 = pruneRuns(id, { keepDays: 5 });
      assert.equal(res2.keepCount, 0, '显式只传 keepDays 时 keepCount 应按 0（不限）参与判定: ' + JSON.stringify(res2));
      assert.ok(res2.removed.includes('20251001-120000-000') && !res2.removed.includes('20251002-120000-000'), JSON.stringify(res2));
      // 两个都显式给 -> AND 规则不变：超次数但未超天龄的不删（对照：只传 keepCount:1 会删）
      fs.rmSync(base, { recursive: true, force: true });
      mk('20251001-120000-000'); mk('20251002-120000-000');   // 两条都刚建（1 天都没超）
      const res3 = pruneRuns(id, { keepCount: 1, keepDays: 30 });
      assert.equal(res3.removed.length, 0, 'AND 规则下未超天龄的不该删: ' + JSON.stringify(res3));
      assert.equal(fs.readdirSync(base).length, 2, '两条都应保留');
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  await A('run.keepVideosPerFlow 配置驱动：录像按配置留 N 段', async () => {
    const id = 't-cfg-keepvideos';
    const base = path.join(DIRS.runs, id);
    fs.rmSync(base, { recursive: true, force: true });
    try {
      const stamps = [];
      for (let i = 0; i < 5; i++) {
        const stamp = '20251001-12000' + i + '-000';
        stamps.push(stamp);
        const d = path.join(base, stamp);
        fs.mkdirSync(path.join(d, 'videos'), { recursive: true });
        fs.writeFileSync(path.join(d, 'report.json'), JSON.stringify({ flowId: id, stamp, status: 'pass', startedAt: '2025-10-01T12:00:00.000Z', durationMs: 1, healed: [] }));
        const v = path.join(d, 'videos', 'video.webm');
        fs.writeFileSync(v, 'webm-' + i);
        const t = new Date(Date.now() - (5 - i) * 60000);
        fs.utimesSync(v, t, t);            // 录像新旧以文件 mtime 为准
      }
      const countWebm = () => stamps.reduce((s, st) => s + (fs.existsSync(path.join(base, st, 'videos', 'video.webm')) ? 1 : 0), 0);
      writeConfig({ run: { keepRunsPerFlow: 0, keepRunDays: 0, keepVideosPerFlow: 2 } });
      try {
        const res = pruneRuns(id, {});
        assert.equal(res.videosRemoved, 3, JSON.stringify(res));
        assert.equal(res.videosKept, 2, JSON.stringify(res));
        assert.equal(countWebm(), 2, '应只剩 2 段录像');
      } finally {
        writeConfig({ run: { keepRunsPerFlow: 50, keepRunDays: 30, keepVideosPerFlow: 20 } });
      }
      assert.equal(readConfig().run.keepVideosPerFlow, 20, 'keepVideosPerFlow 未恢复默认');
      assert.equal(fs.readdirSync(base).length, 5, 'keepRunsPerFlow/keepRunDays=0 时运行记录本身不该被删');
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  /* ================= 收尾 ================= */
  // 备份不随 deleteFlow 清理：不一起删会永久累积（每跑一轮多几份残件）
  const purgeBackups = (id) => { for (const b of listBackups(id)) { try { fs.rmSync(b.file, { force: true }); } catch { /* ignore */ } } };
  for (const id of created) {
    try { deleteFlow(id); } catch { /* ignore */ }
    purgeBackups(id);
  }
  for (const id of ['t-select', 't-uncheck', 't-press', 't-hover', 't-scroll', 't-slow', 't-extract', 't-optional',
    't-asserts', 't-errbanner', 't-list-ok', 't-list-empty', 't-dl-ok', 't-dl-empty', 't-dl-strict', 't-assert-mix', 't-guard',
    't-guard2', 't-guard-ok', 't-retry', 't-human-headless', 't-human-headed', 't-secret', 't-csv-param',
    't-csv-all', 't-noev', 't-failshot', 't-preflight', 't-alarm', 't-msg',
    't-lock', 't-dlg-accept', 't-dlg-step', 't-dlg-bad', 't-dlg-lenient', 't-dateoff',
    't-mask-yes', 't-mask-no', 't-infinite', 't-interrupted', 't-retention', 't-badurl',
    't-splice-mid', 't-splice-tail', 't-splice-nosuffix', 't-splice-empty', 't-splice-var',
    't-splice-bad', 't-splice-lock', 't-splice-restore',
    't-timeout', 't-timeout-scroll', 't-timeout-handoff', 't-video', 't-video-ok', 't-video-secret', 't-sched-expect', 't-listruns',
    't-runidx-save', 't-runidx-heal', 't-runidx-prune', 't-runidx-order',
    't-chain-child', 't-chain-parent', 't-chain-skip-a', 't-chain-skip-b', 't-unattended', 't-video-prune',
    't-live-marker', 't-waiting-human', 't-cf-running', 't-cf-interrupted', 't-totalruns',
    't-noretry', 't-retry-cfg', 't-handoff-cfg', 't-mask-cfg', 't-noev-cfg', 't-url-regex', 't-url-regex-bad',
    't-cfg-ltz', 't-cfg-profile', 't-navtimeout', 't-sp-ok', 't-sp-bad', 't-cfg-keepruns']) {
    try { deleteFlow(id); } catch { /* ignore */ }
    try { fs.rmSync(path.join(DIRS.runs, id), { recursive: true, force: true }); } catch { /* ignore */ }
    purgeBackups(id);
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
