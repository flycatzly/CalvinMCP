// 修复回归测试：v1.1.1（2026-10-05）修掉的缺陷逐项钉住，防复发。
// 覆盖：BUG-1 chat_search 全文写回（展示截断≠落库截断 + 重复检索幂等）、
//       BUG-2 wai_new_leads record 契约、BUG-3 群日报「已有结论或分歧」[object Object]、
//       BUG-4 wai_feedback_add record 契约、BUG-5 opportunity_update 消费 followUp（三路径）、
//       BUG-6 history_list summary 非字符串不再拼进 content、BUG-8 config_set settings 声明与边界，
//       BUG-F3 单行「时间 昵称: 内容」解析（reT 先于 reB/reD）、
//       BUG-F11 render_bundle 覆盖缺口（brief/报告族/未知 md 不再被静默丢弃，internal 仍刻意不进站）、
//       BUG-F5 openPromisesOf 承诺逾期口径（到期日优先 + 3 天兜底）、
//       BUG-F10 wai_obsidian_write 的 chat/url → sourceChat/sourceUrl 映射、
//       BUG-F13X dispatch 层 required 必填统一校验（空参/空串/空数组拦截）、
//       BUG-F4 链接口径同窗（hits=appearances、first/last 覆盖）+ 上下文不切半个 URL、
//       BUG-F6 wai_home 输出预算（胖行下仍 ≤48KB 完整 JSON）+ counts.inbox/today 诚实总数
//      （不受 limit 截断）+ counts.inbox_entries 消除与 wai_status.inbox 的同名歧义、
//       BUG-F12 wai_vault_scan 缺目录不再静默 files:0（全缺失报错对齐 wai_scan，部分缺失列 missing）、
//       BUG-F7 freshness.source 是语料真实来源（messages.source 主来源 + sources 构成），
//      不再被索引通道（kv last_index_source，自动档偏好 vault）冒充，通道事实另列 last_index_channel、
//       BUG-F8 reactivation「今天优先看」要求沉默期满（2 天标签/「下一批」会话不再被折进今日行动，
//      未满落等待区；沉默会话的折叠与 decisive 近期判定口径保持）、
//       BUG-F14 显式 source=vault:/sqlite:/wcdb:缺失路径不再静默空集（报错族对齐 wai_scan；
//      默认通道 needs_access 设计态与自动档降级保持）、
//       BUG-F15 loadVault 解析缓存按键合并写回（force 空根/子集与工具子集不再整文件覆写清掉
//      他目录条目；命中语义与扫过根内陈旧条目回收保持），
//       BUG-F16 wai_vault_scan 声明的 out 真正消费：落 vault-scan-summary.json（仅路径与计数，
//      无聊天名/正文；空串视为未给；与 wai_scan/wai_db_index 的摘要在同目录互不覆盖），
//       BUG-F17 wai_chat_search 声明的 out 真正消费：落 chat_search.md 检索证据
//      （renderChatSearch 走 writeText 默认掩码——privacy.redactOutputs 开启时 maskPii；
//      每条命中带会话归属；空串视为未给；与 chat_history.md 同目录互不覆盖），
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

await t("BUG-F3：单行「时间 昵称: 内容」不再被时间冒号误切", async () => {
  const { parseChatText } = await import(new URL("../lib/parse.mjs", import.meta.url).href);
  const long = "很长的正文内容".repeat(8); // >40 字符：旧路径 reB 不匹配、掉进 reD 把时间切开
  const parsed = parseChatText([
    "2026-10-05 16:38:00 张三: 短内容",
    "2026-10-05 16:40:00 李四: " + long,
    "2026-10-05 16:45 王五",
    "接续正文一行",
  ].join("\n"), { defaultChat: "测试", refDate: new Date("2026-10-06T00:00:00Z") });
  const msgs = parsed.messages;
  eq(msgs.length, 3, "应解析 3 条（王五行与续行合为一条）");
  eq(msgs[0].sender, "张三", "短内容行 sender");
  eq(msgs[0].content, "短内容", "短内容行 content");
  eq(msgs[1].sender, "李四", "长内容行 sender");
  eq(msgs[1].content, long, "长内容行 content");
  eq(msgs[2].sender, "王五", "sender 单行 + 续行");
  eq(msgs[2].content, "接续正文一行", "sender 单行的续行内容");
});

