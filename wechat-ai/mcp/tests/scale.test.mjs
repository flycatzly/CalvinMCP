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
await t("wai_person 支持按发送者建档（无同名会话时回退）", async () => {
  // 固件里「成员1」只是发送者（会话叫 会话0-39），旧实现直接报「找不到」
  const r = await call("wai_person", { name: "成员1", limit: 50 });
  eq(r.matched_by, "sender", "应按发送者命中");
  eq(r.chat, "成员1");
  ok((r.messages ?? []).length > 0, "发送者视角应取到消息");
  ok((r.messages ?? []).every((m) => m.sender === "成员1"), "只应包含该发送者的消息");
});
await t("仅是发送者的名字走 wai_reply_draft 时给出可执行错误", async () => {
  const r = await srv.handleRpc({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "wai_reply_draft", arguments: { name: "成员2" } } });
  ok(r.result?.isError, "应报错（回复草稿需要会话上下文）");
  const msg = String(r.result?.structuredContent?.error ?? "");
  ok(msg.includes("发送者"), "错误应说明这是发送者：" + msg);
  ok(msg.includes("wai_chat_search") || msg.includes("wai_topic"), "错误应给出下一步：" + msg);
});

console.log("\n2b) 窗口取行列面（窄取列契约，防列面膨胀）");
await t("messagesInWindow 只返回审计过的消费列", async () => {
  const rows = store.messagesInWindow({ sinceMs: now - dayMs, untilMs: now + 1, limit: 5 });
  ok(rows.length > 0, "窗口内应有行");
  eq(Object.keys(rows[0]).sort(), ["attachments", "content", "id", "is_owner", "links", "sender", "sender_id", "session_kind", "session_name", "source", "ts"], "行键集合");
  eq(rows[0].attachments, [], "attachments 列不取，rowToMessage 兜底为空数组");
  ok(rows[0]._indexed === true, "_indexed 标记保留（links 索引期已提取）");
  eq(Object.keys(rows[0]).join(","), "id,session_name,session_kind,sender,sender_id,is_owner,ts,content,links,source,attachments", "行键序（JSON 序列化稳定性）");
  eq(typeof rows[0].is_owner, "boolean", "is_owner 必须是布尔");
});
await t("messagesInWindow 双映射路径逐行等价（对象行 rowToMessage vs 数组行 rowFromWindowTuple）", async () => {
  const o = (links, is_owner = 1) => ({ id: 7, session_name: "会话", session_kind: "group", sender: "成员", sender_id: "sid", is_owner, ts: 1700000000000, content: "正文", links, source: "scale" });
  const t10 = (links, is_owner = 1) => [7, "会话", "group", "成员", "sid", is_owner, 1700000000000, "正文", links, "scale"];
  for (const links of ['["https://a.example/x"]', "[]", "", null, "脏数据{", '["https://a.example/x","https://b.example/y"]']) {
    const viaObj = store.rowToMessage(o(links, 0));
    const viaTuple = store.rowFromWindowTuple(t10(links, 0));
    eq(JSON.stringify(viaTuple), JSON.stringify(viaObj), "links=" + String(links) + " 双路径 JSON 等价");
    eq(Object.keys(viaTuple).join(","), Object.keys(viaObj).join(","), "键序一致");
    ok(viaTuple._indexed === true, "_indexed 标记一致");
  }
  ok(Object.isFrozen(store.rowFromWindowTuple(t10("[]")).links), "空 links 快路径返回共享冻结数组（零变更点已审计）");
});
await t("messagesForAnalyze 行契约：键序固定、links 往返、is_owner 布尔", async () => {
  const rows = store.messagesForAnalyze({ sinceMs: now - dayMs, untilMs: now + 1, limit: 5 });
  ok(rows.length > 0, "窗口内应有行");
  eq(Object.keys(rows[0]).join(","), "session_name,sender,is_owner,ts,content,links,attachments", "行键序（JSON 序列化稳定性）");
  eq(rows[0].attachments, [], "attachments 恒为空数组（列不取）");
  ok(rows[0]._indexed === true, "_indexed 标记保留");
  eq(typeof rows[0].is_owner, "boolean", "is_owner 必须是布尔");
  ok(Array.isArray(rows[0].links), "links 是数组");
  eq(rows[0].links, [], "固件无链接 → 空数组（'[]' 快路径与解析路径 JSON 等价）");
});
await t("messagesForAnalyze 双映射路径逐行等价（对象行 rowToMessage vs 数组行 rowFromTuple）", async () => {
  const t6 = (links, is_owner = 1) => ["会话", "成员", is_owner, 1700000000000, "正文", links];
  const o = (links, is_owner = 1) => ({ session_name: "会话", sender: "成员", is_owner, ts: 1700000000000, content: "正文", links });
  for (const links of ['["https://a.example/x"]', "[]", "", null, "脏数据{", '["https://a.example/x","https://b.example/y"]']) {
    const viaObj = store.rowToMessage(o(links, 0));
    const viaTuple = store.rowFromTuple(t6(links, 0));
    eq(JSON.stringify(viaTuple), JSON.stringify(viaObj), "links=" + String(links) + " 双路径 JSON 等价");
    eq(Object.keys(viaTuple).join(","), Object.keys(viaObj).join(","), "键序一致");
    ok(viaTuple._indexed === true, "_indexed 标记一致");
  }
  ok(Object.isFrozen(store.rowFromTuple(t6("[]")).links), "空 links 快路径返回共享冻结数组（零变更点已审计）");
});

