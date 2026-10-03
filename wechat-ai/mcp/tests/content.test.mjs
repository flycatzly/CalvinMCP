// 内容级断言：这些行为是上游测试固定下来的口径，必须逐条对齐。
// 覆盖：链接商单概率判定、粉丝数识别、社交主页 URL、承诺不被 ACK 关闭、
//       复联状态判定、联系人日报状态与回复方向、群日报格式约束、时间窗环比。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "content-test-"));
process.env.WECHAT_AI_HOME = ROOT;

let passed = 0, failed = 0;
const fails = [];
const t = async (name, fn) => {
  try { await fn(); passed += 1; console.log("  ✓ " + name); }
  catch (e) { failed += 1; fails.push(name + " :: " + (e?.message ?? e)); console.log("  ✗ " + name + " :: " + (e?.message ?? e)); }
};
const eq = (a, b, m) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error((m ?? "不相等") + "：期望 " + JSON.stringify(b) + "，实际 " + JSON.stringify(a)); };
const ok = (v, m) => { if (!v) throw new Error(m ?? "断言失败"); };

const { analyze, reactivation } = await import(new URL("../lib/signals.mjs", import.meta.url).href);
const store = await import(new URL("../lib/store.mjs", import.meta.url).href);
const ingest = await import(new URL("../lib/ingest.mjs", import.meta.url).href);
const views = await import(new URL("../lib/views.mjs", import.meta.url).href);
const md = await import(new URL("../lib/report/md.mjs", import.meta.url).href);

const now = Date.now();
const H = 3600_000;
const msg = (chat, sender, hoursAgo, content, isOwner = false, links = []) => ({
  session_name: chat, chat_kind: undefined, sender, is_owner: isOwner, ts: now - hoursAgo * H, content, links,
});
const W = { sinceMs: now - 720 * H, untilMs: now + H };

// =====================================================================================
console.log("1) 链接商单概率：明确非商单 / 粉丝数 / 社交主页");

await t("「不是商单，纯分享」压过付费加热证据", async () => {
  const a = analyze({
    messages: [
      msg("群A", "甲", 30, "同一条 https://example.com/p 帮忙加热，红包伺候", false, ["https://example.com/p"]),
      msg("群B", "乙", 29, "不是商单，纯分享 https://example.com/p", false, ["https://example.com/p"]),
    ],
    ...W,
  });
  const l = a.links.find((x) => x.url.includes("/p"));
  ok(l, "没聚合到链接");
  eq(l.probability, "明确非商单", "判定=" + l.probability);
  eq(l.rank, 0);
  ok(/原文明确/.test(l.reason ?? l.note ?? ""), "理由应说明原文明确写了非商单：" + (l.reason ?? l.note));
});

await t("跨群付费加热 → 高概率商单", async () => {
  const a = analyze({
    messages: [
      msg("群A", "甲", 30, "品牌方投放 https://example.com/boost 红包加热", false, ["https://example.com/boost"]),
      msg("群B", "乙", 29, "同一条 https://example.com/boost 三连加热", false, ["https://example.com/boost"]),
    ],
    ...W,
  });
  const l = a.links.find((x) => x.url.includes("boost"));
  eq(l.probability, "高概率商单");
  ok(l.rank >= 2, "rank=" + l.rank);
});

await t("「10万+爆款」不被当成粉丝数", async () => {
  const a = analyze({
    messages: [
      msg("群A", "甲", 30, "我那条 10万+爆款了 https://example.com/viral", false, ["https://example.com/viral"]),
      msg("群B", "乙", 29, "同一条 https://example.com/viral", false, ["https://example.com/viral"]),
    ],
    ...W,
  });
  const l = a.links.find((x) => x.url.includes("viral"));
  eq(l.rank, 1, "没有付费加热时不应因爆款升级为高概率");
  ok(!/万粉/.test(l.reason ?? ""), "理由不该提万粉：" + l.reason);
});

await t("真实的万粉信号能被识别", async () => {
  const a = analyze({
    messages: [
      msg("群A", "甲", 30, "我 3 万粉，可以接 https://example.com/fans", false, ["https://example.com/fans"]),
      msg("群B", "乙", 29, "同一条 https://example.com/fans", false, ["https://example.com/fans"]),
      msg("群C", "丙", 28, "同一条 https://example.com/fans", false, ["https://example.com/fans"]),
    ],
    ...W,
  });
  const l = a.links.find((x) => x.url.includes("fans"));
  ok(l.rank >= 2, "3 万粉 + 3 群应升到高概率，实际 rank=" + l.rank + " 判定=" + l.probability);
});

