/* obs6 全链路走查：用户点名链条 + 归因三面一致 + 双模抽查（自密封）
 * A 悬浮球录制→生成→重播成功（✅ 无 🩵 对照）
 * B 失败探针（深页→根+点击+断言必败）→悬浮球 ▶→❌ + 🩵
 * C 🩵→控制台报告摘要含「归因」（act-report digest）
 * D 控制台直接回放→renderRunResult 归因行 + run_report JSON attribution（三面一致）
 * E 双模抽查：拔桥→徽章独立→本地录制回放；插回→徽章依赖
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pw from '../mcp/node_modules/playwright/index.js';
const { chromium } = pw;

const ROOT = 'D:/work/MCP/web-rpa-mcp/';
const PORT = 8324;
const BASE = 'http://127.0.0.1:' + PORT;
const DEAD = 'http://127.0.0.1:8399';
const log = (m) => console.log('[obs6] ' + m);
const bridgeCall = async (name, args) => {
  const r = await fetch(BASE + '/api/call', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, args: args || {} }) });
  return r.json();
};
const sh = (page, expr) => page.evaluate(new Function('return ' + expr));

let bridge = null, ctx = null, demo = null, stub = null, userDataDir = null;
const createdFlows = [];
let exitCode = 0;
const step = async (name, fn) => { try { await fn(); log('PASS ' + name); } catch (e) { exitCode = 1; log('FAIL ' + name + ': ' + (e && e.message ? e.message : e)); } };

try {
  /* ---- 环境 ---- */
  demo = await (await import('../demo/app.mjs')).startDemoServer(4321);
  const http = await import('node:http');
  stub = await new Promise((res) => {
    const s = http.createServer((q, r) => { r.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); r.end('<!doctype html><html><head><meta charset="utf-8"><title>obs6页</title></head><body><h1>obs6页</h1><input id="num" data-testid="num"><button id="go" data-testid="go" onclick="document.getElementById(\'out\').textContent=\'OK\'">执行</button><div id="out"></div>' +
      '<script>setTimeout(function(){var n=document.getElementById("num");n.value="7";n.dispatchEvent(new Event("input",{bubbles:true}));document.getElementById("go").click();},1200);</script></body></html>'); });
    s.listen(0, '127.0.0.1', () => res({ server: s, url: 'http://127.0.0.1:' + s.address().port }));
  });
  bridge = spawn('node', [ROOT + 'mcp/bridge.mjs', String(PORT)], { cwd: ROOT, stdio: 'ignore' });
  let ready = false;
  for (let i = 0; i < 40 && !ready; i++) { await new Promise((r) => setTimeout(r, 500)); try { ready = (await fetch(BASE + '/health')).ok; } catch { /* retry */ } }
  if (!ready) throw new Error('bridge 8324 未就绪');
  log('env ready：demo ' + demo.url + ' / stub ' + stub.url + ' / bridge ' + BASE);

  const rs = await bridgeCall('record_status');
  if (rs.data && rs.data.recording) throw new Error('录制器被外部占用，中止');

  const probe = {
    id: 't-obs6-fail', name: 't-obs6-fail', version: 1,
    startUrl: 'http://127.0.0.1:4321/report', params: [],
    steps: [
      { op: 'goto', seq: 1, url: 'http://127.0.0.1:4321/report' },
      { op: 'click', seq: 2, locators: [{ strategy: 'css', value: '#empNo' }, { strategy: 'role', value: 'textbox', name: '工号' }] },
    ],
    assertions: [{ kind: 'textPresent', text: '不存在的断言文字XYZ', message: 'obs6 走查探针：断言必失败' }],
  };
  const imp = await bridgeCall('flow_import', { flow: probe, overwrite: true });
  if (!imp.ok) throw new Error('flow_import: ' + imp.summary);
  createdFlows.push('t-obs6-fail');
  log('失败探针已导入');

  /* ---- 扩展浏览器（初始桥接=8324）---- */
  const EXT = ROOT + 'extension/';
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rpa-obs6-'));
  async function launch(headless) {
    const c = await chromium.launchPersistentContext(userDataDir, { channel: 'chromium', headless, args: ['--disable-extensions-except=' + EXT, '--load-extension=' + EXT, '--no-first-run'], viewport: { width: 1100, height: 760 } });
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
  const page = await ctx.newPage();
  const shadowBtn = (page, text) => page.evaluate((t) => {
    const r = document.getElementById('__rpa-ball-host').shadowRoot;
    const b = [...r.querySelectorAll('button.act')].find((x) => x.textContent.indexOf(t) >= 0);
    if (!b) throw new Error('no button ' + t);
    b.click();
  }, text);
  const msg = () => sh(page, 'document.getElementById("__rpa-ball-host").shadowRoot.querySelector(".msg").textContent');
  const chip = () => sh(page, 'document.getElementById("__rpa-ball-host").shadowRoot.querySelector(".mode-chip").textContent');

  /* ---- A 成功场景：录制→重播（✅ 无 🩵 对照）---- */
  await step('A1 录制→生成', async () => {
    await page.goto(stub.url + '/?auto=1');
    await page.waitForSelector('#__rpa-ball-host', { state: 'attached', timeout: 15000 });
    await page.click('#__rpa-ball-host .ball');
    await page.waitForFunction(() => { const r = document.getElementById('__rpa-ball-host').shadowRoot; return [...r.querySelectorAll('button.act')].some((b) => b.textContent.indexOf('快速录制当前页') >= 0); }, undefined, { timeout: 10000 });
    await shadowBtn(page, '快速录制当前页');
    await page.waitForFunction(() => { const r = document.getElementById('__rpa-ball-host').shadowRoot; const badge = r.querySelector('.badge'); return badge && !badge.classList.contains('hide') && (parseInt(badge.textContent, 10) || 0) >= 2; }, undefined, { timeout: 45000 });
    await page.waitForTimeout(2500);
    await shadowBtn(page, '结束并保存');
    await page.waitForFunction(() => { const m = document.getElementById('__rpa-ball-host').shadowRoot.querySelector('.msg').textContent; return m.indexOf('技能已生成') >= 0 || m.indexOf('❌') >= 0; }, undefined, { timeout: 60000 });
    const m = await msg();
    if (m.indexOf('技能已生成') < 0) throw new Error(m.slice(0, 100));
    const fl = await bridgeCall('flow_list');
    const rec = ((fl.data && fl.data.flows) || []).find((f) => (f.id || '').indexOf('悬浮-') === 0);
    if (rec) createdFlows.push(rec.id);
    log('  生成: ' + m.slice(0, 50));
  });
  await step('A2 重播成功（✅ 且无 🩵）', async () => {
    await page.waitForFunction(() => { const r = document.getElementById('__rpa-ball-host').shadowRoot; return [...r.querySelectorAll('button.act')].some((b) => b.textContent.indexOf('重播刚生成的技能') >= 0); }, undefined, { timeout: 8000 });
    await shadowBtn(page, '重播刚生成的技能');
    await page.waitForFunction(() => { const m = document.getElementById('__rpa-ball-host').shadowRoot.querySelector('.msg').textContent; return m.indexOf('重播成功') >= 0 || m.indexOf('❌') >= 0; }, undefined, { timeout: 60000 });
    const m = await msg();
    if (m.indexOf('重播成功') < 0) throw new Error(m.slice(0, 120));
    const actHidden = await sh(page, 'document.getElementById("__rpa-ball-host").shadowRoot.querySelector(".msg-act").classList.contains("hide")');
    if (!actHidden) throw new Error('成功场景不应显示 🩵');
    log('  ' + m.slice(0, 60) + ' | 🩵 隐藏=PASS');
  });

  /* ---- B 失败场景：悬浮球 ▶ 探针 → ❌ + 🩵 ---- */
  await step('B1 失败回放 → ❌ + 🩵 出现', async () => {
    await page.click('__rpa-ball-host .ball'.startsWith('#') ? '#__rpa-ball-host .ball' : '#__rpa-ball-host .ball');
    await page.waitForTimeout(400);
    await page.click('#__rpa-ball-host .ball');
    await page.waitForFunction(() => { const r = document.getElementById('__rpa-ball-host').shadowRoot; return [...r.querySelectorAll('.frow')].some((x) => x.textContent.indexOf('t-obs6-fail') >= 0); }, undefined, { timeout: 10000 });
    await page.evaluate(() => {
      const r = document.getElementById('__rpa-ball-host').shadowRoot;
      const row = [...r.querySelectorAll('.frow')].find((x) => x.textContent.indexOf('t-obs6-fail') >= 0);
      row.querySelectorAll('button')[0].click();
    });
    await page.waitForFunction(() => { const r = document.getElementById('__rpa-ball-host').shadowRoot; const m = r.querySelector('.msg').textContent; const act = r.querySelector('.msg-act'); return (m.indexOf('❌') >= 0) && act && !act.classList.contains('hide'); }, undefined, { timeout: 60000 });
    log('  ' + (await msg()).replace(/\s+/g, ' ').slice(0, 90));
  });

  /* ---- C 🩵 → 控制台报告摘要含归因 ---- */
  const consolePage = await (async () => {
    const [p] = await Promise.all([ctx.waitForEvent('page'), page.evaluate(() => document.getElementById('__rpa-ball-host').shadowRoot.querySelector('.msg-act button').click())]);
    return p;
  })();
  await step('C1 🩵 打开控制台 + 报告摘要含「归因」', async () => {
    await consolePage.waitForLoadState('domcontentloaded');
    if (consolePage.url().indexOf('8324') < 0) throw new Error('控制台地址异常: ' + consolePage.url());
    await consolePage.locator('#tabs button[data-tab="flows"]').click();
    const card = consolePage.locator('.flow-card[data-flow="t-obs6-fail"]');
    await card.waitFor({ state: 'visible', timeout: 15000 });
    if (!(await card.evaluate((el) => el.open))) await card.locator('summary').click();
    await card.locator('.act-report').click();
    await consolePage.waitForFunction(() => { const c = document.querySelector('.flow-card[data-flow="t-obs6-fail"]'); const o = c && c.querySelector('.out'); return o && o.textContent.indexOf('归因') >= 0; }, undefined, { timeout: 15000 });
    const t = await consolePage.evaluate(() => document.querySelector('.flow-card[data-flow="t-obs6-fail"] .out').textContent);
    if (t.indexOf('疑似外部真实站风控重定向') < 0) throw new Error('摘要缺归因文案: ' + t.slice(0, 200));
    if (t.indexOf('最终页') < 0) throw new Error('摘要缺最终页: ' + t.slice(0, 200));
  });

  /* ---- D 控制台直接回放：renderRunResult 归因行 + run_report JSON 三面一致 ---- */
  await step('D1 控制台回放 → renderRunResult 归因行', async () => {
    const cardSel = '.flow-card[data-flow="t-obs6-fail"]';
    if (!(await card_open(consolePage))) await consolePage.locator(cardSel + ' summary').click();
    // run-area 是折叠面板：已展开就不再点 act-run（toggle 会把它关掉导致 run-go 不可见）
    const areaOpen = await consolePage.locator(cardSel + ' .run-area').isVisible().catch(() => false);
    if (!areaOpen) await consolePage.locator(cardSel + ' .act-run').click();
    await consolePage.locator(cardSel + ' .run-go').click();
    try {
      await consolePage.waitForFunction(() => { const c = document.querySelector('.flow-card[data-flow="t-obs6-fail"]'); const o = c && c.querySelector('.out'); return o && o.textContent.indexOf('归因:') >= 0; }, undefined, { timeout: 60000 });
    } catch (e) {
      const t = await consolePage.evaluate(() => { const c = document.querySelector('.flow-card[data-flow="t-obs6-fail"]'); return c && c.querySelector('.out') ? c.querySelector('.out').textContent : '(no .out)'; });
      throw new Error('归因行未出现，.out 现场: ' + t.replace(/\s+/g, ' ').slice(0, 300));
    }
    const t = await consolePage.evaluate(() => document.querySelector('.flow-card[data-flow="t-obs6-fail"] .out').textContent);
    if (t.indexOf('疑似外部真实站风控重定向') < 0) throw new Error('归因行缺文案');
    log('  renderRunResult 归因行渲染 PASS');
  });
  async function card_open(p) { return p.locator('.flow-card[data-flow="t-obs6-fail"]').evaluate((el) => el.open); }
  await step('D2 run_report JSON 含 attribution（三面一致）', async () => {
    const rr = await bridgeCall('run_report', { flowId: 't-obs6-fail' });
    const d = rr.data || {};
    if (!d.attribution || d.attribution.indexOf('疑似外部真实站风控重定向') < 0) throw new Error('run_report 缺 attribution: ' + JSON.stringify(d).slice(0, 200));
    if (!d.finalUrl || d.finalUrl.indexOf('127.0.0.1:4321') < 0) throw new Error('finalUrl 异常: ' + d.finalUrl);
    log('  run_report attribution + finalUrl PASS');
  });

  /* ---- E 双模抽查 ---- */
  await step('E1 拔桥 → 悬浮球徽章=独立 + 本地录制回放', async () => {
    bridge.kill(); bridge = null;
    await new Promise((r) => setTimeout(r, 600));
    await page.evaluate((b) => chrome.storage.local.set({ bridgeUrl: b }), DEAD).catch(() => {});
    // content 经 SW→bridge 会失败；直接改扩展 storage 后需新页签生效（background 每次读 storage）
    await page.reload();
    await page.waitForSelector('#__rpa-ball-host', { state: 'attached', timeout: 15000 });
    await page.click('#__rpa-ball-host .ball');
    await page.waitForFunction(() => { const c = document.getElementById('__rpa-ball-host').shadowRoot.querySelector('.mode-chip'); return c && c.textContent.indexOf('独立模式') >= 0; }, undefined, { timeout: 15000 });
    await page.waitForFunction(() => { const r = document.getElementById('__rpa-ball-host').shadowRoot; return [...r.querySelectorAll('button.act')].some((b) => b.textContent.indexOf('本地录制当前页') >= 0); }, undefined, { timeout: 10000 });
    await shadowBtn(page, '本地录制当前页');
    await page.waitForTimeout(300);
    await page.fill('#num', '999');
    await page.click('#go');
    await page.waitForTimeout(300);
    await page.waitForFunction(() => { const r = document.getElementById('__rpa-ball-host').shadowRoot; return [...r.querySelectorAll('button.act')].some((b) => b.textContent.indexOf('保存到本地') >= 0); }, undefined, { timeout: 10000 });
    await shadowBtn(page, '保存到本地');
    await page.waitForFunction(() => { const m = document.getElementById('__rpa-ball-host').shadowRoot.querySelector('.msg').textContent; return m.indexOf('已保存到本地') >= 0; }, undefined, { timeout: 10000 });
    await page.evaluate(() => { document.getElementById('out').textContent = ''; });
    await page.waitForFunction(() => { const r = document.getElementById('__rpa-ball-host').shadowRoot; return [...r.querySelectorAll('.locsect .frow')].some((x) => x.textContent.indexOf('步 · 本地') >= 0); }, undefined, { timeout: 10000 });
    await page.evaluate(() => {
      const r = document.getElementById('__rpa-ball-host').shadowRoot;
      const row = [...r.querySelectorAll('.locsect .frow')].find((x) => x.textContent.indexOf('步 · 本地') >= 0);
      row.querySelectorAll('button')[0].click();
    });
    await page.waitForFunction(() => { const m = document.getElementById('__rpa-ball-host').shadowRoot.querySelector('.msg').textContent; return m.indexOf('独立回放完成') >= 0 || m.indexOf('❌') >= 0; }, undefined, { timeout: 15000 });
    const m = await msg();
    if (m.indexOf('独立回放完成') < 0) throw new Error(m.slice(0, 120));
    const out = await page.evaluate(() => document.getElementById('out').textContent);
    if (out !== 'OK') throw new Error('本地回放 out=' + out);
  });
  await step('E2 插回桥接 → 徽章=依赖 MCP', async () => {
    bridge = spawn('node', [ROOT + 'mcp/bridge.mjs', String(PORT)], { cwd: ROOT, stdio: 'ignore' });
    let ready = false;
    for (let i = 0; i < 40 && !ready; i++) { await new Promise((r) => setTimeout(r, 500)); try { ready = (await fetch(BASE + '/health')).ok; } catch { /* retry */ } }
    if (!ready) throw new Error('重插桥接失败');
    // storage 必须在扩展页上下文写（page main world 无 chrome.storage——上轮教训）
    const p0 = await ctx.newPage();
    await p0.goto('chrome-extension://' + extId + '/popup.html');
    await p0.evaluate((b) => chrome.storage.local.set({ bridgeUrl: b }), BASE);
    await p0.close();
    await page.reload();
    await page.waitForSelector('#__rpa-ball-host', { state: 'attached', timeout: 15000 });
    await page.click('#__rpa-ball-host .ball');
    await page.waitForFunction(() => { const c = document.getElementById('__rpa-ball-host').shadowRoot.querySelector('.mode-chip'); return c && c.textContent.indexOf('依赖 MCP') >= 0; }, undefined, { timeout: 15000 });
  });
} catch (e) {
  exitCode = 1;
  log('走查失败: ' + (e && e.message ? e.message : e));
} finally {
  try { if (ctx) await ctx.close(); } catch { /* ignore */ }
  try { const c = await bridgeCall('record_status'); if (c.data && c.data.recording) { await bridgeCall('record_cancel'); log('清理: 已取消悬挂录制'); } } catch { /* ignore */ }
  try {
    for (const id of createdFlows) { try { await bridgeCall('flow_delete', { flowId: id }); log('清理 flow: ' + id); } catch (e) { log('清理失败 ' + id + ': ' + e.message); } }
  } catch { /* ignore */ }
  try { if (bridge) bridge.kill(); } catch { /* ignore */ }
  try { if (demo && demo.server) demo.server.close(); } catch { /* ignore */ }
  try { if (stub && stub.server) stub.server.close(); } catch { /* ignore */ }
  try { if (userDataDir) fs.rmSync(userDataDir, { recursive: true, force: true }); } catch { /* ignore */ }
  // 本地流程清理（扩展 storage 在 ctx 关闭后不可达；local-* 前缀不影响发布且下轮 standalone 验证会自清，如实记录）
}
log('done exit=' + exitCode);
process.exit(exitCode);