await t("BUG-F11：render_bundle 不再静默丢弃 brief/报告族/未知 md，internal 仍不进站", async () => {
  await withHome("bugf11", async ({ call, home }) => {
    const dir = path.join(home, "report");
    fs.mkdirSync(path.join(dir, "group-daily"), { recursive: true });
    fs.writeFileSync(path.join(dir, "brief.md"), "# 跨报告行动总览\n\nAlphaBriefToken 独特词组。\n");
    fs.writeFileSync(path.join(dir, "period_report.md"), "# 期间报告\n\nBetaReportToken 独特词组。\n");
    fs.writeFileSync(path.join(dir, "unknown_note.md"), "# 随手记\n\nGammaOrphanToken 独特词组。\n");
    fs.writeFileSync(path.join(dir, "group-daily", "cross_group_links.md"), "# 商单信号雷达\n\nDeltaRadarToken。\n");
    fs.writeFileSync(path.join(dir, "group-daily", "group_daily_digest.md"), "# 机器初筛\n\nInternalHiddenToken。\n");
    const r = await call("wai_render_bundle", { reportDir: dir, out: path.join(home, "bundle.html"), title: "F11 验收" });
    ok(!r.isError, "render_bundle 失败：" + JSON.stringify(r.structuredContent ?? {}).slice(0, 200));
    const html = fs.readFileSync(path.join(home, "bundle.html"), "utf8");
    for (const token of ["AlphaBriefToken", "BetaReportToken", "GammaOrphanToken", "DeltaRadarToken"]) {
      ok(html.includes(token), "站点应包含 " + token + "（全局搜索即搜此内容）");
    }
    ok(!html.includes("InternalHiddenToken"), "internal 源仍应刻意不进站");
    ok(html.includes("专题分析"), "导航应含专题分析分区");
    ok(html.includes('id="source-brief"'), "brief 应有自己的源文档节");
    // brief 归入综合行动（overview）分区：source-brief 必须落在 data-route=overview 的页面内
    const ovStart = html.indexOf('data-route="overview"');
    const nextRoute = html.indexOf('data-route="', ovStart + 10);
    const briefAt = html.indexOf('id="source-brief"');
    ok(ovStart >= 0 && briefAt > ovStart && (nextRoute < 0 || briefAt < nextRoute), "brief 应并入综合行动分区");
    // 报告族与未知 md 进专题分析（reports）分区
    const rpStart = html.indexOf('data-route="reports"');
    const periodAt = html.indexOf('id="source-period-report"');
    ok(rpStart >= 0 && periodAt > rpStart, "报告族应进专题分析分区");
  });
});

await t("BUG-F5：openPromisesOf 的 overdue 按到期日判定，无到期日退化 3 天兜底", async () => {
  const { openPromisesOf } = await import(new URL("../lib/views.mjs", import.meta.url).href);
  // 本地时间构造（extractDueDates 相对日期按 ref 的本地日历日计算），不受时区影响
  const mk = (ts, content, extra = []) => [{ ts, sender: "我", is_owner: true, content, session_name: "会话A" }, ...extra];

  // 1) 有到期日且已过（F5 报告形态：10-02「明天上午」发，10-05 查）→ 已逾期
  const r1 = openPromisesOf(mk(new Date(2026, 9, 2, 9, 30).getTime(), "我明天上午把组合价发你"), { now: new Date(2026, 9, 5, 17, 0).getTime() });
  ok(r1.length === 1 && r1[0].overdue === true, "到期日已过的承诺应标 overdue，实际：" + JSON.stringify(r1[0]));

  // 2) 同一承诺在到期前查 → 不逾期
  const r2 = openPromisesOf(mk(new Date(2026, 9, 2, 9, 30).getTime(), "我明天上午把组合价发你"), { now: new Date(2026, 9, 2, 20, 0).getTime() });
  ok(r2.length === 1 && r2[0].overdue === false, "到期前不应标 overdue，实际：" + JSON.stringify(r2[0]));

  // 3) 无日期可解析、发出 1 天多 → 兜底不标
  const r3 = openPromisesOf(mk(new Date(2026, 9, 4, 9, 0).getTime(), "我回头把清单发你"), { now: new Date(2026, 9, 5, 17, 0).getTime() });
  ok(r3.length === 1 && r3[0].overdue === false, "无日期 <3 天不应标 overdue，实际：" + JSON.stringify(r3[0]));

  // 4) 无日期可解析、发出超 3 天 → 兜底标逾期
  const r4 = openPromisesOf(mk(new Date(2026, 9, 1, 9, 0).getTime(), "我回头把清单发你"), { now: new Date(2026, 9, 5, 17, 0).getTime() });
  ok(r4.length === 1 && r4[0].overdue === true, "无日期 >3 天应标 overdue，实际：" + JSON.stringify(r4[0]));

  // 5) 已兑现（其后有完成消息）→ 不进 openPromises
  const r5 = openPromisesOf(mk(new Date(2026, 9, 1, 9, 0).getTime(), "我明天上午把组合价发你", [{ ts: new Date(2026, 9, 2, 10, 0).getTime(), sender: "我", is_owner: true, content: "已经发送", session_name: "会话A" }]), { now: new Date(2026, 9, 5, 17, 0).getTime() });
  ok(r5.length === 0, "已兑现承诺不应出现在 openPromises，实际：" + JSON.stringify(r5));
});

