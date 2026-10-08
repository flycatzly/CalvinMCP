// verify/ui-ext.mjs — 浏览器插件控制台 UI 全链路回归（可重复资产，与 live-fulltest 同级的实测资产）。
// 用法：node verify/ui-ext.mjs            （完整回归，约 3-4 分钟，需桥接 8317 运行中）
//       node verify/ui-ext.mjs --quick    （跳过长流程 live 进度用例，约 2 分钟）
// 覆盖（历轮真机验证精华合集）：
//   Part A /console@8317（无扩展纯浏览器）：web 布局+缩放 / 状态页运行中区块 / 录制页冲突只观察 /
//     流程页只读 / 编辑器闭环（探针上移改删+变量断言）/ 定时与 secret 往返 / 控制台调用 / 设置往返
//   Part B 扩展@8318 隔离实例：注入 / 面板连接 / 👁查看步骤 / ⚙重命名+删除 / ✂重录表单默认值 /
//     🎬录制→生成→🔁重播 / 右键菜单3项+Esc / 拖拽位置 / 🙈隐藏不复活 / （--quick 跳过）live 进度长流程
// 自密封：探针与生成流程收尾全清；隔离桥接 spawn/kill；storage 恢复 8317（或确认 userDataDir 即删）。
// 纪律：Shadow DOM 选元素走 shadowRoot（Playwright CSS 选择器除外）；长流程等待只认目标不认兜底文案。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const EXT = path.join(ROOT, 'extension');
const PW_URL = pathToFileURL(path.join(ROOT, 'mcp', 'node_modules', 'playwright', 'index.mjs')).href;
const B1 = 'http://127.0.0.1:8317';
const QUICK = process.argv.includes('--quick');

let pass = 0, fail = 0;
const failures = [];
function ok(n) { pass++; console.log('  ok   ' + n); }
function bad(n, e) { fail++; failures.push(n); console.log('  FAIL ' + n + ' -> ' + (e && e.message ? e.message : e)); }
async function T(n, fn) { try { await fn(); ok(n); } catch (e) { bad(n, e); } }

const api1 = async (n, a) => {
  const r = await fetch('http://127.0.0.1:8317' + '/api/call', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: n, args: a || {} }) });
  const j = await r.json();
  if (!j.ok) throw new Error(j.summary || 'call 失败');
  return j;
};

const { chromium } = await import(PW_URL);

/* 8317 桥接前置自检（环境事件教训：缺桥接=ERR_CONNECTION_REFUSED 堆栈 ≠ 回归失败）：
 * 有主桥接直接用；没有则自起临时桥接并在退出时 kill（自密封） */
let ownedBridge = null;
async function ensureBridge8317() {
  try { const r = await fetch(B1 + '/health', { signal: AbortSignal.timeout(2000) }); if (r.ok) { console.log('（使用既有 8317 桥接）'); return; } } catch { /* down */ }
  console.log('8317 桥接未启动——自起临时桥接…');
  ownedBridge = spawn('node', [path.join(ROOT, 'mcp', 'bridge.mjs'), '8317'], { cwd: ROOT, stdio: 'ignore' });
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 500));
    try { const r2 = await fetch(B1 + '/health'); if (r2.ok) { console.log('临时桥接就绪'); return; } } catch { /* retry */ }
  }
  throw new Error('临时桥接启动失败（8317）');
}
process.on('exit', () => { if (ownedBridge) { try { ownedBridge.kill(); } catch { /* ignore */ } } });
/* 收尾自清（微观察轮定案）：Part B 重播产生的「悬浮-」「ui-ext-」前缀 runs 目录是 flow_delete 清不到的孤儿——
 * exit 钩子同步删（只删本脚本族前缀，绝不碰用户 runs） */
process.on('exit', () => {
  try {
    const runsDir = path.join(ROOT, 'runs');
    for (const name of fs.readdirSync(runsDir)) {
      if (/^(悬浮-|ui-ext-)/.test(name)) { try { fs.rmSync(path.join(runsDir, name), { recursive: true, force: true }); } catch { /* ignore */ } }
    }
  } catch { /* ignore */ }
});
await ensureBridge8317();

