#!/usr/bin/env node
// web-rpa-mcp 桥接服务：把 stdio MCP 服务器暴露成本地 HTTP REST，供浏览器插件「Web RPA 控制台」调用。
//
//   node mcp/bridge.mjs [端口]     默认 8317（或 WEBRPA_BRIDGE_PORT）
//
// 端点：
//   GET  /            说明页（含端点清单）
//   GET  /health      桥接与 MCP 服务器状态
//   GET  /tools       全部工具（name / description / inputSchema）
//   POST /api/call    { name, args } -> 调用任意 MCP 工具，返回 { ok, summary, data, text, elapsedMs }
//
// 安全：只绑定 127.0.0.1；校验 Host（防 DNS rebinding）与 Origin（只放行 chrome-extension://
// 与本机同源）；不带任何 CORS 放行头——跨源网页拿不到响应体。回放/录制是本机强操作，
// 不要把这个端口暴露到局域网。
// 可选 token 鉴权（公网/跨机转发场景的兜底）：启动时设置 WEBRPA_BRIDGE_TOKEN 后，
// /health /tools /api/call 三个端点必须带有效凭证——请求头 `X-RPA-Token: <token>`，
// 或（网页版 /console 场景）URL 参数 `?token=<token>`；不匹配一律 403 并提示配置方法。
// 未设置该环境变量时行为逐字节不变（向后兼容）。/ 说明页与 /console 静态文件不校验
//（页面本身不含敏感数据；页面内的所有 fetch 都会带上凭证）。
import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = path.join(__dirname, 'server.mjs');
const EXTENSION_DIR = path.resolve(__dirname, '..', 'extension');
const BRIDGE_VERSION = '1.0.0';
const PORT = Number(process.argv[2] || process.env.WEBRPA_BRIDGE_PORT || 8317);
const HOST = '127.0.0.1';
const MAX_BODY = 10 * 1024 * 1024; // flow_import 等大 JSON 的上限
const TOKEN = process.env.WEBRPA_BRIDGE_TOKEN || ''; // 空 = 不启用鉴权（默认行为不变）

const startedAt = Date.now();
let lastError = null;

/* 调用可观测性：totalCalls/errors 计数 + 最近 20 次调用环（/health 可见，stderr 留痕）。
   无人值守排障要能回答"谁在什么时候调了什么、结果如何"——插件/网页/脚本共用这一个端口。 */
const stats = { calls: 0, errors: 0 };
const recentCalls = [];
function noteCall(name, elapsedMs, ok, err) {
  stats.calls++;
  if (!ok) stats.errors++;
  const rec = { at: new Date().toISOString(), tool: name, elapsedMs, ok };
  if (err) rec.error = String(err).slice(0, 200);
  recentCalls.push(rec);
  if (recentCalls.length > 20) recentCalls.shift();
  console.error('[bridge] call ' + name + ' ok=' + ok + ' ' + elapsedMs + 'ms' + (err ? ' err=' + String(err).slice(0, 160) : ''));
}

/* ------------------------------------------------------------------ */
/* MCP 子进程（stdio JSON-RPC）                                         */
/* ------------------------------------------------------------------ */

const mcp = {
  child: null,
  ready: false,
  serverInfo: null,
  tools: null,          // tools/list 缓存
  stderrTail: [],       // 最近 20 行 stderr，health 里给排障线索
  booting: null,        // 进行中的启动 Promise（并发去重）
};

function mcpLog(line) {
  const text = String(line || '').trim();
  if (!text) return;
  mcp.stderrTail.push(text);
  if (mcp.stderrTail.length > 20) mcp.stderrTail.shift();
  console.error('[mcp] ' + text);
}

const pending = new Map();
let seq = 0;

function mcpRequest(method, params, timeoutMs = 15000) {
  const child = mcp.child;
  if (!child) throw new Error('MCP 服务器未启动');
  const id = ++seq;
  return new Promise((resolve, reject) => {
    const timer = timeoutMs
      ? setTimeout(() => { pending.delete(id); reject(new Error('MCP 调用超时: ' + method)); }, timeoutMs)
      : null;
    pending.set(id, (msg) => {
      if (timer) clearTimeout(timer);
      if (msg.error) reject(new Error('MCP 错误 ' + msg.error.code + ': ' + msg.error.message));
      else resolve(msg.result);
    });
    try { child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); }
    catch (e) { if (timer) clearTimeout(timer); pending.delete(id); reject(e); }
  });
}

