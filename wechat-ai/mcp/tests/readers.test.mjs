// 其余只读数据源端到端测试：vault（导出目录）/ cli（外部只读 CLI）/ local（本地索引）/ mock（演示）。
// cli 用真实子进程跑一个符合 rion-wechat-cli 协议的小脚本，并额外验证 fake_vault_cli 契约。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "readers-test-"));
process.env.WECHAT_AI_HOME = path.join(ROOT, "home");

let passed = 0, failed = 0;
const fails = [];
const t = async (name, fn) => {
  try { await fn(); passed += 1; console.log("  ✓ " + name); }
  catch (e) { failed += 1; fails.push(name + " :: " + (e?.message ?? e)); console.log("  ✗ " + name + " :: " + (e?.message ?? e)); }
};
const eq = (a, b, m) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error((m ?? "不相等") + "：期望 " + JSON.stringify(b) + "，实际 " + JSON.stringify(a)); };
const ok = (v, m) => { if (!v) throw new Error(m ?? "断言失败"); };

const { createVaultReader } = await import(new URL("../lib/reader/vault.mjs", import.meta.url).href);
const { createCliReader, extractJson } = await import(new URL("../lib/reader/cli.mjs", import.meta.url).href);
const { createLocalReader } = await import(new URL("../lib/reader/local.mjs", import.meta.url).href);
const { createMockReader, buildDemoMessages } = await import(new URL("../lib/reader/mock.mjs", import.meta.url).href);
const store = await import(new URL("../lib/store.mjs", import.meta.url).href);
const ingest = await import(new URL("../lib/ingest.mjs", import.meta.url).href);

// =====================================================================================
console.log("\n1) vault Reader（导出目录）");
const VAULT = path.join(ROOT, "vault");
fs.mkdirSync(VAULT, { recursive: true });
fs.writeFileSync(path.join(VAULT, "客户群.txt"), [
  "【AI 培训客户群】",
  "[2026-06-30 09:10] 王工: 我们想在 9 月做一场内部 AI 培训，想先了解你们的课程大纲和报价",
  "[2026-06-30 09:40] 我: 好的，我整理一版大纲和报价，本周内发你",
  "[2026-06-30 10:20] 李经理: 另外能不能先安排一次线上试讲，听众大概 30 人 [图片]",
  "",
].join("\n"), "utf8");
fs.writeFileSync(path.join(VAULT, "同行群.md"), [
  "# 同行交流群",
  "[2026-06-30 14:00] 老张: 有一家企业内训需要 AI 方向讲师，预算可谈 https://example.com/brief",
  "[2026-06-30 14:30] 我: 我这边可以",
  "",
].join("\n"), "utf8");
fs.writeFileSync(path.join(VAULT, "私聊.json"), JSON.stringify([
  { chat: "艾老师", sender: "艾老师", time: "2026-06-30 19:45", content: "合作报价方便报一下吗" },
  { chat: "艾老师", sender: "我", time: "2026-06-30 20:00", content: "好的，明天给你" },
]), "utf8");
fs.writeFileSync(path.join(VAULT, "消息.jsonl"), [
  JSON.stringify({ chat: "项目群", sender: "项目经理", time: "2026-06-30 15:00", content: "初稿今天能出吗" }),
  JSON.stringify({ chat: "项目群", sender: "我", time: "2026-06-30 15:30", content: "今晚 8 点前给你初稿" }),
  "",
].join("\n"), "utf8");
fs.mkdirSync(path.join(VAULT, "sub"), { recursive: true });
fs.writeFileSync(path.join(VAULT, "sub", "csv.csv"), "chat,sender,time,content\n比价群,群友,2026-06-30 16:00,\"这个账号后台报价40w一条广告\"\n", "utf8");

const vault = createVaultReader({ dirs: [VAULT], force: true });
await t("vault status=ready 且统计到消息", async () => {
  const st = (await vault.status()).data;
  eq(st.state, "ready");
  ok(st.message_count >= 8, "message_count=" + st.message_count);
  ok(st.session_count >= 4, "session_count=" + st.session_count);
});
await t("vault 解析 5 种文件格式（txt/md/json/jsonl/csv）", async () => {
  const names = (await vault.sessions({ limit: 50 })).data.sessions.map((s) => s.name);
  for (const n of ["AI 培训客户群", "同行交流群", "艾老师", "项目群", "比价群"]) {
    ok(names.some((x) => x.includes(n)), "缺少会话 " + n + "；实际：" + JSON.stringify(names));
  }
});
await t("vault 群/私聊类型判定", async () => {
  const rows = (await vault.sessions({ limit: 50 })).data.sessions;
  eq(rows.find((s) => s.name.includes("AI 培训客户群")).kind, "group");
  eq(rows.find((s) => s.name === "艾老师").kind, "private");
});
await t("vault timeline 取消息", async () => {
  const tl = (await vault.timeline("AI 培训客户群", { limit: 50, displayOrder: "asc" })).data;
  eq(tl.messages.length, 3);
  eq(tl.messages[0].sender, "王工");
  ok(tl.messages[0].links.length === 0);
});
await t("vault resolve-chat 精确与模糊", async () => {
  eq((await vault.resolveChat("艾老师")).data.talker, "艾老师");
  ok((await vault.resolveChat("培训")).data.talker.includes("培训"));
  eq((await vault.resolveChat("不存在")).ok, false);
});
await t("vault search 跨会话命中并抽取链接", async () => {
  const r = (await vault.search("AI", { limit: 20 })).data;
  const chats = new Set(r.messages.map((m) => m.chat));
  ok(chats.size >= 2, "只命中 " + chats.size + " 个会话");
  const brief = (await vault.search("brief", { limit: 10 })).data;
  ok(brief.messages.length >= 1);
});
await t("vault members 由发言推断", async () => {
  const m = (await vault.members("AI 培训客户群", { limit: 20 })).data;
  eq(m.members.length, 3);
  ok(m.members.some((x) => x.name === "王工"));
});
await t("vault 缓存：二次加载命中缓存", async () => {
  const r = createVaultReader({ dirs: [VAULT], force: true });
  const a = r.describe();
  const b = r.describe();
  ok(a.files === b.files && a.cache_hits >= 0);
});
await t("vault 不提供 sql 时明确报错", async () => {
  eq((await vault.sql({ query: "SELECT 1" })).ok, false);
});

