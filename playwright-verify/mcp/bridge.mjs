#!/usr/bin/env node
/**
 * bridge.mjs — 浏览器插件本地桥（HTTP ⇄ JSON-RPC 2.0）
 *
 * 为什么需要它：MCP server 是 stdio 传输，浏览器插件够不到 stdin/stdout。
 * 这座桥把**同一份** handleMessage 挂到本机 HTTP 上，插件用 fetch 调 JSON-RPC ——
 * 工具行为、错误码、日志、脱敏与 stdio 通道**零分叉**（复用 server.mjs 的处理器，
 * 不是把工具再实现一遍：两份实现 = 两套行为，漂移是静默的）。
 *
 * 安全边界（本机工具最容易被「顺手暴露」成远程后端，所以边界写死在代码里）：
 *   1) 只监听 127.0.0.1 —— 绝不对外暴露；
 *   2) Host 头必须是本机名（127.0.0.1 / localhost / [::1]）—— 挡 DNS rebinding：
 *      域名解析到 127.0.0.1 后浏览器会带**原域名**的 Host 头进来，这层就是拦它的；
 *   3) Origin 若存在必须是浏览器扩展来源（chrome-extension:// 等）——
 *      网页来源一律 403：不给恶网页一个「拿本机测试工具当后端」的通道；
 *   4) 可选口令 PVMCP_BRIDGE_TOKEN（头 x-bridge-token）—— 部署机要多一道门就设它；
 *   5) 脱敏红线：请求体（参数值）与响应体**永不进日志**，观测行只记 方法/工具名/
 *      耗时/状态 —— 哨兵测试（bridge-check）钉住这件事。
 *
 * Env:
 *   PVMCP_BRIDGE_PORT   监听端口（默认 7395；CLI 可用 --port 覆盖，0 = 随机端口）
 *   PVMCP_BRIDGE_TOKEN  可选口令；设置后所有请求须带 x-bridge-token 头
 *
 * 用法：
 *   node mcp/bridge.mjs                # 监听 http://127.0.0.1:7395
 *   node mcp/bridge.mjs --port 0       # 随机端口（测试用，启动行会打出实际端口）
 *
 * 路由（全部走 JSON-RPC 2.0，与 MCP 协议同构）：
 *   GET  /health   健康探活（不需要口令，探活不该被门禁挡住）
 *   POST /rpc      单条或批量 JSON-RPC 消息 → handleMessage 处理后回传
 *   OPTIONS /rpc   CORS 预检
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { handleMessage, TOOLS, VERSION, LATEST_PROTOCOL_VERSION } from './server.mjs';

const LOOPBACK = '127.0.0.1';
const DEFAULT_PORT = 7395;
/** 请求体上限：工具参数不该这么大（脚本生成类参数撑死几百 KB）；
 *  超限直接 413 —— 无上限的 body 缓冲是本机服务最便宜的内存放大器。 */
const MAX_BODY = 4 * 1024 * 1024;
/** 允许的浏览器扩展来源：chrome/edge、firefox、safari 三家的扩展协议头。 */
const EXTENSION_ORIGIN = /^(chrome|moz|safari-web)-extension:\/\//;
/** Host 头允许的本机名（端口已被剥掉）。 */
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

/* ------------------------------------------------------------------ *
 * 观测行（脱敏红线：只记元数据，绝不记参数值/结果文本/口令）
 * ------------------------------------------------------------------ */
function defaultLog(line) {
  process.stderr.write(`[pvmcp-bridge] ${line}\n`);
}

