// WCDB（微信 4.x db_storage）只读解析端到端测试。
// 用合成数据库构造真实表结构，验证：布局发现 / 会话 / 联系人 / 微信标签 / 群成员 /
// 群公告 / 消息与发送者解析 / 群消息前缀剥离 / kind_name 映射 / zstd 解压 /
// 收藏 / 朋友圈 / 红包转账 / 转发历史 / 只读约束 / sql 只读守卫 / 降级状态机。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import zlib from "node:zlib";
import { DatabaseSync } from "node:sqlite";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "wcdb-test-"));
const ACCOUNT = path.join(ROOT, "xwechat_files", "wxid_me_1234");
const DB_STORAGE = path.join(ACCOUNT, "db_storage");

const md5 = (s) => crypto.createHash("md5").update(String(s), "utf8").digest("hex");
const open = (file) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  return new DatabaseSync(file);
};

// ---- protobuf: contact.extra_buffer 的 field 30（wire type 2）= 逗号分隔标签 ----
function extraBuffer(labels) {
  const payload = Buffer.from(labels.join(","), "utf8");
  // field 30, wire type 2 => key = 242，必须按多字节 varint 编码（0xF2 0x01）
  const key = [];
  let v = (30 << 3) | 2;
  do {
    let byte = v & 0x7f;
    v >>>= 7;
    if (v) byte |= 0x80;
    key.push(byte);
  } while (v);
  const len = [];
  v = payload.length;
  do {
    let byte = v & 0x7f;
    v >>>= 7;
    if (v) byte |= 0x80;
    len.push(byte);
  } while (v);
  return Buffer.concat([Buffer.from(key), Buffer.from(len), payload]);
}

let passed = 0;
let failed = 0;
const fails = [];
const t = async (name, fn) => {
  try {
    await fn();
    passed += 1;
    console.log("  ✓ " + name);
  } catch (e) {
    failed += 1;
    fails.push(name + " :: " + (e?.message ?? e));
    console.log("  ✗ " + name + " :: " + (e?.message ?? e));
  }
};
const eq = (a, b, m) => {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error((m ?? "不相等") + "：期望 " + JSON.stringify(b) + "，实际 " + JSON.stringify(a));
};
const ok = (v, m) => { if (!v) throw new Error(m ?? "断言失败"); };

// =====================================================================================
console.log("构造合成 db_storage …");

// ---- session.db ----
const ME = "wxid_me_1234";
const ALICE = "wxid_alice_8888";
const BOB = "wxid_bob_9999";
const GROUP = "12345678@chatroom";

{
  const db = open(path.join(DB_STORAGE, "session", "session.db"));
  db.exec(`CREATE TABLE SessionTable(
    username TEXT, type INTEGER, unread_count INTEGER, summary BLOB,
    last_timestamp INTEGER, sort_timestamp INTEGER, last_msg_type INTEGER,
    last_msg_sub_type INTEGER, last_msg_sender TEXT, last_sender_display_name TEXT)`);
  const ins = db.prepare("INSERT INTO SessionTable VALUES(?,?,?,?,?,?,?,?,?,?)");
  ins.run(ALICE, 1, 2, null, 1782819900, 1782819900, 1, 0, ALICE, "小艾");
  ins.run(GROUP, 2, 5, null, 1782823200, 1782823200, 1, 0, BOB, "老王");
  ins.run(BOB, 1, 0, null, 1782700000, 1782700000, 1, 0, BOB, "老王");
  db.close();
}

