// 结构漂移（schema drift）测试：真实的微信库不会和合成夹具完全一致。
// 这里刻意制造列顺序不同、缺列、大小写不同、3.x 老布局、脏数据、只有消息没有会话表等情况，
// 断言 reader 要么给出正确结果，要么**明确降级并告警**——绝不静默给出错误数据。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import zlib from "node:zlib";
import { DatabaseSync } from "node:sqlite";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "drift-test-"));
const md5 = (s) => crypto.createHash("md5").update(String(s), "utf8").digest("hex");
const open = (f) => { fs.mkdirSync(path.dirname(f), { recursive: true }); return new DatabaseSync(f); };

let passed = 0, failed = 0;
const fails = [];
const t = async (name, fn) => {
  try { await fn(); passed += 1; console.log("  ✓ " + name); }
  catch (e) { failed += 1; fails.push(name + " :: " + (e?.message ?? e)); console.log("  ✗ " + name + " :: " + (e?.message ?? e)); }
};
const eq = (a, b, m) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error((m ?? "不相等") + "：期望 " + JSON.stringify(b) + "，实际 " + JSON.stringify(a)); };
const ok = (v, m) => { if (!v) throw new Error(m ?? "断言失败"); };

const { createWcdbReader } = await import(new URL("../lib/reader/wcdb.mjs", import.meta.url).href);

const ME = "wxid_me_1234";
const ALICE = "wxid_alice_8888";
const GROUP = "98765432@chatroom";
const T0 = 1782819900;

// =====================================================================================
// 变体 1：列顺序打乱、缺 sort_timestamp、缺 WCDB_CT_message_content、缺 compress_content、
//         缺 server_id、表名大小写不同
// =====================================================================================
console.log("变体 1：列顺序不同 + 关键列缺失 + 大小写不同");
const V1 = path.join(ROOT, "v1", "db_storage");
{
  // session：没有 sort_timestamp，只有 last_timestamp；表名小写
  const db = open(path.join(V1, "session", "session.db"));
  db.exec("CREATE TABLE sessiontable(last_timestamp INTEGER, username TEXT, unread_count INTEGER, summary TEXT, type INTEGER, last_sender_display_name TEXT)");
  db.prepare("INSERT INTO sessiontable VALUES(?,?,?,?,?,?)").run(T0, ALICE, 3, "最后一条摘要", 1, "小艾");
  db.close();
}
{
  // contact：列顺序完全不同，且没有 extra_buffer
  const db = open(path.join(V1, "contact", "contact.db"));
  db.exec("CREATE TABLE Contact(remark TEXT, username TEXT, id INTEGER PRIMARY KEY, nick_name TEXT, alias TEXT, local_type INTEGER)");
  db.prepare("INSERT INTO Contact VALUES(?,?,?,?,?,?)").run("艾老师", ALICE, 2, "小艾", "alice_x", 3);
  db.prepare("INSERT INTO Contact VALUES(?,?,?,?,?,?)").run("", ME, 1, "我自己", "me", 3);
  db.close();
}
{
  // message：没有 WCDB_CT_message_content（zstd 只能靠 magic 识别）、没有 compress_content、没有 server_id
  const db = open(path.join(V1, "message", "message_0.db"));
  db.exec("CREATE TABLE name2id(rowid INTEGER PRIMARY KEY, user_name TEXT)");
  db.prepare("INSERT INTO name2id VALUES(?,?)").run(1, ME);
  db.prepare("INSERT INTO name2id VALUES(?,?)").run(2, ALICE);
  const tbl = "msg_" + md5(ALICE);
  db.exec(`CREATE TABLE "${tbl}"(create_time INTEGER, message_content BLOB, real_sender_id INTEGER, local_id INTEGER PRIMARY KEY, local_type INTEGER)`);
  const ins = db.prepare(`INSERT INTO "${tbl}" VALUES(?,?,?,?,?)`);
  ins.run(T0, "纯文本消息", 2, 1, 1);
  ins.run(T0 + 60, zlib.zstdCompressSync(Buffer.from("压缩正文靠 magic 识别", "utf8")), 2, 2, 1);
  ins.run(T0 + 120, null, 1, 3, 1);            // NULL 正文
  ins.run(T0 + 180, "", 1, 4, 1);              // 空正文
  ins.run(T0 + 240, Buffer.from([0xff, 0xfe, 0x41]), 2, 5, 1); // 非法 UTF-8
  db.close();
}

