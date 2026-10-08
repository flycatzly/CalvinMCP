/* verify/standalone.mjs — 插拔式双模全功能点验证（无需预装桥接；自密封清理）
 * Part1 独立模式（桥接=死端口）：悬浮球 模式徽章/本地录制/本地回放
 * Part2 popup 独立 UI：模式横幅/本地列表/导出/弹窗删除
 * Part3 插入桥接：横幅切依赖/本地流程「升级到 MCP」/映射正确性（goto 起手）
 * Part4 拔出桥接：横幅回落独立/本地流程仍在（存储跨模式存活）
 * Part5 popup→content 通道：「▶ 回放到当前标签」
 * 纪律：临时桥接 finally kill；userDataDir mkdtemp+rm；探针流程经桥接 API 清理
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pw from '../mcp/node_modules/playwright/index.js';
const { chromium } = pw;

const ROOT = 'D:/work/MCP/web-rpa-mcp/';
const DEAD = 'http://127.0.0.1:8399';
const LIVE_PORT = 8323;
const LIVE = 'http://127.0.0.1:' + LIVE_PORT;
const EXT = ROOT + 'extension/';
let pass = 0, fail = 0;
const failures = [];
function ok(name) { pass++; console.log('  ok   ' + name); }
function bad(name, e) { fail++; failures.push(name + ' -> ' + (e && e.message ? e : e)); console.log('  FAIL ' + name + '\n       ' + (e && e.message ? e : e)); }
async function T(name, fn) { try { await fn(); ok(name); } catch (e) { bad(name, e); } }

const api2 = (bridge, name, args) => fetch(bridge + '/api/call', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, args: args || {} }) }).then((r) => r.json());
const shadow = (page, expr) => page.evaluate(new Function('return ' + expr));

let bridge = null, ctx = null, stub = null, userDataDir = null;
let LOCAL_ACTUAL_ID = null; // P2 从 popup 上下文（有 chrome.storage）捕获真实自增 id
try {
  /* ---- stub 站（v1.21 扩：hover 揭层 + Enter 提交 + 同源跨页 /page2）---- */
  const http = await import('node:http');
  stub = await new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      const u = new URL(req.url, 'http://x');
      if (u.pathname === '/page2') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<!doctype html><html><head><meta charset="utf-8"><title>page2</title></head><body><h1>page2</h1>' +
          '<input id="num2" data-testid="num2">' +
          '<button id="go2b" data-testid="go2b" onclick="document.getElementById(\'out2\').textContent=\'OK2\'">执行2</button><div id="out2"></div>' +
          '</body></html>');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><html><head><meta charset="utf-8"><title>standalone页</title></head><body>' +
        '<h1>standalone页</h1><input id="num" data-testid="num" value="">' +
        '<button id="go" data-testid="go" onclick="document.getElementById(\'out\').textContent=\'OK\'">执行</button><div id="out"></div>' +
        '<div id="menu" onmouseover="document.getElementById(\'menu-item\').style.display=\'block\'" style="display:inline-block;padding:4px;border:1px solid #999">菜单</div>' +
        '<div id="menu-item" style="display:none">揭层内容</div>' +
        '<input id="name" data-testid="name"><script>document.getElementById("name").addEventListener("keydown",function(e){if(e.key==="Enter"){document.getElementById("out").textContent="ENTER";}});</script>' +
        '<a id="go2" data-testid="go2" href="/page2">去第二页</a>' +
        '</body></html>');
    });
    s.listen(0, '127.0.0.1', () => resolve({ server: s, url: 'http://127.0.0.1:' + s.address().port }));
  });
  console.log('stub ' + stub.url);

  /* ---- 扩展浏览器：初始桥接=死端口（模拟未插桥接）---- */
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rpa-std-'));
  async function launch(headless) {
    const c = await chromium.launchPersistentContext(userDataDir, {
      channel: 'chromium', headless,
      args: ['--disable-extensions-except=' + EXT, '--load-extension=' + EXT, '--no-first-run'],
      viewport: { width: 1100, height: 760 },
    });
    let sw = c.serviceWorkers()[0];
    if (!sw) { try { sw = await c.waitForEvent('serviceworker', { timeout: headless ? 12000 : 20000 }); } catch (e) { await c.close(); return null; } }
    return c;
  }
  ctx = await launch(true);
  if (!ctx) { console.log('headless SW 未启动，回退有头'); ctx = await launch(false); }
  if (!ctx) throw new Error('扩展 SW 未启动');
  const extId = new URL(ctx.serviceWorkers()[0].url()).hostname;
  {
    const p0 = await ctx.newPage();
    await p0.goto('chrome-extension://' + extId + '/popup.html');
    await p0.evaluate((b) => chrome.storage.local.set({ bridgeUrl: b }), DEAD);
    await p0.close();
  }
  console.log('extension ' + extId + '，初始桥接=' + DEAD + '（死端口）');

  const page = await ctx.newPage();
  page.on('dialog', (d) => d.accept().catch(() => {}));

  /* ---- Part1 独立模式：悬浮球 ---- */
  await T('P1-1 悬浮球注入 + 模式徽章=独立模式', async () => {
    await page.goto(stub.url + '/');
    await page.waitForSelector('#__rpa-ball-host', { state: 'attached', timeout: 15000 });
    await page.click('#__rpa-ball-host .ball');
    await page.waitForFunction(() => {
      const r = document.getElementById('__rpa-ball-host').shadowRoot;
      const chip = r.querySelector('.mode-chip');
      return chip && chip.textContent.indexOf('独立模式') >= 0;
    }, undefined, { timeout: 15000 });
  });
  await T('P1-2 本地录制：🎬 → 页面真实操作 → ⏹ 保存', async () => {
    // 竞态：徽章先于本地区块（异步 listLocal 回调）渲染——先等按钮存在再原子点击
    await page.waitForFunction(() => {
      const r = document.getElementById('__rpa-ball-host').shadowRoot;
      return [...r.querySelectorAll('button.act')].some((b) => b.textContent.indexOf('本地录制当前页') >= 0);
    }, undefined, { timeout: 15000 });
    await page.evaluate(() => {
      const r = document.getElementById('__rpa-ball-host').shadowRoot;
      const b = [...r.querySelectorAll('button.act')].find((x) => x.textContent.indexOf('本地录制当前页') >= 0);
      if (!b) throw new Error('no local record button');
      b.click();
    });
    await page.waitForFunction(() => {
      const m = document.getElementById('__rpa-ball-host').shadowRoot.querySelector('.msg').textContent;
      return m.indexOf('独立录制中') >= 0;
    }, undefined, { timeout: 8000 });
    // 页面真实操作（录制器 capture 阶段监听）
    await page.fill('#num', '888');
    await page.click('#go');
    await page.waitForTimeout(400);
    await page.waitForFunction(() => {
      const r = document.getElementById('__rpa-ball-host').shadowRoot;
      return [...r.querySelectorAll('button.act')].some((b) => b.textContent.indexOf('保存到本地') >= 0);
    }, undefined, { timeout: 10000 });
    await page.evaluate(() => {
      const r = document.getElementById('__rpa-ball-host').shadowRoot;
      const b = [...r.querySelectorAll('button.act')].find((x) => x.textContent.indexOf('保存到本地') >= 0);
      if (!b) throw new Error('no save button');
      b.click();
    });
    await page.waitForFunction(() => {
      const m = document.getElementById('__rpa-ball-host').shadowRoot.querySelector('.msg').textContent;
      return m.indexOf('已保存到本地') >= 0 || m.indexOf('❌') >= 0;
    }, undefined, { timeout: 10000 });
    const m = await shadow(page, 'document.getElementById("__rpa-ball-host").shadowRoot.querySelector(".msg").textContent');
    if (m.indexOf('已保存到本地') < 0) throw new Error(m.slice(0, 100));
    // DOM 真值核对（main world 无 chrome.storage；P1-3 的回放成功即存储持久化的终证）
    const sect = await shadow(page, 'document.getElementById("__rpa-ball-host").shadowRoot.querySelector(".locsect").textContent');
    if (sect.indexOf('1 条') < 0 && !/ [1-9]\d* 条/.test(sect)) throw new Error('本地区块计数异常: ' + sect.slice(0, 80));
  });
  await T('P1-3 本地回放：清空 out → ▶ → out=OK', async () => {
    await page.evaluate(() => { document.getElementById('out').textContent = ''; document.getElementById('num').value = ''; });
    await page.waitForFunction(() => {
      const r = document.getElementById('__rpa-ball-host').shadowRoot;
      return [...r.querySelectorAll('.locsect .frow')].some((x) => x.textContent.indexOf('步 · 本地') >= 0);
    }, undefined, { timeout: 15000 });
    await page.evaluate(() => {
      const r = document.getElementById('__rpa-ball-host').shadowRoot;
      const row = [...r.querySelectorAll('.locsect .frow')].find((x) => x.textContent.indexOf('步 · 本地') >= 0);
      if (!row) throw new Error('本地流程行不存在');
      row.querySelectorAll('button')[0].click(); // ▶
    });
    await page.waitForFunction(() => {
      const m = document.getElementById('__rpa-ball-host').shadowRoot.querySelector('.msg').textContent;
      return m.indexOf('独立回放完成') >= 0 || m.indexOf('❌') >= 0;
    }, undefined, { timeout: 15000 });
    const m = await shadow(page, 'document.getElementById("__rpa-ball-host").shadowRoot.querySelector(".msg").textContent');
    if (m.indexOf('独立回放完成') < 0) throw new Error(m.slice(0, 120));
    const out = await page.evaluate(() => document.getElementById('out').textContent);
    if (out !== 'OK') throw new Error('回放后 out=' + JSON.stringify(out));
  });

  /* ---- Part2 popup 独立 UI ---- */
  const popup = await ctx.newPage();
  popup.on('dialog', (d) => d.accept().catch(() => {})); // popup 内 window.confirm 也要接
  await popup.goto('chrome-extension://' + extId + '/popup.html');
  await T('P2-1 状态页模式横幅=独立模式', async () => {
    await popup.waitForFunction(() => {
      const b = document.getElementById('mode-body');
      return b && b.textContent.indexOf('独立模式') >= 0;
    }, undefined, { timeout: 10000 });
  });
  await T('P2-2 流程页本地列表显示 + 导出下载 + 捕获真实 id', async () => {
    await popup.locator('#tabs button[data-tab="flows"]').click();
    await popup.waitForFunction(() => {
      const b = document.getElementById('local-flows-body');
      return b && b.textContent.indexOf('本地-') >= 0;
    }, undefined, { timeout: 10000 });
    LOCAL_ACTUAL_ID = await popup.evaluate(() => new Promise((res) => {
      chrome.storage.local.get('rpaLocalFlows', (st) => res(((st.rpaLocalFlows || [])[0] || {}).id || null));
    }));
    if (!LOCAL_ACTUAL_ID) throw new Error('捕获本地流程 id 失败');
    console.log('       本地流程 id=' + LOCAL_ACTUAL_ID);
    const dl = popup.waitForEvent('download', { timeout: 10000 });
    await popup.evaluate(() => {
      const rows = [...document.querySelectorAll('.local-flow-row')];
      rows[0].querySelectorAll('button')[1].click(); // 导出
    });
    const d = await dl;
    const p = await d.path();
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (!j.steps || j.steps.length < 2) throw new Error('导出 JSON 形状不对: ' + JSON.stringify(j).slice(0, 120));
  });

  /* ---- Part3 插入桥接（8323）：依赖模式 + 升级到 MCP ---- */
  bridge = spawn('node', [ROOT + 'mcp/bridge.mjs', String(LIVE_PORT)], { cwd: ROOT, stdio: 'ignore' });
  {
    let ready = false;
    for (let i = 0; i < 40 && !ready; i++) { await new Promise((r) => setTimeout(r, 500)); try { ready = (await fetch(LIVE + '/health')).ok; } catch { /* retry */ } }
    if (!ready) throw new Error('bridge 8323 未就绪');
  }
  await T('P3-1 插桥后横幅切「依赖 MCP 模式」', async () => {
    await popup.evaluate((b) => chrome.storage.local.set({ bridgeUrl: b }), LIVE);
    await popup.reload();
    await popup.waitForFunction(() => {
      const b = document.getElementById('mode-body');
      return b && b.textContent.indexOf('依赖 MCP') >= 0;
    }, undefined, { timeout: 10000 });
  });
  await T('P3-2 「升级到 MCP」：flow_import 成功且映射 goto 起手', async () => {
    await popup.locator('#tabs button[data-tab="flows"]').click();
    await popup.waitForSelector('.local-flow-row', { timeout: 10000 });
    await popup.evaluate(() => {
      const rows = [...document.querySelectorAll('.local-flow-row')];
      const up = [...rows[0].querySelectorAll('button')].find((b) => b.textContent.indexOf('升级到 MCP') >= 0);
      up.click();
    });
    await popup.waitForFunction(() => {
      const t = document.getElementById('toast');
      return t && !t.classList.contains('hide') && (t.textContent.indexOf('已升级到 MCP') >= 0 || t.textContent.indexOf('❌') >= 0);
    }, undefined, { timeout: 15000 });
    const t = await popup.evaluate(() => document.getElementById('toast').textContent);
    if (t.indexOf('已升级到 MCP') < 0) throw new Error('toast: ' + t.slice(0, 120));
    const fl = await api2(LIVE, 'flow_list');
    const f = ((fl.data && fl.data.flows) || []).find((x) => x.id === LOCAL_ACTUAL_ID);
    if (!f) throw new Error('桥接侧找不到升级后的流程 ' + LOCAL_ACTUAL_ID + '；现有: ' + ((fl.data && fl.data.flows) || []).map((x) => x.id).join(','));
    const sh = await api2(LIVE, 'flow_show', { flowId: LOCAL_ACTUAL_ID, format: 'json' });
    const steps = (sh.data && sh.data.steps) || [];
    if (!steps.length || steps[0].op !== 'goto') throw new Error('映射首步应为 goto: ' + JSON.stringify(steps[0] || null));
    const clickStep = steps.find((s) => s.op === 'click');
    if (!clickStep || !clickStep.locators || !clickStep.locators.length) throw new Error('click 步缺 locators');
  });

  /* ---- Part4 拔出桥接：回落独立 + 本地仍在 ---- */
  await T('P4-1 拔桥后横幅回落「独立模式」且本地流程仍在', async () => {
    bridge.kill(); bridge = null;
    await new Promise((r) => setTimeout(r, 800));
    await popup.evaluate((b) => chrome.storage.local.set({ bridgeUrl: b }), DEAD);
    await popup.reload();
    await popup.waitForFunction(() => {
      const b = document.getElementById('mode-body');
      return b && b.textContent.indexOf('独立模式') >= 0;
    }, undefined, { timeout: 10000 });
    await popup.locator('#tabs button[data-tab="flows"]').click();
    await popup.waitForFunction(() => {
      const b = document.getElementById('local-flows-body');
      return b && b.textContent.indexOf('本地-') >= 0;
    }, undefined, { timeout: 10000 });
  });

  /* ---- Part5 popup→content：回放到当前标签 ---- */
  await T('P5-1 「▶ 回放到当前标签」跨页通道', async () => {
    // 注意：popup 前台会让 tabs.query(active,currentWindow) 返回 popup 自己——保持 stub 页为活动标签
    await page.bringToFront();
    await page.evaluate(() => { document.getElementById('out').textContent = ''; });
    await new Promise((r) => setTimeout(r, 300));
    await popup.evaluate(() => {
      document.querySelector('#tabs button[data-tab="flows"]').click();
    });
    await popup.waitForSelector('.local-flow-row', { timeout: 10000 });
    await popup.evaluate(() => {
      const rows = [...document.querySelectorAll('.local-flow-row')];
      rows[0].querySelectorAll('button')[0].click(); // ▶ 回放到当前标签
    });
    await page.waitForFunction(() => document.getElementById('out').textContent === 'OK', undefined, { timeout: 15000 });
    await popup.waitForFunction(() => {
      const t = document.getElementById('toast');
      return t && !t.classList.contains('hide') && t.textContent.indexOf('独立回放完成') >= 0;
    }, undefined, { timeout: 10000 });
  });

  /* ---- Part6 删除本地流程（弹窗确认）---- */
  await T('P6-1 popup 🗑 删除本地流程', async () => {
    await popup.locator('#tabs button[data-tab="flows"]').click();
    await popup.waitForSelector('.local-flow-row', { timeout: 10000 });
    await popup.evaluate(() => {
      const rows = [...document.querySelectorAll('.local-flow-row')];
      rows[0].querySelectorAll('button')[3].click(); // 🗑
    });
    await popup.waitForFunction(() => {
      const b = document.getElementById('local-flows-body');
      return b && b.textContent.indexOf('还没有本地流程') >= 0;
    }, undefined, { timeout: 10000 });
    // 存储核对必须在扩展页上下文（main world 无 chrome.storage——本脚本两次踩坑定案）
    const flows = await popup.evaluate(() => new Promise((res) => chrome.storage.local.get('rpaLocalFlows', (st) => res(st.rpaLocalFlows || []))));
    if (flows.length) throw new Error('存储未清空');
  });

  /* ---- P7 hover/press 步骤（v1.21）---- */
  await T('P7-1 本地录制 hover+fill+Enter → 保存', async () => {
    await page.goto(stub.url + '/');
    await page.waitForSelector('#__rpa-ball-host', { state: 'attached', timeout: 15000 });
    await page.click('#__rpa-ball-host .ball');
    await page.waitForFunction(() => { const r = document.getElementById('__rpa-ball-host').shadowRoot; return [...r.querySelectorAll('button.act')].some((b) => b.textContent.indexOf('本地录制当前页') >= 0); }, undefined, { timeout: 15000 });
    await page.evaluate(() => { const r = document.getElementById('__rpa-ball-host').shadowRoot; [...r.querySelectorAll('button.act')].find((b) => b.textContent.indexOf('本地录制当前页') >= 0).click(); });
    await page.waitForTimeout(300);
    await page.hover('#menu'); // mouseover → hover 步
    await page.fill('#name', 'x1');
    await page.press('#name', 'Enter'); // keydown Enter → press 步
    await page.waitForTimeout(300);
    await page.evaluate(() => { const r = document.getElementById('__rpa-ball-host').shadowRoot; [...r.querySelectorAll('button.act')].find((b) => b.textContent.indexOf('保存到本地') >= 0).click(); });
    await page.waitForFunction(() => { const m = document.getElementById('__rpa-ball-host').shadowRoot.querySelector('.msg').textContent; return m.indexOf('已保存到本地') >= 0; }, undefined, { timeout: 10000 });
    const flows = await popup.evaluate(() => new Promise((res) => chrome.storage.local.get('rpaLocalFlows', (st) => res(st.rpaLocalFlows || []))));
    const ops = (flows[0].steps || []).map((s) => s.op);
    if (ops.indexOf('hover') < 0) throw new Error('缺 hover 步: ' + ops.join(','));
    if (ops.indexOf('press') < 0) throw new Error('缺 press 步: ' + ops.join(','));
    console.log('       P7 步骤: ' + ops.join(','));
  });
  await T('P7-2 回放 hover+press 生效', async () => {
    await page.evaluate(() => { document.getElementById('out').textContent = ''; document.getElementById('menu-item').style.display = 'none'; });
    // 竞态守卫：保存触发的本地区块异步重渲染未完成时行不存在（间歇性失败根因）
    await page.waitForFunction(() => { const r = document.getElementById('__rpa-ball-host').shadowRoot; return r && [...r.querySelectorAll('.locsect .frow')].some((x) => x.textContent.indexOf('步 · 本地') >= 0); }, undefined, { timeout: 10000 });
    await page.evaluate(() => { const r = document.getElementById('__rpa-ball-host').shadowRoot; const row = [...r.querySelectorAll('.locsect .frow')].find((x) => x.textContent.indexOf('步 · 本地') >= 0); row.querySelectorAll('button')[0].click(); });
    await page.waitForFunction(() => { const m = document.getElementById('__rpa-ball-host').shadowRoot.querySelector('.msg').textContent; return m.indexOf('独立回放完成') >= 0 || m.indexOf('❌') >= 0; }, undefined, { timeout: 15000 });
    const m = await page.evaluate(() => document.getElementById('__rpa-ball-host').shadowRoot.querySelector('.msg').textContent);
    if (m.indexOf('独立回放完成') < 0) throw new Error(m.slice(0, 120));
    const st2 = await page.evaluate(() => ({ menu: document.getElementById('menu-item').style.display, out: document.getElementById('out').textContent }));
    if (st2.menu !== 'block') throw new Error('hover 未揭层: ' + st2.menu);
    if (st2.out !== 'ENTER') throw new Error('press 未生效: ' + st2.out);
  });

  /* ---- P8 同源跨页 goto 续播（v1.21）---- */
  await T('P8 goto 跨页 → sessionStorage 续播完成', async () => {
    // 直接经扩展页构造含 goto 的本地流程（录制侧跨页会断流，goto 步由链接点击识别而来）
    const page2Url = stub.url + '/page2';
    await popup.evaluate((u2) => new Promise((res) => {
      const flow = { id: 'local-crosspage', name: '跨页探针', startUrl: u2, steps: [
        { op: 'goto', url: u2 },
        { op: 'fill', locator: { strategy: 'testid', value: 'num2' }, value: '555' },
        { op: 'click', locator: { strategy: 'testid', value: 'go2b' } },
      ] };
      chrome.storage.local.get('rpaLocalFlows', (st) => { const arr = st.rpaLocalFlows || []; arr.unshift(flow); chrome.storage.local.set({ rpaLocalFlows: arr }, () => res(true)); });
    }), page2Url);
    await page.goto(stub.url + '/');
    await page.waitForSelector('#__rpa-ball-host', { state: 'attached', timeout: 15000 });
    await page.click('#__rpa-ball-host .ball');
    await page.waitForFunction(() => { const r = document.getElementById('__rpa-ball-host').shadowRoot; return [...r.querySelectorAll('.locsect .frow')].some((x) => x.textContent.indexOf('跨页探针') >= 0); }, undefined, { timeout: 15000 });
    await page.evaluate(() => { const r = document.getElementById('__rpa-ball-host').shadowRoot; const row = [...r.querySelectorAll('.locsect .frow')].find((x) => x.textContent.indexOf('跨页探针') >= 0); row.querySelectorAll('button')[0].click(); });
    // goto 导航到 page2 → content 重注入 → maybeResume 接续 fill+click → out2=OK2
    await page.waitForFunction(() => document.getElementById('out2') && document.getElementById('out2').textContent === 'OK2', undefined, { timeout: 20000 });
    const num2 = await page.evaluate(() => document.getElementById('num2').value);
    if (num2 !== '555') throw new Error('续播 fill 未生效: ' + num2);
    await page.waitForFunction(() => { const r = document.getElementById('__rpa-ball-host').shadowRoot; return r && r.querySelector('.msg') && r.querySelector('.msg').textContent.indexOf('跨页续播完成') >= 0; }, undefined, { timeout: 15000 });
  });

  /* ---- P9 本地流程导入（v1.21）---- */
  await T('P9 popup 导入按钮（filechooser→本地格式）', async () => {
    const tmp = path.join(os.tmpdir(), 'rpa-import-' + Date.now() + '.json');
    fs.writeFileSync(tmp, JSON.stringify({ id: 'local-x', name: '导入探针', startUrl: stub.url + '/', steps: [{ op: 'click', locator: { strategy: 'testid', value: 'go' } }] }));
    await popup.evaluate(() => { document.querySelector('#tabs button[data-tab="flows"]').click(); });
    await popup.waitForSelector('#btn-local-import', { state: 'visible', timeout: 10000 });
    const [fc] = await Promise.all([popup.waitForEvent('filechooser', { timeout: 10000 }), popup.locator('#btn-local-import').click()]);
    await fc.setFiles(tmp);
    await popup.waitForFunction(() => { const b = document.getElementById('local-flows-body'); return b && b.textContent.indexOf('导入探针') >= 0; }, undefined, { timeout: 10000 });
    fs.rmSync(tmp, { force: true });
    // 清理导入的流程
    await popup.evaluate(() => new Promise((res) => chrome.storage.local.get('rpaLocalFlows', (st) => { const next = (st.rpaLocalFlows || []).filter((f) => f.name !== '导入探针'); chrome.storage.local.set({ rpaLocalFlows: next }, () => res(true)); })));
  });

  /* ---- P10 真实站点观察：demo 登录表单 POST 跨页流（v1.21.1 submit 续播）---- */
  await T('P10 demo 表单提交跨页：fill×2+submit→POST→/report 续播收尾', async () => {
    const demo = await (await import('../demo/app.mjs')).startDemoServer(0); // 随机端口防冲突
    try {
      const loginUrl = demo.url + '/login';
      await popup.evaluate((u) => new Promise((res) => {
        const flow = { id: 'local-formflow', name: 'demo登录表单流', startUrl: u, steps: [
          { op: 'fill', locator: { strategy: 'testid', value: 'empNo' }, value: '1001' },
          { op: 'fill', locator: { strategy: 'css', value: '#pwd' }, value: 'DemoPass123' }, // demo 的 pwd 只有 id 无 data-testid（真实标记核对）
          { op: 'click', locator: { strategy: 'testid', value: 'loginBtn' } },
        ] };
        chrome.storage.local.get('rpaLocalFlows', (st) => { const arr = (st.rpaLocalFlows || []).filter((f) => f.id !== 'local-formflow'); arr.unshift(flow); chrome.storage.local.set({ rpaLocalFlows: arr }, () => res(true)); });
      }), loginUrl);
      await page.goto(loginUrl);
      await page.waitForSelector('#__rpa-ball-host', { state: 'attached', timeout: 15000 });
      await page.click('#__rpa-ball-host .ball');
      await page.waitForFunction(() => { const r = document.getElementById('__rpa-ball-host').shadowRoot; return [...r.querySelectorAll('.locsect .frow')].some((x) => x.textContent.indexOf('demo登录表单流') >= 0); }, undefined, { timeout: 15000 });
      await page.evaluate(() => { const r = document.getElementById('__rpa-ball-host').shadowRoot; const row = [...r.querySelectorAll('.locsect .frow')].find((x) => x.textContent.indexOf('demo登录表单流') >= 0); row.querySelectorAll('button')[0].click(); });
      // fill×2 + submit 点击 → POST /login → 302 /report（带 cookie 鉴权）→ 新页续播收尾
      await page.waitForFunction(() => location.pathname === '/report', undefined, { timeout: 20000 });
      await page.waitForFunction(() => document.title.indexOf('订单日报') >= 0, undefined, { timeout: 15000 });
      const st2 = await page.evaluate(() => ({ rows: document.querySelectorAll('#tbl tbody tr').length, emp: null }));
      if (!st2.rows) throw new Error('报表页无数据行（登录未成功）');
      // 续播令牌应已被 maybeResume 消费（不存在）
      const token = await page.evaluate(() => sessionStorage.getItem('rpaStandaloneResume'));
      if (token) throw new Error('续播令牌未消费: ' + token.slice(0, 80));
      console.log('       P10 终态: ' + locationSafe(await page.url()) + ' 行数=' + st2.rows);
    } finally { try { demo.server.close(); } catch { /* ignore */ } }
  });
  function locationSafe(u) { return String(u).slice(0, 60); }
} catch (e) {
  fail++; failures.push('setup -> ' + (e && e.message ? e : e));
  console.log('  FAIL setup: ' + (e && e.message ? e : e));
} finally {
  /* ---- 自密封清理（逐项 try/catch）---- */
  try { if (bridge) bridge.kill(); } catch { /* ignore */ }
  try { if (bridge) { /* 再确认端口释放 */ } } catch { /* ignore */ }
  try {
    if (bridge !== null || true) {
      // 升级到 MCP 的探针流程清理：起临时桥接杀之前先试；若桥接已 kill 则跳过（探针流程 id 无害且门禁排除 local- 前缀外的 t- 残件——用 API 清）
      const b2 = spawn('node', [ROOT + 'mcp/bridge.mjs', String(LIVE_PORT)], { cwd: ROOT, stdio: 'ignore' });
      let ready = false;
      for (let i = 0; i < 20 && !ready; i++) { await new Promise((r) => setTimeout(r, 400)); try { ready = (await fetch(LIVE + '/health')).ok; } catch { /* retry */ } }
      if (ready) {
        try {
          if (LOCAL_ACTUAL_ID) { await api2(LIVE, 'flow_delete', { flowId: LOCAL_ACTUAL_ID }); console.log('清理: 升级探针流程 ' + LOCAL_ACTUAL_ID); }
          const fl = await api2(LIVE, 'flow_list');
          for (const x of ((fl.data && fl.data.flows) || [])) {
            if (/^local-/.test(x.id)) { await api2(LIVE, 'flow_delete', { flowId: x.id }); console.log('清理: 残留 local 流程 ' + x.id); }
          }
        } catch (e) { console.log('清理升级流程失败: ' + e.message); }
      }
      try { b2.kill(); } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
  try { if (ctx) await ctx.close(); } catch { /* ignore */ }
  try { if (stub && stub.server) stub.server.close(); } catch { /* ignore */ }
  try { if (userDataDir) fs.rmSync(userDataDir, { recursive: true, force: true }); } catch { /* ignore */ }
}
console.log('\nstandalone 验证: ' + pass + ' 过 / ' + fail + ' 败');
if (failures.length) console.log('失败项:\n' + failures.join('\n'));
process.exit(fail ? 1 : 0);