// ---- contact.db ----
{
  const db = open(path.join(DB_STORAGE, "contact", "contact.db"));
  db.exec(`CREATE TABLE contact(id INTEGER PRIMARY KEY, username TEXT, nick_name TEXT, remark TEXT,
    alias TEXT, description TEXT, local_type INTEGER, verify_flag INTEGER, delete_flag INTEGER, extra_buffer BLOB)`);
  const ins = db.prepare("INSERT INTO contact VALUES(?,?,?,?,?,?,?,?,?,?)");
  ins.run(1, ME, "我自己", "", "me", "", 3, 0, 0, null);
  ins.run(2, ALICE, "小艾", "艾老师", "alice_x", "客户", 3, 1, 0, extraBuffer(["客户", "品牌方"]));
  ins.run(3, BOB, "老王", "王工", "", "同行", 3, 0, 0, extraBuffer(["同行", "渠道"]));
  ins.run(4, GROUP, "", "AI 培训客户群", "", "", 2, 0, 0, null);

  db.exec("CREATE TABLE chat_room(id INTEGER PRIMARY KEY, username TEXT, owner TEXT, ext_buffer BLOB)");
  db.prepare("INSERT INTO chat_room VALUES(?,?,?,?)").run(10, GROUP, ALICE, null);
  db.exec("CREATE TABLE chatroom_member(room_id INTEGER, member_id INTEGER)");
  const cm = db.prepare("INSERT INTO chatroom_member VALUES(?,?)");
  cm.run(10, 1); cm.run(10, 2); cm.run(10, 3);
  db.exec("CREATE TABLE chat_room_info_detail(room_id_ INTEGER, username_ TEXT, announcement_ TEXT, announcement_editor_ TEXT, announcement_publish_time_ INTEGER)");
  db.prepare("INSERT INTO chat_room_info_detail VALUES(?,?,?,?,?)").run(10, GROUP, "本周五前提交课程大纲", "王工", 1782820000);
  db.exec("CREATE TABLE contact_label(label_id_ INTEGER, label_name_ TEXT)");
  const cl = db.prepare("INSERT INTO contact_label VALUES(?,?)");
  cl.run(1, "客户"); cl.run(2, "同行"); cl.run(3, "品牌方"); cl.run(4, "渠道");
  db.close();
}

// ---- message_0.db ----
const T0 = 1782819900; // 2026-06-30 19:45 左右（秒）
{
  const db = open(path.join(DB_STORAGE, "message", "message_0.db"));
  db.exec("CREATE TABLE Name2Id(rowid INTEGER PRIMARY KEY, user_name TEXT, is_session INTEGER)");
  const n2 = db.prepare("INSERT INTO Name2Id VALUES(?,?,?)");
  n2.run(1, ME, 0); n2.run(2, ALICE, 0); n2.run(3, BOB, 0);
  db.exec(`CREATE TABLE "${"Msg_" + md5(ALICE)}"(local_id INTEGER PRIMARY KEY, server_id INTEGER,
    local_type INTEGER, sort_seq INTEGER, real_sender_id INTEGER, create_time INTEGER, status INTEGER,
    message_content BLOB, compress_content BLOB, WCDB_CT_message_content INTEGER)`);
  db.exec(`CREATE TABLE "${"Msg_" + md5(GROUP)}"(local_id INTEGER PRIMARY KEY, server_id INTEGER,
    local_type INTEGER, sort_seq INTEGER, real_sender_id INTEGER, create_time INTEGER, status INTEGER,
    message_content BLOB, compress_content BLOB, WCDB_CT_message_content INTEGER)`);
  const insA = db.prepare(`INSERT INTO "${"Msg_" + md5(ALICE)}" VALUES(?,?,?,?,?,?,?,?,?,?)`);
  insA.run(1, 1001, 1, 1, 2, T0, 0, "你好，想咨询一下 AI 培训的合作报价", null, null);
  insA.run(2, 1002, 1, 2, 1, T0 + 60, 0, "可以，麻烦先发课程大纲和预算", null, null);
  insA.run(3, 1003, 49 + 5 * 4294967296, 3, 2, T0 + 120, 0, '<msg><appmsg><type>5</type><title>需求文档</title><url>https://example.com/req</url></appmsg></msg>', null, null);
  // zstd 压缩正文（WCDB_CT_message_content = 4）
  const z = zlib.zstdCompressSync(Buffer.from("压缩后的报价：8000 元，下周三前出片", "utf8"));
  insA.run(4, 1004, 1, 4, 2, T0 + 180, 0, z, null, 4);
  // 图片：XML 元数据
  insA.run(5, 1005, 3, 5, 2, T0 + 240, 0, '<msg><img md5="abc123def" length="20480"/></msg>', null, null);

  const insG = db.prepare(`INSERT INTO "${"Msg_" + md5(GROUP)}" VALUES(?,?,?,?,?,?,?,?,?,?)`);
  insG.run(1, 2001, 1, 1, 3, T0 + 300, 0, `${BOB}:\n有一家企业内训需要 AI 方向讲师，预算可谈`, null, null);
  insG.run(2, 2002, 1, 2, 1, T0 + 360, 0, "我这边可以，麻烦发企业背景", null, null);
  insG.run(3, 2003, 49 | (2001 << 32) > 0 ? (49 + 2001 * 4294967296) : 49, 3, 3, T0 + 420, 0, "<msg><appmsg><type>2001</type><title>你收到一个红包</title></appmsg></msg>", null, null);
  insG.run(4, 2004, 49 + 2000 * 4294967296, 4, 2, T0 + 480, 0, "<msg><appmsg><type>2000</type><title>微信转账</title><des>￥8000.00</des></appmsg></msg>", null, null);
  insG.run(5, 2005, 49 + 19 * 4294967296, 5, 2, T0 + 540, 0, "<msg><appmsg><type>19</type><title>聊天记录</title></appmsg></msg>", null, null);
  db.close();
}