console.log("\n2c) 裸行列面（messagesRaw：5 列直返契约）");
await t("messagesRaw 只返回 5 键且键序固定", async () => {
  const rows = store.messagesRaw({ sinceMs: now - dayMs, untilMs: now + 1, limit: 5 });
  ok(rows.length > 0, "窗口内应有行");
  eq(rows.length, 5, "limit 生效");
  eq(Object.keys(rows[0]).join(","), "session_name,sender,is_owner,ts,content", "行键序（JSON 序列化稳定性）");
  for (const r of rows) {
    eq(typeof r.ts, "number", "ts 是数字");
    eq(typeof r.content, "string", "content 是字符串");
    ok(r.is_owner === 0 || r.is_owner === 1, "is_owner 保持裸值 0/1（JSON 逐位等价前提）");
  }
});
await t("messagesRaw 双映射路径逐行等价（裸行直返 vs 数组行 rowFromRawTuple）", async () => {
  for (const is_owner of [0, 1]) {
    for (const content of ["有项目方找 KOL 投放，预算 3000", "", "脏数据{"]) {
      const bare = Object.create(null);
      bare.session_name = "会话"; bare.sender = "成员"; bare.is_owner = is_owner; bare.ts = 1700000000000; bare.content = content;
      const viaTuple = store.rowFromRawTuple([bare.session_name, bare.sender, bare.is_owner, bare.ts, bare.content]);
      eq(JSON.stringify(viaTuple), JSON.stringify(bare), "双路径 JSON 等价（is_owner=" + is_owner + "）");
      eq(Object.keys(viaTuple).join(","), "session_name,sender,is_owner,ts,content", "键序一致");
    }
  }
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

console.log("\n5) 攒批摄取（ingestSessionBatches）：等价性 / 幂等 / 批内原子");
await t("攒批摄取与逐会话写入等价，且重跑幂等", async () => {
  const batches = [];
  for (let s = 0; s < 25; s++) {
    const msgs = [];
    for (let i = 0; i < 30; i++) msgs.push({ session_name: "批会话" + s, session_kind: "group", sender: "戊", ts: now - i * 1000, content: "攒批内容 " + i });
    batches.push(msgs);
  }
  const w = ingest.ingestSessionBatches(db, batches, { source: "scale", chunkSize: 20 });
  eq(w.sessions, 25, "会话数");
  eq(w.chunks, 2, "25 会话 / chunkSize 20 一批 = 2 批（显式钉住，不随默认调参变化）");
  eq(w.inserted, 25 * 30, "首跑插入数");
  eq(w.stats.sessions, 25, "收尾统计覆盖的会话数");
  const rows = db.prepare("SELECT name, msg_count FROM sessions WHERE name LIKE '批会话%' ORDER BY name").all();
  eq(rows.length, 25);
  for (const r of rows) eq(r.msg_count, 30, r.name + " 计数");
  const w2 = ingest.ingestSessionBatches(db, batches, { source: "scale", chunkSize: 20 });
  eq(w2.inserted, 0, "重跑应全部 INSERT OR IGNORE 落空");
  eq(db.prepare("SELECT COUNT(*) n FROM messages WHERE session_name LIKE '批会话%'").get().n, 25 * 30, "重跑后总数不变");
});
await t("sessionBatchWriter 逐批 add（异步取数形态）与 ingestSessionBatches 等价、results 与 add 同序", async () => {
  // indexFromReader 形态：取数异步、逐页 add、末尾 finish 一次收尾
  const writer = ingest.sessionBatchWriter(db, { source: "scale", chunkSize: 20 });
  for (let s = 0; s < 25; s++) {
    const msgs = [];
    for (let i = 0; i <= s; i++) msgs.push({ session_name: "写入器会话" + s, session_kind: "group", sender: "辛", ts: now - i * 1000, content: "写入器内容 " + i });
    writer.add(msgs);
    await new Promise((r) => setImmediate(r)); // 模拟逐页异步取数
  }
  const w = writer.finish();
  eq(w.sessions, 25, "会话数");
  eq(w.chunks, 2, "25 批 / 20 一批 = 2 批");
  eq(w.inserted, (25 * 26) / 2, "插入数 = 1+2+…+25");
  eq(w.results.length, 25, "results 与 add 一一对应");
  for (let s = 0; s < 25; s++) eq(w.results[s].inserted, s + 1, "results[" + s + "] 同序记账");
  eq(db.prepare("SELECT COUNT(*) n FROM messages WHERE session_name LIKE '写入器会话%'").get().n, (25 * 26) / 2, "落库总数");
});
await t("批内原子：同批任一会话写入失败则整批回滚、错误上抛", async () => {
  db.exec("ALTER TABLE links RENAME TO links_hidden");
  try {
    const batches = [
      [{ session_name: "原子A", session_kind: "group", sender: "己", ts: now, content: "无链接消息" }],
      [{ session_name: "原子B", session_kind: "group", sender: "己", ts: now, content: "带链接 https://example.com/x" }],
    ];
    let threw = null;
    try { ingest.ingestSessionBatches(db, batches, { source: "scale", chunkSize: 20 }); } catch (e) { threw = e; }
    ok(threw, "links 表缺失时 addLink 应抛错上抛（吞错会让半成品落库）");
    eq(db.prepare("SELECT COUNT(*) n FROM messages WHERE session_name IN ('原子A','原子B')").get().n, 0, "原子A（无链接）也必须随批回滚");
  } finally {
    db.exec("ALTER TABLE links_hidden RENAME TO links");
  }
});
await t("批间独立：chunkSize=1 时前批已提交、后批失败不影响它", async () => {
  db.exec("ALTER TABLE links RENAME TO links_hidden");
  try {
    const batches = [
      [{ session_name: "原子C", session_kind: "group", sender: "庚", ts: now, content: "无链接消息" }],
      [{ session_name: "原子D", session_kind: "group", sender: "庚", ts: now, content: "带链接 https://example.com/y" }],
    ];
    let threw = null;
    try { ingest.ingestSessionBatches(db, batches, { source: "scale", chunkSize: 1 }); } catch (e) { threw = e; }
    ok(threw, "第二批失败应上抛");
    eq(db.prepare("SELECT COUNT(*) n FROM messages WHERE session_name = '原子C'").get().n, 1, "第一批应已独立提交");
    eq(db.prepare("SELECT COUNT(*) n FROM messages WHERE session_name = '原子D'").get().n, 0, "第二批应整体回滚");
  } finally {
    db.exec("ALTER TABLE links_hidden RENAME TO links");
  }
  // 恢复后重跑（幂等补齐）：原子C 落空、原子D 成功补上，统计收尾一并修正
  const w = ingest.ingestSessionBatches(db, [
    [{ session_name: "原子C", session_kind: "group", sender: "庚", ts: now, content: "无链接消息" }],
    [{ session_name: "原子D", session_kind: "group", sender: "庚", ts: now, content: "带链接 https://example.com/y" }],
  ], { source: "scale", chunkSize: 1 });
  eq(w.inserted, 1, "重跑只补上失败的原子D");
  eq(db.prepare("SELECT COUNT(*) n FROM messages WHERE session_name IN ('原子C','原子D')").get().n, 2);
  eq(db.prepare("SELECT msg_count FROM sessions WHERE name = '原子C'").get().msg_count, 1, "重跑收尾应修正原子C 的会话计数");
});

console.log("\n5b) 扫描导入攒批（scanPath：攒批一事务 + 重扫幂等）");
await t("scanPath 多文件等价写入、perFile 记账正确、重扫幂等", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scan-dir-"));
  try {
    for (let f = 0; f < 25; f++) {
      const lines = [];
      for (let i = 0; i < 5; i++) lines.push("[2026-06-30 10:0" + i + "] 成员" + f + ": 文件" + f + " 内容 " + i);
      fs.writeFileSync(path.join(dir, "chat" + f + ".txt"), lines.join("\n") + "\n", "utf8");
    }
    const t0 = Date.now();
    const r1 = ingest.scanPath(dir, { source: "scale" });
    const ms = Date.now() - t0;
    eq(r1.files, 25, "文件数");
    eq(r1.inserted, 25 * 5, "首扫插入数");
    eq(r1.perFile.length, 25, "perFile 记账条数");
    for (const pf of r1.perFile) eq(pf.inserted, 5, pf.file + " 插入数");
    ok(ms < 5000, "25 文件扫描耗时 " + ms + "ms（阈值 5000ms）");
    console.log("      实测 " + ms + "ms / 25 文件 125 条（攒批 1 次提交）");
    const r2 = ingest.scanPath(dir, { source: "scale" });
    eq(r2.inserted, 0, "重扫幂等：应全部 INSERT OR IGNORE 落空");
    eq(db.prepare("SELECT COUNT(*) n FROM messages WHERE session_name LIKE 'chat%'").get().n, 25 * 5, "重扫后总数不变");
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); } catch { /* ignore */ }
  }
});
await t("scanPath 对不存在的路径报错而不是静默 0 文件", async () => {
  let threw = null;
  try { ingest.scanPath(path.join(ROOT, "不存在的目录"), { source: "scale" }); } catch (e) { threw = e; }
  ok(threw, "不存在的扫描目标必须抛错（静默成功会让用户以为扫描完成）");
  ok(String(threw.message).includes("扫描目标不存在"), "错误信息应指明目标不存在：" + threw.message);
});

console.log("\n6) 逐会话索引的耗时上界（防 O(n^2) 退化）");
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

console.log("\n7) 词频长词优先的耗时上界（防 O(n²) 退化，轮13）");
await t("termFreq 4 万条 / 2000 唯一词表 < 3 秒", async () => {
  const { termFreq } = await import(new URL("../lib/analytics/core.mjs", import.meta.url).href);
  const pool = [];
  for (let k = 0; k < 2000; k++) {
    const a = String.fromCharCode(0x4e00 + (k % 700));
    const b = String.fromCharCode(0x4e00 + (Math.floor(k / 700) % 700));
    pool.push(`项目${a}${b}需求${b}${a}排期${a}${b}方案${a}${b}交付`);
  }
  const msgs = [];
  for (let i = 0; i < 40000; i++) msgs.push({ content: pool[i % pool.length] + "，" + pool[(i * 7919) % pool.length] });
  const t0 = Date.now();
  const r = termFreq(msgs, { minCount: 2, limit: 30 });
  const ms = Date.now() - t0;
  ok(ms < 3000, "耗时 " + ms + "ms（阈值 3000ms；O(E²) 旧实现约 7000ms 会失败）");
  ok(r.length === 30, "应输出 30 词，实际 " + r.length);
  console.log("      实测 " + ms + "ms / 4 万条 2000 唯一短语");
});