/** 口令比较：长度不同直接 false，等长逐字符异或累加（时序不泄露逐字节差异）。 */
function tokenMatches(a, b) {
  const x = String(a || '');
  const y = String(b || '');
  if (x.length !== y.length || x.length === 0) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

/**
 * 请求守门。返回 null 表示放行，否则给出 HTTP 状态与原因（原因只涉及来源/主机，
 * 不含任何请求内容）。exemptToken=true 时豁免口令（/health 探活专用：
 * 只回元数据，探活不该被门禁挡住，也帮插件区分「桥没起来」和「口令错」）。
 */
function guard(req, token, exemptToken = false) {
  const host = String(req.headers.host || '').replace(/:\d+$/, '');
  if (!LOCAL_HOSTS.has(host)) return { status: 403, reason: 'host-not-local' };
  const origin = req.headers.origin;
  if (origin && !EXTENSION_ORIGIN.test(String(origin))) return { status: 403, reason: 'origin-not-extension' };
  if (token && !exemptToken && !tokenMatches(req.headers['x-bridge-token'], token)) {
    return { status: 401, reason: 'bad-token' };
  }
  return null;
}

/** CORS 头：Origin 已被守门限定为扩展来源，这里回显它（file:// 等无 Origin 场景不需要）。 */
function corsHeaders(req) {
  const origin = req.headers.origin;
  if (!origin || !EXTENSION_ORIGIN.test(String(origin))) return {};
  return {
    'Access-Control-Allow-Origin': String(origin),
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'content-type, x-bridge-token',
    'Access-Control-Max-Age': '600',
  };
}

function sendJson(req, res, status, obj, extraHeaders = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    ...corsHeaders(req),
    ...extraHeaders,
  });
  res.end(body);
}

function sendEmpty(req, res, status, extraHeaders = {}) {
  res.writeHead(status, { ...corsHeaders(req), ...extraHeaders });
  res.end();
}

function rpcError(id, code, message) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

/**
 * 启动桥。返回 { port, url, close, address }。
 * 绑定 127.0.0.1 是硬编码的（没有「顺便支持 0.0.0.0」的开关 —— 这种开关就是事故本体）。
 *
 * @param {{port?: number, token?: string, log?: (line: string) => void}} [opts]
 * @returns {Promise<{port: number, url: string, address: string, close: () => Promise<void>}>}
 */
