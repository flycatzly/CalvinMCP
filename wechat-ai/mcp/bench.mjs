#!/usr/bin/env node
/**
 * 规模基准：用合成的「真实体量」数据测热路径耗时，作为优化前后的对照。
 *
 *   node bench.mjs                 # 默认 20 万条消息 / 600 个会话
 *   node bench.mjs --n 500000 --sessions 1200
 *   node bench.mjs --runs 1        # 单跑模式（不取中位）
 *   node bench.mjs --json          # 只输出机器可读结果（每行 3 跑取中位，带 spreadMs 极差）
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
const RUNS = Math.max(1, num("--runs", 3));
const JSON_ONLY = argv.includes("--json");

// 跨跑自污染防护（轮13）：同进程连跑同一 fn 时，跑 1 的 20 万行垃圾会让跑 2/3 计算行变慢 ~2×
// （机制=GC 压力；--runs 1 立即回基线可证）。3 跑中位要求每次测量前强制 GC，需 --expose-gc；
// 未带时自动以 --expose-gc 重启自身（一次性，WAI_BENCH_REEXEC 防环），GC 不计入计时。
if (RUNS > 1 && typeof global.gc !== "function" && !process.env.WAI_BENCH_REEXEC) {
  const { spawnSync } = await import("node:child_process");
  const r = spawnSync(process.execPath, ["--expose-gc", ...process.argv.slice(1)], {
    stdio: "inherit",
    env: { ...process.env, WAI_BENCH_REEXEC: "1" },
  });
  process.exit(r.status ?? 1);
}

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "wai-bench-"));
process.env.WECHAT_AI_HOME = ROOT;

const results = [];
// 稳态化（轮13）：除语料写入外每行 3 跑取中位，极差 >15% 时随行输出 [N 跑 a/b/c]——单跑会被
// 同机噪声误读（写路径行曾现 448-704ms 双峰）。重复跑必须做 GC 隔离（见 time() 与启动自重启），
// 否则跑 1 的垃圾让跑 2/3 计算行慢 ~2×（跨跑自污染）。可重复性前提：写路径行 fn() 内部自带
// snapshot() 同起点库副本（每次跑独立重建），工具行时间窗按调用时刻毫秒级解析（analysisCache
// 键必不同，各跑均走冷路径），读行只读。语料写入行是 setup 行（INSERT OR IGNORE，重跑变空插入），单跑。
const timeOnce = async (name, fn) => {
  const t0 = process.hrtime.bigint();
  const out = await fn();
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  results.push({ name, ms, spreadMs: 0, note: typeof out === "string" ? out : "" });
  if (!JSON_ONLY) console.log("  " + name.padEnd(38, " ") + ms.toFixed(0).padStart(7) + " ms  " + (typeof out === "string" ? out : ""));
  return out;
};
const time = async (name, fn) => {
  const runs = [];
  let out;
  for (let i = 0; i < RUNS; i++) {
    // 每次测量前强制 GC（含首跑）：清掉上一跑/上一行的垃圾，跑与跑、行与行同起点。
    global.gc?.();
    const t0 = process.hrtime.bigint();
    out = await fn();
    runs.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  runs.sort((a, b) => a - b);
  const ms = runs[Math.floor(runs.length / 2)];
  const spreadMs = runs[runs.length - 1] - runs[0];
  results.push({ name, ms, spreadMs: Math.round(spreadMs), note: typeof out === "string" ? out : "" });
  if (!JSON_ONLY) {
    const flag = RUNS > 1 && ms > 0 && spreadMs / ms > 0.15 ? "  [" + RUNS + " 跑 " + runs.map((r) => r.toFixed(0)).join("/") + "]" : "";
    console.log("  " + name.padEnd(38, " ") + ms.toFixed(0).padStart(7) + " ms  " + (typeof out === "string" ? out : "") + flag);
  }
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
await timeOnce("写入 " + N.toLocaleString() + " 条消息", () => {
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

const { searchMessages, messagesInWindow, messagesRaw, messagesForAnalyze, listSessions, storeStats } = await import(new URL("./lib/store.mjs", import.meta.url).href);
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
  const a = analyze({ messages: messagesForAnalyze({ ...w24, limit: 500000 }), ...w24 });
  return a.coverage.messages + " 条 / " + a.coverage.sessions + " 会话";
});
await time("analyze 7d", () => {
  const a = analyze({ messages: messagesForAnalyze({ ...w7, limit: 500000 }), ...w7 });
  return a.coverage.messages + " 条";
});
await time("analyze 400d（复联路径）", () => {
  const a = analyze({ messages: messagesForAnalyze({ ...w365, limit: 500000 }), ...w365 });
  return a.coverage.messages.toLocaleString() + " 条";
});
await time("reactivation 400d", () => {
  // 与 wai_reactivation 工具同路径：5 列裸行取数（跳过 rowToMessage 映射）
  const r = reactivation({ messages: messagesRaw({ ...w365, limit: 500000 }), inactiveDays: 21 });
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
// 三条路径各跑在「同一起点」的库副本上：此前串行跑同一个库时，越晚的路径背着越大的库
// （20 万 → 29 万行，事务提交成本随库变大超线性增长），看起来「deferStats 更慢」是测量混淆而非实现差异。
const { ingestMessages, flushIngestStats, ingestSessionBatches } = await import(new URL("./lib/ingest.mjs", import.meta.url).href);

const snapshot = (name) => {
  const file = path.join(ROOT, `bench-snap-${name}.db`);
  try { fs.rmSync(file, { force: true }); } catch { /* ignore */ }
  db.exec("VACUUM INTO '" + file.replace(/\\/g, "/").replace(/'/g, "''") + "'");
  return openStore(file);
};
const makeMsgs = (prefix, s, sender) => {
  const msgs = [];
  for (let i = 0; i < 50; i++) msgs.push({ session_name: `${prefix}${s}`, session_kind: "group", sender, ts: now - i * 1000, content: "内容 " + i });
  return msgs;
};

await time("整批写入（单事务对照，" + SESSIONS + " 会话）", () => {
  const db1 = snapshot("one");
  const all = [];
  for (let s = 0; s < SESSIONS; s++) all.push(...makeMsgs("单批会话", s, "甲"));
  ingestMessages(db1, all, { source: "bench-one" });
  db1.close();
  return (SESSIONS * 50).toLocaleString() + " 条 / 1 次调用";
});
await time("逐会话索引（每会话一事务 + 即时统计）", () => {
  const db2 = snapshot("per");
  for (let s = 0; s < SESSIONS; s++) ingestMessages(db2, makeMsgs("即时会话", s, "乙"), { source: "bench-a" });
  db2.close();
  return (SESSIONS * 50).toLocaleString() + " 条 / " + SESSIONS + " 次调用";
});
await time("逐会话索引（deferStats + 攒批收尾）", () => {
  const db3 = snapshot("defer");
  const pending = [];
  for (let s = 0; s < SESSIONS; s++) pending.push(ingestMessages(db3, makeMsgs("批量会话", s, "丙"), { source: "bench-b", deferStats: true }));
  const st = flushIngestStats(db3, pending);
  db3.close();
  return (SESSIONS * 50).toLocaleString() + " 条 / 收尾 " + st.sessions + " 会话 " + st.senders + " 发送者";
});
await time("逐会话索引（每 100 会话一事务 + 攒批统计，wai_vault_scan 形态）", () => {
  const db4 = snapshot("chunk");
  const batches = [];
  for (let s = 0; s < SESSIONS; s++) batches.push(makeMsgs("攒批会话", s, "丁"));
  const w = ingestSessionBatches(db4, batches, { source: "bench-c" });
  db4.close();
  return (SESSIONS * 50).toLocaleString() + " 条 / " + w.chunks + " 批提交 / 插入 " + w.inserted;
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
