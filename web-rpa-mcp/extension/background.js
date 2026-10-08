// MV3 Service Worker：悬浮球（content script）与完整控制台的桥接中转。
// content script 运行在页面源上、受页面 CORS 与 Trusted Types 限制，无法直接 fetch 127.0.0.1；
// 统一走这里转发（host_permissions 已放行本机回环，扩展页面/后台 fetch 不受页面 CORS 约束）。
const DEFAULT_BASE = 'http://127.0.0.1:8317';

// 桥接地址归一化（与 popup.js 同款）：裸端口/host:port 补成完整 origin，
// 否则 fetch 打到 /8321/api/call 这类 404 静默全功能失效（存量坏值在读取时自愈）
function normalizeBridgeUrl(v) {
  const s = String(v || '').trim().replace(/\/+$/, '');
  if (!s) return DEFAULT_BASE;
  if (/^https?:\/\//i.test(s)) return s;
  if (/^\d+$/.test(s)) return 'http://127.0.0.1:' + s;
  return 'http://' + s;
}

async function bridgeBase() {
  try {
    const st = await chrome.storage.local.get({ bridgeUrl: DEFAULT_BASE });
    return normalizeBridgeUrl(st.bridgeUrl || DEFAULT_BASE);
  } catch (e) {
    return DEFAULT_BASE;
  }
}

async function callBridge(path, opts) {
  const base = await bridgeBase();
  // 桥接启用 WEBRPA_BRIDGE_TOKEN 时，统一在这里注入鉴权头（content script 与控制台共用本中转）
  const st = await chrome.storage.local.get({ rpaToken: '' });
  const headers = Object.assign({}, (opts && opts.headers) || {});
  if (st.rpaToken) headers['X-RPA-Token'] = st.rpaToken;
  const res = await fetch(base + path, Object.assign({}, opts, { headers }));
  if (!res.ok) {
    let msg = 'HTTP ' + res.status;
    try { const j = await res.json(); if (j && j.error) msg = j.error; } catch (e) { /* keep default */ }
    throw new Error(msg);
  }
  return res.json();
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      if (msg && msg.type === 'rpa-call') {
        sendResponse(await callBridge('/api/call', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: msg.tool, args: msg.args || {} }),
        }));
      } else if (msg && msg.type === 'rpa-health') {
        sendResponse(await callBridge('/health'));
      } else if (msg && msg.type === 'rpa-open-console') {
        const base = await bridgeBase();
        chrome.tabs.create({ url: base + '/console' });
        sendResponse({ ok: true });
      } else {
        sendResponse({ ok: false, summary: '未知消息类型' });
      }
    } catch (e) {
      sendResponse({ ok: false, summary: String(e && e.message ? e.message : e) });
    }
  })();
  return true; // 异步 sendResponse
});