console.log("\n8) 话题聚类单遍合并的相对耗时（比重扫式快 25%+，轮14）");
await t("topicClusters 高命中语料 < 逐话题重扫基线的 75%", async () => {
  const { topicClusters, TOPIC_SETS } = await import(new URL("../lib/analytics/content.mjs", import.meta.url).href);
  const { termFreq } = await import(new URL("../lib/analytics/core.mjs", import.meta.url).href);
  // 200k 条、每条命中 2-3 个话题；base-700 双字段保证短语唯一性（防生成器周期混叠）
  const TOPIC_WORDS = {
    工作: ["项目排期", "需求评审", "方案交付", "开会汇报"],
    商务: ["合作报价", "预算投放", "结算发票", "品牌推广"],
    家庭: ["爸妈孩子", "回家过年", "长辈家人"],
    感情: ["喜欢恋爱", "约会表白"],
    金钱: ["转账红包", "工资房租", "还款报销"],
    健康: ["医院看病", "发烧感冒", "锻炼跑步"],
    学业: ["作业考试", "论文答辩"],
    娱乐: ["电影游戏", "旅行攻略", "开黑排位"],
    餐饮: ["吃饭外卖", "火锅奶茶", "烧烤宵夜"],
    技术: ["代码接口", "部署报错", "数据库模型"],
    购物: ["下单快递", "退货优惠券"],
    出行: ["机票高铁", "打车酒店", "航班导航"],
  };
  const keys = Object.keys(TOPIC_WORDS);
  const msgs = [];
  for (let i = 0; i < 200000; i++) {
    const w = (k, j) => TOPIC_WORDS[k][(i + j) % TOPIC_WORDS[k].length];
    const u = String.fromCharCode(0x4e00 + (i % 700), 0x4e00 + (Math.floor(i / 700) % 700));
    msgs.push({ content: w(keys[i % 12], 0) + "，" + w(keys[(i * 5 + 1) % 12], 1) + "，" + w(keys[(i * 7 + 2) % 12], 2) + "，" + u });
  }
  // 预热：避免 JIT/正则冷启动偏向第一次测量
  topicClusters(msgs.slice(0, 2000));
  for (const re of Object.values(TOPIC_SETS)) termFreq(msgs.slice(0, 500).filter((m) => re.test(m.content)), { limit: 5, minCount: 2 });
  const t0 = Date.now();
  const r = topicClusters(msgs);
  const msNew = Date.now() - t0;
  const t1 = Date.now();
  let hitTotal = 0;
  for (const re of Object.values(TOPIC_SETS)) {
    const hits = msgs.filter((m) => re.test(m.content));
    hitTotal += hits.length;
    termFreq(hits, { limit: 5, minCount: 2 }); // 旧路径：逐话题独立重扫 n-gram
  }
  const msRescan = Date.now() - t1;
  ok(msNew < msRescan * 0.75, "单遍 " + msNew + "ms 应 < 重扫式 " + msRescan + "ms × 0.75（多话题消息的 n-gram 重复枚举必须被消除）");
  ok(r.length === 12, "12 个话题都应命中，实际 " + r.length);
  console.log("      实测 单遍 " + msNew + "ms vs 重扫式 " + msRescan + "ms（20 万条 / 累计命中 " + hitTotal + "）");
});

console.log("\n9) 实体表预筛门+直聚合的相对耗时（比无门推入式快 25%+，轮15）");
await t("entityTable 200k < 无门推入式基线的 75%", async () => {
  const { entityTable } = await import(new URL("../lib/analytics/content.mjs", import.meta.url).href);
  const { extractAmounts, extractDueDates } = await import(new URL("../lib/signals.mjs", import.meta.url).href);
  // 基线 = 改前形态：无门全文 matchAll + 临时对象 push（含 time 死字段）+ 事后 dedupe
  const naive = (messages, { ref = new Date(), limit = 40 } = {}) => {
    const RES = {
      location: /(?:地址[:：]?\s*)?(?:[一-龥]{2,10}(?:路|街|道|巷|弄|大道|大街)\d{0,4}号?|[一-龥]{2,12}(?:大厦|大楼|广场|中心|园区|产业园|酒店|宾馆|咖啡厅?|餐厅|书店|医院|学校|地铁站?|机场|火车站|高铁站|体育馆|公园|商场|超市))/g,
      org: /[一-龥]{2,12}?(?:有限公司|股份公司|科技|集团|银行|医院|大学|学院|事务所|工作室|研究院|工作室|政府|支行|分行|基金会|协会|委员会|工作室)/g,
      event: /(会议|例会|评审会|发布会|上线|开工|奠基|签约|验收|交付|试讲|培训|团建|聚餐|婚礼|面试|考试|答辩|出差|旅行|搬家|年会|展会|沙龙|直播)/g,
      at: /@([一-龥A-Za-z0-9_\-]{2,20})/g,
      person: /(王|李|张|刘|陈|杨|赵|黄|周|吴|徐|孙|胡|朱|高|林|何|郭|马)(?:总|工|老师|医生|经理|主任|校长|教授|律师|师傅|同学|哥|姐|姐夫|阿姨|叔叔)/g,
    };
    const bags = { time: [], location: [], person: [], amount: [], org: [], event: [] };
    const push = (arr, value, m) => {
      if (!value) return;
      arr.push({ value, msg_id: m?.id ?? null, time: m?.ts ? new Date(m.ts).toISOString() : null });
    };
    for (const m of messages) {
      const text = String(m?.content ?? "");
      if (!text) continue;
      for (const d of extractDueDates(text, m?.ts ? new Date(m.ts) : ref)) push(bags.time, d.text, m);
      for (const a of extractAmounts(text)) push(bags.amount, a, m);
      for (const mm of text.matchAll(RES.location)) push(bags.location, mm[0], m);
      for (const mm of text.matchAll(RES.org)) push(bags.org, mm[0], m);
      for (const mm of text.matchAll(RES.event)) push(bags.event, mm[0], m);
      for (const mm of text.matchAll(RES.at)) push(bags.person, mm[1], m);
      for (const mm of text.matchAll(RES.person)) push(bags.person, mm[0], m);
      if (!m.is_owner && m.sender) push(bags.person, m.sender, m);
    }
    const out = {};
    for (const [k, arr] of Object.entries(bags)) {
      const seen = new Map();
      for (const e of arr) {
        const row = seen.get(e.value) ?? { value: e.value, count: 0, msg_ids: [] };
        row.count += 1;
        if (row.msg_ids.length < 5 && e.msg_id) row.msg_ids.push(e.msg_id);
        seen.set(e.value, row);
      }
      out[k] = [...seen.values()].sort((a, b) => b.count - a.count || a.value.localeCompare(b.value, "zh")).slice(0, limit);
    }
    return out;
  };
  // 语料：200k、约 30% 实体密度、base-700 双字段唯一尾缀（防生成器周期混叠）
  const plain = ["好的收到", "这个需求我看下", "明天同步一下进度", "哈哈没问题", "在吗", "稍等我查一下", "文档我更新了", "先这样定了", "回头细聊", "最近太忙了"];
  const ent = [
    "3月5日发版", "明天下午开会", "下周五之前给", "2026-06-30 截止",
    "预算 3000 块", "500元搞定", "1.5万预算", "RMB 200 一人",
    "南京西路 88 号碰头", "创新大厦 5 层", "万达广场一楼", "星巴克咖啡厅", "市一医院门诊", "虹桥火车站集合",
    "腾讯科技那边", "阿里巴巴集团合作", "招商银行支行", "清华大学东门",
    "项目评审会改期", "下周上线", "团队聚餐", "明天面试",
    "@张三丰 看下", "@xiaoming 收到没", "王总说了算", "李老师在吗", "刘工帮忙看下",
  ];
  const msgs = [];
  for (let i = 0; i < 200000; i++) {
    const u = String.fromCharCode(0x4e00 + (i % 700), 0x4e00 + (Math.floor(i / 700) % 700));
    const pool = i % 10 < 3 ? ent : plain;
    msgs.push({ id: "m" + i, ts: 1700000000000 + i * 60000, is_owner: i % 3 === 0, sender: "用户" + (i % 50), content: pool[i % pool.length] + "，" + u });
  }
  const ref = new Date(1700000000000);
  // 预热：避免 JIT/正则冷启动偏向第一次测量
  entityTable(msgs.slice(0, 2000), { ref });
  naive(msgs.slice(0, 2000), { ref });
  const t0 = Date.now();
  const r = entityTable(msgs, { ref });
  const msNew = Date.now() - t0;
  const t1 = Date.now();
  naive(msgs, { ref });
  const msNaive = Date.now() - t1;
  ok(msNew < msNaive * 0.75, "预筛门+直聚合 " + msNew + "ms 应 < 无门推入式 " + msNaive + "ms × 0.75（门跳过 + 消灭临时对象分配必须兑现）");
  ok(r.person.length >= 1 && r.location.length >= 1, "语料应有实体产出：" + r.person.length + "/" + r.location.length);
  console.log("      实测 新式 " + msNew + "ms vs 无门推入式 " + msNaive + "ms（20 万条 / 约 30% 实体密度）");
});

