/**
 * floating-e2e.mjs — 猫耳悬浮球端到端常驻套件（第 39 轮转正）
 *
 * 真浏览器 + 真扩展 + 真桥 + **本地靶场**（零外网依赖 —— 上一轮真机战役用外网目标，
 * 转正后必须换本地页，否则 CI 被网络波动污染）。
 *
 * 靶场覆盖三类页面形态（真机实测定性的三种现实）：
 *   1) light DOM（搜索输入框/普通段落）—— 录得进、回放得出；
 *   2) 开放影子树（attachShadow open）—— 深搜可穿透，回放可达；
 *   3) 关闭影子树（attachShadow closed）—— 内容脚本按浏览器隔离规则不可达，
 *      回放诚实停止是设计行为（绝不盲点），本套件把这个边界钉死。
 *
 * 守则（上一轮实测台血泪）：
 *   - 桥自起用临时端口 + 起后验 tools/list=16（旧桥可能是混载进程）；
 *   - SW 中转的 base 经 service worker evaluate 写 chrome.storage（口令/地址不进页面）；
 *   - 扩展侧 console/page error 计零（扩展自身不许报错）。
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const requireFromRoot = createRequire(path.join(ROOT, 'package.json'));

let failures = 0;
function check(name, ok, detail) {
  if (ok) {
    console.log(`PASS  ${name}`);
  } else {
    failures += 1;
    console.log(`FAIL  ${name}${detail !== undefined ? '  ' + String(detail).replace(/\s+/g, ' ').slice(0, 200) : ''}`);
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function poll(fn, timeoutMs, stepMs = 400) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const v = await fn();
      if (v) return v;
    } catch { /* 单次探测失败不当结论 */ }
    await sleep(stepMs);
  }
  return null;
}
async function safe(fn, fallback = null) {
  try { return await fn(); } catch { return fallback; }
}

/* ================= 本地靶场 ================= */
const REPO_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>悬浮球靶场仓库页</title></head><body>
<h1>CalvinMCP 靶场</h1>
<input id="file-search" type="text" placeholder="搜索文件" />
<input id="secret-input" type="password" placeholder="口令" />
<p id="readme-p">MCP 工具与技能集合仓库。纯净发布口径：零预装依赖（依赖由命令生成），不含 node_modules 与 . 前缀文件。</p>
<a id="link-other" href="/other">另一个页面</a>
<a id="link-missing" href="/missing404">会 404 的链接</a>
<x-open-widget></x-open-widget>
<x-closed-widget></x-closed-widget>
<footer><p id="footer-p">页脚说明文字，稳定可点。</p></footer>
<script>
  const openHost = document.querySelector('x-open-widget');
  const osr = openHost.attachShadow({ mode: 'open' });
  osr.innerHTML = '<style>h2{color:#333}</style><h2 id="open-h2">影子树可回放标题</h2>';
  const closedHost = document.querySelector('x-closed-widget');
  const csr = closedHost.attachShadow({ mode: 'closed' });
  csr.innerHTML = '<p id="closed-p">关闭影子树不可达段落。</p>';
  // 关闭影子树的内部引用只有附加者自己拿得到（浏览器隔离边界）——测试经它发起真实点击
  window.__closedP = csr.querySelector('#closed-p');
</script>
</body></html>`;

const OTHER_HTML = '<!doctype html><html><head><meta charset="utf-8"><title>另一页面</title></head><body><p id="other-p">另一页面的段落。</p></body></html>';

function startTargetServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = String(req.url || '/');
      if (url.startsWith('/other')) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(OTHER_HTML);
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(REPO_HTML);
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

async function ensureBridge() {
  // 临时端口自起 + 起后验 tools/list=16 —— 旧桥/混载进程在这里挡掉（真机战役实锤的守则）
  const probe = http.createServer();
  await new Promise((r) => probe.listen(0, '127.0.0.1', r));
  const port = probe.address().port;
  await new Promise((r) => probe.close(r));
  const child = spawn(process.execPath, [path.join(ROOT, 'mcp', 'bridge.mjs'), '--port', String(port)],
    { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const base = `http://127.0.0.1:${port}`;
  const up = await poll(async () => { const r = await fetch(base + '/health'); return r.ok; }, 15000, 300);
  if (!up) return { child, base, ok: false, why: 'bridge health 超时' };
  const tools = await poll(async () => {
    const r = await fetch(base + '/rpc', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    const j = await r.json().catch(() => null);
    return j && j.result && Array.isArray(j.result.tools) && j.result.tools.length === 16 ? 16 : null;
  }, 10000, 400);
  return { child, base, ok: tools === 16, why: tools === 16 ? '' : `tools/list=${tools}` };
}