export function startBridge(opts = {}) {
  const token = String(opts.token || '');
  const log = typeof opts.log === 'function' ? opts.log : defaultLog;

  // 串行队列：与 stdio 通道同一语义 —— 工具调用可能很长、会写共享产物目录，
  // 并发跑会让产物互相覆盖。慢调用挡住后面的请求是**有意的**（可预期 > 假并行）。
  let queue = Promise.resolve();
  const enqueue = (fn) => {
    const next = queue.then(fn, fn);
    queue = next.catch(() => {});
    return next;
  };

  const server = http.createServer((req, res) => {
    const started = Date.now();
    const route = String(req.url || '').split('?')[0];
    const method = String(req.method || 'GET').toUpperCase();
    const done = (status, note) => {
      log(`${method} ${route} -> ${status} ${Date.now() - started}ms${note ? ` ${note}` : ''}`);
    };

    const denied = guard(req, token, route === '/health');
    if (denied) {
      sendJson(req, res, denied.status, { ok: false, error: denied.reason });
      done(denied.status, denied.reason);
      return;
    }

    if (method === 'OPTIONS') {
      sendEmpty(req, res, 204);
      done(204);
      return;
    }

    if (method === 'GET' && route === '/health') {
      sendJson(req, res, 200, {
        ok: true,
        name: 'playwright-verify-bridge',
        version: VERSION,
        protocol: LATEST_PROTOCOL_VERSION,
        tools: TOOLS.length,
      });
      done(200);
      return;
    }

    if (route !== '/rpc') {
      sendJson(req, res, 404, { ok: false, error: 'not-found', routes: ['/health', '/rpc'] });
      done(404);
      return;
    }

    if (method !== 'POST') {
      sendJson(req, res, 405, { ok: false, error: 'method-not-allowed' });
      done(405);
      return;
    }

    // ---- 读体（有上限）----
    const chunks = [];
    let size = 0;
    let aborted = false;
    req.on('data', (c) => {
      if (aborted) return;
      size += c.length;
      if (size > MAX_BODY) {
        aborted = true;
        sendJson(req, res, 413, { ok: false, error: 'payload-too-large', limit: MAX_BODY });
        done(413);
        // 排空而不是 destroy：直接掐连接会让对端把「连接被重置」当成崩溃，
        // 413 的语义（请求太大）反而丢了。排空只扔数据不缓冲，内存不涨。
        req.resume();
        return;
      }
      chunks.push(c);
    });
    req.on('error', () => { aborted = true; });
    req.on('end', () => {
      if (aborted) return;
      let msg;
      try {
        msg = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch (e) {
        sendJson(req, res, 400, rpcError(null, -32700, `JSON 解析失败：${e.message}`));
        done(400, 'parse-error');
        return;
      }

      enqueue(async () => {
        // 批量（数组）与单条同一处理路径：逐条交给 handleMessage，
        // 通知（无 id）按 JSON-RPC 语义不产生响应 —— 全是通知就 204。
        const msgs = Array.isArray(msg) ? msg : [msg];
        const out = [];
        for (const m of msgs) {
          const r = await handleMessage(m);
          if (r) out.push(r);
        }
        const body = Array.isArray(msg) ? out : (out[0] || null);
        if (body === null || (Array.isArray(body) && !body.length)) {
          sendEmpty(req, res, 204);
          done(204, 'notification-only');
          return;
        }
        // 观测行只记 JSON-RPC 方法与 tools/call 的工具名（与 stdio 日志同口径），
        // 参数值/结果文本一个字节都不落 —— 脱敏红线，bridge-check 哨兵钉住。
        const names = msgs.map((m) => (m && m.params && m.params.name ? String(m.params.name) : String((m && m.method) || '?')));
        sendJson(req, res, 200, body);
        done(200, names.join(','));
      }).catch((e) => {
        sendJson(req, res, 500, rpcError(null, -32603, `桥内部错误：${e.message}`));
        done(500, 'bridge-exception');
      });
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    // 绑回环：不对外暴露（没有监听地址开关 —— 见文件头安全边界 1）
    server.listen(Number(opts.port) || 0, LOOPBACK, () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({
        port,
        url: `http://${LOOPBACK}:${port}`,
        address: LOOPBACK,
        close: () => new Promise((res2) => {
          // fetch/浏览器的 keep-alive 连接会把 server.close() 挂到空闲超时才回 ——
          // 测试收尾与 Ctrl+C 都会「看起来卡住」。主动断开空闲连接不伤在飞请求
          //（在飞的走 gracefulClose 语义：close 先停新连接，这里只清已空闲的）。
          server.close(() => res2());
          if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
        }),
      });
    });
  });
}

/* ------------------------------------------------------------------ *
 * CLI 入口（浏览器插件的常驻后端）
 * ------------------------------------------------------------------ */
function parsePortArg(argv) {
  const i = argv.findIndex((a) => a === '--port' || a.startsWith('--port='));
  if (i === -1) return undefined;
  const raw = argv[i] === '--port' ? argv[i + 1] : argv[i].slice('--port='.length);
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 65535) {
    process.stderr.write(`[pvmcp-bridge] --port 需要 0–65535 的整数（收到：${String(raw).slice(0, 20)}）\n`);
    process.exit(1);
  }
  return n;
}

/** 与 server.mjs 同款主模块判定（真实路径比较，免疫改名/软链）。 */
function isMainModule() {
  if (process.env.PVMCP_FORCE_LISTEN === '1') return true;
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return fs.realpathSync(entry) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMainModule()) {
  const portArg = parsePortArg(process.argv.slice(2));
  const port = portArg !== undefined ? portArg : Number(process.env.PVMCP_BRIDGE_PORT || DEFAULT_PORT);
  const token = process.env.PVMCP_BRIDGE_TOKEN || '';
  startBridge({ port, token }).then(({ url, close }) => {
    // 启动行是给插件「填桥地址」和给人看的：只含地址，不含口令。
    process.stdout.write(`playwright-verify bridge listening on ${url}\n`);
    const stop = () => { close().then(() => process.exit(0)); };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  }).catch((e) => {
    process.stderr.write(`[pvmcp-bridge] 启动失败：${e.message}\n`);
    process.exit(1);
  });
}

export { MAX_BODY, EXTENSION_ORIGIN, LOCAL_HOSTS, tokenMatches, guard };