const r1 = createWcdbReader({ roots: [path.join(ROOT, "v1")], selfUsername: ME });
await t("列顺序打乱后仍识别为 ready", async () => {
  const s = (await r1.status()).data;
  eq(s.state, "ready", JSON.stringify(s).slice(0, 300));
});
await t("大小写不同的表名仍能读取", async () => {
  const sessions = (await r1.sessions({ limit: 10 })).data.sessions;
  eq(sessions.length, 1);
  eq(sessions[0].display_name, "艾老师");
  eq(sessions[0].unread_count, 3, "缺 sort_timestamp 时应按 last_timestamp 排序并读到未读数");
  eq(sessions[0].summary, "最后一条摘要");
});
await t("缺 WCDB_CT 时靠 zstd magic 仍能解压", async () => {
  const rows = (await r1.timeline(ALICE, { limit: 10 })).data.messages;
  const z = rows.find((m) => String(m.content).includes("压缩正文"));
  ok(z, "未解压：" + JSON.stringify(rows.map((m) => m.content)));
});
await t("NULL / 空 / 非法 UTF-8 正文都不抛异常", async () => {
  const rows = (await r1.timeline(ALICE, { limit: 10 })).data.messages;
  eq(rows.length, 5);
  ok(rows.every((m) => typeof m.content === "string"), "content 必须都是字符串");
});
await t("缺 extra_buffer 时标签为空数组而不是崩溃", async () => {
  const c = (await r1.contacts({ limit: 10 })).data.contacts;
  ok(c.every((x) => Array.isArray(x.labels)), "labels 必须是数组");
  eq(c.find((x) => x.username === ALICE).labels, []);
});
await t("缺 server_id 时该字段为 null 而不是 undefined", async () => {
  const rows = (await r1.timeline(ALICE, { limit: 10 })).data.messages;
  ok(rows.every((m) => m.server_id === null), "server_id 应为 null");
  ok(rows.some((m) => m.local_id !== null), "local_id 应可读");
});

// =====================================================================================
// 变体 2：微信 3.x 老布局（MSG 表）
// =====================================================================================
console.log("\n变体 2：微信 3.x（MSG 表）");
const V2 = path.join(ROOT, "v2", "db_storage");
{
  const db = open(path.join(V2, "message", "MSG0.db"));
  db.exec(`CREATE TABLE MSG(localId INTEGER PRIMARY KEY, TalkerId INTEGER, MsgSvrID INTEGER, Type INTEGER,
    SubType INTEGER, IsSender INTEGER, CreateTime INTEGER, StrTalker TEXT, StrContent TEXT, DisplayContent TEXT,
    CompressContent BLOB, BytesExtra BLOB)`);
  const ins = db.prepare("INSERT INTO MSG VALUES(?,?,?,?,?,?,?,?,?,?,?,?)");
  ins.run(1, 0, 9001, 1, 0, 0, T0, "wxid_bob_7777", "老版本库的文本消息", null, null, null);
  ins.run(2, 0, 9002, 1, 0, 1, T0 + 60, "wxid_bob_7777", "我发出的消息", null, null, null);
  ins.run(3, 0, 9003, 3, 0, 0, T0 + 120, "wxid_bob_7777", null, "[图片]", null, null);
  db.close();
}
const { createSqliteReader } = await import(new URL("../lib/reader/sqlite.mjs", import.meta.url).href);
const r2 = createSqliteReader({ roots: [path.join(ROOT, "v2")] });
await t("3.x MSG 表被识别为 wechat3", async () => {
  const d = r2.describe();
  ok((d.schemas ?? []).some((x) => x.schema === "wechat3"), JSON.stringify(d.schemas ?? d));
});
await t("3.x status=ready 且能读到消息", async () => {
  const s = (await r2.status()).data;
  eq(s.state, "ready");
  ok(s.message_count >= 3, "message_count=" + s.message_count);
});
await t("3.x 文本与 DisplayContent 回退", async () => {
  const rows = (await r2.timeline("wxid_bob_7777", { limit: 10 })).data.messages;
  eq(rows.length, 3);
  ok(rows.some((m) => m.content.includes("老版本库的文本消息")));
  ok(rows.some((m) => m.content.includes("[图片]")), "StrContent 为空时应回退到 DisplayContent");
});

// =====================================================================================
// 变体 3：只有 message 库，没有 session/contact（应降级 + 明确告警）
// =====================================================================================
console.log("\n变体 3：缺 session 表（应降级并告警，而不是静默给错）");
const V3 = path.join(ROOT, "v3", "db_storage");
{
  const db = open(path.join(V3, "message", "message_0.db"));
  db.exec("CREATE TABLE Name2Id(rowid INTEGER PRIMARY KEY, user_name TEXT)");
  db.prepare("INSERT INTO Name2Id VALUES(?,?)").run(1, "wxid_solo_1111");
  const tbl = "Msg_" + md5("wxid_solo_1111");
  db.exec(`CREATE TABLE "${tbl}"(local_id INTEGER PRIMARY KEY, local_type INTEGER, real_sender_id INTEGER, create_time INTEGER, message_content BLOB)`);
  db.prepare(`INSERT INTO "${tbl}" VALUES(?,?,?,?,?)`).run(1, 1, 1, T0, "只有消息没有会话表");
  db.close();
}
const r3 = createWcdbReader({ roots: [path.join(ROOT, "v3")], selfUsername: ME });
await t("缺会话表时仍能列出会话（由联系人/消息推断）", async () => {
  const s = (await r3.status()).data;
  eq(s.state, "ready");
  const sessions = (await r3.sessions({ limit: 10 })).data.sessions;
  ok(sessions.length >= 1, "至少有 1 个会话");
});
await t("缺会话表会在 warnings 里明确说明（不静默）", async () => {
  const s = (await r3.status()).data;
  ok((s.warnings ?? []).length >= 1, "warnings 应非空：" + JSON.stringify(s.warnings));
});

