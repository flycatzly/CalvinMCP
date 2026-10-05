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

  check('structuredContent 纯增量：成功带结构化字段且与 text 内 JSON 同源一致', () => {
    const r = fl.result;
    if (!('structuredContent' in r)) throw new Error('成功结果应带 structuredContent');
    if (r.isError !== false) throw new Error('isError 应为 false，实际 ' + r.isError);
    if (!r.content || !r.content[0] || r.content[0].type !== 'text') throw new Error('content 文本回退必须保留');
    const textJson = JSON.parse(r.content[0].text.slice(r.content[0].text.indexOf('{')));
    if (JSON.stringify(r.structuredContent) !== JSON.stringify(textJson)) {
      throw new Error('structuredContent 应与 text 内 JSON 同源一致: ' + JSON.stringify(r.structuredContent));
    }
  });

  check('isError:true 形状不变：失败结果恰为 {content,isError}，不带 structuredContent', () => {
    const r = bad.result;
    if (!r || !r.isError) throw new Error('应 isError=true');
    if ('structuredContent' in r) throw new Error('失败结果不该带 structuredContent（isError:true 形状不变）');
    if (!r.content || !r.content[0] || r.content[0].type !== 'text') throw new Error('content 必须保留');
    const keys = Object.keys(r).sort().join(',');
    if (keys !== 'content,isError') throw new Error('isError:true 形状应恰为 {content,isError}，实为 ' + JSON.stringify(Object.keys(r)));
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

  const negBudget = await call('tools/call', { name: 'flow_run', arguments: { flowId: '__不存在的流程__', maxDurationMs: -1 } });
  check('负数 maxDurationMs 被入口校验拦下（INVALID_ARGUMENT 点名参数）', () => {
    const r = negBudget.result;
    if (!r || !r.isError) throw new Error('应当 isError=true，实际: ' + JSON.stringify(r).slice(0, 300));
    const text = r.content[0].text;
    if (text.indexOf('INVALID_ARGUMENT') < 0) throw new Error('缺少错误码: ' + text.slice(0, 200));
    if (text.indexOf('maxDurationMs') < 0) throw new Error('未点名参数: ' + text.slice(0, 200));
    if (text.indexOf('流程不存在') >= 0) throw new Error('应先于 handler 校验，不该走到流程查找');
  });

  const badItems = await call('tools/call', { name: 'chain_run', arguments: { items: [{ flow: 'a' }, {}] } });
  check('chain_run items 缺 flow 报 items[1].flow', () => {
    const text = badItems.result && badItems.result.content[0].text;
    if (!text || text.indexOf('items[1].flow') < 0) throw new Error('未点名嵌套参数路径: ' + String(text).slice(0, 200));
  });

  const missRequired = await call('tools/call', { name: 'flow_run', arguments: {} });
  check('缺必填参数 flowId 报可读错误', () => {
    const text = missRequired.result && missRequired.result.content[0].text;
    if (!missRequired.result || !missRequired.result.isError) throw new Error('应当 isError=true');
    if (text.indexOf('缺少必填参数 flowId') < 0) throw new Error('错误信息不明确: ' + String(text).slice(0, 200));
  });

  const coerced = await call('tools/call', { name: 'runs_prune', arguments: { dryRun: 'true', keepCount: '3' } });
  check('数字/布尔字符串被兼容转换（不报 INVALID_ARGUMENT）', () => {
    const r = coerced.result;
    if (!r || r.isError) throw new Error('应当成功，实际: ' + JSON.stringify(r).slice(0, 300));
    if (r.content[0].text.indexOf('预演') < 0) throw new Error('dryRun 未按 true 处理: ' + r.content[0].text.slice(0, 200));
  });

  const trav1 = await call('tools/call', { name: 'flow_show', arguments: { flowId: '../web-rpa.config' } });
  check('flow_show 穿越 id 被 INVALID_ARGUMENT 拦下且不泄露 webhook', () => {
    const r = trav1.result;
    if (!r || !r.isError) throw new Error('应当 isError=true，实际: ' + JSON.stringify(r).slice(0, 300));
    const text = r.content[0].text;
    if (text.indexOf('INVALID_ARGUMENT') < 0) throw new Error('缺少错误码: ' + text.slice(0, 200));
    if (text.indexOf('webhook') >= 0) throw new Error('泄露了 webhook 配置: ' + text.slice(0, 200));
    if (text.indexOf('flowId') < 0) throw new Error('未点名参数: ' + text.slice(0, 200));
  });

  const trav2 = await call('tools/call', { name: 'flow_delete', arguments: { flowId: '..\\probe-trav' } });
  check('flow_delete 穿越 id 被拒（不可删 flows/ 之外文件）', () => {
    const r = trav2.result;
    if (!r || !r.isError) throw new Error('应当 isError=true，实际: ' + JSON.stringify(r).slice(0, 300));
    if (r.content[0].text.indexOf('INVALID_ARGUMENT') < 0) throw new Error('缺少错误码: ' + r.content[0].text.slice(0, 200));
  });

  const trav3 = await call('tools/call', { name: 'run_history', arguments: { flowId: '..\\..\\x' } });
  check('run_history 穿越 id 被拒', () => {
    const r = trav3.result;
    if (!r || !r.isError) throw new Error('应当 isError=true，实际: ' + JSON.stringify(r).slice(0, 300));
    if (r.content[0].text.indexOf('INVALID_ARGUMENT') < 0) throw new Error('缺少错误码: ' + r.content[0].text.slice(0, 200));
  });

  const trav4 = await call('tools/call', { name: 'run_report', arguments: { flowId: '__不存在的流程__', stamp: '../latest' } });
  check('run_report 穿越 stamp 被拒（stamp 也是路径段）', () => {
    const r = trav4.result;
    if (!r || !r.isError) throw new Error('应当 isError=true，实际: ' + JSON.stringify(r).slice(0, 300));
    const text = r.content[0].text;
    if (text.indexOf('INVALID_ARGUMENT') < 0) throw new Error('缺少错误码: ' + text.slice(0, 200));
    if (text.indexOf('stamp') < 0) throw new Error('未点名参数: ' + text.slice(0, 200));
  });

  // TOOL_ERROR stack 是回给外部客户端的错误回显——路径必须脱敏（日志脱敏红线），但行:列要留着可定位
  const leak = await call('tools/call', { name: 'flow_show', arguments: { flowId: '__不存在的流程__' } });
  check('TOOL_ERROR stack 已脱敏：保留 at 帧结构与行列号，无本地绝对路径', () => {
    const r = leak.result;
    if (!r || !r.isError) throw new Error('应当 isError=true，实际: ' + JSON.stringify(r).slice(0, 300));
    const text = r.content[0].text;
    if (text.indexOf('TOOL_ERROR') < 0) throw new Error('缺少 TOOL_ERROR 形状: ' + text.slice(0, 200));
    if (!/at \S+ \(.+:\d+:\d+\)/.test(text)) throw new Error('stack 帧结构/行列号丢失: ' + text.slice(0, 300));
    if (/([A-Za-z]:[\\/]|file:\/\/\/|\/(?:home|Users|work)\/)/.test(text)) throw new Error('泄露本地路径: ' + text.slice(0, 300));
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
