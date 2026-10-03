// cli Reader：把外部只读读取器（rion-wechat-cli / fake_vault_cli.py / 任意符合协议的脚本）
// 适配成本项目统一的 reader 协议。兼容两种信封：
//   A) {ok, tool, command, data:{messages|sessions|...}}
//   B) {messages:[...]} / {data:{messages:[...]}}
import { spawn } from "node:child_process";
import { envelope, inferKind, paginate, sortByTime, toReaderMessage } from "./common.mjs";

function run(command, args, { timeoutMs = 60000, cwd, env } = {}) {
  return new Promise((resolve) => {
    let out = "";
    let err = "";
    let done = false;
    const child = spawn(command, args, { cwd, env: { ...process.env, ...(env ?? {}) }, shell: false, windowsHide: true });
    const timer = setTimeout(() => {
      if (!done) {
        done = true;
        try { child.kill(); } catch { /* ignore */ }
        resolve({ code: -1, stdout: out, stderr: err + "\n[timeout]" });
      }
    }, timeoutMs);
    child.stdout?.on("data", (d) => { out += d.toString("utf8"); });
    child.stderr?.on("data", (d) => { err += d.toString("utf8"); });
    child.on("error", (e) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code: -1, stdout: out, stderr: String(e.message ?? e) });
    });
    child.on("close", (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code: code ?? 0, stdout: out, stderr: err });
    });
  });
}

/** 从任意 stdout 中提取 JSON（容忍前后有日志行） */
export function extractJson(text) {
  const s = String(text ?? "").trim();
  if (!s) return null;
  try { return JSON.parse(s); } catch { /* continue */ }
  const lines = s.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i].trim();
    if (!l || (l[0] !== "{" && l[0] !== "[")) continue;
    try { return JSON.parse(l); } catch { /* continue */ }
  }
  const first = s.indexOf("{");
  const last = s.lastIndexOf("}");
  if (first >= 0 && last > first) {
    try { return JSON.parse(s.slice(first, last + 1)); } catch { /* continue */ }
  }
  return null;
}

function rowsOf(obj, keys) {
  if (!obj) return [];
  const pools = [obj, obj.data, obj.result, obj.payload].filter((x) => x && typeof x === "object");
  for (const p of pools) {
    for (const k of keys) if (Array.isArray(p[k])) return p[k];
  }
  if (Array.isArray(obj)) return obj;
  return [];
}

