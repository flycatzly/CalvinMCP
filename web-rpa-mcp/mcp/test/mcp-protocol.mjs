// web-rpa-mcp — MCP 协议层测试：真的启一个服务器进程，走 stdio JSON-RPC
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.join(__dirname, '..', 'server.mjs');

let pass = 0, fail = 0;
const failures = [];
function check(name, fn) {
  try { fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fail++; failures.push(name + ' -> ' + (e && e.message ? e.message : e)); console.log('  FAIL ' + name + '\n       ' + (e && e.message ? e.message : e)); }
}

const child = spawn(process.execPath, [serverPath], { stdio: ['pipe', 'pipe', 'pipe'] });
const pending = new Map();
let buf = '';
const stderrLines = [];
child.stderr.on('data', (d) => stderrLines.push(String(d)));
child.stdout.on('data', (d) => {
  buf += String(d);
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id !== undefined && pending.has(msg.id)) {
      const r = pending.get(msg.id);
      pending.delete(msg.id);
      r(msg);
    }
  }
});

let seq = 0;
function call(method, params) {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('超时: ' + method)); }, 90000);
    pending.set(id, (m) => { clearTimeout(timer); resolve(m); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}
function notify(method) { child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method }) + '\n'); }

async function main() {
  const init = await call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  check('initialize 返回 serverInfo', () => {
    if (!init.result || !init.result.serverInfo) throw new Error('缺少 serverInfo: ' + JSON.stringify(init));
    if (init.result.serverInfo.name !== 'web-rpa-mcp') throw new Error('名字不对: ' + init.result.serverInfo.name);
    if (!init.result.capabilities || !init.result.capabilities.tools) throw new Error('缺少 tools 能力');
  });
  notify('notifications/initialized');

  const list = await call('tools/list', {});
  const tools = (list.result && list.result.tools) || [];
  check('tools/list 返回 44 个工具', () => { if (tools.length !== 44) throw new Error('实际 ' + tools.length + ' 个'); });
  check('每个工具都有 name/description/inputSchema', () => {
    for (const t of tools) {
      if (!t.name || !t.description || !t.inputSchema) throw new Error('工具字段缺失: ' + JSON.stringify(t).slice(0, 120));
      if (t.inputSchema.type !== 'object') throw new Error(t.name + ' 的 inputSchema 不是 object');
    }
  });
  check('关键工具都在', () => {
    const need = ['record_start', 'record_stop', 'flow_run', 'flow_preflight', 'flow_lint', 'schedule_add', 'notify_config', 'chain_run', 'doctor', 'secret_set',
      'status_report', 'runs_prune', 'lock_status', 'lock_release',
      'profile_login', 'profile_info', 'profile_reset'];
    const names = new Set(tools.map((t) => t.name));
    for (const n of need) if (!names.has(n)) throw new Error('缺少工具 ' + n);
  });

  const ping = await call('ping', {});
  check('ping 正常', () => { if (!ping.result) throw new Error(JSON.stringify(ping)); });

  const doc = await call('tools/call', { name: 'doctor', arguments: {} });
  check('doctor 调用成功', () => {
    const r = doc.result;
    if (!r || r.isError) throw new Error('doctor 返回错误: ' + JSON.stringify(r).slice(0, 300));
    const text = r.content[0].text;
    if (text.indexOf('web-rpa-mcp') < 0 && text.indexOf('browser') < 0) throw new Error('doctor 输出异常: ' + text.slice(0, 200));
    if (text.indexOf('chromium') < 0 && text.indexOf('msedge') < 0 && text.indexOf('chrome') < 0) throw new Error('doctor 没有报告浏览器: ' + text.slice(0, 400));
  });

  const sr = await call('tools/call', { name: 'status_report', arguments: {} });
  check('status_report 调用成功并返回 summary', () => {
    const r = sr.result;
    if (!r || r.isError) throw new Error('status_report 返回错误: ' + JSON.stringify(r).slice(0, 300));
    const data = JSON.parse(r.content[0].text.slice(r.content[0].text.indexOf('{')));
    if (!data.summary || typeof data.summary.flows !== 'number') throw new Error('缺少 summary: ' + JSON.stringify(data).slice(0, 200));
    if (!Array.isArray(data.items)) throw new Error('缺少 items');
  });

  const lp = await call('tools/call', { name: 'runs_prune', arguments: {} });
  check('runs_prune 默认只预演（dryRun=true）', () => {
    const r = lp.result;
    if (!r || r.isError) throw new Error('runs_prune 返回错误: ' + JSON.stringify(r).slice(0, 300));
    const data = JSON.parse(r.content[0].text.slice(r.content[0].text.indexOf('{')));
    if (data.dryRun !== true) throw new Error('默认应当是预演');
  });

  const fl = await call('tools/call', { name: 'flow_list', arguments: {} });
  check('flow_list 调用成功', () => {
    const r = fl.result;
    if (!r || r.isError) throw new Error(JSON.stringify(r).slice(0, 300));
    if (r.content[0].text.indexOf('count') < 0) throw new Error('缺少 count 字段');
  });

  const bad = await call('tools/call', { name: 'flow_run', arguments: { flowId: '__不存在的流程__' } });
  check('不存在的流程返回可读错误', () => {
    const r = bad.result;
    if (!r || !r.isError) throw new Error('应当 isError=true，实际: ' + JSON.stringify(r).slice(0, 300));
    if (r.content[0].text.indexOf('不存在') < 0) throw new Error('错误信息不明确: ' + r.content[0].text);
  });

  const unknown = await call('tools/call', { name: '__no_such_tool__', arguments: {} });
  check('未知工具报 JSON-RPC 错误', () => { if (!unknown.error) throw new Error('应当返回 error，实际: ' + JSON.stringify(unknown)); });

  const noMethod = await call('__no_such_method__', {});
  check('未知方法报 -32601', () => {
    if (!noMethod.error) throw new Error('应当返回 error');
    if (noMethod.error.code !== -32601) throw new Error('错误码应为 -32601，实际 ' + noMethod.error.code);
  });

  const lintCall = await call('tools/call', { name: 'config_get', arguments: {} });
  check('config_get 对 webhook 做了掩码', () => {
    const text = lintCall.result.content[0].text;
    if (text.indexOf('webhook') < 0) throw new Error('缺少 webhook 字段');
  });

  child.stdin.end();
  await new Promise((r) => setTimeout(r, 500));
  try { child.kill(); } catch { /* ignore */ }

  console.log('\n总计: ' + pass + ' passed, ' + fail + ' failed');
  if (fail) console.log('\n失败项:\n' + failures.join('\n'));
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error('协议测试异常: ' + String(e && e.stack ? e.stack : e));
  if (stderrLines.length) console.error('服务器 stderr:\n' + stderrLines.join('').slice(-1500));
  try { child.kill(); } catch { /* ignore */ }
  process.exit(1);
});