await t("社交主页 URL 判为普通内容（不是可归因的推广帖）", async () => {
  const a = analyze({
    messages: [
      msg("群A", "甲", 30, "我的主页 https://x.com/someone", false, ["https://x.com/someone"]),
      msg("群B", "乙", 29, "关注一下 https://x.com/someone", false, ["https://x.com/someone"]),
    ],
    ...W,
  });
  const l = a.links.find((x) => x.url.includes("x.com"));
  eq(l.probability, "普通内容");
  eq(l.rank, 0);
});

// =====================================================================================
console.log("\n2) 承诺：对方 ACK 不能关闭承诺");

await t("对方回「嗯嗯对的」后承诺仍然待兑现", async () => {
  const a = analyze({
    messages: [
      msg("项目群", "我", 30, "我今晚把初稿发你，再多 quote 几次", true),
      msg("项目群", "对方", 29, "嗯嗯对的"),
    ],
    ...W,
  });
  eq(a.promises.length, 1, "承诺数=" + a.promises.length);
  eq(a.promises[0].state, "待兑现");
  ok(a.promises[0].acknowledged, "应记录对方已确认");
  ok(a.promises[0].note.includes("未见交付证据"), a.promises[0].note);
});

await t("本人后续说「已发你」才关闭承诺", async () => {
  const a = analyze({
    messages: [
      msg("项目群", "我", 30, "我今晚把初稿发你", true),
      msg("项目群", "我", 28, "初稿已发你了，见附件", true),
    ],
    ...W,
  });
  eq(a.promises.length, 1);
  eq(a.promises[0].state, "已兑现");
});

// =====================================================================================
console.log("\n3) 复联状态判定（上游口径）");

const reMsg = (chat, sender, daysAgo, content) => ({ session_name: chat, sender, ts: now - daysAgo * 86400_000, content, is_owner: sender === "我", links: [] });
const band = (rows, chat) => rows.all.find((r) => r.chat === chat)?.band;

await t("对方说「下一批」→ 今天优先看（有明确后续窗口）", async () => {
  const r = reactivation({ messages: [reMsg("品牌X", "对接人", 40, "这批结束了，下一批我提前跟你聊")], inactiveDays: 21 });
  eq(band(r, "品牌X"), "今天优先看");
});
await t("纯佣无保底 → 纯佣低优先级", async () => {
  const r = reactivation({ messages: [reMsg("品牌Y", "对接人", 40, "我们这边是纯佣投放，没有保底")], inactiveDays: 21 });
  eq(band(r, "品牌Y"), "纯佣低优先级");
});
await t("负责人交接 → 待交接跟进", async () => {
  const r = reactivation({ messages: [reMsg("品牌Z", "对接人", 40, "我暂时不负责这个项目，会拉创始人进来交接合作")], inactiveDays: 21 });
  eq(band(r, "品牌Z"), "待交接跟进");
});
await t("近期明确拒绝 → 等待区（暂缓）", async () => {
  const r = reactivation({ messages: [reMsg("品牌W", "对接人", 5, "暂时不考虑合作，预算不够")], inactiveDays: 21 });
  eq(band(r, "品牌W"), "等待区");
});
await t("曾经成交且久未联系 → 今天优先看（复购保温）", async () => {
  const r = reactivation({ messages: [reMsg("品牌V", "对接人", 60, "已经结算完成，谢谢")], inactiveDays: 21 });
  eq(band(r, "品牌V"), "今天优先看");
});
await t("最近刚聊过 → 进等待区而不是今日行动", async () => {
  const r = reactivation({ messages: [reMsg("品牌U", "对接人", 2, "好的收到")], inactiveDays: 21 });
  ok(r.immediate.every((x) => x.chat !== "品牌U"), "不该出现在今天优先看：" + JSON.stringify(r.immediate.map((x) => x.chat)));
});

// =====================================================================================
console.log("\n4) 联系人日报：状态与回复方向");