console.log("\n10) sentiment 打分共享正则的相对耗时（比逐消息重编译快 25%+，轮16）");
await t("scoreOf 200k < 逐消息重编译基线的 75%", async () => {
  const { scoreOf } = await import(new URL("../lib/analytics/sentiment.mjs", import.meta.url).href);
  // 基线 = 改前形态：每次调用 new RegExp(source,"g") 重新编译 4 个正则
  const NEGATION_RE = /(?:不|没|没有|别|未|无|毫不|不再|不算|不至于)/;
  const INTENSIFIER_RE = /(?:太|超|超|特别|非常|真的|好|真|挺|很|巨|老|贼|简直)/;
  const POS_SRC = /开心|高兴|喜欢|太棒|不错|赞|厉害|优秀|顺利|成功|搞定|完成|感谢|谢谢|幸福|期待|好玩|好看|舒服|满意|值得|稳了|破防了|好耶|哈哈|嘿嘿|加油|恭喜|温暖|感动|甜/.source;
  const NEG_SRC = /难过|伤心|失望|生气|愤怒|气死|烦|焦虑|担心|害怕|崩溃|累死|压力|痛苦|哭|糟糕|失败|出错|报错|坑|投诉|垃圾|离谱|无语|委屈|孤独|难受|疼|病|失眠|拖延|后悔|抱歉|对不起|可惜|凉了|完蛋|翻车|吵架|分手/.source;
  const CONFLICT_SRC = /吵|争执|翻脸|投诉|举报|骗子|骗|凭什么|太过分|忍无可忍|拉黑|绝交|对骂/.source;
  const COMFORT_SRC = /别担心|没关系|没事的?|抱抱|辛苦了|加油|慢慢来|不着急|理解你|会好的|我陪你|放心/.source;
  const weightAt = (text, index) => {
    const before = text.slice(Math.max(0, index - 4), index);
    const after = text.slice(index, index + 6);
    let w = 1;
    if (NEGATION_RE.test(before)) w *= -1;
    if (INTENSIFIER_RE.test(before) || INTENSIFIER_RE.test(after)) w *= 1.4;
    return w;
  };
  const oldScoreOf = (text) => {
    const t = String(text ?? "");
    let score = 0;
    for (const m of t.matchAll(new RegExp(POS_SRC, "g"))) score += weightAt(t, m.index) * 1;
    for (const m of t.matchAll(new RegExp(NEG_SRC, "g"))) score += weightAt(t, m.index) * -1;
    const conflict = (t.match(new RegExp(CONFLICT_SRC, "g")) ?? []).slice(0, 5);
    const comfort = (t.match(new RegExp(COMFORT_SRC, "g")) ?? []).slice(0, 5);
    return { score: Math.max(-1.5, Math.min(1.5, score)), conflict, comfort };
  };
  // 语料：200k、base-700 唯一尾缀 + 混合情绪词（词命中/未命中都扫）
  const pool = ["今天很开心，项目顺利", "烦死了加班到十点", "好的收到", "不开心，真的不开心", "这个需求我看下", "太棒了恭喜", "压力好大想哭", "在吗", "别担心加油", "稍等我查一下"];
  const texts = [];
  for (let i = 0; i < 200000; i++) {
    const u = String.fromCharCode(0x4e00 + (i % 700), 0x4e00 + (Math.floor(i / 700) % 700));
    texts.push(pool[i % pool.length] + "，" + u);
  }
  // 预热：避免 JIT/正则冷启动偏向第一次测量
  scoreOf(texts[0]); oldScoreOf(texts[0]);
  const t0 = Date.now();
  for (const s of texts) scoreOf(s);
  const msNew = Date.now() - t0;
  const t1 = Date.now();
  for (const s of texts) oldScoreOf(s);
  const msOld = Date.now() - t1;
  ok(msNew < msOld * 0.75, "共享正则 " + msNew + "ms 应 < 逐消息重编译 " + msOld + "ms × 0.75（每调用 new RegExp 必须被消除）");
  console.log("      实测 共享 " + msNew + "ms vs 重编译 " + msOld + "ms（20 万条打分）");
});

console.log("\n11) 词频×话题共享单遍的相对耗时（比双遍快 10%+，轮17 共享 / 轮19 位图后重基线）");
await t("keywordsAndTopics 200k 长消息 < 双遍基线的 90%", async () => {
  const { keywordsAndTopics, topicClusters } = await import(new URL("../lib/analytics/content.mjs", import.meta.url).href);
  const { termFreq } = await import(new URL("../lib/analytics/core.mjs", import.meta.url).href);
  // 语料：200k 条真实长度（30-60 字）消息、50% 话题密度、base-700 唯一尾缀（防生成器周期混叠）。
  // 短串语料里 n-gram 枚举占比低、共享收益趋零——收益随消息长度增长，故门禁用长消息语料。
  const topicSents = [
    "这周三下午三点开项目评审会，需求文档我先过一遍，排期等评审后再定",
    "预算这边财务说要走合同流程，发票开过来我让甲方走付款审批，尾款下周结算",
    "作业写完了没？明天考试范围划重点，论文初稿记得发给老师看一下",
    "周六去看电影还是吃火锅？新开的那家烧烤店听说要排队，奶茶顺便带一杯",
    "高铁票买好了，酒店订在会展中心附近，出发前把值机和导航都弄一下",
  ];
  const plainSents = [
    "好的收到，我看下晚点回你",
    "哈哈没问题就按你说的来吧",
    "在吗稍等我查一下之前那个记录",
    "最近太忙了回头细聊这段时间先这样",
    "嗯嗯明白那我先同步一下进度再说",
  ];
  const msgs = [];
  for (let i = 0; i < 200000; i++) {
    const u = String.fromCharCode(0x4e00 + (i % 700), 0x4e00 + (Math.floor(i / 700) % 700));
    const pool = i % 10 < 5 ? topicSents : plainSents;
    msgs.push({ content: pool[i % pool.length] + "，回头发你 " + u });
  }
  // 预热：避免 JIT 冷启动偏向第一次测量
  keywordsAndTopics(msgs.slice(0, 2000), { limit: 20 });
  termFreq(msgs.slice(0, 2000), { limit: 20 });
  topicClusters(msgs.slice(0, 2000));
  // 交错三跑取各侧最小（§12 教训：单跑顺序有偏，先测侧吸收全量预热成本）。
  // 轮19 位图预检把单次 n-gram 枚举成本降 ~35%，共享单遍的相对收益从 ~25% 收缩到 ~19%
  // （交错实测 0.81-0.82）；门禁按惯例留余量重基线到 ×0.9——真双遍回归比值 ≈1.0 仍被绊住。
  let msNew = Infinity, msDual = Infinity, r = null;
  for (let k = 0; k < 3; k++) {
    const t0 = Date.now();
    r = keywordsAndTopics(msgs, { limit: 20 });
    msNew = Math.min(msNew, Date.now() - t0);
    const t1 = Date.now();
    termFreq(msgs, { limit: 20 }); // 双遍基线 = 现公共路径原样（旧 contentAnalysis 的组合形态）
    topicClusters(msgs);
    msDual = Math.min(msDual, Date.now() - t1);
  }
  ok(msNew < msDual * 0.9, "共享单遍 " + msNew + "ms 应 < 双遍 " + msDual + "ms × 0.9（同一语料的 n-gram 枚举必须只跑一遍）");
  ok(r.keywords.length === 20 && r.topics.length >= 6, "产出应完整：keywords " + r.keywords.length + " / topics " + r.topics.length);
  console.log("      实测 共享 " + msNew + "ms vs 双遍 " + msDual + "ms（20 万条 30-60 字消息 / 50% 话题密度，交错取最小）");
});