/* ============ Part A: /console@8317（无扩展） ============ */
console.log('—— Part A: /console 全页签（8317） ——');
{
  const browser = await chromium.launch({ channel: 'chromium', headless: true });
  const page = await browser.newPage();
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.goto(B1 + '/console');
  await page.waitForFunction(() => {
    const t = document.getElementById('conn-text').textContent;
    return t.indexOf('已连接') >= 0 || t.indexOf('未连接') >= 0;
  }, undefined, { timeout: 15000 });
  const ev = (fn, arg) => page.evaluate(fn, arg);

  await T('web 布局 + 缩放 110%', async () => {
    const s = await ev(() => {
      const z = document.getElementById('zoom-slider');
      z.value = '110'; z.dispatchEvent(new Event('input'));
      return { web: document.body.classList.contains('web'), zoom: document.body.style.zoom };
    });
    if (!s.web || s.zoom !== '1.1') throw new Error(JSON.stringify(s));
  });

  await T('状态页：运行中区块渲染（运行中或空态文案）', async () => {
    await ev(() => document.querySelector('#tabs button[data-tab="status"]').click());
    await page.waitForFunction(() => {
      const b = document.getElementById('running-body');
      return b && b.textContent.length > 5;
    }, undefined, { timeout: 15000 });
    const t = await ev(() => document.getElementById('running-body').textContent);
    if (!t.includes('运行中') && !t.includes('没有运行中')) throw new Error(t.slice(0, 60));
  });

  await T('录制页：冲突只观察或空闲态（干预卡状态正确）', async () => {
    await ev(() => document.querySelector('#tabs button[data-tab="record"]').click());
    await page.waitForTimeout(3800);
    const st = await ev(() => ({
      mode: document.getElementById('rec-mode').textContent,
      stopHidden: document.getElementById('rec-stop-card').style.display === 'none',
    }));
    const rec = await fetch('http://127.0.0.1:8317' + '/api/call', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"name":"record_status"}' }).then((r) => r.json());
    if (rec.data && rec.data.recording) {
      if (!st.mode.includes('其他会话') || !st.stopHidden) throw new Error('外部会话未走只观察: ' + JSON.stringify(st));
    } else if (!st.stopHidden) {
      throw new Error('空闲时干预卡应隐藏');
    }
  });

  await T('编辑器闭环：探针造→上移→改 patch→变量断言→清理', async () => {
    await ev(async () => {
      await fetch('http://127.0.0.1:8317' + '/api/call', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'flow_import', args: { overwrite: true, flow: {
          id: 'ui-ext-probe', name: 'ui-ext-probe', startUrl: 'http://example.test/',
          steps: [{ op: 'goto', url: 'http://example.test/' }, { op: 'sleep', ms: 500 }, { op: 'sleep', ms: 300 }],
          assertions: [{ kind: 'title', equals: 'x', message: 'm' }],
        } } }) });
      document.querySelector('#tabs button[data-tab="flows"]').click();
    });
    await page.waitForTimeout(1000);
    await ev(() => {
      const card = document.querySelector('.flow-card[data-flow="ui-ext-probe"]');
      card.open = true;
      card.querySelector('.act-edit').click();
    });
    await page.waitForFunction(() => {
      const a = document.querySelector('.flow-card[data-flow="ui-ext-probe"] .edit-area');
      return a && a.querySelectorAll('.sub-step .erow').length === 3;
    }, undefined, { timeout: 10000 });
    await ev(() => [...document.querySelectorAll('.flow-card[data-flow="ui-ext-probe"] .sub-step .erow')][1].querySelector('.st-up').click());
    await page.waitForTimeout(900);
    await ev(() => {
      const card = document.querySelector('.flow-card[data-flow="ui-ext-probe"]');
      card.querySelector('.sub-step .st-edit').click();
      const ta = card.querySelector('.estep-edit:not(.hide) textarea');
      const o = JSON.parse(ta.value); o.ms = 777; ta.value = JSON.stringify(o);
      card.querySelector('.st-save').click();
    });
    await page.waitForTimeout(900);
    const rows = await ev(() => [...document.querySelectorAll('.flow-card[data-flow="ui-ext-probe"] .sub-step .erow .elabel')].map((e) => e.textContent));
    if (!rows[0].includes('777')) throw new Error('patch 未生效: ' + JSON.stringify(rows));
    await ev(() => {
      const card = document.querySelector('.flow-card[data-flow="ui-ext-probe"]');
      card.querySelector('.subtabs button[data-sub="param"]').click();
      card.querySelector('.p-name').value = 'v1'; card.querySelector('.p-default').value = 'd1';
      card.querySelector('.p-add').click();
    });
    await page.waitForTimeout(900);
    const subtabs = await ev(() => [...document.querySelectorAll('.flow-card[data-flow="ui-ext-probe"] .subtabs button')].map((b) => b.textContent));
    if (!subtabs.some((x) => x.includes('变量（1）'))) throw new Error('变量计数: ' + JSON.stringify(subtabs));
    await ev(async () => { await fetch('http://127.0.0.1:8317' + '/api/call', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"name":"flow_delete","args":{"flowId":"ui-ext-probe"}}' }); });
  });

  await T('定时 add→remove 往返', async () => {
    await ev(async () => {
      await fetch('http://127.0.0.1:8317' + '/api/call', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'schedule_add', args: { flowId: '演示-订单日报导出', frequency: 'once', date: '2026/10/09', at: '08:00' } }) });
      document.querySelector('#tabs button[data-tab="schedule"]').click();
    });
    await page.waitForTimeout(1500);
    await ev(() => {
      window.confirm = () => true;
      document.querySelector('.sched-del[data-flow="演示-订单日报导出"]').click();
    });
    await page.waitForTimeout(1500);
    const after = await ev(() => document.getElementById('sched-list').textContent.includes('演示-订单日报导出'));
    if (after) throw new Error('删除后仍在');
  });

  await T('secret set→delete 往返', async () => {
    await ev(() => {
      document.querySelector('#tabs button[data-tab="system"]').click();
      document.getElementById('sec-name').value = 'ui-ext-sec';
      document.getElementById('sec-value').value = 'v-x';
      document.getElementById('btn-secret-set').click();
    });
    await page.waitForTimeout(1000);
    await ev(() => document.getElementById('btn-secret-delete').click());
    await page.waitForTimeout(1000);
    const out = await ev(() => document.getElementById('secret-out').textContent.slice(0, 30));
    if (!out.includes('已删除') && !out.includes('已加密')) throw new Error(out);
  });

  await T('控制台页工具表 + 调用', async () => {
    await ev(() => document.querySelector('#tabs button[data-tab="console"]').click());
    await page.waitForTimeout(800);
    const n = await ev(() => document.querySelectorAll('#console-tool option').length);
    if (n < 44) throw new Error('工具表=' + n);
    await ev(() => {
      const sel = document.getElementById('console-tool');
      sel.value = 'doctor'; sel.dispatchEvent(new Event('change'));
      document.getElementById('btn-console-call').click();
    });
    await page.waitForTimeout(3000);
    const out = await ev(() => document.getElementById('console-out').textContent.length);
    if (out < 5) throw new Error('doctor 输出空');
  });

  await T('设置往返：bridgeUrl 读写', async () => {
    await ev(() => document.getElementById('btn-settings').click());
    const v1 = await ev(() => document.getElementById('bridge-url').value);
    if (!v1.includes('8317')) throw new Error(v1);
  });

  await browser.close();
}

