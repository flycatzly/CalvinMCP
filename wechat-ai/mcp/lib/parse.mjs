// 聊天内容解析：把多种导出/分享文本转成统一消息结构
import { extractUrls, safeFileName, stripControl, truncate } from "./util.mjs";
import { parseMessageTime } from "./timewin.mjs";

// 附件占位符（每个只出现一次，避免重复计数）
const ATTACH_MARK = [
  "图片", "视频", "语音", "文件", "表情", "链接", "位置", "转账", "红包",
  "小程序", "公众号", "音乐", "合并转发的聊天记录", "聊天记录", "动画表情", "名片", "接龙", "引用",
].map((k) => new RegExp("\\[" + k + "\\]", "g"));

const ATTACH_KIND = [
  [/图片|\u56fe\u7247/, "image"], [/视频|\u89c6\u9891/, "video"], [/语音|\u8bed\u97f3/, "voice"],
  [/文件|\u6587\u4ef6/, "file"], [/链接|\u94fe\u63a5/, "link"], [/表情|\u8868\u60c5/, "sticker"],
  [/小程序|\u5c0f\u7a0b\u5e8f/, "miniapp"], [/公众号|\u516c\u4f17\u53f7/, "article"],
  [/合并转发|\u5408\u5e76\u8f6c\u53d1/, "merged"],
];

/** 从一行文本里抽取附件占位符 */
export function extractAttachments(text) {
  const out = [];
  const s = String(text ?? "");
  for (const re of ATTACH_MARK) {
    for (const m of s.matchAll(new RegExp(re.source, "g"))) {
      let kind = "unknown";
      for (const [k, v] of ATTACH_KIND) if (k.test(m[0])) { kind = v; break; }
      out.push({ kind, marker: m[0] });
    }
  }
  return out;
}

const TIME = "(?:\\d{4}[-/.\u5e74]\\d{1,2}[-/.\u6708]\\d{1,2}\u65e5?(?:[ T]+\\d{1,2}[:\u65f6]\\d{1,2}(?::\\d{1,2})?)?|\\d{1,2}[-/.\u6708]\\d{1,2}\u65e5?(?:[ T]+\\d{1,2}:\\d{1,2}(?::\\d{1,2})?)?|\\d{1,2}:\\d{2}(?::\\d{2})?)";

/** 逐行解析：
 *  A) [2026-06-30 10:12] 张三: 内容
 *  B) 2026-06-30 10:12:33 张三  /  内容(下一行起)
 *  C) 张三 2026-06-30 10:12  /  内容(下一行起)
 *  D) 张三: 内容        （沿用上一条时间，逐条 +1 秒）
 *  E) 【群名】张三: 内容
 */
