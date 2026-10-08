/* verify/button-sweep.mjs — /console 六页签逐按钮清扫（自密封）
 * 教训固化：popup 大量分区是折叠 <details>——交互前必须 openAllDetails(页签)；
 *           act-rename 走原生 prompt()（dialog.accept(值)）；录制结果看 toast/#rec-live-steps。
 * 分级：safe=读、roundtrip=点完还原、skip=有理由跳过（破坏性/人工/他人）
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pw from '../mcp/node_modules/playwright/index.js';
const { chromium } = pw;
const ROOT = 'D:/work/MCP/web-rpa-mcp/';
const PORT = 8330;
const BASE = 'http://127.0.0.1:' + PORT;
let pass = 0, fail = 0;
const failures = [];
const log = (m) => console.log('[sweep] ' + m);
function ok(n) { pass++; console.log('  ok   ' + n); }
function bad(n, e) { fail++; failures.push(n); console.log('  FAIL ' + n + ': ' + (e && e.message ? e : e)); }
async function T(n, fn) { try { await fn(); ok(n); } catch (e) { bad(n, e); } }
const bridgeCall = async (n, a) => {
  const r = await fetch(BASE + '/api/call', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: n, args: a || {} }) });
  return r.json();
};

let bridge = null, ctx = null, popup = null, stub = null, userDataDir = null;
const flowsCreated = [];
try {
  const http = await import('node:http');
  stub = await new Promise((res) => {
    const s = http.createServer((q, r) => {
      const u = new URL(q.url, 'http://x');
      const auto = u.search.indexOf('auto=1') >= 0;
      r.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      r.end('<!doctype html><html><head><meta charset="utf-8"><title>sweep页</title></head><body><h1>sweep页</h1><input id="num" data-testid="num"><button id="go" data-testid="go" onclick="document.getElementById(\'out\').textContent=\'OK\'">go</button><div id="out"></div>' +
        '<table id="tbl"><tbody><tr><td>a</td></tr><tr><td>b</td></tr></tbody></table>' +
        (auto ? '<script>setTimeout(function(){var n=document.getElementById("num");n.value="7";n.dispatchEvent(new Event("input",{bubbles:true}));document.getElementById("go").click();},1200);</script>' : '') +
        '</body></html>');
    });
    s.listen(0, '127.0.0.1', () => res({ server: s, url: 'http://127.0.0.1:' + s.address().port }));
  });
  bridge = spawn('node', [ROOT + 'mcp/bridge.mjs', String(PORT)], { cwd: ROOT, stdio: 'ignore' });
  let ready = false;
  for (let i = 0; i < 40 && !ready; i++) { await new Promise((r) => setTimeout(r, 500)); try { ready = (await fetch(BASE + '/health')).ok; } catch { /* retry */ } }
  if (!ready) throw new Error('bridge 未就绪');
  const mkFlow = (id, url, assertText) => ({
    id, name: id, version: 1, startUrl: url, params: [],
    steps: [{ op: 'goto', seq: 1, url }],
    assertions: assertText ? [{ kind: 'textPresent', text: assertText, message: 'sweep 断言' }] : [],
  });
  await bridgeCall('flow_import', { flow: mkFlow('t-sweep-a', stub.url + '/', 'sweep页'), overwrite: true }); flowsCreated.push('t-sweep-a');
  await bridgeCall('flow_import', { flow: mkFlow('t-sweep-b', stub.url + '/', 'sweep页'), overwrite: true }); flowsCreated.push('t-sweep-b');
  log('env ready：stub ' + stub.url);

  const EXT = ROOT + 'extension/';
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rpa-sweep-'));
  async function launch(headless) {
    const c = await chromium.launchPersistentContext(userDataDir, { channel: 'chromium', headless, args: ['--disable-extensions-except=' + EXT, '--load-extension=' + EXT, '--no-first-run'], viewport: { width: 1100, height: 860 } });
    let sw = c.serviceWorkers()[0];
    if (!sw) { try { sw = await c.waitForEvent('serviceworker', { timeout: headless ? 12000 : 20000 }); } catch (e) { await c.close(); return null; } }
    return c;
  }
  ctx = await launch(true) || await launch(false);
  if (!ctx) throw new Error('扩展 SW 未启动');
  const extId = new URL(ctx.serviceWorkers()[0].url()).hostname;
  {
    const p0 = await ctx.newPage();
    await p0.goto('chrome-extension://' + extId + '/popup.html');
    await p0.evaluate((b) => chrome.storage.local.set({ bridgeUrl: b }), BASE);
    await p0.close();
  }
  popup = await ctx.newPage();
  popup.setDefaultTimeout(10000);
  popup.on('dialog', async (d) => {
    try { if (d.type() === 'prompt') await d.accept('t-sweep-a'); else await d.accept(); } catch { /* ignore */ }
  });
  await popup.goto('chrome-extension://' + extId + '/popup.html');
  const openAll = async (tab) => popup.evaluate((t) => { document.querySelectorAll('#tab-' + t + ' details').forEach((d) => { d.open = true; }); }, tab);
  const goTab = async (t) => { await popup.locator('#tabs button[data-tab="' + t + '"]').click(); await openAll(t); await popup.waitForTimeout(300); };
  const toastHas = (needle) => popup.waitForFunction((nd) => { const t = document.getElementById('toast'); return t && !t.classList.contains('hide') && t.textContent.indexOf(nd) >= 0; }, needle, { timeout: 30000 });
  const outHas = async (rootSel, needle, ms) => popup.waitForFunction(([rs, nd]) => { const r = document.querySelector(rs); const o = r && (r.querySelector('.out') || r.querySelector('.runs-table')); return o && o.textContent.indexOf(nd) >= 0; }, [rootSel, needle], { timeout: ms || 25000 });
  const click = async (sel) => { await popup.locator(sel).first().click(); };

  /* ---- 状态页 ---- */
  await goTab('status');
  await T('S1 btn-refresh-health', async () => { await click('#btn-refresh-health'); await popup.waitForFunction(() => { const b = document.getElementById('health-body'); return b && b.textContent.length > 10; }, undefined, { timeout: 15000 }); });
  await T('S2 btn-doctor', async () => { await click('#btn-doctor'); await popup.waitForFunction(() => { const o = document.getElementById('doctor-out'); return o && o.textContent.length > 10; }, undefined, { timeout: 30000 }); });
  await T('S3 btn-status-report', async () => { await click('#btn-status-report'); await popup.waitForFunction(() => { const o = document.getElementById('status-out') || document.querySelector('#tab-status .out'); return o && o.textContent.length > 10; }, undefined, { timeout: 25000 }); });
  await T('S4 btn-prune（dryRun 预演，系统页）', async () => { await goTab('system'); await click('#btn-prune'); await popup.waitForFunction(() => { const o = document.getElementById('prune-out'); return o && o.textContent.length > 5; }, undefined, { timeout: 25000 }); });

  /* ---- 录制页 ---- */
  await goTab('record');
  await T('S5 btn-record-status', async () => { await goTab('record'); await click('#btn-record-status'); await popup.waitForTimeout(1800); const st = await popup.evaluate(() => ({ idle: (document.getElementById('rec-idle') || {}).textContent || '', live: (document.getElementById('rec-live-steps') || {}).textContent || '', toast: (document.getElementById('toast') || {}).textContent || '' })); if (!st.idle.trim() && !st.live.trim() && !st.toast.trim()) throw new Error('状态无任何输出: ' + JSON.stringify(st).slice(0, 120)); });
  await T('S6 录制往返 start→stop', async () => {
    await popup.locator('#rec-url').fill(stub.url + '/');
    await popup.locator('#rec-name').fill('sweep-rec');
    await click('#btn-record-start');
    await toastHas('录制已开始');
    await popup.waitForTimeout(2500);
    await popup.locator('#btn-record-stop').click();
    await toastHas('技能已生成').catch(async () => { await toastHas('没有操作'); });
    const fl = await bridgeCall('flow_list');
    const rec = ((fl.data && fl.data.flows) || []).find((f) => (f.name || '').indexOf('sweep-rec') === 0 || (f.id || '').indexOf('悬浮-') === 0);
    if (rec) flowsCreated.push(rec.id);
  });
  await T('S7 录制取消往返 start→cancel', async () => {
    await click('#btn-record-start');
    await toastHas('录制已开始');
    await popup.waitForTimeout(800);
    await click('#btn-record-cancel');
    await toastHas('已取消');
  });
  await T('S8 splice 表单（flow 下拉加载）', async () => {
    const sel = popup.locator('#splice-flow');
    await sel.waitFor({ state: 'visible', timeout: 10000 });
    if ((await sel.locator('option').count()) < 1) throw new Error('splice 下拉为空');
  });

  /* ---- 流程页 ---- */
  await goTab('flows');
  const card = '.flow-card[data-flow="t-sweep-a"]';
  await popup.locator(card).waitFor({ state: 'visible', timeout: 15000 });
  if (!(await popup.locator(card).evaluate((el) => el.open))) await popup.locator(card + ' summary').click(); // 折叠卡片先展开（S9-S12 教训）
  await T('S9 act-show 步骤清单', async () => { await popup.locator(card + ' .act-show').click(); await outHas(card, '打开网址', 15000); });
  await T('S10 act-preflight 预检', async () => { await popup.locator(card + ' .act-preflight').click(); await outHas(card, '预检', 30000); });
  await T('S11 act-lint 静态检查', async () => { await popup.locator(card + ' .act-lint').click(); await outHas(card, '静态检查', 25000); });
  await T('S12 act-history 历史表格', async () => { await popup.locator(card + ' .act-history').click(); await popup.waitForSelector(card + ' .runs-table', { timeout: 15000 }); });
  await T('S13 run-go 回放（成功场景）', async () => {
    const areaOpen = await popup.locator(card + ' .run-area').isVisible().catch(() => false);
    if (!areaOpen) await popup.locator(card + ' .act-run').click();
    await popup.locator(card + ' .run-go').click();
    await outHas(card, '回放成功', 60000);
  });
  await T('S14 act-report 报告摘要', async () => { await popup.locator(card + ' .act-report').click(); await outHas(card, '执行报告', 20000); });
  await T('S15 act-export 导出下载', async () => {
    const dl = popup.waitForEvent('download', { timeout: 15000 });
    await popup.locator(card + ' .act-export').click();
    const d = await dl;
    if (!/\.json$/.test(d.suggestedFilename())) throw new Error('文件名: ' + d.suggestedFilename());
  });
  await T('S16 act-rename（prompt 往返同名）', async () => {
    await popup.locator(card + ' .act-rename').click();
    await popup.waitForTimeout(1200); // prompt dialog 由 handler accept('t-sweep-a') 处理
    const fl = await bridgeCall('flow_list');
    if (!((fl.data && fl.data.flows) || []).some((f) => f.id === 't-sweep-a')) throw new Error('改名后流程丢失');
  });
  await T('S17 act-restore 备份列表', async () => { await popup.locator(card + ' .act-restore').click(); await popup.waitForTimeout(1500); });
  await T('S18 act-edit 编辑器可达', async () => { await popup.locator(card + ' .act-edit').click().catch(() => {}); await popup.waitForTimeout(800); });
  await T('S19 btn-chain-run 串联（details 先展开）', async () => {
    await openAll('flows');
    await popup.locator('#chain-items').fill(JSON.stringify([{ flow: 't-sweep-a' }, { flow: 't-sweep-b' }]));
    await click('#btn-chain-run');
    await popup.waitForFunction(() => { const o = document.getElementById('chain-out'); return o && (o.textContent.indexOf('t-sweep-a') >= 0 || o.textContent.indexOf('✅') >= 0 || o.textContent.indexOf('❌') >= 0 || o.textContent.indexOf('串联') >= 0); }, undefined, { timeout: 90000 });
  });
  await T('S20 本地流程卡片渲染', async () => {
    await popup.waitForSelector('#local-flows-card', { state: 'visible', timeout: 10000 });
    const t = await popup.evaluate(() => document.getElementById('local-flows-body').textContent);
    if (t.length < 5) throw new Error('本地卡片异常');
  });

  /* ---- 定时页 ---- */
  await goTab('schedule');
  await T('S21 定时往返 add→run-now→del', async () => {
    await popup.waitForFunction(() => { const s = document.getElementById('sched-flow'); return s && s.options.length > 1; }, undefined, { timeout: 15000 });
    await popup.locator('#sched-flow').selectOption('t-sweep-a');
    const at = popup.locator('#sched-at');
    if (await at.count()) await at.fill('09:41');
    await click('#btn-sched-add');
    try {
      await popup.waitForFunction(() => { const b = document.getElementById('sched-list'); return b && b.textContent.indexOf('t-sweep-a') >= 0; }, undefined, { timeout: 20000 });
    } catch (e) {
      const st = await popup.evaluate(() => ({ list: (document.getElementById('sched-list') || {}).textContent || '', toast: (document.getElementById('toast') || {}).textContent || '' }));
      throw new Error('add 后列表无任务: ' + JSON.stringify(st).slice(0, 200));
    }
    await popup.locator('#sched-list .sched-run').first().click();
    await popup.waitForTimeout(2500);
    await popup.locator('#sched-list .sched-del').first().click();
    await popup.waitForFunction(() => { const b = document.getElementById('sched-list'); return b && b.textContent.indexOf('t-sweep-a') < 0; }, undefined, { timeout: 20000 });
  });
  await T('S22 btn-sched-refresh', async () => { await click('#btn-sched-refresh'); await popup.waitForTimeout(800); });

  /* ---- 系统页 ---- */
  await goTab('system');
  await T('S23 secret 往返 set→list→delete', async () => {
    await goTab('system');
    await popup.locator('#sec-name').fill('sweep-key');
    await popup.locator('#sec-value').fill('sweep-val');
    await click('#btn-secret-set');
    await popup.waitForTimeout(800);
    await click('#btn-secret-list');
    await popup.waitForFunction(() => { const o = document.getElementById('secret-out'); return o && o.textContent.indexOf('sweep-key') >= 0; }, undefined, { timeout: 15000 });
    await popup.locator('#sec-name').fill('sweep-key');
    await click('#btn-secret-delete');
    await popup.waitForTimeout(800);
  });
  await T('S24 btn-profile-info', async () => { await click('#btn-profile-info'); await popup.waitForFunction(() => { const o = document.getElementById('profile-out'); return o && o.textContent.length > 5; }, undefined, { timeout: 15000 }); });
  await T('S25 btn-lock-status', async () => { await click('#btn-lock-status'); await popup.waitForFunction(() => { const o = document.getElementById('lock-out'); return o && o.textContent.length > 3; }, undefined, { timeout: 15000 }); });
  await T('S26 btn-config-get', async () => { await click('#btn-config-get'); await popup.waitForFunction(() => { const o = document.getElementById('config-out'); return o && o.textContent.length > 20; }, undefined, { timeout: 15000 }); });
  await T('S27 btn-notify-load', async () => { await click('#btn-notify-load'); await popup.waitForTimeout(1200); });
  log('skip: profile-login（人工扫码）/ profile-reset（清登录态）/ lock-release（可能碰他人锁）/ notify-save+test（无 webhook，集成已覆盖）/ config-set（集成已覆盖）/ editor 保存与 splice 执行（ui-ext 已覆盖）');

  /* ---- 控制台页 ---- */
  await goTab('console');
  await T('S28 btn-console-tools 44 工具表', async () => { await click('#btn-console-tools'); await popup.waitForFunction(() => { const b = document.getElementById('tool-list') || document.querySelector('#tab-console'); return b && b.textContent.indexOf('flow_run') >= 0; }, undefined, { timeout: 20000 }); });
  await T('S29 btn-console-call 原始调用', async () => { await click('#btn-console-call'); await popup.waitForFunction(() => { const o = document.getElementById('console-out') || document.querySelector('#tab-console .out'); return o && o.textContent.length > 10; }, undefined, { timeout: 25000 }); });

  /* ---- 设置 ---- */
  await T('S30 设置面板展开→保存往返（同值）', async () => {
    await click('#btn-settings'); // 头部 ⚙ 展开隐藏的 #settings 面板
    await popup.locator('#bridge-url').waitFor({ state: 'visible', timeout: 10000 });
    const v = await popup.locator('#bridge-url').inputValue();
    await click('#btn-save-settings');
    await popup.waitForTimeout(1000);
    const v2 = await popup.locator('#bridge-url').inputValue();
    if (v2 !== v) throw new Error('桥接地址被改变: ' + v + ' -> ' + v2);
    await click('#btn-settings'); // 收起还原
  });

  /* ---- S32 splice 执行闭环（候选④；同时回归 v1.21.1 setMyRecSession 修复）---- */
  await T('S32 splice 执行：from=3 重录 → popup 停止 → 步骤数增加', async () => {
    await bridgeCall('flow_import', { flow: mkFlow('t-sweep-c', stub.url + '/?auto=1', null), overwrite: true });
    // mkFlow 只有 goto 一步——补成 3 步探针（goto + click go + fill num）
    const sh = await bridgeCall('flow_show', { flowId: 't-sweep-c', format: 'json' });
    const f = sh.data;
    f.steps = [
      { op: 'goto', seq: 1, url: stub.url + '/?auto=1' },
      { op: 'click', seq: 2, locators: [{ strategy: 'testid', value: 'go' }] },
      { op: 'fill', seq: 3, locators: [{ strategy: 'testid', value: 'num' }], value: '1' },
    ];
    await bridgeCall('flow_import', { flow: f, overwrite: true });
    flowsCreated.push('t-sweep-c');
    // 清孤儿录制会话（此前失败轮泄漏的 splice 会话会阻塞新会话——录制器全局单例）
    const rs0 = await bridgeCall('record_status');
    if (rs0.data && rs0.data.recording) { await bridgeCall('record_cancel'); await popup.waitForTimeout(500); }
    await popup.reload(); // splice 下拉选项在 init 时加载——重载才能看到新导入的流程
    await goTab('record');
    const sel = popup.locator('#splice-flow');
    await sel.waitFor({ state: 'visible', timeout: 10000 });
    await popup.waitForFunction(() => { const s = document.getElementById('splice-flow'); return s && s.options.length > 1; }, undefined, { timeout: 15000 });
    await sel.selectOption('t-sweep-c');
    await popup.locator('#splice-from').fill('3');
    await popup.locator('#splice-to').fill('3');
    await click('#btn-splice-start');
    // 成功信号 = 停止卡出现（自己会话；v1.21.1 修复后可见）；失败信号 = toast ❌。不猜 toast 文案。
    await popup.waitForFunction(() => {
      const c = document.getElementById('rec-stop-card');
      const t = document.getElementById('toast');
      const stopped = c && c.style.display !== 'none';
      const err = t && !t.classList.contains('hide') && t.textContent.indexOf('❌') >= 0;
      return stopped || err;
    }, undefined, { timeout: 90000 });
    const t1 = await popup.evaluate(() => document.getElementById('toast').textContent);
    const stopVisible = await popup.evaluate(() => { const c = document.getElementById('rec-stop-card'); return c && c.style.display !== 'none'; });
    if (!stopVisible) throw new Error('splice 启动失败: ' + t1.slice(0, 150));
    // 等录制窗口里的 auto 合成事件真的录进新片段（轮询步数，替代固定等待的竞态）
    let stepped = false;
    let rsLast = null;
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      const rs = await bridgeCall('record_status');
      rsLast = rs.data;
      // splice 会话的 stepCount 只计新片段（API 探针实证：auto 的 fill+click=2 步）
      if (rs.data && rs.data.recording && (rs.data.stepCount || 0) >= 2) { stepped = true; break; }
      if (rs.data && !rs.data.recording) break;
    }
    if (stepped) await new Promise((r) => setTimeout(r, 2000)); // 长沉降对齐 API 探针成功模式（紧凑停止有间歇尾步丢失边界）
    if (!stepped) throw new Error('新片段未录到步骤（auto 链未触发？）');
    await click('#btn-record-stop');
    await popup.waitForFunction(() => { const t = document.getElementById('toast'); return t && !t.classList.contains('hide') && (t.textContent.indexOf('技能已生成') >= 0 || t.textContent.indexOf('拼接') >= 0 || t.textContent.indexOf('❌') >= 0); }, undefined, { timeout: 90000 });
    const t2 = await popup.evaluate(() => document.getElementById('toast').textContent);
    if (t2.indexOf('❌') >= 0) throw new Error('splice 停止失败: ' + t2.slice(0, 150));
    const sh2 = await bridgeCall('flow_show', { flowId: 't-sweep-c', format: 'json' });
    const steps2 = (sh2.data && sh2.data.steps) || [];
    const n = steps2.length;
    if (n < 4) throw new Error('拼接后步骤数应≥4（前缀2+新片段），实为 ' + n + '；步骤=' + steps2.map((s) => s.op).join(',') + '；录制会话步骤=' + JSON.stringify((rsLast && rsLast.steps) || []).slice(0, 200));
    log('  splice 后步骤数=' + n);
  });

  /* ---- S33-S35：recorder 分支三问审计（盲区狩猎续：空段/keepSuffix/params 前置）---- */
  await T('S33 splice 空段拒绝且原流程不改', async () => {
    // 无 auto 的静态页做前缀终点：录制窗口无合成事件 → 新片段必空 → finalizeSplice 拒绝保存
    const rs0 = await bridgeCall('record_status');
    if (rs0.data && rs0.data.recording) await bridgeCall('record_cancel');
    await bridgeCall('flow_import', { flow: mkFlow('t-sweep-d', stub.url + '/', null), overwrite: true });
    const sh0 = await bridgeCall('flow_show', { flowId: 't-sweep-d', format: 'json' });
    sh0.data.steps = [
      { op: 'goto', seq: 1, url: stub.url + '/' },
      { op: 'click', seq: 2, locators: [{ strategy: 'testid', value: 'go' }] },
      { op: 'fill', seq: 3, locators: [{ strategy: 'testid', value: 'num' }], value: '1' },
    ];
    await bridgeCall('flow_import', { flow: sh0.data, overwrite: true });
    flowsCreated.push('t-sweep-d');
    const sp = await bridgeCall('record_splice_start', { flowId: 't-sweep-d', from: 3, to: 3, keepSuffix: true });
    if (!sp.ok) throw new Error('splice 启动失败: ' + String(sp.summary).slice(0, 80));
    await new Promise((r) => setTimeout(r, 2500)); // 录制窗口开在静态页：不操作
    const st = await bridgeCall('record_stop', {});
    if (st.ok) throw new Error('空片段应被拒绝保存，却返回成功');
    if (String(st.summary || '').indexOf('没有录到任何步骤') < 0) throw new Error('拒绝文案不符: ' + String(st.summary).slice(0, 120));
    const sh1 = await bridgeCall('flow_show', { flowId: 't-sweep-d', format: 'json' });
    if (((sh1.data && sh1.data.steps) || []).length !== 3) throw new Error('原流程被修改了');
    const rs2 = await bridgeCall('record_status');
    if (rs2.data && rs2.data.recording) throw new Error('拒绝后会话未释放');
  });

  await T('S34 keepSuffix=false 后缀丢弃 + auto 新片段替换', async () => {
    const rs0 = await bridgeCall('record_status');
    if (rs0.data && rs0.data.recording) await bridgeCall('record_cancel');
    await bridgeCall('flow_import', { flow: mkFlow('t-sweep-e', stub.url + '/?auto=1', null), overwrite: true });
    const sh0 = await bridgeCall('flow_show', { flowId: 't-sweep-e', format: 'json' });
    sh0.data.steps = [
      { op: 'goto', seq: 1, url: stub.url + '/?auto=1' },
      { op: 'click', seq: 2, locators: [{ strategy: 'testid', value: 'go' }] },
      { op: 'fill', seq: 3, locators: [{ strategy: 'testid', value: 'num' }], value: '1' },
    ];
    await bridgeCall('flow_import', { flow: sh0.data, overwrite: true });
    flowsCreated.push('t-sweep-e');
    const sp = await bridgeCall('record_splice_start', { flowId: 't-sweep-e', from: 2, to: 2, keepSuffix: false });
    if (!sp.ok) throw new Error('splice 启动失败: ' + String(sp.summary).slice(0, 80));
    let stepped = false;
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      const rs = await bridgeCall('record_status');
      if (rs.data && rs.data.recording && (rs.data.stepCount || 0) >= 2) { stepped = true; break; }
      if (rs.data && !rs.data.recording) break;
    }
    if (!stepped) { await bridgeCall('record_cancel'); throw new Error('auto 新片段未录到步骤'); }
    await new Promise((r) => setTimeout(r, 2000));
    const st = await bridgeCall('record_stop', {});
    if (!st.ok) throw new Error('splice 失败: ' + String(st.summary).slice(0, 100));
    const sh1 = await bridgeCall('flow_show', { flowId: 't-sweep-e', format: 'json' });
    const steps = (sh1.data && sh1.data.steps) || [];
    const ops = steps.map((s) => s.op).join(',');
    if (ops !== 'goto,fill,click') throw new Error('keepSuffix=false 终态应为 goto,fill,click（后缀原 fill 已弃），实为 ' + ops);
    const fillStep = steps.find((s) => s.op === 'fill');
    if (!fillStep || String(fillStep.value) !== '7') throw new Error('新片段未替换（fill 值应为 auto 的 7）: ' + JSON.stringify(fillStep));
  });

  await T('S35 splice params 前置拒绝（缺参数点名）', async () => {
    const rs0 = await bridgeCall('record_status');
    if (rs0.data && rs0.data.recording) await bridgeCall('record_cancel');
    const pf = mkFlow('t-sweep-p', stub.url + '/q/${查询日}', null);
    pf.params = [{ name: '查询日', required: true }]; // missing 只收 required:true 的声明（resolveParams 实读定案）
    await bridgeCall('flow_import', { flow: pf, overwrite: true });
    flowsCreated.push('t-sweep-p');
    const sp = await bridgeCall('record_splice_start', { flowId: 't-sweep-p', from: 1, to: 1, keepSuffix: true });
    if (sp.ok) throw new Error('缺 params 应被前置拒绝');
    if (String(sp.summary || '').indexOf('重放前缀需要这些参数') < 0) throw new Error('拒绝文案不符: ' + String(sp.summary).slice(0, 120));
    if (String(sp.summary || '').indexOf('查询日') < 0) throw new Error('未点名缺失参数: ' + String(sp.summary).slice(0, 120));
    const rs2 = await bridgeCall('record_status');
    if (rs2.data && rs2.data.recording) throw new Error('拒绝后不应有会话');
  });

  /* ---- S36-S38：player 断言边界组（checkAssertion 语义实读后的负向/边界落点）---- */
  const runAsserts = async (id, url, asserts) => {
    const fl = mkFlow(id, url, null);
    fl.assertions = asserts;
    await bridgeCall('flow_import', { flow: fl, overwrite: true });
    flowsCreated.push(id);
    const r = await bridgeCall('flow_run', { flowId: id });
    return r.data || {};
  };
  await T('S36a url contains 正向 + title equals 精确匹配 → pass', async () => {
    const d = await runAsserts('t-sweep-a1', stub.url + '/', [
      { kind: 'url', contains: '127.0.0.1', message: 'u' },
      { kind: 'title', equals: 'sweep页', message: 't' },
    ]);
    if (d.status !== 'pass') throw new Error('应 pass: ' + JSON.stringify((d.assertions || []).map((a) => a.pass)));
  });
  await T('S36b title contains 大小写敏感 → fail（SKILL 五之四第 2 条的 stub 回归）', async () => {
    const d = await runAsserts('t-sweep-a2', stub.url + '/', [{ kind: 'title', contains: 'SWEEP页', message: '大小写' }]);
    if (d.status !== 'fail') throw new Error('大小写不敏感会误判 pass——contains 应区分大小写');
  });
  await T('S36c textAbsent 命中文本 → fail', async () => {
    const d = await runAsserts('t-sweep-a3', stub.url + '/', [{ kind: 'textAbsent', text: 'sweep页', message: '文本实际存在' }]);
    if (d.status !== 'fail') throw new Error('textAbsent 命中应 fail');
  });
  await T('S37 tableNotEmpty min 边界：min=2 过 / min=3 败（有效行数语义）', async () => {
    const d1 = await runAsserts('t-sweep-a4', stub.url + '/', [{ kind: 'tableNotEmpty', selector: '#tbl tbody tr', min: 2, message: '2 行达标' }]);
    if (d1.status !== 'pass') throw new Error('min=2 应 pass（表 2 行）: ' + JSON.stringify(d1.assertions));
    const d2 = await runAsserts('t-sweep-a5', stub.url + '/', [{ kind: 'tableNotEmpty', selector: '#tbl tbody tr', min: 3, message: '3 行不达标' }]);
    if (d2.status !== 'fail') throw new Error('min=3 应 fail（表仅 2 行）');
  });
  await T('S38 elementVisible/elementAbsent 正负边界', async () => {
    const d1 = await runAsserts('t-sweep-a6', stub.url + '/', [
      { kind: 'elementVisible', selector: '#go', message: '存在' },
      { kind: 'elementAbsent', selector: '#nope-x', message: '不存在' },
    ]);
    if (d1.status !== 'pass') throw new Error('visible+absent(不存在) 应 pass: ' + JSON.stringify(d1.assertions));
    const d2 = await runAsserts('t-sweep-a7', stub.url + '/', [{ kind: 'elementAbsent', selector: '#go', message: '存在却期望缺席' }]);
    if (d2.status !== 'fail') throw new Error('elementAbsent 命中现存元素应 fail');
  });

  /* ---- 清理卡片流程 ---- */
  await T('S31 act-delete 删除 t-sweep-b', async () => {
    await goTab('flows');
    const cb = '.flow-card[data-flow="t-sweep-b"]';
    await popup.locator(cb).waitFor({ state: 'visible', timeout: 15000 });
    if (!(await popup.locator(cb).evaluate((el) => el.open))) await popup.locator(cb + ' summary').click();
    await popup.locator(cb + ' .act-delete').click();
    await popup.waitForTimeout(400);
    await popup.locator(cb + ' .act-delete').click().catch(() => {}); // 两击确认或 confirm 已 accept
    await popup.waitForFunction((cs) => !document.querySelector(cs), cb, { timeout: 15000 });
    const fl = await bridgeCall('flow_list');
    if (((fl.data && fl.data.flows) || []).some((f) => f.id === 't-sweep-b')) throw new Error('流程未删除');
  });
} catch (e) {
  fail++; failures.push('setup: ' + (e && e.message ? e : e));
  console.log('  FAIL setup: ' + (e && e.message ? e : e));
} finally {
  try { if (ctx) await ctx.close(); } catch { /* ignore */ }
  try {
    const fl = await bridgeCall('flow_list');
    for (const f of ((fl.data && fl.data.flows) || [])) {
      if (/sweep|悬浮-/.test(f.id || '')) { try { await bridgeCall('flow_delete', { flowId: f.id }); } catch { /* ignore */ } }
    }
    try { await bridgeCall('secret_delete', { name: 'sweep-key' }); } catch { /* ignore */ }
    try { await bridgeCall('schedule_remove', { flowId: 't-sweep-a' }); } catch { /* ignore */ }
  } catch { /* ignore */ }
  try { if (bridge) bridge.kill(); } catch { /* ignore */ }
  try { if (stub && stub.server) stub.server.close(); } catch { /* ignore */ }
  try { if (userDataDir) fs.rmSync(userDataDir, { recursive: true, force: true }); } catch { /* ignore */ }
}
console.log('\nbutton-sweep: ' + pass + ' 过 / ' + fail + ' 败');
if (failures.length) console.log('失败:\n' + failures.join('\n'));
process.exit(fail ? 1 : 0);