/* ============ Part B: 扩展@8318 隔离实例 ============ */
console.log('—— Part B: 悬浮球全链路（8318 隔离） ——');
const stub = await new Promise((resolve) => {
  const s = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const auto = u.searchParams.get('auto') === '1';
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><html><head><meta charset="utf-8"><title>ui-ext页</title></head><body>' +
      '<h1>ui-ext页</h1><input id="num" data-testid="num" value="">' +
      '<button id="go" data-testid="go" onclick="document.getElementById(\'out\').textContent=\'OK\'">执行</button><div id="out"></div>' +
      (auto ? '<script>setTimeout(function(){var n=document.getElementById("num");n.value="777";' +
        'n.dispatchEvent(new Event("input",{bubbles:true}));n.dispatchEvent(new Event("change",{bubbles:true}));' +
        'document.getElementById("go").click();},1200);</script>' : '') +
      '</body></html>');
  });
  s.listen(0, '127.0.0.1', () => resolve({ server: s, url: 'http://127.0.0.1:' + s.address().port }));
});

const bridge2 = spawn(process.execPath, ['mcp/bridge.mjs', '8318'], { cwd: ROOT, stdio: 'ignore' });
process.on('exit', () => { try { bridge2.kill(); } catch (e) {} });
await new Promise((r) => setTimeout(r, 2500));
const b2h = await fetch('http://127.0.0.1:8318/health').then((r) => r.json()).catch(() => null);
if (!b2h || !b2h.ok) { console.log('8318 隔离桥接未就绪'); process.exit(3); }
const api2 = async (n, a) => {
  const r = await fetch('http://127.0.0.1:8318/api/call', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: n, args: a || {} }) });
  const j = await r.json();
  if (!j.ok) throw new Error(j.summary || 'call 失败');
  return j;
};