console.log("\n12) summary×type_breakdown 共享分类单遍的相对耗时（比两段式快 15%+，轮18）");
await t("extractiveSummary+kinds 200k 长消息 < 两段式基线的 85%", async () => {
  const { extractiveSummary } = await import(new URL("../lib/analytics/content.mjs", import.meta.url).href);
  const { classifyMessage, countBy } = await import(new URL("../lib/analytics/core.mjs", import.meta.url).href);
  // 语料：200k 条 30-60 字消息、20% 非 text/link 类型、base-700 唯一尾缀。
  // 两段式 = 现公共路径原样（extractiveSummary 逐条 classify + countBy 再 classify 一遍）；融合 = kinds 每条恰一次。
  // 收益随消息长度摊薄（短串 POC 0.517、长消息档 0.698），故门禁用长消息档留 15% 余量。
  const topicSents = [
    "这周三下午三点开项目评审会，需求文档我先过一遍，排期等评审后再定",
    "预算这边财务说要走合同流程，发票开过来我让甲方走付款审批，尾款下周结算",
  ];
  const plainSents = [
    "好的收到，我看下晚点回你，到时候再对一下细节",
    "哈哈没问题就按你说的来吧，我这边没什么意见",
  ];
  const kindMarks = ["[图片]", "[语音 12s]", "季度报告.docx 已上传", "https://example.com/spec", "我到了，在创新大厦"];
  const msgs = [];
  for (let i = 0; i < 200000; i++) {
    const u = String.fromCharCode(0x4e00 + (i % 700), 0x4e00 + (Math.floor(i / 700) % 700));
    if (i % 5 === 0) msgs.push({ content: kindMarks[((i / 5) % kindMarks.length) | 0] + " " + u });
    else msgs.push({ content: (i % 10 < 5 ? topicSents : plainSents)[i % 2] + "，回头发你 " + u });
  }
  const now = new Date(2026, 9, 5, 12, 0, 0);
  // 预热：避免 JIT 冷启动偏向第一次测量
  const warmKinds = msgs.slice(0, 2000).map((m) => classifyMessage(m));
  extractiveSummary(msgs.slice(0, 2000), { now, kinds: warmKinds });
  countBy(warmKinds, (k) => k);
  extractiveSummary(msgs.slice(0, 2000), { now });
  countBy(msgs.slice(0, 2000), (m) => classifyMessage(m));
  // 交错三跑取各侧最小：单跑顺序有偏（先测的一侧吸收一次性全量预热成本，融合先测比值摆到 0.84-0.98；
  // GC 隔离中位与交错取最小都稳定 ~0.71），门禁必须交错对测；三跑给负载下的干净跑留机会。
  let msNew = Infinity, msDual = Infinity, s = null;
  for (let r = 0; r < 3; r++) {
    const t0 = Date.now();
    const kinds = msgs.map((m) => classifyMessage(m));
    s = extractiveSummary(msgs, { now, kinds });
    countBy(kinds, (k) => k);
    msNew = Math.min(msNew, Date.now() - t0);
    const t1 = Date.now();
    extractiveSummary(msgs, { now }); // 两段式基线 = 现公共路径原样
    countBy(msgs, (m) => classifyMessage(m));
    msDual = Math.min(msDual, Date.now() - t1);
  }
  ok(msNew < msDual * 0.85, "共享分类单遍 " + msNew + "ms 应 < 两段式 " + msDual + "ms × 0.85（classifyMessage 每条必须只跑一次）");
  ok(s.bullets.length >= 1, "产出应完整：bullets " + s.bullets.length);
  console.log("      实测 融合 " + msNew + "ms vs 两段式 " + msDual + "ms（20 万条 30-60 字消息 / 20% 非文本类型，交错取最小）");
});

console.log("\n13) 选句打分链路扫描侧的相对耗时（正则提级+长度早退，轮18-②）");
await t("extractiveSummary 扫描侧 200k < 改前内联旧实现的 85%", async () => {
  const { extractiveSummary } = await import(new URL("../lib/analytics/content.mjs", import.meta.url).href);
  const { classifyMessage, evidence, round, truncate } = await import(new URL("../lib/analytics/core.mjs", import.meta.url).href);
  // 基线 = 轮18 改前逐字形态：text/link 双判定（非 text 消息 classify 两次）+ 逐句正则字面量 + 长度<6。
  const oldSummary = (messages, { maxBullets = 8, now = new Date() } = {}) => {
    const sentences = [];
    for (const m of messages) {
      const text = String(m?.content ?? "").trim();
      if (text.length < 6) continue;
      if (classifyMessage(m) !== "text" && classifyMessage(m) !== "link") continue;
      for (const seg of text.split(/[。！？!?；;\n]/)) {
        const s = seg.trim();
        if (s.length < 8 || s.length > 120) continue;
        let score = Math.min(s.length, 60) / 20;
        if (/[0-9一二三四五六七八九十百千万]/.test(s)) score += 1;
        if (/[A-Za-z]{3,}/.test(s)) score += 0.5;
        if (/(?:会议|决定|确认|发布|上线|交付|签约|报价|预算|时间|地点|地址|截止|延期|完成|需要|问题)/.test(s)) score += 1.5;
        if (/[?？]/.test(s)) score -= 0.5;
        if (/^(?:好的|收到|嗯|哈哈|OK|ok|谢谢)/.test(s)) score -= 2;
        sentences.push({ text: s, score, msg: m });
      }
    }
    sentences.sort((a, b) => b.score - a.score || (a.msg.ts ?? 0) - (b.msg.ts ?? 0));
    const bullets = [];
    for (const s of sentences) {
      if (bullets.length >= maxBullets) break;
      if (bullets.some((b) => b.text.slice(0, 10) === s.text.slice(0, 10))) continue;
      bullets.push({ text: truncate(s.text, 100), score: round(s.score, 2), ...evidence(s.msg, { limit: 100 }) });
    }
    return { bullets, method: "抽取式（按信息密度打分选句），不是生成式改写；只保留原句片段，不扩写结论。" };
  };
  // 语料：200k 条 30-60 字消息 + 40% 非文本 + 10% 链接 + base-700 唯一尾缀。
  // 短串语料会把扫描类收益误判为零（轮17 教训），非文本占比是双判定收益的来源，两档都要有。
  const longSents = [
    "这周三下午三点开项目评审会，需求文档我先过一遍，排期等评审后再定",
    "预算这边财务说要走合同流程，发票开过来我让甲方走付款审批，尾款下周结算",
    "作业写完了没？明天考试范围划重点，论文初稿记得发给老师看一下",
    "高铁票买好了，酒店订在会展中心附近，出发前把值机和导航都弄一下",
  ];
  const nonText = ["[图片]", "[语音 12s]", "季度报告.docx 已上传", "转账 500 元已到账", "微信红包恭喜发财", "位置：南京西路 88 号", "[视频 0:30]", "[动画表情]"];
  const msgs = [];
  for (let i = 0; i < 200000; i++) {
    const u = String.fromCharCode(0x4e00 + (i % 700), 0x4e00 + (Math.floor(i / 700) % 700));
    const bucket = i % 10;
    if (bucket < 4) msgs.push({ content: nonText[i % nonText.length] + " " + u });
    else if (bucket < 5) msgs.push({ content: "参考这个 https://example.com/spec " + u });
    else msgs.push({ content: longSents[i % longSents.length] + "，回头发你 " + u });
  }
  const now = new Date(2026, 9, 5, 12, 0, 0);
  // 自检：两侧产出必须逐位一致，门禁才是在比同一份工作的快慢（否则比值无意义）
  eq(oldSummary(msgs.slice(0, 2000), { now }), extractiveSummary(msgs.slice(0, 2000), { now }), "新旧实现产出必须逐位一致");
  // 预热 + 交错三跑取各侧最小：单跑顺序有偏（§12 实测先测侧吸收全量预热成本可摆到 0.84-0.98）
  oldSummary(msgs.slice(0, 2000), { now });
  extractiveSummary(msgs.slice(0, 2000), { now });
  let msNew = Infinity, msOld = Infinity, r = null;
  for (let k = 0; k < 3; k++) {
    const t0 = Date.now();
    r = extractiveSummary(msgs, { now });
    msNew = Math.min(msNew, Date.now() - t0);
    const t1 = Date.now();
    oldSummary(msgs, { now });
    msOld = Math.min(msOld, Date.now() - t1);
  }
  ok(msNew < msOld * 0.85, "扫描侧新式 " + msNew + "ms 应 < 改前旧式 " + msOld + "ms × 0.85（正则提级 + 长度早退 + 单次 classify 必须兑现）");
  ok(r.bullets.length >= 1, "产出应完整：bullets " + r.bullets.length);
  console.log("      实测 新式 " + msNew + "ms vs 旧式 " + msOld + "ms（20 万条 / 40% 非文本 + 10% 链接，交错取最小）");
});