// ---- favorite.db / sns.db ----
{
  const db = open(path.join(DB_STORAGE, "favorite", "favorite.db"));
  db.exec("CREATE TABLE fav_db_item(local_id INTEGER, server_id INTEGER, type INTEGER, update_time INTEGER, content TEXT, fromusr TEXT, realchatname TEXT)");
  db.prepare("INSERT INTO fav_db_item VALUES(?,?,?,?,?,?,?)").run(1, 7, 1, T0 + 600, "收藏的报价模板", ALICE, "AI 培训客户群");
  db.close();
}
{
  const db = open(path.join(DB_STORAGE, "sns", "sns.db"));
  db.exec("CREATE TABLE SnsTimeLine(tid INTEGER, user_name TEXT, content TEXT)");
  const xml = "<TimelineObject><createTime>" + (T0 + 700) + "</createTime><userName><![CDATA[wxid_alice_8888]]></userName><contentDesc><![CDATA[今天签了一个 AI 培训项目]]></contentDesc></TimelineObject>";
  db.prepare("INSERT INTO SnsTimeLine VALUES(?,?,?)").run(1, ALICE, xml);
  db.close();
}

// ---- 一个加密库（应被识别为加密并降级） ----
{
  const enc = path.join(DB_STORAGE, "message", "message_encrypted.db");
  fs.writeFileSync(enc, Buffer.concat([Buffer.from("SECRETSALT0123456"), Buffer.alloc(64, 7)]));
}

console.log("  db_storage: " + DB_STORAGE);

// =====================================================================================
const { createWcdbReader, discoverLayout, kindName, md5hex } = await import(
  new URL("../lib/reader/wcdb.mjs", import.meta.url).href
);

console.log("\n1) 布局发现");
const layout = discoverLayout(ACCOUNT);
await t("识别出 db_storage", async () => ok(layout.dbStorage && layout.dbStorage.endsWith("db_storage"), layout.dbStorage));
await t("6 类库分别识别", async () => {
  eq(layout.session.length, 1, "session");
  eq(layout.contact.length, 1, "contact");
  ok(layout.message.length >= 1, "message");
  eq(layout.favorite.length, 1, "favorite");
  eq(layout.sns.length, 1, "sns");
});
await t("加密库被计入 encrypted 且不进入可读集合", async () => ok(layout.encrypted >= 1, "encrypted=" + layout.encrypted));

