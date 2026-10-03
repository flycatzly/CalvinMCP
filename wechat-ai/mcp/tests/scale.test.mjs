// 规模与增量语义测试。
// 重点不是"跑得快"，而是**算法行为**：
//  1) 逐会话索引时，只重算受影响会话/发送者（用哨兵值证明其它会话没被重算）
//  2) 时间窗语义：只给 days / since 时不能退化成零长度窗口
//  3) groupLimit 真正生效
//  4) 渲染器返回值统一成 { name: path }
// 另附一个宽松的耗时上界，防止将来退化成 O(n^2)。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "scale-test-"));
process.env.WECHAT_AI_HOME = ROOT;

let passed = 0, failed = 0;
const fails = [];
const t = async (name, fn) => {
  try { await fn(); passed += 1; console.log("  ✓ " + name); }
  catch (e) { failed += 1; fails.push(name + " :: " + (e?.message ?? e)); console.log("  ✗ " + name + " :: " + (e?.message ?? e)); }
};
const eq = (a, b, m) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error((m ?? "不相等") + "：期望 " + JSON.stringify(b) + "，实际 " + JSON.stringify(a)); };
const ok = (v, m) => { if (!v) throw new Error(m ?? "断言失败"); };

const store = await import(new URL("../lib/store.mjs", import.meta.url).href);
const ingest = await import(new URL("../lib/ingest.mjs", import.meta.url).href);
const { resolveWindow } = await import(new URL("../lib/timewin.mjs", import.meta.url).href);
const srv = await import(new URL("../server.mjs", import.meta.url).href);
const call = async (name, args) => {
  const r = await srv.handleRpc({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args ?? {} } });
  const res = r.result ?? {};
  if (res.isError) throw new Error(name + " 失败：" + (res.structuredContent?.error ?? ""));
  return res.structuredContent ?? {};
};

const db = store.openStore();
const now = Date.now();
const dayMs = 86400_000;
const SESSIONS = 40;
const PER = 200;

// ---- 造数据：40 个会话 x 200 条 ----
for (let s = 0; s < SESSIONS; s++) {
  const name = "会话" + s;
  const msgs = [];
  for (let i = 0; i < PER; i++) {
    msgs.push({
      session_name: name, session_kind: s % 2 ? "group" : "private",
      sender: i % 3 === 0 ? "我" : "成员" + (i % 5), is_owner: i % 3 === 0,
      ts: now - i * 3600_000, content: i % 20 === 0 ? "有项目方找 KOL 投放，预算 3000" : "日常消息 " + i,
    });
  }
  ingest.ingestMessages(db, msgs, { source: "scale" });
}

console.log("\n1) 增量重算语义");
await t("每个会话的消息数与首末时间正确", async () => {
  const rows = db.prepare("SELECT name, msg_count, first_ts, last_ts FROM sessions ORDER BY name").all();
  eq(rows.length, SESSIONS, "会话数");
  for (const r of rows) {
    eq(r.msg_count, PER, r.name + " 计数");
    ok(r.first_ts < r.last_ts, r.name + " 首末时间");
  }
});
await t("联系人统计只覆盖出现过的发送者", async () => {
  const rows = db.prepare("SELECT name, msg_count FROM contacts WHERE msg_count > 0").all();
  ok(rows.length >= 6 && rows.length <= 12, "联系人数量=" + rows.length + "（应为「我」+ 成员0-4）");
});

// 哨兵：人为改坏一个会话的计数，然后**只往另一个会话写**，验证坏值没有被重算
db.prepare("UPDATE sessions SET msg_count = 999999, first_ts = 0, last_ts = 0 WHERE name = '会话0'").run();
await t("写入会话A 不会重算会话B（证明是增量而非全量）", async () => {
  ingest.ingestMessages(db, [{ session_name: "会话7", session_kind: "group", sender: "新成员", ts: now, content: "只写这一条" }], { source: "scale" });
  const sentinel = db.prepare("SELECT msg_count, first_ts, last_ts FROM sessions WHERE name = '会话0'").get();
  eq(sentinel.msg_count, 999999, "会话0 的哨兵值应保持不动");
  eq(sentinel.first_ts, 0, "会话0 首时间应保持不动");
  const own = db.prepare("SELECT msg_count FROM sessions WHERE name = '会话7'").get();
  eq(own.msg_count, PER + 1, "被写入会话的计数应更新");
});
await t("全量重算能修正哨兵（维护路径仍可用）", async () => {
  store.recalcSessionCounts(db);
  eq(db.prepare("SELECT msg_count FROM sessions WHERE name = '会话0'").get().msg_count, PER);
});
await t("联系人增量：只刷新本次发送者", async () => {
  const before = db.prepare("SELECT msg_count FROM contacts WHERE name = '成员0'").get().msg_count;
  ingest.ingestMessages(db, [{ session_name: "会话9", session_kind: "group", sender: "成员0", ts: now, content: "增量" }], { source: "scale" });
  const after = db.prepare("SELECT msg_count FROM contacts WHERE name = '成员0'").get().msg_count;
  eq(after, before + 1, "被写发送者的计数应 +1");
  ok(db.prepare("SELECT COUNT(*) n FROM contacts WHERE msg_count > 0").get().n >= 6, "其它联系人不应消失");
});

