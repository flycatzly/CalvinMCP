/* verify/journey.mjs — 新用户插拔旅程（自密封）
 * 弧线：独立模式（无桥接）本地录制→👁查看→本地回放→（横幅独立/升级置灰）
 *       →插桥→横幅依赖→升级到 MCP→悬浮球列表重播（依赖路径，含默认断言可过 L010）
 *       →拔桥回落独立→本地流程仍在
 * 覆盖 v1.21.2 两处：本地行 👁 查看步骤；toMcpFlow 默认 url 断言（升级流程可直接重播）
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pw from '../mcp/node_modules/playwright/index.js';
const { chromium } = pw;
const ROOT = 'D:/work/MCP/web-rpa-mcp/';
const PORT = 8327;
const BASE = 'http://127.0.0.1:' + PORT;
const DEAD = 'http://127.0.0.1:8399';
let pass = 0, fail = 0;
const failures = [];
const log = (m) => console.log('[journey] ' + m);
function ok(n) { pass++; console.log('  ok   ' + n); }
function bad(n, e) { fail++; failures.push(n); console.log('  FAIL ' + n + ': ' + (e && e.message ? e : e)); }
async function T(n, fn) { try { await fn(); ok(n); } catch (e) { bad(n, e); } }
const bridgeCall = async (n, a) => {
  const r = await fetch(BASE + '/api/call', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: n, args: a || {} }) });
  return r.json();
};

let bridge = null, ctx = null, stub = null, userDataDir = null;
let promotedId = null;
let promotedName = null;
try {
  const http = await import('node:http');
  stub = await new Promise((res) => {
    const s = http.createServer((q, r) => { r.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); r.end('<!doctype html><html><head><meta charset="utf-8"><title>journey页</title></head><body><h1>journey页</h1><input id="num" data-testid="num"><button id="go" data-testid="go" onclick="document.getElementById(\'out\').textContent=\'OK\'">go</button><div id="out"></div></body></html>'); });
    s.listen(0, '127.0.0.1', () => res({ server: s, url: 'http://127.0.0.1:' + s.address().port }));
  });
  const EXT = ROOT + 'extension/';
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rpa-journey-'));
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
    await p0.evaluate((b) => chrome.storage.local.set({ bridgeUrl: b }), DEAD);
    await p0.evaluate(() => chrome.storage.local.set({ rpaLocalFlows: [] }));
    await p0.close();
  }
  log('新用户旅程开始（桥接=' + DEAD + ' 死端口，stub ' + stub.url + '）');
  const page = await ctx.newPage();
  const shadowBtn = (t) => page.evaluate((x) => {
    const r = document.getElementById('__rpa-ball-host').shadowRoot;
    const b = [...r.querySelectorAll('button.act')].find((y) => y.textContent.indexOf(x) >= 0);
    if (!b) throw new Error('no button ' + x);
    b.click();
  }, t);

  await T('J1 开箱即用：无桥接 → 徽章=独立模式', async () => {
    await page.goto(stub.url + '/');
    await page.waitForSelector('#__rpa-ball-host', { state: 'attached', timeout: 15000 });
    await page.click('#__rpa-ball-host .ball');
    await page.waitForFunction(() => { const c = document.getElementById('__rpa-ball-host').shadowRoot.querySelector('.mode-chip'); return c && c.textContent.indexOf('独立模式') >= 0; }, undefined, { timeout: 15000 });
  });
  await T('J2 本地录制（真实 fill+click）→ 保存', async () => {
    await shadowBtn('本地录制当前页');
    await page.waitForTimeout(300);
    await page.fill('#num', '42');
    await page.click('#go');
    await page.waitForTimeout(300);
    await page.waitForFunction(() => { const r = document.getElementById('__rpa-ball-host').shadowRoot; return [...r.querySelectorAll('button.act')].some((b) => b.textContent.indexOf('保存到本地') >= 0); }, undefined, { timeout: 10000 });
    await shadowBtn('保存到本地');
    await page.waitForFunction(() => { const m = document.getElementById('__rpa-ball-host').shadowRoot.querySelector('.msg').textContent; return m.indexOf('已保存到本地') >= 0; }, undefined, { timeout: 10000 });
  });
  await T('J3 👁 查看步骤（v1.21.2 新增能力）', async () => {
    await page.waitForFunction(() => { const r = document.getElementById('__rpa-ball-host').shadowRoot; return [...r.querySelectorAll('.locsect .frow')].some((x) => x.textContent.indexOf('步 · 本地') >= 0); }, undefined, { timeout: 10000 });
    await page.evaluate(() => {
      const r = document.getElementById('__rpa-ball-host').shadowRoot;
      const row = [...r.querySelectorAll('.locsect .frow')].find((x) => x.textContent.indexOf('步 · 本地') >= 0);
      row.querySelectorAll('button')[1].click(); // 👁（▶ 后第二颗）
    });
    await page.waitForFunction(() => { const r = document.getElementById('__rpa-ball-host').shadowRoot; return r.querySelector('.locsect .fblock') && r.querySelector('.locsect .fblock').textContent.indexOf('填入') >= 0; }, undefined, { timeout: 10000 });
    const steps = await page.evaluate(() => document.getElementById('__rpa-ball-host').shadowRoot.querySelector('.locsect .fblock').textContent);
    if (steps.indexOf('点击') < 0) throw new Error('步骤清单缺点击: ' + steps.slice(0, 80));
  });
  await T('J4 本地回放 → out=OK', async () => {
    await page.evaluate(() => { document.getElementById('out').textContent = ''; });
    await page.evaluate(() => { const r = document.getElementById('__rpa-ball-host').shadowRoot; const row = [...r.querySelectorAll('.locsect .frow')].find((x) => x.textContent.indexOf('步 · 本地') >= 0); row.querySelectorAll('button')[0].click(); });
    await page.waitForFunction(() => { const m = document.getElementById('__rpa-ball-host').shadowRoot.querySelector('.msg').textContent; return m.indexOf('独立回放完成') >= 0 || m.indexOf('❌') >= 0; }, undefined, { timeout: 15000 });
    const m = await page.evaluate(() => document.getElementById('__rpa-ball-host').shadowRoot.querySelector('.msg').textContent);
    if (m.indexOf('独立回放完成') < 0) throw new Error(m.slice(0, 100));
    if (await page.evaluate(() => document.getElementById('out').textContent) !== 'OK') throw new Error('回放未生效');
  });

  const popup = await ctx.newPage();
  popup.on('dialog', (d) => d.accept().catch(() => {}));
  await popup.goto('chrome-extension://' + extId + '/popup.html');
  await T('J5 独立模式横幅 + 升级按钮置灰', async () => {
    await popup.waitForFunction(() => { const b = document.getElementById('mode-body'); return b && b.textContent.indexOf('独立模式') >= 0; }, undefined, { timeout: 10000 });
    await popup.evaluate(() => document.querySelector('#tabs button[data-tab="flows"]').click());
    await popup.waitForSelector('.local-flow-row', { timeout: 10000 });
    const ghost = await popup.evaluate(() => { const up = [...document.querySelectorAll('.local-flow-row button')].find((b) => b.textContent.indexOf('升级到 MCP') >= 0); return up && up.classList.contains('ghost'); });
    if (!ghost) throw new Error('独立模式下升级按钮应置灰提示');
  });

  await T('J6 插桥 → 横幅依赖 → 升级到 MCP（含默认断言）', async () => {
    bridge = spawn('node', [ROOT + 'mcp/bridge.mjs', String(PORT)], { cwd: ROOT, stdio: 'ignore' });
    let ready = false;
    for (let i = 0; i < 40 && !ready; i++) { await new Promise((r) => setTimeout(r, 500)); try { ready = (await fetch(BASE + '/health')).ok; } catch { /* retry */ } }
    if (!ready) throw new Error('桥接未就绪');
    // popup 是扩展页上下文，chrome.storage 可直写——切桥接地址后再 reload
    await popup.evaluate((b) => chrome.storage.local.set({ bridgeUrl: b }), BASE);
    await popup.reload();
    await popup.waitForFunction(() => { const b = document.getElementById('mode-body'); return b && b.textContent.indexOf('依赖 MCP') >= 0; }, undefined, { timeout: 10000 });
    await popup.evaluate(() => document.querySelector('#tabs button[data-tab="flows"]').click());
    await popup.waitForSelector('.local-flow-row', { timeout: 10000 });
    await popup.evaluate(() => { const up = [...document.querySelectorAll('.local-flow-row button')].find((b) => b.textContent.indexOf('升级到 MCP') >= 0); up.click(); });
    await popup.waitForFunction(() => { const t = document.getElementById('toast'); return t && !t.classList.contains('hide') && (t.textContent.indexOf('已升级到 MCP') >= 0 || t.textContent.indexOf('❌') >= 0); }, undefined, { timeout: 15000 });
    const t = await popup.evaluate(() => document.getElementById('toast').textContent);
    if (t.indexOf('已升级到 MCP') < 0) throw new Error(t.slice(0, 120));
    const fl = await bridgeCall('flow_list');
    const f = ((fl.data && fl.data.flows) || []).find((x) => (x.id || '').indexOf('local-') === 0);
    if (!f) throw new Error('升级后流程不在 MCP 列表');
    promotedId = f.id;
    const sh = await bridgeCall('flow_show', { flowId: promotedId, format: 'json' });
    const asserts = (sh.data && sh.data.assertions) || [];
    if (!asserts.length || asserts[0].kind !== 'url') throw new Error('升级流程缺默认 url 断言: ' + JSON.stringify(asserts));
    promotedName = (sh.data && sh.data.name) || promotedId;
  });
  await T('J7 悬浮球列表重播升级流程（依赖路径，L010 不阻断）', async () => {
    await page.bringToFront();
    await page.click('#__rpa-ball-host .ball'); // 前序面板可能仍开着——先关
    await page.waitForTimeout(400);
    await page.click('#__rpa-ball-host .ball'); // 再开 = 强制 refresh 拉最新 MCP 列表
    await page.waitForFunction((pid) => { const r = document.getElementById('__rpa-ball-host').shadowRoot; return [...r.querySelectorAll('.frow button')].some((b) => (b.title || '').indexOf('无头回放 ' + pid) >= 0); }, promotedId, { timeout: 15000 });
    await page.evaluate((pid) => {
      const r = document.getElementById('__rpa-ball-host').shadowRoot;
      // MCP 行 ▶ 的 title=「无头回放 <id>」——同名双行（MCP/本地）场景下按 title 精确点中（体感旅程实锤的歧义）
      const b = [...r.querySelectorAll('.frow button')].find((x) => (x.title || '').indexOf('无头回放 ' + pid) >= 0);
      if (!b) throw new Error('no MCP replay button');
      b.click();
    }, promotedId);
    try {
      await page.waitForFunction(() => { const m = document.getElementById('__rpa-ball-host').shadowRoot.querySelector('.msg').textContent; return m.indexOf('回放成功') >= 0 || m.indexOf('❌') >= 0 || m.indexOf('拒绝执行') >= 0; }, undefined, { timeout: 90000 });
    } catch (e) {
      const dump = await page.evaluate(() => {
        const r = document.getElementById('__rpa-ball-host').shadowRoot;
        return { msg: r.querySelector('.msg').textContent, rows: [...r.querySelectorAll('.frow')].map((x) => x.textContent.slice(0, 50)) };
      });
      const locals = await popup.evaluate(() => new Promise((res) => {
        chrome.storage.local.get('rpaLocalFlows', (st) => {
          const arr = (st.rpaLocalFlows || []).map((f) => ({ name: f.name, steps: (f.steps || []).map((s) => s.op) }));
          res(arr);
        });
      }));
      throw new Error('重播无终态 msg=' + dump.msg.slice(0, 100) + ' | 面板行=' + JSON.stringify(dump.rows) + ' | 本地流程=' + JSON.stringify(locals));
    }
    const m = await page.evaluate(() => document.getElementById('__rpa-ball-host').shadowRoot.querySelector('.msg').textContent);
    if (m.indexOf('回放成功') < 0) throw new Error('升级流程重播失败: ' + m.slice(0, 140));
  });
  await T('J8 拔桥 → 回落独立 + 本地流程仍在', async () => {
    bridge.kill(); bridge = null;
    await new Promise((r) => setTimeout(r, 600));
    const p0 = await ctx.newPage();
    await p0.goto('chrome-extension://' + extId + '/popup.html');
    await p0.evaluate((b) => chrome.storage.local.set({ bridgeUrl: b }), DEAD);
    await p0.close();
    await popup.reload();
    await popup.waitForFunction(() => { const b = document.getElementById('mode-body'); return b && b.textContent.indexOf('独立模式') >= 0; }, undefined, { timeout: 10000 });
    await popup.evaluate(() => document.querySelector('#tabs button[data-tab="flows"]').click());
    await popup.waitForFunction(() => { const b = document.getElementById('local-flows-body'); return b && b.textContent.indexOf('本地-') >= 0; }, undefined, { timeout: 10000 });
  });
} catch (e) {
  fail++; failures.push('setup: ' + (e && e.message ? e : e));
  console.log('  FAIL setup: ' + (e && e.message ? e : e));
} finally {
  try { if (ctx) await ctx.close(); } catch { /* ignore */ }
  try {
    const b2 = spawn('node', [ROOT + 'mcp/bridge.mjs', String(PORT)], { cwd: ROOT, stdio: 'ignore' });
    let ready = false;
    for (let i = 0; i < 20 && !ready; i++) { await new Promise((r) => setTimeout(r, 400)); try { ready = (await fetch(BASE + '/health')).ok; } catch { /* retry */ } }
    if (ready) {
      try {
        const fl = await bridgeCall('flow_list');
        for (const f of ((fl.data && fl.data.flows) || [])) { if ((f.id || '').indexOf('local-') === 0) { await bridgeCall('flow_delete', { flowId: f.id }); log('清理: ' + f.id); } }
      } catch (e) { log('清理失败: ' + e.message); }
    }
    try { b2.kill(); } catch { /* ignore */ }
  } catch { /* ignore */ }
  try { if (stub && stub.server) stub.server.close(); } catch { /* ignore */ }
  try { if (userDataDir) fs.rmSync(userDataDir, { recursive: true, force: true }); } catch { /* ignore */ }
}
console.log('\njourney: ' + pass + ' 过 / ' + fail + ' 败');
if (failures.length) console.log('失败:\n' + failures.join('\n'));
process.exit(fail ? 1 : 0);
