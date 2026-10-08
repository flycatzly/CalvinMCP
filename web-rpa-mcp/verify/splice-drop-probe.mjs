/* splice 尾步丢失受控复现器（观测日志配套；23 轮 API 双模式未复现，日志埋点待真实样本）
 * 用法：node verify/splice-drop-probe.mjs [端口] [轮数]；SETTLE_MS=800 变更停止沉降
 * 判据：session=N inserted<M 即丢步；配合 logs/ 里「停止路径观测」行定位丢步节点 */
/* splice 尾步丢失复现器：紧凑停止 ×N 轮，统计「会话步数 vs 拼接新增」 */
import { spawn } from 'node:child_process';
const ROOT = 'D:/work/MCP/web-rpa-mcp/';
const PORT = Number(process.argv[2] || 8333);
const ROUNDS = Number(process.argv[3] || 5);
const BASE = 'http://127.0.0.1:' + PORT;
const http = await import('node:http');
const stub = await new Promise((res) => {
  const s = http.createServer((q, r) => {
    const u = new URL(q.url, 'http://x');
    const auto = u.search.indexOf('auto=1') >= 0;
    r.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    r.end('<!doctype html><html><head><meta charset="utf-8"><title>drop页</title></head><body><h1>drop页</h1><input id="num" data-testid="num"><button id="go" data-testid="go" onclick="document.getElementById(\'out\').textContent=\'OK\'">go</button><div id="out"></div>' +
      (auto ? '<script>setTimeout(function(){var n=document.getElementById("num");n.value="7";n.dispatchEvent(new Event("input",{bubbles:true}));document.getElementById("go").click();},1200);</script>' : '') +
      '</body></html>');
  });
  s.listen(0, '127.0.0.1', () => res({ server: s, url: 'http://127.0.0.1:' + s.address().port }));
});
const b = spawn('node', [ROOT + 'mcp/bridge.mjs', String(PORT)], { cwd: ROOT, stdio: 'ignore' });
const call = async (n, a) => { const r = await fetch(BASE + '/api/call', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: n, args: a || {} }) }); return r.json(); };
let ok = false;
for (let i = 0; i < 40 && !ok; i++) { await new Promise((r) => setTimeout(r, 500)); try { ok = (await fetch(BASE + '/health')).ok; } catch { /* retry */ } }

let drops = 0;
for (let round = 1; round <= ROUNDS; round++) {
  const id = 't-drop-' + round;
  const probe = { id, name: id, version: 1, startUrl: stub.url + '/?auto=1', params: [],
    steps: [
      { op: 'goto', seq: 1, url: stub.url + '/?auto=1' },
      { op: 'click', seq: 2, locators: [{ strategy: 'testid', value: 'go' }] },
      { op: 'fill', seq: 3, locators: [{ strategy: 'testid', value: 'num' }], value: '1' },
    ], assertions: [] };
  await call('flow_import', { flow: probe, overwrite: true });
  // 清孤儿
  const rs0 = await call('record_status');
  if (rs0.data && rs0.data.recording) await call('record_cancel');
  const sp = await call('record_splice_start', { flowId: id, from: 3, to: 3, keepSuffix: true });
  if (!sp.ok) { console.log('round' + round, 'splice 启动失败', String(sp.summary).slice(0, 60)); continue; }
  // 紧凑停止：等到新片段 2 步立刻停（模拟 popup S32 的紧凑模式）
  let saw = null;
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 500));
    const rs = await call('record_status');
    saw = rs.data;
    if (rs.data && rs.data.recording && (rs.data.stepCount || 0) >= 2) break;
  }
  const sessSteps = saw && saw.steps ? saw.steps.length : -1;
  const SETTLE = Number(process.env.SETTLE_MS || 0);
  if (SETTLE > 0) await new Promise((r) => setTimeout(r, SETTLE));
  const st = await call('record_stop', {});
  const sh = await call('flow_show', { flowId: id, format: 'json' });
  const finalOps = ((sh.data && sh.data.steps) || []).map((s) => s.op);
  const inserted = finalOps.length - 2; // 前缀 2
  const dropped = inserted < sessSteps;
  if (dropped) drops++;
  console.log('round' + round, 'session=' + sessSteps, 'inserted=' + inserted, 'final=' + finalOps.join(','), dropped ? 'DROP!!!' : 'ok', st.ok ? '' : ('stop-err:' + String(st.summary).slice(0, 40)));
  await call('flow_delete', { flowId: id });
  await new Promise((r) => setTimeout(r, 800));
}
console.log('合计: ' + drops + '/' + ROUNDS + ' 轮丢尾步');
b.kill();
stub.server.close();