console.log("\n2) 时间窗语义（零窗口回归）");
await t("resolveWindow 只给 days", async () => {
  const w = resolveWindow({ days: 7 });
  ok(w.hours > 160 && w.hours < 170, "hours=" + w.hours);
});
await t("wai_person 只给 days 能查到数据（曾经是 0 条）", async () => {
  const r = await call("wai_person", { name: "会话0", days: 400, limit: 100 });
  ok((r.messages ?? []).length > 0, "messages=" + (r.messages ?? []).length);
});
await t("wai_person 不传时间时默认全历史", async () => {
  const r = await call("wai_person", { name: "会话0", limit: 100 });
  ok((r.messages ?? []).length > 0, "messages=" + (r.messages ?? []).length);
});
await t("wai_person 只给 since 能查到数据", async () => {
  const r = await call("wai_person", { name: "会话0", since: new Date(now - 400 * dayMs).toISOString().slice(0, 10), limit: 100 });
  ok((r.messages ?? []).length > 0, "messages=" + (r.messages ?? []).length);
});
await t("wai_chat_history 只给 days 能查到数据", async () => {
  const r = await call("wai_chat_history", { chat: "会话0", days: 400, limit: 100 });
  ok((r.messages ?? []).length > 0, "messages=" + (r.messages ?? []).length);
});
await t("wai_topic 只给 days 能查到数据", async () => {
  const r = await call("wai_topic", { topic: "投放", days: 400 });
  ok(r.totals && r.totals.messages > 0, "totals=" + JSON.stringify(r.totals));
  ok((r.groups ?? []).length > 0 || (r.timeline ?? []).length > 0, "既没有 groups 也没有 timeline");
});
await t("显式 hours 仍然优先于默认", async () => {
  const r = await call("wai_chat_history", { chat: "会话0", hours: 3, limit: 100 });
  ok((r.messages ?? []).length <= 3, "3 小时窗口内不应超过 3 条");
});
await t("wai_brief 的 files 是对象而不是字符串", async () => {
  const r = await call("wai_brief", { hours: 24, out: path.join(ROOT, "brief") });
  ok(r.files && typeof r.files === "object" && !Array.isArray(r.files), "files 类型=" + typeof r.files);
  ok(Object.keys(r.files).length <= 5, "files 键数异常：" + Object.keys(r.files).length);
  for (const p of Object.values(r.files)) ok(fs.existsSync(p), "产物不存在：" + p);
});

console.log("\n3) 群聊上限");
await t("groupLimit 生效且报告群数受控", async () => {
  const r = await call("wai_group_daily", { hours: 24 * 400, groupLimit: 3, out: path.join(ROOT, "gd") });
  ok(r.groupCount <= 3, "groupCount=" + r.groupCount);
  eq(r.groupLimit, 3);
  ok(r.groupsTruncated >= 0, "应报告被截断的数量");
  const digest = fs.readFileSync(r.files.digest, "utf8");
  const headings = (digest.match(/^### /gm) || []).length;
  ok(headings <= 3, "日报正文群数=" + headings + "（应 <= 3）");
});
await t("不传 groupLimit 时使用默认 60", async () => {
  const r = await call("wai_group_daily", { hours: 24 * 400, out: path.join(ROOT, "gd2") });
  eq(r.groupLimit, 60);
});

console.log("\n4) 攒批写入（deferStats + flushIngestStats）结果与逐条一致");
await t("攒批写入后统计与逐条写入完全一致", async () => {
  const { flushIngestStats } = ingest;
  const pending = [];
  for (let s = 0; s < 12; s++) {
    const msgs = [];
    for (let i = 0; i < 40; i++) msgs.push({ session_name: "攒批" + s, session_kind: "group", sender: "丙", ts: now - i * 1000, content: "批量内容 " + i });
    pending.push(ingest.ingestMessages(db, msgs, { source: "scale", deferStats: true }));
  }
  const st = flushIngestStats(db, pending);
  ok(st.sessions === 12, "收尾会话数=" + st.sessions);
  const rows = db.prepare("SELECT name, msg_count FROM sessions WHERE name LIKE '攒批%' ORDER BY name").all();
  eq(rows.length, 12);
  for (const r of rows) eq(r.msg_count, 40, r.name);
  const c = db.prepare("SELECT msg_count FROM contacts WHERE name = '丙'").get();
  ok(c.msg_count >= 12 * 40, "联系人计数=" + c.msg_count);
});
await t("嵌套事务可重入（不会 cannot start a transaction within a transaction）", async () => {
  store.tx(db, () => {
    store.tx(db, () => { store.insertMessages(db, [{ session_name: "嵌套", session_kind: "group", sender: "丁", ts: now, content: "x" }], { source: "scale" }); });
  });
  eq(db.prepare("SELECT msg_count FROM sessions WHERE name = '嵌套'").get().msg_count, 1);
});

console.log("\n5) 逐会话索引的耗时上界（防 O(n^2) 退化）");
await t("40 个会话逐个索引 < 5 秒", async () => {
  const t0 = Date.now();
  for (let s = 100; s < 100 + SESSIONS; s++) {
    const msgs = [];
    for (let i = 0; i < PER; i++) msgs.push({ session_name: "批" + s, session_kind: "group", sender: "甲", ts: now - i * 1000, content: "内容 " + i });
    ingest.ingestMessages(db, msgs, { source: "scale" });
  }
  const ms = Date.now() - t0;
  ok(ms < 5000, "耗时 " + ms + "ms（阈值 5000ms）");
  console.log("      实测 " + ms + "ms / " + (SESSIONS * PER) + " 条");
});

console.log("\n" + "=".repeat(50));
if (fails.length) {
  console.log("失败项：");
  for (const f of fails) console.log("  ✗ " + f);
  console.log("");
}
console.log("=== " + passed + " passed, " + failed + " failed ===");
store.closeStore();
try { fs.rmSync(ROOT, { recursive: true, force: true, maxRetries: 3 }); } catch { /* ignore */ }
process.exit(failed === 0 ? 0 : 1);