await t("BUG-F10：wai_obsidian_write 的 chat/url 进入 frontmatter（映射 sourceChat/sourceUrl）", async () => {
  await withHome("bugf10", async ({ call, home }) => {
    const vault = path.join(home, "vault");
    const r = await call("wai_obsidian_write", { vault, folder: "微信流", title: "探针笔记", markdown: "正文", chat: "探针会话甲", url: "https://example.com/probe", tags: ["探针"] });
    ok(!r.isError, "不应报错：" + JSON.stringify(r.structuredContent ?? {}).slice(0, 160));
    const fm = r.structuredContent?.frontmatter ?? {};
    eq(fm.chat, "探针会话甲", "frontmatter.chat 应为传入的 chat");
    eq(fm.url, "https://example.com/probe", "frontmatter.url 应为传入的 url");
    const note = String(r.structuredContent?.note ?? "");
    ok(/^chat: 探针会话甲$/m.test(note), "笔记 YAML 应有 chat 行");
    ok(/^url: "?https:\/\/example\.com\/probe"?$/m.test(note), "笔记 YAML 应有 url 行（URL 含冒号合法加引号）");
    const r2 = await call("wai_obsidian_write", { vault, markdown: "正文二", title: "无来源笔记" });
    ok(!r2.isError && r2.structuredContent?.frontmatter?.chat === "" && r2.structuredContent?.frontmatter?.url === "", "未传 chat/url 时应保持空串（契约形状不变）");
  });
});

await t("BUG-F13X：dispatch 层统一拦截 required 缺失（空参/空串/空数组不再静默成功）", async () => {
  await withHome("bugf13x", async ({ call, srv }) => {
    // 1) 全部声明 required 的工具空参必须报错，错误信封含「不能为空」
    const reqTools = srv.TOOLS.filter((x) => (x.inputSchema?.required ?? []).length > 0);
    ok(reqTools.length >= 23, "声明 required 的工具数应 ≥23，实际 " + reqTools.length);
    let silent = 0;
    for (const x of reqTools) {
      const r = await call(x.name, {});
      if (!r.isError) { silent++; continue; }
      ok(/不能为空/.test(String(r.structuredContent?.error ?? "")), x.name + " 错误应含「不能为空」：" + JSON.stringify(r.structuredContent).slice(0, 120));
    }
    eq(silent, 0, "不允许任何 required 工具空参静默成功");
    // 2) 显式空串/空数组同样视为未给
    const e1 = await call("wai_db_search", { query: "" });
    ok(e1.isError && /不能为空/.test(String(e1.structuredContent?.error ?? "")), "显式空 query 应报错");
    const e2 = await call("wai_batch_create", { items: [] });
    ok(e2.isError && /不能为空/.test(String(e2.structuredContent?.error ?? "")), "空 items 应报错");
    // 3) null 必填参数视为未给
    const e3 = await call("wai_person", { name: null });
    ok(e3.isError && /不能为空/.test(String(e3.structuredContent?.error ?? "")), "null 必填参数应报错");
    // 4) 带必填参数的正常调用不受影响
    const good = await call("wai_db_search", { query: "回归", limit: 5 });
    ok(!good.isError, "带必填参数的正常调用不应受影响：" + JSON.stringify(good.structuredContent ?? {}).slice(0, 160));
    // 5) 可选参数为空不拦（只有 required 才拦）
    const opt = await call("wai_status", {});
    ok(!opt.isError, "无 required 工具空参应保持成功");
  });
});

await t("BUG-F4：链接口径同窗（hits=appearances、first/last 覆盖）+ 上下文不切半个 URL", async () => {
  await withHome("bugf4", async ({ call }) => {
    const U = "https://example.com/campaign-brief";
    // 两个会话 × 两个时间带：2025-06 共 3 条、2026-10 共 2 条
    await call("wai_inbox_push", { body: [
      "[2025-06-10 10:00] 群友A: 旧期分享 " + U,
      "[2025-06-12 10:00] 群友A: 旧期再提 " + U,
      "[2026-10-01 10:00] 群友A: 新期分享 " + U,
    ].join("\n"), chat: "口径群甲", source: "manual" });
    await call("wai_inbox_push", { body: [
      "[2025-06-11 10:00] 群友B: 旧期同款 " + U,
      "[2026-10-02 10:00] 群友B: 新期同款 " + U,
    ].join("\n"), chat: "口径群乙", source: "manual" });
    await call("wai_inbox_process", { limit: 10 });
    const r = await call("wai_db_links", { since: "2026-10-01", until: "2026-10-05", minChats: 2, limit: 10 });
    const L = (r.structuredContent?.links ?? []).find((x) => String(x.url).includes("campaign-brief"));
    ok(L, "窗口内应找到跨群链接");
    const apps = L.appearances ?? [];
    eq(L.hits, 2, "窗口内 hits 应为 2（2025 的 3 条不计入）");
    eq(apps.length, 2, "appearances 应与 hits 同窗同数");
    const appTs = apps.map((a) => a.ts);
    const w0 = Date.parse("2026-10-01T00:00:00"), w1 = Date.parse("2026-10-06T00:00:00");
    ok(appTs.every((t) => t >= w0 && t < w1), "appearances 应全部落在窗口内");
    ok(L.first_ts <= Math.min(...appTs), "first_ts 应覆盖全部 appearances");
    ok(L.last_ts >= Math.max(...appTs), "last_ts 应覆盖全部 appearances");

    // 上下文截断：长文把 URL 挤过截断边界，任何输出字符串都不得在 URL 中间截断
    await call("wai_inbox_push", { body: [
      "[2026-10-03 09:00] 群友A: " + "补".repeat(150) + "https://example.com/brand-req?utm=abc",
      "[2026-10-03 09:05] 群友B: 也发一份 https://example.com/brand-req?utm=abc",
    ].join("\n"), chat: "截断群", source: "manual" });
    await call("wai_inbox_process", { limit: 10 });
    const collected = [];
    const walk = (o, depth = 0) => {
      if (depth > 8 || o == null) return;
      if (typeof o === "string") { if (/https?:/.test(o)) collected.push(o); return; }
      if (Array.isArray(o)) return o.forEach((x) => walk(x, depth + 1));
      if (typeof o === "object") for (const v of Object.values(o)) walk(v, depth + 1);
    };
    for (const [tool, args] of [["wai_signals", { since: "2026-10-01", until: "2026-10-05" }], ["wai_db_links", { since: "2026-10-01", until: "2026-10-05", minChats: 1, limit: 10 }]]) {
      const res = await call(tool, args);
      walk(res.structuredContent);
    }
    ok(collected.length > 0, "应收集到含 URL 的输出字符串");
    const midCut = collected.filter((c) => /https?:\/\/\S*…/.test(c));
    eq(midCut.length, 0, "不允许 URL 中间截断，实际：" + JSON.stringify(midCut.slice(0, 2)));
  });
});