// 5 步探针（带 auto=1 供重录/录制演示）
await api2('flow_import', { overwrite: true, flow: {
  id: 'ui-ext-flow', name: 'ui-ext-flow', startUrl: stub.url + '/?auto=1',
  steps: [
    { op: 'goto', url: stub.url + '/?auto=1' },
    { op: 'sleep', ms: 500 }, { op: 'sleep', ms: 300 },
    { op: 'click', locators: [{ strategy: 'testid', value: 'go' }] },
    { op: 'waitForText', text: 'OK' },
  ],
  assertions: [{ kind: 'title', equals: 'ui-ext页', message: 't' }],
} });

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rpa-uixt-'));
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
let ctx = await launch(true);
if (!ctx) { console.log('headless SW 未启动，回退有头…'); ctx = await launch(false); }
if (!ctx) { console.log('SW 未启动'); process.exit(3); }
const page = await ctx.newPage();
{
  const extId = new URL(ctx.serviceWorkers()[0].url()).hostname;
  const p = await ctx.newPage();
  await p.goto('chrome-extension://' + extId + '/popup.html');
  await p.waitForFunction(() => typeof chrome !== 'undefined' && !!chrome.storage, undefined, { timeout: 5000 });
  await p.evaluate(async () => { await chrome.storage.local.set({ bridgeUrl: 'http://127.0.0.1:8318' }); });
  await p.close();
}

const shadow = (fn) => page.evaluate(() => {
  const r = document.getElementById('__rpa-ball-host').shadowRoot;
  return eval('(' + fn + ')')(r); // eslint-disable-line no-eval
});

await T('注入 + 面板连接', async () => {
  await page.goto(stub.url + '/');
  await page.waitForSelector('#__rpa-ball-host', { state: 'attached', timeout: 10000 });
  await page.click('#__rpa-ball-host .ball');
  await page.waitForFunction(() => {
    const t = document.getElementById('__rpa-ball-host').shadowRoot.querySelector('.status').textContent;
    return t.indexOf('MCP v') >= 0 || t.indexOf('桥接') >= 0;
  }, undefined, { timeout: 8000 });
  const s = await page.evaluate(() => document.getElementById('__rpa-ball-host').shadowRoot.querySelector('.status').textContent);
  if (s.indexOf('MCP v') < 0) throw new Error(s);
});

await T('👁 查看步骤（stepLabel 渲染）', async () => {
  await page.evaluate(() => {
    const r = document.getElementById('__rpa-ball-host').shadowRoot;
    const row = [...r.querySelectorAll('.frow')].find((x) => x.textContent.indexOf('ui-ext-flow') >= 0);
    row.querySelectorAll('button')[1].click();
  });
  await page.waitForFunction(() => {
    const r = document.getElementById('__rpa-ball-host').shadowRoot;
    const b = [...r.querySelectorAll('.fblock')].find((x) => x.textContent.indexOf('打开网址') >= 0);
    return b && b.textContent.indexOf('点击') >= 0 && b.textContent.indexOf('断言') >= 0;
  }, undefined, { timeout: 8000 });
});