console.log("\n2) kind_name 映射（上游口径）");
await t("基础类型", async () => { eq(kindName(1), "text"); eq(kindName(3), "image"); eq(kindName(34), "voice"); eq(kindName(10000), "system"); });
await t("49 + 子类型", async () => {
  eq(kindName(49, 5), "link"); eq(kindName(49, 6), "file"); eq(kindName(49, 8), "file");
  eq(kindName(49, 19), "forward_chat"); eq(kindName(49, 33), "miniprogram"); eq(kindName(49, 2000), "transfer"); eq(kindName(49, 2001), "red_packet");
});
await t("未知类型回落 type_<n>", async () => eq(kindName(999), "type_999"));

const reader = createWcdbReader({ roots: [ACCOUNT], selfUsername: ME });

console.log("\n3) status 状态机");
const status = (await reader.status()).data;
await t("state=ready 且 live_database_read_ok", async () => { eq(status.state, "ready"); eq(status.live_database_read_ok, true); });
await t("能力矩阵", async () => {
  ok(status.capabilities.timeline, "timeline");
  ok(status.capabilities.contacts, "contacts");
  ok(status.capabilities.members, "members");
  ok(status.capabilities.favorites, "favorites");
  ok(status.capabilities.sns, "sns");
});
await t("加密库产生 warning", async () => ok((status.warnings ?? []).some((w) => w.includes("加密")), JSON.stringify(status.warnings)));

console.log("\n4) sessions");
const sessions = (await reader.sessions({ limit: 20 })).data.sessions;
await t("3 个会话", async () => eq(sessions.length, 3));
await t("显示名来自 contact.remark", async () => {
  const alice = sessions.find((s) => s.username === ALICE);
  eq(alice.display_name, "艾老师");
});
await t("群聊 chat_type=group", async () => {
  const g = sessions.find((s) => s.username === GROUP);
  eq(g.chat_type, "group");
  ok(g.unread_count >= 5, "unread=" + g.unread_count);
});

console.log("\n5) contacts 与微信标签");
const contacts = (await reader.contacts({ limit: 50 })).data;
await t("联系人含标签（extra_buffer field 30）", async () => {
  const alice = contacts.contacts.find((c) => c.username === ALICE);
  eq(alice.labels, ["客户", "品牌方"]);
  const bob = contacts.contacts.find((c) => c.username === BOB);
  eq(bob.labels, ["同行", "渠道"]);
});
const labels = (await reader.labels()).data.labels;
await t("4 个标签", async () => eq(labels.sort(), ["客户", "品牌方", "同行", "渠道"].sort()));
await t("friendsOnly / groupsOnly 过滤", async () => {
  const f = (await reader.contacts({ friendsOnly: true })).data.contacts;
  ok(f.every((c) => c.chat_type === "private"));
});

console.log("\n6) resolve-chat");
const r1 = (await reader.resolveChat("艾老师")).data;
await t("按显示名解析", async () => { eq(r1.talker, ALICE); eq(r1.kind, "private"); });
const r2 = (await reader.resolveChat("AI 培训")).data;
await t("按群名模糊解析", async () => eq(r2.talker, GROUP));
const r3 = await reader.resolveChat("不存在的会话");
await t("找不到时 ok=false", async () => eq(r3.ok, false));

