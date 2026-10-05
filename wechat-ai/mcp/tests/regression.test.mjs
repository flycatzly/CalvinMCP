// 修复回归测试：v1.1.1（2026-10-05）修掉的缺陷逐项钉住，防复发。
// 覆盖：BUG-1 chat_search 全文写回（展示截断≠落库截断 + 重复检索幂等）、
//       BUG-2 wai_new_leads record 契约、BUG-3 群日报「已有结论或分歧」[object Object]、
//       BUG-4 wai_feedback_add record 契约、BUG-5 opportunity_update 消费 followUp（三路径）、
//       BUG-6 history_list summary 非字符串不再拼进 content、BUG-8 config_set settings 声明与边界，
//       外加工具数/schema 基线（73 工具、settings type=object）。
// 全部用例跑在隔离 WECHAT_AI_HOME 上，不碰真实 store。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BASE = fs.mkdtempSync(path.join(os.tmpdir(), "wai-regression-"));
let passed = 0, failed = 0;
const fails = [];
const t = async (name, fn) => {
  try { await fn(); passed += 1; console.log("  ✓ " + name); }
  catch (e) { failed += 1; fails.push(name + " :: " + (e?.message ?? e)); console.log("  ✗ " + name + " :: " + (e?.message ?? e)); }
};
const eq = (a, b, m) => { if (a !== b) throw new Error((m ?? "不相等") + "：期望 " + JSON.stringify(b) + "，实际 " + JSON.stringify(a)); };
const ok = (v, m) => { if (!v) throw new Error(m ?? "断言失败"); };

/** 每个用例一个独立数据根，避免相互污染（与 robustness.test.mjs 同款封装） */
async function withHome(sub, fn) {
  const home = path.join(BASE, sub);
  fs.mkdirSync(home, { recursive: true });
  process.env.WECHAT_AI_HOME = home;
  const srv = await import(new URL("../server.mjs", import.meta.url).href + "?h=" + encodeURIComponent(sub));
  const call = async (name, args) => {
    const r = await srv.handleRpc({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args ?? {} } });
    return r.result ?? {};
  };
  return fn({ home, call, srv });
}

console.log("1) 契约与基线");

await t("基线：工具数 73；wai_config_set 的 settings 声明 type=object", async () => {
  await withHome("baseline", async ({ srv }) => {
    eq(srv.TOOLS.length, 73, "工具数应为 73");
    const cfgTool = srv.toolList().find((x) => x.name === "wai_config_set");
    ok(cfgTool, "缺 wai_config_set");
    eq(cfgTool.inputSchema.properties.settings.type, "object", "settings schema 应声明 type=object");
  });
});

await t("BUG-2：wai_new_leads 返回 record（{count, rows}），不再是裸数组", async () => {
  await withHome("bug2", async ({ call }) => {
    const r = await call("wai_new_leads", { minPriority: 1 });
    ok(!r.isError, "不应报错：" + JSON.stringify(r.structuredContent).slice(0, 160));
    const sc = r.structuredContent;
    ok(sc && typeof sc === "object" && !Array.isArray(sc), "structuredContent 必须是 record：" + JSON.stringify(sc).slice(0, 160));
    ok(Array.isArray(sc.rows), "rows 应为数组");
    ok(typeof sc.count === "number", "count 应为数字");
  });
});

await t("BUG-4：wai_feedback_add 返回 record（{saved, id}），不再是裸数字", async () => {
  await withHome("bug4", async ({ call }) => {
    const r = await call("wai_feedback_add", { targetType: "chat", target: "回归测试群", verdict: "low_priority", note: "BUG-4 回归钉" });
    ok(!r.isError, "不应报错：" + JSON.stringify(r.structuredContent));
    const sc = r.structuredContent;
    ok(sc && typeof sc === "object" && !Array.isArray(sc), "structuredContent 必须是 record：" + JSON.stringify(sc).slice(0, 160));
    eq(sc.saved, true, "saved 应为 true");
    ok(Number.isInteger(sc.id), "id 应为整数：" + JSON.stringify(sc.id));
  });
});