await t("「大致价位是多少呢」判为待回复且方向是报价", async () => {
  const db = store.openStore();
  ingest.ingestMessages(db, [
    { session_name: "客户P", session_kind: "private", sender: "客户P", ts: now - 2 * H, content: "你好，你们这边大致价位是多少呢" },
  ], { source: "content" });
  const rows = await views.contactDailyRows({ sinceMs: now - 720 * H, untilMs: now + H, contacts: ["客户P"], selfNames: ["我"] });
  const list = rows.rows ?? rows;
  const row = list.find((r) => r.chat === "客户P");
  ok(row, "客户P 未进入联系人日报：" + JSON.stringify(list.map((x) => x.chat)));
  eq(row.status, "待回复", "状态=" + row.status);
  ok(/报价/.test(row.replyDirection ?? ""), "回复方向应针对报价：" + row.replyDirection);
});

await t("本人最后发言（无未兑现承诺）→ 等待对方", async () => {
  const db = store.openStore();
  ingest.ingestMessages(db, [
    { session_name: "客户Q", session_kind: "private", sender: "客户Q", ts: now - 5 * H, content: "资料收到了吗" },
    { session_name: "客户Q", session_kind: "private", sender: "我", is_owner: true, ts: now - 4 * H, content: "收到了，我看看" },
  ], { source: "content" });
  const rows = await views.contactDailyRows({ sinceMs: now - 720 * H, untilMs: now + H, contacts: ["客户Q"], selfNames: ["我"] });
  const row = (rows.rows ?? rows).find((r) => r.chat === "客户Q");
  eq(row.status, "等待对方", "状态=" + row.status);
});

await t("本人最后发言但存在未兑现承诺 → 待兑现（承诺优先，上游口径）", async () => {
  const db = store.openStore();
  ingest.ingestMessages(db, [
    { session_name: "客户R", session_kind: "private", sender: "客户R", ts: now - 5 * H, content: "麻烦发一下资料" },
    { session_name: "客户R", session_kind: "private", sender: "我", is_owner: true, ts: now - 4 * H, content: "好的，我整理好发你" },
  ], { source: "content" });
  const rows = await views.contactDailyRows({ sinceMs: now - 720 * H, untilMs: now + H, contacts: ["客户R"], selfNames: ["我"] });
  const row = (rows.rows ?? rows).find((r) => r.chat === "客户R");
  eq(row.status, "待兑现", "状态=" + row.status);
});

// =====================================================================================
console.log("\n5) 群日报格式约束");

await t("digest 不含原始 <details>，且同一 URL 只出现一次", async () => {
  const db = store.openStore();
  const url = "https://example.com/once-only";
  ingest.ingestMessages(db, [
    { session_name: "格式群A", session_kind: "group", sender: "甲", ts: now - 3 * H, content: "品牌方招募 AI 博主，预算 8000 " + url, links: [url] },
    { session_name: "格式群B", session_kind: "group", sender: "乙", ts: now - 2 * H, content: "同一条 " + url, links: [url] },
  ], { source: "content" });
  const outDir = path.join(ROOT, "gd-fmt");
  const a = analyze({ messages: store.messagesInWindow({ sinceMs: now - 24 * H, untilMs: now + H, limit: 100000 }), sinceMs: now - 24 * H, untilMs: now + H });
  const files = await md.renderGroupDaily(a, { since: "2026-01-01 00:00", until: "2026-01-02 00:00", outDir, links: a.links, coverage: a.coverage });
  const digest = fs.readFileSync(files.digest, "utf8");
  ok(!/<details/i.test(digest), "digest 不应含 <details>");
  const occurrences = digest.split(url).length - 1;
  eq(occurrences, 1, "同一 URL 在 digest 中应只出现一次，实际 " + occurrences);
});

await t("联系人日报允许使用 <details> 折叠", async () => {
  const outDir = path.join(ROOT, "cd-fmt");
  const rows = await views.contactDailyRows({ sinceMs: now - 720 * H, untilMs: now + H, contacts: ["客户P"], selfNames: ["我"] });
  const files = await md.renderContactDaily(rows.rows ?? rows, { since: "2026-01-01 00:00", until: "2026-01-02 00:00", outDir });
  const target = typeof files === "string" ? files : (files.digest ?? files.report ?? Object.values(files).find((x) => typeof x === "string"));
  const txt = fs.readFileSync(target, "utf8");
  ok(/<details/i.test(txt), "联系人日报按上游口径使用 <details> 折叠");
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
