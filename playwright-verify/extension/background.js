/**
 * background.js — MV3 Service Worker
 *
 * 职责：
 *   1) 点插件图标 → 打开控制台整页（整页而不是 popup：工具表单在 400px 里看不完）；
 *   2) 悬浮器中转：内容脚本不直接 fetch 127.0.0.1（页面 CSP/CORS 会拦）——
 *      一切桥调用走这里 → 桥 /rpc → MCP。口令只存在扩展 storage，只经
 *      x-bridge-token 请求头出站，绝不进内容脚本、绝不进正文、绝不进日志。
 */
chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: chrome.runtime.getURL('panel.html') });
});

const DEFAULT_BASE = 'http://127.0.0.1:7395';
let rpcSeq = 0;

function readCfg() {
  return new Promise((resolve) => {
    chrome.storage.local.get(['pv_base', 'pv_token'], (v) => resolve({
      base: String((v && v.pv_base) || DEFAULT_BASE).replace(/\/$/, ''),
      token: String((v && v.pv_token) || ''),
    }));
  });
}

/** 桥 /rpc 中转（POST JSON-RPC 单发；批量由悬浮器/面板侧自行拼）。 */
async function relayRpc(method, params) {
  const { base, token } = await readCfg();
  const headers = { 'content-type': 'application/json' };
  if (token) headers['x-bridge-token'] = token;
  const res = await fetch(base + '/rpc', {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcSeq, method: String(method || ''), params: params || {} }),
  });
  const json = await res.json().catch(() => null);
  return { ok: res.ok, status: res.status, json };
}

/** 桥探活（/health 免口令 —— 桥侧设计如此，这里只发 GET）。 */
async function relayHealth() {
  const { base } = await readCfg();
  try {
    const res = await fetch(base + '/health', { method: 'GET' });
    return { ok: res.ok, status: res.status };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string') return false;
  if (msg.type === 'pv-bridge') {
    Promise.resolve()
      .then(() => relayRpc(msg.method, msg.params))
      .then((r) => sendResponse(r))
      .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
    return true; // 异步响应：sendResponse 之后才回
  }
  if (msg.type === 'pv-health') {
    relayHealth().then(sendResponse);
    return true;
  }
  if (msg.type === 'pv-open-panel') {
    chrome.tabs.create({ url: chrome.runtime.getURL('panel.html') });
    sendResponse({ ok: true });
    return false;
  }
  return false;
});