console.log("\n14) typeBreakdown 单调 hoist 的相对耗时（双调 classify 每条只跑一次，轮19）");
await t("typeBreakdown 200k < 双调原式的 70%", async () => {
  const { typeBreakdown, classifyMessage } = await import(new URL("../lib/analytics/core.mjs", import.meta.url).href);
  // 基线 = 轮19 改前双调原式逐字形态（counts[k]=… 前后各调一次 classifyMessage）。
  // POC 交错实测 0.523（76.8→40.2ms @200k）；门禁留余量用 ×0.7。
  const doubleCall = (messages) => {
    const counts = { text: 0, image: 0, voice: 0, file: 0, transfer: 0, redpacket: 0, link: 0, location: 0 };
    for (const m of messages) counts[classifyMessage(m)] = (counts[classifyMessage(m)] ?? 0) + 1;
    const total = messages.length || 0;
    const ratio = {};
    for (const [k, v] of Object.entries(counts)) ratio[k] = total ? Math.round((v / total) * 1000) / 10 : 0;
    return { counts, ratio, total };
  };
  // 语料：200k 条 30-60 字消息、20% 非文本类型、base-700 唯一尾缀（类型混叠防规律性分支预测偏置）
  const topicSents = [
    "这周三下午三点开项目评审会，需求文档我先过一遍，排期等评审后再定",
    "预算这边财务说要走合同流程，发票开过来我让甲方走付款审批，尾款下周结算",
  ];
  const kindMarks = ["[图片]", "[语音 12s]", "季度报告.docx 已上传", "红包来了", "给你转 500 元", "https://example.com/spec", "我到了，在创新大厦"];
  const msgs = [];
  for (let i = 0; i < 200000; i++) {
    const u = String.fromCharCode(0x4e00 + (i % 700), 0x4e00 + (Math.floor(i / 700) % 700));
    if (i % 5 === 0) msgs.push({ content: kindMarks[((i / 5) % kindMarks.length) | 0] + " " + u });
    else msgs.push({ content: topicSents[i % 2] + "，回头发你 " + u });
  }
  // 自检：两侧产出必须逐位一致，门禁才是在比同一份工作的快慢
  eq(typeBreakdown(msgs.slice(0, 2000)), doubleCall(msgs.slice(0, 2000)), "新旧实现产出必须逐位一致");
  // 预热 + 交错三跑取各侧最小（§12 实测单跑顺序有偏，先测侧吸收全量预热成本）
  typeBreakdown(msgs.slice(0, 2000));
  doubleCall(msgs.slice(0, 2000));
  let msNew = Infinity, msOld = Infinity, out = null;
  for (let k = 0; k < 3; k++) {
    const t0 = Date.now();
    out = typeBreakdown(msgs);
    msNew = Math.min(msNew, Date.now() - t0);
    const t1 = Date.now();
    doubleCall(msgs);
    msOld = Math.min(msOld, Date.now() - t1);
  }
  ok(msNew < msOld * 0.7, "单调 hoist " + msNew + "ms 应 < 双调原式 " + msOld + "ms × 0.7（classifyMessage 每条必须只跑一次）");
  ok(out.total === 200000, "产出应完整：total " + out.total);
  console.log("      实测 hoist " + msNew + "ms vs 双调 " + msOld + "ms（20 万条 / 20% 非文本，交错取最小）");
});