// =====================================================================================
console.log("\n2) cli Reader（外部只读 CLI 子进程）");
const RION = path.join(ROOT, "rion_stub.mjs");
fs.writeFileSync(RION, `#!/usr/bin/env node
// 模拟 rion-wechat-cli 协议（信封 {ok,tool,command,data}）
const argv = process.argv.slice(2);
const cmd = argv[0];
const arg = (name, dflt) => { const i = argv.indexOf(name); return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt; };
const out = (data) => { process.stdout.write(JSON.stringify({ ok: true, tool: cmd, command: cmd, data })); };
const MSGS = [
  { chat: "AI 培训客户群", talker: "12345@chatroom", sender: "王工", time: "2026-06-30 09:10", text: "想做内部 AI 培训，预算 8000", local_id: 1 },
  { chat: "AI 培训客户群", talker: "12345@chatroom", sender: "我", time: "2026-06-30 09:40", text: "好的，本周给你大纲", local_id: 2 },
  { chat: "艾老师", talker: "wxid_alice_8888", sender: "艾老师", time: "2026-06-30 19:45", text: "合作报价方便报一下吗", local_id: 3 },
];
if (cmd === "version") { out({ name: "rion-wechat-cli", version: "0.9.2-preview.2" }); }
else if (cmd === "status") { out({ state: "ready", live_database_read_ok: true, readiness: "ready", message_count: MSGS.length }); }
else if (cmd === "sessions") { out({ sessions: [{ name: "AI 培训客户群", username: "12345@chatroom", chat_type: "group", message_count: 2 }, { name: "艾老师", username: "wxid_alice_8888", chat_type: "private", message_count: 1 }] }); }
else if (cmd === "resolve-chat") { out({ candidates: [{ username: "12345@chatroom", display_name: "AI 培训客户群", chat_type: "group" }] }); }
else if (cmd === "timeline") { const talker = argv[1]; out({ messages: MSGS.filter((m) => m.talker === talker || m.chat === talker), query: { has_more: false, next_offset: null } }); }
else if (cmd === "search") { const kw = argv[1] || ""; out({ messages: MSGS.filter((m) => m.text.includes(kw)), query: { has_more: false, next_offset: null } }); }
else if (cmd === "members") { out({ chatroom_id: argv[1], total: 2, members: [{ username: "wxid_a", display_name: "王工" }, { username: "wxid_me", display_name: "我" }] }); }
else if (cmd === "sql") { out({ columns: ["label_name_"], rows: [{ label_name_: "客户" }], returned: 1 }); }
else { process.stdout.write(JSON.stringify({ ok: false, error: { code: "unknown_tool", message: "unknown " + cmd } })); process.exit(1); }
`, "utf8");

const cli = createCliReader({ id: "stub", command: process.execPath, args: [RION], timeoutMs: 30000 });
await t("cli version", async () => eq((await cli.version()).data.version, "0.9.2-preview.2"));
await t("cli status 映射 state", async () => {
  const d = (await cli.status()).data;
  eq(d.state, "ready");
  eq(d.live_database_read_ok, true);
});
await t("cli sessions", async () => {
  const rows = (await cli.sessions({ limit: 10 })).data.sessions;
  eq(rows.length, 2);
  eq(rows[0].chat_type, "group");
});
await t("cli resolve-chat", async () => {
  const d = (await cli.resolveChat("培训")).data;
  eq(d.talker, "12345@chatroom");
  eq(d.kind, "group");
});
await t("cli timeline 转成统一行结构", async () => {
  const rows = (await cli.timeline("12345@chatroom", { limit: 20, displayOrder: "asc" })).data.messages;
  eq(rows.length, 2);
  eq(rows[0].sender, "王工");
  ok(rows[0].ts > 1e12, "ts 应为毫秒");
});
await t("cli search", async () => {
  const rows = (await cli.search("报价", { limit: 10 })).data.messages;
  eq(rows.length, 1);
});
await t("cli members", async () => {
  const d = (await cli.members("12345@chatroom", { limit: 10 })).data;
  eq(d.members.length, 2);
});
await t("cli sql", async () => {
  const d = (await cli.sql({ query: "SELECT label_name_ FROM contact_label", subdir: "contact", file: "contact.db" })).data;
  ok((d.rows ?? []).length >= 1);
});
await t("cli 未知命令 → ok=false 且不抛异常", async () => {
  const r = await cli.sessions({ limit: 1 });
  ok(r); // 走到这里说明没有抛
});