console.log("\n2) 参数消费与数据完整性");

await t("BUG-5：opportunity_update 消费 followUp（与 note 同给 / 单独给 / clearFollowUp 三路径）", async () => {
  await withHome("bug5", async ({ call }) => {
    const idx = await call("wai_db_index", { source: "mock", scope: "sessions", sessionLimit: 20, allowDemo: true });
    ok(!idx.isError, "mock 索引失败：" + JSON.stringify(idx.structuredContent).slice(0, 160));
    const sync = await call("wai_opportunity_sync", { hours: 720, dryRun: false });
    ok(!sync.isError, "同步失败：" + JSON.stringify(sync.structuredContent).slice(0, 160));
    const lst = await call("wai_opportunities", { includeCandidates: true, minPriority: 0, limit: 5 });
    const opp = (lst.structuredContent?.opportunities ?? [])[0];
    ok(opp?.id, "没有可用商机行：" + JSON.stringify(lst.structuredContent).slice(0, 200));
    // (a) note+nextAction+followUp 同给：followUp 此前被静默丢弃
    const a = await call("wai_opportunity_update", { id: opp.id, note: "BUG-5 回归钉", nextAction: "回归下一步", followUp: "2026-10-20" });
    ok(!a.isError, "(a) 报错：" + JSON.stringify(a.structuredContent).slice(0, 160));
    eq(a.structuredContent?.next_follow_up, "2026-10-20", "(a) followUp 应落 next_follow_up");
    // (b) 单独给 followUp：此前误报「至少提供一项要更新的字段」
    const b = await call("wai_opportunity_update", { id: opp.id, followUp: "2026-10-25" });
    ok(!b.isError, "(b) 单独 followUp 应被接受：" + JSON.stringify(b.structuredContent).slice(0, 160));
    eq(b.structuredContent?.next_follow_up, "2026-10-25", "(b) 应覆盖为新日期");
    // (c) clearFollowUp 清空
    const c = await call("wai_opportunity_update", { id: opp.id, clearFollowUp: true });
    ok(!c.isError, "(c) 报错：" + JSON.stringify(c.structuredContent).slice(0, 160));
    eq(c.structuredContent?.next_follow_up ?? "", "", "(c) 应清空");
  });
});

await t("BUG-1：chat_search 展示截断不影响写回全文，重复检索幂等不重复落库", async () => {
  await withHome("bug1", async ({ call }) => {
    const idx = await call("wai_db_index", { source: "mock", scope: "sessions", sessionLimit: 20, allowDemo: true });
    ok(!idx.isError, "mock 索引失败");
    const before = await call("wai_status");
    const n0 = before.structuredContent?.messages ?? before.structuredContent?.totals?.messages;
    const s1 = await call("wai_chat_search", { query: "campaign-brief", maxTextChars: 16, source: "mock" });
    ok(!s1.isError, "检索失败：" + JSON.stringify(s1.structuredContent).slice(0, 160));
    const msgs = s1.structuredContent?.messages ?? [];
    ok(msgs.length >= 1, "应命中 mock 消息");
    ok(msgs.every((m) => String(m.content ?? "").length <= 16), "展示层应截断到 16 字");
    eq(s1.structuredContent?.inserted, 0, "全文写回应命中既有行（幂等），不该新插");
    const db = await call("wai_db_search", { query: "campaign-brief", limit: 10 });
    const rows = db.structuredContent?.rows ?? [];
    ok(rows.length >= 1, "索引应能查到");
    ok(rows.some((m) => String(m.content ?? "").includes("https://example.com/campaign-brief")), "索引正文应保留完整 URL（不被 16 字截断）：" + JSON.stringify(rows.map((m) => m.content)).slice(0, 200));
    const after = await call("wai_status");
    eq(after.structuredContent?.messages ?? after.structuredContent?.totals?.messages, n0, "消息总数不应变化");
  });
});

console.log("\n3) 渲染与配置");