await T('⚙ 重命名 + 删除（两击确认）', async () => {
  await page.evaluate(() => {
    const r = document.getElementById('__rpa-ball-host').shadowRoot;
    const row = [...r.querySelectorAll('.frow')].find((x) => x.textContent.indexOf('ui-ext-flow') >= 0);
    row.querySelectorAll('button')[2].click();
  });
  await page.waitForFunction(() => document.getElementById('__rpa-ball-host').shadowRoot.querySelector('.fmgr input'), undefined, { timeout: 5000 });
  await page.evaluate(() => {
    const r = document.getElementById('__rpa-ball-host').shadowRoot;
    const box = r.querySelector('.fmgr');
    box.querySelector('input').value = 'ui-ext-renamed';
    [...box.querySelectorAll('button')].find((b) => b.textContent.indexOf('保存') >= 0).click();
  });
  await page.waitForFunction(() => {
    const r = document.getElementById('__rpa-ball-host').shadowRoot;
    return [...r.querySelectorAll('.fname .n')].some((x) => x.textContent === 'ui-ext-renamed');
  }, undefined, { timeout: 8000 });
  await page.evaluate(() => {
    const r = document.getElementById('__rpa-ball-host').shadowRoot;
    const row = [...r.querySelectorAll('.frow')].find((x) => x.textContent.indexOf('ui-ext-renamed') >= 0);
    row.querySelectorAll('button')[2].click();
  });
  await page.waitForFunction(() => document.getElementById('__rpa-ball-host').shadowRoot.querySelector('.fmgr .del'), undefined, { timeout: 5000 });
  await page.evaluate(() => { document.getElementById('__rpa-ball-host').shadowRoot.querySelector('.fmgr .del').click(); });
  await page.waitForTimeout(200);
  await page.evaluate(() => { document.getElementById('__rpa-ball-host').shadowRoot.querySelector('.fmgr .del').click(); });
  await page.waitForFunction(() => {
    const r = document.getElementById('__rpa-ball-host').shadowRoot;
    return ![...r.querySelectorAll('.fname .n')].some((x) => x.textContent.indexOf('ui-ext-') >= 0);
  }, undefined, { timeout: 8000 });
});

await T('✂ 重录表单：默认值 from=1 to=5', async () => {
  await api2('flow_import', { overwrite: true, flow: {
    id: 'ui-ext-flow', name: 'ui-ext-flow', startUrl: stub.url + '/?auto=1',
    steps: [
      { op: 'goto', url: stub.url + '/?auto=1' },
      { op: 'sleep', ms: 500 }, { op: 'sleep', ms: 300 },
      { op: 'click', locators: [{ strategy: 'testid', value: 'go' }] },
      { op: 'waitForText', text: 'OK' },
    ],
    assertions: [{ kind: 'title', equals: 'ui-ext页', message: 't' }],
  } });
  await page.evaluate(() => { document.getElementById('__rpa-ball-host').shadowRoot; });
  await page.reload();
  await page.waitForSelector('#__rpa-ball-host', { state: 'attached', timeout: 10000 });
  await page.click('#__rpa-ball-host .ball');
  await page.waitForFunction(() => {
    const r = document.getElementById('__rpa-ball-host').shadowRoot;
    return [...r.querySelectorAll('.frow')].some((x) => x.textContent.indexOf('ui-ext-flow') >= 0);
  }, undefined, { timeout: 8000 });
  await page.evaluate(() => {
    const r = document.getElementById('__rpa-ball-host').shadowRoot;
    const row = [...r.querySelectorAll('.frow')].find((x) => x.textContent.indexOf('ui-ext-flow') >= 0);
    row.querySelectorAll('button')[2].click();
  });
  await page.waitForFunction(() => document.getElementById('__rpa-ball-host').shadowRoot.querySelector('.fmgr input'), undefined, { timeout: 5000 });
  await page.evaluate(() => {
    const r = document.getElementById('__rpa-ball-host').shadowRoot;
    [...r.querySelectorAll('.fmgr button')].find((b) => b.textContent.indexOf('重录片段') >= 0).click();
  });
  await page.waitForFunction(() => {
    const r = document.getElementById('__rpa-ball-host').shadowRoot;
    return r.querySelector('.fblock .fstep') && r.querySelector('.fblock .fstep').textContent.indexOf('共 5 步') >= 0;
  }, undefined, { timeout: 8000 });
  const d = await page.evaluate(() => {
    const r = document.getElementById('__rpa-ball-host').shadowRoot;
    const inputs = r.querySelectorAll('.fblock input[type=number]');
    return { from: inputs[0].value, to: inputs[1].value };
  });
  if (d.from !== '1' || d.to !== '5') throw new Error(JSON.stringify(d));
});