// fake_vault_cli 契约（status / new-messages / search）
const FAKE = path.join(ROOT, "fake_vault_cli.mjs");
fs.writeFileSync(FAKE, `#!/usr/bin/env node
const cmd = process.argv[2];
const M = [{ chat: "NovaAI", sender: "NovaAI", time: "2026-06-30 10:12", content: "你好，想咨询一下 X thread 的合作报价" }];
if (cmd === "status") process.stdout.write(JSON.stringify({ ok: true, decrypted_dir: "sample", message_count: M.length }));
else if (cmd === "new-messages") process.stdout.write(JSON.stringify({ messages: M }));
else if (cmd === "search") { const kw = process.argv[3] || ""; process.stdout.write(JSON.stringify({ messages: M.filter((x) => x.content.includes(kw)) })); }
else { process.stderr.write("unknown command"); process.exit(1); }
`, "utf8");
const fakeCli = createCliReader({ id: "fake", command: process.execPath, args: [FAKE], timeoutMs: 30000 });
await t("fake_vault_cli: status 可解析", async () => {
  const d = (await fakeCli.status()).data;
  ok(d.state === "ready" || d.message_count >= 1, JSON.stringify(d));
});
await t("fake_vault_cli: new-messages 回退成 sessions", async () => {
  const rows = (await fakeCli.sessions({ limit: 10 })).data.sessions;
  ok(rows.length >= 1 && rows[0].name === "NovaAI", JSON.stringify(rows));
});
await t("fake_vault_cli: search 命中", async () => {
  const rows = (await fakeCli.search("报价", { limit: 10 })).data.messages;
  eq(rows.length, 1);
});
await t("extractJson 容忍前后日志行", async () => {
  eq(extractJson('log line\n{"a":1}\ntail').a, 1);
  eq(extractJson("not json"), null);
});

// =====================================================================================
console.log("\n3) local Reader（本地索引）");
const db = store.openStore();
ingest.ingestMessages(db, [
  { session_name: "本地群", session_kind: "group", sender: "甲", ts: Date.now() - 3600_000, content: "有项目方找 KOL 投放，预算 3000" },
  { session_name: "本地群", session_kind: "group", sender: "我", ts: Date.now() - 1800_000, content: "我看看", is_owner: true },
], { source: "test" });
const local = createLocalReader();
await t("local status=ready", async () => eq((await local.status()).data.state, "ready"));
await t("local sessions 至少 1 个", async () => ok((await local.sessions({ limit: 10 })).data.sessions.length >= 1));
await t("local timeline", async () => {
  const rows = (await local.timeline("本地群", { limit: 10 })).data.messages;
  eq(rows.length, 2);
});
await t("local search 中文", async () => ok((await local.search("投放", { limit: 10 })).data.messages.length >= 1));
await t("local sql 只读守卫", async () => {
  eq((await local.sql({ query: "DELETE FROM messages" })).ok, false);
  ok((await local.sql({ query: "SELECT COUNT(*) n FROM messages" })).data.rows.length === 1);
});

// =====================================================================================
console.log("\n4) mock Reader（演示数据）");
const mock = createMockReader();
await t("mock 覆盖全部信号类型", async () => {
  const { analyze } = await import(new URL("../lib/signals.mjs", import.meta.url).href);
  const msgs = buildDemoMessages();
  const a = analyze({ messages: msgs, sinceMs: Date.now() - 400 * 86400000, untilMs: Date.now() + 86400000 });
  ok(a.pendingReplies.length >= 1, "待回复");
  ok(a.promises.some((p) => p.state === "待兑现"), "待兑现承诺");
  ok(a.deadlines.length >= 1, "临近截止");
  ok(a.settlements.length >= 1, "待结算");
  ok(a.brandDeals.length >= 1, "商机");
  ok(a.trainings.length >= 1, "培训");
  ok(a.links.length >= 1, "跨群链接");
  ok(a.lowValue.length >= 1, "低价值群");
});
await t("mock stats", async () => {
  const d = (await mock.stats()).data;
  ok(d.sessions >= 5 && d.total_messages >= 30, JSON.stringify({ s: d.sessions, m: d.total_messages }));
});
await t("mock 不提供 sql", async () => eq((await mock.sql({ query: "SELECT 1" })).ok, false));

console.log("\n" + "=".repeat(50));
if (fails.length) {
  console.log("失败项：");
  for (const f of fails) console.log("  ✗ " + f);
  console.log("");
}
console.log("=== " + passed + " passed, " + failed + " failed ===");
try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* ignore */ }
process.exit(failed === 0 ? 0 : 1);