await t("BUG-3：group_daily_groups.md 结论行不再 [object Object]，关键发言真正进入结论", async () => {
  const home = path.join(BASE, "bug3");
  fs.mkdirSync(home, { recursive: true });
  process.env.WECHAT_AI_HOME = home;
  const md = await import(new URL("../lib/report/md.mjs", import.meta.url).href + "?g=bug3");
  ok(typeof md.renderGroupEditorial === "function", "缺 renderGroupEditorial");
  const outDir = path.join(BASE, "bug3-out");
  const packet = {
    "时间范围": { 开始: "2026-10-05 00:00", 结束: "2026-10-05 23:59" },
    "行动候选": [
      {
        群聊: "回归验证群", 标签: ["商单"], 最后消息时间: "2026-10-05 10:00",
        摘要候选: { 商单: "有品牌方询价", 培训或项目: "", 关键发言: "张三：不过预算还没定，再确认一下" },
        建议动作候选: "明天跟对方确认预算", 附件核验提示: "", 群内已有日报: [], 信号讨论: [], 相关跨群链接: [],
      },
      {
        群聊: "回归普通群", 标签: [], 最后消息时间: "2026-10-05 11:00",
        摘要候选: { 商单: "", 培训或项目: "", 关键发言: "李四：今晚聚餐记得带伞" },
        建议动作候选: "暂不需要行动", 附件核验提示: "", 群内已有日报: [], 信号讨论: [], 相关跨群链接: [],
      },
    ],
    "讨论候选": [], "高概率跨群链接": [], "待核实链接": [],
  };
  md.renderGroupEditorial(packet, { outDir, since: "2026-10-05 00:00", until: "2026-10-05 23:59" });
  const groups = fs.readFileSync(path.join(outDir, "group_daily_groups.md"), "utf8");
  ok(!groups.includes("[object Object]"), "结论行有 [object Object]：" + groups.slice(0, 400));
  ok(groups.includes("群内存在待确认的分歧") && groups.includes("不过预算还没定"), "分歧分支应带出关键发言原文");
  ok(groups.includes("尚未形成明确结论：") && groups.includes("今晚聚餐记得带伞"), "过程讨论分支应带出关键发言原文");
});

await t("BUG-6：history_list 的 content 文本不再出现 [object Object]，summary 保持对象", async () => {
  await withHome("bug6", async ({ call }) => {
    const r = await call("wai_history_list", {});
    ok(!r.isError, "不应报错");
    const text = r.content?.[0]?.text ?? "";
    ok(!text.includes("[object Object]"), "content 不应有 [object Object]：" + text.slice(0, 160));
    ok(r.structuredContent?.summary && typeof r.structuredContent.summary === "object", "summary 应保持对象形态");
    ok(Array.isArray(r.structuredContent?.rows), "rows 应为数组");
  });
});

await t("BUG-8：settings 对象可写；字符串/数组/未知键仍被定制错误拒绝", async () => {
  await withHome("bug8", async ({ call }) => {
    const good = await call("wai_config_set", { settings: { defaultHours: 48 } });
    ok(!good.isError && good.structuredContent?.saved, "合法 settings 应成功：" + JSON.stringify(good.structuredContent).slice(0, 160));
    for (const [args, re] of [
      [{ settings: "oops" }, /必须是键值对象/],
      [{ settings: [1, 2] }, /必须是键值对象/],
      [{ settings: { badKeyUnknown: 1 } }, /未知键/],
    ]) {
      const r = await call("wai_config_set", args);
      ok(r.isError, JSON.stringify(args) + " 应报错");
      ok(re.test(String(r.structuredContent?.error ?? "")), "错误应匹配 " + re + "：" + JSON.stringify(r.structuredContent).slice(0, 160));
    }
  });
});

console.log("\n" + "=".repeat(50));
if (fails.length) {
  console.log("失败项：");
  for (const f of fails) console.log("  ✗ " + f);
  console.log("");
}
console.log("=== " + passed + " passed, " + failed + " failed ===");
try { fs.rmSync(BASE, { recursive: true, force: true, maxRetries: 5 }); } catch { /* ignore */ }
process.exit(failed === 0 ? 0 : 1);