await t("BUG-F6：wai_home 输出预算（胖行 ≤48KB 完整 JSON）+ counts 诚实总数 + inbox_entries 消歧", async () => {
  const ENV_KEYS = ["id","opportunity_key","key","title","record_type","record_label","opportunity_type","status","status_label","stage","chat","contact","role","confidence","confidence_label","evidence","evidence_count","links","notes","note","amount","next_action","next_follow_up","priority","last_signal_time","last_signal_at","stage_locked","priority_locked","next_action_locked","closed_at","qualification_score","qualification_reasons","reinforcement_count","expires_at","last_reviewed_at","created_ts","updated_ts","source"];
  const fat = (i) => ({
    chat: "胖行口径群" + i,
    opportunity_key: "reg:f6:" + i,
    title: "标".repeat(300),
    record_type: "opportunity",
    confidence: "high",
    priority: 5,
    next_action: "动".repeat(300),
    amount: "额".repeat(300),
    qualification_reasons: "由".repeat(300),
    last_signal_time: Date.now(),
    evidence: Array.from({ length: 8 }, (_, k) => ({ message_id: "m" + i + "_" + k, chat: "胖行口径群" + i, sender: "发言人甲", ts: Date.now(), content: "长".repeat(250), is_owner: false })),
    links: Array.from({ length: 6 }, (_, k) => "https://example.com/p/" + k + "/" + "p".repeat(180)),
  });

  // 相位 A：25 条对抗性胖行——输出仍必须是完整可解析 JSON 且 ≤48KB
  await withHome("bugf6-fat", async ({ call }) => {
    const opp = await import(new URL("../lib/opportunities.mjs", import.meta.url).href + "?f6fat");
    eq(opp.syncCandidates(Array.from({ length: 25 }, (_, i) => fat(i)), { dryRun: false }).created, 25, "胖行应全部创建");
    const r = await call("wai_home", {});
    const text = r.content?.[0]?.text ?? "";
    ok(text.length <= 48000, "wai_home 文本应 ≤48000 字节，实际 " + text.length);
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { /* fallthrough */ }
    ok(parsed && typeof parsed === "object", "文本必须是完整可解析 JSON（宿主截断后会解析失败）");
    const sc = r.structuredContent ?? {};
    const rows = [...(sc.today ?? []), ...(sc.inbox ?? [])];
    // counts.* 是同口径真实总数，不再拿 limit 截断后的展示条数当总数
    eq(sc.counts?.inbox, 25, "counts.inbox 应为真实总数 25");
    ok(sc.counts.inbox >= (sc.inbox ?? []).length, "counts.inbox 不得小于展示条数");
    ok((sc.inbox ?? []).length < 25, "展示条数应被 limit 截断（以此证明 counts 不再等于展示条数）");
    eq(sc.counts?.today, 25, "counts.today 应为真实总数 25");
    // wai_status.inbox 是 inbox_entries 暂存表行数（另一套数据），同名歧义由 inbox_entries 消除
    const st = (await call("wai_status", {})).structuredContent ?? {};
    eq(sc.counts?.inbox_entries, st.inbox, "counts.inbox_entries 应与 wai_status.inbox 同数");
    eq(sc.triage?.值得关注, sc.counts?.inbox, "triage.值得关注 应与诚实总数一致");
    // 信封不破坏：字段全保留，只收缩值
    ok(rows.length > 0, "应有行输出");
    ok(rows.every((x) => ENV_KEYS.every((k) => k in x)), "行信封字段必须完整");
    ok(rows.every((x) => (x.evidence ?? []).length <= 2), "evidence 预览 ≤2 条");
    ok(rows.every((x) => (x.links ?? []).length <= 3), "links 预览 ≤3 条");
    ok(rows.every((x) => ENV_KEYS.every((k) => typeof x[k] !== "string" || x[k].length <= 120)), "行内字符串 ≤120 字");
  });

  // 相位 B：3 条小数据——countInbox/countToday 的 WHERE 与 listInbox/listToday 逐条镜像（总数=展示条数）
  await withHome("bugf6-small", async ({ call }) => {
    const opp = await import(new URL("../lib/opportunities.mjs", import.meta.url).href + "?f6small");
    eq(opp.syncCandidates([fat(1), fat(2), fat(3)].map((c) => ({ ...c, opportunity_key: c.opportunity_key + ":s" })), { dryRun: false }).created, 3, "小数据应创建 3 条");
    const sc = (await call("wai_home", {})).structuredContent ?? {};
    eq(sc.counts?.inbox, (sc.inbox ?? []).length, "小数据下 counts.inbox 应等于展示条数");
    eq(sc.counts?.today, (sc.today ?? []).length, "小数据下 counts.today 应等于展示条数");
    eq(sc.counts?.inbox, 3, "counts.inbox 应为 3");
    ok([...(sc.today ?? []), ...(sc.inbox ?? [])].some((x) => (x.evidence ?? []).length > 0), "预算内应保留 evidence 预览");
  });
});