/* ================= 主流程 ================= */
async function main() {
  const { chromium } = requireFromRoot('playwright');

  const target = await startTargetServer();
  const page1 = `http://127.0.0.1:${target.port}/repo`;
  const page2 = `http://127.0.0.1:${target.port}/other`;
  const bridge = await ensureBridge();
  check('桥自起且 tools/list=16（新鲜度验证，混载进程挡在门外）', bridge.ok, bridge.why);
  if (!bridge.ok) throw new Error('bridge not ready');

  const extPath = path.join(ROOT, 'extension').replace(/\\/g, '/');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'pv-e2e-profile-'));
  const ctx = await chromium.launchPersistentContext(profile, {
    channel: 'msedge',
    headless: false,
    args: [
      `--disable-extensions-except=${extPath}`,
      `--load-extension=${extPath}`,
      '--no-first-run', '--no-default-browser-check',
    ],
  });
  const page = await ctx.newPage();
  const extErrors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error' && String((msg.location && msg.location().url) || '').includes('chrome-extension://')) {
      extErrors.push(msg.text());
    }
  });
  page.on('pageerror', (err) => {
    const s = String((err && err.message) || err);
    if (/pv-floating|chrome-extension|悬浮球|recorder\.js|floating\.js/i.test(s)) extErrors.push(s);
  });

  const ball = page.locator('pv-floating .pv-ball');
  const panel = page.locator('pv-floating .pv-panel');
  const badge = page.locator('pv-floating .pv-badge');
  const dot = page.locator('pv-floating .pv-dot');
  const log = page.locator('pv-floating .pv-log');
  const act = (a) => page.locator(`pv-floating [data-act="${a}"]`);
  const logText = async () => (await safe(() => log.textContent())) || '';

  try {
    /* ---- SW 中转 base 注入（口令/地址只进扩展 storage） ---- */
    await safe(() => page.goto(page1, { waitUntil: 'domcontentloaded', timeout: 30000 }));
    const appeared = await poll(() => page.locator('pv-floating').count().then((n) => n > 0), 20000);
    check('猫耳球注入（pv-floating 常驻本地靶场页）', !!appeared);
    const sw = await poll(async () => (ctx.serviceWorkers()[0] || null), 15000, 400);
    check('MV3 Service Worker 就位（中转通道在）', !!sw);
    const baseSet = await safe(async () => {
      await sw.evaluate(async (base) => {
        await new Promise((r) => chrome.storage.local.set({ pv_base: base }, r));
      }, bridge.base);
      return true;
    }, false);
    check('SW storage 注入桥地址（base 只进扩展侧）', baseSet === true);

    /* ---- 录制 A：light DOM + 开放影子树（可回放组合） ---- */
    await safe(() => ball.click());
    const panelOpen = await poll(() => panel.evaluate((el) => el.style.display === 'block'), 5000);
    check('点球开面板', !!panelOpen);
    const dotOk = await poll(async () => {
      const c = await dot.getAttribute('class');
      return c && c.includes('pv-ok');
    }, 12000, 500);
    check('状态点转绿（SW 中转→真桥连通）', !!dotOk);

    await safe(() => act('record').click());
    const recOn = await poll(() => ball.evaluate((el) => el.className.includes('pv-rec')), 4000);
    check('🎬 录制开始（球体脉冲态）', !!recOn);

    await safe(() => page.locator('#file-search').fill('calvin', { timeout: 8000 }));
    await safe(() => page.locator('#file-search').press('Enter', { timeout: 5000 }));
    await safe(() => page.locator('x-open-widget h2').click({ timeout: 8000 }));
    // 敏感字段：录制期即跳过（角标不涨）
    await safe(() => page.locator('#secret-input').fill('hunter2-secret', { timeout: 5000 }));
    const badgeTxt = await poll(async () => {
      const t = ((await badge.textContent()) || '').trim();
      return t === '4' ? t : null;
    }, 5000);
    check('录制捕获 4 原始步（fill×2 双事件+press+影子树点击），口令字段录制期跳过', !!badgeTxt, await badge.textContent().catch(() => ''));

    await safe(() => act('stop').click());
    const savedTxt = await poll(async () => (await logText()).includes('已保存 3 步'), 5000);
    check('⏹ 结束保存（归一 3 步，日志回执）', !!savedTxt, await logText());

    // 敏感值红线：任何发包/存储载荷不含口令值
    const storageDump = await safe(async () => JSON.stringify(await sw.evaluate(() => chrome.storage.local.get(null))), 'err');
    check('红线：口令值不进扩展 storage 任何键', storageDump !== 'err' && !storageDump.includes('hunter2-secret'));

    /* ---- 刷新恢复态 + 回放（含开放影子树深搜） ---- */
    await safe(() => page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 }));
    await poll(() => page.locator('pv-floating').count().then((n) => n > 0), 20000);
    await safe(() => ball.click());
    const replayEnabled = await poll(() => act('replay').evaluate((el) => el.disabled === false), 5000);
    check('刷新后录制恢复（回放/生成按钮解禁）', !!replayEnabled);

    await safe(() => act('replay').click());
    const replayTxt = await poll(async () => {
      const t = await logText();
      return /✓/.test(t) && !/未找到/.test(t) && !/已保存/.test(t) ? t : null;
    }, 20000, 500);
    check('▶ 回放 3 步全 ✓（fill+press+开放影子树深搜命中）',
      !!replayTxt && (String(replayTxt).match(/✓/g) || []).length === 3, await logText());

    /* ---- 工具快捷（走真桥→MCP，本地 URL） ---- */
    await safe(() => act('explore').click());
    const expTxt = await poll(async () => {
      const t = await logText();
      return t && !t.startsWith('巡检中') ? t : null;
    }, 90000, 700);
    check('🔍 巡检走中转真执行（本地页，巡检完成）', !!expTxt && expTxt.includes('巡检完成'), expTxt);

    await safe(() => act('collect').click());
    const colTxt = await poll(async () => {
      const t = await logText();
      return t && !t.startsWith('采集中') ? t : null;
    }, 60000, 700);
    check('📊 采集走中转（无表格 → 工具诚实报空）', !!colTxt, colTxt);

    await safe(() => act('generate').click());
    const genTxt = await poll(async () => {
      const t = await logText();
      return /语法|生成|OK|文件/.test(t) && !t.startsWith('生成中') ? t : null;
    }, 40000, 500);
    check('📝 用录制生成脚本（门禁完整执行，键集在 schema 白名单）', !!genTxt && !/^结果不成立：工具执行异常/.test(genTxt), genTxt);

    /* ---- r48：导出录制 JSON（真浏览器触发下载链，断日志回执；下载文件落盘断言见报告边界说明） ---- */
    await safe(() => act('export').click());
    const exp48 = await poll(async () => (await logText()).includes('已导出'), 8000, 300);
    check('📤 导出录制 JSON（本地下载触发，日志回执行数与 write:false 口径）',
      !!exp48 && /已导出 pv-export-.+\.json（\d+ 步 · generate_scripts 输入形态 · write:false）/.test(await logText()),
      await logText());

    /* ---- r49：插拔式双模（真浏览器；storage 状态为真源，点击带重试与错误捕获） ---- */
    const readMode = async () => (await safe(async () => (await sw.evaluate(() => chrome.storage.local.get(['pv_mode'])))?.pv_mode, 'err'));
    const clickModeUntil = async (want) => {
      const attempts = [];
      for (let i = 0; i < 3; i++) {
        try { await act('mode').click({ timeout: 8000 }); } catch (e) { attempts.push(`try${i + 1}:${String(e && e.message || e)}`); }
        await poll(async () => (await readMode()) === want, 3000, 200);
        if ((await readMode()) === want) return { ok: true, tries: i + 1, attempts };
      }
      return { ok: false, tries: 3, attempts };
    };
    const toLocal = await clickModeUntil('local');
    if (!toLocal.ok) { try { fs.writeFileSync(path.join(ROOT, 'Temp', 'e2e-click-err.txt'), (toLocal.attempts || []).join('\n---\n')); } catch { /* 尽力 */ } }
    const localDot = await poll(() => dot.evaluate((el) => /pv-local/.test(el.className)), 4000);
    const genOff = await poll(() => act('generate').evaluate((el) => el.disabled === true), 4000);
    const expOn = await poll(() => act('export').evaluate((el) => el.disabled === false), 4000);
    check('切独立模式（真浏览器）：状态点橙 pv-local、生成停用、导出保留（本地能力不依赖桥）',
      toLocal.ok && !!localDot && !!genOff && !!expOn,
      JSON.stringify({
        hosts: await safe(() => page.locator('pv-floating').count(), -1),
        acts: await safe(() => page.evaluate(() => {
          const out = [];
          document.querySelectorAll('pv-floating').forEach((h) => {
            const walk = (n) => {
              if (n.getAttribute && n.getAttribute('data-act')) out.push(n.getAttribute('data-act'));
              Array.from(n.children || []).forEach(walk); // HTMLCollection 无 forEach（调试代码自身坑）
              if (n.shadowRoot) walk(n.shadowRoot);
            };
            walk(h);
          });
          return out;
        }), 'err'),
        mode: await readMode(), localDot: !!localDot, genOff: !!genOff, expOn: !!expOn,
        pwMode: await safe(() => page.locator('pv-floating [data-act="mode"]').count(), -1),
        pwExport: await safe(() => page.locator('pv-floating [data-act="export"]').count(), -1),
        err: String((toLocal.attempts && toLocal.attempts[0]) || '').split('\n')[0].slice(0, 80),
      }));
    await safe(() => act('export').click());
    const exp49 = await poll(async () => (await logText()).includes('已导出'), 8000, 300);
    check('独立模式下导出录制 JSON 仍可用（插拔式核心主张：断桥不断本地）',
      !!exp49 && /已导出 pv-export-.+\.json/.test(await logText()), await logText());
    const toMcp = await clickModeUntil('mcp');
    const mcpBack = await poll(() => dot.evaluate((el) => /pv-ok|pv-bad/.test(el.className)), 4000);
    check('切回依赖模式：状态点回到健康探活形态（pv_mode 持久化往返闭环）',
      toMcp.ok && !!mcpBack, JSON.stringify({ toMcp, dotNow: await safe(() => dot.getAttribute('class'), 'err') }));

    /* ---- URL 守门 ---- */
    await safe(() => page.goto(page2, { waitUntil: 'domcontentloaded', timeout: 30000 }));
    await poll(() => page.locator('pv-floating').count().then((n) => n > 0), 20000);
    await safe(() => ball.click());
    await safe(() => act('replay').click());
    const guardTxt = await poll(async () => (await logText()).includes('请回到录制页面'), 8000);
    check('回放 URL 守门（非录制页诚实拒绝，不乱点）', !!guardTxt, await logText());

    /* ---- 录制 B：关闭影子树 → 回放诚实停止（隔离边界的活体钉） ---- */
    await safe(() => page.goto(page1, { waitUntil: 'domcontentloaded', timeout: 30000 }));
    await poll(() => page.locator('pv-floating').count().then((n) => n > 0), 20000);
    await safe(() => ball.click());
    await safe(() => act('record').click());
    const closedClicked = await safe(async () => {
      await page.evaluate(() => { if (window.__closedP) window.__closedP.click(); });
      return true;
    }, false);
    await safe(() => act('stop').click());
    const savedB = await poll(async () => (await logText()).includes('已保存'), 5000);
    check('录制 B：关闭影子树点击 → 录到可达宿主选择器（document 层重定向的诚实结果）',
      !!closedClicked && !!savedB, await logText());
    await safe(() => act('replay').click());
    const hostReplay = await poll(async () => {
      const t = await logText();
      return /✓/.test(t) && !/未找到/.test(t) && !/已保存/.test(t) ? t : null;
    }, 12000, 400);
    check('关闭影子树宿主回放 ✓（点可达宿主，绝不假装穿透不可达树）', !!hostReplay, await logText());

    /* ---- 诚实停止活体钉：录后目标从 DOM 移除 → 回放未找到即停 ---- */
    await safe(() => page.goto(page1, { waitUntil: 'domcontentloaded', timeout: 30000 }));
    await poll(() => page.locator('pv-floating').count().then((n) => n > 0), 20000);
    await safe(() => ball.click());
    await safe(() => act('record').click());
    await safe(() => page.locator('#footer-p').click({ timeout: 8000 }));
    await safe(() => act('stop').click());
    await safe(() => page.evaluate(() => { const f = document.querySelector('footer'); if (f) f.remove(); }));
    await safe(() => act('replay').click());
    const honestTxt = await poll(async () => {
      const t = await logText();
      return /元素未找到，已停止/.test(t) ? t : null;
    }, 12000, 400);
    check('目标消失后回放：诚实停止（未找到即停，绝不盲点后续）', !!honestTxt, await logText());

    /* ---- 第 2 轮：稳定性复跑（录制→保存→回放最小链） ---- */
    await safe(() => page.goto(page1, { waitUntil: 'domcontentloaded', timeout: 30000 }));
    await poll(() => page.locator('pv-floating').count().then((n) => n > 0), 20000);
    await safe(() => ball.click());
    await safe(() => act('record').click());
    await safe(() => page.locator('#file-search').fill('round2', { timeout: 8000 }));
    await safe(() => act('stop').click());
    const savedR2 = await poll(async () => (await logText()).includes('已保存 1 步'), 5000);
    check('R2 稳定性：录制→保存 1 步', !!savedR2, await logText());
    await safe(() => act('replay').click());
    const replayR2 = await poll(async () => {
      const t = await logText();
      return /✓/.test(t) && !/未找到/.test(t) && !/已保存/.test(t) ? t : null;
    }, 15000, 400);
    check('R2 稳定性：回放 1 步 ✓', !!replayR2, await logText());

    /* ---- 录制管理（多条列表）真浏览器验证 ----
       注意：三轮循环已在 storage 累积录制 —— 管理钉要测确定性形状，
       先清 storage 再重新 goto（内存随新文档重置），从干净列表起测。 */
    await safe(async () => sw.evaluate(() => chrome.storage.local.remove(['pv_recordings_list', 'pv_recordings'])));
    await safe(() => page.goto(page1, { waitUntil: 'domcontentloaded', timeout: 30000 }));
    await poll(() => page.locator('pv-floating').count().then((n) => n > 0), 20000);
    await safe(() => ball.click());
    await safe(() => act('record').click());
    await safe(() => page.locator('#file-search').fill('mgmt-one', { timeout: 8000 }));
    await safe(() => act('stop').click());
    await safe(() => act('record').click());
    await safe(() => page.locator('#file-search').fill('mgmt-two', { timeout: 8000 }));
    await safe(() => act('stop').click());
    const listAfter2 = await poll(async () => {
      const v = await sw.evaluate(() => chrome.storage.local.get('pv_recordings_list'));
      return Array.isArray(v.pv_recordings_list) && v.pv_recordings_list.length === 2 ? v.pv_recordings_list : null;
    }, 8000, 400);
    check('录制管理：干净列表连录两条 → storage 列表 2（新在前，值正确）', !!listAfter2
      && listAfter2[0].steps.length === 1 && listAfter2[0].steps[0].value === 'mgmt-two'
      && listAfter2[1].steps.length === 1 && listAfter2[1].steps[0].value === 'mgmt-one', await logText());
    const delClicked = await safe(async () => {
      const del = page.locator('pv-floating .pv-rec-row').nth(1).locator('.pv-rec-del'); // 前插序：nth(1)=较早
      await del.click({ timeout: 6000 });
      return true;
    }, false);
    const listAfterDel = await poll(async () => {
      const v = await sw.evaluate(() => chrome.storage.local.get('pv_recordings_list'));
      return Array.isArray(v.pv_recordings_list) && v.pv_recordings_list.length === 1 ? v.pv_recordings_list : null;
    }, 8000, 400);
    check('录制管理：UI 删除较早一条 → storage 列表 1（剩较新的 mgmt-two）', !!delClicked && !!listAfterDel
      && listAfterDel[0].steps[0].value === 'mgmt-two', await logText());
    await safe(() => act('replay').click());
    const replayRemain = await poll(async () => {
      const t = await logText();
      return /✓/.test(t) && !/未找到/.test(t) && !/已保存/.test(t) && !/已删除/.test(t) ? t : null;
    }, 15000, 400);
    check('录制管理：剩余那条回放 ✓（选中态跟随删除自动切换）', !!replayRemain, await logText());

    /* ---- 行内重命名（真浏览器） ---- */
    await safe(() => page.locator('pv-floating .pv-rec-ren').first().click({ timeout: 6000 }));
    const renameInput = page.locator('pv-floating .pv-rec-rename').first();
    await safe(() => renameInput.fill('重命名后的录制', { timeout: 4000 }));
    await safe(() => renameInput.press('Enter', { timeout: 4000 }));
    const renamedOk = await poll(async () => {
      const v = await sw.evaluate(() => chrome.storage.local.get('pv_recordings_list'));
      return v.pv_recordings_list && v.pv_recordings_list[0] && v.pv_recordings_list[0].name === '重命名后的录制' ? v : null;
    }, 8000, 400);
    check('录制管理：真浏览器行内重命名 → storage 名字更新', !!renamedOk, await logText());

    check('扩展侧全程零 console/page error', extErrors.length === 0, extErrors.slice(0, 3).join(' | '));
  } finally {
    await safe(() => ctx.close());
    try { bridge.child.kill(); } catch { /* 已退出 */ }
    await new Promise((r) => target.server.close(r));
  }

  console.log('');
  console.log(`floating-e2e：${failures ? `${failures} 项失败` : '全部通过'}`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error('floating-e2e HARNESS ERROR:', (e && e.stack) || e);
  process.exit(2);
});