export function parseChatText(text, opts = {}) {
  const { defaultChat = "导入会话", refDate = new Date(), ownerNames = [] } = opts;
  const raw = stripControl(String(text ?? "")).replace(/\r\n?/g, "\n");
  const lines = raw.split("\n");
  const messages = [];
  let current = null;
  let lastTs = null;
  let chatTitle = null;
  let seq = 0;
  const ownerSet = new Set(["我", "自己", "本人", ...ownerNames]);

  const isOwner = (n) => ownerSet.has(String(n ?? "").trim());

  const push = () => {
    if (current && current.content.trim()) messages.push(current);
    current = null;
  };

  const reA = new RegExp("^\\[(" + TIME + ")\\]\\s*([^:：]{1,40})[:：]\\s*([\\s\\S]*)$");
  const reB = new RegExp("^(" + TIME + ")\\s+(.{1,40})$");
  const reC = new RegExp("^(.{1,40}?)\\s+(" + TIME + ")\\s*$");
  const reD = new RegExp("^([^:：\\[\\]]{1,40})[:：]\\s*([\\s\\S]*)$");
  // 群名标题：【群名】… 或 [群名]…；但 ASCII 方括号里若是时间戳则不是标题
  const reE = new RegExp("^(?:【([^】]{1,60})】|\\[([^\\]]{1,60})\\])\\s*(.*)$");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed) {
      if (current) current.content += "\n";
      continue;
    }

    // 标题块 1：Markdown H1（# 群名）——常见的 .md 导出首行
    if (chatTitle === null && messages.length === 0 && !current) {
      const h1 = trimmed.match(/^#\s+(.{1,80})$/);
      if (h1) {
        const cand = h1[1].replace(/[*_`]/g, "").trim();
        if (cand && !/^\d{4}[-/.年]\d{1,2}[-/.月]\d{1,2}/.test(cand) && !/^\d{1,2}:\d{2}/.test(cand)) {
          chatTitle = cand;
          continue;
        }
      }
    }

    // 标题块 2：【群名】/ [群名]
    if (chatTitle === null && messages.length === 0 && !current) {
      const mE = matchTitle(trimmed, reE);
      if (mE) {
        chatTitle = mE.title;
        const rest = mE.rest;
        if (rest) {
          const mRest = rest.match(reA) || rest.match(reD);
          if (mRest) { lines[i] = rest; i -= 1; continue; }
        }
        continue;
      }
    }

    const mA = trimmed.match(reA);
    if (mA) {
      push();
      const ts = parseMessageTime(mA[1], refDate);
      lastTs = ts;
      current = mkMsg(mA[2].trim(), ts, mA[3], isOwner(mA[2]));
      continue;
    }

    const mB = trimmed.match(reB);
    if (mB) {
      const ts = parseMessageTime(mB[1], refDate);
      const who = mB[2].trim();
      // 若下一行看起来像新的时间行，则 who 是发送者，内容在后续行
      push();
      lastTs = ts;
      current = mkMsg(who, ts, "", isOwner(who));
      continue;
    }

    const mC = trimmed.match(reC);
    if (mC) {
      push();
      const ts = parseMessageTime(mC[2], refDate);
      lastTs = ts;
      current = mkMsg(mC[1].trim(), ts, "", isOwner(mC[1]));
      continue;
    }

    const mE2 = matchTitle(trimmed, reE);
    if (mE2) {
      if (chatTitle === null) chatTitle = mE2.title;
      const rest = mE2.rest;
      if (rest) {
        const mRest = rest.match(reA) || rest.match(reD);
        if (mRest) {
          push();
          const who = (mRest[2] ?? "").trim();
          const ts = mRest[1] && /\d/.test(mRest[1]) ? parseMessageTime(mRest[1], refDate) : nextTs();
          lastTs = ts;
          current = mkMsg(who, ts, mRest[3] ?? "", isOwner(who));
          continue;
        }
      }
      continue;
    }

    const mD = trimmed.match(reD);
    if (mD && !/^(http|https)/i.test(trimmed)) {
      push();
      const ts = nextTs();
      lastTs = ts;
      current = mkMsg(mD[1].trim(), ts, mD[2], isOwner(mD[1]));
      continue;
    }

    if (current) {
      current.content += (current.content ? "\n" : "") + trimmed;
    } else {
      current = mkMsg(defaultChat, nextTs(), trimmed, false);
    }
  }
  push();

  function nextTs() {
    seq += 1;
    if (lastTs) return new Date(lastTs.getTime() + seq * 1000);
    return new Date(refDate.getTime() + seq * 1000);
  }

  return {
    format: "chat-text",
    title: chatTitle,
    chat: chatTitle || defaultChat,
    messages: finalize(messages, chatTitle || defaultChat),
  };
}

/** 判断是否是群名标题行；ASCII 方括号里是时间戳/消息头时返回 null */
function matchTitle(line, reE) {
  const m = String(line).match(reE);
  if (!m) return null;
  const title = (m[1] ?? m[2] ?? "").trim();
  if (!title) return null;
  if (/^\d{4}[-/.年]\d{1,2}[-/.月]\d{1,2}/.test(title)) return null;
  if (/^\d{1,2}:\d{2}/.test(title)) return null;
  return { title, rest: (m[3] ?? "").trim() };
}

function mkMsg(sender, ts, content, owner) {
  return {
    sender: String(sender ?? "").trim() || "未知",
    ts: ts instanceof Date && !Number.isNaN(ts.getTime()) ? ts.getTime() : null,
    content: String(content ?? ""),
    is_owner: !!owner,
  };
}

function finalize(messages, chat) {
  return messages
    .filter((m) => m.content.replace(/[\s\u200b]/g, "") !== "")
    .map((m) => {
      const links = extractUrls(m.content);
      const attachments = extractAttachments(m.content);
      return {
        chat,
        session_name: chat,
        sender: m.sender,
        ts: m.ts,
        content: m.content.trim(),
        is_owner: m.is_owner,
        links,
        attachments,
      };
    });
}

/** 解析 JSON 导出：支持数组、{messages}、{chats:[{name,messages}]}、reader 契约 */
export function parseJsonChat(obj, opts = {}) {
  const { defaultChat = "导入会话" } = opts;
  const out = [];
  const add = (chat, rec) => {
    const content = String(rec.content ?? rec.text ?? rec.message ?? rec.msg ?? "");
    if (!content.trim()) return;
    const tsRaw = rec.ts ?? rec.time ?? rec.timestamp ?? rec.date ?? null;
    let ts = null;
    if (typeof tsRaw === "number") ts = tsRaw > 1e12 ? tsRaw : tsRaw * (tsRaw > 1e9 ? 1000 : 1000);
    else if (tsRaw) ts = parseMessageTime(String(tsRaw), opts.refDate ?? new Date())?.getTime() ?? null;
    const sender = String(rec.sender ?? rec.from ?? rec.name ?? rec.speaker ?? rec.user ?? "未知");
    out.push({
      chat: rec.chat ?? rec.session ?? rec.group ?? chat ?? defaultChat,
      session_name: rec.chat ?? rec.session ?? rec.group ?? chat ?? defaultChat,
      sender,
      ts,
      content,
      is_owner: /^(我|自己|本人|me)$/i.test(sender),
      links: extractUrls(content),
      attachments: extractAttachments(content),
    });
  };

  const walk = (node, chatName) => {
    if (!node) return;
    if (Array.isArray(node)) {
      for (const it of node) walk(it, chatName);
      return;
    }
    if (typeof node !== "object") return;
    if (Array.isArray(node.chats)) {
      for (const c of node.chats) walk(c, c.name ?? c.chat ?? chatName);
      return;
    }
    if (Array.isArray(node.messages)) {
      const cname = node.name ?? node.chat ?? node.session ?? chatName;
      for (const m of node.messages) add(cname, m);
      return;
    }
    if (node.content !== undefined || node.text !== undefined || node.msg !== undefined) {
      add(chatName, node);
    }
  };
  walk(obj, defaultChat);
  // 时间缺失时按顺序补 1 秒间隔，保证排序稳定
  let prev = null;
  for (const m of out) {
    if (!m.ts) m.ts = prev ? prev + 1000 : (opts.refDate ?? new Date()).getTime();
    prev = m.ts;
  }
  return { format: "json", title: null, chat: out[0]?.chat ?? defaultChat, messages: out };
}

/** 统一入口：自动判格式 */
export function parseAny(text, opts = {}) {
  const s = String(text ?? "").trim();
  if (!s) return { format: "empty", title: null, chat: opts.defaultChat ?? "导入会话", messages: [] };
  if (s.startsWith("{") || s.startsWith("[")) {
    try {
      return parseJsonChat(JSON.parse(s), opts);
    } catch { /* 回退到文本解析 */ }
  }
  const lines = s.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length === 1 && extractUrls(s).length === 1 && s.length < 500) {
    return { format: "link", title: null, chat: opts.defaultChat ?? "链接", messages: [{ chat: opts.defaultChat ?? "链接", session_name: opts.defaultChat ?? "链接", sender: "分享", ts: Date.now(), content: s, links: extractUrls(s), attachments: [], is_owner: false }] };
  }
  return parseChatText(s, opts);
}

/** 生成 slug 用的短标题 */
export function guessTitle(text, fallback = "微信内容") {
  const first = String(text ?? "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean)[0] ?? "";
  return safeFileName(truncate(first.replace(/^[\[【(（][^\]】)）]*[\]】)）]/, "").trim(), 40), 40) || fallback;
}

export { extractUrls, truncate };