await t("BUG-F12：wai_vault_scan 缺目录不再静默 files:0（全缺失报错、部分缺失列 missing、空目录诚实）", async () => {
  await withHome("bugf12", async ({ home, call }) => {
    const missing = path.join(home, "no-such-vault");
    const real = path.join(home, "real-vault");
    const empty = path.join(home, "empty-vault");
    fs.mkdirSync(real, { recursive: true });
    fs.writeFileSync(path.join(real, "a.txt"), "[2026-10-01 10:00] 甲: 复现样本\n", "utf8");
    fs.mkdirSync(empty, { recursive: true });

    // 全缺失：与 wai_scan 同语义显式报错，不再假成功 files:0
    const all = await call("wai_vault_scan", { dirs: [missing] });
    ok(all.isError, "全缺失应报错，实际静默成功：" + JSON.stringify(all.structuredContent ?? {}).slice(0, 120));
    ok(/不存在/.test(all.content?.[0]?.text ?? ""), "报错文案应说明目标不存在");
    const scan = await call("wai_scan", { target: missing });
    ok(scan.isError, "wai_scan 缺失目标应报错（口径锚点）");

    // 部分缺失：继续扫存在的，missing 标记被静默丢弃的目录
    const part = await call("wai_vault_scan", { dirs: [missing, real] });
    ok(!part.isError, "部分缺失不应整体报错：" + JSON.stringify(part.structuredContent ?? {}).slice(0, 120));
    const ps = part.structuredContent ?? {};
    eq(ps.missing?.length, 1, "部分缺失应在 missing 列出 1 个目录");
    ok((ps.files ?? 0) >= 1, "存在的目录应被扫描，files 实际 " + ps.files);

    // 空目录（存在但无文件）：files:0 是诚实结果，不是缺目录，不得报错
    const e = await call("wai_vault_scan", { dirs: [empty] });
    ok(!e.isError, "空目录应成功");
    eq(e.structuredContent?.files, 0, "空目录 files 应为 0");
    eq((e.structuredContent?.missing ?? []).length, 0, "空目录不在 missing 之列");
  });
});