await T('🎬 录制 → 生成 → 🔁 重播', async () => {
  await page.goto(stub.url + '/?auto=1');
  await page.waitForSelector('#__rpa-ball-host', { state: 'attached', timeout: 10000 });
  await page.click('#__rpa-ball-host .ball');
  await page.waitForFunction(() => {
    const r = document.getElementById('__rpa-ball-host').shadowRoot;
    return [...r.querySelectorAll('button.act')].some((b) => b.textContent.indexOf('录制当前页') >= 0);
  }, undefined, { timeout: 8000 });
  await page.evaluate(() => {
    const r = document.getElementById('__rpa-ball-host').shadowRoot;
    [...r.querySelectorAll('button.act')].find((b) => b.textContent.indexOf('录制当前页') >= 0).click();
  });
  await page.waitForFunction(() => {
    const r = document.getElementById('__rpa-ball-host').shadowRoot;
    const badge = r.querySelector('.badge');
    return !badge.classList.contains('hide') && (parseInt(badge.textContent, 10) || 0) >= 2;
  }, undefined, { timeout: 40000 });
  await page.waitForTimeout(2200);
  await page.evaluate(() => {
    const r = document.getElementById('__rpa-ball-host').shadowRoot;
    [...r.querySelectorAll('button.act')].find((b) => b.textContent.indexOf('结束并保存') >= 0).click();
  });
  await page.waitForFunction(() => {
    const m = document.getElementById('__rpa-ball-host').shadowRoot.querySelector('.msg').textContent;
    return m.indexOf('技能已生成') >= 0 || m.indexOf('❌') >= 0;
  }, undefined, { timeout: 60000 });
  const m1 = await page.evaluate(() => document.getElementById('__rpa-ball-host').shadowRoot.querySelector('.msg').textContent);
  if (m1.indexOf('技能已生成') < 0) throw new Error(m1.slice(0, 80));
  await page.waitForFunction(() => {
    const r = document.getElementById('__rpa-ball-host').shadowRoot;
    return [...r.querySelectorAll('button.act')].some((b) => b.textContent.indexOf('重播刚生成的技能') >= 0);
  }, undefined, { timeout: 5000 });
  await page.evaluate(() => {
    const r = document.getElementById('__rpa-ball-host').shadowRoot;
    [...r.querySelectorAll('button.act')].find((b) => b.textContent.indexOf('重播刚生成的技能') >= 0).click();
  });
  await page.waitForFunction(() => {
    const m = document.getElementById('__rpa-ball-host').shadowRoot.querySelector('.msg').textContent;
    return m.indexOf('重播成功') >= 0 || m.indexOf('❌') >= 0;
  }, undefined, { timeout: 60000 });
  const m2 = await page.evaluate(() => document.getElementById('__rpa-ball-host').shadowRoot.querySelector('.msg').textContent);
  if (m2.indexOf('重播成功') < 0) throw new Error(m2.slice(0, 80));
});

await T('右键菜单：3 项 + Esc 收起', async () => {
  await page.evaluate(() => {
    document.querySelector('#__rpa-ball-host').shadowRoot.querySelector('.ball')
      .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  });
  await page.waitForFunction(() => {
    const m = document.getElementById('__rpa-ball-host').shadowRoot.querySelector('.ctxmenu');
    return m && !m.classList.contains('hide');
  }, undefined, { timeout: 3000 });
  const items = await page.evaluate(() =>
    [...document.getElementById('__rpa-ball-host').shadowRoot.querySelectorAll('.ctxmenu button')].map((b) => b.textContent));
  if (items.length !== 3) throw new Error(JSON.stringify(items));
  await page.evaluate(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
  const hidden = await page.evaluate(() => document.getElementById('__rpa-ball-host').shadowRoot.querySelector('.ctxmenu').classList.contains('hide'));
  if (!hidden) throw new Error('Esc 未收起');
});

await T('拖拽位置变化（Playwright 真实指针）', async () => {
  const box = await page.locator('#__rpa-ball-host .ball').boundingBox();
  if (!box) throw new Error('球不可见');
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx - 80, cy - 60, { steps: 5 });
  await page.mouse.up();
  await page.waitForTimeout(200);
  const pos2 = await page.evaluate(() => {
    const b = document.querySelector('#__rpa-ball-host').shadowRoot.querySelector('.ball');
    return { x: b.style.left, y: b.style.top };
  });
  if (pos2.x === box.x + 'px' && pos2.y === box.y + 'px') throw new Error('位置未变: ' + JSON.stringify(pos2));
});