console.log("\n15) 词频枚举热循环的相对耗时（停用边位图预检，轮19）");
await t("termFreq 200k < 改前内联旧 bumpTextInto 路径的 85%", async () => {
  const core = await import(new URL("../lib/analytics/core.mjs", import.meta.url).href);
  // 基线 = 轮19 改前逐字形态：先 slice 子串、再查首尾停用字（Set<string> 哈希 + 单字符串分配），
  // 与 core.mjs 新式的「charCodeAt 位图预检先行、不中才 slice」对拍。
  const OLD_EDGE = new Set([
    ...Array.from("的了是我你他她它们这那就都也很还只把被让给对从到和与在有个不没会能要说看才并且或如果因为所以然后但是而且着过呢吗吧呀啊哦哈嗯呃嘛嘛哇哎唉嘿呵么之其及于以乃"),
  ]);
  const OLD_WORDS = new Set([
    "我们", "你们", "他们", "这个", "那个", "什么", "怎么", "可以", "不是", "没有", "就是", "但是", "因为", "所以", "然后", "如果", "一个", "一下", "这样", "那样", "知道", "觉得", "现在", "时候", "问题", "谢谢", "好的", "哈哈", "嗯嗯", "已经", "还是", "还有", "这么", "那么", "比较", "其实", "直接", "需要", "应该", "可能", "或者", "开始", "今天", "明天", "昨天", "后天", "上午", "下午", "晚上", "时间", "消息", "收到", "OK",
  ]);
  const OLD_CJK_RUN = /[一-龥]{2,}/g;
  const OLD_CJK_UNIT = /[一-龥]{1,4}(?:块钱|元|万|亿|人|天|次|条|个|张|部|台|位|岁|月|年|周|小时|分钟)/g;
  const OLD_LATIN = /[A-Za-z][A-Za-z0-9+#.\-]{1,20}/g;
  const oldBump = (inc, text, maxN = 4) => {
    if (!text) return;
    for (const run of text.match(OLD_CJK_RUN) ?? []) {
      for (let n = 2; n <= Math.min(maxN, run.length); n += 1) {
        for (let i = 0; i + n <= run.length; i += 1) {
          const term = run.slice(i, i + n);
          if (OLD_EDGE.has(term[0]) || OLD_EDGE.has(term[n - 1])) continue;
          if (n === 2 && OLD_WORDS.has(term)) continue;
          inc(term);
        }
      }
    }
    for (const tok of text.match(OLD_CJK_UNIT) ?? []) inc(tok);
    for (const tok of text.match(OLD_LATIN) ?? []) {
      const w = tok.toLowerCase();
      if (w.length >= 2) inc(w);
    }
  };
  const oldTermFreq = (messages, { maxN = 4, minCount = 2, limit = 30, keepLongerRatio = 0.75 } = {}) => {
    const counts = new Map();
    const bump = (tt) => counts.set(tt, (counts.get(tt) ?? 0) + 1);
    for (const m of messages) oldBump(bump, String(m?.content ?? ""), maxN);
    return core.finishTermFreq(counts, { minCount, limit, keepLongerRatio });
  };
  // 语料：200k 条 30-60 字长消息 + 40% 非文本 + 10% 链接 + base-700 唯一尾缀（轮17 教训：
  // 短串语料会把枚举类收益误判为零；唯一尾缀防 memo 化误判，两档都要有）。
  const longSents = [
    "这周三下午三点开项目评审会，需求文档我先过一遍，排期等评审后再定",
    "预算这边财务说要走合同流程，发票开过来我让甲方走付款审批，尾款下周结算",
    "作业写完了没？明天考试范围划重点，论文初稿记得发给老师看一下",
    "高铁票买好了，酒店订在会展中心附近，出发前把值机和导航都弄一下",
  ];
  const nonText = ["[图片]", "[语音 12s]", "季度报告.docx 已上传", "转账 500 元已到账", "微信红包恭喜发财", "位置：南京西路 88 号", "[视频 0:30]", "[动画表情]"];
  const msgs = [];
  for (let i = 0; i < 200000; i += 1) {
    const u = String.fromCharCode(0x4e00 + (i % 700), 0x4e00 + (Math.floor(i / 700) % 700));
    const bucket = i % 10;
    if (bucket < 4) msgs.push({ content: nonText[i % nonText.length] + " " + u });
    else if (bucket < 5) msgs.push({ content: "参考这个 https://example.com/spec " + u });
    else msgs.push({ content: longSents[i % longSents.length] + "，回头发你 " + u });
  }
  const full = { minCount: 1, limit: 100000 };
  eq(oldTermFreq(msgs.slice(0, 2000), full), core.termFreq(msgs.slice(0, 2000), full), "新旧枚举产出必须逐位一致（全词表对拍）");
  oldTermFreq(msgs.slice(0, 2000), full);
  core.termFreq(msgs.slice(0, 2000), full);
  let msNew = Infinity, msOld = Infinity, r = null;
  for (let k = 0; k < 3; k += 1) {
    const t0 = Date.now();
    r = core.termFreq(msgs);
    msNew = Math.min(msNew, Date.now() - t0);
    const t1 = Date.now();
    oldTermFreq(msgs);
    msOld = Math.min(msOld, Date.now() - t1);
  }
  ok(msNew < msOld * 0.85, "termFreq 新式 " + msNew + "ms 应 < 改前旧式 " + msOld + "ms × 0.85（位图预检零分配必须兑现）");
  ok(r.length >= 1, "产出应完整：" + r.length + " 词");
  console.log("      实测 新式 " + msNew + "ms vs 旧式 " + msOld + "ms（20 万条 / 长消息+非文本+链接混叠，交错取最小）");
});

console.log("\n16) socialGraph 月度桶的相对耗时（数值年月键替代 toISOString，轮20）");
await t("socialGraph 200k < 改前 toISOString 月键路径的 60%", async () => {
  const { pathToFileURL } = await import("node:url");
  const social = await import(new URL("../lib/analytics/social.mjs", import.meta.url).href);
  // 基线 = 轮20 改前逐字形态，由源码字符串变换生成（整引擎唯一差异就是月度桶这 9 行），
  // 不手抄：保证其余 socialGraph 代码与新版逐字一致，A/B 只差月键这一处。
  const NEW_SNIPPET = `    const byMonth = new Map();
    for (const m of msgs) {
      if (!m.ts) continue;
      const d = new Date(m.ts);
      const key = d.getUTCFullYear() * 12 + d.getUTCMonth();
      if (key !== key) d.toISOString(); // truthy 但非法时间：与旧实现同款抛 RangeError
      byMonth.set(key, (byMonth.get(key) ?? 0) + 1);
    }
    const monthly = [...byMonth.entries()].map(([ym, count]) => ({ month: fmtYm(ym), count })).sort((a, b) => (a.month < b.month ? -1 : 1));`;
  const OLD_SNIPPET = `    const byMonth = new Map();
    for (const m of msgs) {
      if (!m.ts) continue;
      const key = new Date(m.ts).toISOString().slice(0, 7);
      byMonth.set(key, (byMonth.get(key) ?? 0) + 1);
    }
    const monthly = [...byMonth.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([month, count]) => ({ month, count }));`;
  const src = fs.readFileSync(new URL("../lib/analytics/social.mjs", import.meta.url), "utf8");
  ok(src.split(NEW_SNIPPET).length === 2, "新式月度桶片段必须在 social.mjs 恰好出现 1 次（防并行改动后变换失配）");
  const genPath = path.join(ROOT, "social-old.mjs");
  fs.writeFileSync(genPath, src.split(NEW_SNIPPET).join(OLD_SNIPPET).split('"./core.mjs"').join('"' + new URL("../lib/analytics/core.mjs", import.meta.url).href + '"'));
  const socialOld = await import(pathToFileURL(genPath).href);
  // 语料：200k 条 / 600 会话 / 80 发送者 / 24 个月跨度 / 长消息档 + base-700 唯一尾缀（测量纪律）。
  const longSents = [
    "这周三下午三点开项目评审会，需求文档我先过一遍，排期等评审后再定",
    "预算这边财务说要走合同流程，发票开过来我让甲方走付款审批，尾款下周结算",
    "作业写完了没？明天考试范围划重点，论文初稿记得发给老师看一下",
    "高铁票买好了，酒店订在会展中心附近，出发前把值机和导航都弄一下",
    "上季度复盘数据我拉完了，留存和转化都在表里，明天会上同步给大家",
  ];
  const baseMs = 1700000000000;
  const msgs = [];
  for (let i = 0; i < 200000; i += 1) {
    const u = String.fromCharCode(0x4e00 + (i % 700), 0x4e00 + (Math.floor(i / 700) % 700));
    msgs.push({
      id: "m" + i,
      session_name: "会话" + (i % 600),
      session_kind: i % 3 === 0 ? "group" : "private",
      sender: "发送者" + (i % 80),
      is_owner: i % 5 === 0,
      ts: baseMs + ((i * 137) % (720 * 86400000)),
      content: longSents[i % longSents.length] + " " + u,
    });
  }
  const opts = { sinceMs: -8.64e15, untilMs: 8.64e15, top: 20, now: new Date(1780000000000) };
  const mapAware = (v) => JSON.stringify(v, (_k, x) => (x instanceof Map ? { __map: Object.fromEntries(x) } : x));
  eq(mapAware(social.socialGraph(msgs, opts)), mapAware(socialOld.socialGraph(msgs, opts)), "新旧引擎全输出必须逐位一致（Map-aware 对拍）");
  social.socialGraph(msgs, opts);
  socialOld.socialGraph(msgs, opts);
  let msNew = Infinity, msOld = Infinity, out = null;
  for (let k = 0; k < 3; k += 1) {
    const t0 = Date.now();
    out = social.socialGraph(msgs, opts);
    msNew = Math.min(msNew, Date.now() - t0);
    const t1 = Date.now();
    socialOld.socialGraph(msgs, opts);
    msOld = Math.min(msOld, Date.now() - t1);
  }
  ok(msNew < msOld * 0.6, "月键数值化 " + msNew + "ms 应 < toISOString 旧式 " + msOld + "ms × 0.6（POC 引擎级 0.467）");
  ok(out.who_contacts_me_most.length >= 1, "产出应完整：" + out.who_contacts_me_most.length + " 个联系人");
  console.log("      实测 新式 " + msNew + "ms vs 旧式 " + msOld + "ms（20 万条 / 600 会话 / 24 个月跨度，交错取最小）");
});

console.log("\n17) teamReview 死分配 lazy 化的相对耗时（row 惰性构建，轮21）");
await t("teamReview 200k < 改前 eager 建行路径的 80%", async () => {
  const { pathToFileURL } = await import("node:url");
  const team = await import(new URL("../lib/analytics/team.mjs", import.meta.url).href);
  // 基线 = 轮21 改前 eager 逐字形态，由源码字符串变换反向生成（8 处：建行 1 + spread 4 + 裸 push 3），
  // 其余 teamReview 代码与新版逐字一致；各片段必须恰好命中预期次数（防并行改动后变换失配）。
  const declLazy = 'let row = null; // 死分配消除（轮21）：非命中消息从不消费 row，惰性到首个命中再建\n    const getRow = () => (row ??= { actor, chat: m.session_name ?? "未知", ts: m.ts ?? null, msg_id: m.id ?? null, text: maskPii(truncate(text.replace(/\\s+/g, " "), 100)) });';
  const declEager = 'const row = { actor, chat: m.session_name ?? "未知", ts: m.ts ?? null, msg_id: m.id ?? null, text: maskPii(truncate(text.replace(/\\s+/g, " "), 100)) };';
  const pairs = [
    [declLazy, declEager, 1],
    ["{ ...getRow(), ", "{ ...row, ", 4],
    ["complaints.push(getRow());", "complaints.push(row);", 1],
    ["needs.push(getRow());", "needs.push(row);", 1],
    ["objections.push(getRow());", "objections.push(row);", 1],
  ];
  const src = fs.readFileSync(new URL("../lib/analytics/team.mjs", import.meta.url), "utf8");
  let eagerSrc = src;
  for (const [oldS, newS, n] of pairs) {
    if (eagerSrc.split(oldS).length - 1 !== n) throw new Error("片段命中数失配（期望 " + n + "）：" + oldS.slice(0, 40));
    eagerSrc = eagerSrc.split(oldS).join(newS);
  }
  const genPath = path.join(ROOT, "team-eager-old.mjs");
  fs.writeFileSync(genPath, eagerSrc
    .split('from "./core.mjs"').join('from "' + new URL("../lib/analytics/core.mjs", import.meta.url).href + '"')
    .split('from "../signals.mjs"').join('from "' + new URL("../lib/signals.mjs", import.meta.url).href + '"'));
  const teamOld = await import(pathToFileURL(genPath).href);
  // 语料：bench 真实分布（CHITCHAT 58/WORK 28/OWNER 7/LINKS+WORK 3/DEAL 2）+ 中性长句 30-60 字档
  // + base-700 唯一尾缀；200k 条 / 600 工作向会话。命中密度 ~8%（真实档；dense 档 lazy 收益收缩属预期，不设门）。
  const CHITCHAT = ["收到", "好的没问题", "哈哈哈哈", "今天天气不错", "我先看一下", "稍等我看下", "嗯嗯理解了", "这个我记一下", "好的明天再说", "辛苦啦"];
  const WORK = ["这个需求我这边排一下期", "先对齐一下范围", "文档我更新了", "我们内部过一下", "这块按上周说的做", "进度同步一下"];
  const DEAL = ["有项目方找 KOL 做投放，预算 3000-5000 RMB，AI 方向优先", "品牌方招募 AI 博主，预算 8000，需要主页和数据", "想找讲师做企业内训，2 天课程，预算可谈", "麻烦发一下 invoice，我们这周安排结算", "初稿周四前需要，brief 已发邮箱"];
  const LINKS = ["https://example.com/campaign-brief", "https://mp.weixin.qq.com/s/AbCdEf123456", "https://x.com/someone/status/1234567890"];
  const OWNER = ["好的，我今天晚些把报价整理给你", "我这边可以，麻烦先发大纲", "初稿我今晚 8 点前给你", "我整理一下数据一起发你"];
  const LONG = "这周三下午三点开个会对一遍细节排期等评审后再定回头发你，高铁票买好了酒店订在会展中心附近出发前把值机和导航都弄一下";
  const pick = (arr, i) => arr[i % arr.length];
  const msgs = [];
  for (let i = 0; i < 200000; i += 1) {
    const u = String.fromCharCode(0x4e00 + (i % 700), 0x4e00 + (Math.floor(i / 700) % 700));
    const roll = i % 100;
    let content;
    if (roll < 2) content = pick(DEAL, i);
    else if (roll < 5) content = pick(LINKS, i) + " " + pick(WORK, i);
    else if (roll < 12) content = pick(OWNER, i);
    else if (roll < 40) content = pick(WORK, i);
    else content = pick(CHITCHAT, i);
    msgs.push({
      id: "m" + i,
      session_name: "项目群" + (i % 600),
      session_kind: "group",
      sender: "成员" + (i % 40),
      is_owner: i % 12 === 0,
      ts: 1770000000000 + ((i * 137) % (720 * 86400000)),
      content: content + "，" + LONG + " " + u,
    });
  }
  const opts = { now: new Date(1780000000000), top: 15 };
  const mapAware = (v) => JSON.stringify(v, (_k, x) => (x instanceof Map ? { __map: Object.fromEntries(x) } : x));
  eq(mapAware(team.teamReview(msgs, opts)), mapAware(teamOld.teamReview(msgs, opts)), "新旧引擎全输出必须逐位一致（Map-aware 对拍）");
  team.teamReview(msgs, opts);
  teamOld.teamReview(msgs, opts);
  let msNew = Infinity, msOld = Infinity, out = null;
  for (let k = 0; k < 3; k += 1) {
    const t0 = Date.now();
    out = team.teamReview(msgs, opts);
    msNew = Math.min(msNew, Date.now() - t0);
    const t1 = Date.now();
    teamOld.teamReview(msgs, opts);
    msOld = Math.min(msOld, Date.now() - t1);
  }
  ok(msNew < msOld * 0.8, "lazy 建行 " + msNew + "ms 应 < eager 旧式 " + msOld + "ms × 0.8（POC 引擎级 0.69 @8% 命中密度）");
  ok(out.window_messages === 200000, "产出应完整：window_messages " + out.window_messages);
  console.log("      实测 lazy " + msNew + "ms vs eager " + msOld + "ms（20 万条 / bench 真实分布 + 长句档，交错取最小）");
});

console.log("\n18) teamReview 日桶数值键的相对耗时（数值日键替代 toISOString，轮22）");
await t("teamReview 200k < 改前 toISOString 日键路径的 80%", async () => {
  const { pathToFileURL } = await import("node:url");
  const team = await import(new URL("../lib/analytics/team.mjs", import.meta.url).href);
  // 基线 = 轮22 改前逐字形态，由源码字符串变换反向生成（日桶循环 + by_day 输出行，共 2 处），
  // 其余 teamReview 代码与新版逐字一致（含轮21 lazy row）；各片段必须恰好命中 1 次（防并行改动后变换失配）。
  const NEW_LOOP = `  const byDay = new Map();
  let unknownDay = 0;
  for (const m of base) {
    if (!m.ts) { unknownDay += 1; continue; }
    const d = new Date(m.ts);
    const key = d.getUTCFullYear() * 384 + d.getUTCMonth() * 32 + d.getUTCDate();
    if (key !== key) d.toISOString(); // truthy 但非法时间：与旧实现同款抛 RangeError
    byDay.set(key, (byDay.get(key) ?? 0) + 1);
  }`;
  const OLD_LOOP = `  const byDay = new Map();
  for (const m of base) {
    const day = m.ts ? new Date(m.ts).toISOString().slice(0, 10) : "未知";
    byDay.set(day, (byDay.get(day) ?? 0) + 1);
  }`;
  const NEW_ROW = `      by_day: [...byDay.entries()].map(([k, count]) => ({ day: fmtDayKey(k), count })).concat(unknownDay ? [{ day: "未知", count: unknownDay }] : []).sort((a, b) => (a.day < b.day ? -1 : 1)),`;
  const OLD_ROW = `      by_day: [...byDay.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([day, count]) => ({ day, count })),`;
  const pairs = [[NEW_LOOP, OLD_LOOP, 1], [NEW_ROW, OLD_ROW, 1]];
  const src = fs.readFileSync(new URL("../lib/analytics/team.mjs", import.meta.url), "utf8");
  let oldSrc = src;
  for (const [oldS, newS, n] of pairs) {
    if (oldSrc.split(oldS).length - 1 !== n) throw new Error("片段命中数失配（期望 " + n + "）：" + oldS.slice(0, 40));
    oldSrc = oldSrc.split(oldS).join(newS);
  }
  const genPath = path.join(ROOT, "team-oldday-old.mjs");
  fs.writeFileSync(genPath, oldSrc
    .split('from "./core.mjs"').join('from "' + new URL("../lib/analytics/core.mjs", import.meta.url).href + '"')
    .split('from "../signals.mjs"').join('from "' + new URL("../lib/signals.mjs", import.meta.url).href + '"'));
  const teamOld = await import(pathToFileURL(genPath).href);
  // 语料：bench 真实分布 + 中性长句 + base-700 唯一尾缀（与 §17 同族）；日桶对每条消息都计数，无需命中密度分档。
  const CHITCHAT = ["收到", "好的没问题", "哈哈哈哈", "今天天气不错", "我先看一下", "稍等我看下", "嗯嗯理解了", "这个我记一下", "好的明天再说", "辛苦啦"];
  const WORK = ["这个需求我这边排一下期", "先对齐一下范围", "文档我更新了", "我们内部过一下", "这块按上周说的做", "进度同步一下"];
  const DEAL = ["有项目方找 KOL 做投放，预算 3000-5000 RMB，AI 方向优先", "品牌方招募 AI 博主，预算 8000，需要主页和数据", "想找讲师做企业内训，2 天课程，预算可谈", "麻烦发一下 invoice，我们这周安排结算", "初稿周四前需要，brief 已发邮箱"];
  const LINKS = ["https://example.com/campaign-brief", "https://mp.weixin.qq.com/s/AbCdEf123456", "https://x.com/someone/status/1234567890"];
  const OWNER = ["好的，我今天晚些把报价整理给你", "我这边可以，麻烦先发大纲", "初稿我今晚 8 点前给你", "我整理一下数据一起发你"];
  const LONG = "这周三下午三点开个会对一遍细节排期等评审后再定回头发你，高铁票买好了酒店订在会展中心附近出发前把值机和导航都弄一下";
  const pick = (arr, i) => arr[i % arr.length];
  const msgs = [];
  for (let i = 0; i < 200000; i += 1) {
    const u = String.fromCharCode(0x4e00 + (i % 700), 0x4e00 + (Math.floor(i / 700) % 700));
    const roll = i % 100;
    let content;
    if (roll < 2) content = pick(DEAL, i);
    else if (roll < 5) content = pick(LINKS, i) + " " + pick(WORK, i);
    else if (roll < 12) content = pick(OWNER, i);
    else if (roll < 40) content = pick(WORK, i);
    else content = pick(CHITCHAT, i);
    msgs.push({
      id: "m" + i,
      session_name: "项目群" + (i % 600),
      session_kind: "group",
      sender: "成员" + (i % 40),
      is_owner: i % 12 === 0,
      ts: 1770000000000 + ((i * 137) % (720 * 86400000)),
      content: content + "，" + LONG + " " + u,
    });
  }
  const opts = { now: new Date(1780000000000), top: 15 };
  const mapAware = (v) => JSON.stringify(v, (_k, x) => (x instanceof Map ? { __map: Object.fromEntries(x) } : x));
  eq(mapAware(team.teamReview(msgs, opts)), mapAware(teamOld.teamReview(msgs, opts)), "新旧引擎全输出必须逐位一致（Map-aware 对拍）");
  team.teamReview(msgs, opts);
  teamOld.teamReview(msgs, opts);
  let msNew = Infinity, msOld = Infinity, out = null;
  for (let k = 0; k < 3; k += 1) {
    const t0 = Date.now();
    out = team.teamReview(msgs, opts);
    msNew = Math.min(msNew, Date.now() - t0);
    const t1 = Date.now();
    teamOld.teamReview(msgs, opts);
    msOld = Math.min(msOld, Date.now() - t1);
  }
  ok(msNew < msOld * 0.8, "日键数值化 " + msNew + "ms 应 < toISOString 旧式 " + msOld + "ms × 0.8（POC 引擎级 0.65，目标 ≥25% 收益）");
  ok(out.window_messages === 200000, "产出应完整：window_messages " + out.window_messages);
  console.log("      实测 新式 " + msNew + "ms vs 旧式 " + msOld + "ms（20 万条 / bench 真实分布 + 长句档，交错取最小）");
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