await t("BUG-F7：freshness.source 是语料真实来源（主来源），不再被索引通道冒充；通道另列 last_index_channel", async () => {
  // 相位 A：四条入库路径逐个盖通道章，source 始终跟语料、channel 跟通道
  await withHome("bugf7-stamps", async ({ home, call }) => {
    const f0 = (await call("wai_db_status", {})).structuredContent?.freshness ?? {};
    eq(f0.source, null, "空库 source 应为 null（无语料则无来源）");
    eq(f0.last_index_channel, null, "空库通道应为 null");
    ok(f0.sources && Object.keys(f0.sources).length === 0, "空库 sources 应为空对象");

    const dir = path.join(home, "corpus");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "s.txt"), "[2026-10-01 10:00] 甲: 样本一\n[2026-10-01 10:01] 乙: 样本二\n", "utf8");
    ok(!(await call("wai_scan", { target: dir })).isError, "wai_scan 应成功");
    let f = (await call("wai_db_status", {})).structuredContent?.freshness ?? {};
    eq(f.source, "scan", "scan 后 source 应为语料主来源 scan");
    eq(f.last_index_channel, "scan", "scan 通道应盖章");
    eq(f.sources?.scan, 2, "sources.scan 应为 2");

    ok(!(await call("wai_inbox_push", { body: "[2026-10-01 10:02] 丙: 样本三", chat: "F7暂存群", kind: "chat", source: "manual" })).isError, "wai_inbox_push 应成功");
    ok(!(await call("wai_inbox_process", {})).isError, "wai_inbox_process 应成功");
    f = (await call("wai_db_status", {})).structuredContent?.freshness ?? {};
    eq(f.source, "scan", "inbox 不改变主来源（2>1）");
    eq(f.last_index_channel, "inbox", "inbox 通道应盖章");
    eq(f.sources?.scan, 2, "sources.scan 应为 2");
    eq(f.sources?.manual, 1, "sources.manual 应为 1（entry.source 落到 messages.source）");

    const rv = path.join(home, "real-vault");
    fs.mkdirSync(rv, { recursive: true });
    fs.writeFileSync(path.join(rv, "v.txt"), "[2026-10-01 10:03] 丁: 样本四\n", "utf8");
    ok(!(await call("wai_vault_scan", { dirs: [rv] })).isError, "wai_vault_scan 应成功");
    f = (await call("wai_db_status", {})).structuredContent?.freshness ?? {};
    eq(f.source, "scan", "vault 仅 1 条仍不改变主来源");
    eq(f.last_index_channel, "vault", "vault 通道应盖章");
    eq(f.sources?.vault, 1, "sources.vault 应为 1");
    eq(f.messages, 4, "总消息数应为 4");
  });

  // 相位 B：真机误导序列——空 vault 目录使自动档偏好 vault 通道（0 条入库），
  // source 必须仍是语料主来源，不得再被通道冒充
  await withHome("bugf7-novault", async ({ home, call }) => {
    const dir = path.join(home, "corpus");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "s.txt"), "[2026-10-01 10:00] 甲: 样本一\n[2026-10-01 10:01] 乙: 样本二\n", "utf8");
    ok(!(await call("wai_scan", { target: dir })).isError, "wai_scan 应成功");
    fs.mkdirSync(path.join(home, "vault"), { recursive: true }); // 存在但空 → pickReader 自动档偏好 vault
    ok(!(await call("wai_db_index", {})).isError, "wai_db_index 自动档应成功");
    const f = (await call("wai_db_status", {})).structuredContent?.freshness ?? {};
    eq(f.messages, 2, "空 vault 索引应 0 条入库");
    eq(f.source, "scan", "source 应是语料主来源 scan，而不是通道 vault");
    ok(f.source !== "vault", "不得再用通道冒充来源（vault 语料 0 条）——真机误导序列");
    eq(f.sources?.vault, undefined, "sources 不应列 vault（0 条不列）");
    eq(f.sources?.scan, 2, "sources.scan 应为 2");
    eq(f.last_index_channel, "vault", "通道事实保留在 last_index_channel");
  });
});

await t("BUG-F8：reactivation「今天优先看」要求沉默期满（2 天标签/下一批会话落等待区，沉默折叠与近期判定不变）", async () => {
  await withHome("bugf8", async () => {
    const { reactivation } = await import(new URL("../lib/signals.mjs", import.meta.url).href + "?f8");
    const now = Date.now();
    const reMsg = (chat, sender, daysAgo, content) => ({ session_name: chat, sender, ts: now - daysAgo * 86400_000, content, is_owner: sender === "我", links: [] });
    const bandOf = (r, chat) => r.all.find((x) => x.chat === chat)?.band ?? "(未入池)";
    const run = (msgs, opts) => reactivation({ messages: msgs, inactiveDays: 21, ...opts });

    // 误导序列（改前折进「今天优先看」）：刚聊过的标签/「下一批」会话不是今日行动对象
    const a = run([reMsg("品牌A-复购保温", "对接人", 2, "好的收到")], { label: ["复购保温"] });
    eq(bandOf(a, "品牌A-复购保温"), "等待区", "标签+2 天沉默应落等待区");
    const b = run([reMsg("品牌B", "对接人", 2, "这批结束了，下一批联系你")]);
    eq(bandOf(b, "品牌B"), "等待区", "「下一批」+2 天沉默应落等待区");
    eq(b.immediate.length, 0, "今天优先看不得含未沉默会话");
    ok(b.nextBatch.some((x) => x.chat === "品牌B"), "next 仍返回带「下一批」信号的会话（契约保持）");

    // 折叠口径保持：沉默期满的「待下一批跟进/复购保温」仍进今天优先看
    eq(bandOf(run([reMsg("品牌C", "对接人", 40, "这批结束了，下一批我提前跟你聊")]), "品牌C"), "今天优先看", "「下一批」+40 天折叠不变");
    eq(bandOf(run([reMsg("品牌D-复购保温", "对接人", 25, "好的收到")], { label: ["复购保温"] }), "品牌D-复购保温"), "今天优先看", "标签+25 天折叠不变");

    // 既有判定口径保持：decisive 近期会话参与判定但不进今日行动；纯闲聊近期不入池
    eq(bandOf(run([reMsg("品牌E", "对接人", 5, "暂时不考虑合作，预算不够")]), "品牌E"), "等待区", "近期明确拒绝→等待区（既有口径）");
    eq(bandOf(run([reMsg("品牌F", "对接人", 2, "好的收到")]), "品牌F"), "(未入池)", "纯闲聊+2 天不入池");
  });
});

