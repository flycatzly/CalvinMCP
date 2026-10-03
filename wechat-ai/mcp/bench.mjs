#!/usr/bin/env node
/**
 * 规模基准：用合成的「真实体量」数据测热路径耗时，作为优化前后的对照。
 *
 *   node bench.mjs                 # 默认 20 万条消息 / 600 个会话
 *   node bench.mjs --n 500000 --sessions 1200
 *   node bench.mjs --json          # 只输出机器可读结果
 *
 * 数据全部合成，写入临时数据根，不影响 ~/.wechat-ai。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const argv = process.argv.slice(2);
const num = (flag, dflt) => {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] ? Number(argv[i + 1]) : dflt;
};
const N = num("--n", 200_000);
const SESSIONS = num("--sessions", 600);
const JSON_ONLY = argv.includes("--json");

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "wai-bench-"));
process.env.WECHAT_AI_HOME = ROOT;

const results = [];
const time = async (name, fn) => {
  const t0 = process.hrtime.bigint();
  const out = await fn();
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  results.push({ name, ms, note: typeof out === "string" ? out : "" });
  if (!JSON_ONLY) console.log("  " + name.padEnd(38, " ") + ms.toFixed(0).padStart(7) + " ms  " + (typeof out === "string" ? out : ""));
  return out;
};

// ---------------- 合成数据 ----------------
// 内容分布刻意贴近真实：绝大多数是无关键词的日常对话，少量含商机信号，少量含链接。
const CHITCHAT = ["收到", "好的没问题", "哈哈哈哈", "今天天气不错", "我先看一下", "稍等我看下", "嗯嗯理解了", "这个我记一下", "好的明天再说", "辛苦啦"];
const WORK = ["这个需求我这边排一下期", "先对齐一下范围", "文档我更新了", "我们内部过一下", "这块按上周说的做", "进度同步一下"];
const DEAL = ["有项目方找 KOL 做投放，预算 3000-5000 RMB，AI 方向优先", "品牌方招募 AI 博主，预算 8000，需要主页和数据", "想找讲师做企业内训，2 天课程，预算可谈", "麻烦发一下 invoice，我们这周安排结算", "初稿周四前需要，brief 已发邮箱"];
const LINKS = ["https://example.com/campaign-brief", "https://mp.weixin.qq.com/s/AbCdEf123456", "https://x.com/someone/status/1234567890"];
const OWNER = ["好的，我今天晚些把报价整理给你", "我这边可以，麻烦先发大纲", "初稿我今晚 8 点前给你", "我整理一下数据一起发你"];
const SENDER = ["王工", "李经理", "小艾", "老张", "群友A", "群友B", "资源君", "项目经理", "渠道老刘"];

function pick(arr, i) { return arr[i % arr.length]; }

const { openStore, tx } = await import(new URL("./lib/store.mjs", import.meta.url).href);
const { sessionId } = await import(new URL("./lib/store.mjs", import.meta.url).href);

const db = openStore();
const now = Date.now();
const dayMs = 86400_000;
const spanDays = 400;

const sessions = [];
for (let s = 0; s < SESSIONS; s++) {
  const isGroup = s % 3 !== 0;
  sessions.push({
    id: sessionId(`会话${s}`, isGroup ? "group" : "private"),
    name: isGroup ? `业务群-${s}` : `联系人${s}`,
    kind: isGroup ? "group" : "private",
    isGroup,
  });
}

console.log("合成数据：" + N.toLocaleString() + " 条消息 / " + SESSIONS + " 个会话 / 覆盖 " + spanDays + " 天");
await time("写入 " + N.toLocaleString() + " 条消息", () => {
  const stmt = db.prepare(`INSERT OR IGNORE INTO messages
    (id,session_id,session_name,session_kind,sender,sender_id,is_owner,ts,day,content,links,attachments,source,run_id)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const sessStmt = db.prepare(`INSERT OR REPLACE INTO sessions(id,name,kind,is_group,first_ts,last_ts,msg_count,source) VALUES(?,?,?,?,?,?,?,?)`);
  const perSession = new Map();
  tx(db, () => {
    for (let i = 0; i < N; i++) {
      const s = sessions[i % SESSIONS];
      // 时间分布：近期更密（模拟真实聊天），24h 窗口内约 1.5% 的消息
      const ageDays = Math.floor(Math.pow(i / N, 3) * spanDays);
      const ts = now - ageDays * dayMs - (i % dayMs);
      const roll = i % 100;
      let content;
      let isOwner = 0;
      if (roll < 2) content = pick(DEAL, i);
      else if (roll < 5) content = pick(LINKS, i) + " " + pick(WORK, i);
      else if (roll < 12) { content = pick(OWNER, i); isOwner = 1; }
      else if (roll < 40) content = pick(WORK, i);
      else content = pick(CHITCHAT, i);
      const links = JSON.stringify(roll >= 2 && roll < 5 ? [content.split(" ")[0]] : []);
      const sender = isOwner ? "我" : pick(SENDER, i);
      const mid = "m" + i.toString(36).padStart(8, "0");
      stmt.run(mid, s.id, s.name, s.kind, sender, null, isOwner, ts, new Date(ts).toISOString().slice(0, 10), content, links, "[]", "bench", null);
      const p = perSession.get(s.id) ?? { first: ts, last: ts, n: 0 };
      p.first = Math.min(p.first, ts); p.last = Math.max(p.last, ts); p.n += 1;
      perSession.set(s.id, p);
    }
    for (const s of sessions) {
      const p = perSession.get(s.id);
      if (p) sessStmt.run(s.id, s.name, s.kind, s.isGroup ? 1 : 0, p.first, p.last, p.n, "bench");
    }
  });
  return "含会话表";
});

db.exec("ANALYZE");

const { searchMessages, messagesInWindow, listSessions, storeStats } = await import(new URL("./lib/store.mjs", import.meta.url).href);
const { analyze, reactivation } = await import(new URL("./lib/signals.mjs", import.meta.url).href);
const { freshness } = await import(new URL("./lib/ingest.mjs", import.meta.url).href);

await time("storeStats", () => {
  const s = storeStats();
  return s.messages.toLocaleString() + " 条";
});
await time("listSessions(limit 200)", () => listSessions({ limit: 200 }).length + " 个会话");
await time("searchMessages 常见词（早停）", () => searchMessages({ keyword: "报价", limit: 50 }).length + " 命中");
await time("searchMessages 稀有词（全表扫描）", () => searchMessages({ keyword: "invoice", limit: 50 }).length + " 命中");
await time("searchMessages 不存在词（最坏情况）", () => searchMessages({ keyword: "绝不可能出现的词组XYZ", limit: 50 }).length + " 命中");
await time("searchMessages 不存在的多关键词", () => searchMessages({ keywords: ["绝不可能A", "绝不可能B"], limit: 50 }).length + " 命中");
await time("searchMessages 带会话限定", () => searchMessages({ keyword: "报价", chat: "业务群-1", limit: 50 }).length + " 命中");

const w24 = { sinceMs: now - dayMs, untilMs: now };
const w7 = { sinceMs: now - 7 * dayMs, untilMs: now };
const w365 = { sinceMs: now - spanDays * dayMs, untilMs: now };

await time("messagesInWindow 24h", () => messagesInWindow({ ...w24, limit: 500000 }).length + " 条");
await time("messagesInWindow 7d", () => messagesInWindow({ ...w7, limit: 500000 }).length + " 条");
await time("messagesInWindow 400d（全量）", () => messagesInWindow({ ...w365, limit: 500000 }).length + " 条");
await time("analyze 24h", () => {
  const a = analyze({ messages: messagesInWindow({ ...w24, limit: 500000 }), ...w24 });
  return a.coverage.messages + " 条 / " + a.coverage.sessions + " 会话";
});
await time("analyze 7d", () => {
  const a = analyze({ messages: messagesInWindow({ ...w7, limit: 500000 }), ...w7 });
  return a.coverage.messages + " 条";
});
await time("analyze 400d（复联路径）", () => {
  const a = analyze({ messages: messagesInWindow({ ...w365, limit: 500000 }), ...w365 });
  return a.coverage.messages.toLocaleString() + " 条";
});
await time("reactivation 400d", () => {
  const r = reactivation({ messages: messagesInWindow({ ...w365, limit: 500000 }), inactiveDays: 21 });
  return r.all.length + " 个候选";
});
await time("freshness", () => {
  const f = freshness();
  return f.messages.toLocaleString() + " 条";
});

// ---------------- 端到端 ----------------
const srv = await import(new URL("./server.mjs", import.meta.url).href);
const call = async (name, args) => {
  const r = await srv.handleRpc({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args ?? {} } });
  const res = r.result ?? {};
  if (res.isError) throw new Error(name + " 失败：" + (res.structuredContent?.error ?? ""));
  return res.structuredContent ?? {};
};
await time("工具 wai_db_search", async () => {
  const r = await call("wai_db_search", { query: "报价", limit: 30 });
  return (r.count ?? 0) + " 命中";
});
await time("工具 wai_chat_search（本地源）", async () => {
  const r = await call("wai_chat_search", { query: "投放", limit: 50 });
  return (r.count ?? 0) + " 命中";
});
await time("工具 wai_person", async () => {
  const privateIdx = Math.max(0, Math.floor((SESSIONS - 1) / 3) * 3);
const r = await call("wai_person", { name: "联系人" + privateIdx, limit: 200, days: 400 });
  return ((r.messages?.length ?? r.count ?? 0)) + " 条";
});
await time("工具 wai_group_daily 24h", async () => {
  const r = await call("wai_group_daily", { hours: 24, out: ROOT + "/gd24" });
  return (r.groupCount ?? 0) + " 群";
});
await time("工具 wai_group_daily 7d", async () => {
  const r = await call("wai_group_daily", { hours: 168, out: ROOT + "/gd7" });
  return (r.groupCount ?? 0) + " 群";
});
await time("工具 wai_brief 24h", async () => {
  const r = await call("wai_brief", { hours: 24, out: ROOT + "/brief" });
  return Object.keys(r.files ?? {}).length + " 产物";
});
await time("工具 wai_reactivation 400d", async () => {
  const r = await call("wai_reactivation", { days: 400, inactiveDays: 21, out: ROOT + "/react" });
  return JSON.stringify(r.bands ?? {});
});
await time("工具 wai_today", async () => {
  const r = await call("wai_today", { minPriority: 1, limit: 10 });
  return ((r.items?.length ?? 0)) + " 项";
});

// ---------------- 增量索引路径（曾经是 O(会话数 x 消息数)） ----------------
const { ingestMessages } = await import(new URL("./lib/ingest.mjs", import.meta.url).href);
await time("逐会话增量索引 " + SESSIONS + " 个会话", () => {
  for (let s = 0; s < SESSIONS; s++) {
    const msgs = [];
    for (let i = 0; i < 50; i++) {
      msgs.push({ session_name: `增量会话${s}`, session_kind: "group", sender: "甲", ts: now - i * 1000, content: "增量内容 " + i });
    }
    ingestMessages(db, msgs, { source: "bench-ink" });
  }
  return (SESSIONS * 50).toLocaleString() + " 条 / " + SESSIONS + " 次调用";
});

// 对比：逐个会话各提交一次事务 vs 攒起来一次性收尾
const { flushIngestStats } = await import(new URL("./lib/ingest.mjs", import.meta.url).href);
await time("逐会话索引（每次立即重算统计）", () => {
  for (let s = 0; s < SESSIONS; s++) {
    const msgs = [];
    for (let i = 0; i < 50; i++) msgs.push({ session_name: `即时会话${s}`, session_kind: "group", sender: "乙", ts: now - i * 1000, content: "内容 " + i });
    ingestMessages(db, msgs, { source: "bench-a" });
  }
  return (SESSIONS * 50).toLocaleString() + " 条 / " + SESSIONS + " 次调用";
});
await time("逐会话索引（批量收尾，deferStats）", () => {
  const pending = [];
  for (let s = 0; s < SESSIONS; s++) {
    const msgs = [];
    for (let i = 0; i < 50; i++) msgs.push({ session_name: `批量会话${s}`, session_kind: "group", sender: "丙", ts: now - i * 1000, content: "内容 " + i });
    pending.push(ingestMessages(db, msgs, { source: "bench-b", deferStats: true }));
  }
  const st = flushIngestStats(db, pending);
  return (SESSIONS * 50).toLocaleString() + " 条 / 收尾 " + st.sessions + " 会话 " + st.senders + " 发送者";
});

const total = results.reduce((a, b) => a + b.ms, 0);
if (JSON_ONLY) {
  console.log(JSON.stringify({ n: N, sessions: SESSIONS, totalMs: Math.round(total), results }, null, 2));
} else {
  console.log("\n合计 " + (total / 1000).toFixed(1) + " 秒；最慢 5 项：");
  for (const r of [...results].sort((a, b) => b.ms - a.ms).slice(0, 5)) {
    console.log("  " + r.ms.toFixed(0).padStart(7) + " ms  " + r.name + "  " + r.note);
  }
  console.log("\n数据根 " + ROOT);
}
if (!process.argv.includes("--keep")) { try { fs.rmSync(ROOT, { recursive: true, force: true, maxRetries: 3 }); } catch { /* ignore */ } }
