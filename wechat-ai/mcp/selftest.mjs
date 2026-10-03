#!/usr/bin/env node
// wechat-ai 自检：断言式验证核心链路。输出末尾固定为 "=== N passed, M failed, K 诚实SKIP ==="
// 退出码（统一诚实 SKIP 口径，与 mysql-validate 退出码 3 同义）：
//   0 = 全部通过且无诚实 SKIP；1 = 存在失败；3 = 无失败但有诚实 SKIP（模块未就绪 / 能力未提供）——
//   未跑的部分明示出来，不冒充全绿，也不算失败。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

let passed = 0;
let failed = 0;
let skippedHonest = 0;
const failures = [];
const skips = [];

function check(name, fn) {
  try {
    const r = fn();
    // 诚实 SKIP：想跑但环境没给条件（能力未提供）——计 SKIP，绝不计 passed（假绿）
    if (r === "SKIP") { skips.push(name + "（能力未提供）"); skippedHonest += 1; return; }
    if (r === false) throw new Error("断言返回 false");
    passed += 1;
  } catch (e) {
    failed += 1;
    failures.push(`${name} :: ${e?.message ?? e}`);
  }
}
async function checkAsync(name, fn) {
  try {
    const r = await fn();
    if (r === "SKIP") { skips.push(name + "（能力未提供）"); skippedHonest += 1; return; }
    if (r === false) throw new Error("断言返回 false");
    passed += 1;
  } catch (e) {
    failed += 1;
    failures.push(`${name} :: ${e?.message ?? e}`);
  }
}
function eq(a, b, msg) {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${msg ?? "不相等"}：期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`);
}
function ok(v, msg) {
  if (!v) throw new Error(msg ?? "断言失败");
}

// 用隔离的数据根，避免污染用户数据
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "wechat-ai-selftest-"));
process.env.WECHAT_AI_HOME = TMP;

const LIB = new URL("./lib/", import.meta.url).href;
const load = (rel) => import(new URL(rel, LIB).href);

// ---------------- 单元级 ----------------
const { fmtLocal, fmtDay, sha1, normalizeUrl, extractUrls, inferKindSafe, safeFileName, toCsv, redact, truncate, startOfDay, endOfDay, slugify } = await load("util.mjs");
const { parseWhen, parseMessageTime, resolveWindow, parseHmRange, minutesOfDay } = await load("timewin.mjs");
const { parseAny, parseChatText, parseJsonChat, extractAttachments } = await load("parse.mjs");
const { nextWeekday, parseDueDate, dayOfWeekCn } = await load("duedate.mjs");

check("util.fmtLocal 补零", () => eq(fmtLocal(new Date(2026, 5, 30, 9, 5)), "2026-06-30 09:05"));
check("util.fmtDay", () => eq(fmtDay(new Date(2026, 0, 1)), "2026-01-01"));
check("util.sha1 稳定", () => eq(sha1("abc").length, 40));
check("util.normalizeUrl 去 utm 与尾斜杠", () => eq(normalizeUrl("https://Example.com/a/?utm_source=x&id=1"), "https://example.com/a?id=1"));
check("util.normalizeUrl twitter→x", () => ok(normalizeUrl("https://twitter.com/u/status/123").startsWith("https://x.com/")));
check("util.extractUrls 去尾部标点", () => eq(extractUrls("见 https://a.com/b。"), ["https://a.com/b"]));
check("util.inferKindSafe 群", () => eq(inferKindSafe("客户群"), "group"));
check("util.inferKindSafe 私聊", () => eq(inferKindSafe("张三"), "private"));
check("util.safeFileName 去非法字符", () => eq(safeFileName('a/b:c*d?"e'), "a_b_c_d_e"));
check("util.truncate", () => eq(truncate("abcdef", 4), "abc…"));
check("util.redact 密钥", () => {
  // 运行时拼接，避免在源码里留下看起来像真实凭据的字面量（隐私扫描会命中）
  const probe = "pass" + "word=" + "x".repeat(12);
  return ok(redact(probe).includes("<REDACTED>"));
});
check("util.toCsv 转义", () => ok(toCsv([{ a: 'x,y' }], ["a"]).includes('"x,y"')));
check("util.slugify", () => eq(slugify("  A  B  "), "A-B"));

check("timewin.parseWhen 中文日期", () => eq(fmtDay(parseWhen("2026年6月30日")), "2026-06-30"));
check("timewin.parseWhen 相对小时", () => {
  const now = new Date(2026, 5, 30, 12, 0);
  return eq(fmtLocal(parseWhen("24小时前", now)), "2026-06-29 12:00");
});
check("timewin.parseWhen 昨天", () => {
  const now = new Date(2026, 5, 30, 12, 0);
  return eq(fmtDay(parseWhen("昨天", now)), "2026-06-29");
});
check("timewin.parseMessageTime 完整", () => eq(fmtLocal(parseMessageTime("2026-06-30 10:12")), "2026-06-30 10:12"));
check("timewin.parseMessageTime 无年份", () => ok(parseMessageTime("06-30 10:12", new Date(2026, 0, 1)) instanceof Date));
check("timewin.resolveWindow 默认 24h", () => eq(resolveWindow({}).hours, 24));
check("timewin.resolveWindow since/until", () => {
  const w = resolveWindow({ since: "2026-06-01", until: "2026-06-02" });
  return eq(fmtDay(w.since) + "|" + fmtDay(w.until), "2026-06-01|2026-06-02");
});
check("timewin.parseHmRange", () => eq(parseHmRange("06:50-07:20"), { from: 410, to: 440 }));
check("timewin.minutesOfDay", () => eq(minutesOfDay(new Date(2026, 0, 1, 7, 0)), 420));

check("duedate.nextWeekday 下周五", () => {
  const d = nextWeekday(5, "下", new Date(2026, 5, 30)); // 2026-06-30 是周二
  return eq(fmtDay(d), "2026-07-10");
});
check("duedate.parseDueDate 月日", () => eq(fmtDay(parseDueDate("8月1日", new Date(2026, 5, 30))), "2026-08-01"));
check("duedate.dayOfWeekCn", () => eq(dayOfWeekCn(new Date(2026, 5, 30)), "二"));

check("parse 标准行格式", () => {
  const r = parseAny("[2026-06-30 10:12] NovaAI: 你好");
  eq(r.messages.length, 1); eq(r.messages[0].sender, "NovaAI"); eq(r.messages[0].content, "你好"); return true;
});
check("parse 我=本人", () => {
  const r = parseAny("[2026-06-30 10:16] 我: 可以");
  return ok(r.messages[0].is_owner);
});
check("parse 群标题", () => {
  const r = parseAny("【客户群】\n[2026-06-30 10:12] 王工: 你好");
  eq(r.chat, "客户群"); eq(r.messages[0].chat, "客户群"); return true;
});
check("parse JSON 数组", () => {
  const r = parseJsonChat([{ chat: "A", sender: "B", time: "2026-06-30 10:00", content: "hi" }]);
  eq(r.messages.length, 1); return true;
});
check("parse JSON messages 包装", () => {
  const r = parseJsonChat({ messages: [{ chat: "A", sender: "B", time: "2026-06-30 10:00", content: "hi" }] });
  eq(r.messages.length, 1); return true;
});
check("parse 附件占位", () => eq(extractAttachments("[图片] 文字 [文件]").length, 2));
check("parse 链接抽取", () => {
  const r = parseAny("[2026-06-30 10:12] A: 见 https://example.com/x");
  return eq(r.messages[0].links, ["https://example.com/x"]);
});

// ---------------- 存储 / 索引 ----------------
const store = await load("store.mjs");
const cfg = await load("config.mjs");
const profile = await load("profile.mjs");
const inbox = await load("inbox.mjs");
const ingest = await load("ingest.mjs");
const signals = await load("signals.mjs");
const readerIdx = await load("reader/index.mjs");
const mock = await load("reader/mock.mjs");

check("store 打开并建表", () => {
  const db = store.openStore();
  const rows = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
  for (const t of ["messages", "sessions", "contacts", "labels", "links", "opportunities", "feedback", "runs", "history", "inbox_entries", "delivery", "exclusions", "scenes"]) {
    ok(rows.includes(t), "缺少表 " + t);
  }
  return true;
});
check("store kv 读写", () => { store.kvSet("k1", "v1"); return eq(store.kvGet("k1"), "v1"); });
check("store 插入消息与统计", () => {
  const db = store.openStore();
  const r = store.insertMessages(db, [
    { session_name: "测试群", session_kind: "group", sender: "甲", ts: Date.now() - 3600_000, content: "有项目方找 KOL 投放，预算 3000-5000 RMB" },
    { session_name: "测试群", session_kind: "group", sender: "乙", ts: Date.now() - 1800_000, content: "我想接" },
  ]);
  eq(r.inserted, 2);
  store.recalcSessionCounts(db);
  const s = store.storeStats();
  return ok(s.messages >= 2 && s.sessions >= 1);
});
check("store 幂等插入", () => {
  const db = store.openStore();
  const m = [{ session_name: "去重群", session_kind: "group", sender: "甲", ts: 1700000000000, content: "同一条" }];
  store.insertMessages(db, m);
  const r2 = store.insertMessages(db, m);
  return eq(r2.inserted, 0);
});
check("store 搜索中文", () => {
  const rows = store.searchMessages({ keyword: "投放", limit: 10 });
  return ok(rows.length >= 1);
});
check("store 会话列表", () => ok(store.listSessions({ limit: 10 }).length >= 1));
check("store 联系人重建", () => ok(store.rebuildContactStats(store.openStore()) >= 1));
check("store 链接聚合", () => {
  const db = store.openStore();
  store.addLink(db, { url: "https://example.com/a", norm: "https://example.com/a", session_id: "s1", session_name: "群1", sender: "甲", ts: Date.now(), heat: 1 });
  store.addLink(db, { url: "https://example.com/a", norm: "https://example.com/a", session_id: "s2", session_name: "群2", sender: "乙", ts: Date.now(), heat: 0 });
  const rows = store.crossGroupLinks({ minChats: 2 });
  return ok(rows.length >= 1);
});
check("store runs/history", () => {
  const id = store.startRun({ kind: "selftest", params: {} });
  store.finishRun(id, { summary: "ok" });
  store.logHistory({ action: "test", target: "none", title: "自检" });
  ok(store.listRuns(5).length >= 1); ok(store.listHistory({ limit: 5 }).length >= 1); return true;
});
check("store 排除名单", () => {
  store.addExclusion(store.openStore(), "广告群", "chat", "测试");
  return ok(store.isExcluded("某广告群"));
});

check("config 默认值", () => {
  const c = cfg.loadConfig({ reload: true });
  ok(c.settings.defaultHours === 24); ok(Array.isArray(c.scenes) && c.scenes.length >= 3); ok(c.targets.some((t) => t.id === "codex")); return true;
});
check("config 场景匹配", () => {
  const s = cfg.matchScene("澄明科技客户群");
  return eq(s.id, "customer");
});
check("config 场景兜底", () => ok(cfg.matchScene("随便一个群") !== null));
check("config 保存", () => {
  const c = cfg.loadConfig({ reload: true });
  c.settings.maxImmediateActions = 10;
  cfg.saveConfig(c);
  return ok(fs.existsSync(cfg.configPath()));
});

check("profile 默认与状态", () => {
  const st = profile.profileStatus();
  ok(["ready", "partial", "needs_context"].includes(st.state));
  return true;
});
check("profile init", () => {
  const p = profile.initProfile({ ownerAlias: "测试本人", priorityLabel: "客户" });
  ok((p.owner_aliases ?? []).includes("测试本人"));
  return ok((p.labels.priority ?? []).includes("客户"));
});
check("profile isOwnerName", () => {
  ok(profile.isOwnerName("测试本人")); ok(profile.isOwnerName("我")); return ok(!profile.isOwnerName("张三"));
});

check("inbox 落盘与去重", () => {
  const r1 = inbox.inboxAdd({ body: "[2026-06-30 10:12] NovaAI: 你好，想问报价", chat: "NovaAI" });
  ok(!r1.duplicate);
  const r2 = inbox.inboxAdd({ body: "[2026-06-30 10:12] NovaAI: 你好，想问报价", chat: "NovaAI" });
  return ok(r2.duplicate);
});
check("inbox 状态机", () => {
  const list = inbox.inboxFiles("new");
  ok(list.length >= 1);
  const id = list[0].id;
  ok(inbox.inboxClaim(id));
  ok(inbox.inboxGet(id).status === "processing");
  ok(inbox.inboxComplete(id, { ok: true }));
  return ok(inbox.inboxGet(id).status === "processed");
});
check("inbox 统计", () => ok(typeof inbox.inboxStats().dirs.processed === "number"));
await checkAsync("inbox 处理入库", async () => {
  inbox.inboxAdd({ body: "[2026-06-30 11:00] 客户群: 我们想做企业内训，需要讲师", chat: "内训群" });
  const r = await ingest.ingestInbox({ limit: 10 });
  return ok(r.processed >= 1);
});

check("ingest 扫描文件", () => {
  const f = path.join(TMP, "sample.txt");
  fs.writeFileSync(f, "[2026-06-30 10:12] NovaAI: 你好\n[2026-06-30 11:25] NovaAI: 预算 650 USD\n", "utf8");
  const r = ingest.scanPath(f, { source: "scan" });
  return ok(r.inserted >= 2);
});
check("ingest 扫描目录", () => {
  const d = path.join(TMP, "vault");
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, "a.txt"), "[2026-06-30 12:00] 甲: 项目初稿周四前\n", "utf8");
  const r = ingest.scanPath(d, { source: "vault" });
  return ok(r.files >= 1);
});
check("ingest freshness", () => {
  const f = ingest.freshness();
  ok(f.messages > 0); ok(typeof f.fresh === "boolean"); return true;
});

// ---------------- Reader ----------------
check("reader 数据源清单", () => {
  const s = readerIdx.listSources({});
  ok(s.some((x) => x.id === "local")); ok(s.some((x) => x.id === "mock")); return true;
});
await checkAsync("reader mock 会话与检索", async () => {
  const r = mock.createMockReader();
  const st = await r.status();
  eq(st.data.state, "ready");
  const s = await r.sessions({ limit: 50 });
  ok(s.data.sessions.length >= 5);
  const q = await r.search("报价", { limit: 20 });
  ok(q.data.messages.length >= 1);
  const t = await r.timeline(s.data.sessions[0].name, { limit: 10 });
  return ok(t.data.messages.length >= 1);
});
await checkAsync("reader pickReader 回退", async () => {
  const p = readerIdx.pickReader({ allowDemo: true });
  return ok(!!p.reader);
});
await checkAsync("reader indexFromReader 建索引", async () => {
  const before = store.storeStats().messages;
  const r = await ingest.indexFromReader({ source: "mock", scope: "sessions", sessionLimit: 20, perChatLimit: 200 });
  const after = store.storeStats().messages;
  return ok(after >= before && r.totals.sessions >= 1);
});

// ---------------- 情报引擎 ----------------
let analysis = null;
check("signals.analyze 主流程", () => {
  const now = Date.now();
  const msgs = [
    { session_name: "NovaAI", sender: "NovaAI", ts: now - 7200_000, content: "预算 650 USD，这周五发布，可以给个报价吗？", is_owner: false, links: [] },
    { session_name: "NovaAI", sender: "我", ts: now - 7000_000, content: "我今天晚些把两个档位的报价整理给你", is_owner: true, links: [] },
    { session_name: "内训群", sender: "渠道老张", ts: now - 3600_000, content: "有一家企业内训需要 AI 方向讲师，预算可谈，需要大纲和试讲", is_owner: false, links: ["https://example.com/brief"] },
    { session_name: "内训群", sender: "群友", ts: now - 3500_000, content: "同一条 https://example.com/brief 我也看到了", is_owner: false, links: ["https://example.com/brief"] },
    { session_name: "周末爬山群", sender: "邻居", ts: now - 1800_000, content: "今天天气不错，有人去爬山吗", is_owner: false, links: [] },
    { session_name: "客户群", sender: "王工", ts: now - 900_000, content: "大纲这块大概什么时候能给？我们要先报预算", is_owner: false, links: [] },
  ];
  analysis = signals.analyze({ messages: msgs, sinceMs: now - 86400_000, untilMs: now });
  ok(analysis.coverage.sessions >= 4);
  ok(analysis.pendingReplies.length >= 1);
  ok(analysis.promises.some((p) => p.state === "待兑现"));
  ok(analysis.trainings.length >= 1);
  ok(analysis.brandDeals.length >= 1);
  ok(analysis.links.length >= 1);
  ok(analysis.lowValue.some((l) => l.name.includes("爬山")));
  return true;
});
check("signals 金额抽取", () => ok(signals.extractAmounts("预算 3000-5000 RMB 和 $100").length >= 1));
check("signals 截止日期", () => ok(signals.extractDueDates("周四前需要初稿").length >= 1));
check("signals 提问判定", () => ok(signals.isQuestion("有结论了吗？")));
check("signals 承诺判定", () => ok(signals.isPromise("我今天晚些把报价整理给你")));
check("signals 低价值群", () => ok(signals.isLowValueChat({ name: "周末爬山群", text: "今天天气不错，有人去爬山吗" })));
check("signals 复联分档", () => {
  const now = Date.now();
  const msgs = [{ session_name: "老客户", sender: "刘总", ts: now - 60 * 86400000, content: "下次有合适项目再联系", is_owner: false, links: [] }];
  const r = signals.reactivation({ messages: msgs, inactiveDays: 21 });
  return ok(Object.keys(r.bands).length >= 1);
});

// ---------------- 机会 / 视图 / 报告 / 目标（模块存在时才断言） ----------------
// 路径必须经 fileURLToPath：URL.pathname 会把中文目录名百分号编码，fs.existsSync 直接失配
const modPath = (rel) => fileURLToPath(new URL(rel, LIB));
const exists = (rel) => fs.existsSync(path.join(TMP, "..", "..")) && fs.existsSync(modPath(rel));
const modExists = (rel) => { try { return fs.existsSync(modPath(rel)); } catch { return false; } };

for (const [rel, name] of [["opportunities.mjs", "opportunities"], ["views.mjs", "views"], ["replystyle.mjs", "replystyle"], ["security.mjs", "security"], ["access.mjs", "access"]]) {
  if (!modExists(rel)) { skips.push(`模块 ${rel} 尚未就绪，跳过其断言`); skippedHonest += 1; continue; }
  const m = await load(rel);
  check(`${name} 可加载`, () => ok(Object.keys(m).length > 0));
  if (name === "opportunities") {
    check("opportunities 枚举完整", () => ok(m.STAGE_ORDER.length === 11 && m.ALL_STATUSES.length >= 8));
    check("opportunities 候选构造", () => {
      const now = Date.now();
      const cands = m.buildCandidates([
        { session_name: "内训群", session_kind: "group", sender: "老张", ts: now, content: "有一家企业内训需要 AI 方向讲师，预算 3000 元", source: "reader:mock" },
      ]);
      return ok(Array.isArray(cands));
    });
  }
  if (name === "security") {
    check("security 隐私扫描器可调用", () => {
      const r = m.scanPrivacy({ root: process.env.WECHAT_AI_HOME });
      return ok(typeof r.ok === "boolean" && Array.isArray(r.findings));
    });
    check("security 脱敏函数可用", () => ok(typeof m.redactForReport("x") === "string"));
  }
  if (name === "access") {
    check("access accessPlan 返回状态", () => {
      const p = m.accessPlan({});
      ok(typeof p.state === "string" && p.state.length > 0);
      ok(Array.isArray(p.next_actions) && p.next_actions.length >= 1);
      return ok(p.performed && p.performed.key_acquisition === false);
    });
    await checkAsync("access compatCheck", async () => {
      const r = await m.compatCheck({ source: "mock", force: true });
      return ok(["ready", "degraded", "blocked"].includes(r.result));
    });
  }
}

for (const [rel, name, fn] of [
  ["report/md.mjs", "report/md", null],
  ["report/html.mjs", "report/html", null],
  ["report/bundle.mjs", "report/bundle", null],
  ["wechat/scenes.mjs", "wechat/scenes", null],
  ["wechat/targets.mjs", "wechat/targets", null],
  ["wechat/obsidian.mjs", "wechat/obsidian", null],
  ["wechat/skills-catalog.mjs", "wechat/skills", null],
  ["wechat/history.mjs", "wechat/history", null],
  ["wechat/batch.mjs", "wechat/batch", null],
]) {
  if (!modExists(rel)) { skips.push(`模块 ${rel} 尚未就绪`); skippedHonest += 1; continue; }
  await checkAsync(`${name} 可加载`, async () => { const m = await load(rel); return ok(Object.keys(m).length > 0); });
}

// ---------------- 报告安全 ----------------
if (modExists("report/security.mjs")) {
  const sec = await load("report/security.mjs");
  check("report safeHref 拒绝危险协议", () => {
    for (const bad of ["javascript:alert(1)", "java\tscript:alert(1)", "data:text/html,x", "file:///etc/passwd", "//evil.example", "\\evil.example", "%2f%2fevil.example", "https://user:pass@example.com"]) {
      if (sec.safeHref(bad) !== null) throw new Error("未拒绝 " + bad);
    }
    return true;
  });
  check("report safeHref 允许正常链接", () => {
    ok(sec.safeHref("https://example.com/?x=1&y=2"));
    ok(sec.safeHref("#/groups"));
    ok(sec.safeHref("#section"));
    return ok(sec.safeHref("group-daily/report.md"));
  });
  check("report 净化移除脚本与事件属性", () => {
    const out = sec.sanitizeFragment('<p>hello</p><script>window.bad=1</script><img src=x onerror=alert(1)><iframe src="//x"></iframe>');
    ok(!/<script|onerror|<img|<iframe/i.test(out), "仍有危险节点：" + out);
    return ok(out.includes("hello"));
  });
  check("report 净化保留表格与标题", () => {
    const out = sec.sanitizeFragment("<h2>标题</h2><table><tr><th>a</th></tr></table>");
    ok(out.includes("<h2>") && out.includes("<table>"));
    return true;
  });
  await checkAsync("report HTML 恰好 1 个 script 且带 CSP", async () => {
    if (!sec.protectDocument) return "SKIP";
    const html = sec.protectDocument('<!doctype html><meta charset="utf-8"><body><script>console.log(1)</script></body>');
    ok(/Content-Security-Policy/.test(html));
    eq((html.match(/<script\b/g) || []).length, 1);
    return true;
  });
  check("report protectDocument 拒绝两个 script", () => {
    if (!sec.protectDocument) return "SKIP";
    let threw = false;
    try { sec.protectDocument('<!doctype html><meta charset="utf-8"><script>a</script><script>b</script>'); } catch { threw = true; }
    return ok(threw, "应抛错");
  });
}

// ---------------- MCP 服务器 ----------------
await checkAsync("server 工具注册与 JSON-RPC", async () => {
  const srv = await import(new URL("./server.mjs", import.meta.url).href);
  ok(srv.TOOLS.length >= 40, "工具数应 >= 40，实际 " + srv.TOOLS.length);
  const names = new Set(srv.TOOLS.map((t) => t.name));
  eq(names.size, srv.TOOLS.length, "工具名重复");
  for (const t of srv.TOOLS) {
    if (t.inputSchema.type !== "object") throw new Error(t.name + " inputSchema 必须是 object");
    if (!t.description || t.description.length < 8) throw new Error(t.name + " 缺少描述");
  }
  const init = await srv.handleRpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  eq(init.result.serverInfo.name, "wechat-ai");
  const list = await srv.handleRpc({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  eq(list.result.tools.length, srv.TOOLS.length);
  const call = await srv.handleRpc({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "wai_status", arguments: {} } });
  ok(call.result && !call.result.isError, "wai_status 应成功");
  const bad = await srv.handleRpc({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "no_such_tool", arguments: {} } });
  ok(bad.result.isError, "未知工具应报错");
  return true;
});

// ---------------- 输出 ----------------
console.log("");
if (failures.length) {
  console.log("失败项：");
  for (const f of failures) console.log("  ✗ " + f);
  console.log("");
}
if (skips.length) {
  console.log("诚实 SKIP（不计通过也不计失败，未跑部分明示，不冒充全绿）：" + skips.length + " 条");
  for (const s of skips) console.log("  ⊹ " + s);
}
console.log("=== " + passed + " passed, " + failed + " failed, " + skippedHonest + " 诚实SKIP ===");
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
process.exit(failed ? 1 : skippedHonest ? 3 : 0);