await T('🙈 隐藏 + 刷新不复活', async () => {
  await page.evaluate(() => {
    document.getElementById('__rpa-ball-host').shadowRoot.querySelector('.foot button:nth-child(2)').click();
  });
  if (await page.$('#__rpa-ball-host')) throw new Error('未移除');
  await page.reload();
  await page.waitForTimeout(1000);
  if (await page.$('#__rpa-ball-host')) throw new Error('刷新后复活');
});

if (!QUICK) {
  await T('live 进度：长流程运行中显示 → 结束空态', async () => {
    await api2('flow_import', { overwrite: true, flow: {
      id: 'ui-ext-live', name: 'ui-ext-live', startUrl: stub.url + '/',
      steps: [{ op: 'goto', url: stub.url + '/' }, { op: 'sleep', ms: 25000 }, { op: 'sleep', ms: 20000 }],
      assertions: [{ kind: 'title', equals: 'ui-ext页', message: 't' }],
    } });
    const runPromise = api2('flow_run', { flowId: 'ui-ext-live' });
    await new Promise((r) => setTimeout(r, 6000));
    await page.goto(stub.url + '/');
    await page.evaluate(() => sessionStorage.removeItem('__rpaBallHidden')); // 🙈 用例的隐藏标记按 origin 存活，先清再验注入
    await page.reload();
    await page.waitForSelector('#__rpa-ball-host', { state: 'attached', timeout: 10000 });
    await page.click('#__rpa-ball-host .ball');
    // 只认目标流程出现，不认兜底文案（冷启动竞态教训）
    await page.waitForFunction(() => {
      const n = document.getElementById('__rpa-ball-host').shadowRoot.querySelector('.runnow');
      return n && n.textContent.includes('ui-ext-live');
    }, undefined, { timeout: 30000 });
    console.log('       运行中: ' + await page.evaluate(() => document.getElementById('__rpa-ball-host').shadowRoot.querySelector('.runnow').textContent.slice(0, 70)));
    const r = await runPromise;
    if (r.data.status !== 'pass') throw new Error('长流程 ' + r.data.status);
    await page.reload();
    await page.waitForSelector('#__rpa-ball-host', { state: 'attached', timeout: 10000 });
    await page.click('#__rpa-ball-host .ball');
    await page.waitForFunction(() => {
      const n = document.getElementById('__rpa-ball-host').shadowRoot.querySelector('.runnow');
      return n && n.textContent.includes('没有运行中');
    }, undefined, { timeout: 10000 });
    await api2('flow_delete', { flowId: 'ui-ext-live' });
  });
}

/* 收尾：先删流程后关桥接，恢复 storage（userDataDir 即删场景亦执行，双保险） */
{
  const list = await api2('flow_list');
  for (const f of (list.data.flows || [])) {
    try {
      if (String(f.id).indexOf('ui-ext') === 0 || String(f.id).indexOf('悬浮-') === 0) { await api2('flow_delete', { flowId: f.id }); }
    } catch (e) { /* 单项失败不中断清理 */ }
  }
}
{
  const extId = new URL(ctx.serviceWorkers()[0].url()).hostname;
  const p = await ctx.newPage();
  await p.goto('chrome-extension://' + extId + '/popup.html');
  await p.waitForFunction(() => typeof chrome !== 'undefined' && !!chrome.storage, undefined, { timeout: 5000 });
  await p.evaluate(async () => { await chrome.storage.local.set({ bridgeUrl: 'http://127.0.0.1:8317' }); });
  await p.close();
}
stub.server.close();
await ctx.close();
fs.rmSync(userDataDir, { recursive: true, force: true });
try { bridge2.kill(); } catch (e) { /* ignore */ }
console.log('════ ui-ext 回归: ' + pass + ' 过 / ' + fail + ' 败' + (failures.length ? ' | 失败: ' + failures.join('、') : '') + ' ════');
process.exit(fail ? 1 : 0);
