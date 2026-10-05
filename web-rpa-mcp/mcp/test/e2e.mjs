// web-rpa-mcp — 端到端测试：真实录制 -> 生成技能 -> 回放 -> 自愈 -> 空结果守卫
// 用 Playwright 驱动"录制中的那个浏览器窗口"来模拟人工演示，事件由页面内录制器真实捕获。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startDemoServer } from '../../demo/app.mjs';
import { startRecording, stopRecording, activeSession } from '../lib/recorder.mjs';
import { runFlow } from '../lib/player.mjs';
import { loadFlow, saveFlow, deleteFlow, stepLabel } from '../lib/store.mjs';
import { lintFlow } from '../lib/lint.mjs';
import { formatDate, DIRS, readConfig, writeConfig } from '../lib/core.mjs';
import { closeAll, getPlaywright } from '../lib/browser.mjs';

const created = [];
let pass = 0, fail = 0, skip = 0;
const failures = [];
const skips = [];
// 诚实 SKIP 口径（同 tools.mjs / mysql-validate 退出码 3）：缺 playwright 环境下整个
// 录制/回放链路都跑不了 —— 明示 SKIP 不冒充失败（假红）也不冒充通过（假绿）。
// 探针守卫：只有环境真的解析不到 playwright 才降级；装了仍报缺 = 产品缺陷 = 照旧 FAIL。
const depSig = /未找到可用的 playwright|PLAYWRIGHT_NOT_FOUND/;
let pwMissing = false;
try { await getPlaywright(); } catch (e) { pwMissing = !!(e && e.code === 'PLAYWRIGHT_NOT_FOUND'); }
function check(name, fn) {
  try { fn(); pass++; console.log('  ok   ' + name); }
  catch (e) {
    const msg = e && e.message ? e.message : String(e);
    if (pwMissing && depSig.test(msg)) { skip++; skips.push(name + ' -> 缺 playwright 依赖'); console.log('  SKIP ' + name + '\n       （诚实 SKIP：环境缺 playwright 依赖）'); return; }
    fail++; failures.push(name + ' -> ' + msg); console.log('  FAIL ' + name + '\n       ' + msg);
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const today = formatDate(new Date(), 'YYYY-MM-DD');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'webrpa-e2e-'));
  const demo = await startDemoServer(0);
  console.log('\n演示站点: ' + demo.url);

  /* ---------- 1. 录制 ---------- */
  console.log('\n[1] 录制：在真实浏览器里演示一遍');
  const rec = await startRecording({ url: demo.url + '/', name: 'e2e-订单日报导出' });
  assert.ok(rec.ok, '开始录制失败: ' + JSON.stringify(rec));
  const session = activeSession();
  assert.ok(session, '没有活动录制会话');
  const page = session.page;

  await page.waitForSelector('[data-testid="empNo"]');
  await page.fill('[data-testid="empNo"]', '1001');            // 工号
  await page.waitForTimeout(400);
  await page.fill('#pwd', 'demo-pass');                        // 密码（应被识别为敏感）
  await page.waitForTimeout(400);
  await page.click('[data-testid="loginBtn"]');                // 登录 -> 跳转
  await page.waitForURL('**/report', { timeout: 15000 });
  await page.fill('[data-testid="reportDate"]', today);        // 报表日期（应为今天 -> 自动变量化）
  await page.waitForTimeout(400);
  await page.click('[data-testid="queryBtn"]');                // 查询 -> 跳转
  await page.waitForSelector('[data-testid="queryDone"]', { timeout: 15000 });
  await page.waitForTimeout(300);
  const exportPath = path.join(tmp, 'manual-export.csv');
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 20000 }), page.click('[data-testid="exportBtn"]')]);
  await dl.saveAs(exportPath);
  const manualCsv = fs.readFileSync(exportPath, 'utf8');
  console.log('  人工演示下载到: ' + dl.suggestedFilename() + '（' + manualCsv.length + ' 字节）');
  await sleep(1200);   // 等录制器的防抖 flush

  const stop = await stopRecording({ name: 'e2e-订单日报导出' });
  assert.ok(stop.ok, '结束录制失败: ' + JSON.stringify(stop));
  created.push(stop.flowId);

  console.log('\n  录到的步骤清单：');
  stop.flow.steps.forEach((s, i) => console.log('    ' + stepLabel(s, i)));
  console.log('\n  自动变量化: ' + JSON.stringify(stop.autoVariables));
  console.log('  推断断言: ' + JSON.stringify(stop.assertions));
  console.log('  录制提醒: ' + JSON.stringify(stop.notes));
  console.log('  lint: errors=' + stop.lint.errors.length + ' warnings=' + stop.lint.warnings.length + ' infos=' + stop.lint.infos.length);
  stop.lint.errors.forEach((e) => console.log('    ERROR [' + e.code + '] step' + e.step + ' ' + e.message));
  stop.lint.warnings.forEach((e) => console.log('    warn  [' + e.code + '] step' + e.step + ' ' + e.message));

  /* ---------- 2. 录制质量断言 ---------- */
  console.log('\n[2] 录制质量检查');
  const steps = stop.flow.steps;
  check('录到了 goto 起始页', () => assert.ok(steps.some((s) => s.op === 'goto'), '没有 goto 步骤'));
  check('没有重复的初始 goto', () => assert.equal(steps.filter((s) => s.op === 'goto' && !s.newTab).length, 1, '初始 goto 数量应为 1，实际 ' + steps.filter((s) => s.op === 'goto').length));
  check('录到了工号填写', () => assert.ok(steps.some((s) => s.op === 'fill' && String(s.value) === '1001'), '没有录到工号 1001'));
  check('密码被识别为敏感且未存明文', () => {
    const pwd = steps.find((s) => s.op === 'fill' && s.sensitiveReason === 'password');
    assert.ok(pwd, '没有识别出密码字段');
    assert.equal(pwd.value, '', '密码值不应被记录，实际=' + JSON.stringify(pwd.value));
  });
  check('今天的日期被自动变量化', () => {
    const hit = steps.find((s) => s.op === 'fill' && String(s.value).indexOf('\${today') === 0);
    assert.ok(hit, '没有把 ' + today + ' 换成 \${today:...}，步骤值=' + JSON.stringify(steps.filter((s) => s.op === 'fill').map((s) => s.value)));
  });
  check('登录点击带上了等待导航', () => assert.ok(steps.some((s) => s.op === 'click' && s.waitForNav), '没有等待导航标记'));
  check('导出的点击被标记 expectDownload', () => assert.ok(steps.some((s) => s.op === 'click' && s.expectDownload), '没有 expectDownload 标记'));
  check('每个点击都有定位符', () => {
    for (const s of steps.filter((x) => ['click', 'fill'].includes(x.op))) {
      assert.ok((s.locators || []).length > 0, '步骤缺少定位符: ' + stepLabel(s));
    }
  });
  check('优先使用了 data-testid 稳定定位', () => assert.ok(steps.some((s) => (s.locators || [])[0] && s.locators[0].strategy === 'testid'), '没有 testid 定位'));

  /* ---------- 3. 修复密码步骤 + 声明参数 ---------- */
  console.log('\n[3] 修复敏感步骤并声明变量');
  const flow = loadFlow(stop.flowId);
  const pwdStep = flow.steps.find((s) => s.op === 'fill' && s.sensitiveReason === 'password');
  pwdStep.value = '\${DEMO_PWD}';
  pwdStep.sensitive = true;
  flow.params = [{ name: 'DEMO_PWD', label: '演示密码', source: 'env:RPA_DEMO_PWD', secret: true, required: true }];
  saveFlow(flow);
  process.env.RPA_DEMO_PWD = 'demo-pass';
  const lint2 = lintFlow(loadFlow(stop.flowId), {});
  check('修复后没有阻断级问题', () => assert.equal(lint2.errors.length, 0, '仍有: ' + JSON.stringify(lint2.errors)));

  /* ---------- 4. 回放 ---------- */
  console.log('\n[4] 无头回放');
  const rep = await runFlow(loadFlow(stop.flowId), { params: {}, headed: false, trigger: 'e2e' });
  console.log('  状态=' + rep.status + ' 耗时=' + rep.durationMs + 'ms');
  rep.steps.forEach((s) => console.log('    ' + s.index + '. ' + s.op + ' [' + s.status + '] ' + (s.detail || s.error || '')));
  rep.assertions.forEach((a) => console.log('    断言 ' + (a.pass ? 'PASS' : 'FAIL') + ' [' + a.kind + '] ' + a.detail));
  if (rep.error) console.log('  错误: ' + rep.error);
  check('回放成功', () => assert.equal(rep.status, 'pass', '回放失败: ' + rep.error));
  check('下载断言通过（含数据行要求）', () => {
    const a = rep.assertions.find((x) => x.kind === 'download');
    assert.ok(a, '没有下载断言');
    assert.ok(a.pass, '下载断言未通过: ' + a.detail);
    assert.ok(/行/.test(a.detail), '下载断言未校验数据行数: ' + a.detail);
  });
  check('表格非空断言通过', () => assert.ok(rep.assertions.some((a) => a.kind === 'tableNotEmpty' && a.pass), '没有表格断言通过；实际断言=' + JSON.stringify(rep.assertions)));
  check('确实产生了下载文件', () => {
    assert.ok(rep.downloads.length > 0, '没有下载');
    const f = rep.downloads[0];
    assert.ok(fs.existsSync(f.path) && fs.statSync(f.path).size > 0, '下载文件不存在或为空: ' + JSON.stringify(f));
  });
  check('产生了证据截图', () => assert.ok(rep.screenshots.length > 0, '没有截图'));
  check('写入了运行报告', () => assert.ok(rep.reportPath && fs.existsSync(rep.reportPath), '报告不存在'));
  check('没有报错', () => assert.equal(rep.error, null, '有错误: ' + rep.error));

  /* ---------- 5. 自愈 ---------- */
  console.log('\n[5] 自愈：模拟页面改版导致定位符失效');
  const healFlow = JSON.parse(JSON.stringify(loadFlow(stop.flowId)));
  healFlow.id = stop.flowId + '-heal';
  healFlow.name = 'e2e-自愈验证';
  const exportStep = healFlow.steps.find((s) => s.op === 'click' && s.expectDownload);
  assert.ok(exportStep, '找不到导出点击步骤');
  exportStep.locators = [{ strategy: 'css', value: '#this-button-no-longer-exists-9f3a' }];   // 故意打断，保留 fingerprint
  delete healFlow.selfHealedAt;
  saveFlow(healFlow);
  created.push(healFlow.id);

  const healRep = await runFlow(loadFlow(healFlow.id), { params: {}, headed: false, trigger: 'e2e-heal' });
  console.log('  状态=' + healRep.status + '  自愈记录=' + JSON.stringify(healRep.healed));
  if (healRep.error) console.log('  错误: ' + healRep.error);
  check('定位符失效后靠指纹自愈并成功', () => assert.equal(healRep.status, 'pass', '自愈后仍失败: ' + healRep.error));
  check('记录了自愈事件', () => assert.ok(healRep.healed.length > 0, '没有自愈记录'));
  check('自愈置信度达标', () => assert.ok(healRep.healed[0].confidence >= 0.72, '置信度过低: ' + healRep.healed[0].confidence));
  check('自愈结果回写进流程文件', () => {
    const after = loadFlow(healFlow.id);
    const s = after.steps.find((x) => x.op === 'click' && (x.locators || []).some((l) => l.value === '导出'));
    assert.ok(s, '回写后应出现基于文本"导出"的定位符；当前=' + JSON.stringify(after.steps.filter((x) => x.op === 'click').map((x) => (x.locators || []).map((l) => l.strategy + ':' + l.value))));
  });

  /* run.healMinScore 与 flow_run.learn 的语义锁 */
  const mkHealFlow = (id, name) => {
    const f = JSON.parse(JSON.stringify(loadFlow(stop.flowId)));
    f.id = id; f.name = name;
    const s = f.steps.find((x) => x.op === 'click' && x.expectDownload);
    s.locators = [{ strategy: 'css', value: '#this-button-no-longer-exists-9f3a' }];   // 同样打断，保留 fingerprint
    delete f.selfHealedAt;
    saveFlow(f);
    created.push(f.id);
    return f;
  };

  const healFlow2 = mkHealFlow(stop.flowId + '-heal-threshold', 'e2e-自愈阈值验证');
  const prevHeal = readConfig().run.healMinScore;
  writeConfig({ run: { healMinScore: 2 } });   // 阈值高于置信度上限 1 -> 自愈永不达标
  try {
    const rep2 = await runFlow(loadFlow(healFlow2.id), { params: {}, headed: false, trigger: 'e2e-heal-threshold' });
    console.log('  状态=' + rep2.status + '  自愈记录=' + JSON.stringify(rep2.healed) + '  错误=' + (rep2.error || '无'));
    check('healMinScore 阈值不可达时不自愈（直接判失败，不硬凑）', () => {
      assert.equal(rep2.status, 'fail', '阈值 2 不该还能自愈成功');
      assert.equal((rep2.healed || []).length, 0, '不该产生自愈记录: ' + JSON.stringify(rep2.healed));
    });
  } finally {
    writeConfig({ run: { healMinScore: prevHeal } });
  }

  const healFlow3 = mkHealFlow(stop.flowId + '-heal-nolearn', 'e2e-自愈不回写验证');
  const beforeSteps3 = JSON.stringify(loadFlow(healFlow3.id).steps);
  const rep3 = await runFlow(loadFlow(healFlow3.id), { params: {}, headed: false, trigger: 'e2e-heal-nolearn', learn: false });
  console.log('  状态=' + rep3.status + '  自愈记录=' + JSON.stringify(rep3.healed));
  check('learn=false 时自愈照常生效但不回写流程文件', () => {
    assert.equal(rep3.status, 'pass', '自愈后应成功: ' + rep3.error);
    assert.ok((rep3.healed || []).length > 0, '应有自愈记录');
    assert.equal(JSON.stringify(loadFlow(healFlow3.id).steps), beforeSteps3, 'learn=false 不该回写流程文件');
  });

  /* ---------- 6. 空结果守卫 ---------- */
  console.log('\n[6] 空结果守卫：文章头号坑（改版点错位置 -> 生成空表却当成成功）');
  const emptyFlow = JSON.parse(JSON.stringify(loadFlow(stop.flowId)));
  emptyFlow.id = stop.flowId + '-empty';
  emptyFlow.name = 'e2e-空结果验证';
  const dateStep = emptyFlow.steps.find((s) => s.op === 'fill' && String(s.value).indexOf('\${today') === 0);
  assert.ok(dateStep, '找不到日期填写步骤');
  dateStep.value = '1999-01-01';            // 哨兵日期 -> 表格只有"暂无数据"占位行
  saveFlow(emptyFlow);
  created.push(emptyFlow.id);

  const emptyRep = await runFlow(loadFlow(emptyFlow.id), { params: {}, headed: false, trigger: 'e2e-empty' });
  console.log('  状态=' + emptyRep.status);
  console.log('  空结果守卫: ' + JSON.stringify(emptyRep.emptyGuard));
  emptyRep.assertions.forEach((a) => console.log('    断言 ' + (a.pass ? 'PASS' : 'FAIL') + ' [' + a.kind + '] ' + a.detail));
  check('空结果被判为失败（而不是假成功）', () => assert.equal(emptyRep.status, 'fail', '空结果竟然通过了'));
  check('失败原因指向空结果', () => assert.ok(/空|empty|暂无数据/i.test(JSON.stringify(emptyRep.assertions) + String(emptyRep.error)), '失败原因不明确: ' + JSON.stringify(emptyRep.assertions)));

  /* ---------- 7. 缺参数拦截 ---------- */
  console.log('\n[7] 缺必填参数时拒绝执行');
  delete process.env.RPA_DEMO_PWD;
  const noParam = await runFlow(loadFlow(stop.flowId), { params: {}, headed: false, trigger: 'e2e-noparam' });
  console.log('  状态=' + noParam.status + ' 错误=' + noParam.error);
  check('缺参数被阻断', () => assert.equal(noParam.status, 'blocked', '应被阻断，实际 ' + noParam.status));
  process.env.RPA_DEMO_PWD = 'demo-pass';

  /* ---------- 8. 定时与告警配置（不落地系统任务） ---------- */
  console.log('\n[8] 定时包装器与告警文案生成');
  const { writeWrapper } = await import('../lib/schedule.mjs');
  const wrapper = writeWrapper(stop.flowId, { params: { DEMO_PWD: 'x' }, at: '09:00', frequency: 'daily' });
  check('生成了任务计划包装器', () => assert.ok(fs.existsSync(wrapper), '包装器不存在'));
  check('包装器内容正确调用 runner', () => {
    const txt = fs.readFileSync(wrapper, 'utf8');
    assert.ok(txt.indexOf('runner.mjs') > 0, '未调用 runner.mjs');
    assert.ok(txt.indexOf('"run"') > 0, '未带 run 子命令');
    assert.ok(txt.indexOf('--params-file') > 0, '未传参数文件');
  });
  const { composeRunMessage } = await import('../lib/notify.mjs');
  const msg = composeRunMessage(rep, { notify: { mention: '' } });
  check('告警文案含流程名与状态标记', () => assert.ok(msg.title.indexOf(rep.name) >= 0 && /成功|失败/.test(msg.title), '文案异常: ' + msg.title));
  const failMsg = composeRunMessage(emptyRep, { notify: {} });
  check('失败告警文案含失败步骤与原因', () => assert.ok(failMsg.text.indexOf('校验') >= 0, '文案缺少校验信息: ' + failMsg.text));

  /* ---------- 9. 多标签：主录制页被关掉，工作标签页接替 ---------- */
  console.log('\n[9] 多标签：关掉主录制页后，已在用的标签页接替主录制');
  const rec2 = await startRecording({ url: demo.url + '/form', name: 'e2e-多标签' });
  assert.ok(rec2.ok, '第二次录制启动失败: ' + JSON.stringify(rec2));
  const s2 = activeSession();
  const p1 = s2.page;
  const p2 = await p1.context().newPage();
  await p2.goto(demo.url + '/frame');                 // 用户开了个新标签 -> 记一条 goto(newTab)
  await sleep(1600);                                  // 离开「进入跳转」的重定向收敛窗口
  await p2.evaluate((u) => { location.href = u; }, demo.url + '/form-result');   // 主页面还在：副标签地址栏跳转，不是开新标签
  await p2.waitForURL('**/form-result', { timeout: 10000 });
  await sleep(600);
  await p1.close();                                   // 用户把主录制页关掉了
  await sleep(1200);
  await p2.evaluate((u) => { location.href = u; }, demo.url + '/form');   // 无 DOM 事件的跳转（等价地址栏输入）
  await p2.waitForURL('**/form', { timeout: 10000 });
  await sleep(1200);   // 等录制器的防抖 flush
  const stop2 = await stopRecording({ name: 'e2e-多标签' });
  assert.ok(stop2.ok, '第二次录制失败: ' + JSON.stringify(stop2));
  created.push(stop2.flowId);
  const t2 = stop2.flow.steps;
  console.log('  多标签录到的步骤：');
  t2.forEach((s, i) => console.log('    ' + stepLabel(s, i)));
  check('新标签页只记一条「进入跳转」', () => {
    const n = t2.filter((s) => s.op === 'goto' && s.newTab).length;
    assert.equal(n, 1, 'goto(newTab) 数量应为 1，实际 ' + n + '：' + JSON.stringify(t2));
  });
  check('主页面还在时副标签跳转记成普通 goto（不是第二个新标签）', () => {
    assert.ok(t2.some((s) => s.op === 'goto' && !s.newTab && /form-result/.test(String(s.url))), '没有把副标签跳转记成普通 goto: ' + JSON.stringify(t2));
  });
  check('接替后跳转记成普通 goto（回放不会多开标签）', () => {
    assert.ok(t2.some((s) => s.op === 'goto' && !s.newTab && String(s.url).endsWith('/form')), '没有把接替页的跳转记成普通 goto: ' + JSON.stringify(t2));
  });
  check('没有多余的 goto（起始 + 新标签 + 副标签跳转 + 接替跳转，共 4 条）', () => {
    const n = t2.filter((s) => s.op === 'goto').length;
    assert.equal(n, 4, 'goto 总数应为 4，实际 ' + n + '：' + JSON.stringify(t2));
  });

  /* ---------- 10. 清理 ---------- */
  for (const id of created) { deleteFlow(id); }
  demo.server.close();
  await closeAll();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }

  console.log('\n总计: ' + pass + ' passed, ' + fail + ' failed' + (skip ? ', ' + skip + ' 诚实SKIP' : ''));
  if (fail) console.log('\n失败项:\n' + failures.join('\n'));
  if (skip) console.log('\n诚实 SKIP（不计通过也不计失败）:\n' + skips.join('\n'));
  process.exit(fail ? 1 : skip ? 3 : 0);
}

main().catch(async (e) => {
  const msg = String(e && e.message ? e.message : e);
  try { await closeAll(); } catch { /* ignore */ }
  // 整条链路在起点就因缺依赖中断：诚实 SKIP（exit 3），不冒充失败
  if (pwMissing && depSig.test(msg)) {
    console.log('\nSKIP 端到端（整体）（诚实 SKIP：环境缺 playwright 依赖——先在 mcp 目录 npm install）');
    console.log('\n总计: ' + pass + ' passed, ' + fail + ' failed, 1 诚实SKIP');
    process.exit(3);
  }
  console.error('\n端到端测试异常: ' + String(e && e.stack ? e.stack : e));
  process.exit(1);
});