await t("BUG-F14：显式 source=路径型缺失 不再静默空集（报错族对齐 wai_scan；默认通道与自动档不变）", async () => {
  await withHome("bugf14", async ({ home, call }) => {
    const missing = path.join(home, "no-such-dir");
    // 三条路径型显式 source 指向缺失路径 → 统一「扫描目标不存在」报错（此前静默空集/空结果）
    for (const [tool, args] of [
      ["wai_db_index", { source: "vault:" + missing }],
      ["wai_db_index", { source: "sqlite:" + path.join(home, "no-such.db") }],
      ["wai_db_index", { source: "wcdb:" + path.join(home, "no-such-wcdb") }],
      ["wai_chat_search", { query: "任意词", source: "vault:" + missing }],
    ]) {
      const r = await call(tool, args);
      ok(r.isError, tool + " 显式缺失路径应报错，实际静默成功");
      ok(/不存在/.test(r.content?.[0]?.text ?? ""), tool + " 报错文案应说明目标不存在");
    }

    // 设计态保持：默认 vault 缺失仍是 needs_access（vault_status 依赖），不是错误
    const vs = await call("wai_vault_status", {});
    ok(!vs.isError, "默认 vault 缺失不应报错");
    eq(vs.structuredContent?.state, "needs_access", "默认 vault 缺失应为 needs_access 设计态");

    // 既有报错与降级保持：未知 id 报「没有可用的数据源」；自动档缺 vault 时正常降级不报错
    const unk = await call("wai_db_index", { source: "nope-no-such" });
    ok(unk.isError, "未知 source id 应报错");
    ok(/没有可用的数据源/.test(unk.content?.[0]?.text ?? ""), "未知 id 文案保持");
    const auto = await call("wai_db_index", {});
    ok(!auto.isError, "自动档缺 vault 应降级而非报错：" + JSON.stringify(auto.structuredContent ?? {}).slice(0, 120));

    // 存在的路径不受影响：显式 vault:真实目录正常入库
    const real = path.join(home, "real-vault");
    fs.mkdirSync(real, { recursive: true });
    fs.writeFileSync(path.join(real, "a.txt"), "[2026-10-01 10:00] 甲: 样本\n", "utf8");
    const okIdx = await call("wai_db_index", { source: "vault:" + real });
    ok(!okIdx.isError, "显式 vault:存在目录应成功：" + JSON.stringify(okIdx.structuredContent ?? {}).slice(0, 120));
  });
});

await t("BUG-F15：loadVault 解析缓存按键合并写回（force 空根/子集与工具子集不再清掉他目录条目；命中与 GC 语义保持）", async () => {
  await withHome("bugf15", async ({ home, call }) => {
    const { loadVault } = await import(new URL("../lib/reader/vault.mjs", import.meta.url).href + "?f15");
    const A = path.join(home, "vaultA");
    const B = path.join(home, "vaultB");
    const E = path.join(home, "emptyE");
    for (const d of [A, B, E]) fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(A, "a.txt"), "[2026-10-01 10:00] 甲: A 样本\n", "utf8");
    fs.writeFileSync(path.join(B, "b.txt"), "[2026-10-01 11:00] 乙: B 样本\n", "utf8");
    const cacheFile = path.join(home, "cache", "vault-cache.json");
    const entries = () => { try { return JSON.parse(fs.readFileSync(cacheFile, "utf8")); } catch { return {}; } };

    eq(loadVault({ dirs: [A, B] }).parsedCount, 2, "首扫应解析 2 个文件");
    eq(Object.keys(entries()).length, 2, "缓存应有 2 条");

    // force 空根（存在但无文件）：旧实现 next={} 整文件覆写，清空整个缓存
    loadVault({ dirs: [E], force: true });
    eq(Object.keys(entries()).length, 2, "force 空根不得清空缓存");

    // force 子集：旧实现只留本次条目，B 被丢
    loadVault({ dirs: [A], force: true });
    eq(Object.keys(entries()).length, 2, "force 子集不得清掉 B 的条目");

    // 工具级同源：wai_vault_status（非 force）与 wai_vault_scan（force）显式 dirs 都走子集加载
    await call("wai_vault_status", { dirs: [A] });
    eq(Object.keys(entries()).length, 2, "wai_vault_status 子集不得清掉 B 的条目");
    const vs = await call("wai_vault_scan", { dirs: [A] });
    ok(!vs.isError, "wai_vault_scan 子集应成功：" + JSON.stringify(vs.structuredContent ?? {}).slice(0, 120));
    eq(Object.keys(entries()).length, 2, "wai_vault_scan force 子集不得清掉 B 的条目");

    // 命中语义不受合并影响：重扫全量应全命中
    const r5 = loadVault({ dirs: [A, B] });
    eq(r5.cacheHits, 2, "重扫全量应全命中缓存");
    eq(r5.parsedCount, 0, "不应重复解析");

    // GC 语义保持：扫过根内已删文件的陈旧条目回收，未扫根条目保留
    fs.rmSync(path.join(B, "b.txt"));
    loadVault({ dirs: [B] });
    const e = entries();
    ok(!Object.values(e).some((rec) => String(rec.file ?? "").includes("b.txt")), "扫过根内已删文件的陈旧条目应被回收");
    ok(Object.values(e).some((rec) => String(rec.file ?? "").includes("a.txt")), "未扫根 A 的条目应保留");
  });
});