async function mcpEnsure() {
  if (mcp.child && mcp.ready) return;
  if (mcp.booting) return mcp.booting;
  mcp.booting = (async () => {
    lastError = null;
    const child = spawn(process.execPath, [SERVER_PATH], { stdio: ['pipe', 'pipe', 'pipe'] });
    mcp.child = child;
    mcp.ready = false;
    mcp.tools = null;
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d) => String(d).split('\n').forEach(mcpLog));
    child.on('exit', (code) => {
      mcpLog('MCP 服务器进程退出，code=' + code);
      mcp.child = null;
      mcp.ready = false;
      for (const [id, fn] of pending) { fn({ error: { code: -1, message: 'MCP 服务器进程已退出' } }); pending.delete(id); }
    });

    const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    rl.on('line', (line) => {
      const text = String(line || '').trim();
      if (!text) return;
      let msg;
      try { msg = JSON.parse(text); } catch { return; }
      if (msg.id !== undefined && pending.has(msg.id)) {
        const fn = pending.get(msg.id);
        pending.delete(msg.id);
        fn(msg);
      }
    });

    try {
      const init = await mcpRequest('initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'web-rpa-bridge', version: BRIDGE_VERSION },
      }, 20000);
      mcp.serverInfo = init.serverInfo || null;
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
      const list = await mcpRequest('tools/list', {}, 15000);
      mcp.tools = (list.tools || []);
      mcp.ready = true;
      console.error('[bridge] MCP 服务器已就绪: ' + (mcp.serverInfo && mcp.serverInfo.version) + '，工具 ' + mcp.tools.length + ' 个，pid ' + child.pid);
    } catch (e) {
      lastError = String(e && e.message ? e.message : e);
      try { child.kill(); } catch { /* ignore */ }
      throw e;
    } finally {
      mcp.booting = null;
    }
  })();
  return mcp.booting;
}

async function mcpToolCall(name, args) {
  await mcpEnsure();
  return mcpRequest('tools/call', { name, arguments: args || {} }, 0); // 回放/录制可能跑很久：不设超时
}

/* 把 MCP 工具结果拆成 UI 友好的形状：ok() 的 structuredContent 优先，
   fail() 没有 structuredContent，从 text 的 "❌ message\n\n{json}" 里解析。 */
function unwrap(result) {
  const text = (result && result.content && result.content[0] && result.content[0].text) || '';
  let data = result && result.structuredContent !== undefined ? result.structuredContent : undefined;
  let summary = text.split('\n')[0] || '';
  if (data === undefined) {
    const i = text.indexOf('{');
    if (i >= 0) { try { data = JSON.parse(text.slice(i)); } catch { /* 保持 undefined */ } }
  }
  return {
    ok: !(result && result.isError),
    summary: summary.replace(/^❌\s*/, '').replace(/^✅\s*/, ''),
    data: data === undefined ? null : data,
    text,
  };
}

/* ------------------------------------------------------------------ */
/* HTTP                                                                */
/* ------------------------------------------------------------------ */

function send(res, status, body, type = 'application/json; charset=utf-8') {
  const payload = (typeof body === 'string' || Buffer.isBuffer(body)) ? body : JSON.stringify(body, null, 2);
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(payload);
}

function guard(req, res) {
  // DNS rebinding 防护：浏览器发来的 Host 必须是本机
  const host = String(req.headers.host || '').split(':')[0];
  if (host !== '127.0.0.1' && host !== 'localhost') {
    send(res, 403, { ok: false, error: 'Host 不合法（只允许本机访问）' });
    return false;
  }
  // 跨源防护：只放行扩展与本机同源；网页来源直接 403（也不发 CORS 头，让浏览器拿不到响应）
  const origin = req.headers.origin;
  if (origin && origin !== 'null' && !origin.startsWith('chrome-extension://') &&
      origin !== 'http://' + HOST + ':' + PORT && origin !== 'http://localhost:' + PORT) {
    send(res, 403, { ok: false, error: 'Origin 不合法：只允许浏览器插件与本机页面调用' });
    return false;
  }
  return true;
}

