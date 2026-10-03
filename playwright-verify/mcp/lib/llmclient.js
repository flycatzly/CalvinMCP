/**
 * llmclient.js — 智能体线的大脑接入层（可选依赖，缺失只影响智能体线）
 *
 * 背景（来自「LangChain + Playwright 智能测试 Agent」一文的合并需求）：
 *   声明式测试的目标是「说目标，不说步骤」——目标→检查清单这一步需要一个 LLM 来规划。
 *   但规划只是规划：**执行、断言、证据落盘仍然走本服务已有的执行线**，
 *   LLM 从头到尾不碰脚本内容，所以「模型编造一个通过」在这条链路上做不到。
 *
 * 硬规则（与全项目一致，这里再收紧一层）：
 *   1) 凭据只从环境变量读 —— API key 绝不作为参数传入、绝不写盘、绝不进日志与报错文本。
 *   2) 默认本地 Ollama（数据不出机）；云端（DeepSeek）必须显式 PVMCP_LLM=deepseek 才启用。
 *      页面内容会被送进 LLM 做规划，这是隐私边界：默认本地就是为了让这条边界不需要审批。
 *   3) 零运行时依赖：HTTP 用 Node 自带 fetch，超时用 AbortController。
 *
 * Env（全部可选，缺省即回落）：
 *   PVMCP_LLM             ollama（默认）| deepseek | off
 *   OLLAMA_BASE_URL       默认 http://127.0.0.1:11434
 *   OLLAMA_MODEL          默认 qwen3（文章实测模型）
 *   DEEPSEEK_API_KEY      deepseek 提供方必需（只从这里读）
 *   DEEPSEEK_BASE_URL     默认 https://api.deepseek.com
 *   DEEPSEEK_MODEL        默认 deepseek-chat
 *   PVMCP_LLM_TIMEOUT_MS  默认 60000
 */
import os from 'node:os';

const DEFAULTS = {
  ollamaBase: 'http://127.0.0.1:11434',
  ollamaModel: 'qwen3',
  deepseekBase: 'https://api.deepseek.com',
  deepseekModel: 'deepseek-chat',
  timeoutMs: 60_000,
};

/**
 * 从环境变量解析 LLM 配置。**key 只在这里从 env 取一次**，返回对象也不带 key 明文
 * （调用方拿不到就丢不掉 —— 不落盘、不入报错的前提是它根本不在传递链上）。
 */
export function resolveLlm(env = process.env) {
  const kind = String(env.PVMCP_LLM || 'ollama').toLowerCase().trim();
  const timeoutMs = Number(env.PVMCP_LLM_TIMEOUT_MS) > 0
    ? Number(env.PVMCP_LLM_TIMEOUT_MS) : DEFAULTS.timeoutMs;

  if (kind === 'off' || kind === 'none' || kind === '0') {
    return { kind: 'off', why: 'PVMCP_LLM=off（智能体线用确定性骨架规划）', timeoutMs };
  }
  if (kind === 'deepseek') {
    const key = String(env.DEEPSEEK_API_KEY || '').trim();
    return {
      kind: 'deepseek',
      baseUrl: String(env.DEEPSEEK_BASE_URL || DEFAULTS.deepseekBase).replace(/\/+$/, ''),
      model: String(env.DEEPSEEK_MODEL || DEFAULTS.deepseekModel),
      hasKey: !!key,
      // key 本体不出这个函数：调用方需要鉴权时调 sign()，而不是拿着 key 自己拼。
      sign: (headers = {}) => (key ? { ...headers, Authorization: `Bearer ${key}` } : headers),
      timeoutMs,
      why: key
        ? 'DeepSeek 云端（显式开启；页面内容会出机）'
        : 'PVMCP_LLM=deepseek 但缺 DEEPSEEK_API_KEY（凭据只从环境变量读，不接受传参）',
    };
  }
  // ollama（含一切未知取值的回落 —— 未知值宁可走本地，也不静默切到云端）
  return {
    kind: 'ollama',
    baseUrl: String(env.OLLAMA_BASE_URL || DEFAULTS.ollamaBase).replace(/\/+$/, ''),
    model: String(env.OLLAMA_MODEL || DEFAULTS.ollamaModel),
    sign: (headers = {}) => headers,
    timeoutMs,
    why: kind === 'ollama' ? 'Ollama 本地（数据不出机）' : `PVMCP_LLM=${kind} 不是已知取值，已回落本地 Ollama`,
  };
}