// =====================================================================================
// 变体 4：rglob 更深的目录层级 + 多个账号目录
// =====================================================================================
console.log("\n变体 4：多账号 / 深层目录");
const V4ROOT = path.join(ROOT, "v4");
{
  // 账号 A：完整
  const A = path.join(V4ROOT, "account_a", "db_storage");
  const db = open(path.join(A, "session", "session.db"));
  db.exec("CREATE TABLE SessionTable(username TEXT, type INTEGER, unread_count INTEGER, last_timestamp INTEGER, sort_timestamp INTEGER, summary BLOB)");
  db.prepare("INSERT INTO SessionTable VALUES(?,?,?,?,?,?)").run("wxid_a1", 1, 0, T0, T0, null);
  db.close();
  // 账号 B：另一个 db_storage
  const B = path.join(V4ROOT, "account_b", "db_storage");
  const db2 = open(path.join(B, "session", "session.db"));
  db2.exec("CREATE TABLE SessionTable(username TEXT, type INTEGER, unread_count INTEGER, last_timestamp INTEGER, sort_timestamp INTEGER, summary BLOB)");
  db2.prepare("INSERT INTO SessionTable VALUES(?,?,?,?,?,?)").run("wxid_b1", 1, 1, T0 + 10, T0 + 10, null);
  db2.close();
}
const r4 = createWcdbReader({ roots: [V4ROOT], selfUsername: "wxid_a1" });
await t("多账号目录都能被发现", async () => {
  const s = (await r4.status()).data;
  eq(s.state, "ready");
  eq(s.session_dbs, 2, "应发现 2 个 session 库");
});
await t("多账号会话合并可见", async () => {
  const names = (await r4.sessions({ limit: 10 })).data.sessions.map((x) => x.username).sort();
  eq(names, ["wxid_a1", "wxid_b1"]);
});

// =====================================================================================
// 变体 5：vault 文本导出的 BOM / CRLF / 全角冒号
// =====================================================================================
console.log("\n变体 5：vault 文本导出编码与标点变体");
const { createVaultReader } = await import(new URL("../lib/reader/vault.mjs", import.meta.url).href);
const VB = path.join(ROOT, "vault-enc");
fs.mkdirSync(VB, { recursive: true });
fs.writeFileSync(path.join(VB, "bom-crlf.txt"), "\uFEFF【BOM 群】\r\n[2026-06-30 10:00] 甲：全角冒号\r\n[2026-06-30 10:01] 乙: 半角冒号\r\n", "utf8");
fs.writeFileSync(path.join(VB, "gbk-like.json"), JSON.stringify([{ chat: "编码群", sender: "甲", time: "2026-06-30 11:00", content: "包含 emoji 🎉 和制表符\t的内容" }]), "utf8");
const rv = createVaultReader({ dirs: [VB], force: true });
await t("BOM 与 CRLF 不影响解析", async () => {
  const names = (await rv.sessions({ limit: 10 })).data.sessions.map((s) => s.name);
  ok(names.some((n) => n.includes("BOM 群")), JSON.stringify(names));
});
await t("全角冒号与半角冒号都能切分", async () => {
  const rows = (await rv.timeline("BOM 群", { limit: 10 })).data.messages;
  eq(rows.length, 2, JSON.stringify(rows));
  ok(rows.some((m) => m.content.includes("全角冒号")));
  ok(rows.some((m) => m.content.includes("半角冒号")));
});
await t("emoji 与制表符内容原样保留", async () => {
  const rows = (await rv.search("emoji", { limit: 10 })).data.messages;
  ok(rows.length === 1 && rows[0].content.includes("🎉"), JSON.stringify(rows));
});

console.log("\n" + "=".repeat(50));
if (fails.length) {
  console.log("失败项：");
  for (const f of fails) console.log("  ✗ " + f);
  console.log("");
}
console.log("=== " + passed + " passed, " + failed + " failed ===");
try { fs.rmSync(ROOT, { recursive: true, force: true, maxRetries: 3 }); } catch { /* ignore */ }
process.exit(failed === 0 ? 0 : 1);