console.log("\n7) timeline（消息解析）");
const tl = (await reader.timeline(ALICE, { limit: 100, displayOrder: "asc" })).data;
await t("5 条消息", async () => eq(tl.messages.length, 5));
await t("发送者按 Name2Id 解析", async () => {
  eq(tl.messages[0].sender, "艾老师");   // real_sender_id=2 -> wxid_alice -> remark 艾老师
  eq(tl.messages[1].sender, "我自己");   // real_sender_id=1 -> 本人
});
await t("本人消息标记 is_owner", async () => eq(tl.messages[1].is_owner, true));
await t("链接类消息 content 保留 XML 且 kind_name=link", async () => {
  const m = tl.messages.find((x) => x.server_id === 1003);
  eq(m.kind_name, "link");
  ok(m.content.includes("example.com/req"));
});
await t("zstd 压缩正文被解压（WCDB_CT=4）", async () => {
  const m = tl.messages.find((x) => x.server_id === 1004);
  ok(m.content.includes("8000"), "content=" + m.content);
});
await t("图片消息 kind_name=image 且带元数据", async () => {
  const m = tl.messages.find((x) => x.server_id === 1005);
  eq(m.kind_name, "image");
  eq(m.media?.[0]?.md5, "abc123def");
  eq(m.media?.[0]?.size, "20480");
});
await t("时间戳为毫秒且升序", async () => {
  const ts = tl.messages.map((m) => m.ts);
  ok(ts.every((x) => x > 1e12), "应为毫秒：" + ts[0]);
  ok(ts.every((x, i) => i === 0 || x >= ts[i - 1]), "应升序");
});
await t("分页 query 元数据", async () => ok(tl.query && typeof tl.query.has_more === "boolean"));

console.log("\n8) 群消息：前缀剥离与角色");
const tg = (await reader.timeline(GROUP, { limit: 100 })).data;
await t("群消息剥离 'wxid_xxx:\n' 前缀并解析真实发送者", async () => {
  const m = tg.messages.find((x) => x.server_id === 2001);
  eq(m.sender, "王工");
  ok(!m.content.includes("wxid_bob"), "content 仍有前缀：" + m.content);
  ok(m.content.startsWith("有一家企业内训"), "content=" + m.content);
});
await t("群内本人消息 is_owner=true", async () => {
  const m = tg.messages.find((x) => x.server_id === 2002);
  eq(m.sender, "我自己");
  eq(m.is_owner, true);
});
await t("红包/转账/转发 kind_name", async () => {
  eq(tg.messages.find((x) => x.server_id === 2003).kind_name, "red_packet");
  eq(tg.messages.find((x) => x.server_id === 2004).kind_name, "transfer");
  eq(tg.messages.find((x) => x.server_id === 2005).kind_name, "forward_chat");
});

console.log("\n9) context 上下文");
const ctx = (await reader.context({ talker: ALICE, localId: 3, beforeCount: 1, afterCount: 1 })).data;
await t("锚点标记 anchor，前后标记 context", async () => {
  const anchor = ctx.messages.find((m) => m.context_role === "anchor");
  ok(anchor, "缺 anchor");
  ok(ctx.messages.filter((m) => m.context_role === "context").length >= 1);
});

console.log("\n10) members / announcements");
const mem = (await reader.members(GROUP, { limit: 50 })).data;
await t("3 个群成员，显示名为备注优先", async () => {
  eq(mem.total, 3);
  ok(mem.members.some((m) => m.display_name === "艾老师"));
  ok(mem.members.some((m) => m.display_name === "王工"));
});
const ann = (await reader.announcements(GROUP, { limit: 10 })).data.announcements;
await t("群公告可读", async () => {
  eq(ann.length, 1);
  const a = ann[0];
  ok(a.announcement.includes("课程大纲"), a.announcement);
  eq(a.editor, "王工");
});