export function createCliReader({ id, command, args = [], cwd, env, name, timeoutMs = 60000 } = {}) {
  const a = async (extra, opts = {}) => run(command, [...args, ...extra], { timeoutMs, cwd, env, ...opts });
  const j = async (extra, keys) => {
    const r = await a(extra);
    const obj = extractJson(r.stdout);
    return { r, obj, rows: rowsOf(obj, keys) };
  };
  const label = id || name || command;

  return {
    id: `cli:${label}`,
    kind: "cli",
    command,
    args,
    describe: () => ({ reader: "cli", id: label, command, args }),
    version: async () => {
      const r = await a(["version"]);
      const obj = extractJson(r.stdout);
      return envelope({ tool: `cli:${label}`, command: "version", ok: r.code === 0, data: obj?.data ?? obj ?? { raw: r.stdout.trim().slice(0, 400), stderr: r.stderr.trim().slice(0, 400) } });
    },
    status: async () => {
      for (const cmd of [["status", "--strict-read-only"], ["status"], []]) {
        if (!cmd.length) break;
        const r = await a(cmd);
        const obj = extractJson(r.stdout);
        if (obj) {
          const data = obj.data ?? obj;
          if (data && (data.state || data.messages || data.message_count !== undefined || obj.ok !== undefined)) {
            return envelope({ tool: `cli:${label}`, command: "status", ok: obj.ok !== false, data: { state: data.state ?? (obj.ok === false ? "needs_access" : "ready"), ...data } });
          }
        }
      }
      const r2 = await a(["status"]);
      return envelope({ tool: `cli:${label}`, command: "status", ok: false, data: { state: "needs_access", detail: "外部读取器未返回可识别状态", stderr: r2.stderr.trim().slice(0, 400), stdout: r2.stdout.trim().slice(0, 400) } });
    },
    sessions: async ({ limit = 80, typeFilter } = {}) => {
      const argv = ["sessions", "--limit", String(limit)];
      if (typeFilter) argv.push("--type-filter", String(typeFilter));
      const { r, obj, rows } = await j(argv, ["sessions", "chats", "rows"]);
      if (rows.length) return envelope({ tool: `cli:${label}`, command: "sessions", data: { sessions: rows } });
      // 回退到 hub 兼容命令
      const nm = await j(["new-messages"], ["messages"]);
      const groups = new Map();
      for (const m of nm.rows) {
        const chat = String(m.chat ?? m.session ?? "未知会话");
        if (!groups.has(chat)) groups.set(chat, { name: chat, kind: inferKind(chat), message_count: 0, last_ts: null });
        const g = groups.get(chat);
        g.message_count += 1;
        const ts = m.ts ? (m.ts > 1e12 ? m.ts : m.ts * 1000) : m.time ? Date.parse(m.time) : null;
        if (ts && (!g.last_ts || ts > g.last_ts)) g.last_ts = ts;
      }
      return envelope({ tool: `cli:${label}`, command: "sessions", ok: r.code === 0, data: { sessions: [...groups.values()].sort((x, y) => (y.last_ts ?? 0) - (x.last_ts ?? 0)) } });
    },
    resolveChat: async (chatName, { typeFilter } = {}) => {
      const argv = ["resolve-chat", String(chatName)];
      if (typeFilter) argv.push("--type-filter", String(typeFilter));
      const { obj, rows } = await j(argv, ["candidates"]);
      const data = obj?.data ?? obj ?? {};
      // 上游契约：resolve-chat 返回 data.candidates[]，每项含 username / display_name / chat_type
      const first = (Array.isArray(data.candidates) && data.candidates[0]) || rows[0] || null;
      if (first && typeof first === "object") {
        const talker = String(first.username ?? first.talker ?? first.chatroom_id ?? "");
        if (talker) {
          return envelope({
            tool: `cli:${label}`, command: "resolve-chat",
            data: {
              chat: String(first.display_name ?? first.nick_name ?? first.remark ?? first.name ?? talker),
              talker,
              kind: String(first.chat_type ?? first.type_filter ?? inferKind(chatName)),
              ambiguous: (data.candidates ?? rows).length > 1,
              candidates: (data.candidates ?? rows).slice(0, 10).map((x) => x.display_name ?? x.name ?? x.username ?? x),
            },
          });
        }
      }
      if (data.chat || data.talker) return envelope({ tool: `cli:${label}`, command: "resolve-chat", data: { chat: data.chat ?? data.talker, talker: data.talker ?? data.chat, kind: data.kind ?? inferKind(chatName), ambiguous: !!data.ambiguous, candidates: data.candidates ?? [] } });
      const s = await createCliReader({ id: label, command, args, cwd, env, timeoutMs }).sessions({ limit: 500 });
      const hit = s.data.sessions.find((x) => String(x.name).includes(String(chatName)));
      if (!hit) return envelope({ tool: `cli:${label}`, command: "resolve-chat", ok: false, data: { state: "not_found", candidates: [] } });
      return envelope({ tool: `cli:${label}`, command: "resolve-chat", data: { chat: hit.name, talker: hit.name, kind: hit.kind ?? inferKind(hit.name), ambiguous: false, candidates: [hit.name] } });
    },
    timeline: async (talker, { limit = 200, offset = 0, displayOrder = "asc", since, before } = {}) => {
      const argv = ["timeline", String(talker), "--limit", String(limit), "--offset", String(offset), "--display-order", displayOrder === "desc" ? "desc" : "asc", "--include-media-paths", "false"];
      if (since) argv.push("--since", String(since));
      if (before) argv.push("--before", String(before));
      const { r, obj, rows } = await j(argv, ["messages", "rows"]);
      if (rows.length) {
        const data = obj?.data ?? obj ?? {};
        return envelope({
          tool: `cli:${label}`, command: "timeline",
          data: { talker, chat: talker, messages: rows.map((m) => toReaderMessage(m, { chat: talker })), query: data.query ?? { has_more: rows.length >= limit, next_offset: rows.length >= limit ? offset + limit : null } },
        });
      }
      // 回退：new-messages + 过滤
      const nm = await j(["new-messages"], ["messages"]);
      let msgs = nm.rows.filter((m) => String(m.chat ?? m.session ?? "") === String(talker) || String(m.chat ?? "").includes(String(talker)));
      msgs = sortByTime(msgs.map((m) => toReaderMessage(m, { chat: talker })), displayOrder === "desc" ? "desc" : "asc");
      const p = paginate(msgs, { limit, offset });
      return envelope({ tool: `cli:${label}`, command: "timeline", ok: r.code === 0, data: { talker, chat: talker, messages: p.rows, query: p.query } });
    },
    members: async (chatroomId, { limit = 500 } = {}) => {
      const { obj, rows } = await j(["members", String(chatroomId), "--limit", String(limit), "--strict-read-only"], ["members"]);
      if (rows.length) return envelope({ tool: `cli:${label}`, command: "members", data: { chat: chatroomId, members: rows } });
      const t = await createCliReader({ id: label, command, args, cwd, env, timeoutMs }).timeline(chatroomId, { limit: 5000 });
      const seen = new Map();
      for (const m of t.data.messages) {
        if (!seen.has(m.sender)) seen.set(m.sender, { name: m.sender, id: m.sender_id, message_count: 0 });
        seen.get(m.sender).message_count += 1;
      }
      return envelope({ tool: `cli:${label}`, command: "members", data: { chat: chatroomId, members: [...seen.values()].slice(0, limit), note: obj ? undefined : "由 timeline 推断" } });
    },
    search: async (keyword, { limit = 100, offset = 0, maxTextChars = 240, inChat, after, before } = {}) => {
      const argv = ["search", String(keyword), "--limit", String(limit), "--offset", String(offset), "--max-text-chars", String(maxTextChars)];
      if (inChat) argv.push("--in", String(inChat));
      if (after) argv.push("--after", String(after));
      if (before) argv.push("--before", String(before));
      const { r, obj, rows } = await j(argv, ["messages", "rows"]);
      const data = obj?.data ?? obj ?? {};
      if (rows.length || r.code === 0) {
        return envelope({ tool: `cli:${label}`, command: "search", data: { keyword, messages: rows.map((m) => toReaderMessage(m)), query: data.query ?? { has_more: rows.length >= limit, next_offset: rows.length >= limit ? offset + limit : null } } });
      }
      return envelope({ tool: `cli:${label}`, command: "search", ok: false, data: { keyword, messages: [], stderr: r.stderr.trim().slice(0, 400) } });
    },
    sql: async ({ query, subdir = "contact", file = "contact.db", limit = 100 } = {}) => {
      const { obj, rows } = await j(["sql", String(query), "--subdir", subdir, "--file", file, "--limit", String(limit)], ["rows"]);
      return envelope({ tool: `cli:${label}`, command: "sql", data: { rows, raw: rows.length ? undefined : obj } });
    },
  };
}