await t("BUG-F16：wai_vault_scan 的 out 落扫描摘要（不传零变化、空串视为未给、幂等、无正文泄露）", async () => {
  await withHome("bugf16", async ({ home, call }) => {
    const vault = path.join(home, "vault");
    fs.mkdirSync(vault, { recursive: true });
    fs.writeFileSync(path.join(vault, "a.txt"), "[2026-10-01 10:00] 甲: F16 样本\n", "utf8");

    // 不传 out：返回不得出现新键，也不得创建任何目录（基线兼容）
    const r0 = await call("wai_vault_scan", { dirs: [vault] });
    ok(!r0.isError, "不传 out 应成功");
    ok(!("out" in (r0.structuredContent ?? {})) && !("summary_file" in (r0.structuredContent ?? {})), "不传 out 不得新增返回键");

    // 传 out：落 vault-scan-summary.json，内容仅路径与计数，不含聊天名与消息正文
    const outDir = path.join(home, "sum");
    const r1 = await call("wai_vault_scan", { dirs: [vault], out: outDir });
    ok(!r1.isError, "传 out 应成功");
    const f = r1.structuredContent?.summary_file;
    ok(typeof f === "string" && fs.existsSync(f), "summary_file 应存在：" + f);
    eq(path.basename(f), "vault-scan-summary.json", "文件名应区别于 wai_scan/wai_db_index 的摘要");
    const raw = fs.readFileSync(f, "utf8");
    const j = JSON.parse(raw);
    eq(j.inserted, r1.structuredContent.inserted, "摘要 inserted 应与返回一致");
    ok(!/F16 样本/.test(raw) && !("perFile" in j), "摘要不得含消息正文或逐会话明细");

    // 空串（trim 后）视为未给：不报错、不落盘
    const r2 = await call("wai_vault_scan", { dirs: [vault], out: "  " });
    ok(!r2.isError && !("summary_file" in (r2.structuredContent ?? {})), "空白 out 应视为未给");

    // 幂等：同 out 重跑摘要字节一致（无时间戳抖动），inserted 归 0
    const b1 = fs.readFileSync(f, "utf8");
    const r3 = await call("wai_vault_scan", { dirs: [vault], out: outDir });
    eq(fs.readFileSync(f, "utf8"), b1, "重跑摘要应字节一致");
    eq(r3.structuredContent.inserted, 0, "重跑 inserted 应为 0");
  });
});

await t("BUG-F17：wai_chat_search 的 out 落检索证据（不传零变化、PII 打码、会话归属、幂等、零命中诚实）", async () => {
  await withHome("bugf17", async ({ home, call }) => {
    const corpus = path.join(home, "corpus");
    fs.mkdirSync(corpus, { recursive: true });
    fs.writeFileSync(path.join(corpus, "甲群.txt"), "[2026-10-01 10:00] 甲: 找我随时联系 13812345678\n", "utf8");
    fs.writeFileSync(path.join(corpus, "乙群.txt"), "[2026-10-01 11:00] 乙: 联系方式发你邮箱 f17@example.com\n", "utf8");
    ok(!(await call("wai_scan", { target: corpus })).isError, "建索引应成功");

    // 不传 out：返回不得出现新键（基线兼容）
    const r0 = await call("wai_chat_search", { query: "联系", source: "local" });
    ok(!r0.isError, "不传 out 应成功");
    ok(!("out" in (r0.structuredContent ?? {})), "不传 out 不得新增返回键");
    ok((r0.structuredContent?.count ?? 0) >= 2, "跨两会话应命中≥2，实际 " + r0.structuredContent?.count);

    // 传 out：落 chat_search.md，每条命中带会话归属，PII 打码（redactOutputs 默认开）
    const outDir = path.join(home, "sum");
    const r1 = await call("wai_chat_search", { query: "联系", source: "local", out: outDir });
    ok(!r1.isError, "传 out 应成功");
    const f = r1.structuredContent?.out;
    ok(typeof f === "string" && fs.existsSync(f), "out 文件应存在：" + f);
    eq(path.basename(f), "chat_search.md", "文件名应区别于 chat_history.md");
    const raw = fs.readFileSync(f, "utf8");
    ok(raw.includes("# 微信搜索结果：联系"), "标题应为检索语义");
    ok(/甲群/.test(raw) && /乙群/.test(raw), "多会话命中应带会话归属");
    ok(!raw.includes("13812345678") && raw.includes("<手机号>"), "手机号应打码（F1 口径）");
    ok(!raw.includes("f17@example.com"), "邮箱应打码");

    // 幂等：重跑字节一致
    const b1 = raw;
    const r2 = await call("wai_chat_search", { query: "联系", source: "local", out: outDir });
    eq(fs.readFileSync(r2.structuredContent.out, "utf8"), b1, "重跑应字节一致");

    // 空串视为未给
    const r3 = await call("wai_chat_search", { query: "联系", source: "local", out: "  " });
    ok(!r3.isError && !("out" in (r3.structuredContent ?? {})), "空白 out 应视为未给");

    // 零命中诚实落盘
    const out2 = path.join(home, "sum2");
    const r4 = await call("wai_chat_search", { query: "绝不存在的词F17", source: "local", out: out2 });
    ok(!r4.isError && fs.readFileSync(r4.structuredContent.out, "utf8").includes("没有符合条件的消息。"), "零命中应诚实落盘");
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