/* 可选 token 鉴权：TOKEN 未设置时直接放行（行为与旧版逐字节一致）。
 * 比较用 crypto.timingSafeEqual（长度不同先拒再拒），避免字符串比较的时序侧信道。 */
function tokenOk(req, url) {
  if (!TOKEN) return true;
  const got = req.headers['x-rpa-token'] || url.searchParams.get('token') || '';
  const a = crypto.createHash('sha256').update(String(got)).digest();
  const b = crypto.createHash('sha256').update(TOKEN).digest();
  return crypto.timingSafeEqual(a, b);
}

function requireToken(req, url, res) {
  if (tokenOk(req, url)) return true;
  send(res, 403, {
    ok: false,
    error: '已启用 token 鉴权：本请求未带有效的 X-RPA-Token 头（桥接启动时设置了 WEBRPA_BRIDGE_TOKEN）。' +
      '请在浏览器插件设置里配置同一 token，或网页版访问 /console?token=<token>。',
  });
  return false;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('请求体超过 10MB 上限')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const INDEX_HTML = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>web-rpa-mcp 桥接服务</title>
<style>body{font-family:system-ui,sans-serif;max-width:680px;margin:40px auto;padding:0 16px;color:#1f2937}
code,pre{background:#f3f4f6;border-radius:6px;padding:2px 6px}pre{padding:12px;overflow:auto}
.dot{display:inline-block;width:10px;height:10px;border-radius:50%;background:#9ca3af;margin-right:6px}
.dot.ok{background:#16a34a}.dot.bad{background:#dc2626}</style></head><body>
<h1><span class="dot" id="d"></span>web-rpa-mcp 桥接服务</h1>
<p id="s">检查中…</p>
<h2>端点</h2>
<pre>GET  /health    桥接与 MCP 服务器状态
GET  /tools     全部工具（name / description / inputSchema）
POST /api/call  {"name":"flow_list","args":{}}   调用任意 MCP 工具</pre>
<p>浏览器插件控制台在本仓库 <code>extension/</code> 目录，按 extension/README.md 加载即可；不想装插件，也可以直接打开 <a href="/console">/console 网页版控制台</a>（功能相同）。</p>
<script>
fetch('/health').then(r=>{if(r.status===403)throw new Error('已启用 token 鉴权：请用 /console?token=<token> 打开控制台，或在浏览器插件设置里配置同一 token');return r.json()}).then(h=>{
  document.getElementById('d').className='dot '+(h.ok?'ok':'bad');
  document.getElementById('s').textContent=h.ok
    ?('已连接 MCP 服务器 v'+(h.mcp.serverInfo&&h.mcp.serverInfo.version)+'，工具 '+h.mcp.toolCount+' 个，pid '+h.mcp.pid)
    :('MCP 未就绪：'+(h.mcp&&h.mcp.error||'未知'));
}).catch(e=>{document.getElementById('d').className='dot bad';document.getElementById('s').textContent='桥接不可达：'+e;});
</script></body></html>`;

async function route(req, res) {
  if (!guard(req, res)) return;
  const url = new URL(req.url, 'http://' + (req.headers.host || HOST));
  const p = url.pathname;

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  /* 扩展控制台的网页兜底：没装插件时浏览器直接开 /console 也能用（与本桥接同源，安全口径一致） */
  if (req.method === 'GET') {
    const STATIC_FILES = {
      '/console': ['popup.html', 'text/html; charset=utf-8'],
      '/popup.html': ['popup.html', 'text/html; charset=utf-8'],
      '/popup.css': ['popup.css', 'text/css; charset=utf-8'],
      '/popup.js': ['popup.js', 'text/javascript; charset=utf-8'],
      '/icons/icon16.png': ['icons/icon16.png', 'image/png'],
      '/icons/icon32.png': ['icons/icon32.png', 'image/png'],
      '/icons/icon48.png': ['icons/icon48.png', 'image/png'],
      '/icons/icon128.png': ['icons/icon128.png', 'image/png'],
    };
    const hit = STATIC_FILES[p];
    if (hit) {
      const file = path.join(EXTENSION_DIR, hit[0]);
      if (file.startsWith(EXTENSION_DIR + path.sep) && fs.existsSync(file)) {
        send(res, 200, fs.readFileSync(file), hit[1]);
      } else {
        send(res, 404, { ok: false, error: 'extension/ 文件缺失：' + hit[0] });
      }
      return;
    }
  }

  if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
    send(res, 200, INDEX_HTML, 'text/html; charset=utf-8');
    return;
  }

  if (req.method === 'GET' && p === '/health') {
    if (!requireToken(req, url, res)) return;
    const out = {
      ok: false,
      bridge: {
        version: BRIDGE_VERSION, port: PORT, pid: process.pid,
        uptimeSec: Math.round((Date.now() - startedAt) / 1000),
        stats, recentCalls: recentCalls.slice(-10),
      },
      mcp: { ready: false, serverInfo: null, pid: null, toolCount: 0, error: null, stderrTail: mcp.stderrTail.slice(-5) },
    };
    try {
      await mcpEnsure();
      out.ok = mcp.ready;
      out.mcp = {
        ready: mcp.ready, serverInfo: mcp.serverInfo,
        pid: mcp.child ? mcp.child.pid : null,
        toolCount: mcp.tools ? mcp.tools.length : 0,
        error: lastError, stderrTail: mcp.stderrTail.slice(-5),
      };
    } catch (e) {
      out.mcp.error = String(e && e.message ? e.message : e);
      out.mcp.stderrTail = mcp.stderrTail.slice(-5);
    }
    send(res, 200, out);
    return;
  }

  if (req.method === 'GET' && p === '/tools') {
    if (!requireToken(req, url, res)) return;
    try {
      await mcpEnsure();
      send(res, 200, { ok: true, count: mcp.tools.length, tools: mcp.tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) });
    } catch (e) {
      send(res, 502, { ok: false, error: 'MCP 服务器不可用：' + (e && e.message ? e.message : e) });
    }
    return;
  }

  if (req.method === 'POST' && p === '/api/call') {
    if (!requireToken(req, url, res)) return;
    const t0 = Date.now();
    let body;
    try {
      const raw = await readBody(req);
      if (!raw) { send(res, 400, { ok: false, error: '请求体为空' }); return; }
      body = JSON.parse(raw);
    } catch (e) {
      send(res, 400, { ok: false, error: '请求体不是合法 JSON：' + (e && e.message ? e.message : e) });
      return;
    }
    const name = body && body.name;
    const args = (body && body.args) || {};
    if (typeof name !== 'string' || !/^[a-z_][a-z0-9_]*$/i.test(name)) {
      send(res, 400, { ok: false, error: 'name 必须是工具名（如 flow_list）' });
      return;
    }
    if (typeof args !== 'object' || args === null || Array.isArray(args)) {
      send(res, 400, { ok: false, error: 'args 必须是对象' });
      return;
    }
    // 客户端中途关掉插件窗口不取消执行：MCP 侧继续跑完并落报告，结果可从运行历史找回
    req.on('error', () => {});
    let out;
    try {
      const result = await mcpToolCall(name, args);
      out = unwrap(result);
    } catch (e) {
      out = { ok: false, summary: String(e && e.message ? e.message : e), data: null, text: '' };
    }
    out.tool = name;
    out.elapsedMs = Date.now() - t0;
    noteCall(name, out.elapsedMs, out.ok, out.ok ? null : out.summary);
    send(res, 200, out);
    return;
  }

  send(res, 404, { ok: false, error: '未找到 ' + p });
}

const server = http.createServer((req, res) => {
  route(req, res).catch((e) => {
    console.error('[bridge] 处理请求异常:', e);
    try { send(res, 500, { ok: false, error: String(e && e.message ? e.message : e) }); } catch { /* ignore */ }
  });
});
server.requestTimeout = 0;      // 工具调用可能跑几十分钟：不给响应设墙
server.headersTimeout = 60000;
server.listen(PORT, HOST, () => {
  console.error('[bridge] web-rpa-mcp 桥接服务 v' + BRIDGE_VERSION + ' 已启动: http://' + HOST + ':' + PORT + '（只监听本机）');
  console.error('[bridge] 浏览器插件加载 extension/ 目录即可控制录制/回放/定时等全部工具');
});

function shutdown() {
  console.error('[bridge] 正在退出');
  if (mcp.child) { try { mcp.child.kill(); } catch { /* ignore */ } }
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('exit', () => { if (mcp.child) { try { mcp.child.kill(); } catch { /* ignore */ } } });