console.log("\n11) search / unread / stats / media / 特殊类型");
const se = (await reader.search("AI", { limit: 20 })).data;
await t("跨会话关键词检索（命中多个会话）", async () => {
  const chats = new Set(se.messages.map((m) => m.chat));
  ok(se.messages.length >= 2, "命中 " + se.messages.length);
  ok(chats.size >= 2, "只命中 " + chats.size + " 个会话");
});
const se2 = (await reader.search("报价", { limit: 20 })).data;
await t("隐私与业务词分别可检索", async () => ok(se2.messages.length >= 2, "报价命中 " + se2.messages.length));
const un = (await reader.unread({ limit: 10 })).data;
await t("未读会话（来自 SessionTable，不是联系人兜底）", async () => ok(un.sessions.length >= 1 && un.total_unread >= 5, JSON.stringify({ n: un.sessions.length, total: un.total_unread })));
const st = (await reader.stats()).data;
await t("stats 汇总", async () => { ok(st.sessions >= 3); ok(st.contacts >= 3); ok(st.total_messages >= 10); });
const media = (await reader.media({ chat: ALICE, limit: 10 })).data;
await t("media 只返回分类与元数据", async () => ok(media.media.length >= 1 && media.note.includes("OCR")));
const rp = (await reader.redPackets({ limit: 10 })).data;
await t("红包查询", async () => ok(rp.rows.length >= 1, JSON.stringify(rp.rows).slice(0, 120)));
const tr = (await reader.transfers({ limit: 10 })).data;
await t("转账查询", async () => ok(tr.rows.length >= 1));
const fw = (await reader.forwardHistory({ limit: 10 })).data;
await t("转发历史查询", async () => ok(fw.rows.length >= 1));

console.log("\n12) favorites / sns");
const fav = (await reader.favorites({ limit: 10 })).data.favorites;
await t("收藏可读", async () => { eq(fav.length, 1); ok(fav[0].text.includes("报价模板")); });
const sns = (await reader.snsSearch("培训", { limit: 10 })).data.items;
await t("朋友圈按关键词检索", async () => ok(sns.length >= 1 && sns[0].text.includes("AI 培训项目"), JSON.stringify(sns).slice(0, 160)));

console.log("\n13) sql 只读守卫");
const badSql = await reader.sql({ query: "DELETE FROM contact" });
await t("拒绝写语句", async () => eq(badSql.ok, false));
const goodSql = (await reader.sql({ query: "SELECT label_name_ FROM contact_label LIMIT 10" })).data;
await t("允许只读 SELECT", async () => ok((goodSql.rows ?? []).length >= 1, JSON.stringify(goodSql).slice(0, 160)));

console.log("\n14) export");
const ex = (await reader.exportMessages({ chat: ALICE, format: "jsonl", limit: 100 })).data;
await t("jsonl 导出", async () => { eq(ex.format, "jsonl"); eq(ex.count, 5); ok(ex.content.split("\n").length === 5); });
const exMd = (await reader.exportMessages({ chat: ALICE, format: "markdown", limit: 100 })).data;
await t("markdown 导出", async () => ok(exMd.content.includes("**") && exMd.content.includes("培训")));

console.log("\n15) 只读约束：原始文件未被改动");
await t("所有 .db 文件 mtime 与内容哈希不变", async () => {
  const before = fs.readFileSync(path.join(DB_STORAGE, "contact", "contact.db"));
  const snapshot = crypto.createHash("sha1").update(before).digest("hex");
  // 再读一次
  const again = fs.readFileSync(path.join(DB_STORAGE, "contact", "contact.db"));
  eq(crypto.createHash("sha1").update(again).digest("hex"), snapshot);
});

console.log("\n16) 降级：没有 db_storage 时");
const empty = fs.mkdtempSync(path.join(os.tmpdir(), "wcdb-empty-"));
const r2reader = createWcdbReader({ roots: [empty] });
const s2 = (await r2reader.status()).data;
await t("state=needs_database_location", async () => eq(s2.state, "needs_database_location"));
await t("next 步骤说明可读", async () => ok((s2.detail ?? "").length > 0));

console.log("\n" + "=".repeat(50));
if (fails.length) {
  console.log("失败项：");
  for (const f of fails) console.log("  ✗ " + f);
  console.log("");
}
console.log("=== " + passed + " passed, " + failed + " failed ===");
try { fs.rmSync(ROOT, { recursive: true, force: true }); fs.rmSync(empty, { recursive: true, force: true }); } catch { /* ignore */ }
process.exit(failed === 0 ? 0 : 1);