/** 把任何可能带 key 的文本抹成掩码 —— 报错与日志都过这一层。 */
export function maskSecrets(text, env = process.env) {
  let t = String(text == null ? '' : text);
  const key = String(env.DEEPSEEK_API_KEY || '').trim();
  if (key && key.length >= 6) t = t.split(key).join('***');
  return t.replace(/Bearer\s+[A-Za-z0-9._-]{8,}/g, 'Bearer ***').replace(/sk-[A-Za-z0-9]{6,}/g, 'sk-***');
}

function timeoutError(ms) {
  const e = new Error(`LLM 请求超时（${ms}ms）`);
  e.code = 'LLM_TIMEOUT';
  return e;
}

/**
 * 与 LLM 对话并要求返回 JSON。
 *
 * @param {object} o
 * @param {string} o.system        系统提示（人设 + 输出契约）
 * @param {string} o.user          用户消息（目标 + 页面事实 + 动作白名单）
 * @param {object} [o.env]         环境（默认 process.env；测试可注入）
 * @param {Function} [o.fetchImpl] fetch 实现（默认全局 fetch；测试可注入）
 * @param {number} [o.timeoutMs]
 * @returns {Promise<{ok:boolean, provider:string, model:string, text?:string, json?:any, latencyMs:number, reason?:string, why?:string}>}
 */
export async function llmChatJson({ system, user, env = process.env, fetchImpl, timeoutMs } = {}) {
  const cfg = resolveLlm(env);
  const started = Date.now();
  const done = (extra) => ({ provider: cfg.kind, model: cfg.model || '', latencyMs: Date.now() - started, ...extra });

  if (cfg.kind === 'off') return done({ ok: false, reason: 'LLM_OFF', why: cfg.why });
  if (cfg.kind === 'deepseek' && !cfg.hasKey) return done({ ok: false, reason: 'LLM_KEY_MISSING', why: cfg.why });

  const doFetch = fetchImpl || globalThis.fetch;
  if (typeof doFetch !== 'function') {
    return done({ ok: false, reason: 'LLM_NO_FETCH', why: '当前 Node 没有全局 fetch（需要 Node ≥ 18）' });
  }

  const ms = timeoutMs || cfg.timeoutMs;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    let url;
    let body;
    if (cfg.kind === 'deepseek') {
      url = `${cfg.baseUrl}/chat/completions`;
      body = {
        model: cfg.model,
        messages: [
          { role: 'system', content: String(system || '') },
          { role: 'user', content: String(user || '') },
        ],
        response_format: { type: 'json_object' },
        stream: false,
      };
    } else {
      url = `${cfg.baseUrl}/api/chat`;
      body = {
        model: cfg.model,
        messages: [
          { role: 'system', content: String(system || '') },
          { role: 'user', content: String(user || '') },
        ],
        format: 'json',
        stream: false,
      };
    }

    const res = await doFetch(url, {
      method: 'POST',
      headers: cfg.sign({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(body),
      signal: ctl.signal,
    });
    if (!res.ok) {
      return done({ ok: false, reason: 'LLM_HTTP_' + res.status, why: `LLM 服务返回 HTTP ${res.status}` });
    }
    const payload = await res.json();
    const text = cfg.kind === 'deepseek'
      ? payload?.choices?.[0]?.message?.content
      : payload?.message?.content;
    if (typeof text !== 'string' || !text.trim()) {
      return done({ ok: false, reason: 'LLM_EMPTY', why: 'LLM 返回了空内容' });
    }
    // 契约是 JSON；模型偶尔会在 JSON 外裹说明文字 —— 能救就救，救不动如实报，绝不编造。
    let json = null;
    try { json = JSON.parse(text); } catch {
      const m = /\{[\s\S]*\}/.exec(text);
      if (m) { try { json = JSON.parse(m[0]); } catch { /* 落到下面 */ } }
    }
    if (json === null) return done({ ok: false, reason: 'LLM_NOT_JSON', why: 'LLM 返回的不是 JSON', text: maskSecrets(text, env) });
    return done({ ok: true, json, text: maskSecrets(text, env) });
  } catch (e) {
    if (e.name === 'AbortError' || e.code === 'LLM_TIMEOUT') {
      return done({ ok: false, reason: 'LLM_TIMEOUT', why: timeoutError(ms).message });
    }
    return done({ ok: false, reason: 'LLM_UNREACHABLE', why: maskSecrets(e.message, env) });
  } finally {
    clearTimeout(timer);
  }
}

/** 本机概况（selfcheck 用）：只报「配了什么」，永远不报 key。 */
export function llmStatus(env = process.env) {
  const cfg = resolveLlm(env);
  return {
    provider: cfg.kind,
    model: cfg.model || null,
    baseUrl: cfg.baseUrl || null,
    why: cfg.why,
    machine: os.platform(),
  };
}

export default { resolveLlm, llmChatJson, llmStatus, maskSecrets };
